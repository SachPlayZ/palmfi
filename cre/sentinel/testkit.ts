/** Test fixtures for the Sentinel: config and Hub log builders (no tests here, so importing is side-effect free). */
import type { EVMLog } from "@chainlink/cre-sdk";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, type Address, type Hex } from "viem";
import { hubEventsAbi } from "../shared/abi";
import { DEFAULT_PARAMS } from "../shared/deviation";
import { ADDR, type Req } from "../shared/testing";
import type { Config, SCORED_EVENTS } from "./main";

export const config: Config = {
  chainSelectorName: "arc-testnet",
  chainId: 5042002,
  hub: ADDR.hub,
  multicall3: ADDR.multicall3,
  reportTtlSeconds: 900,
  gasLimit: "1500000",
  maxWritesPerRun: 5,
  scoring: DEFAULT_PARAMS,
  notifyDelaySeconds: 6 * 3600,
  notify: { url: "https://palmfi.example/api/notify", apiKeySecret: "notifyApiKey" },
};

type EventName = (typeof SCORED_EVENTS)[number];

/** Build the EVMLog the trigger would deliver for a Hub event. */
export function hubLog(eventName: EventName, args: Record<string, unknown>, opts: { removed?: boolean; index?: number } = {}): EVMLog {
  const topics = encodeEventTopics({ abi: hubEventsAbi, eventName, args } as never) as Hex[];
  const item = hubEventsAbi.find((e) => e.name === eventName)!;
  const nonIndexed = item.inputs.filter((i) => !("indexed" in i && i.indexed));
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]) as never);
  return {
    address: hexToBytes(ADDR.hub),
    topics: topics.map((t) => hexToBytes(t)),
    data: hexToBytes(data),
    txHash: hexToBytes(`0x${"ab".repeat(32)}`),
    blockHash: hexToBytes(`0x${"cd".repeat(32)}`),
    eventSig: hexToBytes(topics[0]),
    blockNumber: { absVal: new Uint8Array([0x01, 0x00]), sign: 1n },
    txIndex: 0,
    index: opts.index ?? 0,
    removed: opts.removed ?? false,
  } as unknown as EVMLog;
}

export const queuedLog = (vault: Address, r: Req, id = 1n, opts = {}) =>
  hubLog(
    "RequestQueued",
    {
      vault,
      requestId: id,
      requestHash: r.requestHash,
      kind: r.kind,
      wallet: r.requester,
      amount: r.amount,
      destination: r.destination,
      reasonCodes: r.reasonCodes,
    },
    opts,
  );

export const configLog = (vault: Address, kind: number, eta = 0n, changeId = 1n) =>
  hubLog("ConfigChange", { vault, changeId, kind, data: "0x", yesVotes: 1, eta });

export const outflowLog = (vault: Address, viaPool: boolean) =>
  hubLog("Outflow", { vault, wallet: ADDR.w0, destination: ADDR.friend, amount: 1_000000n, viaPool });
