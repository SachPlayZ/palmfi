import { describe, expect } from "bun:test";
import type { CronPayload } from "@chainlink/cre-sdk";
import { newTestRuntime, test } from "@chainlink/cre-sdk/test";
import * as P from "../shared/palm";
import { ADDR, addVault, fakeVault, installWorld, newWorld, request, type World } from "../shared/testing";
import { byPriority, initWorkflow, onCron, type Config } from "./main";
import { config } from "./testkit";

const payload = { scheduledExecutionTime: { seconds: 1_793_973_600n, nanos: 0 } } as unknown as CronPayload;

export const runCron = (w: World, cfg: Config = config) => {
  installWorld(w);
  const runtime = newTestRuntime<Config>();
  runtime.config = cfg;
  return JSON.parse(onCron(runtime, payload)) as Record<string, unknown> & { evmCalls: number; requests: string[]; health: string[] };
};

describe("registration", () => {
  test("one cron handler on the configured schedule", () => {
    const h = initWorkflow(config);
    expect(h).toHaveLength(1);
    expect((h[0].trigger as unknown as { config: { schedule: string } }).config.schedule).toBe(config.schedule);
  });
});

describe("onCron", () => {
  test("healthy network → heartbeat only", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault());
    const out = runCron(w);
    expect(out.heartbeat).toBe("WRITTEN");
    expect(w.writes.map((r) => r.reportType)).toEqual([P.REPORT_HEARTBEAT]);
    expect(out.evmCalls).toBeLessThanOrEqual(15);
  });

  test("scores unscored pending requests; skips scored and fast-tracked ones", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.alice, fakeVault());
    v.requests.set(1n, request());
    v.requests.set(2n, request({ scored: true, amount: 2n }));
    v.requests.set(3n, request({ fastTracked: true, amount: 3n }));
    const out = runCron(w);
    expect(out.requests).toEqual([`${ADDR.alice}#1 DELAY WRITTEN`]);
  });

  test("reserves below supply → RESERVE_FLAG, and that Vault's requests are left alone", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault({ reserves: { held: 1n, supply: 2n } })).requests.set(1n, request());
    const out = runCron(w);
    expect(out.health).toEqual([`${ADDR.alice} RESERVE_FLAG WRITTEN`]);
    expect(out.requests).toEqual([]);
  });

  test("frozen Vaults are not re-flagged", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault({ reserves: { held: 1n, supply: 2n } }), P.STATUS_FROZEN);
    expect(runCron(w).health).toEqual([]);
  });

  test("one write slot is always kept for the heartbeat", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.alice, fakeVault());
    for (let i = 1n; i <= 5n; i++) v.requests.set(i, request({ amount: 1000_000000n + i }));
    runCron(w, { ...config, maxWritesPerRun: 3 });
    expect(w.writes.map((r) => r.reportType)).toEqual([P.REPORT_SET_DELAY, P.REPORT_SET_DELAY, P.REPORT_HEARTBEAT]);
  });

  test("largest amount first (flood defence)", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.alice, fakeVault());
    v.requests.set(1n, request({ amount: 10_000000n }));
    v.requests.set(2n, request({ amount: 900_000000n }));
    runCron(w, { ...config, maxWritesPerRun: 2 });
    expect(w.writes[0].requestId).toBe(2n);
  });

  test("RPC down → no reports but the heartbeat attempt; nothing frozen on missing data", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request());
    w.failing.add("*");
    const out = runCron(w);
    expect(out.requests).toEqual([]);
    expect(w.writes.map((r) => r.reportType)).toEqual([P.REPORT_HEARTBEAT]);
  });
});

test("byPriority is a total, deterministic order", () => {
  const row = (vault: `0x${string}`, requestId: bigint, amount: bigint) => ({
    vault, requestId, amount, state: 1, scored: false, fastTracked: false, executableAt: 0n, requestHash: "0x" as const,
  });
  const rows = [row(ADDR.nvidia, 1n, 5n), row(ADDR.alice, 2n, 5n), row(ADDR.alice, 1n, 5n), row(ADDR.alice, 9n, 50n)];
  expect(rows.slice().sort(byPriority).map((r) => `${r.vault}#${r.requestId}`)).toEqual([
    `${ADDR.alice}#9`, `${ADDR.nvidia}#1`, `${ADDR.alice}#1`, `${ADDR.alice}#2`, // ties: vault (lowercase hex), then id
  ]);
});
