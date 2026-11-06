// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {SepoliaConfig, External} from "../../script/lib/SepoliaConfig.sol";
import {NetworkDeployer, Deployment} from "../../script/lib/NetworkDeployer.sol";

interface IWETH9 {
    function deposit() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IAggregatorV3 {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// Seam 1: the whole palmfi network deployed onto a Sepolia fork, driven by actors through public entry points.
abstract contract NetworkTest is Test, SepoliaConfig, NetworkDeployer {
    string internal constant DEFAULT_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

    External internal ext;
    Deployment internal net;

    address internal owner = makeAddr("owner");
    address internal hotWallet = makeAddr("hotWallet");
    address internal attacker = makeAddr("attacker");
    address internal guardian = makeAddr("guardian");
    address internal recoveryKey = makeAddr("recoveryKey");
    address internal member = makeAddr("member");
    address internal searcher = makeAddr("searcher");
    address internal approver = makeAddr("approver");
    address internal deployer = makeAddr("deployer");

    function setUp() public virtual {
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", DEFAULT_RPC);
        if (forkBlock == 0) {
            // Stay a few blocks behind head: load-balanced public RPCs serve "latest" from nodes that lag.
            vm.createSelectFork(rpc);
            vm.rollFork(block.number - 8);
        } else {
            vm.createSelectFork(rpc, forkBlock);
        }

        ext = loadExternal();
        net = deployNetwork(ext, deployer);
    }

    // --- actor helpers ---

    function fundUsdc(address to, uint256 amount) internal {
        deal(ext.usdc, to, amount);
    }

    function fundWeth(address to, uint256 amount) internal {
        vm.deal(to, amount);
        vm.prank(to);
        IWETH9(ext.weth).deposit{value: amount}();
    }

    /// Next call comes from the CRE simulation forwarder, as `cre workflow simulate --broadcast` reports do.
    function asForwarder() internal {
        vm.prank(ext.creSimForwarder);
    }

    function ethUsdPrice() internal view returns (int256 answer) {
        (, answer,,,) = IAggregatorV3(ext.ethUsdFeed).latestRoundData();
    }
}
