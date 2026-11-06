// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {CommonBase} from "forge-std/Base.sol";

/// External Arc testnet addresses palmfi builds on, read from config/arc.json (never hard-coded in contracts).
struct External {
    address poolManager;
    address permit2;
    address usdc;
    address creSimForwarder;
    address creForwarder;
    address metamaskDelegator;
}

abstract contract ArcConfig is CommonBase {
    string internal constant CONFIG_PATH = "../config/arc.json";

    function loadExternal() internal view returns (External memory e) {
        string memory j = vm.readFile(CONFIG_PATH);
        e.poolManager = vm.parseJsonAddress(j, ".uniswap.poolManager");
        e.permit2 = vm.parseJsonAddress(j, ".uniswap.permit2");
        e.usdc = vm.parseJsonAddress(j, ".tokens.usdc");
        e.creSimForwarder = vm.parseJsonAddress(j, ".cre.simForwarder");
        e.creForwarder = vm.parseJsonAddress(j, ".cre.forwarder");
        e.metamaskDelegator = vm.parseJsonAddress(j, ".delegates.metamaskEip7702StatelessDeleGator");
    }
}
