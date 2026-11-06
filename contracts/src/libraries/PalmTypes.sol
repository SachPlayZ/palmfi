// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// Shared constants and structs for palmfi v2 (Arc, USDC-only, intra-org votes, deviation-scored delays).
library PalmTypes {
    // --- Vault status (held by the Hub) ---
    uint8 internal constant STATUS_NONE = 0;
    uint8 internal constant STATUS_ACTIVE = 1;
    uint8 internal constant STATUS_FROZEN = 2;
    uint8 internal constant STATUS_MIGRATED = 3;
    uint8 internal constant STATUS_REVOKED = 4;

    // --- Queued request states ---
    uint8 internal constant REQ_NONE = 0;
    uint8 internal constant REQ_PENDING = 1;
    uint8 internal constant REQ_EXECUTED = 2;
    uint8 internal constant REQ_VETOED = 3;
    uint8 internal constant REQ_EXPIRED = 4;
    uint8 internal constant REQ_FLAGGED = 5;
    uint8 internal constant REQ_CANCELLED = 6;

    // --- Queued request kinds ---
    uint8 internal constant KIND_UNWRAP = 0; // USDC to an outside destination
    uint8 internal constant KIND_PAYMENT = 1; // USDC backing to another palmfi Vault (destination = payee Vault)

    // --- CRE report types ---
    uint8 internal constant REPORT_SET_DELAY = 0;
    uint8 internal constant REPORT_FLAG = 1;
    uint8 internal constant REPORT_HEARTBEAT = 2;
    uint8 internal constant REPORT_DELEGATION_FLAG = 3;
    uint8 internal constant REPORT_RESERVE_FLAG = 4;

    // --- Reason codes (bitmap, brief §7.2) ---
    uint256 internal constant UNUSUAL_AMOUNT = 1 << 0;
    uint256 internal constant NEW_DESTINATION = 1 << 1;
    uint256 internal constant OFF_HOURS = 1 << 2;
    uint256 internal constant VELOCITY = 1 << 3;
    uint256 internal constant CONFIG_CHANGE_PENDING = 1 << 4;
    uint256 internal constant NEW_WALLET = 1 << 5;
    uint256 internal constant BLOCKLISTED_DEST = 1 << 6;
    uint256 internal constant DELEGATION_CHANGED = 1 << 7;
    uint256 internal constant RESERVE_MISMATCH = 1 << 8;
    uint256 internal constant OVER_HARD_CAP = 1 << 9;
    uint256 internal constant CRE_SILENT = 1 << 10;

    // --- ReportRejected reasons (ADR-0005) ---
    uint8 internal constant REJECT_DECODE = 1;
    uint8 internal constant REJECT_WORKFLOW = 2;
    uint8 internal constant REJECT_DUPLICATE = 3;
    uint8 internal constant REJECT_EXPIRED = 4;
    uint8 internal constant REJECT_UNKNOWN_VAULT = 5;
    uint8 internal constant REJECT_UNKNOWN_REQUEST = 6;
    uint8 internal constant REJECT_HASH_MISMATCH = 7;
    uint8 internal constant REJECT_TERMINAL = 8; // request no longer pending (executed, vetoed, flagged, ...)
    uint8 internal constant REJECT_FAST_TRACKED = 9; // a majority already fast-tracked it; votes beat CRE
    uint8 internal constant REJECT_BAD_TYPE = 10;

    // --- Settings changes (majority vote; timelock per kind, ADR-0008) ---
    uint8 internal constant CHANGE_ADD_WALLET = 1; // 48h: (address)
    uint8 internal constant CHANGE_REMOVE_WALLET = 2; // now: (address)
    uint8 internal constant CHANGE_BUDGET = 3; // 48h: (uint128 budget24h, uint128 budget7d)
    uint8 internal constant CHANGE_LIMITS = 4; // 48h: (uint128 hardCap, uint32 floor, uint32 maxDelay, uint32 capDelay)
    uint8 internal constant CHANGE_ADD_DESTINATION = 5; // 48h: (address)
    uint8 internal constant CHANGE_ADD_DELEGATE = 6; // 48h: (address)
    uint8 internal constant CHANGE_RECOVERY_VAULT = 7; // 7d: (address)
    uint8 internal constant CHANGE_RECOVERY_KEY = 8; // 7d: (address)
    uint8 internal constant CHANGE_UNFREEZE = 9; // now: ()
    uint8 internal constant CHANGE_MIGRATE = 10; // now: () — only ever to the fixed Recovery vault

    /// One CRE report. Field meaning by type:
    /// SET_DELAY: vault, requestId, requestHash, delay (seconds), score (milli-bits), reasonCodes.
    /// FLAG: vault, requestId, requestHash, score, reasonCodes; freezes the Vault, blocklists the destination.
    /// HEARTBEAT: all but expiry/nonce ignored.
    /// DELEGATION_FLAG / RESERVE_FLAG: vault, reasonCodes; freezes the Vault.
    struct Report {
        uint8 reportType;
        address vault;
        uint256 requestId;
        bytes32 requestHash;
        uint64 delay;
        uint32 score;
        uint256 reasonCodes;
        uint64 expiry;
        uint256 nonce;
    }

    /// Onboarding config. `wallets` are the Vault's Voters (min 3, one vote each).
    struct VaultConfig {
        address[] wallets;
        address recoveryKey; // optional cold key: unfreeze or migrate only
        address recoveryVault; // fixed destination for migration
        uint128 budget24h; // USDC, 6dp
        uint128 budget7d;
        uint128 hardCap;
        uint32 floorDelay;
        uint32 maxDelay; // delay when CRE is silent
        uint32 capDelay; // minimum delay above the Hard cap unless fast-tracked
        address[] destinations; // known destinations (cold-start prior, ADR-0007)
        uint8 bizStartHourUtc;
        uint8 bizEndHourUtc;
        uint128 usualMaxPayout;
    }

    /// One executed outflow, kept in each Vault's onchain baseline ring buffer (ADR-0009).
    struct Outflow {
        address wallet;
        address destination;
        uint128 amount;
        uint64 timestamp;
    }

    function hashRequest(address vault, uint256 requestId, uint8 kind, uint256 amount, address destination)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, vault, requestId, kind, amount, destination));
    }
}
