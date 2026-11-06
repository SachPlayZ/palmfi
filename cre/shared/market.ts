/**
 * Market modes per Underlying (issue #19). Pure functions; the Reconciler feeds them chain reads.
 *   Degraded: the feed is stale (heartbeat + 1h, as Vault.valueUsd) or answers ≤ 0, or Chainlink and our
 *             v4 pool differ by more than DEVIATION_DEGRADED_BPS (3%).
 *   Volatile: the latest answer moved more than `volatileMoveBps` against the previous round.
 *   Normal:   otherwise.
 */
import { DEVIATION_DEGRADED_BPS, MODE_DEGRADED, MODE_NORMAL, MODE_VOLATILE, ORACLE_STALE, PRICE_DEVIATION, STALENESS_MARGIN } from "./palm";

export type FeedRound = { answer: bigint; updatedAt: bigint; decimals: number };

export const isStale = (f: FeedRound, heartbeat: bigint, now: bigint): boolean =>
  f.answer <= 0n || f.updatedAt + heartbeat + STALENESS_MARGIN < now;

const Q192 = 1n << 192n;

/**
 * Price of `base` in units of `quote`, scaled to 1e`outDecimals`, from a v4 pool's sqrtPriceX96.
 * In v4, price = token1/token0 in raw units = sqrtPriceX96² / 2¹⁹².
 */
export function poolPrice(opts: {
  sqrtPriceX96: bigint;
  baseIsToken0: boolean;
  baseDecimals: number;
  quoteDecimals: number;
  outDecimals: number;
}): bigint {
  const { sqrtPriceX96: s, baseIsToken0, baseDecimals, quoteDecimals, outDecimals } = opts;
  if (s === 0n) return 0n;
  const sq = s * s;
  const scale = 10n ** BigInt(outDecimals);
  if (baseIsToken0) {
    // quote_raw per base_raw = sq / Q192; per whole base: × 10^baseDec / 10^quoteDec
    return (sq * scale * 10n ** BigInt(baseDecimals)) / (Q192 * 10n ** BigInt(quoteDecimals));
  }
  // base is token1: base_raw per quote_raw = sq / Q192, invert
  return (Q192 * scale * 10n ** BigInt(baseDecimals)) / (sq * 10n ** BigInt(quoteDecimals));
}

/** |a − b| / b in basis points. */
export const deviationBps = (a: bigint, b: bigint): bigint => {
  if (b === 0n) return 10_000n;
  const d = a > b ? a - b : b - a;
  return (d * 10_000n) / b;
};

/** Scale a feed answer with `decimals` to `to` decimals. */
export const rescale = (v: bigint, from: number, to: number): bigint =>
  to >= from ? v * 10n ** BigInt(to - from) : v / 10n ** BigInt(from - to);

export type ModeInput = {
  feed?: FeedRound;
  heartbeat: bigint;
  now: bigint;
  /** Answer of the previous feed round, for the Volatile check. */
  prevAnswer?: bigint;
  volatileMoveBps: bigint;
  /** Chainlink price of the asset in the pool's quote token and the pool's own price (same decimals). */
  chainlinkInQuote?: bigint;
  pool?: bigint;
};

export type ModeDecision = { mode: number; reasonCodes: bigint; deviationBps?: bigint } | undefined;

/** undefined = not enough data to decide; the Reconciler then leaves the current mode alone. */
export function marketMode(m: ModeInput): ModeDecision {
  if (!m.feed) return undefined;
  if (isStale(m.feed, m.heartbeat, m.now)) return { mode: MODE_DEGRADED, reasonCodes: ORACLE_STALE };
  if (m.pool !== undefined && m.chainlinkInQuote !== undefined) {
    const dev = deviationBps(m.pool, m.chainlinkInQuote);
    if (dev > DEVIATION_DEGRADED_BPS) return { mode: MODE_DEGRADED, reasonCodes: PRICE_DEVIATION, deviationBps: dev };
  }
  if (m.prevAnswer !== undefined && m.prevAnswer > 0n && deviationBps(m.feed.answer, m.prevAnswer) > m.volatileMoveBps)
    return { mode: MODE_VOLATILE, reasonCodes: 0n };
  return { mode: MODE_NORMAL, reasonCodes: 0n };
}
