// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// Stateless Second factor checks, split out of the Vault to keep it under EIP-170.
/// Passkeys: OpenZeppelin WebAuthn over P-256 (RIP-7212/EIP-7951 precompile at 0x100, with fallback).
/// Approvers: ECDSA over an EIP-712 digest computed by the ApprovalBook.
contract SecondFactorVerifier {
    function verifyPasskey(bytes32 challenge, bytes calldata sig, bytes32 x, bytes32 y) external view returns (bool) {
        if (x == bytes32(0) && y == bytes32(0)) return false;
        WebAuthn.WebAuthnAuth memory auth = abi.decode(sig, (WebAuthn.WebAuthnAuth));
        return WebAuthn.verify(abi.encodePacked(challenge), auth, x, y);
    }

    function verifyEcdsa(bytes32 digest, bytes calldata sig, address expected) external pure returns (bool) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        return err == ECDSA.RecoverError.NoError && signer == expected && expected != address(0);
    }
}
