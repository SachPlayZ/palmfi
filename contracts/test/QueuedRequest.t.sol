// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {NetworkTest, IERC20Like} from "./base/NetworkTest.sol";
import {Vault} from "../src/Vault.sol";
import {Hub} from "../src/Hub.sol";
import {PalmTypes as T} from "../src/libraries/PalmTypes.sol";

/// Ticket #6: Queued request → Hub → Sentinel Verdict → execute after the Floor.
contract QueuedRequestTest is NetworkTest {
    Vault v;

    function setUp() public override {
        super.setUp();
        v = onboardAlice();
        depositUsdc(v, hotWallet, 100e6);
        vm.deal(hotWallet, 1 ether);
    }

    function _request(uint256 amount) internal returns (uint256 id) {
        vm.prank(hotWallet);
        id = v.requestUnwrap{value: BOND}(ext.usdc, amount, payee, false);
    }

    function test_requestEmitsThroughHubWithBoundHash() public {
        bytes32 h = T.hashRequest(address(v), 1, ext.usdc, 20e6, payee);
        vm.expectEmit(true, true, false, false, net.hub);
        emit Hub.UnwrapRequested(address(v), 1, h, ext.usdc, 20e6, payee, 0, 0);
        uint256 id = _request(20e6);
        Vault.Request memory r = v.getRequest(id);
        assertEq(r.requestHash, h);
        assertEq(r.state, T.REQ_PENDING);
        assertTrue(r.reasonCodes & T.NEW_DESTINATION != 0, "payee not allowlisted");
        assertTrue(r.reasonCodes & T.OVER_BUDGET != 0);
        assertEq(usdcToken(v).balanceOf(hotWallet), 80e6, "escrowed");
    }

    function test_clearWithinHardCapExecutesAfterFloorByAnyone() public {
        uint256 id = _request(20e6);
        verdict(v, id, T.VERDICT_CLEAR, 0);
        assertEq(v.getRequest(id).state, T.REQ_CLEARED);
        assertFalse(v.isExecutable(id));
        vm.expectRevert(Vault.NotExecutable.selector);
        v.execute(id);
        skip(15 minutes);
        uint256 bondBefore = hotWallet.balance;
        vm.prank(searcher);
        v.execute(id);
        assertEq(IERC20Like(ext.usdc).balanceOf(payee), 20e6);
        assertEq(v.getRequest(id).state, T.REQ_EXECUTED);
        assertEq(hotWallet.balance - bondBefore, BOND, "bond refunded");
    }

    function test_ownerCancelRefundsBondAndTokens() public {
        uint256 id = _request(20e6);
        uint256 bal = hotWallet.balance;
        vm.prank(hotWallet);
        v.cancel(id);
        assertEq(v.getRequest(id).state, T.REQ_CANCELLED);
        assertEq(hotWallet.balance - bal, BOND);
        assertEq(usdcToken(v).balanceOf(hotWallet), 100e6);
    }

    function test_requestExpiresAfterSevenDays() public {
        uint256 id = _request(20e6);
        verdict(v, id, T.VERDICT_HOLD, T.NEW_DESTINATION);
        vm.expectRevert(Vault.BadState.selector);
        v.expire(id);
        skip(7 days + 1);
        v.expire(id);
        assertEq(v.getRequest(id).state, T.REQ_EXPIRED);
    }

    function test_bondAndPendingCapEnforced() public {
        vm.prank(hotWallet);
        vm.expectRevert(Vault.BadBond.selector);
        v.requestUnwrap{value: 0}(ext.usdc, 10e6, payee, false);
        _request(10e6);
        _request(10e6);
        _request(10e6);
        vm.prank(hotWallet);
        vm.expectRevert(Vault.TooManyPending.selector);
        v.requestUnwrap{value: BOND}(ext.usdc, 10e6, payee, false);
    }

    // --- report hygiene (ADR-0005): never revert on content, record ReportRejected ---

    function _rawReport(uint256 id, bytes32 h, uint8 verdict_, uint64 expiry, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(T.Report(T.REPORT_VERDICT, address(v), id, h, verdict_, 0, expiry, nonce));
    }

    function test_onlyForwarderCanReport() public {
        uint256 id = _request(20e6);
        bytes memory rep = _rawReport(id, v.getRequest(id).requestHash, T.VERDICT_CLEAR, uint64(block.timestamp + 60), 1);
        vm.prank(attacker);
        vm.expectRevert(Hub.NotForwarder.selector);
        hub().onReport("", rep);
    }

    function test_duplicateExpiredAndMismatchedReportsAreIgnored() public {
        uint256 id = _request(20e6);
        bytes32 h = v.getRequest(id).requestHash;

        bytes memory good = _rawReport(id, h, T.VERDICT_HOLD, uint64(block.timestamp + 60), 7);
        asForwarder();
        hub().onReport("", good);
        assertEq(v.getRequest(id).state, T.REQ_HELD);

        vm.expectEmit(true, false, false, true, net.hub);
        emit Hub.ReportRejected(keccak256(good), T.REJECT_DUPLICATE);
        asForwarder();
        hub().onReport("", good);

        bytes memory expired = _rawReport(id, h, T.VERDICT_CLEAR, uint64(block.timestamp - 1), 8);
        vm.expectEmit(true, false, false, true, net.hub);
        emit Hub.ReportRejected(keccak256(expired), T.REJECT_EXPIRED);
        asForwarder();
        hub().onReport("", expired);

        bytes memory wrongHash = _rawReport(id, keccak256("modified"), T.VERDICT_CLEAR, uint64(block.timestamp + 60), 9);
        vm.expectEmit(true, false, false, true, net.hub);
        emit Hub.ReportRejected(keccak256(wrongHash), T.REJECT_HASH_MISMATCH);
        asForwarder();
        hub().onReport("", wrongHash);

        asForwarder();
        hub().onReport("", hex"deadbeef"); // garbage: rejected, not reverted
        assertEq(v.getRequest(id).state, T.REQ_HELD);
    }

    function test_heartbeatReportRecorded() public {
        report(T.REPORT_HEARTBEAT, address(0), 0, bytes32(0), 0, 0);
        assertEq(hub().lastHeartbeat(), block.timestamp);
    }

    function test_batchedOpenRequestsView() public {
        _request(20e6);
        _request(30e6);
        Hub.OpenRequest[] memory open = hub().openRequests(0, 10);
        assertEq(open.length, 2);
        assertEq(open[0].vault, address(v));
    }
}
