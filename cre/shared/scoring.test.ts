import { describe, expect } from "bun:test";
import { EVMClient } from "@chainlink/cre-sdk";
import { newTestRuntime, test } from "@chainlink/cre-sdk/test";
import type { Address, Hex } from "viem";
import { Chain } from "./chain";
import * as P from "./palm";
import { encodeReport, decodeReport } from "./report";
import { ecrecoverInput, payoutDigest, scoreAndWrite, shouldWrite, type ScoringConfig } from "./scoring";
import { ADDR, addVault, fakeVault, installWorld, newWorld, request, SEPOLIA, T_02H, T_14H, type World } from "./testing";

const cfg: ScoringConfig = {
  chainId: 11155111,
  hub: ADDR.hub,
  reportTtlSeconds: 600,
  gasLimit: "500000",
  maxWritesPerRun: 5,
  notify: { url: "https://palmfi.example/api/notify", apiKeySecret: "notifyApiKey" },
};

const run = (w: World, refs: { vault: Address; requestId: bigint }[], ts: bigint | undefined = T_14H) => {
  installWorld(w);
  const runtime = newTestRuntime();
  const chain = new Chain(runtime, new EVMClient(SEPOLIA), ADDR.multicall3);
  const out = scoreAndWrite(runtime, chain, cfg, refs, { blockTimestamp: ts, nonceSeed: "test" });
  return { out, chain };
};

const SIG = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as Hex;

describe("report encoding", () => {
  test("round-trips PalmTypes.Report", () => {
    const r: P.Report = {
      reportType: P.REPORT_VERDICT,
      vault: ADDR.alice,
      requestId: 7n,
      requestHash: `0x${"ab".repeat(32)}`,
      verdict: P.VERDICT_FLAG,
      reasonCodes: P.BLOCKLISTED_DEST | P.NEW_DESTINATION,
      expiry: 123n,
      nonce: 456n,
    };
    const enc = encodeReport(r);
    expect((enc.length - 2) / 2).toBe(8 * 32); // static struct: 8 words, same as Hub.decodeReport
    expect(decodeReport(enc)).toEqual({ ...r, vault: r.vault });
  });
});

describe("ecrecover input", () => {
  test("hash ‖ v ‖ r ‖ s", () => {
    const d = `0x${"cd".repeat(32)}` as Hex;
    const x = ecrecoverInput(d, SIG)!;
    expect(x.length).toBe(2 + 128 * 2);
    expect(x.slice(2, 66)).toBe("cd".repeat(32));
    expect(BigInt(`0x${x.slice(66, 130)}`)).toBe(27n);
  });
  test("v of 0/1 is normalised to 27/28", () => {
    const x = ecrecoverInput(`0x${"00".repeat(32)}`, `0x${"11".repeat(64)}01`)!;
    expect(BigInt(`0x${x.slice(66, 130)}`)).toBe(28n);
  });
  test("non-65-byte signatures are refused", () => {
    expect(ecrecoverInput(`0x${"00".repeat(32)}`, "0x1234")).toBeUndefined();
  });
});

describe("write policy", () => {
  const d = (verdict: P.Verdict, reasonCodes = 0n) => ({ verdict, reasonCodes, missing: [] });
  test("pending takes any verdict", () => {
    for (const v of [P.VERDICT_CLEAR, P.VERDICT_HOLD, P.VERDICT_FLAG] as const)
      expect(shouldWrite(request(), d(v))).toBe(true);
  });
  test("cleared only takes a FLAG", () => {
    const r = request({ state: P.REQ_CLEARED });
    expect(shouldWrite(r, d(P.VERDICT_FLAG))).toBe(true);
    expect(shouldWrite(r, d(P.VERDICT_CLEAR))).toBe(false);
    expect(shouldWrite(r, d(P.VERDICT_HOLD))).toBe(false);
  });
  test("held takes CLEAR, FLAG, or a HOLD with new reasons", () => {
    const r = request({ state: P.REQ_HELD, reasonCodes: P.NEW_DESTINATION });
    expect(shouldWrite(r, d(P.VERDICT_CLEAR))).toBe(true);
    expect(shouldWrite(r, d(P.VERDICT_HOLD, P.NEW_DESTINATION))).toBe(false);
    expect(shouldWrite(r, d(P.VERDICT_HOLD, P.ORACLE_STALE))).toBe(true);
  });
  test("terminal states take nothing", () => {
    for (const s of [P.REQ_FLAGGED, P.REQ_EXECUTED, P.REQ_CANCELLED, P.REQ_EXPIRED])
      expect(shouldWrite(request({ state: s }), d(P.VERDICT_FLAG))).toBe(false);
  });
});

describe("scoreAndWrite", () => {
  test("CLEAR is written after a FINALIZED re-read, within the EVM call budget", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.alice, fakeVault());
    v.requests.set(1n, request());
    const { out, chain } = run(w, [{ vault: ADDR.alice, requestId: 1n }]);
    expect(out[0].outcome).toBe("WRITTEN");
    expect(w.writes).toHaveLength(1);
    expect(w.writes[0].verdict).toBe(P.VERDICT_CLEAR);
    expect(w.writes[0].requestHash).toBe(v.requests.get(1n)!.requestHash);
    expect(w.writes[0].expiry).toBe(T_14H + 600n);
    expect(chain.calls).toBeLessThanOrEqual(4);
    expect(w.notifications).toHaveLength(0); // no notification on CLEAR
  });

  test("CLEAR is deferred while the request is not yet final", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.alice, fakeVault());
    v.requests.set(1n, request());
    v.finalized = new Map(); // request newer than the finalized block
    const { out } = run(w, [{ vault: ADDR.alice, requestId: 1n }]);
    expect(out[0].outcome).toBe("DEFER_FINALITY");
    expect(w.writes).toHaveLength(0);
  });

  test("CLEAR is deferred when the finalized request has a different hash (reorg replaced it)", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.alice, fakeVault());
    v.requests.set(1n, request());
    v.finalized = new Map([[1n, request({ requestHash: `0x${"99".repeat(32)}` })]]);
    expect(run(w, [{ vault: ADDR.alice, requestId: 1n }]).out[0].outcome).toBe("DEFER_FINALITY");
  });

  test("FLAG is written at LATEST without waiting for finality, and the Owner is notified", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.alice, fakeVault());
    v.requests.set(1n, request({ destination: ADDR.attacker }));
    v.finalized = new Map();
    w.blocked.add(ADDR.attacker.toLowerCase());
    const { out } = run(w, [{ vault: ADDR.alice, requestId: 1n }]);
    expect(out[0].outcome).toBe("WRITTEN");
    expect(w.writes[0].verdict).toBe(P.VERDICT_FLAG);
    expect(w.notifications).toHaveLength(1);
    const n = w.notifications[0];
    expect(n.body).toEqual({
      vault: ADDR.alice,
      kind: "FLAG",
      requestId: "1",
      reasonCodes: (w.writes[0].reasonCodes).toString(),
    });
    expect(n.headers["x-api-key"]).toEqual(["{{.notifyApiKey}}"]);
    expect(n.secrets).toEqual(["notifyApiKey"]);
  });

  test("HOLD notifies with kind HOLD", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request({ destination: ADDR.exchange }));
    run(w, [{ vault: ADDR.alice, requestId: 1n }]);
    expect(w.writes[0].verdict).toBe(P.VERDICT_HOLD);
    expect((w.notifications[0].body as { kind: string }).kind).toBe("HOLD");
  });

  test("a reverted onReport is a failed write (receiverContractExecutionStatus), and nobody is notified", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request({ destination: ADDR.exchange }));
    w.writeReply = { txStatus: "TX_STATUS_SUCCESS", receiverReverted: true };
    const { out } = run(w, [{ vault: ADDR.alice, requestId: 1n }]);
    expect(out[0].outcome).toBe("WRITE_FAILED");
    expect(out[0].write!.receiverReverted).toBe(true);
    expect(w.notifications).toHaveLength(0);
  });

  test("a failed tx is a failed write", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request({ destination: ADDR.exchange }));
    w.writeReply = { txStatus: "TX_STATUS_REVERTED", receiverReverted: false };
    expect(run(w, [{ vault: ADDR.alice, requestId: 1n }]).out[0].outcome).toBe("WRITE_FAILED");
  });

  test("an unknown request is skipped", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault());
    expect(run(w, [{ vault: ADDR.alice, requestId: 9n }]).out[0].outcome).toBe("SKIP_UNKNOWN_REQUEST");
    expect(w.writes).toHaveLength(0);
  });

  test("a frozen Vault's requests are skipped", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault(), P.STATUS_FROZEN).requests.set(1n, request());
    expect(run(w, [{ vault: ADDR.alice, requestId: 1n }]).out[0].outcome).toBe("SKIP_VAULT_INACTIVE");
  });

  test("RPC down: every read fails → nothing is CLEARed", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request());
    w.failing.add("*");
    const { out } = run(w, [{ vault: ADDR.alice, requestId: 1n }]);
    expect(out[0].outcome).toBe("SKIP_UNKNOWN_REQUEST");
    expect(w.writes).toHaveLength(0);
  });

  test("one failed sub-read → HOLD with API_UNAVAILABLE", () => {
    const w = newWorld();
    addVault(w, ADDR.alice, fakeVault()).requests.set(1n, request());
    w.failing.add(`${ADDR.alice.toLowerCase()}:delegations`);
    run(w, [{ vault: ADDR.alice, requestId: 1n }]);
    expect(w.writes[0].verdict).toBe(P.VERDICT_HOLD);
    expect(w.writes[0].reasonCodes & P.API_UNAVAILABLE).toBe(P.API_UNAVAILABLE);
  });

  test("write budget caps reports per run", () => {
    const w = newWorld();
    const v = addVault(w, ADDR.alice, fakeVault({ institution: true, hardCap: 10n ** 12n }));
    const refs = [];
    for (let i = 1n; i <= 7n; i++) {
      v.requests.set(i, request({ amount: i, destination: ADDR.exchange }));
      refs.push({ vault: ADDR.alice as Address, requestId: i });
    }
    const { out } = run(w, refs);
    expect(w.writes).toHaveLength(5);
    expect(out.filter((o) => o.outcome === "SKIP_WRITE_BUDGET")).toHaveLength(2);
  });
});

describe("Institution Payout approvals (ApprovalBook + ecrecover)", () => {
  const setup = (sigSigner: Address | undefined, over: Partial<{ amount: bigint; expiry: bigint }> = {}) => {
    const w = newWorld();
    const v = addVault(
      w,
      ADDR.nvidia,
      fakeVault({ institution: true, hardCap: 1000_000000n, bizStartHourUtc: 9, bizEndHourUtc: 17, usualMaxPayout: 500_000000n }),
    );
    const r = request({ usdValue: 12_000000n, destination: ADDR.friend });
    v.requests.set(1n, r);
    w.approvals.set(`${ADDR.nvidia.toLowerCase()}:${r.requestHash.toLowerCase()}`, {
      requestId: 1n,
      amount: over.amount ?? r.amount,
      asset: r.asset,
      destination: r.destination,
      expiry: over.expiry ?? T_14H + 3600n,
      signature: SIG,
    });
    if (sigSigner) w.signers.set(SIG.toLowerCase(), sigSigner);
    return w;
  };

  test("payroll with an Approver-signed Payout approval CLEARs", () => {
    const w = setup(ADDR.approver);
    run(w, [{ vault: ADDR.nvidia, requestId: 1n }]);
    expect(w.writes[0].verdict).toBe(P.VERDICT_CLEAR);
  });
  test("an approval signed by someone else is NO_APPROVED_PAYOUT", () => {
    const w = setup(ADDR.attacker);
    run(w, [{ vault: ADDR.nvidia, requestId: 1n }]);
    expect(w.writes[0].verdict).toBe(P.VERDICT_HOLD);
    expect(w.writes[0].reasonCodes & P.NO_APPROVED_PAYOUT).toBe(P.NO_APPROVED_PAYOUT);
  });
  test("an approval for a different amount is NO_APPROVED_PAYOUT", () => {
    const w = setup(ADDR.approver, { amount: 1n });
    run(w, [{ vault: ADDR.nvidia, requestId: 1n }]);
    expect(w.writes[0].reasonCodes & P.NO_APPROVED_PAYOUT).toBe(P.NO_APPROVED_PAYOUT);
  });
  test("an expired approval is NO_APPROVED_PAYOUT", () => {
    const w = setup(ADDR.approver, { expiry: T_14H - 1n });
    run(w, [{ vault: ADDR.nvidia, requestId: 1n }]);
    expect(w.writes[0].reasonCodes & P.NO_APPROVED_PAYOUT).toBe(P.NO_APPROVED_PAYOUT);
  });
  test("off-hours by block time", () => {
    const w = setup(undefined);
    run(w, [{ vault: ADDR.nvidia, requestId: 1n }], T_02H);
    expect(w.writes[0].reasonCodes & P.OFF_HOURS).toBe(P.OFF_HOURS);
  });
  test("the digest is a 32-byte EIP-712 hash (cross-checked against ApprovalBook only on a fork)", () => {
    const d = payoutDigest(11155111, ADDR.book, ADDR.nvidia, `0x${"00".repeat(32)}`, 1n, ADDR.usdc, ADDR.friend, 1n);
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
