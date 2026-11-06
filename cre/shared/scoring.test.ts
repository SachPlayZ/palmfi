import { describe, expect } from "bun:test";
import { EVMClient } from "@chainlink/cre-sdk";
import { newTestRuntime, test } from "@chainlink/cre-sdk/test";
import type { Address } from "viem";
import { Chain } from "./chain";
import { DEFAULT_PARAMS } from "./deviation";
import * as P from "./palm";
import { decodeReport, encodeReport } from "./report";
import { scoreAndWrite, type ScoreOptions, type ScoringConfig } from "./scoring";
import { ADDR, addVault, ARC, fakeVault, installWorld, newWorld, request, T_02H, T_14H, type World } from "./testing";

const cfg: ScoringConfig = {
  hub: ADDR.hub,
  reportTtlSeconds: 600,
  gasLimit: "500000",
  maxWritesPerRun: 5,
  scoring: DEFAULT_PARAMS,
  notifyDelaySeconds: 6 * 3600,
  notify: { url: "https://palmfi.example/api/notify", apiKeySecret: "notifyApiKey" },
};

const run = (w: World, refs: { vault: Address; requestId: bigint }[], opts: Partial<ScoreOptions> = {}, c = cfg) => {
  installWorld(w);
  const runtime = newTestRuntime();
  const chain = new Chain(runtime, new EVMClient(ARC), ADDR.multicall3);
  const out = scoreAndWrite(runtime, chain, c, refs, { blockTimestamp: T_14H, nonceSeed: "test", ...opts });
  return { out, chain };
};

describe("report encoding", () => {
  test("round-trips PalmTypes.Report (9 static words)", () => {
    const r: P.Report = {
      reportType: P.REPORT_SET_DELAY,
      vault: ADDR.alice,
      requestId: 7n,
      requestHash: `0x${"ab".repeat(32)}`,
      delay: 3600n,
      score: 12_345,
      reasonCodes: P.NEW_DESTINATION | P.OFF_HOURS,
      expiry: 123n,
      nonce: 456n,
    };
    const enc = encodeReport(r);
    expect((enc.length - 2) / 2).toBe(9 * 32);
    expect(decodeReport(enc)).toEqual(r);
  });
});

describe("scoreAndWrite", () => {
  test("routine request → SET_DELAY near the Floor, one multicall, no notification", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request());
    const { out, chain } = run(w, [{ vault: ADDR.alice, requestId: 1n }]);
    expect(out[0].outcome).toBe("WRITTEN");
    expect(chain.calls).toBe(1);
    expect(w.writes[0]).toMatchObject({ reportType: P.REPORT_SET_DELAY, vault: ADDR.alice, requestId: 1n, expiry: T_14H + 600n });
    expect(w.writes[0].delay).toBeLessThan(2n * 3600n);
    expect(w.notifications).toHaveLength(0);
  });

  test("a scored request drops CRE_SILENT but keeps the Vault's other codes", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request({ reasonCodes: P.CRE_SILENT | P.OVER_HARD_CAP }));
    run(w, [{ vault: ADDR.alice, requestId: 1n }]);
    expect(w.writes[0].reasonCodes & P.CRE_SILENT).toBe(0n);
    expect(w.writes[0].reasonCodes & P.OVER_HARD_CAP).toBe(P.OVER_HARD_CAP);
  });

  test("huge 2am request to a new destination → FLAG and every Voter is notified", () => {
    const w = newWorld();
    const r = request({ amount: 3_000_000_000000n, destination: ADDR.attacker, createdAt: T_02H, reasonCodes: P.NEW_DESTINATION });
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, r);
    run(w, [{ vault: ADDR.alice, requestId: 1n }], { blockTimestamp: T_02H });
    expect(w.writes[0]).toMatchObject({ reportType: P.REPORT_FLAG, delay: 0n });
    expect(w.notifications[0].body).toMatchObject({ vault: ADDR.alice, kind: "FLAG", requestId: "1" });
    expect(w.notifications[0].secrets).toEqual(["notifyApiKey"]);
  });

  test("long delay notifies with kind DELAY", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request({ amount: 400_000_000000n }));
    run(w, [{ vault: ADDR.alice, requestId: 1n }]);
    expect(w.writes[0].reportType).toBe(P.REPORT_SET_DELAY);
    expect(w.writes[0].delay).toBeGreaterThanOrEqual(24n * 3600n); // over the Hard cap → ≥ CapDelay
    expect(w.notifications[0].body.kind).toBe("DELAY");
  });

  test("skips: unknown, closed, already scored, fast-tracked, inactive Vault, hash mismatch", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.alice, fakeVault());
    v.requests.set(2n, request({ state: P.REQ_EXECUTED }));
    v.requests.set(3n, request({ scored: true }));
    v.requests.set(4n, request({ fastTracked: true }));
    v.requests.set(5n, request());
    addVault(w, ADDR.nvidia, fakeVault(), P.STATUS_FROZEN).requests.set(1n, request());
    const refs = [1n, 2n, 3n, 4n].map((requestId) => ({ vault: ADDR.alice, requestId }));
    const { out } = run(w, [...refs, { vault: ADDR.nvidia, requestId: 1n }, { vault: ADDR.alice, requestId: 5n }], {
      expectedHash: new Map([[`${ADDR.alice.toLowerCase()}:5`, `0x${"99".repeat(32)}` as const]]),
    });
    expect(out.map((o) => o.outcome)).toEqual([
      "SKIP_UNKNOWN_REQUEST",
      "SKIP_CLOSED",
      "SKIP_SCORED",
      "SKIP_FAST_TRACKED",
      "SKIP_VAULT_INACTIVE",
      "SKIP_HASH_MISMATCH",
    ]);
    expect(w.writes).toHaveLength(0);
  });

  test("FLAG beats a fast-track (majority YES cannot outvote a blocklisted destination)", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request({ fastTracked: true, reasonCodes: P.BLOCKLISTED_DEST }));
    run(w, [{ vault: ADDR.alice, requestId: 1n }]);
    expect(w.writes[0].reportType).toBe(P.REPORT_FLAG);
  });

  test("rescore re-writes an already scored request", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault({ configChangePending: true })).requests.set(1n, request({ scored: true }));
    const { out } = run(w, [{ vault: ADDR.alice, requestId: 1n }], { rescore: true });
    expect(out[0].outcome).toBe("WRITTEN");
    expect(w.writes[0].reasonCodes & P.CONFIG_CHANGE_PENDING).toBe(P.CONFIG_CHANGE_PENDING);
  });

  test("write budget caps writes per run", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.alice, fakeVault());
    for (let i = 1n; i <= 3n; i++) v.requests.set(i, request({ amount: 1000_000000n + i }));
    const { out } = run(w, [1n, 2n, 3n].map((requestId) => ({ vault: ADDR.alice, requestId })), {}, { ...cfg, maxWritesPerRun: 2 });
    expect(out.map((o) => o.outcome)).toEqual(["WRITTEN", "WRITTEN", "SKIP_WRITE_BUDGET"]);
  });

  test("a failed read writes nothing (unsure → the Vault's MaxDelay default stands)", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request());
    w.failing.add(`${ADDR.alice.toLowerCase()}:scoringContext`);
    const { out } = run(w, [{ vault: ADDR.alice, requestId: 1n }]);
    expect(out[0].outcome).toBe("SKIP_UNKNOWN_REQUEST");
    expect(w.writes).toHaveLength(0);
  });

  test("deterministic: two runs produce identical report bytes", () => {
    const a = newWorld();
    addVault(a, ADDR.alice, fakeVault()).requests.set(1n, request({ amount: 7_777_000000n }));
    run(a, [{ vault: ADDR.alice, requestId: 1n }]);
    const b = newWorld();
    addVault(b, ADDR.alice, fakeVault()).requests.set(1n, request({ amount: 7_777_000000n }));
    run(b, [{ vault: ADDR.alice, requestId: 1n }]);
    expect(encodeReport(a.writes[0])).toBe(encodeReport(b.writes[0]));
  });
});
