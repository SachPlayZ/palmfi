// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Script} from "forge-std/Script.sol";
import {ArcConfig, External} from "./lib/ArcConfig.sol";
import {NetworkDeployer, Deployment} from "./lib/NetworkDeployer.sol";

/// Deploys the palmfi network to Arc testnet from scratch and records addresses in deployments/arc.json.
/// Rerunnable end to end: each run deploys a fresh network and overwrites the record, so apps and workflows
/// always read the latest addresses from that file.
contract Deploy is Script, ArcConfig, NetworkDeployer {
    string internal constant OUT = "../deployments/arc.json";

    function run() external returns (Deployment memory d) {
        External memory e = loadExternal();

        vm.startBroadcast();
        d = deployNetwork(e, msg.sender);
        vm.stopBroadcast();

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "blockNumber", d.blockNumber);
        vm.serializeAddress(k, "hub", d.hub);
        vm.serializeAddress(k, "factory", d.factory);
        vm.serializeAddress(k, "vaultImpl", d.vaultImpl);
        vm.serializeAddress(k, "vaultModule", d.vaultModule);
        vm.serializeAddress(k, "tokenImpl", d.tokenImpl);
        string memory json = vm.serializeAddress(k, "deployer", d.deployer);
        vm.writeJson(json, OUT);
    }
}
