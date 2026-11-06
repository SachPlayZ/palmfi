// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {SepoliaConfig, External} from "../../script/lib/SepoliaConfig.sol";
import {NetworkDeployer, Deployment} from "../../script/lib/NetworkDeployer.sol";
import {PalmTypes} from "../../src/libraries/PalmTypes.sol";
import {Vault} from "../../src/Vault.sol";
import {VaultModule} from "../../src/VaultModule.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {Hub} from "../../src/Hub.sol";
import {NetworkRegistry} from "../../src/NetworkRegistry.sol";
import {ProtectedToken} from "../../src/tokens/ProtectedToken.sol";
import {IEnsResolver} from "../../src/interfaces/IPalm.sol";

interface IUniversalResolverV2 {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory, address);
}

interface IWETH9 {
    function deposit() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IERC20Like {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
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
    address internal deployer;

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
        deployer = ext.ensParentOwner; // the deployer owns palmfi.eth
        vm.startPrank(deployer, deployer);
        net = deployNetwork(ext, deployer);
        vm.stopPrank();
    }

    uint256 internal constant FEE = 0.001 ether;
    uint256 internal constant BOND = 0.001 ether;
    address internal recoveryVaultAddr = makeAddr("recoveryVault");
    address internal hotWallet2 = makeAddr("hotWallet2");
    address internal payee = makeAddr("payee");

    /// The Vault address seen through its module ABI (settings, recovery, Safe-harbor, Reconciler views).
    function mod(Vault v) internal pure returns (VaultModule) {
        return VaultModule(payable(address(v)));
    }

    function factory() internal view returns (VaultFactory) {
        return VaultFactory(net.factory);
    }

    function hub() internal view returns (Hub) {
        return Hub(net.hub);
    }

    function netRegistry() internal view returns (NetworkRegistry) {
        return NetworkRegistry(net.registry);
    }

    /// Alice's demo limits (spec): $5/24h, $20/7d, $50 Hard cap; short Floor and full delay for tests.
    function individualConfig(address owner_, address hot) internal view returns (PalmTypes.VaultConfig memory c) {
        c.owner = owner_;
        c.hotWallets = new address[](2);
        c.hotWallets[0] = hot;
        c.hotWallets[1] = hotWallet2;
        c.defaultReceiver = hot;
        c.guardian = guardian;
        c.recoveryKey = recoveryKey;
        c.recoveryVault = recoveryVaultAddr;
        c.budget24h = 5e6;
        c.budget7d = 20e6;
        c.hardCap = 50e6;
        c.floorDelay = 15 minutes;
        c.fullDelay = 24 hours;
    }

    function onboardIndividual(string memory label, PalmTypes.VaultConfig memory c) internal returns (Vault v) {
        vm.deal(c.owner, c.owner.balance + FEE);
        vm.prank(c.owner);
        v = Vault(payable(factory().createVault{value: FEE}(label, c)));
    }

    function onboardAlice() internal returns (Vault) {
        return onboardIndividual("alice", individualConfig(owner, hotWallet));
    }

    function usdcToken(Vault v) internal view returns (ProtectedToken) {
        return ProtectedToken(v.protectedToken(ext.usdc));
    }

    function ethToken(Vault v) internal view returns (ProtectedToken) {
        return ProtectedToken(v.protectedToken(ext.weth));
    }

    function depositUsdc(Vault v, address hot, uint256 amount) internal {
        fundUsdc(hot, amount);
        vm.startPrank(hot);
        IERC20Like(ext.usdc).approve(address(v), amount);
        v.deposit(ext.usdc, amount, hot);
        vm.stopPrank();
    }

    // --- CRE reports ---

    uint256 internal reportNonce;

    function report(uint8 reportType, address vault, uint256 requestId, bytes32 h, uint8 v, uint256 codes) internal {
        PalmTypes.Report memory r = PalmTypes.Report(
            reportType, vault, requestId, h, v, codes, uint64(block.timestamp + 10 minutes), ++reportNonce
        );
        asForwarder();
        hub().onReport("", abi.encode(r));
    }

    function verdict(Vault v, uint256 id, uint8 verdict_, uint256 codes) internal {
        report(PalmTypes.REPORT_VERDICT, address(v), id, v.getRequest(id).requestHash, verdict_, codes);
    }

    // --- ENS reads (through the shared resolver and the live Universal Resolver) ---

    function ensDns(string memory label) internal view returns (bytes memory) {
        return factory().dnsName(label);
    }

    function ensText(string memory label, string memory key) internal view returns (string memory) {
        bytes memory out = IEnsResolver(net.ensResolver)
            .resolve(ensDns(label), abi.encodeWithSignature("text(bytes32,string)", bytes32(0), key));
        return abi.decode(out, (string));
    }

    function ensAddr(string memory label) internal view returns (address) {
        bytes memory out =
            IEnsResolver(net.ensResolver).resolve(ensDns(label), abi.encodeWithSignature("addr(bytes32)", bytes32(0)));
        return abi.decode(out, (address));
    }

    function urAddr(string memory label) internal view returns (address) {
        (bytes memory out,) = IUniversalResolverV2(ext.ensUniversalResolver)
            .resolve(ensDns(label), abi.encodeWithSignature("addr(bytes32)", bytes32(0)));
        return abi.decode(out, (address));
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
