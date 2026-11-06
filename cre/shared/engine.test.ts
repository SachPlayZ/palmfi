import { describe, expect, test } from "bun:test";
import { decide, utcHour, withinHours, type RequestFacts } from "./engine";
import * as P from "./palm";

// 2026-11-06 14:00:00 UTC and 02:00:00 UTC
const T_14H = 1793973600n;
const T_02H = 1793930400n;

/** An Individual's in-profile request: known destination, fresh data, under the Hard cap. */
const individual = (over: Partial<RequestFacts> = {}): RequestFacts => ({
  institution: false,
  usdValue: 30_000000n,
  hardCap: 50_000000n,
  secondFactor: false,
  requestCodes: P.OVER_BUDGET,
  isDestination: true,
  destinationBlocked: false,
  sensitivePending: 0n,
  delegationsOk: true,
  reservesOk: true,
  feedStale: false,
  marketMode: P.MODE_NORMAL,
  blockTimestamp: T_14H,
  bizStartHourUtc: 0,
  bizEndHourUtc: 0,
  usualMaxPayout: 0n,
  ...over,
});

/** An Institution's in-profile payroll: business hours 9-17 UTC, usual max $1000, approved. */
const institution = (over: Partial<RequestFacts> = {}): RequestFacts =>
  individual({
    institution: true,
    usdValue: 12_000000n,
    hardCap: 100_000000n,
    bizStartHourUtc: 9,
    bizEndHourUtc: 17,
    usualMaxPayout: 1000_000000n,
    payoutApproved: true,
    ...over,
  });

const has = (codes: bigint, bit: bigint) => (codes & bit) !== 0n;

describe("helpers", () => {
  test("utcHour reads the hour from a block timestamp", () => {
    expect(utcHour(T_14H)).toBe(14);
    expect(utcHour(T_02H)).toBe(2);
  });
  test("withinHours handles plain, wrapping and undeclared windows", () => {
    expect(withinHours(10, 9, 17)).toBe(true);
    expect(withinHours(17, 9, 17)).toBe(false);
    expect(withinHours(8, 9, 17)).toBe(false);
    expect(withinHours(23, 22, 6)).toBe(true);
    expect(withinHours(3, 22, 6)).toBe(true);
    expect(withinHours(12, 22, 6)).toBe(false);
    expect(withinHours(3, 0, 0)).toBe(true);
  });
});

describe("CLEAR", () => {
  test("an in-profile Individual request clears", () => {
    const d = decide(individual());
    expect(d.verdict).toBe(P.VERDICT_CLEAR);
    expect(d.missing).toEqual([]);
  });
  test("an approved, in-hours Institution payroll clears", () => {
    expect(decide(institution()).verdict).toBe(P.VERDICT_CLEAR);
  });
  test("an Institution request confirmed onchain clears without a book entry", () => {
    expect(decide(institution({ payoutApproved: false, secondFactor: true })).verdict).toBe(P.VERDICT_CLEAR);
  });
  test("deterministic: same facts, same decision", () => {
    expect(decide(individual({ isDestination: false }))).toEqual(decide(individual({ isDestination: false })));
  });
});

describe("FLAG rules", () => {
  test("Blocklisted destination (now)", () => {
    const d = decide(individual({ destinationBlocked: true }));
    expect(d.verdict).toBe(P.VERDICT_FLAG);
    expect(has(d.reasonCodes, P.BLOCKLISTED_DEST)).toBe(true);
  });
  test("Blocklisted destination (stamped by the Vault at request time)", () => {
    const d = decide(individual({ requestCodes: P.BLOCKLISTED_DEST }));
    expect(d.verdict).toBe(P.VERDICT_FLAG);
  });
  test("delegation changed to an unknown target", () => {
    const d = decide(individual({ delegationsOk: false }));
    expect(d.verdict).toBe(P.VERDICT_FLAG);
    expect(has(d.reasonCodes, P.DELEGATION_CHANGED)).toBe(true);
  });
  test("request while a sensitive settings change is pending", () => {
    const d = decide(individual({ sensitivePending: 1n }));
    expect(d.verdict).toBe(P.VERDICT_FLAG);
    expect(has(d.reasonCodes, P.CONFIG_CHANGE_PENDING)).toBe(true);
  });
  test("CONFIG_CHANGE_PENDING stamped at request time FLAGs even after the change is cancelled", () => {
    const d = decide(individual({ requestCodes: P.CONFIG_CHANGE_PENDING, sensitivePending: 0n }));
    expect(d.verdict).toBe(P.VERDICT_FLAG);
  });
  test("reserves below supply", () => {
    const d = decide(individual({ reservesOk: false }));
    expect(d.verdict).toBe(P.VERDICT_FLAG);
    expect(has(d.reasonCodes, P.RESERVE_MISMATCH)).toBe(true);
  });
  test("a Second factor never overrides a FLAG", () => {
    expect(decide(individual({ destinationBlocked: true, secondFactor: true })).verdict).toBe(P.VERDICT_FLAG);
  });
  test("a known FLAG wins even with missing facts", () => {
    const d = decide(individual({ destinationBlocked: true, feedStale: undefined }));
    expect(d.verdict).toBe(P.VERDICT_FLAG);
    expect(has(d.reasonCodes, P.API_UNAVAILABLE)).toBe(true);
  });
});

describe("HOLD rules (Individual)", () => {
  test("new destination", () => {
    const d = decide(individual({ isDestination: false }));
    expect(d.verdict).toBe(P.VERDICT_HOLD);
    expect(has(d.reasonCodes, P.NEW_DESTINATION)).toBe(true);
  });
  test("new destination + passkey Second factor → CLEAR (issue #7 re-score)", () => {
    const d = decide(individual({ isDestination: false, secondFactor: true }));
    expect(d.verdict).toBe(P.VERDICT_CLEAR);
    expect(has(d.reasonCodes, P.NEW_DESTINATION)).toBe(true); // still explained
  });
  test("over the Hard cap without a Second factor", () => {
    expect(decide(individual({ usdValue: 80_000000n })).verdict).toBe(P.VERDICT_HOLD);
  });
  test("over the Hard cap with a Second factor → CLEAR", () => {
    expect(decide(individual({ usdValue: 80_000000n, secondFactor: true })).verdict).toBe(P.VERDICT_CLEAR);
  });
  test("at the Hard cap exactly is not over it", () => {
    expect(decide(individual({ usdValue: 50_000000n })).verdict).toBe(P.VERDICT_CLEAR);
  });
  test("stale feed → ORACLE_STALE, even with a Second factor", () => {
    const d = decide(individual({ feedStale: true, marketMode: P.MODE_DEGRADED, secondFactor: true }));
    expect(d.verdict).toBe(P.VERDICT_HOLD);
    expect(has(d.reasonCodes, P.ORACLE_STALE)).toBe(true);
    expect(has(d.reasonCodes, P.PRICE_DEVIATION)).toBe(false);
  });
  test("Degraded mode with a fresh feed → PRICE_DEVIATION", () => {
    const d = decide(individual({ marketMode: P.MODE_DEGRADED }));
    expect(d.verdict).toBe(P.VERDICT_HOLD);
    expect(has(d.reasonCodes, P.PRICE_DEVIATION)).toBe(true);
  });
  test("Volatile mode alone does not HOLD", () => {
    expect(decide(individual({ marketMode: P.MODE_VOLATILE })).verdict).toBe(P.VERDICT_CLEAR);
  });
  test("Individuals ignore the institution profile fields", () => {
    expect(decide(individual({ blockTimestamp: T_02H, bizStartHourUtc: 9, bizEndHourUtc: 17 })).verdict).toBe(
      P.VERDICT_CLEAR,
    );
  });
});

describe("missing data → HOLD (API_UNAVAILABLE), never CLEAR", () => {
  const keys: (keyof RequestFacts)[] = [
    "institution",
    "usdValue",
    "hardCap",
    "secondFactor",
    "isDestination",
    "destinationBlocked",
    "sensitivePending",
    "delegationsOk",
    "reservesOk",
    "feedStale",
    "marketMode",
  ];
  for (const k of keys) {
    test(`missing ${k}`, () => {
      const d = decide(individual({ [k]: undefined }));
      expect(d.verdict).toBe(P.VERDICT_HOLD);
      expect(has(d.reasonCodes, P.API_UNAVAILABLE)).toBe(true);
      expect(d.missing).toContain(k);
    });
  }
  test("a Second factor does not override missing data", () => {
    expect(decide(individual({ delegationsOk: undefined, secondFactor: true })).verdict).toBe(P.VERDICT_HOLD);
  });
  for (const k of ["blockTimestamp", "bizStartHourUtc", "bizEndHourUtc", "usualMaxPayout"] as const) {
    test(`Institution missing ${k}`, () => {
      const d = decide(institution({ [k]: undefined }));
      expect(d.verdict).toBe(P.VERDICT_HOLD);
      expect(d.missing).toContain(k);
    });
  }
  test("Institution with unknown approval status", () => {
    const d = decide(institution({ payoutApproved: undefined }));
    expect(d.verdict).toBe(P.VERDICT_HOLD);
    expect(d.missing).toContain("payoutApproved");
  });
});

describe("Institution rules (issues #13, #14)", () => {
  test("off-hours (real block time vs onchain business hours)", () => {
    const d = decide(institution({ blockTimestamp: T_02H, payoutApproved: false }));
    expect(d.verdict).toBe(P.VERDICT_HOLD);
    expect(has(d.reasonCodes, P.OFF_HOURS)).toBe(true);
  });
  test("over the usual maximum payout", () => {
    const d = decide(institution({ usdValue: 5000_000000n, payoutApproved: false }));
    expect(d.verdict).toBe(P.VERDICT_HOLD);
    expect(has(d.reasonCodes, P.VELOCITY_1H)).toBe(true);
  });
  test("usualMaxPayout 0 means undeclared", () => {
    const d = decide(institution({ usdValue: 5000_000000n, usualMaxPayout: 0n }));
    expect(has(d.reasonCodes, P.VELOCITY_1H)).toBe(false);
  });
  test("no matching Payout approval", () => {
    const d = decide(institution({ payoutApproved: false }));
    expect(d.verdict).toBe(P.VERDICT_HOLD);
    expect(has(d.reasonCodes, P.NO_APPROVED_PAYOUT)).toBe(true);
  });
  test("a Payout approval resolves off-hours and size HOLDs (codes still recorded)", () => {
    const d = decide(institution({ blockTimestamp: T_02H, usdValue: 5000_000000n }));
    expect(d.verdict).toBe(P.VERDICT_CLEAR);
    expect(has(d.reasonCodes, P.OFF_HOURS)).toBe(true);
  });
  test("Binance replay: off-hours + over usual + no approval + new destination → FLAG", () => {
    const d = decide(
      institution({ blockTimestamp: T_02H, usdValue: 9000_000000n, payoutApproved: false, isDestination: false }),
    );
    expect(d.verdict).toBe(P.VERDICT_FLAG);
    for (const bit of [P.OFF_HOURS, P.VELOCITY_1H, P.NO_APPROVED_PAYOUT, P.NEW_DESTINATION]) {
      expect(has(d.reasonCodes, bit)).toBe(true);
    }
  });
  test("three of the four Binance signals only HOLD", () => {
    const d = decide(institution({ blockTimestamp: T_02H, usdValue: 9000_000000n, payoutApproved: false }));
    expect(d.verdict).toBe(P.VERDICT_HOLD);
  });
});

describe("one test per reason code", () => {
  const cases: [P.ReasonName, Partial<RequestFacts>, boolean][] = [
    ["NEW_DESTINATION", { isDestination: false }, false],
    ["OVER_BUDGET", { requestCodes: P.OVER_BUDGET }, false],
    ["BLOCKLISTED_DEST", { destinationBlocked: true }, false],
    ["OFF_HOURS", { blockTimestamp: T_02H }, true],
    ["NO_APPROVED_PAYOUT", { payoutApproved: false }, true],
    ["VELOCITY_1H", { usdValue: 5000_000000n }, true],
    ["DELEGATION_CHANGED", { delegationsOk: false }, false],
    ["CONFIG_CHANGE_PENDING", { sensitivePending: 2n }, false],
    ["RESERVE_MISMATCH", { reservesOk: false }, false],
    ["ORACLE_STALE", { feedStale: true }, false],
    ["PRICE_DEVIATION", { marketMode: P.MODE_DEGRADED }, false],
    ["API_UNAVAILABLE", { hardCap: undefined }, false],
  ];
  for (const [name, over, inst] of cases) {
    test(name, () => {
      const d = decide(inst ? institution(over) : individual(over));
      expect(P.reasonNames(d.reasonCodes)).toContain(name);
    });
  }
  test("VELOCITY_24H and VELOCITY_7D are never set by the engine (no velocity history in v1)", () => {
    const d = decide(individual({ requestCodes: P.VELOCITY_24H | P.VELOCITY_7D }));
    expect(has(d.reasonCodes, P.VELOCITY_24H)).toBe(false);
    expect(has(d.reasonCodes, P.VELOCITY_7D)).toBe(false);
  });
  test("non-sticky request codes are recomputed, not copied", () => {
    // NEW_DESTINATION was set at request time, but the destination has since been allowlisted.
    const d = decide(individual({ requestCodes: P.NEW_DESTINATION | P.ORACLE_STALE }));
    expect(d.verdict).toBe(P.VERDICT_CLEAR);
    expect(d.reasonCodes).toBe(0n);
  });
});
