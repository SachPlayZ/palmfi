// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {NetworkTest} from "../base/NetworkTest.sol";
import {Vault} from "../../src/Vault.sol";
import {VaultBase} from "../../src/VaultBase.sol";
import {OrbitalHook} from "../../src/orbital/OrbitalHook.sol";
import {OrbitalRouter} from "../../src/orbital/OrbitalRouter.sol";
import {ProtectedToken} from "../../src/tokens/ProtectedToken.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

struct PoolKeyHolder {
    PoolKey key;
}

/// Orbital pool on the real Arc v4 PoolManager (fork): cross-org payments, payer controls, frozen tokens,
/// deferred settlement (brief §8, ADR-0010).
contract OrbitalTest is NetworkTest {
    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );

    OrbitalHook hook;
    OrbitalRouter router;
    Vault nvidia; // w[0..2]
    Vault palantir; // p[0..2]
    Vault evil; // e[0..2]
    address[] p;
    address[] e;
    address nt; // nUSDC, pUSDC, eUSDC: cached so vm.prank / expectRevert hit the intended call
    address pt;
    address et;

    function setUp() public override {
        super.setUp();
        address at = address(FLAGS ^ (uint160(0x4444) << 144));
        deployCodeTo("OrbitalHook.sol:OrbitalHook", abi.encode(ext.poolManager, net.factory, deployer), at);
        hook = OrbitalHook(at);
        router = new OrbitalRouter(IPoolManager(ext.poolManager), hook);
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
        (nt, pt, et) = (nvidia.token(), palantir.token(), evil.token());

        // Each org LPs 10k of its own token and keeps 1k in its payer wallet.
        _lp(nvidia, w[0], 10_000e6);
        _lp(palantir, p[0], 10_000e6);
        _lp(evil, e[0], 10_000e6);
    }

    function _lp(Vault v, address wallet, uint256 amount) internal {
        depositUsdc(v, wallet, amount + 1_000e6);
        vm.startPrank(wallet);
        tokenOf(v).approve(address(hook), amount);
        hook.addLiquidity(v.token(), amount);
        tokenOf(v).approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _pay(address from, Vault payer, Vault payee, address to, uint256 amount) internal returns (uint256 inAmt) {
        (address tin, address tout) = (payer.token(), payee.token());
        vm.prank(from);
        (inAmt,) = router.swap(tin, tout, amount, false, type(uint256).max, to);
    }

    function test_registration_facadePerPair() public view {
        assertEq(hook.tokenCount(), 3);
        assertEq(hook.vaultOf(nt), address(nvidia));
        assertGt(hook.radius(), 0);
    }

    function test_paymentByName_palantirPaysNvidia() public {
        address to = Vault(hub().resolve("nvidia")).wallets()[1];
        uint256 budget = palantir.availableBudget();
        uint256 paid = _pay(p[0], palantir, nvidia, to, 100e6);
        assertEq(tokenOf(nvidia).balanceOf(to), 100e6); // exact out
        assertGe(paid, 100e6); // pool never loses
        assertLe(paid, 100.2e6); // near 1:1 around the peg (20× concentration)
        assertEq(tokenOf(palantir).balanceOf(p[0]), 1_000e6 - paid);
        assertEq(palantir.availableBudget(), budget - paid); // charged like an Unwrap
    }

    function test_exactIn_nearPeg() public {
        vm.prank(p[0]);
        (, uint256 out) = router.swap(pt, nt, 100e6, true, 99e6, w[0]);
        assertLe(out, 100e6);
        assertGe(out, 99.8e6);
    }

    function test_attackerOrgExit_chargedToPayerBudget() public {
        // A hacked Palantir wallet tries to drain into evilcorp's token: capped by Palantir's Instant budget.
        vm.prank(p[0]);
        vm.expectRevert();
        router.swap(pt, et, 600e6, true, 0, e[0]);
        _pay(p[0], palantir, evil, e[0], 400e6);
        vm.prank(p[0]);
        vm.expectRevert();
        router.swap(pt, et, 200e6, true, 0, e[0]);
    }

    function test_outputOnlyToPayeeWallets() public {
        vm.prank(p[0]);
        vm.expectRevert(); // nUSDC can't leave the PoolManager to an outsider
        router.swap(pt, nt, 10e6, true, 0, outsider);
    }

    function test_onlyOwnWalletPays() public {
        vm.prank(w[0]); // an nvidia wallet can't spend palantir's token, nor charge palantir's budget
        vm.expectRevert();
        router.swap(pt, nt, 10e6, true, 0, w[0]);
    }

    function test_frozenToken_swapsRevert() public {
        vm.prank(w[2]);
        nvidia.freeze();
        vm.prank(p[0]);
        vm.expectRevert(); // FrozenToken(nUSDC), wrapped by the PoolManager's hook-call error
        router.swap(pt, nt, 10e6, true, 0, w[0]);
    }

    function test_directPoolManagerSwap_rejected() public {
        // Anyone but the trusted router is refused, so the payer can always be identified.
        OrbitalRouter rogue = new OrbitalRouter(IPoolManager(ext.poolManager), hook);
        vm.startPrank(p[0]);
        ProtectedToken(pt).approve(address(rogue), type(uint256).max);
        vm.expectRevert();
        rogue.swap(pt, nt, 10e6, true, 0, w[0]);
        vm.stopPrank();
    }

    function test_settle_movesForeignInventoryVaultToVault() public {
        _pay(p[0], palantir, nvidia, w[1], 300e6);
        assertGt(hook.reserveOf(pt), hook.liquidityOf(pt)); // foreign pUSDC piled up
        assertLt(hook.reserveOf(nt), hook.liquidityOf(nt));

        uint256 nvUsdc = usdcBalance(address(nvidia));
        hook.settle();
        assertEq(hook.reserveOf(nt), hook.liquidityOf(nt)); // nvidia's LP is whole again in its own token
        assertGt(usdcBalance(address(nvidia)), nvUsdc);
        _assertBacked(nvidia);
        _assertBacked(palantir);
        _assertBacked(evil);
    }

    function test_lpWithdraw_settlesFirst_ownTokenOnly() public {
        _pay(p[0], palantir, nvidia, w[1], 300e6);
        uint256 before = tokenOf(nvidia).balanceOf(w[0]);
        vm.prank(w[0]);
        hook.removeLiquidity(nt, 10_000e6, w[0]);
        assertEq(tokenOf(nvidia).balanceOf(w[0]), before + 10_000e6);
        assertEq(tokenOf(palantir).balanceOf(w[0]), 0); // never a foreign token
        _assertBacked(nvidia);
        _assertBacked(palantir);
    }

    function test_frozenIssuer_haltsItsSettlement() public {
        _pay(p[0], palantir, nvidia, w[1], 300e6);
        vm.prank(p[2]);
        palantir.freeze();
        assertEq(hook.settle(), 0);
        vm.prank(w[0]); // nvidia can't take its full LP back until palantir's slice settles
        vm.expectRevert(OrbitalHook.InsufficientReserve.selector);
        hook.removeLiquidity(nt, 10_000e6, w[0]);
    }

    function test_lpOnlyFromOwnWallets() public {
        vm.prank(w[0]);
        vm.expectRevert(OrbitalHook.NotWallet.selector);
        hook.addLiquidity(pt, 1);
    }

    function test_foreignPoolInit_rejected() public {
        PoolKeyHolder memory k = PoolKeyHolder(hook.keyFor(nt, et));
        k.key.fee = 3000; // a variant facade on our hook
        vm.expectRevert();
        IPoolManager(ext.poolManager).initialize(k.key, 2 ** 96);
    }

    function testFuzz_swapSettleCycles_keepReserves(uint96 a, uint96 b, bool dir) public {
        uint256 x = bound(a, 1e6, 400e6);
        uint256 y = bound(b, 1e6, 400e6);
        if (dir) _pay(p[0], palantir, nvidia, w[1], x);
        else _pay(w[0], nvidia, palantir, p[1], x);
        skip(1 days);
        _pay(e[0], evil, palantir, p[2], y);
        hook.settle();
        _assertBacked(nvidia);
        _assertBacked(palantir);
        _assertBacked(evil);
        uint256 total;
        uint256 liq;
        for (uint256 i; i < 3; i++) {
            address t = hook.tokens(i);
            total += hook.reserveOf(t);
            liq += hook.liquidityOf(t);
            assertEq(IPoolManager(ext.poolManager).balanceOf(address(hook), uint160(t)), hook.reserveOf(t)); // ERC-6909 claims
        }
        assertGe(total, liq); // the curve never pays out more than it takes in
    }

    function _assertBacked(Vault v) internal view {
        assertGe(usdcBalance(address(v)), tokenOf(v).totalSupply(), "reserves >= supply");
    }
}
