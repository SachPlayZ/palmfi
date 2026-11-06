/**
 * The Sentinel decision engine (brief §8.3, issue #1 "Decision engine").
 *
 * A pure, deterministic function from request facts to a Verdict plus a reason-code bitmap. It never reads
 * the clock, the network or randomness: every input arrives in `RequestFacts`, read by the workflow from
 * consensus-verified chain reads. A fact the workflow could not read is `undefined`, and a missing fact can
 * only ever produce HOLD (API_UNAVAILABLE), never CLEAR ("when unsure, HOLD", brief §8.1.2).
 *
 * Precedence: FLAG > HOLD > CLEAR. A FLAG condition that is known to be true wins even when other facts are
 * missing; a missing fact that could have produced a FLAG yields HOLD.
 */
import {
  API_UNAVAILABLE,
  BLOCKLISTED_DEST,
  CONFIG_CHANGE_PENDING,
  DELEGATION_CHANGED,
  MODE_DEGRADED,
  NEW_DESTINATION,
  NO_APPROVED_PAYOUT,
  OFF_HOURS,
  ORACLE_STALE,
  OVER_BUDGET,
  PRICE_DEVIATION,
  RESERVE_MISMATCH,
  VELOCITY_1H,
  VERDICT_CLEAR,
  VERDICT_FLAG,
  VERDICT_HOLD,
  type Verdict,
} from "./palm";

export type RequestFacts = {
  /** Owner type, Vault.institution(). */
  institution?: boolean;
  /** Request USD value (6 dp) as recorded by the Vault at request time. */
  usdValue?: bigint;
  /** Vault.hardCap() (6 dp). */
  hardCap?: bigint;
  /** Request.secondFactor: passkey (Individual) or Payout approval via confirm() (Institution), verified onchain. */
  secondFactor?: boolean;
  /**
   * Reason codes the Vault stamped at request time (Request.reasonCodes / UnwrapRequested.reasonCodes).
   * Only the sticky bits are taken from it: OVER_BUDGET, BLOCKLISTED_DEST, CONFIG_CHANGE_PENDING
   * (a request made while a sensitive change was pending is always FLAGged, issue #10).
   */
  requestCodes: bigint;
  /** Vault.isDestination(destination). */
  isDestination?: boolean;
  /** Hub.isBlocked(destination), i.e. on the network Blocklist now. */
  destinationBlocked?: boolean;
  /** Vault.sensitivePending(): Guardian / Recovery / Approver / passkey changes pending. */
  sensitivePending?: bigint;
  /** Every Hot wallet's EIP-7702 delegation is none or an approved delegate (Vault.delegations().ok). */
  delegationsOk?: boolean;
  /** Every Underlying's balance covers its Protected token supply (Vault.reserves()). */
  reservesOk?: boolean;
  /** The asset's Chainlink feed is stale per Vault.valueUsd (heartbeat + 1h). */
  feedStale?: boolean;
  /** Vault.marketModeOf(asset): the effective Market mode. */
  marketMode?: number;
  /** Timestamp (seconds) of the block being scored, from the block header. Never a node clock. */
  blockTimestamp?: bigint;
  /** Institution coarse profile (ADR-0007). */
  bizStartHourUtc?: number;
  bizEndHourUtc?: number;
  usualMaxPayout?: bigint;
  /** Institutions: a matching, unexpired ApprovalBook Payout approval signed by the Vault's Approver. */
  payoutApproved?: boolean;
};

export type Decision = {
  verdict: Verdict;
  reasonCodes: bigint;
  /** Names of the facts that were missing, for logs. */
  missing: string[];
};

/** UTC hour (0-23) of a unix timestamp. */
export const utcHour = (ts: bigint): number => Number((ts / 3600n) % 24n);

/**
 * Whether `hour` is inside [start, end). start == end means "no business hours declared" (always inside).
 * start > end wraps midnight, e.g. 22 → 6.
 */
export const withinHours = (hour: number, start: number, end: number): boolean => {
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
};

const STICKY = OVER_BUDGET | BLOCKLISTED_DEST | CONFIG_CHANGE_PENDING;

export function decide(f: RequestFacts): Decision {
  const missing: string[] = [];
  const need = <T>(name: string, v: T | undefined): v is T => {
    if (v === undefined) missing.push(name);
    return v !== undefined;
  };

  let codes = f.requestCodes & STICKY;
  let flag = (codes & (BLOCKLISTED_DEST | CONFIG_CHANGE_PENDING)) !== 0n;
  let dataProblem = false;
  let soft = false; // a HOLD reason that a Second factor can resolve

  // --- FLAG conditions ---
  if (need("destinationBlocked", f.destinationBlocked) && f.destinationBlocked) {
    codes |= BLOCKLISTED_DEST;
    flag = true;
  }
  if (need("delegationsOk", f.delegationsOk) && !f.delegationsOk) {
    codes |= DELEGATION_CHANGED;
    flag = true;
  }
  if (need("sensitivePending", f.sensitivePending) && f.sensitivePending > 0n) {
    codes |= CONFIG_CHANGE_PENDING;
    flag = true;
  }
  if (need("reservesOk", f.reservesOk) && !f.reservesOk) {
    codes |= RESERVE_MISMATCH;
    flag = true;
  }

  // --- data quality: always HOLD, a Second factor never overrides it ---
  if (need("feedStale", f.feedStale) && f.feedStale) {
    codes |= ORACLE_STALE;
    dataProblem = true;
  }
  if (need("marketMode", f.marketMode) && f.marketMode === MODE_DEGRADED && !f.feedStale) {
    codes |= PRICE_DEVIATION; // Degraded with a fresh feed = the Reconciler saw Chainlink-vs-pool deviation
    dataProblem = true;
  }

  // --- request facts ---
  const institution = need("institution", f.institution) ? f.institution : undefined;
  const confirmed = need("secondFactor", f.secondFactor) ? f.secondFactor : undefined;
  // Institutions: a Payout approval is the Second factor, whether confirmed onchain or posted to the book.
  const approved = institution === true ? confirmed === true || f.payoutApproved === true : confirmed === true;

  const isNewDest = need("isDestination", f.isDestination) ? !f.isDestination : undefined;
  if (isNewDest) {
    codes |= NEW_DESTINATION;
    soft = true;
  }

  if (need("usdValue", f.usdValue) && need("hardCap", f.hardCap) && f.usdValue > f.hardCap) {
    // No dedicated reason code for "over the Hard cap"; OVER_BUDGET is already set by the Vault for every
    // Queued request above the Instant budget. The Vault itself also enforces the full delay (applyVerdict).
    soft = true;
  }

  // --- Institution profile (ADR-0007) ---
  let offHours = false;
  let overUsual = false;
  let noApproval = false;
  if (institution === true) {
    if (
      need("blockTimestamp", f.blockTimestamp) &&
      need("bizStartHourUtc", f.bizStartHourUtc) &&
      need("bizEndHourUtc", f.bizEndHourUtc) &&
      !withinHours(utcHour(f.blockTimestamp), f.bizStartHourUtc, f.bizEndHourUtc)
    ) {
      offHours = true;
      codes |= OFF_HOURS;
      soft = true;
    }
    if (
      need("usualMaxPayout", f.usualMaxPayout) &&
      f.usdValue !== undefined &&
      f.usualMaxPayout > 0n &&
      f.usdValue > f.usualMaxPayout
    ) {
      // PalmTypes has no "over usual payout" bit; a single payout above the declared usual maximum is
      // reported as a 1h velocity spike.
      overUsual = true;
      codes |= VELOCITY_1H;
      soft = true;
    }
    if (!approved) {
      if (f.payoutApproved === undefined && confirmed !== true) missing.push("payoutApproved");
      else {
        noApproval = true;
        codes |= NO_APPROVED_PAYOUT;
        soft = true;
      }
    }
    // Binance-style compromise (issue #14): every signature valid, but off-hours, oversized, unapproved,
    // to a new destination. That combination freezes instead of waiting.
    if (offHours && overUsual && noApproval && isNewDest === true) flag = true;
  }

  if (missing.length > 0) {
    codes |= API_UNAVAILABLE;
    dataProblem = true;
  }

  let verdict: Verdict;
  if (flag) verdict = VERDICT_FLAG;
  else if (dataProblem) verdict = VERDICT_HOLD;
  else if (soft && !approved) verdict = VERDICT_HOLD;
  else verdict = VERDICT_CLEAR;

  return { verdict, reasonCodes: codes, missing };
}
