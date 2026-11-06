"use client";

import { useMemo } from "react";
import type { Address, Hex } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { hubAbi, orbitalHookAbi, vaultAbi } from "@/abi";
import { deployments } from "./deployments";
import { arcTestnet } from "./network";

const chainId = arcTestnet.id;

export type VaultEntry = { vault: Address; name?: string; status?: number; verified: boolean; token?: Address };

/** Every registered Vault, straight from the Hub (no log scans): name, status, verified badge, token. */
export function useVaultIndex() {
  const hub = deployments.hub;
  const count = useReadContract({ address: hub, abi: hubAbi, functionName: "vaultCount", chainId, query: { enabled: !!hub, refetchInterval: 60_000 } });
  const n = count.data ?? 0n;
  const list = useReadContract({
    address: hub,
    abi: hubAbi,
    functionName: "getVaults",
    args: [0n, n],
    chainId,
    query: { enabled: !!hub && n > 0n, refetchInterval: 60_000 },
  });
  const vaults = useMemo(() => (list.data ?? []) as readonly Address[], [list.data]);
  const meta = useReadContracts({
    allowFailure: true,
    contracts: vaults.flatMap((v) => [
      { address: hub, abi: hubAbi, functionName: "nameOf", args: [v], chainId } as const,
      { address: hub, abi: hubAbi, functionName: "statusOf", args: [v], chainId } as const,
      { address: hub, abi: hubAbi, functionName: "verified", args: [v], chainId } as const,
      { address: v, abi: vaultAbi, functionName: "token", chainId } as const,
    ]),
    query: { enabled: vaults.length > 0, refetchInterval: 30_000 },
  });
  const entries: VaultEntry[] = useMemo(
    () =>
      vaults.map((vault, i) => ({
        vault,
        name: (meta.data?.[i * 4]?.result as string | undefined) || undefined,
        status: meta.data?.[i * 4 + 1]?.result as number | undefined,
        verified: Boolean(meta.data?.[i * 4 + 2]?.result),
        token: meta.data?.[i * 4 + 3]?.result as Address | undefined,
      })),
    [vaults, meta.data],
  );
  return {
    entries,
    count: Number(n),
    isLoading: count.isLoading || list.isLoading || (vaults.length > 0 && meta.isLoading),
    error: count.error ?? list.error,
  };
}

/** Vaults where `me` is a wallet (a Voter). */
export function useMyVaults(me: Address | undefined) {
  const idx = useVaultIndex();
  const q = useReadContracts({
    allowFailure: true,
    contracts: idx.entries.map((e) => ({ address: e.vault, abi: vaultAbi, functionName: "isWallet", args: [me!], chainId }) as const),
    query: { enabled: !!me && idx.entries.length > 0, refetchInterval: 30_000 },
  });
  const mine = useMemo(() => idx.entries.filter((_, i) => q.data?.[i]?.result === true), [idx.entries, q.data]);
  return { mine, isLoading: idx.isLoading || (!!me && idx.entries.length > 0 && q.isLoading), error: idx.error ?? q.error, all: idx };
}

export type OpenRequest = {
  vault: Address;
  requestId: bigint;
  amount: bigint;
  state: number;
  scored: boolean;
  fastTracked: boolean;
  executableAt: bigint;
  requestHash: Hex;
};

/** Every open request across the network (Hub.openRequests). */
export function useOpenRequests(limit = 200n) {
  return useReadContract({
    address: deployments.hub,
    abi: hubAbi,
    functionName: "openRequests",
    args: [0n, limit],
    chainId,
    query: { enabled: !!deployments.hub, refetchInterval: 15_000, select: (d) => d as readonly OpenRequest[] },
  });
}

/** Sentinel heartbeat + CRE liveness, shared by the status page and the chrome. */
export function useNetworkHealth() {
  const hub = deployments.hub;
  const q = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: hub, abi: hubAbi, functionName: "lastHeartbeat", chainId },
      { address: hub, abi: hubAbi, functionName: "HEARTBEAT_STALE", chainId },
      { address: hub, abi: hubAbi, functionName: "creLive", chainId },
      { address: hub, abi: hubAbi, functionName: "workflowName", chainId },
      { address: hub, abi: hubAbi, functionName: "workflowId", chainId },
      { address: hub, abi: hubAbi, functionName: "admin", chainId },
      { address: hub, abi: hubAbi, functionName: "BLOCK_TTL", chainId },
      { address: deployments.hook, abi: orbitalHookAbi, functionName: "tokenCount", chainId },
    ],
    query: { enabled: !!hub, refetchInterval: 15_000 },
  });
  const r = q.data;
  return {
    lastHeartbeat: r?.[0]?.result as bigint | undefined,
    staleAfter: r?.[1]?.result as bigint | undefined,
    creLive: r?.[2]?.result as boolean | undefined,
    workflowName: r?.[3]?.result as Hex | undefined,
    workflowId: r?.[4]?.result as Hex | undefined,
    admin: r?.[5]?.result as Address | undefined,
    blockTtl: r?.[6]?.result as bigint | undefined,
    poolTokens: r?.[7]?.result as bigint | undefined,
    isLoading: q.isLoading,
    error: q.error,
  };
}

/** Names for a set of addresses that might be Vaults (null name = not a vault). */
export function useNames(addrs: readonly (Address | undefined)[]) {
  const list = addrs.filter((a): a is Address => !!a);
  const q = useReadContracts({
    allowFailure: true,
    contracts: list.map((a) => ({ address: deployments.hub, abi: hubAbi, functionName: "nameOf", args: [a], chainId }) as const),
    query: { enabled: list.length > 0 && !!deployments.hub, staleTime: 60_000 },
  });
  const map = new Map<string, string>();
  list.forEach((a, i) => {
    const n = q.data?.[i]?.result as string | undefined;
    if (n) map.set(a.toLowerCase(), n);
  });
  return (a?: string) => (a ? map.get(a.toLowerCase()) : undefined);
}
