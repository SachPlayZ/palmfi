// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {NetworkTest} from "./base/NetworkTest.sol";
import {PalmTypes as T} from "../src/libraries/PalmTypes.sol";
import {Vault} from "../src/Vault.sol";
import {VaultBase} from "../src/VaultBase.sol";
import {VaultModule} from "../src/VaultModule.sol";

/// Settings: instant tightening by any wallet, majority + timelock loosening, Sybil guard (ADR-0008).
contract ChangesTest is NetworkTest {
    Vault v; // 5 wallets

    function setUp() public override {
        super.setUp();
        v = onboard("nvidia", 5);
        depositUsdc(v, w[0], 10_000e6);
    }

    /// The main attack: one hacked wallet adds puppets to reach a majority.
    function test_sybil_hackedWalletCannotAddPuppets() public {
        vm.startPrank(w[0]);
        uint256 a = mod(v).proposeChange(T.CHANGE_ADD_WALLET, abi.encode(makeAddr("puppet1")));
        uint256 b = mod(v).proposeChange(T.CHANGE_ADD_WALLET, abi.encode(makeAddr("puppet2")));
        vm.stopPrank();
        assertEq(mod(v).getChange(a).eta, 0); // 1/5 is no majority
        assertEq(mod(v).pendingWalletAdds(), 2);

        // While an add is pending, every request carries CONFIG_CHANGE_PENDING for the Sentinel.
        vm.prank(w[0]);
        uint256 id = v.requestUnwrap(1_000e6, attacker);
        assertTrue(v.getRequest(id).reasonCodes & T.CONFIG_CHANGE_PENDING != 0);

        skip(30 days);
        vm.expectRevert(VaultBase.BadState.selector);
        mod(v).executeChange(a);

        // Honest wallets drop the attacker's proposals.
        vm.prank(w[3]);
        mod(v).cancelChange(a);
        vm.prank(w[3]);
        mod(v).cancelChange(b);
        assertEq(mod(v).pendingWalletAdds(), 0);
    }

    function test_addWallet_majorityThen48h() public {
        address fresh = makeAddr("fresh");
        vm.prank(w[0]);
        uint256 c = mod(v).proposeChange(T.CHANGE_ADD_WALLET, abi.encode(fresh));
        vm.prank(w[1]);
        mod(v).voteChange(c);
        vm.prank(w[2]);
        mod(v).voteChange(c);
        assertEq(mod(v).getChange(c).eta, block.timestamp + 48 hours);

        vm.expectRevert(VaultBase.TimelockActive.selector);
        mod(v).executeChange(c);
        vm.prank(w[4]); // a passed change can't be dropped by one wallet
        vm.expectRevert(VaultBase.BadState.selector);
        mod(v).cancelChange(c);

        skip(48 hours);
        mod(v).executeChange(c);
        assertTrue(v.isWallet(fresh));
        assertEq(v.walletCount(), 6);
    }

    function test_newWallet_cannotVoteOnOlderRequests() public {
        vm.prank(w[0]);
        uint256 id = v.requestUnwrap(1_000e6, outsider);
        address fresh = makeAddr("fresh");
        vm.prank(w[0]);
        uint256 c = mod(v).proposeChange(T.CHANGE_ADD_WALLET, abi.encode(fresh));
        vm.prank(w[1]);
        mod(v).voteChange(c);
        vm.prank(w[2]);
        mod(v).voteChange(c);
        skip(48 hours);
        mod(v).executeChange(c);

        vm.prank(fresh);
        vm.expectRevert(VaultBase.NotEligible.selector);
        v.vote(id, true);
        assertEq(v.getRequest(id).voterCount, 5); // snapshot unchanged
    }

    function test_removeHackedWallet_majorityInstant() public {
        address hacked = w[4];
        vm.prank(w[0]);
        uint256 c = mod(v).proposeChange(T.CHANGE_REMOVE_WALLET, abi.encode(hacked));
        vm.prank(w[1]);
        mod(v).voteChange(c);
        vm.prank(w[2]);
        mod(v).voteChange(c);
        assertFalse(v.isWallet(hacked));
        vm.prank(hacked);
        vm.expectRevert(VaultBase.NotWallet.selector);
        v.unwrap(1e6, attacker);
    }

    function test_minimumThreeWalletsKept() public {
        Vault s = onboard("smallco", 3);
        vm.prank(w[0]);
        vm.expectRevert(VaultBase.TooFewWallets.selector);
        mod(s).leave();
    }

    function test_tightening_instantByOneWallet() public {
        vm.prank(w[3]);
        mod(v).lowerBudget(100e6, 400e6);
        assertEq(v.budget24h(), 100e6);
        vm.prank(w[3]);
        vm.expectRevert(VaultBase.NotTightening.selector);
        mod(v).lowerBudget(200e6, 400e6);
    }

    function test_loosening_budgetNeedsMajorityAnd48h() public {
        vm.prank(w[0]);
        uint256 c = mod(v).proposeChange(T.CHANGE_BUDGET, abi.encode(uint128(1_000e6), uint128(4_000e6)));
        vm.prank(w[1]);
        mod(v).voteChange(c);
        vm.prank(w[2]);
        mod(v).voteChange(c);
        skip(48 hours);
        mod(v).executeChange(c);
        assertEq(v.budget24h(), 1_000e6);
    }

    function test_migrate_majority_onlyToRecoveryVault() public {
        vm.prank(w[0]);
        uint256 c = mod(v).proposeChange(T.CHANGE_MIGRATE, "");
        vm.prank(w[1]);
        mod(v).voteChange(c);
        vm.prank(w[2]);
        mod(v).voteChange(c);
        assertEq(usdcBalance(recoveryVaultAddr), 10_000e6);
        assertEq(hub().statusOf(address(v)), T.STATUS_MIGRATED);
        assertEq(tokenOf(v).totalSupply(), 0);
    }

    function test_scoringContext_oneRead() public {
        vm.prank(w[0]);
        v.unwrap(100e6, outsider);
        vm.prank(w[0]);
        uint256 id = v.requestUnwrap(1_000e6, outsider);
        VaultModule.ScoringContext memory ctx = mod(v).scoringContext(id);
        assertEq(ctx.request.amount, 1_000e6);
        assertEq(ctx.history.length, 1);
        assertEq(ctx.history[0].amount, 100e6);
        assertEq(ctx.destinationCount, 1);
        assertEq(ctx.walletCount, 5);
        assertEq(ctx.profile.usualMaxPayout, 2_000e6);
    }

    function test_history_ringBufferKeepsLast32() public {
        vm.prank(w[0]);
        mod(v).lowerBudget(500e6, 2_000e6);
        for (uint256 i; i < 40; i++) {
            vm.prank(w[0]);
            v.unwrap(1e6 + i, outsider);
            skip(1 hours);
        }
        assertEq(v.historyCount(), 40);
        assertEq(mod(v).history().length, 32);
        assertEq(mod(v).history()[0].amount, 1e6 + 8); // oldest kept
        assertEq(mod(v).history()[31].amount, 1e6 + 39);
    }
}
