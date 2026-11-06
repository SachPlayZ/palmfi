// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ExchangeReleaser} from "@tjar/releasers/ExchangeReleaser.sol";
import {TokenJar} from "@tjar/TokenJar.sol";

interface IERC20Approve {
    function approve(address, uint256) external returns (bool);
}

/// Scene 8. Reads the jar + releaser from deployments/sepolia.json.
///   Searcher: forge script script/Jar.s.sol --sig "release()" --rpc-url sepolia --broadcast --account searcher
///   Lock:     forge script script/Jar.s.sol --sig "lock()"    --rpc-url sepolia --broadcast --account deployer
contract Jar is Script {
    string internal constant DEPLOYMENT = "../deployments/sepolia.json";
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function _releaser() internal view returns (ExchangeReleaser) {
        return ExchangeReleaser(vm.parseJsonAddress(vm.readFile(DEPLOYMENT), ".jarReleaser"));
    }

    /// Pays the 25 USDC threshold (sent to the SafetyFund) and sweeps the jar's LINK fees and ETH.
    function release() external {
        ExchangeReleaser r = _releaser();
        string memory cfg = vm.readFile("../config/sepolia.json");
        Currency[] memory assets = new Currency[](2);
        assets[0] = Currency.wrap(vm.parseJsonAddress(cfg, ".tokens.link"));
        assets[1] = Currency.wrap(address(0)); // onboarding fees (ETH)
        (uint256 total, uint256 fee) = r.releaseCost();
        vm.startBroadcast();
        IERC20Approve(address(r.resource())).approve(address(r), total);
        r.release(r.nonce(), assets, msg.sender, fee);
        vm.stopBroadcast();
        console.log("released to", msg.sender, "paid", total);
    }

    /// Irreversible: owner 0xdead and config setter zero on both the releaser and the jar.
    function lock() external {
        ExchangeReleaser r = _releaser();
        TokenJar jar = TokenJar(payable(address(r.TOKEN_JAR())));
        vm.startBroadcast();
        r.setConfigSetter(address(0));
        r.transferOwnership(DEAD);
        jar.transferOwnership(DEAD);
        vm.stopBroadcast();
    }
}
