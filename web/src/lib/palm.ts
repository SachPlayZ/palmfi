/**
 * Mirror of contracts/src/libraries/PalmTypes.sol + VaultBase constants (v2: Arc, USDC-only, intra-org votes,
 * deviation delays) plus display helpers. Wording follows GLOSSARY.md.
 */

export const STATUS = { NONE: 0, ACTIVE: 1, FROZEN: 2, MIGRATED: 3, REVOKED: 4 } as const;
export const STATUS_LABEL: Record<number, string> = { 0: "unknown", 1: "active", 2: "frozen", 3: "migrated", 4: "revoked" };

export const REQ = { NONE: 0, PENDING: 1, EXECUTED: 2, VETOED: 3, EXPIRED: 4, FLAGGED: 5, CANCELLED: 6 } as const;
export const REQ_LABEL: Record<number, string> = {
  0: "None",
  1: "Pending",
  2: "Executed",
  3: "Vetoed",
  4: "Expired",
  5: "Flagged",
  6: "Cancelled",
};
export const KIND = { UNWRAP: 0, PAYMENT: 1 } as const;

/** Reason codes bitmap (brief §7.2), bit index → [code, human explanation]. */
export const REASON_CODES: ReadonlyArray<readonly [number, string, string]> = [
  [0, "UNUSUAL_AMOUNT", "Amount is far above this wallet's / Vault's usual outflows"],
  [1, "NEW_DESTINATION", "Never paid before and not a known destination"],
  [2, "OFF_HOURS", "Outside the Vault's business hours"],
  [3, "VELOCITY", "Unusually many outflows in the last hour / day"],
  [4, "CONFIG_CHANGE_PENDING", "A wallet add is pending (possible Sybil attempt)"],
  [5, "NEW_WALLET", "The requesting wallet was added less than 7 days ago"],
  [6, "BLOCKLISTED_DEST", "Destination is on the network Blocklist"],
  [7, "DELEGATION_CHANGED", "A wallet's EIP-7702 delegation points at an unapproved target"],
  [8, "RESERVE_MISMATCH", "USDC reserves don't cover the Protected token supply"],
  [9, "OVER_HARD_CAP", "Above the Hard cap: at least CapDelay unless a majority fast-tracks"],
  [10, "CRE_SILENT", "Not scored yet: MaxDelay applies until the Sentinel reports"],
];

export function decodeReasonCodes(bitmap: bigint | number): { code: string; description: string; bit: number }[] {
  const b = BigInt(bitmap);
  return REASON_CODES.filter(([bit]) => (b >> BigInt(bit)) & 1n).map(([bit, code, description]) => ({ bit, code, description }));
}

export const CHANGE = {
  ADD_WALLET: 1,
  REMOVE_WALLET: 2,
  BUDGET: 3,
  LIMITS: 4,
  ADD_DESTINATION: 5,
  ADD_DELEGATE: 6,
  RECOVERY_VAULT: 7,
  RECOVERY_KEY: 8,
  UNFREEZE: 9,
  MIGRATE: 10,
} as const;
export const CHANGE_LABEL: Record<number, string> = {
  1: "Add wallet",
  2: "Remove wallet",
  3: "Raise Instant budget",
  4: "Change Hard cap / delays",
  5: "Add destination",
  6: "Add approved delegate",
  7: "Change Recovery vault",
  8: "Change Recovery key",
  9: "Unfreeze",
  10: "Migrate to Recovery vault",
};
/** Timelock after a majority (seconds): removals, unfreeze and migrate apply at once and can't be cancelled by one wallet. */
export const CHANGE_TIMELOCK: Record<number, number> = { 1: 48 * 3600, 2: 0, 3: 48 * 3600, 4: 48 * 3600, 5: 48 * 3600, 6: 48 * 3600, 7: 7 * 86400, 8: 7 * 86400, 9: 0, 10: 0 };

export const BOND = 1_000_000n; // 1 USDC, escrowed as burned Protected tokens
export const REQUEST_TTL = 7 * 24 * 3600;
export const MIN_WALLETS = 3;
export const MAX_PENDING_PER_WALLET = 3;
export const USDC_DECIMALS = 6;

/** Veto: more than half of the Voters other than the requester say NO. */
export const vetoNeeded = (voterCount: number) => Math.floor((voterCount - 1) / 2) + 1;
/** Fast-track: more than half of all Voters say YES. */
export const fastTrackNeeded = (voterCount: number) => Math.floor(voterCount / 2) + 1;

export function formatUsd(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 1_000_000n;
  const cents = (a % 1_000_000n) / 10_000n;
  return `${neg ? "-" : ""}$${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

export function parseUsd(s: string): bigint {
  const [w, f = ""] = s.trim().replace(/^\$/, "").replace(/,/g, "").split(".");
  return BigInt(w || "0") * 1_000_000n + BigInt((f + "000000").slice(0, 6));
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Milli-bits → "12.3 bits". */
export const formatBits = (mb: number) => `${(mb / 1000).toFixed(1)} bits`;

/** Demo defaults (brief §6): small numbers so the demo runs on faucet USDC. */
export const DEMO_DEFAULTS = {
  budget24h: "5",
  budget7d: "20",
  hardCap: "50",
  floorMinutes: "1",
  maxDelayHours: "72",
  capDelayHours: "24",
  usualMaxPayout: "10",
};

/** Hub name rules: lowercase a-z, 0-9 and '-', 1..32 characters. */
export function isValidName(name: string): boolean {
  return /^[a-z0-9-]{1,32}$/.test(name);
}
