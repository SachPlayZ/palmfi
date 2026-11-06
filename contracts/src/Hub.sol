// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {PalmTypes as T} from "./libraries/PalmTypes.sol";
import {IReceiver, IVault, IEnsResolver, INetworkRegistry} from "./interfaces/IPalm.sol";

/// The single network contract every Vault reports its events through and every CRE Verdict arrives through.
/// - Event router for the Sentinel's log trigger (all Vault events carry the vault as an indexed topic).
/// - CRE receiver: reverts only on a wrong caller; every content problem is dropped as ReportRejected (ADR-0005).
/// - Source of truth for Vault status, mirrored into ENS `status` (its only ENS write permission).
contract Hub is IReceiver {
    // --- events (the Sentinel/Reconciler/app ABI) ---
    event VaultRegistered(address indexed vault, address indexed owner, bytes dnsName, bool institution);
    event UnwrapRequested(
        address indexed vault,
        uint256 indexed requestId,
        bytes32 requestHash,
        address asset,
        uint256 amount,
        address destination,
        uint256 usdValue,
        uint256 reasonCodes
    );
    event RequestUpdated(
        address indexed vault, uint256 indexed requestId, uint8 state, uint64 executableAt, uint256 reasonCodes
    );
    event ConfigChangeRequested(address indexed vault, uint256 indexed changeId, uint8 kind, bytes data, uint64 eta);
    event SecondFactorConfirmed(address indexed vault, uint256 indexed requestId, bytes32 requestHash);
    event HookSwap(
        address indexed vault, address indexed hotWallet, address asset, uint256 amount, bool isUnwrap, uint256 usdValue
    );
    event SafeHarborSwap(
        address indexed vault, address indexed hotWallet, uint256 amountIn, uint256 amountOut, uint256 minOut
    );
    event NetworkTransfer(address indexed vault, address indexed payee, address asset, uint256 amount);
    event Flagged(address indexed vault, uint256 indexed requestId, uint256 reasonCodes, address destination);
    event Frozen(address indexed vault, uint256 reasonCodes);
    event Unfrozen(address indexed vault);
    event Migrated(address indexed vault, address recoveryVault);
    event StatusChanged(address indexed vault, uint8 status);
    event PausedChanged(address indexed vault, bool paused);
    event MarketModeSet(address indexed asset, uint8 mode);
    event Heartbeat(uint256 timestamp, uint256 nonce);
    event ReportAccepted(bytes32 indexed reportId, uint8 reportType, address indexed vault, uint256 requestId);
    event ReportRejected(bytes32 indexed reportId, uint8 reason);
    event EnsWriteFailed(address indexed vault, string status);
    event WorkflowPinned(bytes32 workflowId, address workflowOwner, bytes10 workflowName, address forwarder);
    event WorkflowRotationProposed(bytes32 workflowId, address workflowOwner, bytes10 workflowName, uint64 eta);

    error NotForwarder();
    error NotVault();
    error NotAdmin();
    error NotFactory();
    error NotRegistry();
    error AlreadySet();
    error BadTransition();
    error FreezeLocked();
    error TimelockActive();

    uint256 public constant ROTATION_TIMELOCK = 48 hours;

    address public immutable admin;
    IEnsResolver public immutable resolver;
    address public forwarder;
    address public factory;
    INetworkRegistry public registry;

    // workflow pin (set once when we go live; rotation needs 48h timelock + Vote)
    bool public pinned;
    bytes32 public workflowId;
    address public workflowOwner;
    bytes10 public workflowName;

    struct Rotation {
        bytes32 id;
        address owner;
        bytes10 name;
        uint64 eta;
    }

    Rotation public pendingRotation;

    mapping(address => uint8) public statusOf;
    mapping(address => bytes) public dnsNameOf;
    mapping(address => uint64) public freezeLockedUntil;
    mapping(address => uint8) public marketMode;
    mapping(bytes32 => bool) public usedReports;
    address[] internal _vaults;
    uint256 public lastHeartbeat;

    constructor(address admin_, address forwarder_, address resolver_) {
        admin = admin_;
        forwarder = forwarder_;
        resolver = IEnsResolver(resolver_);
    }

    function setWiring(address factory_, address registry_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (factory != address(0)) revert AlreadySet();
        factory = factory_;
        registry = INetworkRegistry(registry_);
    }

    // ------------------------------------------------------------------
    // Factory hooks
    // ------------------------------------------------------------------

    function registerVault(address vault, address owner, bytes calldata dnsName, bool institution) external {
        if (msg.sender != factory) revert NotFactory();
        statusOf[vault] = T.STATUS_ACTIVE;
        dnsNameOf[vault] = dnsName;
        _vaults.push(vault);
        emit VaultRegistered(vault, owner, dnsName, institution);
        emit StatusChanged(vault, T.STATUS_ACTIVE);
    }

    /// Revocation by the admin through the factory (the factory clears `addr` and writes `status=revoked`).
    function markRevoked(address vault) external {
        if (msg.sender != factory) revert NotFactory();
        statusOf[vault] = T.STATUS_REVOKED;
        emit StatusChanged(vault, T.STATUS_REVOKED);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function isVault(address vault) public view returns (bool) {
        return statusOf[vault] != T.STATUS_NONE;
    }

    function isBlocked(address account) external view returns (bool) {
        return registry.isBlocked(account);
    }

    function vaultCount() external view returns (uint256) {
        return _vaults.length;
    }

    function getVaults(uint256 offset, uint256 limit) external view returns (address[] memory out) {
        uint256 n = _vaults.length;
        if (offset >= n) return out;
        uint256 end = offset + limit > n ? n : offset + limit;
        out = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            out[i - offset] = _vaults[i];
        }
    }

    struct OpenRequest {
        address vault;
        uint256 requestId;
        uint256 usdValue;
        uint8 state;
        bytes32 requestHash;
    }

    /// Batched view for the Reconciler: every open request across a page of Vaults.
    function openRequests(uint256 offset, uint256 limit) external view returns (OpenRequest[] memory out) {
        address[] memory vs = this.getVaults(offset, limit);
        uint256 total;
        uint256[][] memory ids = new uint256[][](vs.length);
        for (uint256 i; i < vs.length; i++) {
            ids[i] = VaultLike(vs[i]).openRequestIds();
            total += ids[i].length;
        }
        out = new OpenRequest[](total);
        uint256 k;
        for (uint256 i; i < vs.length; i++) {
            for (uint256 j; j < ids[i].length; j++) {
                VaultLike.Req memory r = VaultLike(vs[i]).getRequest(ids[i][j]);
                out[k++] = OpenRequest(vs[i], ids[i][j], r.usdValue, r.state, r.requestHash);
            }
        }
    }

    // ------------------------------------------------------------------
    // Vault → Hub event router
    // ------------------------------------------------------------------

    modifier onlyVault() {
        if (statusOf[msg.sender] == T.STATUS_NONE) revert NotVault();
        _;
    }

    function emitUnwrapRequested(
        uint256 requestId,
        bytes32 requestHash,
        address asset,
        uint256 amount,
        address destination,
        uint256 usdValue,
        uint256 reasonCodes
    ) external onlyVault {
        emit UnwrapRequested(msg.sender, requestId, requestHash, asset, amount, destination, usdValue, reasonCodes);
    }

    function emitRequestUpdated(uint256 requestId, uint8 state, uint64 executableAt, uint256 reasonCodes)
        external
        onlyVault
    {
        emit RequestUpdated(msg.sender, requestId, state, executableAt, reasonCodes);
    }

    function emitConfigChangeRequested(uint256 changeId, uint8 kind, bytes calldata data, uint64 eta)
        external
        onlyVault
    {
        emit ConfigChangeRequested(msg.sender, changeId, kind, data, eta);
    }

    function emitSecondFactorConfirmed(uint256 requestId, bytes32 requestHash) external onlyVault {
        emit SecondFactorConfirmed(msg.sender, requestId, requestHash);
    }

    function emitHookSwap(address hotWallet, address asset, uint256 amount, bool isUnwrap, uint256 usdValue)
        external
        onlyVault
    {
        emit HookSwap(msg.sender, hotWallet, asset, amount, isUnwrap, usdValue);
    }

    function emitSafeHarborSwap(address hotWallet, uint256 amountIn, uint256 amountOut, uint256 minOut)
        external
        onlyVault
    {
        emit SafeHarborSwap(msg.sender, hotWallet, amountIn, amountOut, minOut);
    }

    function emitNetworkTransfer(address payee, address asset, uint256 amount) external onlyVault {
        emit NetworkTransfer(msg.sender, payee, asset, amount);
    }

    function vaultPaused(bool paused) external onlyVault {
        emit PausedChanged(msg.sender, paused);
    }

    /// Recovery-key unfreeze (the Vault already checked the Recovery key and, for Individuals, the passkey).
    function vaultUnfreeze() external onlyVault {
        if (statusOf[msg.sender] != T.STATUS_FROZEN) revert BadTransition();
        if (block.timestamp < freezeLockedUntil[msg.sender]) revert FreezeLocked();
        _setStatus(msg.sender, T.STATUS_ACTIVE, "active");
        emit Unfrozen(msg.sender);
    }

    function vaultMigrated(address recoveryVault) external onlyVault {
        _setStatus(msg.sender, T.STATUS_MIGRATED, "migrated");
        emit Migrated(msg.sender, recoveryVault);
    }

    // ------------------------------------------------------------------
    // NetworkRegistry (Votes)
    // ------------------------------------------------------------------

    function extendFreeze(address vault, uint64 until) external {
        if (msg.sender != address(registry)) revert NotRegistry();
        if (statusOf[vault] != T.STATUS_FROZEN) revert BadTransition();
        if (until > freezeLockedUntil[vault]) freezeLockedUntil[vault] = until;
    }

    function proposeWorkflowRotation(bytes32 id, address owner_, bytes10 name_) external {
        if (msg.sender != admin) revert NotAdmin();
        uint64 eta = uint64(block.timestamp + ROTATION_TIMELOCK);
        pendingRotation = Rotation(id, owner_, name_, eta);
        emit WorkflowRotationProposed(id, owner_, name_, eta);
    }

    /// Executed by a passed Vote, after the 48h timelock.
    function applyWorkflowRotation() external {
        if (msg.sender != address(registry)) revert NotRegistry();
        Rotation memory r = pendingRotation;
        if (r.eta == 0 || block.timestamp < r.eta) revert TimelockActive();
        workflowId = r.id;
        workflowOwner = r.owner;
        workflowName = r.name;
        delete pendingRotation;
        emit WorkflowPinned(r.id, r.owner, r.name, forwarder);
    }

    /// Go live: switch to the production forwarder and pin the workflow, once.
    function pinWorkflow(address forwarder_, bytes32 id, address owner_, bytes10 name_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (pinned) revert AlreadySet();
        pinned = true;
        forwarder = forwarder_;
        workflowId = id;
        workflowOwner = owner_;
        workflowName = name_;
        emit WorkflowPinned(id, owner_, name_, forwarder_);
    }

    // ------------------------------------------------------------------
    // CRE receiver
    // ------------------------------------------------------------------

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == 0x01ffc9a7;
    }

    function decodeReport(bytes calldata report) external pure returns (T.Report memory) {
        return abi.decode(report, (T.Report));
    }

    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != forwarder) revert NotForwarder();
        bytes32 reportId = keccak256(report);

        if (pinned && !_workflowOk(metadata)) return _reject(reportId, T.REJECT_WORKFLOW);

        T.Report memory r;
        try this.decodeReport(report) returns (T.Report memory decoded) {
            r = decoded;
        } catch {
            return _reject(reportId, T.REJECT_DECODE);
        }
        if (usedReports[reportId]) return _reject(reportId, T.REJECT_DUPLICATE);
        if (r.expiry < block.timestamp) return _reject(reportId, T.REJECT_EXPIRED);
        usedReports[reportId] = true;

        if (r.reportType == T.REPORT_VERDICT) {
            if (statusOf[r.vault] == T.STATUS_NONE) return _reject(reportId, T.REJECT_UNKNOWN_VAULT);
            (uint8 reject, address dest) =
                IVault(r.vault).applyVerdict(r.requestId, r.requestHash, r.verdict, r.reasonCodes);
            if (reject != 0) return _reject(reportId, reject);
            if (r.verdict == T.VERDICT_FLAG) {
                emit Flagged(r.vault, r.requestId, r.reasonCodes, dest);
                _freeze(r.vault, r.reasonCodes);
                try registry.addToBlocklist(dest, r.vault) {} catch {}
            }
        } else if (r.reportType == T.REPORT_MARKET_MODE) {
            if (r.verdict > T.MODE_DEGRADED) return _reject(reportId, T.REJECT_BAD_VERDICT);
            address asset = address(uint160(r.requestId));
            marketMode[asset] = r.verdict;
            emit MarketModeSet(asset, r.verdict);
        } else if (r.reportType == T.REPORT_HEARTBEAT) {
            lastHeartbeat = block.timestamp;
            emit Heartbeat(block.timestamp, r.nonce);
        } else if (r.reportType == T.REPORT_DELEGATION_FLAG || r.reportType == T.REPORT_RESERVE_FLAG) {
            if (statusOf[r.vault] == T.STATUS_NONE) return _reject(reportId, T.REJECT_UNKNOWN_VAULT);
            emit Flagged(r.vault, 0, r.reasonCodes, address(0));
            _freeze(r.vault, r.reasonCodes);
        } else {
            return _reject(reportId, T.REJECT_BAD_TYPE);
        }
        emit ReportAccepted(reportId, r.reportType, r.vault, r.requestId);
    }

    function _workflowOk(bytes calldata metadata) internal view returns (bool) {
        if (metadata.length < 62) return false;
        bytes32 id = bytes32(metadata[0:32]);
        bytes10 name_ = bytes10(metadata[32:42]);
        address owner_ = address(bytes20(metadata[42:62]));
        return id == workflowId && owner_ == workflowOwner && name_ == workflowName;
    }

    function _reject(bytes32 reportId, uint8 reason) internal {
        emit ReportRejected(reportId, reason);
    }

    function _freeze(address vault, uint256 reasonCodes) internal {
        if (statusOf[vault] != T.STATUS_ACTIVE) return; // Frozen stays Frozen; Migrated/Revoked are terminal
        _setStatus(vault, T.STATUS_FROZEN, "frozen");
        emit Frozen(vault, reasonCodes);
    }

    function _setStatus(address vault, uint8 status, string memory text) internal {
        statusOf[vault] = status;
        emit StatusChanged(vault, status);
        try resolver.setText(dnsNameOf[vault], "status", text) {}
        catch {
            emit EnsWriteFailed(vault, text);
        }
    }
}

interface VaultLike {
    struct Req {
        address asset;
        address destination;
        address requester;
        uint128 amount;
        uint128 usdValue;
        uint64 createdAt;
        uint64 executableAt;
        uint8 state;
        bool asWeth;
        bool secondFactor;
        bool recoveryApproved;
        uint256 reasonCodes;
        bytes32 requestHash;
    }

    function openRequestIds() external view returns (uint256[] memory);
    function getRequest(uint256 id) external view returns (Req memory);
}
