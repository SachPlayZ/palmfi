/**
 * Sentinel (ADR-0003, ADR-0009): the shared, log-triggered workflow that scores every Vault's queued requests.
 *
 * Trigger: raw EVM logTrigger on the Hub at CONFIDENCE_LEVEL_LATEST (the generated bindings helper drops
 * `confidence` and would silently use SAFE). Arc finality is deterministic, so LATEST is final. Events:
 *   RequestQueued  → Deviation score → SET_DELAY (or FLAG: freeze + blocklist inside Hub.onReport)
 *   ConfigChange   → notify every Voter; a proposed wallet add re-scores the Vault's open requests
 *   Outflow(viaPool) → Vault health: reserves (RESERVE_FLAG), delegations (DELEGATION_FLAG)
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
import { normalizeAddresses } from "../shared/config";
import { flagVaults, inspectVaults } from "../shared/health";
import { notify, type NotifyConfig } from "../shared/notify";
import * as P from "../shared/palm";
import type { Params } from "../shared/deviation";
import { key, scoreAndWrite, type Ref, type Scored, type ScoringConfig } from "../shared/scoring";

export type Config = {
  chainSelectorName: string;
  chainId: number;
  hub: Address;
  multicall3: Address;
  reportTtlSeconds: number;
  gasLimit: string;
  maxWritesPerRun: number;
  scoring: Params;
  notifyDelaySeconds: number;
  notify: NotifyConfig;
};

export const SCORED_EVENTS = ["RequestQueued", "ConfigChange", "Outflow"] as const;

export const eventTopic = (eventName: (typeof SCORED_EVENTS)[number]): Hex =>
  encodeEventTopics({ abi: hubEventsAbi, eventName })[0];

const evmFor = (config: Config) => {
  const net = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName });
  if (!net) throw new Error(`unknown chain ${config.chainSelectorName}`);
  return new EVMClient(net.chainSelector.selector);
};

export const scoringConfig = (c: Config): ScoringConfig => ({
  hub: c.hub,
  reportTtlSeconds: c.reportTtlSeconds,
  gasLimit: c.gasLimit,
  maxWritesPerRun: c.maxWritesPerRun,
  scoring: c.scoring,
  notifyDelaySeconds: c.notifyDelaySeconds,
  notify: c.notify,
});

const summarize = (event: string, scored: Scored[]) =>
  `${event}: ${scored
    .map(
      (s) =>
        `${s.ref.vault}#${s.ref.requestId} ${s.assessment?.action ?? "-"} ${s.outcome}` +
        (s.assessment
          ? ` score=${s.assessment.score} delay=${s.assessment.delay} [${P.reasonNames(s.assessment.reasonCodes).join(",")}]`
          : ""),
    )
    .join("; ")}`;

export const onHubLog = (runtime: Runtime<Config>, log: EVMLog): string => {
  const txHash = bytesToHex(log.txHash);
  // Reorg retraction (not expected on Arc's BFT finality): any report bound to a vanished request's hash
  // is rejected onchain (unknown request / hash mismatch), so there is nothing to undo.
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

  const cfg = normalizeAddresses(runtime.config);
  const scfg = scoringConfig(cfg);
  const evm = evmFor(cfg);
  const chain = new Chain(runtime, evm, cfg.multicall3);
  const nonceSeed = `${txHash}:${log.index}`;
  // Block timestamp from the log's block header (the log payload has none). Never a node clock.
  const header = chain.blockTimestamp(log.blockNumber ? protoBigIntToBigint(log.blockNumber) : undefined);
  // Unsure → slow: without a header we can't stamp report expiry, so write nothing and let the Reconciler
  // score it (the request already defaults to MaxDelay onchain).
  if (header === undefined) return `DEFERRED no block header ${txHash}#${log.index}`;
  const blockTimestamp = header.timestamp;

  switch (ev.eventName) {
    case "RequestQueued": {
      const { vault, requestId, requestHash } = ev.args;
      const ref: Ref = { vault, requestId };
      const scored = scoreAndWrite(runtime, chain, scfg, [ref], {
        blockTimestamp,
        nonceSeed,
        expectedHash: new Map([[key(ref), requestHash]]),
      });
      return summarize(ev.eventName, scored);
    }
    case "ConfigChange": {
      const { vault, changeId, kind, eta } = ev.args;
      const proposedAdd = kind === P.CHANGE_ADD_WALLET && eta === 0n;
      notify(runtime, cfg.notify, {
        vault,
        kind: "CONFIG_CHANGE",
        requestId: changeId,
        reasonCodes: proposedAdd ? P.CONFIG_CHANGE_PENDING : 0n,
      });
      if (!proposedAdd) return `ConfigChange kind=${kind} notified`;
      // A pending wallet add is the Sybil path (ADR-0008): every open request now carries extra bits.
      const [ids] = chain.multicall([{ to: vault, abi: vaultAbi, functionName: "openRequestIds" }]);
      const refs = ((ids as readonly bigint[] | undefined) ?? []).map((requestId) => ({ vault, requestId }));
      const scored = refs.length ? scoreAndWrite(runtime, chain, scfg, refs, { blockTimestamp, nonceSeed, rescore: true }) : [];
      return refs.length ? summarize(`ConfigChange kind=${kind}`, scored) : `ConfigChange kind=${kind} no open requests`;
    }
    case "Outflow": {
      const { vault, viaPool } = ev.args;
      if (!viaPool) return `Outflow ${vault} direct, no health check`;
      const findings = inspectVaults(chain, cfg.hub, [vault]);
      flagVaults(runtime, chain, scfg, findings, { blockTimestamp, nonceSeed, writeBudget: cfg.maxWritesPerRun });
      return findings.length
        ? `Outflow: ${findings.map((f) => `${f.vault} ${f.reportType === P.REPORT_RESERVE_FLAG ? "RESERVE_FLAG" : "DELEGATION_FLAG"} ${f.write?.ok ? "WRITTEN" : "WRITE_FAILED"}`).join("; ")}`
        : `Outflow: ${vault} healthy`;
    }
    default:
      return `IGNORED ${(ev as { eventName: string }).eventName}`;
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
