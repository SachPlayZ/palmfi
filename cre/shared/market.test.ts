import { describe, expect, test } from "bun:test";
import { deviationBps, isStale, marketMode, poolPrice, rescale } from "./market";
import * as P from "./palm";

/** sqrtPriceX96 for a raw token1/token0 ratio num/den. */
const sqrtX96 = (num: bigint, den: bigint) => {
  const target = (num << 192n) / den;
  let x = 1n << 96n;
  for (let i = 0; i < 200; i++) x = (x + target / x) >> 1n;
  return x;
};

describe("poolPrice", () => {
  test("WETH priced in USDC when USDC is token0 (Sepolia ordering)", () => {
    // 3000 USDC (6dp) per 1 WETH (18dp): token1/token0 raw = 1e18 / 3000e6
    const s = sqrtX96(10n ** 18n, 3000n * 10n ** 6n);
    const p = poolPrice({ sqrtPriceX96: s, baseIsToken0: false, baseDecimals: 18, quoteDecimals: 6, outDecimals: 8 });
    expect(deviationBps(p, 3000_00000000n)).toBeLessThanOrEqual(1n);
  });
  test("base as token0", () => {
    // token0 = WETH, token1 = USDC: raw ratio 3000e6 / 1e18
    const s = sqrtX96(3000n * 10n ** 6n, 10n ** 18n);
    const p = poolPrice({ sqrtPriceX96: s, baseIsToken0: true, baseDecimals: 18, quoteDecimals: 6, outDecimals: 8 });
    expect(deviationBps(p, 3000_00000000n)).toBeLessThanOrEqual(1n);
  });
  test("uninitialised pool is 0", () => {
    expect(poolPrice({ sqrtPriceX96: 0n, baseIsToken0: true, baseDecimals: 18, quoteDecimals: 6, outDecimals: 8 })).toBe(0n);
  });
});

describe("helpers", () => {
  test("deviationBps", () => {
    expect(deviationBps(103n, 100n)).toBe(300n);
    expect(deviationBps(97n, 100n)).toBe(300n);
    expect(deviationBps(1n, 0n)).toBe(10_000n);
  });
  test("rescale", () => {
    expect(rescale(1_00000000n, 8, 6)).toBe(1_000000n);
    expect(rescale(1_000000n, 6, 8)).toBe(1_00000000n);
  });
  test("isStale uses the feed's own heartbeat + 1h (Vault.valueUsd)", () => {
    const f = { answer: 1n, updatedAt: 1000n, decimals: 8 };
    expect(isStale(f, 3600n, 1000n + 7200n)).toBe(false);
    expect(isStale(f, 3600n, 1000n + 7201n)).toBe(true);
    expect(isStale({ ...f, answer: 0n }, 3600n, 1000n)).toBe(true);
  });
});

describe("marketMode", () => {
  const base = {
    feed: { answer: 3000_00000000n, updatedAt: 10_000n, decimals: 8 },
    heartbeat: 3600n,
    now: 10_100n,
    volatileMoveBps: 1000n,
  };
  test("Normal", () => {
    expect(marketMode({ ...base, prevAnswer: 2990_00000000n, chainlinkInQuote: 3000n, pool: 3010n })!.mode).toBe(P.MODE_NORMAL);
  });
  test("stale feed → Degraded (ORACLE_STALE)", () => {
    expect(marketMode({ ...base, now: 10_000n + 7201n })).toEqual({ mode: P.MODE_DEGRADED, reasonCodes: P.ORACLE_STALE });
  });
  test("pool deviates > 3% → Degraded (PRICE_DEVIATION)", () => {
    const d = marketMode({ ...base, chainlinkInQuote: 3000n, pool: 3100n })!;
    expect(d.mode).toBe(P.MODE_DEGRADED);
    expect(d.reasonCodes).toBe(P.PRICE_DEVIATION);
  });
  test("exactly 3% is not over the threshold", () => {
    expect(marketMode({ ...base, chainlinkInQuote: 3000n, pool: 3090n })!.mode).toBe(P.MODE_NORMAL);
  });
  test("ETH −15% round over round → Volatile (demo scene 4)", () => {
    expect(marketMode({ ...base, prevAnswer: 3530_00000000n })!.mode).toBe(P.MODE_VOLATILE);
  });
  test("missing feed → no decision", () => {
    expect(marketMode({ ...base, feed: undefined })).toBeUndefined();
  });
});
