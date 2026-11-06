// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {OrbitalHook} from "../../src/orbital/OrbitalHook.sol";
import {OrbitalRouter} from "../../src/orbital/OrbitalRouter.sol";
import {MockOrbitalVault} from "./MockOrbitalVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Fork of Arc testnet: real PoolManager, mock vaults behind IOrbitalVault.
contract OrbitalHookForkTest is Test, IUnlockCallback {
    IPoolManager constant PM = IPoolManager(0x1d70945634F618eefdF9EDaAdB59B9A183CEF929);
    uint160 constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );
    uint256 constant LP = 1_000_000e6;

    OrbitalHook hook;
    OrbitalRouter router;
    MockOrbitalVault palantir; // pUSDC
    MockOrbitalVault nvidia; // nUSDC
    MockOrbitalVault evil; // eUSDC: attacker-onboarded org

    address pWallet = makeAddr("palantirTreasury");
    address nWallet = makeAddr("nvidiaTreasury");
    address eWallet = makeAddr("evilcorp");
    address stranger = makeAddr("stranger");

    function setUp() public {
        vm.createSelectFork(vm.envOr("ARC_RPC_URL", string("https://rpc.testnet.arc.network")));
        assertEq(block.chainid, 5042002);

        router = new OrbitalRouter(PM);
        address[] memory routers = new address[](1);
        routers[0] = address(router);
        address at = address(FLAGS ^ (0x4444 << 144));
        deployCodeTo("OrbitalHook.sol:OrbitalHook", abi.encode(PM, address(this), routers), at);
        hook = OrbitalHook(at);

        palantir = _org("pUSDC", pWallet, 10_000e6);
        nvidia = _org("nUSDC", nWallet, 10_000e6);
        evil = _org("eUSDC", eWallet, 10_000e6);
    }

    function _org(string memory sym, address wallet, uint256 budget) internal returns (MockOrbitalVault v) {
        v = new MockOrbitalVault(sym);
        v.setHook(hook);
        v.setWallet(wallet, budget);
        hook.registerToken(v); // this test is the factory
        v.provide(LP);
        _approve(v, wallet, address(router));
    }

    function _approve(MockOrbitalVault v, address owner, address spender) internal {
        IERC20 t = IERC20(v.token());
        vm.prank(owner);
        t.approve(spender, type(uint256).max);
    }

    function _pay(address from, MockOrbitalVault vIn, MockOrbitalVault vOut, int256 amount, address to)
        internal
        returns (uint256 amountIn, uint256 amountOut)
    {
        return _payExpect(from, vIn, vOut, amount, to, "");
    }

    /// View calls happen first so a pending expectRevert lands on the swap itself.
    function _payExpect(
        address from,
        MockOrbitalVault vIn,
        MockOrbitalVault vOut,
        int256 amount,
        address to,
        bytes memory err
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        address tIn = vIn.token();
        PoolKey memory key = hook.pairKey(tIn, vOut.token());
        if (err.length > 0) vm.expectRevert(err);
        vm.prank(from);
        (amountIn, amountOut) =
            router.swap(key, Currency.unwrap(key.currency0) == tIn, amount, amount < 0 ? 0 : type(uint256).max, to);
    }

    function _hookRevert(bytes memory inner) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            IHooks.beforeSwap.selector,
            inner,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    // ------------------------------------------------------------------ payments

    function test_setup_reservesAreClaims() public view {
        assertEq(hook.tokenCount(), 3);
        for (uint256 k; k < 3; ++k) {
            address t = hook.tokens(k);
            assertEq(hook.reserveOf(t), LP);
            assertEq(PM.balanceOf(address(hook), Currency.wrap(t).toId()), LP);
        }
        // equal reserves, n=3: x = r (1 - 1/sqrt 3)
        assertApproxEqRel(hook.radius(), LP * 1e12 * 2366025403784438647 / 1e18, 1e9);
    }

    function test_payment_palantirToNvidia_exactIn() public {
        uint256 pBefore = palantir.protected().balanceOf(pWallet);
        uint256 quote = hook.quoteExactIn(palantir.token(), nvidia.token(), 1_000e6);
        (uint256 amountIn, uint256 amountOut) = _pay(pWallet, palantir, nvidia, -1_000e6, nWallet);

        assertEq(amountIn, 1_000e6);
        assertEq(amountOut, quote);
        assertApproxEqRel(amountOut, 1_000e6, 0.002e18); // near 1:1 on a balanced 1M pool
        assertLe(amountOut, 1_000e6);
        assertEq(nvidia.protected().balanceOf(nWallet), 1_000_000e6 + amountOut);
        assertEq(palantir.protected().balanceOf(pWallet), pBefore - 1_000e6);
        assertEq(palantir.budget(pWallet), 9_000e6, "payer budget charged");
        assertEq(hook.reserveOf(palantir.token()), LP + 1_000e6);
        assertEq(hook.reserveOf(nvidia.token()), LP - amountOut);
        assertEq(PM.balanceOf(address(hook), Currency.wrap(nvidia.token()).toId()), LP - amountOut);
    }

    function test_payment_exactOut() public {
        (uint256 amountIn, uint256 amountOut) = _pay(pWallet, palantir, nvidia, 500e6, nWallet);
        assertEq(amountOut, 500e6);
        assertGe(amountIn, 500e6);
        assertEq(nvidia.protected().balanceOf(nWallet), 1_000_000e6 + 500e6);
        assertEq(palantir.budget(pWallet), 10_000e6 - amountIn);
    }

    function test_reverseDirection() public {
        _pay(nWallet, nvidia, palantir, -2_000e6, pWallet);
        assertEq(nvidia.budget(nWallet), 8_000e6);
    }

    // ------------------------------------------------------------------ controls

    function test_overBudget_reverts() public {
        bytes memory err = _hookRevert(abi.encodeWithSelector(MockOrbitalVault.OverBudget.selector, 10_001e6, 10_000e6));
        _payExpect(pWallet, palantir, nvidia, -10_001e6, nWallet, err);
    }

    function test_frozenOutputToken_reverts() public {
        nvidia.setFrozen(true);
        _payExpect(
            pWallet,
            palantir,
            nvidia,
            -100e6,
            nWallet,
            _hookRevert(abi.encodeWithSelector(OrbitalHook.Frozen.selector, nvidia.token()))
        );
    }

    function test_frozenInputToken_reverts() public {
        palantir.setFrozen(true);
        _payExpect(
            pWallet,
            palantir,
            nvidia,
            -100e6,
            nWallet,
            _hookRevert(abi.encodeWithSelector(OrbitalHook.Frozen.selector, palantir.token()))
        );
    }

    function test_attackerOrgExit_chargedToPayer() public {
        // hacked Palantir wallet dumps pUSDC into evilcorp's token: Palantir's budget still binds
        _pay(pWallet, palantir, evil, -10_000e6, eWallet);
        assertEq(palantir.budget(pWallet), 0);
        assertEq(evil.budget(eWallet), 10_000e6, "attacker org budget untouched");
        _payExpect(
            pWallet,
            palantir,
            evil,
            -1e6,
            eWallet,
            _hookRevert(abi.encodeWithSelector(MockOrbitalVault.OverBudget.selector, 1e6, 0))
        );
    }

    function test_recipientMustBeOutputVaultWallet() public {
        // ERC-6909 / arbitrary-recipient leak: output only lands on the output vault's whitelist
        _payExpect(
            pWallet,
            palantir,
            nvidia,
            -100e6,
            stranger,
            _hookRevert(abi.encodeWithSelector(OrbitalHook.RecipientNotWallet.selector, stranger))
        );
    }

    function test_nonWalletPayer_reverts() public {
        _approve(palantir, stranger, address(router));
        _payExpect(
            stranger,
            palantir,
            nvidia,
            -1e6,
            nWallet,
            _hookRevert(abi.encodeWithSelector(MockOrbitalVault.NotWallet.selector, stranger))
        );
    }

    function test_untrustedRouter_reverts() public {
        OrbitalRouter rogue = new OrbitalRouter(PM);
        PoolKey memory key = hook.pairKey(palantir.token(), nvidia.token());
        _approve(palantir, pWallet, address(rogue));
        bool z = Currency.unwrap(key.currency0) == palantir.token();
        vm.expectRevert(_hookRevert(abi.encodeWithSelector(OrbitalHook.UntrustedRouter.selector)));
        vm.prank(pWallet);
        rogue.swap(key, z, -1e6, 0, nWallet);
    }

    function test_slippage_reverts() public {
        PoolKey memory key = hook.pairKey(palantir.token(), nvidia.token());
        bool z = Currency.unwrap(key.currency0) == palantir.token();
        uint256 q = hook.quoteExactIn(palantir.token(), nvidia.token(), 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(OrbitalRouter.Slippage.selector, 1_000e6, q));
        vm.prank(pWallet);
        router.swap(key, z, -1_000e6, q + 1, nWallet);
    }

    // ------------------------------------------------------------------ pool pins

    function test_initializeOnlyByHook() public {
        PoolKey memory key = hook.pairKey(palantir.token(), nvidia.token());
        key.tickSpacing = 2; // new PoolId, otherwise pinned params
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(OrbitalHook.NotHook.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        PM.initialize(key, 1 << 96);
    }

    function test_v4LiquidityBlocked() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeAddLiquidity.selector,
                abi.encodeWithSelector(OrbitalHook.LiquidityNotAllowed.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        PM.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        PM.modifyLiquidity(
            hook.pairKey(palantir.token(), nvidia.token()),
            ModifyLiquidityParams({tickLower: -10, tickUpper: 10, liquidityDelta: 1e18, salt: 0}),
            ""
        );
        return "";
    }

    function test_addLiquidity_ownTokenOnly() public {
        vm.expectRevert(OrbitalHook.NotVault.selector);
        hook.addLiquidity(palantir, 1e6);
    }

    function test_registerToken_onlyFactory() public {
        MockOrbitalVault v = new MockOrbitalVault("xUSDC");
        vm.prank(stranger);
        vm.expectRevert(OrbitalHook.NotFactory.selector);
        hook.registerToken(v);
    }

    function test_newTokenInactiveUntilLp() public {
        MockOrbitalVault v = new MockOrbitalVault("xUSDC");
        v.setHook(hook);
        v.setWallet(stranger, 1e12);
        hook.registerToken(v);
        (address p, address x) = (palantir.token(), v.token());
        vm.expectRevert(abi.encodeWithSelector(OrbitalHook.InactiveToken.selector, x));
        hook.quoteExactIn(p, x, 1e6);
        v.provide(LP);
        assertGt(hook.quoteExactIn(palantir.token(), v.token(), 1e6), 0);
    }
}
