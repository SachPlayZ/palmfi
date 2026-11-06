import { describe, expect } from "bun:test";
import type { EVMLog } from "@chainlink/cre-sdk";
import { newTestRuntime, test } from "@chainlink/cre-sdk/test";
import * as P from "../shared/palm";
import {
  ADDR,
  addVault,
  fakeVault,
  installWorld,
  newWorld,
  request,
  T_02H,
  type World,
} from "../shared/testing";
import { eventTopic, initWorkflow, onHubLog, SCORED_EVENTS, type Config } from "./main";
import { config, hubLog, unwrapLog } from "./testkit";

const runLog = (w: World, log: EVMLog) => {
  installWorld(w);
  const runtime = newTestRuntime<Config>();
  runtime.config = config;
  return onHubLog(runtime, log);
};

describe("trigger registration", () => {
  test("raw logTrigger on the Hub at LATEST for the five scored events", () => {
    const [h] = initWorkflow(config);
    const c = (h.trigger as unknown as { config: unknown }).config as { confidence: number; addresses: Uint8Array[]; topics: { values: Uint8Array[] }[] };
    expect(c.confidence).toBe(1); // ConfidenceLevel.LATEST
    expect(c.addresses).toHaveLength(1);
    expect(Buffer.from(c.addresses[0]).toString("hex")).toBe(ADDR.hub.slice(2).toLowerCase());
    expect(c.topics[0].values.map((v) => `0x${Buffer.from(v).toString("hex")}`)).toEqual(SCORED_EVENTS.map(eventTopic));
  });
});

describe("UnwrapRequested", () => {
  test("a request to a new destination is HELD and the Owner is notified", () => {
    const w = newWorld();
    const r = request({ destination: ADDR.exchange, reasonCodes: P.NEW_DESTINATION | P.OVER_BUDGET });
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, r);
    const out = runLog(w, unwrapLog(ADDR.alice, r));
    expect(out).toContain("HOLD WRITTEN");
    expect(w.writes[0]).toMatchObject({ reportType: P.REPORT_VERDICT, vault: ADDR.alice, requestId: 1n, verdict: P.VERDICT_HOLD });
    expect(w.writes[0].reasonCodes & P.NEW_DESTINATION).toBe(P.NEW_DESTINATION);
    expect(w.notifications).toHaveLength(1);
  });

  test("a Blocklisted destination is FLAGged within the same run", () => {
    const w = newWorld();
    const r = request({ destination: ADDR.attacker });
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, r);
    w.blocked.add(ADDR.attacker.toLowerCase());
    expect(runLog(w, unwrapLog(ADDR.alice, r))).toContain("FLAG WRITTEN");
    expect(w.writes[0].verdict).toBe(P.VERDICT_FLAG);
  });

  test("the block timestamp comes from the log's block header", () => {
    const w = newWorld();
    w.headerTimestamp = T_02H;
    const v = addVault(w, ADDR.nvidia, fakeVault({ institution: true, hardCap: 10n ** 12n, bizStartHourUtc: 9, bizEndHourUtc: 17 }));
    const r = request();
    v.requests.set(1n, r);
    runLog(w, unwrapLog(ADDR.nvidia, r));
    expect(w.writes[0].reasonCodes & P.OFF_HOURS).toBe(P.OFF_HOURS);
    expect(w.writes[0].expiry).toBe(T_02H + 900n);
  });

  test("a missing block header → HOLD for Institutions (cannot check business hours)", () => {
    const w = newWorld();
    w.headerFails = true;
    const v = addVault(w, ADDR.nvidia, fakeVault({ institution: true, hardCap: 10n ** 12n, bizStartHourUtc: 9, bizEndHourUtc: 17 }));
    const r = request();
    v.requests.set(1n, r);
    runLog(w, unwrapLog(ADDR.nvidia, r));
    expect(w.writes[0].verdict).toBe(P.VERDICT_HOLD);
    expect(w.writes[0].reasonCodes & P.API_UNAVAILABLE).toBe(P.API_UNAVAILABLE);
  });

  test("an in-profile request already final is CLEARed", () => {
    const w = newWorld();
    const r = request();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, r);
    expect(runLog(w, unwrapLog(ADDR.alice, r))).toContain("CLEAR WRITTEN");
  });

  test("an in-profile request not yet final is deferred (no CLEAR from LATEST)", () => {
    const w = newWorld();
    const r = request();
    const v = addVault(w, ADDR.alice, fakeVault());
    v.requests.set(1n, r);
    v.finalized = new Map();
    expect(runLog(w, unwrapLog(ADDR.alice, r))).toContain("DEFER_FINALITY");
    expect(w.writes).toHaveLength(0);
  });

  test("a log whose hash no longer matches the onchain request is skipped", () => {
    const w = newWorld();
    const r = request();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request({ requestHash: `0x${"77".repeat(32)}` }));
    expect(runLog(w, unwrapLog(ADDR.alice, r))).toContain("SKIP_HASH_MISMATCH");
    expect(w.writes).toHaveLength(0);
  });

  test("removed=true (reorg) is ignored", () => {
    const w = newWorld();
    const r = request({ destination: ADDR.attacker });
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, r);
    expect(runLog(w, unwrapLog(ADDR.alice, r, 1n, { removed: true }))).toStartWith("REMOVED");
    expect(w.writes).toHaveLength(0);
    expect(w.evmCalls).toBe(0);
  });
});

describe("SecondFactorConfirmed (issue #7 re-score)", () => {
  test("a Held request confirmed with a passkey is re-scored to CLEAR", () => {
    const w = newWorld();
    const r = request({ destination: ADDR.exchange, usdValue: 80_000000n, state: P.REQ_HELD, secondFactor: true, reasonCodes: P.NEW_DESTINATION });
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, r);
    const out = runLog(w, hubLog("SecondFactorConfirmed", { vault: ADDR.alice, requestId: 1n, requestHash: r.requestHash }));
    expect(out).toContain("CLEAR WRITTEN");
    expect(w.writes[0].verdict).toBe(P.VERDICT_CLEAR);
  });
});

describe("ConfigChangeRequested (issue #10)", () => {
  test("a sensitive change notifies CONFIG_CHANGE and FLAGs every open request", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.alice, fakeVault({ sensitivePending: 1n }));
    v.requests.set(1n, request({ amount: 1n }));
    v.requests.set(2n, request({ amount: 2n, state: P.REQ_CLEARED }));
    const out = runLog(
      w,
      hubLog("ConfigChangeRequested", { vault: ADDR.alice, changeId: 4n, kind: P.CHANGE_RECOVERY_KEY, data: "0x", eta: 1n }),
    );
    expect(w.notifications[0].body).toEqual({
      vault: ADDR.alice,
      kind: "CONFIG_CHANGE",
      requestId: "4",
      reasonCodes: P.CONFIG_CHANGE_PENDING.toString(),
    });
    expect(w.writes.map((x) => x.verdict)).toEqual([P.VERDICT_FLAG, P.VERDICT_FLAG]);
    expect(out).toContain("FLAG WRITTEN");
  });

  test("a non-sensitive change only notifies", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault());
    const out = runLog(
      w,
      hubLog("ConfigChangeRequested", { vault: ADDR.alice, changeId: 1n, kind: P.CHANGE_ADD_DESTINATION, data: "0x", eta: 1n }),
    );
    expect(out).toContain("no open requests");
    expect((w.notifications[0].body as { reasonCodes: string }).reasonCodes).toBe("0");
    expect(w.writes).toHaveLength(0);
  });
});

describe("HookSwap / SafeHarborSwap", () => {
  test("a swap from a Vault whose Hot wallet delegates to a sweeper raises DELEGATION_FLAG", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault({ delegationTargets: [ADDR.sweeper], delegationOk: [false] }));
    const out = runLog(
      w,
      hubLog("HookSwap", { vault: ADDR.alice, hotWallet: ADDR.hot, asset: ADDR.weth, amount: 1n, isUnwrap: true, usdValue: 1n }),
    );
    expect(out).toContain("DELEGATION_FLAG WRITTEN");
    expect(w.writes[0]).toMatchObject({ reportType: P.REPORT_DELEGATION_FLAG, vault: ADDR.alice, reasonCodes: P.DELEGATION_CHANGED });
  });

  test("a healthy Vault writes nothing", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault());
    const out = runLog(w, hubLog("SafeHarborSwap", { vault: ADDR.alice, hotWallet: ADDR.hot, amountIn: 1n, amountOut: 1n, minOut: 1n }));
    expect(out).toContain("healthy");
    expect(w.writes).toHaveLength(0);
  });

  test("reserves below supply raise RESERVE_FLAG", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault({ reserves: { u: [ADDR.weth], held: [1n], supply: [2n] } }));
    runLog(w, hubLog("SafeHarborSwap", { vault: ADDR.alice, hotWallet: ADDR.hot, amountIn: 1n, amountOut: 1n, minOut: 1n }));
    expect(w.writes[0]).toMatchObject({ reportType: P.REPORT_RESERVE_FLAG, reasonCodes: P.RESERVE_MISMATCH });
  });
});
