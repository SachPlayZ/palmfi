// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {CommonBase} from "forge-std/Base.sol";

/// External Sepolia addresses palmfi builds on, read from config/sepolia.json (never hard-coded in contracts).
struct External {
    address poolManager;
    address positionManager;
    address stateView;
    address permit2;
    address universalRouter;
    address v4Quoter;
    address usdc;
    address weth;
    address link;
    address ethUsdFeed;
    address usdcUsdFeed;
    address linkUsdFeed;
    address ensUniversalResolver;
    address ensRootRegistry;
    address ensEthRegistry;
    address ensVerifiableFactory;
    address ensPermissionedResolverImpl;
    address ensUserRegistryImpl;
    address ensParentOwner;
    address creSimForwarder;
    address creForwarder;
    address metamaskDelegator;
    uint32 ethUsdHeartbeat;
    uint32 usdcUsdHeartbeat;
    uint256 voteWindow;
}

abstract contract SepoliaConfig is CommonBase {
    string internal constant CONFIG_PATH = "../config/sepolia.json";

    function loadExternal() internal view returns (External memory e) {
        string memory j = vm.readFile(CONFIG_PATH);
        e.poolManager = vm.parseJsonAddress(j, ".uniswap.poolManager");
        e.positionManager = vm.parseJsonAddress(j, ".uniswap.positionManager");
        e.stateView = vm.parseJsonAddress(j, ".uniswap.stateView");
        e.permit2 = vm.parseJsonAddress(j, ".uniswap.permit2");
        e.universalRouter = vm.parseJsonAddress(j, ".uniswap.universalRouter");
        e.v4Quoter = vm.parseJsonAddress(j, ".uniswap.v4Quoter");
        e.usdc = vm.parseJsonAddress(j, ".tokens.usdc");
        e.weth = vm.parseJsonAddress(j, ".tokens.weth");
        e.link = vm.parseJsonAddress(j, ".tokens.link");
        e.ethUsdFeed = vm.parseJsonAddress(j, ".feeds.ethUsd");
        e.usdcUsdFeed = vm.parseJsonAddress(j, ".feeds.usdcUsd");
        e.linkUsdFeed = vm.parseJsonAddress(j, ".feeds.linkUsd");
        e.ensUniversalResolver = vm.parseJsonAddress(j, ".ens.universalResolver");
        e.ensRootRegistry = vm.parseJsonAddress(j, ".ens.rootRegistry");
        e.ensEthRegistry = vm.parseJsonAddress(j, ".ens.ethRegistry");
        e.ensVerifiableFactory = vm.parseJsonAddress(j, ".ens.verifiableFactory");
        e.ensPermissionedResolverImpl = vm.parseJsonAddress(j, ".ens.permissionedResolverImpl");
        e.ensUserRegistryImpl = vm.parseJsonAddress(j, ".ens.userRegistryImpl");
        e.ensParentOwner = vm.parseJsonAddress(j, ".ens.parentOwner");
        e.creSimForwarder = vm.parseJsonAddress(j, ".cre.simForwarder");
        e.creForwarder = vm.parseJsonAddress(j, ".cre.forwarder");
        e.metamaskDelegator = vm.parseJsonAddress(j, ".delegates.metamaskEip7702StatelessDeleGator");
        e.ethUsdHeartbeat = uint32(vm.parseJsonUint(j, ".feedHeartbeats.ethUsd"));
        e.usdcUsdHeartbeat = uint32(vm.parseJsonUint(j, ".feedHeartbeats.usdcUsd"));
        e.voteWindow = vm.parseJsonUint(j, ".network.voteWindowSeconds");
    }
}
