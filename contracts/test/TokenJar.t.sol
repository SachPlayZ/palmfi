// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {UniswapTest} from "./base/UniswapTest.sol";
import {IERC20Like} from "./base/NetworkTest.sol";
import {SafetyFund} from "../src/SafetyFund.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ExchangeReleaser} from "@tjar/releasers/ExchangeReleaser.sol";
import {TokenJar} from "@tjar/TokenJar.sol";
import {FeeController} from "@tjar/FeeController.sol";
import {IResourceManager} from "@tjar/interfaces/base/IResourceManager.sol";

/// Ticket #18 (scene 8): TJAR release -> SafetyFund, and locking the jar terms.
contract TokenJarTest is UniswapTest {
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function releaser() internal view returns (ExchangeReleaser) {
        return ExchangeReleaser(net.uni.jarReleaser);
    }

    function test_jarWiring() public view {
        ExchangeReleaser r = releaser();
        assertEq(address(r.resource()), ext.usdc);
        assertEq(r.threshold(), 25e6, "25 USDC");
        assertEq(r.resourceRecipient(), net.safetyFund);
        assertEq(address(r.TOKEN_JAR()), net.uni.tokenJar);
        assertEq(TokenJar(payable(net.uni.tokenJar)).releaser(), address(r));
        assertEq(r.owner(), deployer, "unlocked until the release is demonstrated");
        assertEq(FeeController(net.uni.jarFeeController).owner(), deployer, "INITIAL_OPS_OWNER = our deployer");
        assertEq(factory().tokenJar(), net.uni.tokenJar);
    }

    function test_searcherReleaseFundsSafetyFund() public {
        // fees accumulate: onboarding ETH + PaymentRouter LINK fees
        onboardAlice();
        deal(ext.link, net.uni.tokenJar, 2e18);
        uint256 jarEth = net.uni.tokenJar.balance;
        assertGt(jarEth, 0);

        fundUsdc(searcher, 25e6);
        uint256 fundBefore = bal(ext.usdc, net.safetyFund);
        ExchangeReleaser r = releaser();
        (uint256 total, uint256 fee) = r.releaseCost();
        assertEq(fee, 0);
        Currency[] memory assets = new Currency[](2);
        assets[0] = Currency.wrap(ext.link);
        assets[1] = Currency.wrap(address(0)); // native ETH
        vm.startPrank(searcher);
        IERC20Like(ext.usdc).approve(address(r), total);
        r.release(r.nonce(), assets, searcher, 0);
        vm.stopPrank();

        assertEq(bal(ext.usdc, net.safetyFund) - fundBefore, 25e6, "SafetyFund +25 USDC");
        assertEq(bal(ext.link, searcher), 2e18, "searcher gets the jar's tokens");
        assertEq(searcher.balance, jarEth);
        assertEq(net.uni.tokenJar.balance, 0);
    }

    function test_lockedJarTermsCannotChange() public {
        ExchangeReleaser r = releaser();
        // dry run: the owner can still retune before locking
        vm.prank(deployer);
        r.setConfig(ext.usdc, net.safetyFund, 30e6, 20);
        assertEq(r.threshold(), 30e6);

        // lock: owner 0xdead, config setter zero (on both jar and releaser)
        vm.startPrank(deployer);
        r.setConfigSetter(address(0));
        r.transferOwnership(DEAD);
        TokenJar(payable(net.uni.tokenJar)).transferOwnership(DEAD);
        vm.stopPrank();
        assertEq(r.owner(), DEAD);
        assertEq(r.configSetter(), address(0));

        vm.prank(deployer);
        vm.expectRevert(IResourceManager.Unauthorized.selector);
        r.setConfig(ext.usdc, deployer, 1, 20);
        vm.prank(attacker);
        vm.expectRevert(IResourceManager.Unauthorized.selector);
        r.setConfig(ext.usdc, attacker, 1, 20);
        vm.prank(deployer);
        vm.expectRevert("UNAUTHORIZED");
        TokenJar(payable(net.uni.tokenJar)).setReleaser(deployer);
    }

    function test_safetyFundPaysOutOnlyThroughRegistry() public {
        fundUsdc(net.safetyFund, 25e6);
        vm.prank(deployer);
        vm.expectRevert(SafetyFund.OnlyRegistry.selector);
        SafetyFund(payable(net.safetyFund)).payout(ext.usdc, deployer, 25e6);
    }
}
