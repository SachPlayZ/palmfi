// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {NetworkTest, IERC20Like} from "./base/NetworkTest.sol";
import {Vault} from "../src/Vault.sol";
import {VaultBase} from "../src/VaultBase.sol";
import {ProtectedToken} from "../src/tokens/ProtectedToken.sol";
import {PalmTypes} from "../src/libraries/PalmTypes.sol";

/// Ticket #5: Protected tokens move only between own Hot wallets and PoolManager custody (ADR-0006).
contract WhitelistTest is NetworkTest {
    Vault v;
    ProtectedToken t;

    function setUp() public override {
        super.setUp();
        v = onboardAlice();
        t = usdcToken(v);
        depositUsdc(v, hotWallet, 10e6);
    }

    function test_transferBetweenOwnHotWalletsSucceeds() public {
        vm.prank(hotWallet);
        t.transfer(hotWallet2, 4e6);
        assertEq(t.balanceOf(hotWallet2), 4e6);
    }

    function test_transferToOutsiderReverts() public {
        vm.prank(hotWallet);
        vm.expectRevert(abi.encodeWithSelector(ProtectedToken.TransferNotAllowed.selector, hotWallet, attacker));
        t.transfer(attacker, 1e6);
    }

    function test_transferFromWithApprovalStillEnforcesWhitelist() public {
        vm.prank(hotWallet);
        t.approve(attacker, type(uint256).max);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(ProtectedToken.TransferNotAllowed.selector, hotWallet, attacker));
        t.transferFrom(hotWallet, attacker, 1e6);
    }

    function test_poolManagerCustodyOnlyReleasesToHotWallets() public {
        vm.prank(hotWallet);
        t.transfer(ext.poolManager, 5e6); // into the real PoolManager: allowed
        assertEq(t.balanceOf(ext.poolManager), 5e6);

        vm.prank(ext.poolManager);
        vm.expectRevert(abi.encodeWithSelector(ProtectedToken.TransferNotAllowed.selector, ext.poolManager, attacker));
        t.transfer(attacker, 1e6);

        vm.prank(ext.poolManager);
        t.transfer(hotWallet2, 1e6);
        assertEq(t.balanceOf(hotWallet2), 1e6);
    }

    function test_behavesAsStandardErc20ForWallets() public view {
        assertEq(t.decimals(), 6);
        assertEq(t.totalSupply(), 10e6);
        assertEq(IERC20Like(address(t)).balanceOf(hotWallet), 10e6);
    }

    function test_hotWalletAddedOnlyByRecoveryKeyAfterTimelock() public {
        address newHot = makeAddr("newHot");
        vm.prank(hotWallet);
        vm.expectRevert(VaultBase.NotRecoveryKey.selector);
        mod(v).proposeChange(PalmTypes.CHANGE_ADD_HOT_WALLET, abi.encode(newHot));

        vm.prank(recoveryKey);
        uint256 id = mod(v).proposeChange(PalmTypes.CHANGE_ADD_HOT_WALLET, abi.encode(newHot));
        vm.prank(recoveryKey);
        vm.expectRevert(VaultBase.TimelockActive.selector);
        mod(v).executeChange(id);
        skip(48 hours);
        vm.prank(recoveryKey);
        mod(v).executeChange(id);
        assertTrue(v.isHotWallet(newHot));
        vm.prank(hotWallet);
        t.transfer(newHot, 1e6);
    }

    function test_removingHotWalletIsInstant() public {
        vm.prank(hotWallet);
        mod(v).removeHotWallet(hotWallet2);
        assertFalse(v.isHotWallet(hotWallet2));
        vm.prank(hotWallet);
        vm.expectPartialRevert(ProtectedToken.TransferNotAllowed.selector);
        t.transfer(hotWallet2, 1e6);
    }

    /// Reserves always cover supply (fuzzed over deposit / unwrap / internal moves).
    function testFuzz_reservesCoverSupply(uint96 dep, uint96 out, uint96 moved) public {
        dep = uint96(bound(dep, 1, 1_000e6));
        depositUsdc(v, hotWallet2, dep);
        moved = uint96(bound(moved, 0, dep));
        vm.prank(hotWallet2);
        t.transfer(hotWallet, moved);
        out = uint96(bound(out, 1, 4e6));
        vm.prank(hotWallet);
        v.unwrap(ext.usdc, out, payee, false);
        assertGe(IERC20Like(ext.usdc).balanceOf(address(v)), t.totalSupply());
    }
}
