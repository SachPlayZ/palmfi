// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {ArcConfig, External} from "../../script/lib/ArcConfig.sol";
import {NetworkDeployer, Deployment} from "../../script/lib/NetworkDeployer.sol";
import {PalmTypes} from "../../src/libraries/PalmTypes.sol";
import {Vault} from "../../src/Vault.sol";
import {VaultModule} from "../../src/VaultModule.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {Hub} from "../../src/Hub.sol";
import {ProtectedToken} from "../../src/tokens/ProtectedToken.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

interface IERC20Like {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// Seam 1: the whole palmfi network deployed onto an Arc testnet fork, driven by actors through public entry points.
abstract contract NetworkTest is Test, ArcConfig, NetworkDeployer {
    string internal constant DEFAULT_RPC = "https://rpc.testnet.arc.network";

    External internal ext;
    Deployment internal net;

    address internal deployer = makeAddr("deployer");
    address internal attacker = makeAddr("attacker");
    address internal recoveryKey = makeAddr("recoveryKey");
    address internal recoveryVaultAddr = makeAddr("recoveryVault");
    address internal outsider = makeAddr("outsider");

    // Nvidia: 5 wallets (CFO, controller, 3 treasury engineers). w[0] is the usual payer.
    address[] internal w;

    function setUp() public virtual {
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        string memory rpc = vm.envOr("ARC_RPC_URL", DEFAULT_RPC);
        if (forkBlock == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, forkBlock);

        ext = loadExternal();
        vm.etch(ext.usdc, address(new MockUSDC()).code);
        vm.startPrank(deployer, deployer);
        net = deployNetwork(ext, deployer);
        vm.stopPrank();

        for (uint256 i; i < 5; i++) {
            w.push(makeAddr(string.concat("wallet", vm.toString(i))));
        }
    }

    uint256 internal constant BOND = 1e6;

    function mod(Vault v) internal pure returns (VaultModule) {
        return VaultModule(address(v));
    }

    function factory() internal view returns (VaultFactory) {
        return VaultFactory(net.factory);
    }

    function hub() internal view returns (Hub) {
        return Hub(net.hub);
    }

    function wallets(uint256 n) internal view returns (address[] memory out) {
        out = new address[](n);
        for (uint256 i; i < n; i++) {
            out[i] = w[i];
        }
    }

    /// Demo limits scaled down: $500/24h, $2,000/7d, $5,000 Hard cap; Floor 15m, CapDelay 24h, MaxDelay 72h.
    function config(address[] memory ws) internal view returns (PalmTypes.VaultConfig memory c) {
        c.wallets = ws;
        c.recoveryKey = recoveryKey;
        c.recoveryVault = recoveryVaultAddr;
        c.budget24h = 500e6;
        c.budget7d = 2_000e6;
        c.hardCap = 5_000e6;
        c.floorDelay = 15 minutes;
        c.maxDelay = 72 hours;
        c.capDelay = 24 hours;
        c.bizStartHourUtc = 9;
        c.bizEndHourUtc = 18;
        c.usualMaxPayout = 2_000e6;
    }

    function onboard(string memory name, uint256 nWallets) internal returns (Vault) {
        return Vault(factory().createVault(name, config(wallets(nWallets))));
    }

    function tokenOf(Vault v) internal view returns (ProtectedToken) {
        return ProtectedToken(v.token());
    }

    /// USDC is a MockUSDC etched over Arc's 0x3600… in fork tests (see MockUSDC).
    function fundUsdc(address to, uint256 amount) internal {
        deal(ext.usdc, to, usdcBalance(to) + amount, true);
    }

    function usdcBalance(address a) internal view returns (uint256) {
        return IERC20Like(ext.usdc).balanceOf(a);
    }

    function depositUsdc(Vault v, address wallet, uint256 amount) internal {
        fundUsdc(wallet, amount);
        vm.startPrank(wallet);
        IERC20Like(ext.usdc).approve(address(v), amount);
        v.deposit(amount, wallet);
        vm.stopPrank();
    }

    // --- CRE reports ---

    uint256 internal reportNonce;

    function report(PalmTypes.Report memory r) internal {
        r.expiry = uint64(block.timestamp + 10 minutes);
        r.nonce = ++reportNonce;
        vm.prank(ext.creSimForwarder);
        hub().onReport("", abi.encode(r));
    }

    function setDelay(Vault v, uint256 id, uint64 delay, uint32 score) internal {
        report(
            PalmTypes.Report(
                PalmTypes.REPORT_SET_DELAY, address(v), id, v.getRequest(id).requestHash, delay, score, 0, 0, 0
            )
        );
    }

    function flag(Vault v, uint256 id, uint256 codes) internal {
        report(
            PalmTypes.Report(
                PalmTypes.REPORT_FLAG, address(v), id, v.getRequest(id).requestHash, 0, 30_000, codes, 0, 0
            )
        );
    }

    function vote(Vault v, address voter, uint256 id, bool yes) internal {
        vm.prank(voter);
        v.vote(id, yes);
    }
}
