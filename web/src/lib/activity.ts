"use client";

import { useQuery } from "@tanstack/react-query";
import { decodeEventLog, pad, type Address, type Hex } from "viem";
import { usePublicClient } from "wagmi";
import { hubAbi, orbitalHookAbi } from "@/abi";
import { deployments } from "./deployments";
import { arcTestnet } from "./network";

/** The public Arc endpoint rejects eth_getLogs ranges above 10k blocks. */
const STEP = 10_000n;

export type Activity = {
  event: string;
  args: Record<string, unknown>;
  block: bigint;
  tx: Hex;
  logIndex: number;
  /** Unix seconds, interpolated between two block anchors (≈). */
  at: number;
};

type RawLog = { topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; logIndex: Hex };

/** Block → time estimate from the deployment block and the latest block. */
async function timeAnchors(client: NonNullable<ReturnType<typeof usePublicClient>>) {
  const latest = await client.getBlock();
  const fromN = deployments.fromBlock > 0n ? deployments.fromBlock : latest.number - 1000n;
  const first = await client.getBlock({ blockNumber: fromN });
  const span = Number(latest.number - first.number) || 1;
  const rate = Number(latest.timestamp - first.timestamp) / span;
  return { latest: latest.number, at: (b: bigint) => Number(first.timestamp) + Number(b - first.number) * rate };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One eth_getLogs call, retried with backoff when the public endpoint rate-limits. */
async function getLogs(client: NonNullable<ReturnType<typeof usePublicClient>>, params: Record<string, unknown>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await client.request({ method: "eth_getLogs", params: [params] } as never)) as RawLog[];
    } catch (e) {
      if (attempt >= 4 || !/rate|limit|429/i.test(String((e as Error)?.message ?? e))) throw e;
      await sleep(800 * 2 ** attempt);
    }
  }
}

async function scan(client: NonNullable<ReturnType<typeof usePublicClient>>, address: Address, topics: (Hex | null)[], latest: bigint, limitBlocks?: bigint) {
  const floor = deployments.fromBlock > 0n ? deployments.fromBlock : latest > 200_000n ? latest - 200_000n : 0n;
  const start = limitBlocks && latest - limitBlocks > floor ? latest - limitBlocks : floor;
  const out: RawLog[] = [];
  for (let from = start; from <= latest; from += STEP) {
    const to = from + STEP - 1n > latest ? latest : from + STEP - 1n;
    out.push(...(await getLogs(client, { address, topics, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` })));
    if (to < latest) await sleep(120);
  }
  return out;
}

function decode(abi: typeof hubAbi | typeof orbitalHookAbi, logs: RawLog[], at: (b: bigint) => number): Activity[] {
  const out: Activity[] = [];
  for (const l of logs) {
    try {
      const d = decodeEventLog({ abi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
      const block = BigInt(l.blockNumber);
      out.push({
        event: d.eventName as string,
        args: (d.args ?? {}) as Record<string, unknown>,
        block,
        tx: l.transactionHash,
        logIndex: Number(l.logIndex),
        at: at(block),
      });
    } catch {
      /* not an event we know */
    }
  }
  return out.sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block > b.block ? -1 : 1));
}

/** Every Hub event about one Vault (the Vault is the first indexed topic of each), newest first. */
export function useVaultActivity(vault: Address | undefined) {
  const client = usePublicClient({ chainId: arcTestnet.id });
  return useQuery({
    queryKey: ["activity", vault],
    enabled: !!client && !!vault && !!deployments.hub,
    refetchInterval: 30_000,
    queryFn: async () => {
      const t = await timeAnchors(client!);
      const logs = await scan(client!, deployments.hub!, [null, pad(vault!)], t.latest);
      return decode(hubAbi, logs, t.at);
    },
  });
}

/** Recent Hub events of the given names, network-wide (for the status page and blocklist). */
export function useHubEvents(names: string[], key: string, recentBlocks?: bigint) {
  const client = usePublicClient({ chainId: arcTestnet.id });
  return useQuery({
    queryKey: ["hubEvents", key],
    enabled: !!client && !!deployments.hub,
    refetchInterval: 30_000,
    queryFn: async () => {
      const t = await timeAnchors(client!);
      const logs = await scan(client!, deployments.hub!, [], t.latest, recentBlocks);
      return decode(hubAbi, logs, t.at).filter((a) => names.includes(a.event));
    },
  });
}

/** Recent Orbital pool events. */
export function usePoolEvents(recentBlocks?: bigint) {
  const client = usePublicClient({ chainId: arcTestnet.id });
  return useQuery({
    queryKey: ["poolEvents"],
    enabled: !!client && !!deployments.hook,
    refetchInterval: 30_000,
    queryFn: async () => {
      const t = await timeAnchors(client!);
      const logs = await scan(client!, deployments.hook!, [], t.latest, recentBlocks);
      return decode(orbitalHookAbi, logs, t.at);
    },
  });
}

export function ago(at: number, now = Date.now() / 1000) {
  const s = Math.max(0, now - at);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
