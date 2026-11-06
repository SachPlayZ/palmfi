/**
 * Score Queued requests end to end: read facts (batched), run the pure engine, apply the write policy,
 * re-read every CLEAR candidate at FINALIZED, write VERDICT reports and notify on HOLD/FLAG.
 * Shared by the Sentinel (one request per log) and the Reconciler (undecided requests, largest USD first).
 *
 * EVM call budget per invocation, independent of the number of requests:
 *   1 phase-1 multicall (vault facts + getRequest) · 1 phase-2 multicall (destination/asset/approval facts)
 *   · ≤1 ecrecover multicall (Institution approvals) · ≤1 FINALIZED multicall (CLEAR candidates)
 *   + the caller's header read. Writes are separate (one per report).
 */
import type { Runtime } from "@chainlink/cre-sdk";
import { hashTypedData, isAddressEqual, zeroAddress, type Address, type Hex } from "viem";
import { approvalBookAbi, ECRECOVER, hubAbi, vaultAbi } from "./abi";
import type { Call, Chain } from "./chain";
import { decide, type Decision, type RequestFacts } from "./engine";
import { notify, type NotifyConfig } from "./notify";
import * as P from "./palm";
import { deriveNonce, writeReport, type WriteResult } from "./report";

export type ScoringConfig = {
  chainId: number;
  hub: Address;
  reportTtlSeconds: number;
  gasLimit: string;
  maxWritesPerRun: number;
  notify: NotifyConfig;
};

export type Ref = { vault: Address; requestId: bigint };

export type OnchainRequest = {
  asset: Address;
  destination: Address;
  requester: Address;
  amount: bigint;
  usdValue: bigint;
  createdAt: bigint;
  executableAt: bigint;
  state: number;
  asWeth: boolean;
  secondFactor: boolean;
  recoveryApproved: boolean;
  reasonCodes: bigint;
  requestHash: Hex;
};

export type Outcome =
  | "WRITTEN"
  | "WRITE_FAILED"
  | "SKIP_UNKNOWN_REQUEST"
  | "SKIP_CLOSED"
  | "SKIP_VAULT_INACTIVE"
  | "SKIP_HASH_MISMATCH"
  | "SKIP_UNCHANGED"
  | "SKIP_WRITE_BUDGET"
  | "DEFER_FINALITY";

export type Scored = {
  ref: Ref;
  outcome: Outcome;
  decision?: Decision;
  request?: OnchainRequest;
  write?: WriteResult;
};

const OPEN = new Set([P.REQ_PENDING, P.REQ_CLEARED, P.REQ_HELD]);

/** Whether a fresh decision should be written over the request's current onchain state. */
export function shouldWrite(req: OnchainRequest, d: Decision): boolean {
  if (!OPEN.has(req.state)) return false;
  if (d.verdict === P.VERDICT_FLAG) return true; // FLAG applies to any open request, including Cleared
  if (req.state === P.REQ_CLEARED) return false; // CLEAR→HOLD is rejected onchain; CLEAR→CLEAR is a no-op
  if (req.state === P.REQ_PENDING) return true;
  // Held: write a CLEAR (re-score after a Second factor), or a HOLD whose reasons changed.
  return d.verdict === P.VERDICT_CLEAR || d.reasonCodes !== req.reasonCodes;
}

const vaultCalls = (hub: Address, v: Address): Call[] => [
  { to: v, abi: vaultAbi, functionName: "institution" },
  { to: v, abi: vaultAbi, functionName: "hardCap" },
  { to: v, abi: vaultAbi, functionName: "sensitivePending" },
  { to: v, abi: vaultAbi, functionName: "bizStartHourUtc" },
  { to: v, abi: vaultAbi, functionName: "bizEndHourUtc" },
  { to: v, abi: vaultAbi, functionName: "usualMaxPayout" },
  { to: v, abi: vaultAbi, functionName: "approvalBook" },
  { to: v, abi: vaultAbi, functionName: "approver" },
  { to: v, abi: vaultAbi, functionName: "delegations" },
  { to: v, abi: vaultAbi, functionName: "reserves" },
  { to: hub, abi: hubAbi, functionName: "statusOf", args: [v] },
];

type VaultFacts = {
  institution?: boolean;
  hardCap?: bigint;
  sensitivePending?: bigint;
  bizStartHourUtc?: number;
  bizEndHourUtc?: number;
  usualMaxPayout?: bigint;
  approvalBook?: Address;
  approver?: Address;
  delegationsOk?: boolean;
  reservesOk?: boolean;
  status?: number;
};

export const delegationsOk = (d: readonly [readonly Address[], readonly Address[], readonly boolean[]] | undefined) =>
  d === undefined ? undefined : d[2].every(Boolean);

export const reservesOk = (r: readonly [readonly Address[], readonly bigint[], readonly bigint[]] | undefined) =>
  r === undefined ? undefined : r[1].every((held, i) => held >= r[2][i]);

const toVaultFacts = (r: unknown[]): VaultFacts => ({
  institution: r[0] as boolean | undefined,
  hardCap: r[1] as bigint | undefined,
  sensitivePending: r[2] as bigint | undefined,
  bizStartHourUtc: r[3] as number | undefined,
  bizEndHourUtc: r[4] as number | undefined,
  usualMaxPayout: r[5] as bigint | undefined,
  approvalBook: r[6] as Address | undefined,
  approver: r[7] as Address | undefined,
  delegationsOk: delegationsOk(r[8] as never),
  reservesOk: reservesOk(r[9] as never),
  status: r[10] as number | undefined,
});

type Approval = {
  requestId: bigint;
  amount: bigint;
  asset: Address;
  destination: Address;
  expiry: bigint;
  signature: Hex;
};

/** EIP-712 digest ApprovalBook.payoutDigest computes (domain "palmfi ApprovalBook", version "1"). */
export const payoutDigest = (
  chainId: number,
  book: Address,
  vault: Address,
  requestHash: Hex,
  amount: bigint,
  asset: Address,
  destination: Address,
  expiry: bigint,
): Hex =>
  hashTypedData({
    domain: { name: "palmfi ApprovalBook", version: "1", chainId, verifyingContract: book },
    types: {
      PayoutApproval: [
        { name: "vault", type: "address" },
        { name: "requestHash", type: "bytes32" },
        { name: "amount", type: "uint256" },
        { name: "asset", type: "address" },
        { name: "destination", type: "address" },
        { name: "expiry", type: "uint64" },
      ],
    },
    primaryType: "PayoutApproval",
    message: { vault, requestHash, amount, asset, destination, expiry },
  });

/** ecrecover precompile calldata: hash ‖ v ‖ r ‖ s for a 65-byte (r, s, v) signature. */
export const ecrecoverInput = (digest: Hex, sig: Hex): Hex | undefined => {
  if (sig.length !== 2 + 65 * 2) return undefined;
  const r = sig.slice(2, 66);
  const s = sig.slice(66, 130);
  let v = Number.parseInt(sig.slice(130, 132), 16);
  if (v < 27) v += 27;
  return `0x${digest.slice(2)}${v.toString(16).padStart(64, "0")}${r}${s}`;
};

const matchesRequest = (a: Approval | undefined, ref: Ref, req: OnchainRequest, now: bigint): boolean =>
  a !== undefined &&
  a.signature !== "0x" &&
  a.requestId === ref.requestId &&
  a.amount === req.amount &&
  isAddressEqual(a.asset, req.asset) &&
  isAddressEqual(a.destination, req.destination) &&
  a.expiry >= now;

export type ScoreOptions = {
  /** Block timestamp used for off-hours scoring and report expiry (from a block header). */
  blockTimestamp?: bigint;
  /** Deterministic nonce seed (trigger tx hash + log index, or cron slot). */
  nonceSeed: string;
  /** Request hash the trigger carried; a request whose onchain hash differs is skipped. */
  expectedHash?: Map<string, Hex>;
};

const key = (r: Ref) => `${r.vault.toLowerCase()}:${r.requestId}`;

/** Read facts for `refs` and return the engine's decision per request, without writing anything. */
export function assess(chain: Chain, cfg: ScoringConfig, refs: Ref[], blockTimestamp?: bigint) {
  const vaults = [...new Set(refs.map((r) => r.vault.toLowerCase()))] as Address[];

  // Phase 1: vault-level facts + every request.
  const p1Calls: Call[] = [
    ...vaults.flatMap((v) => vaultCalls(cfg.hub, v)),
    ...refs.map((r) => ({ to: r.vault, abi: vaultAbi, functionName: "getRequest", args: [r.requestId] })),
  ];
  const p1 = chain.multicall(p1Calls);
  const per = vaultCalls(cfg.hub, zeroAddress).length;
  const vf = new Map<string, VaultFacts>();
  vaults.forEach((v, i) => vf.set(v, toVaultFacts(p1.slice(i * per, (i + 1) * per))));
  const requests = refs.map((_, i) => p1[vaults.length * per + i] as OnchainRequest | undefined);

  // Phase 2: destination, asset and approval facts.
  const p2Calls: Call[] = [];
  const p2Index: { dest: number; blocked: number; mode: number; value: number; book?: number }[] = [];
  refs.forEach((ref, i) => {
    const req = requests[i];
    const f = vf.get(ref.vault.toLowerCase())!;
    if (!req || req.state === P.REQ_NONE) {
      p2Index.push({ dest: -1, blocked: -1, mode: -1, value: -1 });
      return;
    }
    const base = p2Calls.length;
    p2Calls.push(
      { to: ref.vault, abi: vaultAbi, functionName: "isDestination", args: [req.destination] },
      { to: cfg.hub, abi: hubAbi, functionName: "isBlocked", args: [req.destination] },
      { to: ref.vault, abi: vaultAbi, functionName: "marketModeOf", args: [req.asset] },
      { to: ref.vault, abi: vaultAbi, functionName: "valueUsd", args: [req.asset, 0n] },
    );
    const idx: (typeof p2Index)[number] = { dest: base, blocked: base + 1, mode: base + 2, value: base + 3 };
    if (f.institution === true && f.approvalBook && !isAddressEqual(f.approvalBook, zeroAddress)) {
      idx.book = p2Calls.length;
      p2Calls.push({ to: f.approvalBook, abi: approvalBookAbi, functionName: "get", args: [ref.vault, req.requestHash] });
    }
    p2Index.push(idx);
  });
  const p2 = chain.multicall(p2Calls);

  // Phase 3: verify posted Payout approvals with the ecrecover precompile.
  const p3Calls: Call[] = [];
  const p3Index = new Map<number, number>();
  refs.forEach((ref, i) => {
    const req = requests[i];
    const idx = p2Index[i];
    const f = vf.get(ref.vault.toLowerCase())!;
    if (!req || idx.book === undefined || blockTimestamp === undefined || !f.approvalBook) return;
    const a = p2[idx.book] as Approval | undefined;
    if (!matchesRequest(a, ref, req, blockTimestamp)) return;
    const digest = payoutDigest(
      cfg.chainId,
      f.approvalBook,
      ref.vault,
      req.requestHash,
      req.amount,
      req.asset,
      req.destination,
      a!.expiry,
    );
    const data = ecrecoverInput(digest, a!.signature);
    if (!data) return;
    p3Index.set(i, p3Calls.length);
    p3Calls.push({ to: ECRECOVER, abi: [], functionName: "", data });
  });
  const p3 = chain.multicall(p3Calls);

  return refs.map((ref, i) => {
    const req = requests[i];
    const f = vf.get(ref.vault.toLowerCase())!;
    const idx = p2Index[i];
    let payoutApproved: boolean | undefined;
    if (f.institution === true && req) {
      if (idx.book === undefined) payoutApproved = undefined;
      else {
        const a = p2[idx.book] as Approval | undefined;
        if (a === undefined) payoutApproved = undefined; // book read failed
        else if (!p3Index.has(i)) payoutApproved = false; // no matching, unexpired approval
        else {
          const out = p3[p3Index.get(i)!] as Hex | undefined;
          if (out === undefined) payoutApproved = undefined;
          else {
            const signer = out.length >= 66 ? (`0x${out.slice(-40)}` as Address) : zeroAddress;
            payoutApproved =
              f.approver !== undefined && !isAddressEqual(signer, zeroAddress) && isAddressEqual(signer, f.approver);
          }
        }
      }
    }
    const value = idx.value >= 0 ? (p2[idx.value] as readonly [bigint, boolean] | undefined) : undefined;
    const facts: RequestFacts = {
      institution: f.institution,
      usdValue: req?.usdValue,
      hardCap: f.hardCap,
      secondFactor: req?.secondFactor,
      requestCodes: req?.reasonCodes ?? 0n,
      isDestination: idx.dest >= 0 ? (p2[idx.dest] as boolean | undefined) : undefined,
      destinationBlocked: idx.blocked >= 0 ? (p2[idx.blocked] as boolean | undefined) : undefined,
      sensitivePending: f.sensitivePending,
      delegationsOk: f.delegationsOk,
      reservesOk: f.reservesOk,
      feedStale: value?.[1],
      marketMode: idx.mode >= 0 ? (p2[idx.mode] as number | undefined) : undefined,
      blockTimestamp,
      bizStartHourUtc: f.bizStartHourUtc,
      bizEndHourUtc: f.bizEndHourUtc,
      usualMaxPayout: f.usualMaxPayout,
      payoutApproved,
    };
    return { ref, request: req, vault: f, facts, decision: decide(facts) };
  });
}

/** Assess, apply the write policy, check finality for CLEARs, write and notify. */
export function scoreAndWrite(runtime: Runtime<unknown>, chain: Chain, cfg: ScoringConfig, refs: Ref[], opts: ScoreOptions): Scored[] {
  const assessed = assess(chain, cfg, refs, opts.blockTimestamp);
  const results: Scored[] = [];
  const toWrite: { a: (typeof assessed)[number]; i: number }[] = [];

  assessed.forEach((a, i) => {
    const { ref, request: req, decision: d } = a;
    if (!req || req.state === P.REQ_NONE) return results.push({ ref, outcome: "SKIP_UNKNOWN_REQUEST" });
    const expected = opts.expectedHash?.get(key(ref));
    if (expected && expected.toLowerCase() !== req.requestHash.toLowerCase())
      return results.push({ ref, outcome: "SKIP_HASH_MISMATCH", request: req, decision: d });
    if (!OPEN.has(req.state)) return results.push({ ref, outcome: "SKIP_CLOSED", request: req, decision: d });
    if (a.vault.status !== undefined && a.vault.status !== P.STATUS_ACTIVE)
      return results.push({ ref, outcome: "SKIP_VAULT_INACTIVE", request: req, decision: d });
    if (!shouldWrite(req, d)) return results.push({ ref, outcome: "SKIP_UNCHANGED", request: req, decision: d });
    toWrite.push({ a, i });
    results.push({ ref, outcome: "WRITTEN", request: req, decision: d }); // provisional, finalized below
  });

  // Fast to freeze, careful to release: re-read every CLEAR candidate at FINALIZED.
  const clears = toWrite.filter((w) => w.a.decision.verdict === P.VERDICT_CLEAR);
  const fin = chain.multicall(
    clears.map((w) => ({ to: w.a.ref.vault, abi: vaultAbi, functionName: "getRequest", args: [w.a.ref.requestId] })),
    "finalized",
  );
  const finalOk = new Set<number>();
  clears.forEach((w, j) => {
    const f = fin[j] as OnchainRequest | undefined;
    if (f && OPEN.has(f.state) && f.requestHash.toLowerCase() === w.a.request!.requestHash.toLowerCase()) finalOk.add(w.i);
  });

  let writes = 0;
  for (const w of toWrite) {
    const r = results.find((x) => x.ref === w.a.ref)!;
    const d = w.a.decision;
    if (d.verdict === P.VERDICT_CLEAR && !finalOk.has(w.i)) {
      r.outcome = "DEFER_FINALITY"; // the Reconciler clears it once the request is final
      continue;
    }
    if (writes >= cfg.maxWritesPerRun) {
      r.outcome = "SKIP_WRITE_BUDGET";
      continue;
    }
    writes++;
    const now = opts.blockTimestamp ?? BigInt(Math.floor(runtime.now().getTime() / 1000));
    const report: P.Report = {
      reportType: P.REPORT_VERDICT,
      vault: w.a.ref.vault,
      requestId: w.a.ref.requestId,
      requestHash: w.a.request!.requestHash,
      verdict: d.verdict,
      reasonCodes: d.reasonCodes,
      expiry: now + BigInt(cfg.reportTtlSeconds),
      nonce: deriveNonce(opts.nonceSeed, key(w.a.ref), d.verdict),
    };
    r.write = writeReport(runtime, chain.evm, cfg.hub, report, cfg.gasLimit);
    r.outcome = r.write.ok ? "WRITTEN" : "WRITE_FAILED";
    runtime.log(
      `verdict ${verdictName(d.verdict)} ${key(w.a.ref)} codes=[${P.reasonNames(d.reasonCodes).join(",")}] ` +
        `tx=${r.write.txStatus} receiverReverted=${r.write.receiverReverted}${r.write.error ? ` err=${r.write.error}` : ""}`,
    );
    if (r.write.ok && d.verdict !== P.VERDICT_CLEAR) {
      notify(runtime, cfg.notify, {
        vault: w.a.ref.vault,
        kind: d.verdict === P.VERDICT_FLAG ? "FLAG" : "HOLD",
        requestId: w.a.ref.requestId,
        reasonCodes: d.reasonCodes,
      });
    }
  }
  return results;
}

export const verdictName = (v: number) =>
  v === P.VERDICT_CLEAR ? "CLEAR" : v === P.VERDICT_HOLD ? "HOLD" : v === P.VERDICT_FLAG ? "FLAG" : "NONE";
