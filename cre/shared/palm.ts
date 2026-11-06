/**
 * Mirror of contracts/src/libraries/PalmTypes.sol (v2: Arc, USDC-only, intra-org votes, deviation delays).
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
export const REQ_EXECUTED = 2;
export const REQ_VETOED = 3;
export const REQ_EXPIRED = 4;
export const REQ_FLAGGED = 5;
export const REQ_CANCELLED = 6;

// --- Queued request kinds ---
export const KIND_UNWRAP = 0;
export const KIND_PAYMENT = 1;

// --- Report types ---
export const REPORT_SET_DELAY = 0;
export const REPORT_FLAG = 1;
export const REPORT_HEARTBEAT = 2;
export const REPORT_DELEGATION_FLAG = 3;
export const REPORT_RESERVE_FLAG = 4;

// --- Reason codes (bitmap, brief §7.2) ---
export const UNUSUAL_AMOUNT = 1n << 0n;
export const NEW_DESTINATION = 1n << 1n;
export const OFF_HOURS = 1n << 2n;
export const VELOCITY = 1n << 3n;
export const CONFIG_CHANGE_PENDING = 1n << 4n;
export const NEW_WALLET = 1n << 5n;
export const BLOCKLISTED_DEST = 1n << 6n;
export const DELEGATION_CHANGED = 1n << 7n;
export const RESERVE_MISMATCH = 1n << 8n;
export const OVER_HARD_CAP = 1n << 9n;
export const CRE_SILENT = 1n << 10n;

export const REASON_CODES = {
  UNUSUAL_AMOUNT,
  NEW_DESTINATION,
  OFF_HOURS,
  VELOCITY,
  CONFIG_CHANGE_PENDING,
  NEW_WALLET,
  BLOCKLISTED_DEST,
  DELEGATION_CHANGED,
  RESERVE_MISMATCH,
  OVER_HARD_CAP,
  CRE_SILENT,
} as const;
export type ReasonName = keyof typeof REASON_CODES;

/** Bit order, spelled out (no Object.keys: key order is a determinism hazard on the DON). */
const REASON_ORDER: ReasonName[] = [
  "UNUSUAL_AMOUNT",
  "NEW_DESTINATION",
  "OFF_HOURS",
  "VELOCITY",
  "CONFIG_CHANGE_PENDING",
  "NEW_WALLET",
  "BLOCKLISTED_DEST",
  "DELEGATION_CHANGED",
  "RESERVE_MISMATCH",
  "OVER_HARD_CAP",
  "CRE_SILENT",
];

/** Human-readable names of the bits set in a reason-code bitmap, in bit order. */
export const reasonNames = (codes: bigint): ReasonName[] => REASON_ORDER.filter((k) => (codes & REASON_CODES[k]) !== 0n);

// --- ReportRejected reasons (ADR-0005) ---
export const REJECT_DECODE = 1;
export const REJECT_WORKFLOW = 2;
export const REJECT_DUPLICATE = 3;
export const REJECT_EXPIRED = 4;
export const REJECT_UNKNOWN_VAULT = 5;
export const REJECT_UNKNOWN_REQUEST = 6;
export const REJECT_HASH_MISMATCH = 7;
export const REJECT_TERMINAL = 8;
export const REJECT_FAST_TRACKED = 9;
export const REJECT_BAD_TYPE = 10;

// --- Settings changes (majority vote, ADR-0008) ---
export const CHANGE_ADD_WALLET = 1;
export const CHANGE_REMOVE_WALLET = 2;
export const CHANGE_BUDGET = 3;
export const CHANGE_LIMITS = 4;
export const CHANGE_ADD_DESTINATION = 5;
export const CHANGE_ADD_DELEGATE = 6;
export const CHANGE_RECOVERY_VAULT = 7;
export const CHANGE_RECOVERY_KEY = 8;
export const CHANGE_UNFREEZE = 9;
export const CHANGE_MIGRATE = 10;

/** One CRE report (PalmTypes.Report). Field meaning by reportType is documented there. */
export type Report = {
  reportType: number;
  vault: `0x${string}`;
  requestId: bigint;
  requestHash: `0x${string}`;
  delay: bigint;
  score: number;
  reasonCodes: bigint;
  expiry: bigint;
  nonce: bigint;
};
