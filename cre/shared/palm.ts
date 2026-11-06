/**
 * Mirror of contracts/src/libraries/PalmTypes.sol (and the few Vault.sol constants the workflows need).
 * Every value here is part of the onchain ABI: change PalmTypes first, then this file, never the reverse.
 * palm.test.ts parses PalmTypes.sol and fails if the two drift.
 */

// --- Vault status ---
export const STATUS_NONE = 0;
export const STATUS_ACTIVE = 1;
export const STATUS_FROZEN = 2;
export const STATUS_MIGRATED = 3;
export const STATUS_REVOKED = 4;

// --- Queued request lifecycle ---
export const REQ_NONE = 0;
export const REQ_PENDING = 1;
export const REQ_CLEARED = 2;
export const REQ_HELD = 3;
export const REQ_FLAGGED = 4;
export const REQ_EXECUTED = 5;
export const REQ_CANCELLED = 6;
export const REQ_EXPIRED = 7;

// --- Verdicts ---
export const VERDICT_NONE = 0;
export const VERDICT_CLEAR = 1;
export const VERDICT_HOLD = 2;
export const VERDICT_FLAG = 3;
export type Verdict = typeof VERDICT_CLEAR | typeof VERDICT_HOLD | typeof VERDICT_FLAG;

// --- Report types ---
export const REPORT_VERDICT = 0;
export const REPORT_MARKET_MODE = 1;
export const REPORT_HEARTBEAT = 2;
export const REPORT_DELEGATION_FLAG = 3;
export const REPORT_RESERVE_FLAG = 4;

// --- Market modes ---
export const MODE_NORMAL = 0;
export const MODE_VOLATILE = 1;
export const MODE_DEGRADED = 2;

// --- Reason codes (bitmap) ---
export const NEW_DESTINATION = 1n << 0n;
export const OVER_BUDGET = 1n << 1n;
export const BLOCKLISTED_DEST = 1n << 2n;
export const VELOCITY_1H = 1n << 3n;
export const VELOCITY_24H = 1n << 4n;
export const VELOCITY_7D = 1n << 5n;
export const OFF_HOURS = 1n << 6n;
export const NO_APPROVED_PAYOUT = 1n << 7n;
export const DELEGATION_CHANGED = 1n << 8n;
export const CONFIG_CHANGE_PENDING = 1n << 9n;
export const RESERVE_MISMATCH = 1n << 10n;
export const ORACLE_STALE = 1n << 11n;
export const PRICE_DEVIATION = 1n << 12n;
export const API_UNAVAILABLE = 1n << 13n;

export const REASON_CODES = {
  NEW_DESTINATION,
  OVER_BUDGET,
  BLOCKLISTED_DEST,
  VELOCITY_1H,
  VELOCITY_24H,
  VELOCITY_7D,
  OFF_HOURS,
  NO_APPROVED_PAYOUT,
  DELEGATION_CHANGED,
  CONFIG_CHANGE_PENDING,
  RESERVE_MISMATCH,
  ORACLE_STALE,
  PRICE_DEVIATION,
  API_UNAVAILABLE,
} as const;
export type ReasonName = keyof typeof REASON_CODES;

/** Human-readable names of the bits set in a reason-code bitmap, in bit order. */
export const reasonNames = (codes: bigint): ReasonName[] => REASON_ORDER.filter((k) => (codes & REASON_CODES[k]) !== 0n);

/** Bit order, spelled out (no Object.keys: key order is a determinism hazard on the DON). */
const REASON_ORDER: ReasonName[] = [
  "NEW_DESTINATION",
  "OVER_BUDGET",
  "BLOCKLISTED_DEST",
  "VELOCITY_1H",
  "VELOCITY_24H",
  "VELOCITY_7D",
  "OFF_HOURS",
  "NO_APPROVED_PAYOUT",
  "DELEGATION_CHANGED",
  "CONFIG_CHANGE_PENDING",
  "RESERVE_MISMATCH",
  "ORACLE_STALE",
  "PRICE_DEVIATION",
  "API_UNAVAILABLE",
];

// --- ReportRejected reasons (ADR-0005) ---
export const REJECT_DECODE = 1;
export const REJECT_WORKFLOW = 2;
export const REJECT_DUPLICATE = 3;
export const REJECT_EXPIRED = 4;
export const REJECT_UNKNOWN_VAULT = 5;
export const REJECT_UNKNOWN_REQUEST = 6;
export const REJECT_HASH_MISMATCH = 7;
export const REJECT_TERMINAL = 8;
export const REJECT_BAD_VERDICT = 9;
export const REJECT_BAD_TYPE = 10;

// --- Config change kinds (settings timelocks) ---
export const CHANGE_BUDGET = 1;
export const CHANGE_LIMITS = 2;
export const CHANGE_ADD_DESTINATION = 3;
export const CHANGE_ADD_HOT_WALLET = 4;
export const CHANGE_ADD_DELEGATE = 5;
export const CHANGE_GUARDIAN = 6;
export const CHANGE_RECOVERY_KEY = 7;
export const CHANGE_RECOVERY_VAULT = 8;
export const CHANGE_APPROVER = 9;
export const CHANGE_PASSKEY = 10;

/** Kinds that bump Vault.sensitivePending (Vault.proposeChange: kind >= CHANGE_GUARDIAN). */
export const isSensitiveChange = (kind: number): boolean => kind >= CHANGE_GUARDIAN && kind <= CHANGE_PASSKEY;

// --- Vault.sol constants the workflows rely on ---
/** Vault.STALENESS_MARGIN: a feed is stale once updatedAt + heartbeat + 1h < block.timestamp. */
export const STALENESS_MARGIN = 3600n;

// --- Spec numbers that are not in PalmTypes (issue #1 "Market mode") ---
/** Chainlink-vs-pool deviation above which the Reconciler sets Degraded (3%). */
export const DEVIATION_DEGRADED_BPS = 300n;

/** One CRE report (PalmTypes.Report). Field meaning by reportType is documented there. */
export type Report = {
  reportType: number;
  vault: `0x${string}`;
  requestId: bigint;
  requestHash: `0x${string}`;
  verdict: number;
  reasonCodes: bigint;
  expiry: bigint;
  nonce: bigint;
};
