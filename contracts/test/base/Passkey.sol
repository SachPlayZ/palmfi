// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

/// Produces real WebAuthn assertions (P-256 over sha256(authData ‖ sha256(clientDataJSON))) like a
/// platform authenticator would, so the Vault's onchain verification is exercised end to end.
library Passkey {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    function publicKey(uint256 pk) internal pure returns (bytes32 x, bytes32 y) {
        (uint256 px, uint256 py) = vm.publicKeyP256(pk);
        return (bytes32(px), bytes32(py));
    }

    function assertion(uint256 pk, bytes32 challenge) internal pure returns (bytes memory) {
        string memory prefix = '{"type":"webauthn.get","challenge":"';
        string memory clientDataJSON = string.concat(
            prefix,
            Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"https://palmfi.app","crossOrigin":false}'
        );
        // rpIdHash ‖ flags (UP|UV) ‖ signCount
        bytes memory authData = abi.encodePacked(sha256("palmfi.app"), bytes1(0x05), uint32(1));
        bytes32 digest = sha256(abi.encodePacked(authData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, digest);
        if (uint256(s) > N / 2) s = bytes32(N - uint256(s));
        WebAuthn.WebAuthnAuth memory a = WebAuthn.WebAuthnAuth({
            r: r,
            s: s,
            challengeIndex: 23, // index of "challenge":"
            typeIndex: 1, // index of "type":"
            authenticatorData: authData,
            clientDataJSON: clientDataJSON
        });
        return abi.encode(a);
    }
}
