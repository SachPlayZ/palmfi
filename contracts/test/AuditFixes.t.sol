// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {NetworkTest} from "./base/NetworkTest.sol";
import {PalmTypes as T} from "../src/libraries/PalmTypes.sol";
import {Vault} from "../src/Vault.sol";
import {VaultBase} from "../src/VaultBase.sol";
import {OrbitalHook} from "../src/orbital/OrbitalHook.sol";
import {OrbitalRouter} from "../src/orbital/OrbitalRouter.sol";
import {ProtectedToken} from "../src/tokens/ProtectedToken.sol";

/// Regressions for the Arc Studio audit (F-1, F-7, F-9, F-11): a minority of wallets can't block recovery.
contract AuditGovTest is NetworkTest {
    /// F-1: a hacked wallet freezes, but can't cancel the unfreeze, the migration or its own removal.
    function test_hackedWalletCantCancelProtectiveChanges() public {
        Vault v = Vault(factory().createVault("gov", config(wallets(4))));
        depositUsdc(v, w[1], 1_000e6);
        address hacked = w[0];
        vm.prank(hacked);
        v.freeze();

        vm.prank(w[1]);
        uint256 rid = mod(v).proposeChange(T.CHANGE_REMOVE_WALLET, abi.encode(hacked));
        vm.prank(hacked);
        vm.expectRevert(VaultBase.NotCancellable.selector);
        mod(v).cancelChange(rid);
        vm.prank(w[2]);
        mod(v).voteChange(rid);
        vm.prank(w[3]);
        mod(v).voteChange(rid); // 3 of 4: majority, no timelock
        assertFalse(v.isWallet(hacked), "hacked wallet removed");

        vm.prank(w[1]);
        uint256 uid = mod(v).proposeChange(T.CHANGE_UNFREEZE, "");
        vm.prank(w[2]);
        mod(v).voteChange(uid);
        assertEq(hub().statusOf(address(v)), T.STATUS_ACTIVE, "unfrozen by the honest majority");
    }

    function test_migrateIsNotCancellable() public {
        Vault v = Vault(factory().createVault("gov3", config(wallets(3))));
        vm.prank(w[1]);
        uint256 id = mod(v).proposeChange(T.CHANGE_MIGRATE, "");
        vm.prank(w[0]);
        vm.expectRevert(VaultBase.NotCancellable.selector);
        mod(v).cancelChange(id);
    }

    /// F-1b / F-11: delays are bounded, so a single wallet can't push requests past their TTL.
    function test_delaysBounded() public {
        Vault v = Vault(factory().createVault("lim", config(wallets(3))));
        uint32 maxD = v.MAX_DELAY_LIMIT();
        (uint128 cap, uint32 floor_, uint32 capD) = (v.hardCap(), v.floorDelay(), v.capDelay());
        vm.startPrank(w[0]);
        vm.expectRevert(VaultBase.BadLimits.selector);
        mod(v).tightenLimits(cap, floor_, type(uint32).max, capD);
        mod(v).tightenLimits(cap, floor_, maxD, capD); // at the bound: fine
        vm.expectRevert(VaultBase.BadLimits.selector);
        mod(v).proposeChange(T.CHANGE_LIMITS, abi.encode(uint128(1e6), uint32(0), uint32(1 hours), uint32(1 hours)));
        vm.stopPrank();

        // the slowest request still executes inside REQUEST_TTL
        depositUsdc(v, w[1], 1_000e6);
        vm.prank(w[1]);
        uint256 id = v.requestUnwrap(100e6, outsider);
        skip(maxD);
        assertTrue(v.isExecutable(id));

        T.VaultConfig memory c = config(wallets(3));
        c.maxDelay = maxD + 1;
        vm.expectRevert(VaultBase.BadLimits.selector);
        factory().createVault("toolong", c);
    }

    /// F-9: a leaving wallet's tokens go to the receiving wallet instead of being stranded.
    function test_leaveMovesTokens() public {
        Vault v = Vault(factory().createVault("strand", config(wallets(4))));
        depositUsdc(v, w[1], 500e6);
        vm.prank(w[1]);
        mod(v).leave();
        ProtectedToken t = tokenOf(v);
        assertEq(t.balanceOf(w[1]), 0);
        assertEq(t.balanceOf(v.wallets()[0]), 500e6);
        assertEq(t.totalSupply(), 500e6);
    }

    /// F-7: an unverified (throwaway) Vault's FLAG freezes itself but blocklists nobody.
    function test_unverifiedFlagDoesNotBlocklist() public {
        Vault v = onboard("throwaway", 3);
        depositUsdc(v, w[0], 1_000e6);
        vm.prank(w[0]);
        uint256 id = v.requestUnwrap(900e6, outsider);
        flag(v, id, T.BLOCKLISTED_DEST);
        assertEq(hub().statusOf(address(v)), T.STATUS_FROZEN);
        assertFalse(hub().isBlocked(outsider));
    }
}

/// Regressions for the audit's pool findings (F-2, F-4, F-12).
contract AuditOrbitalTest is NetworkTest {
    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );
    OrbitalHook hook;
    OrbitalRouter router;

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
    }

    function _lp(Vault v, address wallet, uint256 amount) internal {
        depositUsdc(v, wallet, amount);
        vm.startPrank(wallet);
        tokenOf(v).approve(address(hook), amount);
        hook.addLiquidity(v.token(), amount);
        vm.stopPrank();
    }

    function _rug() internal returns (Vault rug, address[] memory r, address cold) {
        r = new address[](3);
        for (uint256 i; i < 3; i++) {
            r[i] = makeAddr(string.concat("rug", vm.toString(i)));
        }
        T.VaultConfig memory c = config(r);
        c.budget24h = c.budget7d = c.hardCap = 1e12;
        cold = c.recoveryVault = makeAddr("attackerCold");
        rug = Vault(factory().createVault("rugcorp", c));
    }

    /// F-2: output can't be parked in a Vault contract; migrating keeps USDC behind the pool's tokens, and
    /// settlement then pays the victim org in USDC.
    function test_rugOrgCantUnbackPoolTokens() public {
        Vault nvidia = onboard("nvidia", 3);
        address nt = nvidia.token();
        _lp(nvidia, w[0], 10_000e6);
        (Vault rug, address[] memory r, address cold) = _rug();
        address rt = rug.token();
        _lp(rug, r[0], 1_000e6);
        depositUsdc(rug, r[0], 20_000e6);
        vm.startPrank(r[0]);
        ProtectedToken(rt).approve(address(router), type(uint256).max);
        vm.expectRevert(OrbitalRouter.BadRecipient.selector);
        router.swap(rt, nt, 9_000e6, false, type(uint256).max, address(nvidia));
        (uint256 paid,) = router.swap(rt, nt, 5_000e6, false, type(uint256).max, w[2]);
        vm.stopPrank();

        vm.prank(r[0]);
        uint256 id = mod(rug).proposeChange(T.CHANGE_MIGRATE, "");
        vm.prank(r[1]);
        mod(rug).voteChange(id);
        uint256 pooled = hook.reserveOf(rt);
        assertEq(usdcBalance(address(rug)), ProtectedToken(rt).totalSupply(), "pool tokens stay backed");
        assertEq(usdcBalance(cold), 21_000e6 - pooled, "only the unencumbered USDC leaves");

        uint256 before = usdcBalance(address(nvidia));
        uint256 moved = hook.settle();
        assertEq(moved, paid, "the rug org's swap-in settles into nvidia in USDC");
        assertEq(usdcBalance(address(nvidia)), before + moved);
        // nvidia's pooled inventory is whole again up to the pool's pricing: what it gave out came back in USDC
        assertEq(hook.reserveOf(nt), 10_000e6 - 5_000e6 + moved);
        uint256 avail = hook.reserveOf(nt);
        vm.prank(w[0]);
        hook.removeLiquidity(nt, avail, w[0]);
        assertEq(tokenOf(nvidia).balanceOf(w[0]), avail);
    }

    /// F-12: a lone funded token has no sphere: swaps revert cleanly instead of panicking.
    function test_unfundedPairRevertsCleanly() public {
        Vault a = onboard("alpha", 3);
        Vault b = onboard("beta", 3);
        _lp(a, w[0], 1_000e6);
        address payer = b.wallets()[0];
        (address bt, address at_) = (b.token(), a.token());
        depositUsdc(b, payer, 100e6);
        vm.startPrank(payer);
        ProtectedToken(bt).approve(address(router), type(uint256).max);
        vm.expectRevert(); // InsufficientLiquidity, wrapped by the PoolManager
        router.swap(bt, at_, 10e6, true, 0, w[1]);
        vm.stopPrank();
    }

    /// F-4: spam registrations neither push the sphere off-curve nor block onboarding when the pool is full.
    function test_spamCantBrickPoolOrOnboarding() public {
        for (uint256 i; i < 32; i++) {
            factory().createVault(string.concat("spam", vm.toString(i)), config(wallets(3)));
        }
        Vault late = Vault(factory().createVault("honestlate", config(wallets(3))));
        assertEq(hook.vaultOf(late.token()), address(0), "onboarded without a pool seat");

        Vault s0 = Vault(hub().resolve("spam0"));
        Vault s1 = Vault(hub().resolve("spam1"));
        _lp(s0, w[0], 1_000e6);
        _lp(s1, w[0], 500e6); // one-sided pair among 32 registered tokens: still on-sphere
        assertGt(hook.radius(), 0);
    }
}
