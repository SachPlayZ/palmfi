// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {BaseHook} from "@uniswap/v4-hooks-public/src/base/BaseHook.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IFactory} from "@tjar/interfaces/IFactory.sol";

/// Guards the remappings every later ticket relies on.
contract DepsTest is Test {
    function test_dependencyInterfacesResolve() public pure {
        assertEq(type(IPoolManager).name, "IPoolManager");
        assertEq(type(IV4Router).name, "IV4Router");
        assertEq(type(IPermissionedRegistry).name, "IPermissionedRegistry");
        assertEq(type(IFactory).name, "IFactory");
        assertTrue(BaseHook.getHookPermissions.selector != 0);
        WebAuthn.WebAuthnAuth memory auth;
        assertEq(auth.authenticatorData.length, 0);
    }
}
