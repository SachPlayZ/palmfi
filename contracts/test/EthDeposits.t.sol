// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {NetworkTest, IERC20Like} from "./base/NetworkTest.sol";
import {Vault} from "../src/Vault.sol";

/// Ticket #4: ETH/WETH deposits, native ETH unwraps, one shared USD budget.
contract EthDepositsTest is NetworkTest {
    Vault v;

    function setUp() public override {
        super.setUp();
        v = onboardAlice();
    }

    function test_depositEthWrapsAndMintsOneToOne() public {
        vm.deal(hotWallet, 1 ether);
        vm.prank(hotWallet);
        v.depositETH{value: 0.01 ether}(hotWallet);
        assertEq(ethToken(v).balanceOf(hotWallet), 0.01 ether);
        assertEq(IERC20Like(ext.weth).balanceOf(address(v)), 0.01 ether);
    }

    function test_depositWethMintsOneToOne() public {
        fundWeth(hotWallet, 0.01 ether);
        vm.startPrank(hotWallet);
        IERC20Like(ext.weth).approve(address(v), 0.01 ether);
        v.deposit(ext.weth, 0.01 ether, hotWallet);
        vm.stopPrank();
        assertEq(ethToken(v).balanceOf(hotWallet), 0.01 ether);
    }

    function _ethFor(uint256 usd6) internal view returns (uint256) {
        // amount of ETH worth `usd6` at the live feed price
        return usd6 * 1e18 * 1e2 / uint256(ethUsdPrice());
    }

    function test_unwrapPaysNativeEthByDefault() public {
        vm.deal(hotWallet, 1 ether);
        vm.prank(hotWallet);
        v.depositETH{value: 0.01 ether}(hotWallet);
        uint256 amt = _ethFor(1e6);
        uint256 before = payee.balance;
        vm.prank(hotWallet);
        v.unwrap(ext.weth, amt, payee, false);
        assertEq(payee.balance - before, amt);
    }

    function test_unwrapPaysWethWithFlag() public {
        vm.deal(hotWallet, 1 ether);
        vm.prank(hotWallet);
        v.depositETH{value: 0.01 ether}(hotWallet);
        uint256 amt = _ethFor(1e6);
        vm.prank(hotWallet);
        v.unwrap(ext.weth, amt, payee, true);
        assertEq(IERC20Like(ext.weth).balanceOf(payee), amt);
    }

    function test_budgetIsSharedAcrossUsdcAndEth() public {
        depositUsdc(v, hotWallet, 10e6);
        vm.deal(hotWallet, 1 ether);
        vm.prank(hotWallet);
        v.depositETH{value: 0.01 ether}(hotWallet);

        vm.prank(hotWallet);
        v.unwrap(ext.usdc, 3e6, payee, false); // spend $3 of $5
        uint256 left = v.availableBudgetUsd();
        assertApproxEqAbs(left, 2e6, 0.05e6);

        uint256 tooMuch = _ethFor(2.5e6);
        uint256 fits = _ethFor(1.8e6);
        vm.prank(hotWallet);
        vm.expectPartialRevert(Vault.OverBudget.selector);
        v.unwrap(ext.weth, tooMuch, payee, false);

        vm.prank(hotWallet);
        v.unwrap(ext.weth, fits, payee, false); // fits in the remaining ~$2
    }
}
