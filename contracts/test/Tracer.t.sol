// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {NetworkTest, IERC20Like} from "./base/NetworkTest.sol";
import {Vault} from "../src/Vault.sol";
import {PalmTypes} from "../src/libraries/PalmTypes.sol";

interface IFeedLike {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// Ticket #3: Alice onboards, deposits USDC, unwraps within her shared USD Instant budget.
contract TracerTest is NetworkTest {
    function test_onboardingCreatesVaultTokenHubAndEnsName() public {
        Vault v = onboardAlice();
        assertTrue(factory().isVault(address(v)));
        assertEq(hub().statusOf(address(v)), PalmTypes.STATUS_ACTIVE);
        assertEq(usdcToken(v).symbol(), "pUSDC");
        assertEq(usdcToken(v).vault(), address(v));

        assertEq(ensAddr("alice"), address(v));
        assertEq(urAddr("alice"), address(v), "live Universal Resolver walks palmfi.eth -> our registry");
        assertEq(ensText("alice", "type"), "personal");
        assertEq(ensText("alice", "status"), "active");
        assertEq(ensText("alice", "verified"), "false");
        assertGt(bytes(ensText("alice", "tokens")).length, 0);
    }

    function test_onboardingRequiresFeeAndUniqueName() public {
        Vault v = onboardAlice();
        v;
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        vm.expectRevert(VaultFactoryErrors.NameTaken.selector);
        factory().createVault{value: FEE}("alice", individualConfig(owner, hotWallet));
        vm.prank(owner);
        vm.expectRevert(VaultFactoryErrors.BadFee.selector);
        factory().createVault{value: 0}("alice2", individualConfig(owner, hotWallet));
    }

    function test_ownerChosenLimitsAreStored() public {
        Vault v = onboardAlice();
        assertEq(v.budget24h(), 5e6);
        assertEq(v.budget7d(), 20e6);
        assertEq(v.hardCap(), 50e6);
        assertEq(v.availableBudgetUsd(), 5e6);
    }

    function test_depositMintsOneToOne() public {
        Vault v = onboardAlice();
        depositUsdc(v, hotWallet, 30e6);
        assertEq(usdcToken(v).balanceOf(hotWallet), 30e6);
        assertEq(IERC20Like(ext.usdc).balanceOf(address(v)), 30e6);
    }

    function test_unwrapWithinBudgetSucceedsImmediately() public {
        Vault v = onboardAlice();
        depositUsdc(v, hotWallet, 30e6);
        vm.prank(hotWallet);
        v.unwrap(ext.usdc, 3e6, payee, false);
        assertEq(IERC20Like(ext.usdc).balanceOf(payee), 3e6);
        assertEq(usdcToken(v).balanceOf(hotWallet), 27e6);
        assertApproxEqAbs(v.availableBudgetUsd(), 2e6, 0.05e6); // USDC/USD ~ $1
    }

    function test_unwrapOverBudgetReverts() public {
        Vault v = onboardAlice();
        depositUsdc(v, hotWallet, 30e6);
        vm.prank(hotWallet);
        vm.expectPartialRevert(Vault.OverBudget.selector);
        v.unwrap(ext.usdc, 6e6, payee, false);
    }

    function test_budgetRefillsLinearly() public {
        Vault v = onboardAlice();
        depositUsdc(v, hotWallet, 30e6);
        vm.prank(hotWallet);
        v.unwrap(ext.usdc, 4.9e6, payee, false);
        uint256 a0 = v.availableBudgetUsd();
        skip(12 hours); // half of the 24h window
        uint256 a1 = v.availableBudgetUsd();
        assertApproxEqAbs(a1 - a0, 2.5e6, 0.01e6, "refills $2.50 in 12h on a $5/24h budget");
        // the feed may now be past its heartbeat in the fork; only check budget math here
    }

    function test_staleFeedBlocksInstantLane() public {
        Vault v = onboardAlice();
        depositUsdc(v, hotWallet, 30e6);
        (,,, uint256 updatedAt,) = IFeedLike(ext.usdcUsdFeed).latestRoundData();
        vm.warp(updatedAt + 86400 + 1 hours + 1); // past heartbeat + 1h margin
        vm.prank(hotWallet);
        vm.expectRevert(abi.encodeWithSelector(Vault.Degraded.selector, ext.usdc));
        v.unwrap(ext.usdc, 1e6, payee, false);
    }

    function test_nonHotWalletCannotUnwrap() public {
        Vault v = onboardAlice();
        depositUsdc(v, hotWallet, 30e6);
        vm.prank(attacker);
        vm.expectRevert(Vault.NotHotWallet.selector);
        v.unwrap(ext.usdc, 1e6, attacker, false);
    }

    function test_factoryAdminHasNoPathToVaultFunds() public {
        Vault v = onboardAlice();
        depositUsdc(v, hotWallet, 30e6);
        vm.startPrank(deployer);
        vm.expectRevert(Vault.NotHotWallet.selector);
        v.unwrap(ext.usdc, 1e6, deployer, false);
        vm.expectRevert(Vault.NotRecoveryKey.selector);
        v.migrate();
        vm.expectRevert(Vault.NotRecoveryKey.selector);
        v.proposeChange(PalmTypes.CHANGE_ADD_HOT_WALLET, abi.encode(deployer));
        vm.stopPrank();
    }
}

interface VaultFactoryErrors {
    error NameTaken();
    error BadFee();
}
