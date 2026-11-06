// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PalmTypes as T} from "./libraries/PalmTypes.sol";
import {IOrbitalHookRegistry} from "./interfaces/IPalm.sol";
import {Vault} from "./Vault.sol";
import {VaultBase} from "./VaultBase.sol";
import {ProtectedToken} from "./tokens/ProtectedToken.sol";

interface IHubFactory {
    function registerVault(address vault, string calldata name, address token) external;
}

/// Onboards an org or person (v2): deploys their Vault + Protected token as clones, registers the name in the Hub
/// directory, and lists the token in the Orbital pool. Has no path to any Vault's wallets, recovery or funds.
contract VaultFactory {
    struct Wiring {
        address admin;
        address hub;
        address usdc;
        address poolManager;
        address vaultImpl;
        address vaultModule;
        address tokenImpl;
        address[] defaultDelegates;
    }

    address public immutable admin;
    address public immutable hub;
    address public immutable usdc;
    address public immutable poolManager;
    address public immutable vaultImpl;
    address public immutable vaultModule;
    address public immutable tokenImpl;
    address[] internal _defaultDelegates;

    /// The Orbital pool hook (#33). Set once, before onboarding (tokens record it at creation).
    address public hook;

    mapping(address => bool) public isVault;

    event VaultCreated(address indexed vault, string name, address token);

    error NotAdmin();
    error AlreadySet();
    error BadConfig();

    constructor(Wiring memory w) {
        admin = w.admin;
        hub = w.hub;
        usdc = w.usdc;
        poolManager = w.poolManager;
        vaultImpl = w.vaultImpl;
        vaultModule = w.vaultModule;
        tokenImpl = w.tokenImpl;
        _defaultDelegates = w.defaultDelegates;
    }

    function setHook(address hook_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (hook != address(0)) revert AlreadySet();
        hook = hook_;
    }

    function createVault(string calldata name, T.VaultConfig calldata cfg) external returns (address v) {
        if (cfg.recoveryVault == address(0) || cfg.floorDelay == 0 || cfg.floorDelay > cfg.capDelay) {
            revert BadConfig();
        }
        if (cfg.capDelay > cfg.maxDelay) revert BadConfig();

        v = Clones.clone(vaultImpl);
        address t = Clones.clone(tokenImpl);
        ProtectedToken(t)
            .initialize(
                v, usdc, poolManager, hook, string.concat("palmfi USDC (", name, ")"), string.concat(name, "USDC"), 6
            );
        VaultBase.Wiring memory w = VaultBase.Wiring(hub, usdc, vaultModule, t, _defaultDelegates);
        Vault(v).initialize(cfg, w);
        isVault[v] = true;
        IHubFactory(hub).registerVault(v, name, t);
        if (hook != address(0)) IOrbitalHookRegistry(hook).registerToken(v);
        emit VaultCreated(v, name, t);
    }

    function defaultDelegates() external view returns (address[] memory) {
        return _defaultDelegates;
    }
}
