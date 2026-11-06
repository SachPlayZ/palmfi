import { describe, expect } from "bun:test";
import type { CronPayload } from "@chainlink/cre-sdk";
import { newTestRuntime, test } from "@chainlink/cre-sdk/test";
import type { Address, Hex } from "viem";
import * as P from "../shared/palm";
import { ADDR, addVault, fakeVault, installWorld, newWorld, request, T_14H, type World } from "../shared/testing";
import { byPriority, initWorkflow, onCron, type Config } from "./main";
import { config, POOL_ID } from "./testkit";

/** sqrtPriceX96 for WETH at `usd` USDC with USDC as token0. */
const sqrtForEth = (usd: bigint) => {
  const target = ((10n ** 18n) << 192n) / (usd * 10n ** 6n);
  let x = 1n << 96n;
  for (let i = 0; i < 200; i++) x = (x + target / x) >> 1n;
  return x;
};

const payload = { scheduledExecutionTime: { seconds: 1_793_973_600n, nanos: 0 } } as unknown as CronPayload;

const runCron = (w: World, cfg: Config = config) => {
  installWorld(w);
  const runtime = newTestRuntime<Config>();
  runtime.config = cfg;
  return JSON.parse(onCron(runtime, payload)) as Record<string, unknown> & { evmCalls: number };
};

const healthyWorld = () => {
  const w = newWorld();
  w.slot0.set(POOL_ID.toLowerCase(), sqrtForEth(3000n));
  return w;
};

describe("registration", () => {
  test("one cron handler on the configured schedule (≥ 30s minimum)", () => {
    const h = initWorkflow(config);
    expect(h).toHaveLength(1);
    expect((h[0].trigger as unknown as { config: { schedule: string } }).config.schedule).toBe(config.schedule);
  });
});

describe("heartbeat", () => {
  test("every pass writes a heartbeat, even with nothing to do", () => {
    const w = healthyWorld();
    const out = runCron(w);
    expect(out.heartbeat).toBe("WRITTEN");
    const hb = w.writes.filter((r) => r.reportType === P.REPORT_HEARTBEAT);
    expect(hb).toHaveLength(1);
    expect(hb[0].expiry).toBe(T_14H + 900n);
  });
  test("a heartbeat whose onReport reverts is reported as failed", () => {
    const w = healthyWorld();
    w.writeReply = { txStatus: "TX_STATUS_SUCCESS", receiverReverted: true };
    expect(runCron(w).heartbeat).toContain("receiverReverted");
  });
  test("a pass stays within the 15-call EVM quota", () => {
    const w = healthyWorld();
    const v = addVault(w, ADDR.alice, fakeVault());
    v.requests.set(1n, request({ destination: ADDR.exchange }));
    const out = runCron(w);
    expect(out.evmCalls).toBeLessThanOrEqual(15);
    expect(w.evmCalls).toBeLessThanOrEqual(15);
  });
});

describe("catch-up (issue #11)", () => {
  test("a request whose log was missed gets a Verdict on the next pass", () => {
    const w = healthyWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request({ destination: ADDR.exchange }));
    const out = runCron(w);
    expect(out.requests).toEqual([`${ADDR.alice}#1 HOLD WRITTEN`]);
    expect(w.writes.find((r) => r.reportType === P.REPORT_VERDICT)!.verdict).toBe(P.VERDICT_HOLD);
  });
  test("a CLEAR the Sentinel deferred for finality is written once the request is final", () => {
    const w = healthyWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request());
    runCron(w);
    expect(w.writes.find((r) => r.reportType === P.REPORT_VERDICT)!.verdict).toBe(P.VERDICT_CLEAR);
  });
  test("already decided requests are not re-sent", () => {
    const w = healthyWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request({ state: P.REQ_CLEARED }));
    runCron(w);
    expect(w.writes.filter((r) => r.reportType === P.REPORT_VERDICT)).toHaveLength(0);
  });
  test("largest USD first under a flood (pending cap × many Vaults)", () => {
    const w = healthyWorld();
    for (let i = 0; i < 6; i++) {
      const addr = `0x${(0x100 + i).toString(16).padStart(40, "0")}` as Address;
      const v = addVault(w, addr, fakeVault());
      for (let j = 1n; j <= 3n; j++) v.requests.set(j, request({ amount: j, usdValue: 1_000000n * j, destination: ADDR.exchange }));
    }
    const whale = addVault(w, ADDR.alice, fakeVault());
    whale.requests.set(1n, request({ usdValue: 8000_000000n, destination: ADDR.exchange }));
    const out = runCron(w, { ...config, maxScorePerRun: 4 });
    expect((out.requests as string[])[0]).toStartWith(`${ADDR.alice}#1`);
    expect(out.requests as string[]).toHaveLength(4);
  });
  test("byPriority is a total, deterministic order", () => {
    const rows = [
      { vault: "0x02" as Address, requestId: 1n, usdValue: 5n, state: 1, requestHash: "0x" as Hex },
      { vault: "0x01" as Address, requestId: 2n, usdValue: 5n, state: 1, requestHash: "0x" as Hex },
      { vault: "0x01" as Address, requestId: 1n, usdValue: 5n, state: 1, requestHash: "0x" as Hex },
      { vault: "0x03" as Address, requestId: 1n, usdValue: 9n, state: 1, requestHash: "0x" as Hex },
    ];
    expect(rows.slice().sort(byPriority).map((r) => `${r.vault}:${r.requestId}`)).toEqual(["0x03:1", "0x01:1", "0x01:2", "0x02:1"]);
  });
});

describe("reserves and delegations (issues #11, #12)", () => {
  test("reserves below supply → RESERVE_FLAG, and that Vault's requests are not scored", () => {
    const w = healthyWorld();
    const v = addVault(w, ADDR.alice, fakeVault({ reserves: { u: [ADDR.weth], held: [1n], supply: [2n] } }));
    v.requests.set(1n, request());
    const out = runCron(w);
    expect(w.writes[0]).toMatchObject({ reportType: P.REPORT_RESERVE_FLAG, vault: ADDR.alice, reasonCodes: P.RESERVE_MISMATCH });
    expect(out.requests).toEqual([]);
    expect((w.notifications[0].body as { kind: string }).kind).toBe("FLAG");
  });
  test("sweeper delegation → DELEGATION_FLAG without any Vault call", () => {
    const w = healthyWorld();
    addVault(w, ADDR.nvidia, fakeVault({ delegationTargets: [ADDR.sweeper], delegationOk: [false] }));
    runCron(w);
    expect(w.writes[0]).toMatchObject({ reportType: P.REPORT_DELEGATION_FLAG, vault: ADDR.nvidia, reasonCodes: P.DELEGATION_CHANGED });
  });
  test("an already Frozen Vault is not re-flagged", () => {
    const w = healthyWorld();
    addVault(w, ADDR.nvidia, fakeVault({ delegationTargets: [ADDR.sweeper], delegationOk: [false] }), P.STATUS_FROZEN);
    runCron(w);
    expect(w.writes.filter((r) => r.reportType === P.REPORT_DELEGATION_FLAG)).toHaveLength(0);
  });
  test("an unreadable Vault is never frozen on missing data", () => {
    const w = healthyWorld();
    addVault(w, ADDR.alice, fakeVault());
    w.failing.add(`${ADDR.alice.toLowerCase()}:reserves`);
    w.failing.add(`${ADDR.alice.toLowerCase()}:delegations`);
    runCron(w);
    expect(w.writes.filter((r) => r.reportType !== P.REPORT_HEARTBEAT && r.reportType !== P.REPORT_MARKET_MODE)).toHaveLength(0);
  });
});

describe("Market modes (issue #19)", () => {
  const modeWrites = (w: World) => w.writes.filter((r) => r.reportType === P.REPORT_MARKET_MODE);
  test("healthy market, Normal already set → nothing written", () => {
    const w = healthyWorld();
    expect(modeWrites((runCron(w), w))).toHaveLength(0);
  });
  test("pool > 3% away from Chainlink → WETH Degraded (PRICE_DEVIATION)", () => {
    const w = newWorld();
    w.slot0.set(POOL_ID.toLowerCase(), sqrtForEth(3200n));
    runCron(w);
    const m = modeWrites(w);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ requestId: BigInt(ADDR.weth), verdict: P.MODE_DEGRADED, reasonCodes: P.PRICE_DEVIATION });
  });
  test("stale ETH/USD feed → WETH Degraded (ORACLE_STALE)", () => {
    const w = healthyWorld();
    w.feeds.get(ADDR.ethUsd.toLowerCase())!.updatedAt = T_14H - 3600n - 3601n;
    runCron(w);
    expect(modeWrites(w)[0]).toMatchObject({ verdict: P.MODE_DEGRADED, reasonCodes: P.ORACLE_STALE });
  });
  test("ETH −15% round over round → Volatile", () => {
    const w = newWorld();
    const f = w.feeds.get(ADDR.ethUsd.toLowerCase())!;
    f.prevAnswer = 3530_00000000n;
    w.slot0.set(POOL_ID.toLowerCase(), sqrtForEth(3000n));
    runCron(w);
    expect(modeWrites(w)[0]).toMatchObject({ requestId: BigInt(ADDR.weth), verdict: P.MODE_VOLATILE });
  });
  test("recovery: Degraded onchain, healthy data → back to Normal", () => {
    const w = healthyWorld();
    w.marketMode.set(ADDR.weth.toLowerCase(), P.MODE_DEGRADED);
    runCron(w);
    expect(modeWrites(w)[0]).toMatchObject({ verdict: P.MODE_NORMAL });
  });
  test("pool id not configured yet → deviation check skipped, staleness still applies", () => {
    const w = newWorld();
    const cfg = { ...config, assets: config.assets.map((a) => (a.pool ? { ...a, pool: { ...a.pool, poolId: "" as const } } : a)) };
    w.feeds.get(ADDR.ethUsd.toLowerCase())!.updatedAt = 0n;
    runCron(w, cfg);
    expect(modeWrites(w)[0]).toMatchObject({ verdict: P.MODE_DEGRADED, reasonCodes: P.ORACLE_STALE });
  });
  test("unreadable feed → mode left alone", () => {
    const w = healthyWorld();
    w.failing.add(`${ADDR.usdcUsd.toLowerCase()}:latestRoundData`);
    const out = runCron(w);
    expect((out.modes as string[]).some((m) => m.includes("USDC unknown"))).toBe(true);
  });
});

describe("write budget", () => {
  test("the heartbeat slot is reserved even when flags exhaust the budget", () => {
    const w = healthyWorld();
    for (let i = 0; i < 10; i++)
      addVault(w, `0x${(0x200 + i).toString(16).padStart(40, "0")}` as Address, fakeVault({ delegationOk: [false], delegationTargets: [ADDR.sweeper] }));
    const out = runCron(w, { ...config, maxWritesPerRun: 4 });
    expect(w.writes.filter((r) => r.reportType === P.REPORT_DELEGATION_FLAG)).toHaveLength(3);
    expect(out.heartbeat).toBe("WRITTEN");
  });
});
