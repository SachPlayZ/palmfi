/**
 * Sentinel (ADR-0003): the shared, log-triggered workflow that scores every Owner's requests.
 *
 * Trigger: raw EVM logTrigger on the Hub at CONFIDENCE_LEVEL_LATEST (the generated bindings helper drops
 * `confidence` and would silently use SAFE). Scored events:
 *   UnwrapRequested, SecondFactorConfirmed  → score that request (VERDICT report)
 *   ConfigChangeRequested                   → notify CONFIG_CHANGE, re-score the Vault's open requests
 *   HookSwap, SafeHarborSwap                → Vault health: reserves (RESERVE_FLAG), delegations (DELEGATION_FLAG)
 *
 * Fast to freeze, careful to release: FLAG/HOLD land from LATEST; a CLEAR is written only after the request
 * re-reads identically at FINALIZED, otherwise it is deferred to the Reconciler. FLAG side effects (Freeze,
 * ENS status=frozen, Blocklist) happen inside Hub.onReport; the Sentinel writes the report and notifies.
 */
import {
  bytesToHex,
  EVMClient,
  getNetwork,
  handler,
  hexToBase64,
  protoBigIntToBigint,
  Runner,
  type EVMLog,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeEventLog, encodeEventTopics, type Address, type Hex } from "viem";
import { hubEventsAbi, vaultAbi } from "../shared/abi";
import { Chain } from "../shared/chain";
import { flagVaults, inspectVaults } from "../shared/health";
import { notify, type NotifyConfig } from "../shared/notify";
import * as P from "../shared/palm";
import { scoreAndWrite, verdictName, type Ref, type Scored, type ScoringConfig } from "../shared/scoring";

export type Config = {
  chainSelectorName: string;
  chainId: number;
  hub: Address;
  multicall3: Address;
  reportTtlSeconds: number;
  gasLimit: string;
  maxWritesPerRun: number;
  notify: NotifyConfig;
};

export const SCORED_EVENTS = [
  "UnwrapRequested",
  "ConfigChangeRequested",
  "SecondFactorConfirmed",
  "HookSwap",
  "SafeHarborSwap",
] as const;

export const eventTopic = (eventName: (typeof SCORED_EVENTS)[number]): Hex =>
  encodeEventTopics({ abi: hubEventsAbi, eventName })[0];

const evmFor = (config: Config) => {
  const net = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName });
  if (!net) throw new Error(`unknown chain ${config.chainSelectorName}`);
  return new EVMClient(net.chainSelector.selector);
};

const scoringConfig = (c: Config): ScoringConfig => ({
  chainId: c.chainId,
  hub: c.hub,
  reportTtlSeconds: c.reportTtlSeconds,
  gasLimit: c.gasLimit,
  maxWritesPerRun: c.maxWritesPerRun,
  notify: c.notify,
});

const summarize = (event: string, scored: Scored[]) =>
  `${event}: ${scored
    .map(
      (s) =>
        `${s.ref.vault}#${s.ref.requestId} ${s.decision ? verdictName(s.decision.verdict) : "-"} ${s.outcome}` +
        (s.decision ? ` [${P.reasonNames(s.decision.reasonCodes).join(",")}]` : ""),
    )
    .join("; ")}`;

export const onHubLog = (runtime: Runtime<Config>, log: EVMLog): string => {
  const txHash = bytesToHex(log.txHash);
  // Reorg retraction: nothing to undo. A CLEAR is never written before finality, and any report bound to
  // the vanished request's hash is rejected onchain (unknown request / hash mismatch).
  if (log.removed) {
    runtime.log(`removed log ${txHash}#${log.index} ignored`);
    return `REMOVED ${txHash}#${log.index}`;
  }

  let ev: ReturnType<typeof decodeEventLog<typeof hubEventsAbi>>;
  try {
    ev = decodeEventLog({
      abi: hubEventsAbi,
      data: bytesToHex(log.data),
      topics: log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
    });
  } catch {
    return `IGNORED undecodable log ${txHash}#${log.index}`;
  }

  const cfg = runtime.config;
  const scfg = scoringConfig(cfg);
  const evm = evmFor(cfg);
  const chain = new Chain(runtime, evm, cfg.multicall3);
  const nonceSeed = `${txHash}:${log.index}`;
  // Block timestamp from the log's block header (the log payload has none). Never a node clock.
  const header = chain.blockTimestamp(log.blockNumber ? protoBigIntToBigint(log.blockNumber) : undefined);
  const blockTimestamp = header?.timestamp;

  switch (ev.eventName) {
    case "UnwrapRequested":
    case "SecondFactorConfirmed": {
      const { vault, requestId, requestHash } = ev.args;
      const ref: Ref = { vault, requestId };
      const scored = scoreAndWrite(runtime, chain, scfg, [ref], {
        blockTimestamp,
        nonceSeed,
        expectedHash: new Map([[`${vault.toLowerCase()}:${requestId}`, requestHash]]),
      });
      return summarize(ev.eventName, scored);
    }
    case "ConfigChangeRequested": {
      const { vault, changeId, kind } = ev.args;
      notify(runtime, cfg.notify, {
        vault,
        kind: "CONFIG_CHANGE",
        requestId: changeId,
        reasonCodes: P.isSensitiveChange(kind) ? P.CONFIG_CHANGE_PENDING : 0n,
      });
      // Any withdrawal pending while a sensitive change is pending is FLAGged (engine reads sensitivePending).
      const [ids] = chain.multicall([{ to: vault, abi: vaultAbi, functionName: "openRequestIds" }]);
      const refs = ((ids as readonly bigint[] | undefined) ?? []).map((requestId) => ({ vault, requestId }));
      const scored = refs.length ? scoreAndWrite(runtime, chain, scfg, refs, { blockTimestamp, nonceSeed }) : [];
      return `${summarize(`ConfigChangeRequested kind=${kind}`, scored)}${refs.length ? "" : "no open requests"}`;
    }
    case "HookSwap":
    case "SafeHarborSwap": {
      const { vault } = ev.args;
      const findings = inspectVaults(chain, cfg.hub, [vault]);
      flagVaults(runtime, chain, scfg, findings, {
        blockTimestamp: blockTimestamp ?? BigInt(Math.floor(runtime.now().getTime() / 1000)),
        nonceSeed,
        writeBudget: cfg.maxWritesPerRun,
      });
      return findings.length
        ? `${ev.eventName}: ${findings.map((f) => `${f.vault} ${f.reportType === P.REPORT_RESERVE_FLAG ? "RESERVE_FLAG" : "DELEGATION_FLAG"} ${f.write?.ok ? "WRITTEN" : "WRITE_FAILED"}`).join("; ")}`
        : `${ev.eventName}: ${vault} healthy`;
    }
  }
};

export const initWorkflow = (config: Config) => {
  const evm = evmFor(config);
  return [
    handler(
      evm.logTrigger({
        addresses: [hexToBase64(config.hub)],
        topics: [{ values: SCORED_EVENTS.map((e) => hexToBase64(eventTopic(e))) }],
        confidence: "CONFIDENCE_LEVEL_LATEST",
      }),
      onHubLog,
    ),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
