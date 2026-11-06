// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {NetworkTest, IERC20Like} from "./base/NetworkTest.sol";
import {Vault} from "../src/Vault.sol";
import {ProtectedToken} from "../src/tokens/ProtectedToken.sol";

/// Protected tokens move only between the Vault's own wallets and PoolManager custody (ADR-0006).
contract WhitelistTest is NetworkTest {
    Vault v;
    ProtectedToken t;

    function setUp() public override {
        super.setUp();
        v = onboard("nvidia", 3);
        t = tokenOf(v);
        depositUsdc(v, w[0], 10e6);
    }

    function test_transferBetweenOwnWalletsSucceeds() public {
        vm.prank(w[0]);
        t.transfer(w[1], 4e6);
        assertEq(t.balanceOf(w[1]), 4e6);
    }

    function test_transferToOutsiderReverts() public {
        vm.prank(w[0]);
        vm.expectRevert(abi.encodeWithSelector(ProtectedToken.TransferNotAllowed.selector, w[0], attacker));
        t.transfer(attacker, 1e6);
    }

    function test_transferFromWithApprovalStillEnforcesWhitelist() public {
        vm.prank(w[0]);
        t.approve(attacker, type(uint256).max);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(ProtectedToken.TransferNotAllowed.selector, w[0], attacker));
        t.transferFrom(w[0], attacker, 1e6);
    }

    function test_poolManagerCustodyOnlyReleasesToOwnWallets() public {
        vm.prank(w[0]);
        t.transfer(ext.poolManager, 5e6);
        assertEq(t.balanceOf(ext.poolManager), 5e6);

        vm.prank(ext.poolManager);
        vm.expectRevert(abi.encodeWithSelector(ProtectedToken.TransferNotAllowed.selector, ext.poolManager, attacker));
        t.transfer(attacker, 1e6);

        vm.prank(ext.poolManager);
        t.transfer(w[1], 1e6);
        assertEq(t.balanceOf(w[1]), 1e6);
    }

    function test_otherOrgsWalletCannotHoldToken() public {
        address otherOrgWallet = makeAddr("pal0");
        factory().createVault("palantir", config(_three(otherOrgWallet)));
        vm.prank(ext.poolManager);
        vm.expectRevert();
        t.transfer(otherOrgWallet, 1e6);
    }

    function test_behavesAsStandardErc20ForWallets() public view {
        assertEq(t.decimals(), 6);
        assertEq(t.totalSupply(), 10e6);
        assertEq(IERC20Like(address(t)).balanceOf(w[0]), 10e6);
    }

    /// Reserves always cover supply (fuzzed over deposit / unwrap / internal moves).
    function testFuzz_reservesCoverSupply(uint96 dep, uint96 out, uint96 moved) public {
        dep = uint96(bound(dep, 1, 1_000e6));
        depositUsdc(v, w[1], dep);
        moved = uint96(bound(moved, 0, dep));
        vm.prank(w[1]);
        t.transfer(w[0], moved);
        out = uint96(bound(out, 1, 4e6));
        vm.prank(w[0]);
        v.unwrap(out, outsider);
        assertGe(usdcBalance(address(v)), t.totalSupply());
    }

    function _three(address first) internal returns (address[] memory out) {
        out = new address[](3);
        out[0] = first;
        out[1] = makeAddr("pal1");
        out[2] = makeAddr("pal2");
    }
}
