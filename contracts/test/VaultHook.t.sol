// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {UniswapTest, RawPoolUser} from "./base/UniswapTest.sol";
import {IERC20Like} from "./base/NetworkTest.sol";
import {Vault} from "../src/Vault.sol";
import {VaultHook} from "../src/uniswap/VaultHook.sol";
import {PoolSeeder} from "../src/uniswap/PoolSeeder.sol";
import {ProtectedToken} from "../src/tokens/ProtectedToken.sol";
import {PalmTypes} from "../src/libraries/PalmTypes.sol";
import {IUniversalRouter, URCommands} from "../src/uniswap/UniswapTypes.sol";
import {IPermit2} from "../src/uniswap/UniswapTypes.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";

/// Ticket #16: the VaultHook through the real Universal Router 2.1.2 on a Sepolia fork.
contract VaultHookTest is UniswapTest {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for *;

    Vault internal alice;

    function setUp() public override {
        super.setUp();
        alice = onboardAlice();
    }

    function test_hookAddressAndPoolsCreatedAtOnboarding() public view {
        assertEq(uint160(address(hook())) & Hooks.ALL_HOOK_MASK, uint160(0x2888), "mined flag bits");
        assertEq(factory().hook(), address(hook()));
        PoolKey memory k = hookKey(alice, ext.usdc);
        (address v, address u, address t) = hook().pools(k.toId());
        assertEq(v, address(alice));
        assertEq(u, ext.usdc);
        assertEq(t, address(usdcToken(alice)));
        (uint160 sqrtP,,,) = pm().getSlot0(k.toId());
        assertGt(sqrtP, 0, "pool initialized in the onboarding tx");
        assertGt(_slot0(hookKey(alice, ext.weth)), 0, "one pool per Underlying");
    }

    // --- wraps ---

    function test_wrapThroughUniversalRouterDeliversToHotWallet() public {
        fundUsdc(bob, 10e6);
        urSwap(bob, ext.usdc, path1(hop(address(usdcToken(alice)), hookKey(alice, ext.usdc))), 10e6, 10e6, hotWallet);
        assertEq(usdcToken(alice).balanceOf(hotWallet), 10e6, "1:1 into Alice's Hot wallet");
        assertEq(bal(ext.usdc, address(alice)), 10e6, "Underlying sits in the Vault");
        assertEq(usdcToken(alice).totalSupply(), 10e6);
        assertEq(usdcToken(alice).balanceOf(ext.poolManager), 0, "no residue in the PoolManager");
        assertEq(bal(ext.usdc, address(hook())), 0, "hook holds nothing");
    }

    function test_wrapToOutsiderReverts() public {
        fundUsdc(bob, 10e6);
        PoolKey memory k = hookKey(alice, ext.usdc);
        urSwapReverts(bob, ext.usdc, path1(hop(address(usdcToken(alice)), k)), 10e6, 0, bob);
    }

    // --- unwraps (Instant budget) ---

    function test_unwrapWithinBudgetThroughUniversalRouter() public {
        depositUsdc(alice, hotWallet, 30e6);
        urSwap(hotWallet, address(usdcToken(alice)), path1(hop(ext.usdc, hookKey(alice, ext.usdc))), 3e6, 3e6, vendor);
        assertEq(bal(ext.usdc, vendor), 3e6, "vendor paid in USDC");
        assertEq(usdcToken(alice).balanceOf(hotWallet), 27e6);
        assertEq(usdcToken(alice).totalSupply(), 27e6, "burned");
        assertEq(bal(ext.usdc, address(alice)), 27e6, "reserves still cover supply");
        assertApproxEqAbs(alice.availableBudgetUsd(), 2e6, 0.05e6, "same shared Instant budget");
    }

    function test_unwrapAboveBudgetReverts() public {
        depositUsdc(alice, hotWallet, 30e6);
        PoolKey memory k = hookKey(alice, ext.usdc);
        urSwapReverts(hotWallet, address(usdcToken(alice)), path1(hop(ext.usdc, k)), 6e6, 0, vendor);
    }

    function test_unwrapSharesBudgetWithDirectUnwrap() public {
        depositUsdc(alice, hotWallet, 30e6);
        vm.prank(hotWallet);
        alice.unwrap(ext.usdc, 4e6, payee, false);
        PoolKey memory k = hookKey(alice, ext.usdc);
        urSwapReverts(hotWallet, address(usdcToken(alice)), path1(hop(ext.usdc, k)), 2e6, 0, vendor);
    }

    function test_freezeBlocksHookUnwrapInSameBlock() public {
        depositUsdc(alice, hotWallet, 30e6);
        uint256 blockBefore = block.number;
        report(PalmTypes.REPORT_DELEGATION_FLAG, address(alice), 0, 0, 0, PalmTypes.DELEGATION_CHANGED);
        assertEq(hub().statusOf(address(alice)), PalmTypes.STATUS_FROZEN);
        PoolKey memory k = hookKey(alice, ext.usdc);
        urSwapReverts(hotWallet, address(usdcToken(alice)), path1(hop(ext.usdc, k)), 1e6, 0, vendor);
        assertEq(block.number, blockBefore, "same block");
    }

    function test_freezeAfterFlagVerdictBlocksHookUnwrap() public {
        depositUsdc(alice, hotWallet, 30e6);
        vm.deal(hotWallet, 1 ether);
        vm.prank(hotWallet);
        uint256 id = alice.requestUnwrap{value: BOND}(ext.usdc, 20e6, attacker, false);
        verdict(alice, id, PalmTypes.VERDICT_FLAG, PalmTypes.NEW_DESTINATION);
        assertEq(hub().statusOf(address(alice)), PalmTypes.STATUS_FROZEN);
        PoolKey memory k = hookKey(alice, ext.usdc);
        urSwapReverts(hotWallet, address(usdcToken(alice)), path1(hop(ext.usdc, k)), 1e6, 0, vendor);
    }

    function test_degradedBlocksHookUnwrap() public {
        depositUsdc(alice, hotWallet, 30e6);
        report(PalmTypes.REPORT_MARKET_MODE, address(0), uint160(ext.usdc), 0, PalmTypes.MODE_DEGRADED, 0);
        PoolKey memory k = hookKey(alice, ext.usdc);
        urSwapReverts(hotWallet, address(usdcToken(alice)), path1(hop(ext.usdc, k)), 1e6, 0, vendor);
    }

    // --- pool-key and liquidity restrictions ---

    function test_nonFactoryPoolInitializeReverts() public {
        // a fresh pair pointed at our hook
        PoolKey memory fake = PoolKey(
            Currency.wrap(ext.usdc), Currency.wrap(ext.weth), 0, 1, IHooks(address(hook()))
        );
        if (ext.weth < ext.usdc) (fake.currency0, fake.currency1) = (fake.currency1, fake.currency0);
        vm.expectRevert();
        pm().initialize(fake, 79228162514264337593543950336);

        // the real pair with a different fee / tick spacing
        PoolKey memory k = hookKey(alice, ext.usdc);
        k.fee = 3000;
        k.tickSpacing = 60;
        vm.expectRevert();
        pm().initialize(k, 79228162514264337593543950336);

        // calling the hook directly is PoolManager-only
        PoolKey memory real = hookKey(alice, ext.usdc);
        vm.expectRevert();
        hook().beforeInitialize(address(hook()), real, 0);
    }

    function test_addLiquidityReverts() public {
        PoolKey memory k = hookKey(alice, ext.usdc);
        fundUsdc(attacker, 10e6);
        PoolSeeder seeder = PoolSeeder(net.uni.poolSeeder);
        vm.startPrank(attacker);
        IERC20Like(ext.usdc).approve(address(seeder), type(uint256).max);
        vm.expectRevert(); // VaultHook.LiquidityNotAllowed (wrapped by the PoolManager)
        seeder.seed(k, 0, 10, 10e6, 10e6);
        vm.stopPrank();
    }

    function test_onlyFactoryCanCreatePools() public {
        address[] memory u = new address[](1);
        u[0] = ext.usdc;
        vm.prank(attacker);
        vm.expectRevert(VaultHook.NotFactory.selector);
        hook().initializePools(address(alice), u, u);
    }

    // --- router trust ---

    function test_untrustedRouterReverts() public {
        RawPoolUser raw = new RawPoolUser(pm());
        PoolKey memory k = hookKey(alice, ext.usdc);
        bool zeroForOne = Currency.unwrap(k.currency0) == ext.usdc; // wrap direction
        vm.expectRevert();
        raw.swapDirect(k, zeroForOne, 1e6);
    }

    function test_exactOutputReverts() public {
        fundUsdc(hotWallet, 5e6);
        PoolKey memory k = hookKey(alice, ext.usdc);
        bool zeroForOne = Currency.unwrap(k.currency0) == ext.usdc;
        bytes memory actions = abi.encodePacked(
            uint8(Actions.SETTLE), uint8(Actions.SWAP_EXACT_OUT_SINGLE), uint8(Actions.TAKE_ALL)
        );
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(Currency.wrap(ext.usdc), uint256(5e6), true);
        params[1] = abi.encode(IV4Router.ExactOutputSingleParams(k, zeroForOne, 1e6, 5e6, 0, ""));
        params[2] = abi.encode(Currency.wrap(address(usdcToken(alice))), uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        vm.startPrank(hotWallet, hotWallet);
        IERC20Like(ext.usdc).approve(ext.permit2, type(uint256).max);
        IPermit2(ext.permit2).approve(ext.usdc, ext.universalRouter, 5e6, uint48(block.timestamp + 1));
        vm.expectRevert();
        IUniversalRouter(ext.universalRouter).execute(abi.encodePacked(URCommands.V4_SWAP), inputs, block.timestamp);
        vm.stopPrank();
    }

    // --- ERC-6909 claims ---

    function test_erc6909ClaimCannotBeRedeemedToOutsider() public {
        depositUsdc(alice, hotWallet, 10e6);
        ProtectedToken t = usdcToken(alice);
        RawPoolUser raw = new RawPoolUser(pm());
        vm.prank(hotWallet);
        t.approve(address(raw), 10e6);
        raw.mintClaim(address(t), hotWallet, attacker, 10e6); // Hot wallet -> PoolManager is allowed
        assertEq(pm().balanceOf(attacker, uint256(uint160(address(t)))), 10e6, "claim circulates");

        vm.prank(attacker);
        pm().setOperator(address(raw), true);
        vm.expectRevert(abi.encodeWithSelector(ProtectedToken.TransferNotAllowed.selector, ext.poolManager, attacker));
        raw.redeemClaim(address(t), attacker, attacker, 10e6);

        // only a Hot wallet of the Owner can ever receive the redeemed token
        raw.redeemClaim(address(t), attacker, hotWallet2, 10e6);
        assertEq(t.balanceOf(hotWallet2), 10e6);
    }

    // --- UR 2.1.2 struct encoding, dry-run against the live deployment ---

    function test_ur212StructEncodingDryRun() public {
        // SWAP_EXACT_IN_SINGLE with the 6-field struct (minHopPriceX36) on our seeded WETH/USDC pool.
        assertTrue(net.uni.seeded, "pools seeded");
        fundWeth(bob, 0.001 ether);
        PoolKey memory k = net.uni.wethUsdcKey;
        bool zeroForOne = Currency.unwrap(k.currency0) == ext.weth;
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(IV4Router.ExactInputSingleParams(k, zeroForOne, 0.001 ether, 1, 0, ""));
        params[1] = abi.encode(Currency.wrap(ext.weth), uint256(0.001 ether));
        params[2] = abi.encode(Currency.wrap(ext.usdc), uint256(1));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        vm.startPrank(bob, bob);
        IERC20Like(ext.weth).approve(ext.permit2, type(uint256).max);
        IPermit2(ext.permit2).approve(ext.weth, ext.universalRouter, 0.001 ether, uint48(block.timestamp + 1));
        IUniversalRouter(ext.universalRouter).execute(abi.encodePacked(URCommands.V4_SWAP), inputs, block.timestamp);
        vm.stopPrank();
        uint256 fair = uint256(ethUsdPrice()) / 100 / 1000; // 0.001 ETH in USDC (6dp)
        assertApproxEqRel(bal(ext.usdc, bob), fair, 0.02e18, "priced near Chainlink");

        // Multi-hop SWAP_EXACT_IN with PathKey[] + minHopPriceX36[]: USDC -> WETH (plain) -> pETH (hook).
        fundUsdc(bob, 2e6);
        urSwap(
            bob,
            ext.usdc,
            path2(hop(ext.weth, k), hop(address(ethToken(alice)), hookKey(alice, ext.weth))),
            2e6,
            1,
            hotWallet
        );
        assertGt(ethToken(alice).balanceOf(hotWallet), 0, "two hops, hook last");
    }

    function _slot0(PoolKey memory k) internal view returns (uint160 sqrtP) {
        (sqrtP,,,) = pm().getSlot0(k.toId());
    }
}
