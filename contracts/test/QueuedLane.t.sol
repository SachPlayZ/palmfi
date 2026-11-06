// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {NetworkTest} from "./base/NetworkTest.sol";
import {PalmTypes as T} from "../src/libraries/PalmTypes.sol";
import {Vault} from "../src/Vault.sol";
import {VaultBase} from "../src/VaultBase.sol";

/// Queued lane: deviation-scored delays (ADR-0009) + intra-org Veto / Fast-track (ADR-0008).
contract QueuedLaneTest is NetworkTest {
    Vault v; // Nvidia, 5 wallets

    function setUp() public override {
        super.setUp();
        v = onboard("nvidia", 5);
        depositUsdc(v, w[0], 10_000e6);
    }

    function _request(uint256 amount) internal returns (uint256 id) {
        vm.prank(w[0]);
        id = v.requestUnwrap(amount, outsider);
    }

    function test_creSilent_waitsMaxDelay() public {
        uint256 id = _request(1_000e6);
        VaultBase.Request memory r = v.getRequest(id);
        assertEq(r.executableAt, block.timestamp + 72 hours);
        assertTrue(r.reasonCodes & T.CRE_SILENT != 0);
        assertTrue(r.reasonCodes & T.NEW_DESTINATION != 0);
        assertEq(tokenOf(v).balanceOf(w[0]), 10_000e6 - 1_000e6 - BOND); // escrowed by burning

        skip(72 hours - 1);
        assertFalse(v.isExecutable(id));
        skip(1);
        v.execute(id);
        assertEq(usdcBalance(outsider), 1_000e6);
        assertEq(tokenOf(v).balanceOf(w[0]), 10_000e6 - 1_000e6); // bond back
        assertEq(v.historyCount(), 1);
    }

    function test_sentinelDelay_clampedToFloorAndMax() public {
        uint256 id = _request(1_000e6);
        setDelay(v, id, 60, 1_000); // below Floor → Floor
        assertEq(v.getRequest(id).executableAt, block.timestamp + 15 minutes);
        assertEq(v.getRequest(id).score, 1_000);

        uint256 id2 = _request(1_000e6);
        setDelay(v, id2, 30 days, 20_000); // above Max → Max
        assertEq(v.getRequest(id2).executableAt, block.timestamp + 72 hours);
    }

    function test_aboveHardCap_atLeastCapDelay() public {
        uint256 id = _request(6_000e6);
        assertTrue(v.getRequest(id).reasonCodes & T.OVER_HARD_CAP != 0);
        setDelay(v, id, 15 minutes, 2_000); // even a compromised CRE can't go below CapDelay here
        assertEq(v.getRequest(id).executableAt, block.timestamp + 24 hours);
    }

    function test_fastTrack_majorityYes_executesAtFloor() public {
        uint256 id = _request(6_000e6); // payroll above Hard cap
        vote(v, w[0], id, true);
        vote(v, w[1], id, true);
        assertFalse(v.getRequest(id).fastTracked); // 2/5 is not a majority
        vote(v, w[2], id, true);
        assertTrue(v.getRequest(id).fastTracked);
        assertEq(v.getRequest(id).executableAt, block.timestamp + 15 minutes);

        // CRE can't override a majority
        setDelay(v, id, 72 hours, 9_000);
        assertEq(v.getRequest(id).executableAt, block.timestamp + 15 minutes);

        skip(15 minutes);
        v.execute(id);
        assertEq(usdcBalance(outsider), 6_000e6);
    }

    function test_veto_majorityOfOthers_cancels() public {
        uint256 id = _request(2_000e6);
        vote(v, w[1], id, false);
        vote(v, w[2], id, false);
        assertEq(v.getRequest(id).state, T.REQ_PENDING); // 2 of the 4 others is not >50%
        vote(v, w[3], id, false);
        assertEq(v.getRequest(id).state, T.REQ_VETOED);
        assertEq(tokenOf(v).balanceOf(w[0]), 10_000e6); // escrow + bond re-minted
        assertEq(v.historyCount(), 0); // a vetoed request never teaches the baseline
        skip(72 hours);
        vm.expectRevert(VaultBase.NotExecutable.selector);
        v.execute(id);
    }

    /// 3-wallet org with 1 hacked wallet: the 2 honest wallets are 100% of "the others", so they can veto.
    function test_veto_threeWalletOrg_oneHacked() public {
        Vault s = Vault(factory().createVault("smallco", config(_ws("s", 3))));
        address[] memory sw = s.wallets();
        depositUsdc(s, sw[0], 1_000e6);
        vm.prank(sw[0]); // hacked
        uint256 id = s.requestUnwrap(800e6, attacker);
        vote(s, sw[1], id, false);
        assertEq(s.getRequest(id).state, T.REQ_PENDING);
        vote(s, sw[2], id, false);
        assertEq(s.getRequest(id).state, T.REQ_VETOED);
    }

    /// 2 hacked wallets of 5 can't fast-track; the 3 honest ones still veto.
    function test_twoHackedOfFive_cannotFastTrack() public {
        uint256 id = _request(4_000e6);
        vote(v, w[0], id, true);
        vote(v, w[1], id, true);
        assertFalse(v.getRequest(id).fastTracked);
        vote(v, w[2], id, false);
        vote(v, w[3], id, false);
        vote(v, w[4], id, false);
        assertEq(v.getRequest(id).state, T.REQ_VETOED);
    }

    function test_vote_rules() public {
        uint256 id = _request(1_000e6);
        vm.prank(w[0]);
        vm.expectRevert(VaultBase.NotEligible.selector); // requester can't veto, only cancel
        v.vote(id, false);
        vote(v, w[1], id, true);
        vm.prank(w[1]);
        vm.expectRevert(VaultBase.AlreadyVoted.selector);
        v.vote(id, true);
        vm.prank(attacker);
        vm.expectRevert(VaultBase.NotWallet.selector);
        v.vote(id, false);
    }

    function test_flag_freezesForfeitsBondAndBlocks() public {
        uint256 id = _request(3_000e6);
        vm.prank(deployer);
        hub().setVerified(address(v), true);
        flag(v, id, T.UNUSUAL_AMOUNT | T.OFF_HOURS | T.NEW_DESTINATION);
        assertEq(v.getRequest(id).state, T.REQ_FLAGGED);
        assertEq(hub().statusOf(address(v)), T.STATUS_FROZEN);
        assertTrue(hub().isBlocked(outsider));
        assertEq(tokenOf(v).balanceOf(w[0]), 10_000e6 - BOND);
        assertEq(usdcBalance(address(v)), 10_000e6); // funds never left

        vm.prank(w[1]);
        vm.expectRevert(VaultBase.NotActive.selector);
        v.unwrap(1e6, makeAddr("anyone"));
    }

    function test_pendingCapPerWallet() public {
        _request(10e6);
        _request(10e6);
        _request(10e6);
        vm.prank(w[0]);
        vm.expectRevert(VaultBase.TooManyPending.selector);
        v.requestUnwrap(10e6, outsider);
    }

    function test_reportRejections_ADR0005() public {
        uint256 id = _request(1_000e6);
        T.Report memory r = T.Report(T.REPORT_SET_DELAY, address(v), id, bytes32(uint256(1)), 1 hours, 1, 0, 0, 0);
        report(r); // hash mismatch: dropped, not reverted
        assertEq(v.getRequest(id).executableAt, block.timestamp + 72 hours);
        vm.prank(attacker);
        vm.expectRevert();
        hub().onReport("", abi.encode(r));
    }

    function test_requestPayment_toAnotherVault() public {
        Vault p = Vault(factory().createVault("palantir", config(_ws("pal", 3))));
        vm.prank(w[0]);
        uint256 id = v.requestPayment(address(p), 3_000e6);
        setDelay(v, id, 1 hours, 5_000);
        skip(1 hours);
        v.execute(id);
        assertEq(usdcBalance(address(p)), 3_000e6);
        assertEq(tokenOf(p).balanceOf(p.wallets()[0]), 3_000e6);
    }

    function test_anyWalletFreezes_majorityUnfreezes() public {
        vm.prank(w[4]);
        v.freeze();
        assertEq(hub().statusOf(address(v)), T.STATUS_FROZEN);

        vm.prank(w[0]);
        uint256 c = mod(v).proposeChange(T.CHANGE_UNFREEZE, "");
        vm.prank(w[1]);
        mod(v).voteChange(c);
        assertEq(hub().statusOf(address(v)), T.STATUS_FROZEN);
        vm.prank(w[2]);
        mod(v).voteChange(c); // 3/5: applied immediately (no timelock)
        assertEq(hub().statusOf(address(v)), T.STATUS_ACTIVE);
    }

    function test_recoveryKeyUnfreezes() public {
        vm.prank(w[4]);
        v.freeze();
        vm.prank(recoveryKey);
        mod(v).recoveryUnfreeze();
        assertEq(hub().statusOf(address(v)), T.STATUS_ACTIVE);
    }

    function _ws(string memory p, uint256 n) internal returns (address[] memory out) {
        out = new address[](n);
        for (uint256 i; i < n; i++) {
            out[i] = makeAddr(string.concat(p, vm.toString(i)));
        }
    }
}
