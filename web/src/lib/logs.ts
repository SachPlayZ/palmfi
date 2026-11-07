"use client";

import { useQuery } from "@tanstack/react-query";
import type { AbiEvent, Address } from "viem";
import { usePublicClient } from "wagmi";
import { arcTestnet } from "./network";
import { deployments } from "./deployments";

/** The public Arc endpoint rejects eth_getLogs ranges above 10k blocks. */
const STEP = 10_000n;

/** Chunked getLogs from the deployment block (public RPCs cap ranges). Newest first. */
export function useEventLogs<E extends AbiEvent>(
  key: string,
  params: { address: Address | undefined; event: E; args?: Record<string, unknown>; enabled?: boolean },
) {
  const client = usePublicClient({ chainId: arcTestnet.id });
  return useQuery({
    queryKey: ["logs", key, params.address, JSON.stringify(params.args ?? {})],
    enabled: !!client && !!params.address && params.enabled !== false,
    refetchInterval: 20_000,
    queryFn: async () => {
      const latest = await client!.getBlockNumber();
      const start = deployments.fromBlock > 0n ? deployments.fromBlock : latest > 200_000n ? latest - 200_000n : 0n;
      const out = [];
      for (let from = start; from <= latest; from += STEP) {
        const to = from + STEP - 1n > latest ? latest : from + STEP - 1n;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const logs = await client!.getLogs({ address: params.address!, event: params.event, args: params.args as any, fromBlock: from, toBlock: to });
        out.push(...logs);
      }
      return out.reverse();
    },
  });
}
