// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {NetworkTest} from "./base/NetworkTest.sol";
import {PalmTypes as T} from "../src/libraries/PalmTypes.sol";
import {Vault} from "../src/Vault.sol";
import {VaultBase} from "../src/VaultBase.sol";
import {Hub} from "../src/Hub.sol";
import {VaultFactory} from "../src/VaultFactory.sol";

/// Tracer: an org onboards on Arc, deposits USDC (ERC-20 only), spends within the Instant budget, pays another org.
contract TracerTest is NetworkTest {
    function test_onboard_registersNameAndToken() public {
        Vault v = onboard("nvidia", 5);
        assertEq(hub().resolve("nvidia"), address(v));
        assertEq(hub().statusOf(address(v)), T.STATUS_ACTIVE);
        assertEq(v.walletCount(), 5);
        assertEq(tokenOf(v).vault(), address(v));
        assertEq(tokenOf(v).decimals(), 6);
    }

    function test_onboard_rejectsFewerThanThreeWallets() public {
        vm.expectRevert(VaultBase.TooFewWallets.selector);
        factory().createVault("duo", config(wallets(2)));
    }

    function test_names_firstComeAndVerifiedByAdmin() public {
        Vault v = onboard("nvidia", 3);
        vm.expectRevert(Hub.NameTaken.selector);
        factory().createVault("nvidia", config(wallets(3)));
        vm.expectRevert(Hub.BadName.selector);
        factory().createVault("Nvidia", config(wallets(3)));

        vm.expectRevert(Hub.NotAdmin.selector);
        hub().setVerified(address(v), true);
        vm.prank(deployer);
        hub().setVerified(address(v), true);
        assertTrue(hub().verified(address(v)));
    }

    function test_depositAndInstantUnwrap() public {
        Vault v = onboard("nvidia", 3);
        depositUsdc(v, w[0], 1_000e6);
        assertEq(tokenOf(v).balanceOf(w[0]), 1_000e6);
        assertEq(usdcBalance(address(v)), 1_000e6);

        vm.prank(w[0]);
        v.unwrap(400e6, outsider);
        assertEq(usdcBalance(outsider), 400e6);
        assertEq(tokenOf(v).balanceOf(w[0]), 600e6);
        assertEq(v.availableBudget(), 100e6);
        assertEq(v.historyCount(), 1);

        vm.prank(w[0]);
        vm.expectRevert(abi.encodeWithSelector(VaultBase.OverBudget.selector, 200e6, 100e6));
        v.unwrap(200e6, outsider);
    }

    function test_nativeValueRejected() public {
        Vault v = onboard("nvidia", 3);
        fundUsdc(w[0], 10e6);
        vm.prank(w[0]);
        (bool ok,) = address(v).call{value: 1e18}("");
        assertFalse(ok);
    }

    function test_onlyWalletsSpend() public {
        Vault v = onboard("nvidia", 3);
        depositUsdc(v, w[0], 100e6);
        vm.prank(attacker);
        vm.expectRevert(VaultBase.NotWallet.selector);
        v.unwrap(1e6, attacker);
    }

    function test_instantPaymentBetweenVaults() public {
        Vault n = onboard("nvidia", 3);
        Vault p = Vault(factory().createVault("palantir", config(_ws("pal", 3))));
        address payer = p.wallets()[0];
        depositUsdc(p, payer, 300e6);

        vm.prank(payer);
        p.pay(address(n), 250e6);
        assertEq(usdcBalance(address(n)), 250e6);
        assertEq(tokenOf(n).balanceOf(n.wallets()[0]), 250e6);
        assertEq(tokenOf(p).totalSupply(), 50e6);
    }

    function test_blocklistedDestinationRefused() public {
        Vault v = onboard("nvidia", 3);
        depositUsdc(v, w[0], 1_000e6);
        vm.prank(w[0]);
        uint256 id = v.requestUnwrap(900e6, attacker);
        vm.prank(deployer);
        hub().setVerified(address(v), true); // only a verified Vault's FLAG blocklists network-wide
        flag(v, id, T.BLOCKLISTED_DEST);
        assertTrue(hub().isBlocked(attacker));
        assertEq(hub().statusOf(address(v)), T.STATUS_FROZEN);

        Vault other = Vault(factory().createVault("palantir", config(_ws("pal", 3))));
        address payer = other.wallets()[0];
        depositUsdc(other, payer, 100e6);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(VaultBase.Blocklisted.selector, attacker));
        other.unwrap(10e6, attacker);
    }

    function _ws(string memory p, uint256 n) internal returns (address[] memory out) {
        out = new address[](n);
        for (uint256 i; i < n; i++) {
            out[i] = makeAddr(string.concat(p, vm.toString(i)));
        }
    }
}
