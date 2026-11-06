// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {UniswapTest} from "./base/UniswapTest.sol";
import {Vault} from "../src/Vault.sol";
import {SafeHarborSwapper} from "../src/uniswap/SafeHarborSwapper.sol";
import {PalmTypes} from "../src/libraries/PalmTypes.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

interface IFeedTs {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// Ticket #19 (scene 4): Safe-harbor swaps ETH -> USDC inside the Vault + Market modes.
contract SafeHarborTest is UniswapTest {
    Vault internal alice;
    uint256 internal constant SWAP_IN = 0.002 ether;

    function setUp() public override {
        super.setUp();
        alice = onboardAlice();
        vm.deal(hotWallet, 1 ether);
        vm.prank(hotWallet);
        alice.depositETH{value: 0.01 ether}(hotWallet);
    }

    function route(PoolKey memory k) internal pure returns (bytes memory) {
        return abi.encode(k);
    }

    function test_safeHarborSwapAtOracleCheckedPrice() public {
        uint256 minOut = alice.safeHarborMinOut(SWAP_IN);
        uint256 budgetBefore = alice.availableBudgetUsd();
        vm.prank(hotWallet);
        uint256 out = alice.safeHarborSwap(SWAP_IN, route(net.uni.wethUsdcKey));
        assertGe(out, minOut, "at least Chainlink x (1 - 2%)");
        assertEq(usdcToken(alice).balanceOf(hotWallet), out, "pUSDC minted to the Hot wallet");
        assertEq(ethToken(alice).balanceOf(hotWallet), 0.01 ether - SWAP_IN);
        assertEq(bal(ext.usdc, address(alice)), out, "USDC reserves");
        assertEq(bal(ext.weth, address(alice)), 0.01 ether - SWAP_IN, "WETH reserves");
        assertEq(alice.availableBudgetUsd(), budgetBefore, "no Instant budget used");
        assertEq(bal(ext.weth, net.uni.safeHarborSwapper), 0, "swapper holds nothing");
    }

    function test_nonAllowlistedPoolReverts() public {
        vm.prank(hotWallet);
        vm.expectRevert(SafeHarborSwapper.NotAllowlisted.selector);
        alice.safeHarborSwap(SWAP_IN, route(net.uni.linkUsdcKey));

        PoolKey memory k = net.uni.wethUsdcKey;
        k.fee = 3000;
        k.tickSpacing = 60;
        vm.prank(hotWallet);
        vm.expectRevert(SafeHarborSwapper.NotAllowlisted.selector);
        alice.safeHarborSwap(SWAP_IN, route(k));
    }

    function test_belowMinimumOutputReverts() public {
        // someone pushes the allowlisted pool's price down (> 2% off Chainlink)
        fundWeth(attacker, 0.2 ether);
        urSwap(attacker, ext.weth, path1(hop(ext.usdc, net.uni.wethUsdcKey)), 0.2 ether, 0, attacker);
        vm.prank(hotWallet);
        vm.expectRevert();
        alice.safeHarborSwap(SWAP_IN, route(net.uni.wethUsdcKey));
        assertEq(ethToken(alice).balanceOf(hotWallet), 0.01 ether, "nothing changed");
    }

    function test_volatileModeWidensCapToFivePercent() public {
        uint256 normal = alice.safeHarborMinOut(1 ether);
        report(PalmTypes.REPORT_MARKET_MODE, address(0), uint160(ext.weth), 0, PalmTypes.MODE_VOLATILE, 0);
        uint256 volatile_ = alice.safeHarborMinOut(1 ether);
        assertApproxEqRel(volatile_ * 98, normal * 95, 1e12, "5% vs 2% cap");
        vm.prank(hotWallet);
        alice.safeHarborSwap(SWAP_IN, route(net.uni.wethUsdcKey));
    }

    function test_degradedModeBlocksSwapsAndInstantLane() public {
        report(PalmTypes.REPORT_MARKET_MODE, address(0), uint160(ext.weth), 0, PalmTypes.MODE_DEGRADED, 0);
        assertEq(alice.marketModeOf(ext.weth), PalmTypes.MODE_DEGRADED);
        vm.prank(hotWallet);
        vm.expectRevert(abi.encodeWithSelector(Vault.Degraded.selector, ext.weth));
        alice.safeHarborSwap(SWAP_IN, route(net.uni.wethUsdcKey));
        vm.prank(hotWallet);
        vm.expectRevert(abi.encodeWithSelector(Vault.Degraded.selector, ext.weth));
        alice.unwrap(ext.weth, 0.001 ether, payee, false);

        // back to Normal: both work again
        report(PalmTypes.REPORT_MARKET_MODE, address(0), uint160(ext.weth), 0, PalmTypes.MODE_NORMAL, 0);
        vm.prank(hotWallet);
        alice.safeHarborSwap(SWAP_IN, route(net.uni.wethUsdcKey));
    }

    function test_staleFeedForcesDegraded() public {
        (,,, uint256 updatedAt,) = IFeedTs(ext.ethUsdFeed).latestRoundData();
        vm.warp(updatedAt + 3600 + 1 hours + 1);
        assertEq(alice.marketModeOf(ext.weth), PalmTypes.MODE_DEGRADED, "Vault forces Degraded on stale feeds");
        vm.prank(hotWallet);
        vm.expectRevert(abi.encodeWithSelector(Vault.Degraded.selector, ext.weth));
        alice.safeHarborSwap(SWAP_IN, route(net.uni.wethUsdcKey));
    }

    function test_onlyEthToUsdc() public {
        // the allowlist can only ever hold WETH/USDC keys
        PoolKey[] memory keys = new PoolKey[](1);
        keys[0] = net.uni.linkUsdcKey;
        vm.expectRevert(SafeHarborSwapper.BadPair.selector);
        new SafeHarborSwapper(IPoolManager(ext.poolManager), net.factory, ext.weth, ext.usdc, keys);

        // only factory Vaults can use the swapper, and only with WETH in hand (no USDC -> WETH entry point)
        SafeHarborSwapper s = SafeHarborSwapper(net.uni.safeHarborSwapper);
        fundUsdc(attacker, 10e6);
        vm.prank(attacker);
        vm.expectRevert(SafeHarborSwapper.NotVault.selector);
        s.swap(1e6, 0, route(net.uni.wethUsdcKey));
    }

    function test_frozenVaultCannotSwap() public {
        report(PalmTypes.REPORT_DELEGATION_FLAG, address(alice), 0, 0, 0, PalmTypes.DELEGATION_CHANGED);
        vm.prank(hotWallet);
        vm.expectRevert(Vault.NotActive.selector);
        alice.safeHarborSwap(SWAP_IN, route(net.uni.wethUsdcKey));
    }
}
