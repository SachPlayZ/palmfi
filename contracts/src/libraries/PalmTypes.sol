// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// Shared vocabulary for Vault, Hub, CRE reports and the app. Values are part of the public ABI:
/// the CRE workflows (cre/shared/palm.ts) and the web app mirror them, so append only.
library PalmTypes {
    // --- Vault status (Hub is the source of truth, ENS mirrors it) ---
    uint8 internal constant STATUS_NONE = 0;
    uint8 internal constant STATUS_ACTIVE = 1;
    uint8 internal constant STATUS_FROZEN = 2;
    uint8 internal constant STATUS_MIGRATED = 3;
    uint8 internal constant STATUS_REVOKED = 4;

    // --- Queued request lifecycle ---
    uint8 internal constant REQ_NONE = 0;
    uint8 internal constant REQ_PENDING = 1;
    uint8 internal constant REQ_CLEARED = 2;
    uint8 internal constant REQ_HELD = 3;
    uint8 internal constant REQ_FLAGGED = 4;
    uint8 internal constant REQ_EXECUTED = 5;
    uint8 internal constant REQ_CANCELLED = 6;
    uint8 internal constant REQ_EXPIRED = 7;

    // --- Verdicts ---
    uint8 internal constant VERDICT_NONE = 0;
    uint8 internal constant VERDICT_CLEAR = 1;
    uint8 internal constant VERDICT_HOLD = 2;
    uint8 internal constant VERDICT_FLAG = 3;

    // --- Report types ---
    uint8 internal constant REPORT_VERDICT = 0;
    uint8 internal constant REPORT_MARKET_MODE = 1;
    uint8 internal constant REPORT_HEARTBEAT = 2;
    uint8 internal constant REPORT_DELEGATION_FLAG = 3;
    uint8 internal constant REPORT_RESERVE_FLAG = 4;

    // --- Market modes (per Underlying) ---
    uint8 internal constant MODE_NORMAL = 0;
    uint8 internal constant MODE_VOLATILE = 1;
    uint8 internal constant MODE_DEGRADED = 2;

    // --- Reason codes (bitmap) ---
    uint256 internal constant NEW_DESTINATION = 1 << 0;
    uint256 internal constant OVER_BUDGET = 1 << 1;
    uint256 internal constant BLOCKLISTED_DEST = 1 << 2;
    uint256 internal constant VELOCITY_1H = 1 << 3;
    uint256 internal constant VELOCITY_24H = 1 << 4;
    uint256 internal constant VELOCITY_7D = 1 << 5;
    uint256 internal constant OFF_HOURS = 1 << 6;
    uint256 internal constant NO_APPROVED_PAYOUT = 1 << 7;
    uint256 internal constant DELEGATION_CHANGED = 1 << 8;
    uint256 internal constant CONFIG_CHANGE_PENDING = 1 << 9;
    uint256 internal constant RESERVE_MISMATCH = 1 << 10;
    uint256 internal constant ORACLE_STALE = 1 << 11;
    uint256 internal constant PRICE_DEVIATION = 1 << 12;
    uint256 internal constant API_UNAVAILABLE = 1 << 13;

    // --- ReportRejected reasons (ADR-0005) ---
    uint8 internal constant REJECT_DECODE = 1;
    uint8 internal constant REJECT_WORKFLOW = 2;
    uint8 internal constant REJECT_DUPLICATE = 3;
    uint8 internal constant REJECT_EXPIRED = 4;
    uint8 internal constant REJECT_UNKNOWN_VAULT = 5;
    uint8 internal constant REJECT_UNKNOWN_REQUEST = 6;
    uint8 internal constant REJECT_HASH_MISMATCH = 7;
    uint8 internal constant REJECT_TERMINAL = 8; // e.g. a CLEAR after a FLAG
    uint8 internal constant REJECT_BAD_VERDICT = 9;
    uint8 internal constant REJECT_BAD_TYPE = 10;

    // --- Config change kinds (settings timelocks) ---
    uint8 internal constant CHANGE_BUDGET = 1; // 48h: (uint128 budget24h, uint128 budget7d)
    uint8 internal constant CHANGE_LIMITS = 2; // 48h: (uint128 hardCap, uint32 floorDelay, uint32 fullDelay)
    uint8 internal constant CHANGE_ADD_DESTINATION = 3; // 48h: (address)
    uint8 internal constant CHANGE_ADD_HOT_WALLET = 4; // 48h: (address)
    uint8 internal constant CHANGE_ADD_DELEGATE = 5; // 48h: (address)
    uint8 internal constant CHANGE_GUARDIAN = 6; // 7d: (address)
    uint8 internal constant CHANGE_RECOVERY_KEY = 7; // 7d: (address)
    uint8 internal constant CHANGE_RECOVERY_VAULT = 8; // 7d: (address)
    uint8 internal constant CHANGE_APPROVER = 9; // 7d: (address)
    uint8 internal constant CHANGE_PASSKEY = 10; // 7d: (bytes32 x, bytes32 y)

    /// One CRE report. Field meaning by type:
    /// VERDICT: vault, requestId, requestHash, verdict, reasonCodes.
    /// MARKET_MODE: requestId = uint160(asset), verdict = mode.
    /// HEARTBEAT: all but expiry/nonce ignored.
    /// DELEGATION_FLAG / RESERVE_FLAG: vault, reasonCodes; freezes the vault.
    struct Report {
        uint8 reportType;
        address vault;
        uint256 requestId;
        bytes32 requestHash;
        uint8 verdict;
        uint256 reasonCodes;
        uint64 expiry;
        uint256 nonce;
    }

    /// Onboarding config, chosen by the Owner (Individual) or the admin with the Institution (Institution).
    struct VaultConfig {
        address owner; // profile controller and, for Institutions, the voting Member key
        address[] hotWallets;
        address defaultReceiver; // Hot wallet that receives incoming Network transfers and hook wraps
        address guardian;
        address recoveryKey;
        address recoveryVault;
        address approver; // Institutions: Payout approval key (ADR-0002)
        bytes32 passkeyX; // Individuals: P-256 public key
        bytes32 passkeyY;
        uint128 budget24h; // USD, 6 decimals
        uint128 budget7d;
        uint128 hardCap;
        uint32 floorDelay;
        uint32 fullDelay;
        address[] destinations; // initial allowlist
        // Coarse Institution profile (ADR-0007)
        uint8 bizStartHourUtc;
        uint8 bizEndHourUtc;
        uint128 usualMaxPayout;
    }

    function hashRequest(address vault, uint256 requestId, address asset, uint256 amount, address destination)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, vault, requestId, asset, amount, destination));
    }
}
