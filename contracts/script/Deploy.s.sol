// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Script} from "forge-std/Script.sol";
import {ArcConfig, External} from "./lib/ArcConfig.sol";
import {NetworkDeployer, Deployment} from "./lib/NetworkDeployer.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-hooks-public/src/utils/HookMiner.sol";
import {OrbitalHook} from "../src/orbital/OrbitalHook.sol";
import {OrbitalRouter} from "../src/orbital/OrbitalRouter.sol";
import {VaultFactory} from "../src/VaultFactory.sol";

/// Deploys the palmfi network to Arc testnet from scratch and records addresses in deployments/arc.json.
/// Rerunnable end to end: each run deploys a fresh network and overwrites the record, so apps and workflows
/// always read the latest addresses from that file. The Orbital hook is mined to an address carrying its v4
/// permission bits and deployed through the CREATE2 proxy, then wired before any Vault exists.
contract Deploy is Script, ArcConfig, NetworkDeployer {
    string internal constant OUT = "../deployments/arc.json";
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );

    function run() external returns (Deployment memory d) {
        External memory e = loadExternal();

        vm.startBroadcast();
        d = deployNetwork(e, msg.sender);
        vm.stopBroadcast();

        bytes memory args = abi.encode(e.poolManager, d.factory, msg.sender);
        (address mined, bytes32 salt) = HookMiner.find(CREATE2_DEPLOYER, HOOK_FLAGS, type(OrbitalHook).creationCode, args);
        vm.startBroadcast();
        OrbitalHook hook = new OrbitalHook{salt: salt}(IPoolManager(e.poolManager), d.factory, msg.sender);
        require(address(hook) == mined, "hook address");
        OrbitalRouter router = new OrbitalRouter(IPoolManager(e.poolManager), hook);
        hook.setRouter(address(router));
        VaultFactory(d.factory).setHook(address(hook));
        vm.stopBroadcast();

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "blockNumber", d.blockNumber);
        vm.serializeAddress(k, "hub", d.hub);
        vm.serializeAddress(k, "factory", d.factory);
        vm.serializeAddress(k, "vaultImpl", d.vaultImpl);
        vm.serializeAddress(k, "vaultModule", d.vaultModule);
        vm.serializeAddress(k, "tokenImpl", d.tokenImpl);
        vm.serializeAddress(k, "orbitalHook", address(hook));
        vm.serializeAddress(k, "orbitalRouter", address(router));
        string memory json = vm.serializeAddress(k, "deployer", d.deployer);
        vm.writeJson(json, OUT);
    }
}
