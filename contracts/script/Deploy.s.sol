// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Script} from "forge-std/Script.sol";
import {SepoliaConfig, External} from "./lib/SepoliaConfig.sol";
import {NetworkDeployer, Deployment} from "./lib/NetworkDeployer.sol";

/// Deploys the palmfi network to Sepolia from scratch and records addresses in deployments/sepolia.json.
/// Rerunnable end to end by design: each run deploys a fresh network (clean demo state, survives ENS redeploys)
/// and overwrites the record, so apps and workflows always read the latest addresses from that file.
contract Deploy is Script, SepoliaConfig, NetworkDeployer {
    string internal constant OUT = "../deployments/sepolia.json";

    function run() external returns (Deployment memory d) {
        External memory e = loadExternal();

        vm.startBroadcast();
        d = deployNetwork(e, msg.sender);
        vm.stopBroadcast();

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "blockNumber", d.blockNumber);
        vm.serializeAddress(k, "hub", d.hub);
        vm.serializeAddress(k, "registry", d.registry);
        vm.serializeAddress(k, "safetyFund", d.safetyFund);
        vm.serializeAddress(k, "approvalBook", d.approvalBook);
        vm.serializeAddress(k, "factory", d.factory);
        vm.serializeAddress(k, "vaultImpl", d.vaultImpl);
        vm.serializeAddress(k, "tokenImpl", d.tokenImpl);
        vm.serializeAddress(k, "ensUserRegistry", d.ensUserRegistry);
        vm.serializeAddress(k, "ensResolver", d.ensResolver);
        string memory json = vm.serializeAddress(k, "deployer", d.deployer);
        vm.writeJson(json, OUT);
    }
}
