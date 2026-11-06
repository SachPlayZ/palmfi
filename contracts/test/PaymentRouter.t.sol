// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {UniswapTest} from "./base/UniswapTest.sol";
import {IERC20Like} from "./base/NetworkTest.sol";
import {Vault} from "../src/Vault.sol";
import {VaultHook} from "../src/uniswap/VaultHook.sol";
import {PaymentRouter} from "../src/uniswap/PaymentRouter.sol";
import {PalmTypes} from "../src/libraries/PalmTypes.sol";
import {PathKey} from "@uniswap/v4-periphery/src/libraries/PathKey.sol";

interface IAggregatorLike {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// Ticket #17 (scene 2): pay a name with LINK in one Universal Router transaction.
contract PaymentRouterTest is UniswapTest {
    Vault internal alice;

    function setUp() public override {
        super.setUp();
        alice = onboardAlice();
        deal(ext.link, bob, 10e18);
        vm.prank(bob);
        IERC20Like(ext.link).approve(address(payRouter()), type(uint256).max);
    }

    function linkToPusdc(Vault v) internal view returns (PathKey[] memory) {
        return path2(hop(ext.usdc, net.uni.linkUsdcKey), hop(address(usdcToken(v)), hookKey(v, ext.usdc)));
    }

    function test_payNameWithLink() public {
        uint256 amountIn = 1e18;
        uint256 fee = payRouter().feeOf(amountIn);
        assertEq(fee, 0.001e18, "10 bps");
        uint256 jarBefore = bal(ext.link, net.uni.tokenJar);

        vm.prank(bob);
        uint256 got = payRouter().pay("alice", ext.link, amountIn, linkToPusdc(alice), 1, block.timestamp + 60);

        assertEq(usdcToken(alice).balanceOf(hotWallet), got, "payee's Protected token at their default receiver");
        (, int256 linkUsd,,,) = IAggregatorLike(ext.linkUsdFeed).latestRoundData();
        uint256 fair = uint256(linkUsd) * 0.999e18 / 1e18 / 100; // 8dp -> 6dp USDC
        assertApproxEqRel(got, fair, 0.03e18, "priced near Chainlink");
        assertEq(bal(ext.usdc, address(alice)), got, "USDC reserves in the payee's Vault");
        assertEq(bal(ext.link, net.uni.tokenJar) - jarBefore, fee, "fee in the jar");
        assertEq(bal(ext.link, bob), 10e18 - amountIn);
        assertEq(bal(ext.link, address(payRouter())), 0, "router holds nothing");
        assertEq(payRouter().payer(), address(0), "payer cleared");
    }

    function test_hookResolvesPayerOnPaymentRouterPath() public {
        vm.recordLogs();
        vm.prank(bob);
        payRouter().pay("alice", ext.link, 1e18, linkToPusdc(alice), 1, block.timestamp + 60);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(hook()) && logs[i].topics[0] == VaultHook.VaultSwap.selector) {
                assertEq(address(uint160(uint256(logs[i].topics[2]))), bob, "swapper = original payer");
                assertEq(address(uint160(uint256(logs[i].topics[3]))), address(alice));
                seen = true;
            }
        }
        assertTrue(seen, "hook swap observed");
    }

    function test_payFrozenNameReverts() public {
        report(PalmTypes.REPORT_RESERVE_FLAG, address(alice), 0, 0, 0, PalmTypes.RESERVE_MISMATCH);
        PathKey[] memory p = linkToPusdc(alice);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PaymentRouter.NotActive.selector, PalmTypes.STATUS_FROZEN));
        payRouter().pay("alice", ext.link, 1e18, p, 1, block.timestamp + 60);
    }

    function test_payRevokedNameReverts() public {
        PathKey[] memory p = linkToPusdc(alice);
        vm.prank(deployer);
        factory().revoke("alice");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PaymentRouter.NotActive.selector, PalmTypes.STATUS_REVOKED));
        payRouter().pay("alice", ext.link, 1e18, p, 1, block.timestamp + 60);
    }

    function test_payUnknownNameReverts() public {
        PathKey[] memory p = linkToPusdc(alice);
        vm.prank(bob);
        vm.expectRevert(PaymentRouter.UnknownName.selector);
        payRouter().pay("nobody", ext.link, 1e18, p, 1, block.timestamp + 60);
    }

    function test_routeMustEndInPayeesProtectedToken() public {
        Vault carol = onboardIndividual("carol", individualConfig(makeAddr("carolOwner"), makeAddr("carolHot")));
        PathKey[] memory p = linkToPusdc(carol);
        vm.prank(bob);
        vm.expectRevert(PaymentRouter.BadRoute.selector);
        payRouter().pay("alice", ext.link, 1e18, p, 1, block.timestamp + 60);
    }

    function test_minOutEnforced() public {
        PathKey[] memory p = linkToPusdc(alice);
        vm.prank(bob);
        vm.expectRevert();
        payRouter().pay("alice", ext.link, 1e18, p, 1_000e6, block.timestamp + 60);
    }

    function test_onboardingFeeGoesToJar() public {
        uint256 before = net.uni.tokenJar.balance;
        onboardIndividual("dave", individualConfig(makeAddr("daveOwner"), makeAddr("daveHot")));
        assertEq(net.uni.tokenJar.balance - before, FEE, "0.001 ETH onboarding fee");
    }
}
