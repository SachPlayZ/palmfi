// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {PalmTypes as T} from "./libraries/PalmTypes.sol";
import {IReceiver, IVault} from "./interfaces/IPalm.sol";

/// The single network contract every Vault reports its events through and every CRE report arrives through (v2).
/// - Event router for the Sentinel's log trigger (all Vault events carry the vault as an indexed topic).
/// - CRE receiver: reverts only on a wrong caller; every content problem is dropped as ReportRejected (ADR-0005).
/// - Source of truth for Vault status, the name directory (replaces ENS, ADR-0011) and the shared Blocklist.
contract Hub is IReceiver {
    // --- events (the Sentinel/Reconciler/app ABI) ---
    event VaultRegistered(address indexed vault, string name, address token);
    event NameVerified(address indexed vault, string name, bool verified);
    event RequestQueued(
        address indexed vault,
        uint256 indexed requestId,
        bytes32 requestHash,
        uint8 kind,
        address wallet,
        uint256 amount,
        address destination,
        uint256 reasonCodes
    );
    event RequestUpdated(
        address indexed vault,
        uint256 indexed requestId,
        uint8 state,
        uint64 executableAt,
        uint32 score,
        uint256 reasonCodes
    );
    event Voted(
        address indexed vault, uint256 indexed requestId, address voter, bool yes, uint16 yesVotes, uint16 noVotes
    );
    event ConfigChange(
        address indexed vault, uint256 indexed changeId, uint8 kind, bytes data, uint16 yesVotes, uint64 eta
    );
    event Outflow(address indexed vault, address wallet, address destination, uint256 amount, bool viaPool);
    event Flagged(address indexed vault, uint256 indexed requestId, uint256 reasonCodes, address destination);
    event Frozen(address indexed vault, address by, uint256 reasonCodes);
    event Unfrozen(address indexed vault);
    event Migrated(address indexed vault, address recoveryVault);
    event StatusChanged(address indexed vault, uint8 status);
    event Blocked(address indexed account, address indexed sourceVault, uint64 until);
    event Heartbeat(uint256 timestamp, uint256 nonce);
    event ReportAccepted(bytes32 indexed reportId, uint8 reportType, address indexed vault, uint256 requestId);
    event ReportRejected(bytes32 indexed reportId, uint8 reason);
    event WorkflowPinned(bytes32 workflowId, address workflowOwner, bytes10 workflowName, address forwarder);
    event WorkflowRotationProposed(bytes32 workflowId, address workflowOwner, bytes10 workflowName, uint64 eta);

    error NotForwarder();
    error NotVault();
    error NotAdmin();
    error NotFactory();
    error AlreadySet();
    error BadTransition();
    error NameTaken();
    error BadName();
    error TimelockActive();

    uint256 public constant ROTATION_TIMELOCK = 48 hours;
    uint64 public constant BLOCK_TTL = 30 days;

    address public immutable admin;
    address public forwarder;
    address public factory;

    // Pinned CRE workflow identity (checked once pinned; the simulation forwarder carries no metadata).
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
    mapping(bytes32 => address) internal _vaultByName;
    mapping(address => string) public nameOf;
    /// Set by the admin after business verification. No power over any Vault's funds or settings.
    mapping(address => bool) public verified;
    mapping(address => uint64) public blockedUntil;
    mapping(bytes32 => bool) public usedReports;
    address[] internal _vaults;
    uint256 public lastHeartbeat;
    /// A heartbeat older than this means CRE is down: Vaults reopen the direct instant lane as a fallback.
    uint256 public constant HEARTBEAT_STALE = 10 minutes;

    constructor(address admin_, address forwarder_) {
        admin = admin_;
        forwarder = forwarder_;
    }

    function setFactory(address factory_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (factory != address(0)) revert AlreadySet();
        factory = factory_;
    }

    // ------------------------------------------------------------------
    // Name directory (first come; verified badge by the admin)
    // ------------------------------------------------------------------

    function registerVault(address vault, string calldata name, address token) external {
        if (msg.sender != factory) revert NotFactory();
        bytes32 key = _key(name);
        if (_vaultByName[key] != address(0)) revert NameTaken();
        _vaultByName[key] = vault;
        nameOf[vault] = name;
        statusOf[vault] = T.STATUS_ACTIVE;
        _vaults.push(vault);
        emit VaultRegistered(vault, name, token);
        emit StatusChanged(vault, T.STATUS_ACTIVE);
    }

    function resolve(string calldata name) external view returns (address) {
        return _vaultByName[_key(name)];
    }

    function setVerified(address vault, bool v) external {
        if (msg.sender != admin) revert NotAdmin();
        if (statusOf[vault] == T.STATUS_NONE) revert NotVault();
        verified[vault] = v;
        emit NameVerified(vault, nameOf[vault], v);
    }

    /// Admin revocation (fraud, impersonation): the name stops resolving and the Vault's outflows stop.
    /// Funds stay; the Vault's own majority or Recovery key can still migrate them to its Recovery vault.
    function revoke(address vault) external {
        if (msg.sender != admin) revert NotAdmin();
        if (statusOf[vault] == T.STATUS_NONE) revert NotVault();
        delete _vaultByName[_key(nameOf[vault])];
        _setStatus(vault, T.STATUS_REVOKED);
    }

    /// Lowercase a-z, 0-9 and '-', 1..32 chars.
    function _key(string memory name) internal pure returns (bytes32) {
        bytes memory b = bytes(name);
        if (b.length == 0 || b.length > 32) revert BadName();
        for (uint256 i; i < b.length; i++) {
            bytes1 c = b[i];
            if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x2d)) revert BadName();
        }
        return keccak256(b);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function isVault(address vault) public view returns (bool) {
        return statusOf[vault] != T.STATUS_NONE;
    }

    /// CRE is live while its Reconciler heartbeat is fresh. Live: every outflow is a scored request (small ones
    /// clear at zero delay). Silent: the direct instant lane reopens, bounded by the Instant budget as before.
    function creLive() external view returns (bool) {
        return lastHeartbeat != 0 && block.timestamp <= lastHeartbeat + HEARTBEAT_STALE;
    }

    function isBlocked(address account) external view returns (bool) {
        return blockedUntil[account] > block.timestamp;
    }

    function vaultCount() external view returns (uint256) {
        return _vaults.length;
    }

    function getVaults(uint256 offset, uint256 limit) public view returns (address[] memory out) {
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
        uint256 amount;
        uint8 state;
        bool scored;
        bool fastTracked;
        uint64 executableAt;
        bytes32 requestHash;
    }

    /// Batched view for the Reconciler: every open request across a page of Vaults.
    function openRequests(uint256 offset, uint256 limit) external view returns (OpenRequest[] memory out) {
        address[] memory vs = getVaults(offset, limit);
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
                out[k++] = OpenRequest(
                    vs[i], ids[i][j], r.amount, r.state, r.scored, r.fastTracked, r.executableAt, r.requestHash
                );
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

    function emitRequestQueued(
        uint256 requestId,
        bytes32 requestHash,
        uint8 kind,
        address wallet,
        uint256 amount,
        address destination,
        uint256 reasonCodes
    ) external onlyVault {
        emit RequestQueued(msg.sender, requestId, requestHash, kind, wallet, amount, destination, reasonCodes);
    }

    function emitRequestUpdated(uint256 requestId, uint8 state, uint64 executableAt, uint32 score, uint256 reasonCodes)
        external
        onlyVault
    {
        emit RequestUpdated(msg.sender, requestId, state, executableAt, score, reasonCodes);
    }

    function emitVoted(uint256 requestId, address voter, bool yes, uint16 yesVotes, uint16 noVotes) external onlyVault {
        emit Voted(msg.sender, requestId, voter, yes, yesVotes, noVotes);
    }

    function emitConfigChange(uint256 changeId, uint8 kind, bytes calldata data, uint16 yesVotes, uint64 eta)
        external
        onlyVault
    {
        emit ConfigChange(msg.sender, changeId, kind, data, yesVotes, eta);
    }

    function emitOutflow(address wallet, address destination, uint256 amount, bool viaPool) external onlyVault {
        emit Outflow(msg.sender, wallet, destination, amount, viaPool);
    }

    /// Any one wallet of the Vault can freeze it (the Vault checked the wallet).
    function vaultFreeze(address by) external onlyVault {
        if (statusOf[msg.sender] != T.STATUS_ACTIVE) return;
        _setStatus(msg.sender, T.STATUS_FROZEN);
        emit Frozen(msg.sender, by, 0);
    }

    /// Majority or Recovery-key unfreeze (the Vault already checked which).
    function vaultUnfreeze() external onlyVault {
        if (statusOf[msg.sender] != T.STATUS_FROZEN) revert BadTransition();
        _setStatus(msg.sender, T.STATUS_ACTIVE);
        emit Unfrozen(msg.sender);
    }

    function vaultMigrated(address recoveryVault) external onlyVault {
        _setStatus(msg.sender, T.STATUS_MIGRATED);
        emit Migrated(msg.sender, recoveryVault);
    }

    // ------------------------------------------------------------------
    // Admin: Blocklist corrections and CRE workflow identity
    // ------------------------------------------------------------------

    function unblock(address account) external {
        if (msg.sender != admin) revert NotAdmin();
        blockedUntil[account] = 0;
    }

    function proposeWorkflowRotation(bytes32 id, address owner_, bytes10 name_) external {
        if (msg.sender != admin) revert NotAdmin();
        uint64 eta = uint64(block.timestamp + ROTATION_TIMELOCK);
        pendingRotation = Rotation(id, owner_, name_, eta);
        emit WorkflowRotationProposed(id, owner_, name_, eta);
    }

    function applyWorkflowRotation() external {
        if (msg.sender != admin) revert NotAdmin();
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

        if (r.reportType == T.REPORT_SET_DELAY) {
            if (statusOf[r.vault] == T.STATUS_NONE) return _reject(reportId, T.REJECT_UNKNOWN_VAULT);
            uint8 reject = IVault(r.vault).applyDelay(r.requestId, r.requestHash, r.delay, r.score, r.reasonCodes);
            if (reject != 0) return _reject(reportId, reject);
        } else if (r.reportType == T.REPORT_FLAG) {
            if (statusOf[r.vault] == T.STATUS_NONE) return _reject(reportId, T.REJECT_UNKNOWN_VAULT);
            (uint8 reject, address dest) = IVault(r.vault).applyFlag(r.requestId, r.requestHash, r.score, r.reasonCodes);
            if (reject != 0) return _reject(reportId, reject);
            emit Flagged(r.vault, r.requestId, r.reasonCodes, dest);
            _freeze(r.vault, r.reasonCodes);
            // Network-wide block only on a verified Vault's FLAG, so a throwaway org can't blocklist anyone.
            if (dest != address(0) && statusOf[dest] == T.STATUS_NONE && verified[r.vault]) {
                uint64 until = uint64(block.timestamp) + BLOCK_TTL;
                blockedUntil[dest] = until;
                emit Blocked(dest, r.vault, until);
            }
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
        _setStatus(vault, T.STATUS_FROZEN);
        emit Frozen(vault, address(this), reasonCodes);
    }

    function _setStatus(address vault, uint8 status) internal {
        statusOf[vault] = status;
        emit StatusChanged(vault, status);
    }
}

interface VaultLike {
    struct Req {
        address destination;
        address requester;
        uint128 amount;
        uint64 createdAt;
        uint64 executableAt;
        uint8 state;
        uint8 kind;
        bool fastTracked;
        bool scored;
        uint16 voterCount;
        uint16 yes;
        uint16 no;
        uint32 score;
        uint256 reasonCodes;
        bytes32 requestHash;
    }

    function openRequestIds() external view returns (uint256[] memory);
    function getRequest(uint256 id) external view returns (Req memory);
}
