import { describe, expect } from "bun:test";
import type { EVMLog } from "@chainlink/cre-sdk";
import { newTestRuntime, test } from "@chainlink/cre-sdk/test";
import * as P from "../shared/palm";
import { ADDR, addVault, fakeVault, installWorld, newWorld, request, T_02H, type World } from "../shared/testing";
import { eventTopic, initWorkflow, onHubLog, SCORED_EVENTS, type Config } from "./main";
import { config, configLog, hubLog, outflowLog, queuedLog } from "./testkit";

const runLog = (w: World, log: EVMLog) => {
  installWorld(w);
  const runtime = newTestRuntime<Config>();
  runtime.config = config;
  return onHubLog(runtime, log);
};

describe("trigger registration", () => {
  test("raw logTrigger on the Hub at LATEST for the scored events", () => {
    const [h] = initWorkflow(config);
    const c = (h.trigger as unknown as { config: unknown }).config as { confidence: number; addresses: Uint8Array[]; topics: { values: Uint8Array[] }[] };
    expect(c.confidence).toBe(1); // ConfidenceLevel.LATEST
    expect(Buffer.from(c.addresses[0]).toString("hex")).toBe(ADDR.hub.slice(2).toLowerCase());
    expect(c.topics[0].values.map((v) => `0x${Buffer.from(v).toString("hex")}`)).toEqual(SCORED_EVENTS.map(eventTopic));
  });
});

describe("RequestQueued", () => {
  test("routine request → SET_DELAY", () => {
    const w = newWorld();
    const r = request();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, r);
    const out = runLog(w, queuedLog(ADDR.alice, r));
    expect(out).toContain("DELAY WRITTEN");
    expect(w.writes[0]).toMatchObject({ reportType: P.REPORT_SET_DELAY, vault: ADDR.alice, requestId: 1n, requestHash: r.requestHash });
  });

  test("expiry comes from the log's block header", () => {
    const w = newWorld();
    w.headerTimestamp = T_02H;
    const r = request();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, r);
    runLog(w, queuedLog(ADDR.alice, r));
    expect(w.writes[0].expiry).toBe(T_02H + 900n);
  });

  test("no block header → nothing written (Reconciler picks it up; Vault default is MaxDelay)", () => {
    const w = newWorld();
    w.headerFails = true;
    const r = request();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, r);
    expect(runLog(w, queuedLog(ADDR.alice, r))).toStartWith("DEFERRED");
    expect(w.writes).toHaveLength(0);
  });

  test("a log whose hash differs from the request onchain is skipped", () => {
    const w = newWorld();
    const r = request();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, { ...r, requestHash: `0x${"77".repeat(32)}` });
    expect(runLog(w, queuedLog(ADDR.alice, r))).toContain("SKIP_HASH_MISMATCH");
  });

  test("removed log is ignored", () => {
    const w = newWorld();
    const r = request();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, r);
    expect(runLog(w, queuedLog(ADDR.alice, r, 1n, { removed: true }))).toStartWith("REMOVED");
  });

  test("stays inside the CRE quota (header + 1 multicall)", () => {
    const w = newWorld();
    const r = request();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, r);
    runLog(w, queuedLog(ADDR.alice, r));
    expect(w.evmCalls).toBe(2);
  });
});

describe("ConfigChange", () => {
  test("proposed wallet add → notify + re-score every open request with CONFIG_CHANGE_PENDING", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.alice, fakeVault({ configChangePending: true }));
    v.requests.set(1n, request({ scored: true }));
    v.requests.set(2n, request({ amount: 2_000_000000n, scored: true }));
    runLog(w, configLog(ADDR.alice, P.CHANGE_ADD_WALLET));
    expect(w.notifications[0].body).toMatchObject({ kind: "CONFIG_CHANGE", reasonCodes: String(P.CONFIG_CHANGE_PENDING) });
    expect(w.writes).toHaveLength(2);
    for (const r of w.writes) expect(r.reasonCodes & P.CONFIG_CHANGE_PENDING).toBe(P.CONFIG_CHANGE_PENDING);
  });

  test("other changes only notify", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request());
    expect(runLog(w, configLog(ADDR.alice, P.CHANGE_BUDGET))).toContain("notified");
    expect(w.writes).toHaveLength(0);
    expect(w.notifications).toHaveLength(1);
  });
});

describe("Outflow", () => {
  test("pool outflow with reserves below supply → RESERVE_FLAG", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault({ reserves: { held: 1n, supply: 2n } }));
    expect(runLog(w, outflowLog(ADDR.alice, true))).toContain("RESERVE_FLAG WRITTEN");
    expect(w.writes[0]).toMatchObject({ reportType: P.REPORT_RESERVE_FLAG, reasonCodes: P.RESERVE_MISMATCH });
  });

  test("unapproved 7702 delegation → DELEGATION_FLAG", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault({ delegationTargets: [ADDR.sweeper, ADDR.sweeper, ADDR.sweeper], delegationOk: [false, true, true] }));
    expect(runLog(w, outflowLog(ADDR.alice, true))).toContain("DELEGATION_FLAG WRITTEN");
  });

  test("direct outflow skips the health check", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault({ reserves: { held: 1n, supply: 2n } }));
    expect(runLog(w, outflowLog(ADDR.alice, false))).toContain("no health check");
    expect(w.writes).toHaveLength(0);
  });
});

test("undecodable log is ignored", () => {
  const w = newWorld();
  const log = hubLog("Outflow", { vault: ADDR.alice, wallet: ADDR.w0, destination: ADDR.friend, amount: 1n, viaPool: true });
  (log as unknown as { data: Uint8Array }).data = new Uint8Array([1, 2, 3]);
  expect(runLog(w, log)).toStartWith("IGNORED");
});
