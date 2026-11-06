/**
 * brief §7.4 failure matrix: one test per row, driving the real Sentinel / Reconciler handlers against the
 * fake chain. Rows whose defence is onchain (Vault/Hub) assert the workflow's half; the onchain half is in the
 * Foundry fork tests (QueuedLane.t.sol, Changes.t.sol). The same rows exist as CLI fixtures in cre/fixtures.
 * Row 9 (>50% of wallets compromised) is the stated residual risk and has no test.
 */
import { describe, expect } from "bun:test";
import type { CronPayload } from "@chainlink/cre-sdk";
import { newTestRuntime, test } from "@chainlink/cre-sdk/test";
import { onCron, type Config as RConfig } from "../reconciler/main";
import { config as reconcilerConfig } from "../reconciler/testkit";
import { assess } from "../shared/deviation";
import * as P from "../shared/palm";
import { encodeReport } from "../shared/report";
import { ADDR, addVault, contextOf, fakeVault, installWorld, newWorld, payroll, request, type World } from "../shared/testing";
import { onHubLog, type Config } from "./main";
import { config, configLog, queuedLog } from "./testkit";

const sentinel = (w: World, log: Parameters<typeof onHubLog>[1]) => {
  installWorld(w);
  const rt = newTestRuntime<Config>();
  rt.config = config;
  return onHubLog(rt, log);
};

const cron = (w: World, slot = 1_793_973_600n, cfg: RConfig = reconcilerConfig) => {
  installWorld(w);
  const rt = newTestRuntime<RConfig>();
  rt.config = cfg;
  return JSON.parse(onCron(rt, { scheduledExecutionTime: { seconds: slot, nanos: 0 } } as unknown as CronPayload));
};

const USD = (x: number) => BigInt(x * 1e6);

describe("failure matrix (brief §7.4)", () => {
  test("1. CRE down → nothing written on missing data (request keeps the Vault's MaxDelay default)", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request());
    w.failing.add("*");
    expect(cron(w).requests).toEqual([]);
    expect(w.writes.filter((r) => r.reportType !== P.REPORT_HEARTBEAT)).toHaveLength(0);
  });

  test("2. missed log / dropped execution → the Reconciler scores it", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request());
    expect(cron(w).requests).toEqual([`${ADDR.alice}#1 DELAY WRITTEN`]);
  });

  test("3. replay / modified request → same inputs give the same report bytes; a changed hash is skipped", () => {
    const a = newWorld();
    addVault(a, ADDR.alice, fakeVault()).requests.set(1n, request());
    cron(a, 100n);
    const b = newWorld();
    addVault(b, ADDR.alice, fakeVault()).requests.set(1n, request());
    cron(b, 100n);
    expect(encodeReport(a.writes[0])).toBe(encodeReport(b.writes[0])); // identical reportId → REJECT_DUPLICATE
    const c = newWorld();
    const r = request();
    addVault(c, ADDR.alice, fakeVault()).requests.set(1n, { ...r, amount: r.amount * 100n, requestHash: `0x${"66".repeat(32)}` });
    expect(sentinel(c, queuedLog(ADDR.alice, r))).toContain("SKIP_HASH_MISMATCH");
  });

  test("4. compromised CRE → below Floor only in the quiet lane (≤ threshold); ≥ CapDelay over the Hard cap", () => {
    // The model's zero delay is only for a quiet request within the onboarding threshold; the Vault honours it
    // only within the Instant budget (Foundry CreLive.t.sol), so a compromised CRE releases no more than the budget.
    const v = fakeVault();
    const threshold = v.profile.usualMaxPayout;
    v.requests.set(1n, request({ amount: USD(1) }));
    v.requests.set(2n, request({ amount: USD(60_000), destination: ADDR.friend }));
    v.requests.set(3n, request({ amount: threshold + USD(1) }));
    expect(assess(contextOf(v, 1n)).delay).toBeGreaterThanOrEqual(0n);
    expect(assess(contextOf(v, 2n)).delay).toBeGreaterThanOrEqual(BigInt(v.profile.capDelay));
    expect(assess(contextOf(v, 3n)).delay).toBeGreaterThanOrEqual(BigInt(v.profile.floorDelay));
  });

  test("5. baseline poisoning → a few planted outliers don't move the robust (median/MAD) baseline", () => {
    const clean = fakeVault();
    clean.requests.set(1n, request({ amount: USD(40_000) }));
    const poisoned = fakeVault({
      history: [...payroll().slice(4), ...[1, 2, 3, 4].map((i) => ({ ...payroll()[0], amount: USD(40_000 + i) }))],
    });
    poisoned.requests.set(1n, request({ amount: USD(40_000) }));
    const a = assess(contextOf(clean, 1n));
    const b = assess(contextOf(poisoned, 1n));
    expect(b.terms.amount).toBeGreaterThan(a.terms.amount * 0.8);
    expect(b.reasonCodes & P.UNUSUAL_AMOUNT).toBe(P.UNUSUAL_AMOUNT);
  });

  test("6. voter-fatigue flood → largest first within the write budget; the rest wait at MaxDelay", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.alice, fakeVault());
    for (let i = 1n; i <= 6n; i++) v.requests.set(i, request({ amount: USD(100) + i }));
    v.requests.set(7n, request({ amount: USD(9_000) }));
    cron(w, 1n, { ...reconcilerConfig, maxWritesPerRun: 3 });
    expect(w.writes[0].requestId).toBe(7n);
    expect(w.writes.filter((r) => r.reportType === P.REPORT_SET_DELAY)).toHaveLength(2);
  });

  test("7. Sybil wallet add → every open request is re-scored with CONFIG_CHANGE_PENDING bits", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.alice, fakeVault({ configChangePending: true }));
    v.requests.set(1n, request({ scored: true }));
    sentinel(w, configLog(ADDR.alice, P.CHANGE_ADD_WALLET));
    expect(w.writes[0].reasonCodes & P.CONFIG_CHANGE_PENDING).toBe(P.CONFIG_CHANGE_PENDING);
    const before = assess(contextOf(fakeVault({ requests: v.requests }), 1n)).score;
    expect(w.writes[0].score).toBeGreaterThan(before);
  });

  test("8. attacker freezes (grief) → the workflows leave a Frozen Vault alone (unfreeze is a majority/Recovery act)", () => {
    const w = newWorld();
    const r = request();
    addVault(w, ADDR.alice, fakeVault({ reserves: { held: 0n, supply: 1n } }), P.STATUS_FROZEN).requests.set(1n, r);
    expect(sentinel(w, queuedLog(ADDR.alice, r))).toContain("SKIP_VAULT_INACTIVE");
    expect(cron(w).health).toEqual([]);
  });
});
