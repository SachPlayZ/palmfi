// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {NetworkTest, IERC20Like} from "./base/NetworkTest.sol";
import {Passkey} from "./base/Passkey.sol";
import {Vault} from "../src/Vault.sol";
import {PalmTypes as T} from "../src/libraries/PalmTypes.sol";

/// Ticket #7: HOLD + passkey Second factor, and every row of the spec §6.3 resolution table.
contract SecondFactorTest is NetworkTest {
    uint256 constant PK = 0xA11CE;
    Vault v;

    function setUp() public override {
        super.setUp();
        T.VaultConfig memory c = individualConfig(owner, hotWallet);
        (c.passkeyX, c.passkeyY) = Passkey.publicKey(PK);
        v = onboardIndividual("alice", c);
        depositUsdc(v, hotWallet, 200e6);
        vm.deal(hotWallet, 1 ether);
    }

    function _request(uint256 amount) internal returns (uint256 id) {
        vm.prank(hotWallet);
        id = v.requestUnwrap{value: BOND}(ext.usdc, amount, payee, false);
    }

    function _confirm(uint256 id) internal {
        v.confirm(id, Passkey.assertion(PK, v.getRequest(id).requestHash));
    }

    function test_passkeyStoredAtOnboarding() public view {
        (bytes32 x, bytes32 y) = Passkey.publicKey(PK);
        assertEq(v.passkeyX(), x);
        assertEq(v.passkeyY(), y);
    }

    function test_validPasskeySignatureAccepted() public {
        uint256 id = _request(80e6);
        _confirm(id);
        assertTrue(v.getRequest(id).secondFactor);
    }

    function test_wrongKeyOrOtherRequestSignatureReverts() public {
        uint256 id = _request(80e6);
        uint256 other = _request(60e6);
        bytes memory wrongKey = Passkey.assertion(0xBAD, v.getRequest(id).requestHash);
        vm.expectRevert(Vault.BadSignature.selector);
        v.confirm(id, wrongKey);
        bytes memory forOther = Passkey.assertion(PK, v.getRequest(other).requestHash);
        vm.expectRevert(Vault.BadSignature.selector);
        v.confirm(id, forOther);
    }

    // §6.3 row: FLAG → never executable (covered with Freeze in Incident tests)

    // row: CLEAR, amount > hard cap, second factor present → after the Floor
    function test_clearAboveCapWithSecondFactorAfterFloor() public {
        uint256 id = _request(80e6);
        _confirm(id);
        verdict(v, id, T.VERDICT_CLEAR, 0);
        skip(15 minutes);
        v.execute(id);
        assertEq(IERC20Like(ext.usdc).balanceOf(payee), 80e6);
    }

    // row: CLEAR, amount > hard cap, second factor missing → after the full delay
    function test_clearAboveCapWithoutSecondFactorWaitsFullDelay() public {
        uint256 id = _request(80e6);
        verdict(v, id, T.VERDICT_CLEAR, 0);
        skip(15 minutes);
        assertFalse(v.isExecutable(id));
        skip(24 hours);
        assertTrue(v.isExecutable(id));
    }

    // row: HOLD, second factor present → full delay, or Floor after re-score to CLEAR (live scene 5)
    function test_holdThenFaceIdThenClearExecutesAfterFloor() public {
        uint256 id = _request(80e6);
        verdict(v, id, T.VERDICT_HOLD, T.NEW_DESTINATION);
        assertEq(v.getRequest(id).state, T.REQ_HELD);
        assertFalse(v.isExecutable(id));

        _confirm(id); // Face ID
        assertEq(v.getRequest(id).executableAt, v.getRequest(id).createdAt + 24 hours, "HOLD+2FA: full delay");

        verdict(v, id, T.VERDICT_CLEAR, 0); // Sentinel re-scores with the confirmation
        skip(15 minutes);
        v.execute(id);
        assertEq(v.getRequest(id).state, T.REQ_EXECUTED);
    }

    // row: HOLD, second factor missing → never (expires)
    function test_holdWithoutConfirmationNeverExecutesAndExpires() public {
        uint256 id = _request(80e6);
        verdict(v, id, T.VERDICT_HOLD, T.NEW_DESTINATION);
        skip(7 days);
        assertFalse(v.isExecutable(id));
        skip(1);
        v.expire(id);
        assertEq(v.getRequest(id).state, T.REQ_EXPIRED);
    }

    // row: None (CRE silent), Individual → after 72h unless the Guardian cancels
    function test_creSilentIndividualFailsOpenAfter72h() public {
        uint256 id = _request(80e6);
        skip(72 hours - 1);
        assertFalse(v.isExecutable(id));
        skip(1);
        v.execute(id);
        assertEq(IERC20Like(ext.usdc).balanceOf(payee), 80e6);
    }

    function test_creSilentGuardianCancels() public {
        uint256 id = _request(80e6);
        vm.prank(guardian);
        v.cancel(id);
        skip(72 hours);
        vm.expectRevert(Vault.NotExecutable.selector);
        v.execute(id);
    }

    function test_clearCannotBeDowngradedByStaleHold() public {
        uint256 id = _request(20e6);
        verdict(v, id, T.VERDICT_CLEAR, 0);
        verdict(v, id, T.VERDICT_HOLD, 0); // rejected: CLEAR stands
        assertEq(v.getRequest(id).state, T.REQ_CLEARED);
    }
}
