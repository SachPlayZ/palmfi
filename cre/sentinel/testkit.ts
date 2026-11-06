/** Test fixtures for the Sentinel: config and Hub log builders (no tests here, so importing is side-effect free). */
import type { EVMLog } from "@chainlink/cre-sdk";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, type Address, type Hex } from "viem";
import { hubEventsAbi } from "../shared/abi";
import { ADDR, request } from "../shared/testing";
import type { Config, SCORED_EVENTS } from "./main";

export const config: Config = {
  chainSelectorName: "ethereum-testnet-sepolia",
  chainId: 11155111,
  hub: ADDR.hub,
  multicall3: ADDR.multicall3,
  reportTtlSeconds: 900,
  gasLimit: "1500000",
  maxWritesPerRun: 5,
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

export const unwrapLog = (vault: Address, r: ReturnType<typeof request>, id = 1n, opts = {}) =>
  hubLog(
    "UnwrapRequested",
    {
      vault,
      requestId: id,
      requestHash: r.requestHash,
      asset: r.asset,
      amount: r.amount,
      destination: r.destination,
      usdValue: r.usdValue,
      reasonCodes: r.reasonCodes,
    },
    opts,
  );

