import { describe, expect, test } from "bun:test";
import { assess, log2Milli, mulExp2, type ScoringContext } from "./deviation";
import { BLOCKLISTED_DEST, NEW_DESTINATION, OFF_HOURS, OVER_HARD_CAP, UNUSUAL_AMOUNT, VELOCITY } from "./palm";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
const W = [a(1), a(2), a(3)];
const DEST = [a(100), a(101), a(102), a(103), a(104)];
const USD = (x: number) => BigInt(Math.round(x * 1e6));
const DAY = 86400n;
const T0 = 1_800_000_000n - (1_800_000_000n % DAY); // a UTC midnight
const at = (day: number, hour: number) => T0 + BigInt(day) * DAY + BigInt(hour) * 3600n;

/** 32 business-hours payments ($1k–$3k) to 5 regular payees over ~4 weeks. */
const payrollHistory = () =>
  Array.from({ length: 32 }, (_, i) => ({
    wallet: W[i % 3],
    destination: DEST[i % 5],
    amount: USD(1000 + ((i * 337) % 2000)),
    timestamp: at(i - 32, 9 + (i % 7)) - 0n,
  })).map((o, i) => ({ ...o, timestamp: at(Math.floor(i * 0.85) - 30, 9 + (i % 7)) }));

const ctx = (over: Partial<ScoringContext["request"]> = {}, rest: Partial<ScoringContext> = {}): ScoringContext => ({
  request: {
    destination: DEST[0],
    requester: W[0],
    amount: USD(2000),
    createdAt: at(0, 11),
    executableAt: 0n,
    state: 1,
    kind: 0,
    fastTracked: false,
    scored: false,
    voterCount: 3,
    yes: 0,
    no: 0,
    score: 0,
    reasonCodes: 0n,
    requestHash: `0x${"00".repeat(32)}`,
    ...over,
  },
  history: payrollHistory(),
  destinationCount: 6n,
  knownDestination: true,
  profile: {
    bizStartHourUtc: 9,
    bizEndHourUtc: 17,
    usualMaxPayout: USD(3000),
    hardCap: USD(50_000),
    floorDelay: 15 * 60,
    maxDelay: 72 * 3600,
    capDelay: 24 * 3600,
  },
  configChangePending: false,
  requesterAddedAt: at(-90, 0),
  requesterDelegation: a(0),
  walletCount: 3n,
  ...rest,
});

const hours = (s: bigint) => Number(s) / 3600;

describe("fixed point", () => {
  test("log2Milli", () => {
    expect(log2Milli(1n)).toBe(0n);
    expect(log2Milli(2n)).toBe(1000n);
    expect(log2Milli(1024n)).toBe(10000n);
    expect(Number(log2Milli(3n))).toBeCloseTo(1585, -1);
    expect(Number(log2Milli(10n ** 18n))).toBeCloseTo(59794, -1);
  });
  test("mulExp2", () => {
    expect(mulExp2(900n, 0n)).toBe(900n);
    expect(mulExp2(900n, 2000n)).toBe(3600n);
    expect(Number(mulExp2(1_000_000n, 500n))).toBeCloseTo(1_414_214, -4);
  });
});

describe("assess", () => {
  test("routine payroll: low score, near Floor", () => {
    const r = assess(ctx());
    expect(r.action).toBe("DELAY");
    expect(r.score).toBeLessThan(8000);
    expect(hours(r.delay)).toBeLessThan(2);
    expect(r.reasonCodes & (NEW_DESTINATION | UNUSUAL_AMOUNT | OFF_HOURS)).toBe(0n);
  });

  test("$3M at 3am to a new destination → FLAG", () => {
    const r = assess(ctx({ amount: USD(3_000_000), destination: a(666), createdAt: at(0, 3) }, { knownDestination: false, destinationCount: 0n }));
    expect(r.action).toBe("FLAG");
    expect(r.reasonCodes & (UNUSUAL_AMOUNT | NEW_DESTINATION | OFF_HOURS | OVER_HARD_CAP)).toBe(
      UNUSUAL_AMOUNT | NEW_DESTINATION | OFF_HOURS | OVER_HARD_CAP,
    );
  });

  test("odd $400k to a known payee in hours: long delay, at least CapDelay (over hard cap)", () => {
    const r = assess(ctx({ amount: USD(400_000) }));
    expect(r.action).toBe("DELAY");
    expect(hours(r.delay)).toBeGreaterThanOrEqual(24);
    expect(hours(r.delay)).toBeLessThanOrEqual(72);
    expect(r.reasonCodes & UNUSUAL_AMOUNT).toBe(UNUSUAL_AMOUNT);
  });

  test("delay is clamped to MaxDelay", () => {
    const r = assess(ctx({ amount: USD(40_000), destination: a(777), createdAt: at(0, 2) }, { knownDestination: false, destinationCount: 0n }), { k: 1000, sFlag: 1e9 });
    expect(r.delay).toBe(72n * 3600n);
  });

  test("burst of requests raises velocity", () => {
    const h = payrollHistory();
    const now = at(0, 11);
    const burst = [1, 2, 3, 4, 5].map((m) => ({ wallet: W[0], destination: DEST[1], amount: USD(1500), timestamp: now - BigInt(m) * 300n }));
    const r = assess(ctx({}, { history: [...h.slice(5), ...burst] }));
    expect(r.terms.velocity).toBeGreaterThan(4000);
    expect(r.reasonCodes & VELOCITY).toBe(VELOCITY);
  });

  test("blocklisted destination → FLAG regardless of score", () => {
    expect(assess(ctx({ reasonCodes: BLOCKLISTED_DEST })).action).toBe("FLAG");
  });

  test("cold start: profile seeds the baseline", () => {
    const ok = assess(ctx({ amount: USD(1500) }, { history: [] }));
    const big = assess(ctx({ amount: USD(30_000) }, { history: [] }));
    expect(ok.action).toBe("DELAY");
    expect(hours(ok.delay)).toBeLessThan(3);
    expect(big.score).toBeGreaterThan(ok.score + 3000); // 10× the threshold: log2(10) bits past it
  });

  test("no history and no profile → MaxDelay (unsure → slow)", () => {
    const c = ctx({}, { history: [] });
    c.profile = { ...c.profile, usualMaxPayout: 0n, hardCap: 0n };
    expect(assess(c).delay).toBe(72n * 3600n);
  });

  test("wallet scope catches a wallet that never pays this way", () => {
    // W[2] only ever paid DEST[4]; un-whitelisted DEST[0] is routine for the vault but new for this wallet
    const history = payrollHistory().map((o) => (o.wallet === W[2] ? { ...o, destination: DEST[4] } : o));
    const r = assess(ctx({ requester: W[2], destination: DEST[0] }, { history, knownDestination: false }));
    expect(r.scope).toBe("wallet");
    expect(r.score).toBeGreaterThan(assess(ctx({}, { history })).score);
  });

  test("new wallet and pending config change add fixed bits", () => {
    const base = assess(ctx());
    const r = assess(ctx({}, { requesterAddedAt: at(-1, 0), configChangePending: true }));
    expect(r.score - base.score).toBeGreaterThanOrEqual(8000);
  });

  test("deterministic: same inputs, same output; history order does not matter", () => {
    const c = ctx({ amount: USD(12_345) });
    const r1 = assess(c);
    const r2 = assess({ ...c, history: [...c.history].reverse() });
    expect(r2).toEqual(r1);
  });

  // ---------- every outflow scored: quiet lane + smurfing ----------

  test("within the onboarding threshold: zero amount surprise", () => {
    const r = assess(ctx({ amount: USD(3000) }));
    expect(r.terms.amount).toBe(0);
    expect(r.reasonCodes & UNUSUAL_AMOUNT).toBe(0n);
  });

  test("quiet small payment to a regular payee in hours → zero delay", () => {
    const r = assess(ctx({ amount: USD(200) }));
    expect(r.action).toBe("DELAY");
    expect(r.delay).toBe(0n);
  });

  test("small but surprising (new destination) still waits", () => {
    const r = assess(ctx({ amount: USD(200), destination: a(999) }, { knownDestination: false }));
    expect(r.reasonCodes & NEW_DESTINATION).toBe(NEW_DESTINATION);
    expect(r.delay).toBeGreaterThanOrEqual(15n * 60n);
  });

  test("past the threshold the amount surprise starts at ~0 and rises smoothly", () => {
    const s = [3100, 4500, 6000, 12_000, 24_000].map((x) => assess(ctx({ amount: USD(x) }, { history: [] })).terms.amount);
    expect(s[0]).toBeLessThan(100); // just past the threshold: barely surprising
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThan(s[i - 1]);
    expect(s[3] - s[2]).toBeCloseTo(1000, -2); // one bit per doubling (cold start)
  });

  test("smurfing: a burst of small transfers loses the quiet lane, then FLAGs", () => {
    const now = at(0, 11);
    const smurf = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ wallet: W[0], destination: DEST[1], amount: USD(50), timestamp: now - BigInt(i + 1) * 120n }));
    const h = payrollHistory();
    const few = assess(ctx({ amount: USD(50), destination: DEST[1] }, { history: [...h.slice(4), ...smurf(4)] }));
    expect(few.reasonCodes & VELOCITY).toBe(VELOCITY);
    expect(few.delay).toBeGreaterThan(0n);
    const many = assess(ctx({ amount: USD(50), destination: DEST[1] }, { history: [...h.slice(14), ...smurf(14)] }), { k: 2500, sFlag: 18000 });
    expect(many.action).toBe("FLAG");
  });

  test("pool swap requests carry no destination surprise (the hook isn't the payee)", () => {
    const r = assess(ctx({ amount: USD(200), kind: 2, destination: a(4242) }, { knownDestination: false }));
    expect(r.terms.dest).toBe(0);
    expect(r.reasonCodes & NEW_DESTINATION).toBe(0n);
  });
});

