/**
 * brief §8.5 failure matrix: one test per row, driving the real Sentinel / Reconciler handlers against the
 * fake chain. Rows whose defence is purely onchain (Hub/Vault) assert the workflow's half of the contract;
 * the onchain half is covered by the Foundry fork tests. The same rows exist as CLI fixtures in cre/fixtures.
 */
import { describe, expect } from "bun:test";
import type { CronPayload } from "@chainlink/cre-sdk";
import { newTestRuntime, test } from "@chainlink/cre-sdk/test";
import type { Address } from "viem";
import { config as reconcilerConfig } from "../reconciler/testkit";
import { onCron, type Config as RConfig } from "../reconciler/main";
import * as P from "../shared/palm";
import { ADDR, addVault, fakeVault, installWorld, newWorld, request, T_14H, type World } from "../shared/testing";
import { config, hubLog, unwrapLog } from "./testkit";
import { onHubLog, type Config } from "./main";

const sentinel = (w: World, log: Parameters<typeof onHubLog>[1]) => {
  installWorld(w);
  const rt = newTestRuntime<Config>();
  rt.config = config;
  return onHubLog(rt, log);
};

const cron = (w: World, slot = 1_793_973_600n, cfg: RConfig = { ...reconcilerConfig, assets: [] }) => {
  installWorld(w);
  const rt = newTestRuntime<RConfig>();
  rt.config = cfg;
  return JSON.parse(onCron(rt, { scheduledExecutionTime: { seconds: slot, nanos: 0 } } as unknown as CronPayload));
};

const verdicts = (w: World) => w.writes.filter((r) => r.reportType === P.REPORT_VERDICT);

describe("failure matrix (brief §8.5)", () => {
  test("1. missed log / dropped execution → the Reconciler decides it on the next pass", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request({ destination: ADDR.exchange }));
    const out = cron(w);
    expect(out.requests).toEqual([`${ADDR.alice}#1 HOLD WRITTEN`]);
  });

  test("2. reorg removes the event → removed=true is ignored, and no CLEAR is ever written from LATEST", () => {
    const w = newWorld();
    const r = request();
    const v = addVault(w, ADDR.alice, fakeVault());
    v.requests.set(1n, r);
    expect(sentinel(w, unwrapLog(ADDR.alice, r, 1n, { removed: true }))).toStartWith("REMOVED");
    v.finalized = new Map(); // the request exists at LATEST only
    expect(sentinel(w, unwrapLog(ADDR.alice, r))).toContain("DEFER_FINALITY");
    expect(verdicts(w)).toHaveLength(0);
  });

  test("3. duplicate or replayed report → same execution, same report bytes (Hub rejects the duplicate)", () => {
    const a = newWorld();
    addVault(a, ADDR.alice, fakeVault()).requests.set(1n, request({ destination: ADDR.exchange }));
    cron(a, 100n);
    const b = newWorld();
    addVault(b, ADDR.alice, fakeVault()).requests.set(1n, request({ destination: ADDR.exchange }));
    cron(b, 100n);
    expect(verdicts(a)[0]).toEqual(verdicts(b)[0]); // deterministic → identical reportId → REJECT_DUPLICATE
    const c = newWorld();
    addVault(c, ADDR.alice, fakeVault()).requests.set(1n, request({ destination: ADDR.exchange }));
    cron(c, 160n);
    expect(verdicts(c)[0].nonce).not.toBe(verdicts(a)[0].nonce); // a later pass re-sends with a fresh nonce
    expect(verdicts(a)[0].expiry).toBe(T_14H + BigInt(reconcilerConfig.reportTtlSeconds));
  });

  test("4. request modified after CLEAR → the report binds the onchain requestHash; a stale log is skipped", () => {
    const w = newWorld();
    const original = request();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request({ amount: 999n, requestHash: `0x${"42".repeat(32)}` }));
    expect(sentinel(w, unwrapLog(ADDR.alice, original))).toContain("SKIP_HASH_MISMATCH");
    cron(w);
    expect(verdicts(w)[0].requestHash).toBe(`0x${"42".repeat(32)}`);
  });

  test("5. CLEAR after FLAG → a Flagged request is never written again", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request({ state: P.REQ_FLAGGED }));
    const r = request();
    expect(sentinel(w, unwrapLog(ADDR.alice, { ...r, requestHash: request({ state: P.REQ_FLAGGED }).requestHash }))).toContain("SKIP_CLOSED");
    cron(w);
    expect(verdicts(w)).toHaveLength(0);
  });

  test("6. CRE fully down / RPC down → no Verdict and no freeze is written on missing data", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request());
    w.failing.add("*");
    w.headerFails = true;
    const out = cron(w);
    expect(verdicts(w)).toHaveLength(0);
    expect(w.writes.filter((r) => r.reportType === P.REPORT_RESERVE_FLAG || r.reportType === P.REPORT_DELEGATION_FLAG)).toHaveLength(0);
    expect(out.heartbeat).toBe("WRITTEN"); // heartbeat only proves the workflow ran; stale heartbeat = CRE down
  });

  test("7. oracle stale or deviating → the request HOLDs (ORACLE_STALE / PRICE_DEVIATION)", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.alice, fakeVault({ stale: new Set([ADDR.weth.toLowerCase()]) }));
    v.requests.set(1n, request({ secondFactor: true }));
    w.marketMode.set(ADDR.usdc.toLowerCase(), P.MODE_DEGRADED);
    v.requests.set(2n, request({ amount: 2n, asset: ADDR.usdc }));
    cron(w);
    const [a, b] = verdicts(w);
    expect(a.verdict).toBe(P.VERDICT_HOLD);
    expect(a.reasonCodes & P.ORACLE_STALE).toBe(P.ORACLE_STALE);
    expect(b.verdict).toBe(P.VERDICT_HOLD);
    expect(b.reasonCodes & P.PRICE_DEVIATION).toBe(P.PRICE_DEVIATION);
  });

  test("8. approval source timeout / error → HOLD (API_UNAVAILABLE); a failing /notify never undoes a Verdict", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.nvidia, fakeVault({ institution: true, hardCap: 10n ** 12n }));
    v.requests.set(1n, request());
    w.failing.add(`${ADDR.book.toLowerCase()}:get`);
    w.notifyStatus = 503;
    const out = cron(w);
    expect(verdicts(w)[0].verdict).toBe(P.VERDICT_HOLD);
    expect(verdicts(w)[0].reasonCodes & P.API_UNAVAILABLE).toBe(P.API_UNAVAILABLE);
    expect(out.requests[0]).toContain("HOLD WRITTEN");
  });

  test("9. request flood to bury a large request → the largest USD amount is scored first", () => {
    const w = newWorld();
    for (let i = 0; i < 5; i++) {
      const v = addVault(w, `0x${(0x300 + i).toString(16).padStart(40, "0")}` as Address, fakeVault());
      for (let j = 1n; j <= 3n; j++) v.requests.set(j, request({ amount: j, usdValue: j, destination: ADDR.exchange }));
    }
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request({ usdValue: 9_000_000000n, destination: ADDR.attacker }));
    w.blocked.add(ADDR.attacker.toLowerCase());
    const out = cron(w, 1n, { ...reconcilerConfig, assets: [], maxScorePerRun: 2 });
    expect(out.requests[0]).toBe(`${ADDR.alice}#1 FLAG WRITTEN`);
  });

  test("10. low-and-slow drain → OVER_BUDGET travels with every Verdict (rolling caps are enforced onchain)", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request({ reasonCodes: P.OVER_BUDGET }));
    cron(w);
    expect(verdicts(w)[0].reasonCodes & P.OVER_BUDGET).toBe(P.OVER_BUDGET);
  });

  test("11. config attack (change recovery, then withdraw) → owner alerted, every pending withdrawal FLAGged", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.alice, fakeVault({ sensitivePending: 1n }));
    v.requests.set(1n, request());
    sentinel(w, hubLog("ConfigChangeRequested", { vault: ADDR.alice, changeId: 1n, kind: P.CHANGE_RECOVERY_VAULT, data: "0x", eta: 1n }));
    expect((w.notifications[0].body as { kind: string }).kind).toBe("CONFIG_CHANGE");
    expect(verdicts(w)[0].verdict).toBe(P.VERDICT_FLAG);
    expect(verdicts(w)[0].reasonCodes & P.CONFIG_CHANGE_PENDING).toBe(P.CONFIG_CHANGE_PENDING);
  });

  test("12. 7702 sweeper delegation → DELEGATION_FLAG from the Reconciler", () => {
    const w = newWorld();
    addVault(w, ADDR.nvidia, fakeVault({ delegationTargets: [ADDR.sweeper], delegationOk: [false] }));
    cron(w);
    expect(w.writes[0]).toMatchObject({ reportType: P.REPORT_DELEGATION_FLAG, reasonCodes: P.DELEGATION_CHANGED });
  });

  test("13. price crash → WETH goes Volatile (Safe-harbor swaps stay instant onchain)", () => {
    const w = newWorld();
    w.feeds.get(ADDR.ethUsd.toLowerCase())!.prevAnswer = 3600_00000000n; // −16.7%
    const cfg = { ...reconcilerConfig, assets: [{ ...reconcilerConfig.assets[0], pool: undefined }] };
    cron(w, 1n, cfg);
    expect(w.writes.find((r) => r.reportType === P.REPORT_MARKET_MODE)).toMatchObject({ verdict: P.MODE_VOLATILE });
  });

  test("14. workflow bug or compromise → reports are bounded: known types, verdicts 1–3, short expiry", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.alice, fakeVault({ delegationOk: [false], delegationTargets: [ADDR.sweeper] }));
    v.requests.set(1n, request());
    addVault(w, ADDR.nvidia, fakeVault()).requests.set(1n, request({ destination: ADDR.exchange }));
    cron(w, 1n, reconcilerConfig);
    for (const r of w.writes) {
      expect([P.REPORT_VERDICT, P.REPORT_MARKET_MODE, P.REPORT_HEARTBEAT, P.REPORT_DELEGATION_FLAG, P.REPORT_RESERVE_FLAG]).toContain(r.reportType);
      if (r.reportType === P.REPORT_VERDICT) expect([P.VERDICT_CLEAR, P.VERDICT_HOLD, P.VERDICT_FLAG]).toContain(r.verdict);
      expect(r.expiry).toBeLessThanOrEqual(T_14H + BigInt(reconcilerConfig.reportTtlSeconds));
    }
  });

  test("15. gas spike / failed write → WRITE_FAILED, and the next pass re-sends with a fresh nonce", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request({ destination: ADDR.exchange }));
    w.writeReply = { txStatus: "TX_STATUS_FATAL", receiverReverted: false };
    const first = cron(w, 100n);
    expect(first.requests[0]).toContain("WRITE_FAILED");
    expect(w.notifications).toHaveLength(0);
    w.writeReply = { txStatus: "TX_STATUS_SUCCESS", receiverReverted: false };
    const second = cron(w, 160n);
    expect(second.requests[0]).toContain("HOLD WRITTEN");
    const [a, b] = verdicts(w);
    expect(a.nonce).not.toBe(b.nonce);
  });

  test("16. false-positive freeze → a Frozen Vault is left alone (only the Recovery key or a Vote unfreezes)", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.alice, fakeVault({ reserves: { u: [ADDR.weth], held: [1n], supply: [2n] } }), P.STATUS_FROZEN);
    v.requests.set(1n, request({ destination: ADDR.exchange }));
    cron(w);
    expect(w.writes.filter((r) => r.reportType !== P.REPORT_HEARTBEAT)).toHaveLength(0);
  });
});
