/**
 * Reconciler (ADR-0003): the shared cron workflow that keeps every Vault scored and the network honest.
 * Each pass (every 1–2 min):
 *   1. Vault health over a page of Vaults: reserves < supply → RESERVE_FLAG; a wallet delegated (EIP-7702)
 *      to an unapproved target → DELEGATION_FLAG.
 *   2. Unscored pending requests from the batched Hub.openRequests view, largest amount first (flood
 *      defence), scored with the same Deviation model as the Sentinel: a missed log or dropped write lands
 *      here. Fast-tracked requests are skipped (the majority already decided).
 *   3. Heartbeat report (always; one write slot is reserved for it).
 * Orbital settlement (brief §8.4) joins this pass with #34.
 */
import {
  CronCapability,
  EVMClient,
  getNetwork,
  handler,
  Runner,
  type CronPayload,
  type Runtime,
} from "@chainlink/cre-sdk";
import type { Address, Hex } from "viem";
import { hubAbi } from "../shared/abi";
import { Chain, type Call } from "../shared/chain";
import { normalizeAddresses } from "../shared/config";
import { flagVaults, inspectVaults } from "../shared/health";
import type { Params } from "../shared/deviation";
import type { NotifyConfig } from "../shared/notify";
import * as P from "../shared/palm";
import { deriveNonce, writeReport } from "../shared/report";
import { key, scoreAndWrite, type ScoringConfig } from "../shared/scoring";

export type Config = {
  schedule: string;
  chainSelectorName: string;
  chainId: number;
  hub: Address;
  multicall3: Address;
  reportTtlSeconds: number;
  gasLimit: string;
  /** Total reports per pass, heartbeat included. */
  maxWritesPerRun: number;
  /** Requests scored per pass (largest amount first). */
  maxScorePerRun: number;
  /** Vaults covered per pass (one Hub page). */
  vaultPageSize: number;
  scoring: Params;
  notifyDelaySeconds: number;
  notify: NotifyConfig;
};

const evmFor = (config: Config) => {
  const net = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName });
  if (!net) throw new Error(`unknown chain ${config.chainSelectorName}`);
  return new EVMClient(net.chainSelector.selector);
};

type OpenRow = {
  vault: Address;
  requestId: bigint;
  amount: bigint;
  state: number;
  scored: boolean;
  fastTracked: boolean;
  executableAt: bigint;
  requestHash: Hex;
};

/** Largest amount first; ties broken by vault then id so every node orders identically. */
export const byPriority = (a: OpenRow, b: OpenRow) =>
  a.amount !== b.amount
    ? a.amount > b.amount
      ? -1
      : 1
    : a.vault.toLowerCase() !== b.vault.toLowerCase()
      ? a.vault.toLowerCase() < b.vault.toLowerCase()
        ? -1
        : 1
      : a.requestId < b.requestId
        ? -1
        : a.requestId > b.requestId
          ? 1
          : 0;

export const onCron = (runtime: Runtime<Config>, payload: CronPayload): string => {
  const cfg = normalizeAddresses(runtime.config);
  const evm = evmFor(cfg);
  const chain = new Chain(runtime, evm, cfg.multicall3);
  const scfg: ScoringConfig = {
    hub: cfg.hub,
    reportTtlSeconds: cfg.reportTtlSeconds,
    gasLimit: cfg.gasLimit,
    maxWritesPerRun: cfg.maxWritesPerRun,
    scoring: cfg.scoring,
    notifyDelaySeconds: cfg.notifyDelaySeconds,
    notify: cfg.notify,
  };
  const slot = payload.scheduledExecutionTime?.seconds ?? BigInt(Math.floor(runtime.now().getTime() / 1000));
  const nonceSeed = `reconciler:${slot}`;
  const header = chain.blockTimestamp();
  // Report expiry from the block header; the scheduled slot when the header read fails.
  const now = header?.timestamp ?? slot;
  let budget = Math.max(0, cfg.maxWritesPerRun - 1); // one slot reserved for the heartbeat
  const summary: Record<string, unknown> = { slot: slot.toString() };

  // --- Read A: Vault page and open requests (one EVM call) ---
  const pageSize = BigInt(cfg.vaultPageSize);
  const ra = chain.multicall([
    { to: cfg.hub, abi: hubAbi, functionName: "getVaults", args: [0n, pageSize] },
    { to: cfg.hub, abi: hubAbi, functionName: "openRequests", args: [0n, pageSize] },
  ] satisfies Call[]);
  const vaults = (ra[0] as readonly Address[] | undefined) ?? [];
  const open = (ra[1] as readonly OpenRow[] | undefined) ?? [];
  summary.vaults = vaults.length;

  // --- 1. Vault health ---
  const findings = flagVaults(runtime, chain, scfg, inspectVaults(chain, cfg.hub, [...vaults]), {
    blockTimestamp: now,
    nonceSeed,
    writeBudget: budget,
  });
  budget -= findings.filter((f) => f.write).length;
  const flagged = new Set(findings.filter((f) => f.write?.ok).map((f) => f.vault.toLowerCase()));
  summary.health = findings.map(
    (f) => `${f.vault} ${f.reportType === P.REPORT_RESERVE_FLAG ? "RESERVE_FLAG" : "DELEGATION_FLAG"} ${f.write?.ok ? "WRITTEN" : (f.skipped ?? "WRITE_FAILED")}`,
  );

  // --- 2. Unscored requests, largest amount first ---
  const unscored = open
    .filter((r) => r.state === P.REQ_PENDING && !r.scored && !r.fastTracked && !flagged.has(r.vault.toLowerCase()))
    .slice()
    .sort(byPriority)
    .slice(0, cfg.maxScorePerRun);
  if (unscored.length > 0 && budget > 0) {
    const scored = scoreAndWrite(
      runtime,
      chain,
      { ...scfg, maxWritesPerRun: budget },
      unscored.map((r) => ({ vault: r.vault, requestId: r.requestId })),
      {
        blockTimestamp: now,
        nonceSeed,
        expectedHash: new Map(unscored.map((r) => [key(r), r.requestHash])),
      },
    );
    budget -= scored.filter((s) => s.write).length;
    summary.requests = scored.map(
      (s) => `${s.ref.vault}#${s.ref.requestId} ${s.assessment?.action ?? "-"} ${s.outcome}`,
    );
  } else summary.requests = [];

  // --- 3. Heartbeat ---
  const hb = writeReport(runtime, evm, cfg.hub, {
    reportType: P.REPORT_HEARTBEAT,
    vault: "0x0000000000000000000000000000000000000000",
    requestId: 0n,
    requestHash: `0x${"0".repeat(64)}`,
    delay: 0n,
    score: 0,
    reasonCodes: 0n,
    expiry: now + BigInt(cfg.reportTtlSeconds),
    nonce: deriveNonce(nonceSeed, "heartbeat"),
  }, cfg.gasLimit);
  summary.heartbeat = hb.ok ? "WRITTEN" : `FAILED ${hb.txStatus}${hb.receiverReverted ? " receiverReverted" : ""}`;
  summary.evmCalls = chain.calls;

  const out = JSON.stringify(summary);
  runtime.log(out);
  return out;
};

export const initWorkflow = (config: Config) => [
  handler(new CronCapability().trigger({ schedule: config.schedule }), onCron),
];

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
