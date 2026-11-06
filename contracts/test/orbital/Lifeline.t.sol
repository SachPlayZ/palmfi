// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {NetworkTest} from "../base/NetworkTest.sol";
import {Vault} from "../../src/Vault.sol";
import {VaultBase} from "../../src/VaultBase.sol";
import {VaultModule} from "../../src/VaultModule.sol";
import {OrbitalHook} from "../../src/orbital/OrbitalHook.sol";
import {OrbitalRouter} from "../../src/orbital/OrbitalRouter.sol";
import {PalmTypes as T} from "../../src/libraries/PalmTypes.sol";

/// Lifeline (ADR-0013): a Frozen Vault keeps paying a known counterparty through the Orbital pool, approved by its
/// Recovery key and a wallet majority, and repays the pool from its frozen reserves once the freeze resolves.
contract LifelineTest is NetworkTest {
    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );

    OrbitalHook hook;
    Vault nvidia; // w[0..2], 3 wallets
    Vault palantir; // p[0..2]
    Vault evil; // e[0..2]
    address[] p;
    address[] e;
    address nt;
    address pt;

    function setUp() public override {
        super.setUp();
        address at = address(FLAGS ^ (uint160(0x4444) << 144));
        deployCodeTo("OrbitalHook.sol:OrbitalHook", abi.encode(ext.poolManager, net.factory, deployer), at);
        hook = OrbitalHook(at);
        OrbitalRouter router = new OrbitalRouter(IPoolManager(ext.poolManager), hook);
        vm.startPrank(deployer);
        hook.setRouter(address(router));
        factory().setHook(at);
        vm.stopPrank();

        for (uint256 i; i < 3; i++) {
            p.push(makeAddr(string.concat("palantir", vm.toString(i))));
            e.push(makeAddr(string.concat("evil", vm.toString(i))));
        }
        nvidia = onboard("nvidia", 3);
        palantir = Vault(factory().createVault("palantir", config(p)));
        evil = Vault(factory().createVault("evilcorp", config(e)));
        (nt, pt) = (nvidia.token(), palantir.token());

        _lp(nvidia, w[0], 10_000e6);
        _lp(palantir, p[0], 10_000e6);
        _lp(evil, e[0], 10_000e6);

        // Before the incident nvidia paid palantir once: palantir is a known counterparty.
        vm.prank(w[0]);
        nvidia.pay(address(palantir), 100e6);
    }

    function _lp(Vault v, address wallet, uint256 amount) internal {
        depositUsdc(v, wallet, amount + 1_000e6);
        vm.startPrank(wallet);
        tokenOf(v).approve(address(hook), amount);
        hook.addLiquidity(v.token(), amount);
        vm.stopPrank();
    }

    function _freeze() internal {
        vm.prank(w[1]);
        nvidia.freeze();
    }

    /// Proposed by w[0], approved by w[1] and the Recovery key: drawn.
    function _draw(uint256 amount) internal returns (uint256 id) {
        vm.prank(w[0]);
        id = mod(nvidia).proposeLifeline(address(palantir), amount);
        vm.prank(w[1]);
        mod(nvidia).approveLifeline(id);
        vm.prank(recoveryKey);
        mod(nvidia).approveLifeline(id);
    }

    function _backed(Vault v) internal view {
        (uint256 held, uint256 supply) = mod(v).reserves();
        assertGe(held, supply + mod(v).lifelineDebt(), "reserves back supply + debt");
    }

    function test_frozenVaultPaysKnownCounterparty() public {
        _freeze();
        uint256 usdcBefore = usdcBalance(address(nvidia));
        uint256 payeeBefore = tokenOf(palantir).balanceOf(p[0]);
        uint256 reserveBefore = hook.reserveOf(pt);

        uint256 id = _draw(500e6);

        assertEq(mod(nvidia).getLifeline(id).state, 2);
        assertEq(tokenOf(palantir).balanceOf(p[0]), payeeBefore + 500e6, "payee paid now");
        assertEq(hook.reserveOf(pt), reserveBefore - 500e6, "fronted from palantir's float");
        assertEq(hook.owedTo(pt), 500e6);
        assertEq(mod(nvidia).lifelineDebt(), 502.5e6, "principal + 0.5% fee");
        assertEq(usdcBalance(address(nvidia)), usdcBefore, "frozen USDC never moved");
        assertTrue(nvidia.isFrozen());
        _backed(nvidia);
    }

    function test_repaidOnSettleAfterUnfreeze() public {
        _freeze();
        _draw(500e6);
        uint256 reserveAfterDraw = hook.reserveOf(pt);
        uint256 palUsdc = usdcBalance(address(palantir));
        uint256 feeTo = tokenOf(palantir).balanceOf(p[0]);

        hook.settle(); // still frozen: nothing repaid
        assertEq(hook.debtCount(), 1);

        vm.prank(recoveryKey);
        mod(nvidia).recoveryUnfreeze();
        hook.settle();

        assertEq(hook.debtCount(), 0);
        assertEq(hook.owedTo(pt), 0);
        assertEq(hook.reserveOf(pt), reserveAfterDraw + 500e6, "pool float restored");
        assertEq(usdcBalance(address(palantir)), palUsdc + 502.5e6);
        assertEq(tokenOf(palantir).balanceOf(p[0]), feeTo + 2.5e6, "fee to the lender");
        assertEq(mod(nvidia).lifelineDebt(), 0);
        _backed(nvidia);
        _backed(palantir);
    }

    function test_migrationKeepsDebtBack() public {
        _freeze();
        _draw(500e6);
        vm.prank(recoveryKey);
        mod(nvidia).recoveryMigrate();
        assertEq(hub().statusOf(address(nvidia)), T.STATUS_MIGRATED);
        _backed(nvidia);

        uint256 palUsdc = usdcBalance(address(palantir));
        hook.settle();
        assertEq(hook.debtCount(), 0);
        assertEq(usdcBalance(address(palantir)), palUsdc + 502.5e6, "repaid from the kept-back USDC");
        _backed(palantir);
    }

    function test_needsRecoveryKeyAndMajority() public {
        _freeze();
        vm.prank(w[0]);
        uint256 id = mod(nvidia).proposeLifeline(address(palantir), 500e6);
        vm.prank(w[1]);
        mod(nvidia).approveLifeline(id); // 2/3 wallets, no key
        assertEq(mod(nvidia).getLifeline(id).state, 1, "majority alone is not enough");

        vm.prank(w[0]);
        uint256 id2 = mod(nvidia).proposeLifeline(address(palantir), 100e6);
        vm.prank(recoveryKey);
        mod(nvidia).approveLifeline(id2); // key + 1/3
        assertEq(mod(nvidia).getLifeline(id2).state, 1, "key alone is not enough");
    }

    function test_unknownPayeeRejected() public {
        _freeze();
        vm.prank(w[0]);
        vm.expectRevert(abi.encodeWithSelector(VaultBase.UnknownPayee.selector, address(evil)));
        mod(nvidia).proposeLifeline(address(evil), 100e6);
    }

    function test_onlyWhileFrozen() public {
        vm.prank(w[0]);
        vm.expectRevert(VaultBase.NotFrozen.selector);
        mod(nvidia).proposeLifeline(address(palantir), 100e6);
    }

    function test_capOnFrozenReserves() public {
        _freeze();
        depositUsdc(nvidia, w[0], 5_000e6); // the proposer needs tokens for the escrow
        uint256 room = mod(nvidia).lifelineRoom();
        uint256 tooMuch = room; // amount + fee > room
        vm.prank(w[0]);
        vm.expectRevert();
        mod(nvidia).proposeLifeline(address(palantir), tooMuch);
    }

    function test_hookRejectsDirectCalls() public {
        vm.expectRevert();
        hook.lifelineDraw(address(palantir), 100e6, 0);
        // an active Vault can't draw either
        vm.prank(address(nvidia));
        vm.expectRevert(OrbitalHook.NotFrozen.selector);
        hook.lifelineDraw(address(palantir), 100e6, 0);
    }

    // ------------------------------------------------------------------
    // End to end: a hacked wallet, a CRE FLAG, payroll through the freeze, recovery, repayment
    // ------------------------------------------------------------------


    /// The attacker holds w[2]'s key and tries a large unwrap to its own address; the Sentinel FLAGs it.
    function _hack() internal returns (uint256 reqId) {
        depositUsdc(nvidia, w[2], 6_000e6);
        vm.prank(w[2]);
        reqId = nvidia.requestUnwrap(5_000e6, attacker);
        flag(nvidia, reqId, T.NEW_DESTINATION | T.OFF_HOURS | T.UNUSUAL_AMOUNT);
    }

    function test_e2e_hackFreezePayrollRecoverRepay() public {
        uint256 reqId = _hack();
        assertTrue(nvidia.isFrozen(), "FLAG froze the Vault");
        // (the Hub blocklists the destination only for a verified Vault's FLAG: AuditFixes covers that)
        assertEq(nvidia.getRequest(reqId).state, T.REQ_FLAGGED);
        assertEq(usdcBalance(attacker), 0, "nothing left");

        // Normal lanes are shut while frozen.
        vm.prank(w[0]);
        vm.expectRevert(VaultBase.NotActive.selector);
        nvidia.requestPayment(address(palantir), 100e6);

        // Honest wallets keep paying their known supplier through the pool.
        uint256 payee0 = tokenOf(palantir).balanceOf(p[0]);
        _draw(400e6);
        _draw(300e6);
        assertEq(tokenOf(palantir).balanceOf(p[0]), payee0 + 700e6, "supplier paid during the freeze");
        assertEq(hook.debtCount(), 2);

        // Forensics done (in production: rotate the stolen key first; a 3-wallet Vault must add before it removes).
        vm.prank(recoveryKey);
        mod(nvidia).recoveryUnfreeze();

        uint256 palUsdc = usdcBalance(address(palantir));
        hook.settle();
        assertEq(hook.debtCount(), 0, "all repaid");
        assertEq(hook.owedTo(pt), 0);
        assertEq(usdcBalance(address(palantir)), palUsdc + 703.5e6, "principal + fees in USDC");
        assertEq(mod(nvidia).lifelineDebt(), 0);
        _backed(nvidia);
        _backed(palantir);

        // Business as usual again: palantir can withdraw its full liquidity.
        vm.prank(p[0]);
        hook.removeLiquidity(pt, 10_000e6, p[0]);
    }

    function test_e2e_attackerCannotUseLifeline() public {
        _hack();
        // To its own org: not a known counterparty.
        vm.prank(w[2]);
        vm.expectRevert(abi.encodeWithSelector(VaultBase.UnknownPayee.selector, address(evil)));
        mod(nvidia).proposeLifeline(address(evil), 100e6);

        // To a known payee, with a second stolen wallet (a majority), but no Recovery key: never drawn.
        vm.prank(w[2]);
        uint256 id = mod(nvidia).proposeLifeline(address(palantir), 100e6);
        vm.prank(w[1]);
        mod(nvidia).approveLifeline(id);
        assertEq(mod(nvidia).getLifeline(id).state, 1);
        assertEq(hook.debtCount(), 0);

        // An outsider can neither approve nor draw from the hook.
        vm.prank(attacker);
        vm.expectRevert(VaultBase.NotWallet.selector);
        mod(nvidia).approveLifeline(id);
        vm.prank(attacker);
        vm.expectRevert();
        hook.lifelineDraw(address(palantir), 100e6, 0);

        // An honest wallet cancels? Only the proposer, or anyone after the TTL.
        vm.prank(w[0]);
        vm.expectRevert(VaultBase.Unauthorized.selector);
        mod(nvidia).cancelLifeline(id);
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(w[0]);
        mod(nvidia).cancelLifeline(id);
        assertEq(mod(nvidia).lifelinePending(), 0);
    }

    function test_e2e_hackThenMigrate() public {
        _hack();
        _draw(500e6);
        uint256 recBefore = usdcBalance(recoveryVaultAddr);
        vm.prank(recoveryKey);
        mod(nvidia).recoveryMigrate();
        assertGt(usdcBalance(recoveryVaultAddr), recBefore, "rest went to the Recovery vault");
        _backed(nvidia);
        hook.settle();
        assertEq(hook.debtCount(), 0, "repaid from the kept-back USDC");
        _backed(nvidia);
        _backed(palantir);
        // Nothing else can leave a Migrated Vault through a Lifeline.
        vm.prank(w[0]);
        vm.expectRevert(VaultBase.NotFrozen.selector);
        mod(nvidia).proposeLifeline(address(palantir), 100e6);
    }

    function test_e2e_payeeFrozenAtRepaymentWaits() public {
        _hack();
        _draw(500e6);
        vm.prank(recoveryKey);
        mod(nvidia).recoveryUnfreeze();
        vm.prank(p[1]);
        palantir.freeze(); // the payee has its own incident
        hook.settle();
        assertEq(hook.debtCount(), 1, "waits for the payee");
        vm.prank(recoveryKey);
        mod(palantir).recoveryUnfreeze();
        hook.settle();
        assertEq(hook.debtCount(), 0);
        _backed(nvidia);
        _backed(palantir);
    }

    function test_e2e_poolSideCap() public {
        _hack();
        // 20% of ~17k frozen USDC ≈ 3.4k Vault room; pool fronts at most 5k of palantir's 10k: Vault cap binds.
        depositUsdc(nvidia, w[0], 5_000e6); // the proposer needs tokens for the escrow
        uint256 room = mod(nvidia).lifelineRoom();
        uint256 amount = room * 10_000 / 10_050;
        _draw(amount);
        assertLe(hook.owedTo(pt), 5_000e6);
        vm.prank(w[0]);
        vm.expectRevert();
        mod(nvidia).proposeLifeline(address(palantir), 10e6);
    }

    function test_cancelReturnsEscrow() public {
        _freeze();
        uint256 bal = tokenOf(nvidia).balanceOf(w[0]);
        vm.prank(w[0]);
        uint256 id = mod(nvidia).proposeLifeline(address(palantir), 200e6);
        assertEq(tokenOf(nvidia).balanceOf(w[0]), bal - 201e6);
        vm.prank(w[0]);
        mod(nvidia).cancelLifeline(id);
        assertEq(tokenOf(nvidia).balanceOf(w[0]), bal);
        assertEq(mod(nvidia).lifelinePending(), 0);
    }
}
