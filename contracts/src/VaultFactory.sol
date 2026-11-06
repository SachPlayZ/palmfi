// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {PalmTypes as T} from "./libraries/PalmTypes.sol";
import {IEnsRegistrar, IEnsResolver} from "./interfaces/IPalm.sol";
import {Vault} from "./Vault.sol";
import {ProtectedToken} from "./tokens/ProtectedToken.sol";

interface IHubFactory {
    function registerVault(address vault, address owner, bytes calldata dnsName, bool institution) external;
    function markRevoked(address vault) external;
    function statusOf(address) external view returns (uint8);
}

interface IRegistryFactory {
    function admit(address member, address vault) external;
}

/// Creates pools for a new Vault on the VaultHook (one per Underlying). Implemented by VaultHook.
interface IPoolInitializer {
    function initializePools(address vault, address[] calldata underlyings, address[] calldata tokens) external;
}

/// Onboards every Owner in one transaction: Vault clone + Protected tokens + Hub registration + hook pools +
/// ENS name (+ Member admission for Institutions) + onboarding fee. Holds every name token (ERC1155 receiver),
/// so names are non-transferable (roleBitmap 0). The admin can admit Institutions, set `verified` (only at
/// Institution onboarding) and revoke names, but has no path to any Vault's whitelist, keys or funds.
contract VaultFactory is ERC1155Holder {
    using Strings for address;

    uint256 public constant ONBOARDING_FEE = 0.001 ether;
    uint256 public constant COIN_TYPE_ETH = 60;

    struct ListedAsset {
        address underlying;
        address feed;
        uint32 heartbeat;
        string symbol; // Protected token symbol, e.g. "pUSDC"
    }

    struct Name {
        address vault;
        address controller; // Owner allowed to edit url/avatar
        bool institution;
        bool verified;
    }

    struct Wiring {
        address admin;
        address hub;
        address registry;
        address safetyFund;
        address approvalBook;
        address vaultImpl;
        address tokenImpl;
        address poolManager;
        address weth;
        address usdc;
        address ensRegistry; // our UserRegistry under the parent
        address ensResolver; // shared PermissionedResolver
        bytes parentDnsName; // e.g. \x06palmfi\x03eth\x00
        address[] defaultDelegates; // e.g. MetaMask's EIP-7702 delegator
    }

    address public immutable admin;
    address public immutable hub;
    address public immutable registry;
    address public immutable safetyFund;
    address public immutable approvalBook;
    address public immutable vaultImpl;
    address public immutable tokenImpl;
    address public immutable poolManager;
    address public immutable weth;
    address public immutable usdc;
    IEnsRegistrar public immutable ensRegistry;
    IEnsResolver public immutable ensResolver;
    bytes public parentDnsName;
    address[] internal _defaultDelegates;
    ListedAsset[] internal _assets;

    address public hook;
    address public safeHarborSwapper;
    address public tokenJar;

    mapping(address => bool) public isVault;
    mapping(bytes32 => Name) internal _names; // labelhash => name
    mapping(address => string) public labelOf; // vault => label

    event VaultCreated(address indexed vault, string label, address indexed owner, bool institution);
    event Reissued(string label, address indexed oldVault, address indexed newVault);
    event NameRevoked(string label, address indexed vault);
    event ProfileSet(string label, string key, string value);

    error NotAdmin();
    error AlreadySet();
    error BadFee();
    error NameTaken();
    error BadConfig();
    error NotController();
    error KeyNotAllowed();
    error NotMigrated();
    error NotRecoveryKey();
    error UnknownName();

    constructor(Wiring memory w, ListedAsset[] memory listed) {
        admin = w.admin;
        hub = w.hub;
        registry = w.registry;
        safetyFund = w.safetyFund;
        approvalBook = w.approvalBook;
        vaultImpl = w.vaultImpl;
        tokenImpl = w.tokenImpl;
        poolManager = w.poolManager;
        weth = w.weth;
        usdc = w.usdc;
        ensRegistry = IEnsRegistrar(w.ensRegistry);
        ensResolver = IEnsResolver(w.ensResolver);
        parentDnsName = w.parentDnsName;
        _defaultDelegates = w.defaultDelegates;
        for (uint256 i; i < listed.length; i++) {
            _assets.push(listed[i]);
        }
    }

    // --- one-time wiring of contracts that need the factory's address first ---

    function setHook(address hook_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (hook != address(0)) revert AlreadySet();
        hook = hook_;
    }

    function setSafeHarborSwapper(address swapper) external {
        if (msg.sender != admin) revert NotAdmin();
        if (safeHarborSwapper != address(0)) revert AlreadySet();
        safeHarborSwapper = swapper;
    }

    function setTokenJar(address jar) external {
        if (msg.sender != admin) revert NotAdmin();
        if (tokenJar != address(0)) revert AlreadySet();
        tokenJar = jar;
    }

    // --- onboarding ---

    /// Individual onboarding from the Owner's own EOA.
    function createVault(string calldata label, T.VaultConfig calldata cfg) external payable returns (address) {
        if (cfg.owner != msg.sender || cfg.approver != address(0)) revert BadConfig();
        return _create(label, cfg, false);
    }

    /// Institution onboarding after offchain business verification: `verified=true`, fail-closed config with an
    /// Approver, the coarse profile, and Member admission, all in one transaction.
    function onboardInstitution(string calldata label, T.VaultConfig calldata cfg)
        external
        payable
        returns (address v)
    {
        if (msg.sender != admin) revert NotAdmin();
        if (cfg.approver == address(0)) revert BadConfig();
        v = _create(label, cfg, true);
        IRegistryFactory(registry).admit(cfg.owner, v);
    }

    function _create(string calldata label, T.VaultConfig calldata cfg, bool inst) internal returns (address v) {
        if (msg.value != ONBOARDING_FEE) revert BadFee();
        if (cfg.hotWallets.length == 0 || cfg.recoveryKey == address(0) || cfg.recoveryVault == address(0)) {
            revert BadConfig();
        }
        bytes32 lh = keccak256(bytes(label));
        if (_names[lh].vault != address(0)) revert NameTaken();

        v = _deployVault(label, cfg);
        _names[lh] = Name(v, cfg.owner, inst, inst);
        labelOf[v] = label;

        bytes memory dns = dnsName(label);
        IHubFactory(hub).registerVault(v, cfg.owner, dns, inst);
        ensRegistry.register(
            label, address(this), address(0), address(ensResolver), 0, uint64(block.timestamp + 1460 days)
        );
        _writeRecords(dns, v, inst, inst);

        (bool ok,) = (tokenJar == address(0) ? safetyFund : tokenJar).call{value: msg.value}("");
        require(ok, "fee");
        emit VaultCreated(v, label, cfg.owner, inst);
    }

    function _deployVault(string calldata label, T.VaultConfig calldata cfg) internal returns (address v) {
        v = Clones.clone(vaultImpl);
        uint256 n = _assets.length;
        Vault.Wiring memory w;
        w.hub = hub;
        w.registry = registry;
        w.weth = weth;
        w.usdc = usdc;
        w.safetyFund = safetyFund;
        w.approvalBook = approvalBook;
        w.underlyings = new address[](n);
        w.tokens = new address[](n);
        w.feeds = new address[](n);
        w.heartbeats = new uint32[](n);
        w.defaultDelegates = _defaultDelegates;
        for (uint256 i; i < n; i++) {
            ListedAsset memory a = _assets[i];
            address t = Clones.clone(tokenImpl);
            ProtectedToken(t)
                .initialize(
                    v,
                    a.underlying,
                    poolManager,
                    string.concat("palmfi ", a.symbol, " (", label, ")"),
                    a.symbol,
                    ProtectedToken(a.underlying).decimals()
                );
            w.underlyings[i] = a.underlying;
            w.tokens[i] = t;
            w.feeds[i] = a.feed;
            w.heartbeats[i] = a.heartbeat;
        }
        Vault(payable(v)).initialize(cfg, w);
        isVault[v] = true;
        if (hook != address(0)) IPoolInitializer(hook).initializePools(v, w.underlyings, w.tokens);
    }

    function _writeRecords(bytes memory dns, address v, bool inst, bool verified) internal {
        ensResolver.setAddress(dns, COIN_TYPE_ETH, abi.encodePacked(v));
        ensResolver.setText(dns, "type", inst ? "institution" : "personal");
        ensResolver.setText(dns, "verified", verified ? "true" : "false");
        ensResolver.setText(dns, "status", "active");
        ensResolver.setText(dns, "tokens", tokensRecord(v));
    }

    /// `pUSDC:0x…,pWETH:0x…` — every Protected token of the Vault.
    function tokensRecord(address v) public view returns (string memory s) {
        for (uint256 i; i < _assets.length; i++) {
            address t = Vault(payable(v)).protectedToken(_assets[i].underlying);
            s = string.concat(s, i == 0 ? "" : ",", _assets[i].symbol, ":", t.toChecksumHexString());
        }
    }

    // --- after migration: same name, fresh Vault ---

    function reissue(string calldata label, T.VaultConfig calldata cfg) external returns (address v) {
        bytes32 lh = keccak256(bytes(label));
        Name memory nm = _names[lh];
        if (nm.vault == address(0)) revert UnknownName();
        if (IHubFactory(hub).statusOf(nm.vault) != T.STATUS_MIGRATED) revert NotMigrated();
        if (msg.sender != Vault(payable(nm.vault)).recoveryKey()) revert NotRecoveryKey();
        if (cfg.hotWallets.length == 0 || cfg.recoveryKey == address(0) || cfg.recoveryVault == address(0)) {
            revert BadConfig();
        }
        if (nm.institution != (cfg.approver != address(0))) revert BadConfig();

        v = _deployVault(label, cfg);
        _names[lh].vault = v;
        labelOf[v] = label;
        bytes memory dns = dnsName(label);
        IHubFactory(hub).registerVault(v, nm.controller, dns, nm.institution);
        _writeRecords(dns, v, nm.institution, nm.verified);
        emit Reissued(label, nm.vault, v);
    }

    // --- ENS profile + revocation ---

    function setProfile(string calldata label, string calldata key, string calldata value) external {
        Name memory nm = _names[keccak256(bytes(label))];
        if (nm.vault == address(0)) revert UnknownName();
        if (msg.sender != nm.controller) revert NotController();
        bytes32 k = keccak256(bytes(key));
        if (k != keccak256("url") && k != keccak256("avatar")) revert KeyNotAllowed();
        ensResolver.setText(dnsName(label), key, value);
        emit ProfileSet(label, key, value);
    }

    /// Fraudulent name: clear `addr`, set `status=revoked`, mark the Vault revoked in the Hub.
    function revoke(string calldata label) external {
        if (msg.sender != admin) revert NotAdmin();
        Name memory nm = _names[keccak256(bytes(label))];
        if (nm.vault == address(0)) revert UnknownName();
        bytes memory dns = dnsName(label);
        ensResolver.setAddress(dns, COIN_TYPE_ETH, "");
        ensResolver.setText(dns, "status", "revoked");
        IHubFactory(hub).markRevoked(nm.vault);
        emit NameRevoked(label, nm.vault);
    }

    // --- views ---

    function dnsName(string memory label) public view returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(label).length), label, parentDnsName);
    }

    function vaultOf(string calldata label) external view returns (address) {
        return _names[keccak256(bytes(label))].vault;
    }

    function nameInfo(string calldata label) external view returns (Name memory) {
        return _names[keccak256(bytes(label))];
    }

    function listedAssets() external view returns (ListedAsset[] memory) {
        return _assets;
    }

    function defaultDelegates() external view returns (address[] memory) {
        return _defaultDelegates;
    }
}
