/**
 * Mirror of contracts/src/libraries/PalmTypes.sol (append-only ABI values) plus display helpers.
 * Wording follows GLOSSARY.md.
 */

export const STATUS = { NONE: 0, ACTIVE: 1, FROZEN: 2, MIGRATED: 3, REVOKED: 4 } as const;
export const STATUS_LABEL: Record<number, string> = {
  0: "unknown",
  1: "active",
  2: "frozen",
  3: "migrated",
  4: "revoked",
};

export const REQ = {
  NONE: 0,
  PENDING: 1,
  CLEARED: 2,
  HELD: 3,
  FLAGGED: 4,
  EXECUTED: 5,
  CANCELLED: 6,
  EXPIRED: 7,
} as const;
export const REQ_LABEL: Record<number, string> = {
  0: "None",
  1: "Pending",
  2: "Cleared",
  3: "Held",
  4: "Flagged",
  5: "Executed",
  6: "Cancelled",
  7: "Expired",
};

export const VERDICT_LABEL: Record<number, string> = { 0: "none", 1: "CLEAR", 2: "HOLD", 3: "FLAG" };
export const MODE_LABEL: Record<number, string> = { 0: "Normal", 1: "Volatile", 2: "Degraded" };

/** Reason codes bitmap, bit index → [code, human explanation]. */
export const REASON_CODES: ReadonlyArray<readonly [number, string, string]> = [
  [0, "NEW_DESTINATION", "Destination is not on the Vault's allowlist"],
  [1, "OVER_BUDGET", "Amount is above the remaining Instant budget"],
  [2, "BLOCKLISTED_DEST", "Destination is on the network Blocklist"],
  [3, "VELOCITY_1H", "Unusual spending velocity in the last hour"],
  [4, "VELOCITY_24H", "Unusual spending velocity in the last 24h"],
  [5, "VELOCITY_7D", "Unusual spending velocity in the last 7 days"],
  [6, "OFF_HOURS", "Outside the Institution's business hours"],
  [7, "NO_APPROVED_PAYOUT", "No matching Payout approval from the Approver"],
  [8, "DELEGATION_CHANGED", "A Hot wallet's EIP-7702 delegation changed to an unknown target"],
  [9, "CONFIG_CHANGE_PENDING", "A sensitive settings change is pending"],
  [10, "RESERVE_MISMATCH", "Reserves don't cover Protected token supply"],
  [11, "ORACLE_STALE", "Chainlink price is stale or the asset is Degraded"],
  [12, "PRICE_DEVIATION", "Price deviates from the reference"],
  [13, "API_UNAVAILABLE", "A data source was unavailable"],
];

export function decodeReasonCodes(bitmap: bigint | number): { code: string; description: string; bit: number }[] {
  const b = BigInt(bitmap);
  return REASON_CODES.filter(([bit]) => (b >> BigInt(bit)) & 1n).map(([bit, code, description]) => ({
    bit,
    code,
    description,
  }));
}

export const CHANGE = {
  BUDGET: 1,
  LIMITS: 2,
  ADD_DESTINATION: 3,
  ADD_HOT_WALLET: 4,
  ADD_DELEGATE: 5,
  GUARDIAN: 6,
  RECOVERY_KEY: 7,
  RECOVERY_VAULT: 8,
  APPROVER: 9,
  PASSKEY: 10,
} as const;
export const CHANGE_LABEL: Record<number, string> = {
  1: "Raise Instant budget",
  2: "Change Hard cap / Floor / full delay",
  3: "Add destination",
  4: "Add Hot wallet",
  5: "Add approved delegate",
  6: "Change Guardian",
  7: "Change Recovery key",
  8: "Change Recovery vault",
  9: "Change Approver",
  10: "Change passkey",
};

export const BOND_WEI = 1_000_000_000_000_000n; // 0.001 ETH
export const ONBOARDING_FEE_WEI = 1_000_000_000_000_000n;
export const REQUEST_TTL = 7 * 24 * 3600;
export const FAIL_OPEN_DELAY = 72 * 3600;

/** USD values on-chain use 6 decimals. */
export const USD_DECIMALS = 6;

export function formatUsd(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 1_000_000n;
  const cents = (a % 1_000_000n) / 10_000n;
  return `${neg ? "-" : ""}$${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

export function parseUsd(s: string): bigint {
  const [w, f = ""] = s.trim().replace(/^\$/, "").split(".");
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

/** Demo defaults (brief: Alice $5/24h, $20/7d, $50 Hard cap). */
export const DEMO_DEFAULTS = {
  budget24h: "5",
  budget7d: "20",
  hardCap: "50",
  floorMinutes: "5",
  fullDelayHours: "24",
};

/** ENS label rules we accept in the app (lowercase a-z0-9-, 1..63). */
export function isValidLabel(label: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}

/** "alice", "alice.palmfi.eth" → "alice" (when under parent); otherwise null. */
export function labelFromName(input: string, parent: string): string | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (s.endsWith(`.${parent}`)) {
    const l = s.slice(0, -parent.length - 1);
    return isValidLabel(l) ? l : null;
  }
  return isValidLabel(s) ? s : null;
}

/** Parse the ENS `tokens` record: `pUSDC:0x…,pWETH:0x…`. */
export function parseTokensRecord(rec: string | null | undefined): { symbol: string; address: string }[] {
  if (!rec) return [];
  return rec
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [symbol, address] = p.split(":");
      return { symbol: symbol ?? "", address: address ?? "" };
    })
    .filter((t) => t.symbol && /^0x[0-9a-fA-F]{40}$/.test(t.address));
}

/** DNS wire-format name (\x05alice\x06palmfi\x03eth\x00) → "alice.palmfi.eth". */
export function decodeDnsName(hex: string): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  const parts: string[] = [];
  for (let i = 0; i < b.length && b[i] !== 0; i += b[i] + 1) parts.push(new TextDecoder().decode(b.subarray(i + 1, i + 1 + b[i])));
  return parts.join(".");
}
