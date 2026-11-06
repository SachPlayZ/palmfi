/**
 * Score queued requests end to end: read every request's ScoringContext and its Vault's status in ONE
 * Multicall3 call, run the pure deviation model, write SET_DELAY or FLAG reports, notify every Voter on
 * FLAG and on long delays. Shared by the Sentinel (one request per log) and the Reconciler (unscored ones).
 *
 * Arc has deterministic (BFT) finality, so there is no finality re-read: a scored request is final.
 * EVM budget per invocation: 1 multicall + 1 write per report (capped by maxWritesPerRun).
 */
import type { Runtime } from "@chainlink/cre-sdk";
import type { Address, Hex } from "viem";
import { hubAbi, vaultAbi } from "./abi";
import type { Call, Chain } from "./chain";
import { assess, type Assessment, type Params, type ScoringContext } from "./deviation";
import { notify, type NotifyConfig } from "./notify";
import * as P from "./palm";
import { deriveNonce, writeReport, type WriteResult } from "./report";

export type ScoringConfig = {
  hub: Address;
  reportTtlSeconds: number;
  gasLimit: string;
  maxWritesPerRun: number;
  /** Deviation model parameters (milli-bits). */
  scoring: Params;
  /** Notify Voters when the delay is at least this long (seconds). */
  notifyDelaySeconds: number;
  notify: NotifyConfig;
};

export type Ref = { vault: Address; requestId: bigint };

export type Outcome =
  | "WRITTEN"
  | "WRITE_FAILED"
  | "SKIP_UNKNOWN_REQUEST"
  | "SKIP_CLOSED"
  | "SKIP_SCORED"
  | "SKIP_FAST_TRACKED"
  | "SKIP_VAULT_INACTIVE"
  | "SKIP_HASH_MISMATCH"
  | "SKIP_WRITE_BUDGET";

export type Scored = {
  ref: Ref;
  outcome: Outcome;
  assessment?: Assessment;
  context?: ScoringContext;
  write?: WriteResult;
};

export type ScoreOptions = {
  /** Block timestamp for report expiry (from a block header). */
  blockTimestamp: bigint;
  /** Deterministic nonce seed (trigger tx hash + log index, or cron slot). */
  nonceSeed: string;
  /** Request hash the trigger carried; a request whose onchain hash differs is skipped. */
  expectedHash?: Map<string, Hex>;
  /** Re-score requests that already carry a score (CONFIG_CHANGE re-score). FLAG is written either way. */
  rescore?: boolean;
};

export const key = (r: Ref) => `${r.vault.toLowerCase()}:${r.requestId}`;

/** One multicall: hub.statusOf per Vault, then vault.scoringContext per ref. */
export function readContexts(chain: Chain, hub: Address, refs: Ref[]) {
  const vaults = [...new Set(refs.map((r) => r.vault.toLowerCase()))] as Address[];
  const calls: Call[] = [
    ...vaults.map((v) => ({ to: hub, abi: hubAbi, functionName: "statusOf", args: [v] })),
    ...refs.map((r) => ({ to: r.vault, abi: vaultAbi, functionName: "scoringContext", args: [r.requestId] })),
  ];
  const out = chain.multicall(calls);
  const status = new Map<string, number | undefined>(vaults.map((v, i) => [v, out[i] as number | undefined]));
  return refs.map((ref, i) => ({
    ref,
    status: status.get(ref.vault.toLowerCase()),
    ctx: out[vaults.length + i] as ScoringContext | undefined,
  }));
}

/** Read, score, write and notify. */
export function scoreAndWrite(runtime: Runtime<unknown>, chain: Chain, cfg: ScoringConfig, refs: Ref[], opts: ScoreOptions): Scored[] {
  const results: Scored[] = [];
  let writes = 0;
  for (const { ref, status, ctx } of readContexts(chain, cfg.hub, refs)) {
    const req = ctx?.request;
    if (!ctx || !req || req.state === P.REQ_NONE) {
      results.push({ ref, outcome: "SKIP_UNKNOWN_REQUEST" });
      continue;
    }
    const expected = opts.expectedHash?.get(key(ref));
    if (expected && expected.toLowerCase() !== req.requestHash.toLowerCase()) {
      results.push({ ref, outcome: "SKIP_HASH_MISMATCH", context: ctx });
      continue;
    }
    if (req.state !== P.REQ_PENDING) {
      results.push({ ref, outcome: "SKIP_CLOSED", context: ctx });
      continue;
    }
    if (status !== P.STATUS_ACTIVE) {
      results.push({ ref, outcome: "SKIP_VAULT_INACTIVE", context: ctx });
      continue;
    }
    const a = assess(ctx, cfg.scoring);
    const r: Scored = { ref, outcome: "WRITTEN", assessment: a, context: ctx };
    results.push(r);
    // A majority fast-track beats any delay (the Vault rejects SET_DELAY), but FLAG still freezes.
    if (a.action !== "FLAG" && req.fastTracked) {
      r.outcome = "SKIP_FAST_TRACKED";
      continue;
    }
    if (a.action !== "FLAG" && req.scored && !opts.rescore) {
      r.outcome = "SKIP_SCORED";
      continue;
    }
    if (writes >= cfg.maxWritesPerRun) {
      r.outcome = "SKIP_WRITE_BUDGET";
      continue;
    }
    writes++;
    const report: P.Report = {
      reportType: a.action === "FLAG" ? P.REPORT_FLAG : P.REPORT_SET_DELAY,
      vault: ref.vault,
      requestId: ref.requestId,
      requestHash: req.requestHash,
      delay: a.action === "FLAG" ? 0n : a.delay,
      score: a.score,
      reasonCodes: a.reasonCodes,
      expiry: opts.blockTimestamp + BigInt(cfg.reportTtlSeconds),
      nonce: deriveNonce(opts.nonceSeed, key(ref), a.action, a.score),
    };
    r.write = writeReport(runtime, chain.evm, cfg.hub, report, cfg.gasLimit);
    r.outcome = r.write.ok ? "WRITTEN" : "WRITE_FAILED";
    runtime.log(
      `${a.action} ${key(ref)} score=${a.score}mb delay=${a.delay}s scope=${a.scope} ` +
        `terms=${JSON.stringify(a.terms)} codes=[${P.reasonNames(a.reasonCodes).join(",")}] ` +
        `tx=${r.write.txStatus} receiverReverted=${r.write.receiverReverted}${r.write.error ? ` err=${r.write.error}` : ""}`,
    );
    if (r.write.ok && (a.action === "FLAG" || a.delay >= BigInt(cfg.notifyDelaySeconds))) {
      notify(runtime, cfg.notify, {
        vault: ref.vault,
        kind: a.action === "FLAG" ? "FLAG" : "DELAY",
        requestId: ref.requestId,
        reasonCodes: a.reasonCodes,
        score: a.score,
        delay: a.delay,
      });
    }
  }
  return results;
}
