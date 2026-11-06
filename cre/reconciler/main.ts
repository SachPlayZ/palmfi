/**
 * Reconciler (ADR-0003): the shared cron workflow that keeps every Vault decided and the network honest.
 * Each pass (every 1–2 min):
 *   1. Vault health over a page of Vaults: reserves < supply → RESERVE_FLAG; a Hot wallet delegated to an
 *      unapproved target → DELEGATION_FLAG (issue #12, even without any Vault call).
 *   2. Undecided requests from the batched Hub.openRequests view, largest USD first (flood defence), scored
 *      with the same engine as the Sentinel. Pending requests whose Verdict was missed, dropped, or
 *      rejected are re-sent with a fresh nonce; CLEARs deferred by the Sentinel land here once final.
 *   3. Market modes per Underlying: feed staleness, round-over-round move (Volatile), and the 3%
 *      Chainlink-vs-pool deviation via the v4 StateView (Degraded).
 *   4. Heartbeat report (always; one write slot is reserved for it).
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
import { aggregatorV3Abi, hubAbi, stateViewAbi } from "../shared/abi";
import { Chain, type Call } from "../shared/chain";
import { normalizeAddresses } from "../shared/config";
import { flagVaults, inspectVaults } from "../shared/health";
import { marketMode, poolPrice, rescale, type FeedRound } from "../shared/market";
import type { NotifyConfig } from "../shared/notify";
import * as P from "../shared/palm";
import { deriveNonce, writeReport } from "../shared/report";
import { scoreAndWrite, verdictName, type ScoringConfig } from "../shared/scoring";

export type AssetConfig = {
  name: string;
  underlying: Address;
  /** Chainlink USD feed and its own heartbeat (seconds), as configured in the Vault. */
  feed: Address;
  heartbeat: number;
  /** Optional v4 pool used for the deviation check; empty poolId disables it. */
  pool?: {
    stateView: Address;
    poolId: Hex | "";
    /** The pool's other currency, its decimals and its Chainlink USD feed (to express Chainlink in it). */
    quote: Address;
    quoteDecimals: number;
    quoteFeed: Address;
    baseDecimals: number;
  };
};

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
  /** Requests scored per pass (largest USD first). */
  maxScorePerRun: number;
  /** Vaults covered per pass (one Hub page). */
  vaultPageSize: number;
  volatileMoveBps: number;
  assets: AssetConfig[];
  notify: NotifyConfig;
};

const evmFor = (config: Config) => {
  const net = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName });
  if (!net) throw new Error(`unknown chain ${config.chainSelectorName}`);
  return new EVMClient(net.chainSelector.selector);
};

type OpenRow = { vault: Address; requestId: bigint; usdValue: bigint; state: number; requestHash: Hex };

/** Largest USD first; ties broken by vault then id so every node orders identically. */
export const byPriority = (a: OpenRow, b: OpenRow) =>
  a.usdValue !== b.usdValue
    ? a.usdValue > b.usdValue
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

type Round = readonly [bigint, bigint, bigint, bigint, bigint];

export const onCron = (runtime: Runtime<Config>, payload: CronPayload): string => {
  const cfg = normalizeAddresses(runtime.config);
  const evm = evmFor(cfg);
  const chain = new Chain(runtime, evm, cfg.multicall3);
  const scfg: ScoringConfig = {
    chainId: cfg.chainId,
    hub: cfg.hub,
    reportTtlSeconds: cfg.reportTtlSeconds,
    gasLimit: cfg.gasLimit,
    maxWritesPerRun: cfg.maxWritesPerRun,
    notify: cfg.notify,
  };
  const slot = payload.scheduledExecutionTime?.seconds ?? BigInt(Math.floor(runtime.now().getTime() / 1000));
  const nonceSeed = `reconciler:${slot}`;
  const header = chain.blockTimestamp();
  // Block time for scoring; without a header, scoring treats time as missing (HOLD), and expiry uses the slot.
  const blockTimestamp = header?.timestamp;
  const now = blockTimestamp ?? slot;
  let budget = Math.max(0, cfg.maxWritesPerRun - 1); // one slot reserved for the heartbeat
  const summary: Record<string, unknown> = { slot: slot.toString() };

  // --- Read A: Vault page, open requests, current modes, feeds, pool prices (one EVM call) ---
  const pageSize = BigInt(cfg.vaultPageSize);
  const calls: Call[] = [
    { to: cfg.hub, abi: hubAbi, functionName: "getVaults", args: [0n, pageSize] },
    { to: cfg.hub, abi: hubAbi, functionName: "openRequests", args: [0n, pageSize] },
  ];
  for (const a of cfg.assets) {
    calls.push(
      { to: cfg.hub, abi: hubAbi, functionName: "marketMode", args: [a.underlying] },
      { to: a.feed, abi: aggregatorV3Abi, functionName: "latestRoundData" },
      { to: a.feed, abi: aggregatorV3Abi, functionName: "decimals" },
    );
    if (a.pool && a.pool.poolId) {
      calls.push(
        { to: a.pool.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [a.pool.poolId] },
        { to: a.pool.quoteFeed, abi: aggregatorV3Abi, functionName: "latestRoundData" },
        { to: a.pool.quoteFeed, abi: aggregatorV3Abi, functionName: "decimals" },
      );
    }
  }
  const ra = chain.multicall(calls);
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

  // --- 2. Undecided requests, largest USD first ---
  const undecided = open
    .filter((r) => (r.state === P.REQ_PENDING || r.state === P.REQ_HELD) && !flagged.has(r.vault.toLowerCase()))
    .slice()
    .sort(byPriority)
    .slice(0, cfg.maxScorePerRun);
  if (undecided.length > 0 && budget > 0) {
    const scored = scoreAndWrite(
      runtime,
      chain,
      { ...scfg, maxWritesPerRun: budget },
      undecided.map((r) => ({ vault: r.vault, requestId: r.requestId })),
      {
        blockTimestamp,
        nonceSeed,
        expectedHash: new Map(undecided.map((r) => [`${r.vault.toLowerCase()}:${r.requestId}`, r.requestHash])),
      },
    );
    budget -= scored.filter((s) => s.write).length;
    summary.requests = scored.map(
      (s) => `${s.ref.vault}#${s.ref.requestId} ${s.decision ? verdictName(s.decision.verdict) : "-"} ${s.outcome}`,
    );
  } else summary.requests = [];

  // --- 3. Market modes ---
  // Previous rounds for the Volatile check (one EVM call).
  let k = 2;
  const perAsset = cfg.assets.map((a) => {
    const at = k;
    k += 3 + (a.pool && a.pool.poolId ? 3 : 0);
    return at;
  });
  const prevCalls: Call[] = cfg.assets.map((a, i) => {
    const latest = ra[perAsset[i] + 1] as Round | undefined;
    return {
      to: a.feed,
      abi: aggregatorV3Abi,
      functionName: "getRoundData",
      args: [latest && latest[0] > 0n ? latest[0] - 1n : 0n],
    };
  });
  const prev = chain.multicall(prevCalls);
  const modes: string[] = [];
  cfg.assets.forEach((a, i) => {
    const at = perAsset[i];
    const current = ra[at] as number | undefined;
    const latest = ra[at + 1] as Round | undefined;
    const decimals = ra[at + 2] as number | undefined;
    const feed: FeedRound | undefined =
      latest && decimals !== undefined ? { answer: latest[1], updatedAt: latest[3], decimals } : undefined;
    let pool: bigint | undefined;
    let chainlinkInQuote: bigint | undefined;
    if (a.pool && a.pool.poolId && feed) {
      const slot0 = ra[at + 3] as readonly [bigint, number, number, number] | undefined;
      const q = ra[at + 4] as Round | undefined;
      const qd = ra[at + 5] as number | undefined;
      if (slot0 && slot0[0] > 0n && q && q[1] > 0n && qd !== undefined) {
        const baseIsToken0 = a.underlying.toLowerCase() < a.pool.quote.toLowerCase();
        pool = poolPrice({
          sqrtPriceX96: slot0[0],
          baseIsToken0,
          baseDecimals: a.pool.baseDecimals,
          quoteDecimals: a.pool.quoteDecimals,
          outDecimals: 8,
        });
        // Chainlink price of the asset in the quote token: (asset/USD) / (quote/USD), 8 dp.
        chainlinkInQuote = (rescale(feed.answer, feed.decimals, 8) * 10n ** 8n) / rescale(q[1], qd, 8);
      }
    }
    const p = prev[i] as Round | undefined;
    const d = marketMode({
      feed,
      heartbeat: BigInt(a.heartbeat),
      now,
      prevAnswer: p?.[1],
      volatileMoveBps: BigInt(cfg.volatileMoveBps),
      chainlinkInQuote,
      pool,
    });
    if (!d) return modes.push(`${a.name} unknown (feed unreadable)`);
    if (d.mode === current) return modes.push(`${a.name} ${d.mode} unchanged`);
    if (budget <= 0) return modes.push(`${a.name} ${d.mode} SKIP_WRITE_BUDGET`);
    budget--;
    const w = writeReport(runtime, evm, cfg.hub, {
      reportType: P.REPORT_MARKET_MODE,
      vault: "0x0000000000000000000000000000000000000000",
      requestId: BigInt(a.underlying),
      requestHash: `0x${"0".repeat(64)}`,
      verdict: d.mode,
      reasonCodes: d.reasonCodes,
      expiry: now + BigInt(cfg.reportTtlSeconds),
      nonce: deriveNonce(nonceSeed, "mode", a.underlying.toLowerCase(), d.mode),
    }, cfg.gasLimit);
    modes.push(`${a.name} ${current ?? "?"}->${d.mode} ${w.ok ? "WRITTEN" : "WRITE_FAILED"}`);
  });
  summary.modes = modes;

  // --- 4. Heartbeat ---
  const hb = writeReport(runtime, evm, cfg.hub, {
    reportType: P.REPORT_HEARTBEAT,
    vault: "0x0000000000000000000000000000000000000000",
    requestId: 0n,
    requestHash: `0x${"0".repeat(64)}`,
    verdict: 0,
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
