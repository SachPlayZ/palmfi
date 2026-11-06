"use client";

import { useMemo } from "react";
import { erc20Abi, isAddress, type Address, type Hex } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { hubAbi, orbitalHookAbi, vaultAbi } from "@/abi";
import type { ScoringContext } from "./deviation";
import { deployments } from "./deployments";
import { arcTestnet, network } from "./network";

const REFRESH = 6_000;
const chainId = arcTestnet.id;

export type VaultRequest = ScoringContext["request"] & { id: bigint; executable: boolean };

export type VaultChange = {
  id: bigint;
  kind: number;
  done: boolean;
  voterCount: number;
  yes: number;
  createdAt: bigint;
  eta: bigint;
  data: Hex;
};

const SCALARS = [
  "token",
  "recoveryKey",
  "recoveryVault",
  "budget24h",
  "budget7d",
  "hardCap",
  "floorDelay",
  "maxDelay",
  "capDelay",
  "availableBudget",
  "wallets",
  "openRequestIds",
  "nextRequestId",
  "nextChangeId",
  "pendingWalletAdds",
  "bizStartHourUtc",
  "bizEndHourUtc",
  "usualMaxPayout",
  "historyCount",
  "reserves",
] as const;

type Scalars = {
  token: Address;
  recoveryKey: Address;
  recoveryVault: Address;
  budget24h: bigint;
  budget7d: bigint;
  hardCap: bigint;
  floorDelay: number;
  maxDelay: number;
  capDelay: number;
  availableBudget: bigint;
  wallets: readonly Address[];
  openRequestIds: readonly bigint[];
  nextRequestId: bigint;
  nextChangeId: bigint;
  pendingWalletAdds: bigint;
  bizStartHourUtc: number;
  bizEndHourUtc: number;
  usualMaxPayout: bigint;
  historyCount: bigint;
  reserves: readonly [bigint, bigint];
};

/** Resolves a route id (Hub name or 0x address) to a Vault address. */
export function useVaultAddress(id: string | undefined) {
  const decoded = id ? decodeURIComponent(id).toLowerCase() : "";
  const direct = isAddress(decoded) ? (decoded as Address) : undefined;
  const name = !direct ? decoded : "";
  const q = useReadContract({
    address: deployments.hub,
    abi: hubAbi,
    functionName: "resolve",
    args: [name],
    chainId,
    query: { enabled: !!name && !!deployments.hub },
  });
  const viaName = q.data && q.data !== "0x0000000000000000000000000000000000000000" ? (q.data as Address) : undefined;
  return { vault: direct ?? viaName, isLoading: q.isLoading, notFound: !!name && q.isSuccess && !viaName };
}

export function useVault(vault: Address | undefined) {
  const enabled = !!vault;
  const base = useReadContracts({
    allowFailure: true,
    contracts: [
      ...SCALARS.map((functionName) => ({ address: vault, abi: vaultAbi, functionName, chainId }) as const),
      { address: deployments.hub, abi: hubAbi, functionName: "statusOf", args: [vault!], chainId },
      { address: deployments.hub, abi: hubAbi, functionName: "lastHeartbeat", chainId },
      { address: deployments.hub, abi: hubAbi, functionName: "nameOf", args: [vault!], chainId },
      { address: deployments.hub, abi: hubAbi, functionName: "verified", args: [vault!], chainId },
    ],
    query: { enabled: enabled && !!deployments.hub, refetchInterval: REFRESH },
  });

  const s = useMemo(() => {
    if (!base.data) return undefined;
    const out: Record<string, unknown> = {};
    SCALARS.forEach((k, i) => (out[k] = base.data[i]?.result));
    if (out.token === undefined) return undefined; // not a Vault
    return out as Scalars;
  }, [base.data]);
  const tail = base.data?.slice(SCALARS.length);
  const status = tail?.[0]?.result as number | undefined;
  const lastHeartbeat = tail?.[1]?.result as bigint | undefined;
  const name = (tail?.[2]?.result as string | undefined) || undefined;
  const verified = Boolean(tail?.[3]?.result);

  const wallets = s?.wallets ?? [];
  const token = s?.token;

  const balQ = useReadContracts({
    allowFailure: true,
    contracts: [
      ...wallets.map((w) => ({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [w], chainId }) as const),
      { address: token, abi: erc20Abi, functionName: "symbol", chainId } as const,
      { address: network.usdc, abi: erc20Abi, functionName: "balanceOf", args: [vault!], chainId } as const,
      { address: deployments.hook, abi: orbitalHookAbi, functionName: "liquidityOf", args: [token!], chainId } as const,
      { address: deployments.hook, abi: orbitalHookAbi, functionName: "reserveOf", args: [token!], chainId } as const,
    ],
    query: { enabled: !!token, refetchInterval: REFRESH },
  });
  const balances = wallets.map((w, i) => ({ wallet: w, balance: (balQ.data?.[i]?.result as bigint) ?? 0n }));
  const after = balQ.data?.slice(wallets.length);
  const symbol = (after?.[0]?.result as string) ?? "…";
  const usdcHeld = (after?.[1]?.result as bigint) ?? 0n;
  const poolLiquidity = (after?.[2]?.result as bigint) ?? 0n;
  const poolReserve = (after?.[3]?.result as bigint) ?? 0n;

  // Requests: every open one plus the 8 most recent (ids start at 1; nextRequestId is the latest).
  const ids = useMemo(() => {
    if (!s) return [] as bigint[];
    const set = new Set<bigint>(s.openRequestIds);
    const last = s.nextRequestId;
    for (let i = last; i > 0n && i > last - 8n; i--) set.add(i);
    return [...set].sort((a, b) => (a > b ? -1 : 1));
  }, [s]);
  const reqQ = useReadContracts({
    allowFailure: true,
    contracts: ids.flatMap((id) => [
      { address: vault, abi: vaultAbi, functionName: "getRequest", args: [id], chainId } as const,
      { address: vault, abi: vaultAbi, functionName: "isExecutable", args: [id], chainId } as const,
    ]),
    query: { enabled: ids.length > 0, refetchInterval: REFRESH },
  });
  const requests: VaultRequest[] = ids
    .map((id, i) => {
      const r = reqQ.data?.[i * 2]?.result as ScoringContext["request"] | undefined;
      if (!r || r.state === 0) return undefined;
      return { ...r, id, executable: Boolean(reqQ.data?.[i * 2 + 1]?.result) };
    })
    .filter((r): r is VaultRequest => !!r);

  const changeIds = useMemo(() => {
    if (!s) return [] as bigint[];
    const out: bigint[] = [];
    const last = s.nextChangeId;
    for (let i = last; i > 0n && i > last - 12n; i--) out.push(i);
    return out;
  }, [s]);
  const chQ = useReadContracts({
    allowFailure: true,
    contracts: changeIds.map((id) => ({ address: vault, abi: vaultAbi, functionName: "getChange", args: [id], chainId }) as const),
    query: { enabled: changeIds.length > 0, refetchInterval: REFRESH },
  });
  const changes: VaultChange[] = changeIds
    .map((id, i) => {
      const c = chQ.data?.[i]?.result as Omit<VaultChange, "id"> | undefined;
      return c && c.kind ? { ...c, id } : undefined;
    })
    .filter((c): c is VaultChange => !!c);

  return {
    vault,
    s,
    status,
    name,
    verified,
    lastHeartbeat,
    symbol,
    balances,
    totalTokens: balances.reduce((a, b) => a + b.balance, 0n),
    usdcHeld,
    poolLiquidity,
    poolReserve,
    requests,
    changes,
    isLoading: base.isLoading,
    notVault: base.isSuccess && !s,
    refetch: () => {
      base.refetch();
      balQ.refetch();
      reqQ.refetch();
      chQ.refetch();
    },
  };
}

export type VaultView = ReturnType<typeof useVault>;

/** The Sentinel's inputs for one request, to explain its score term by term with the same math. */
export function useScoringContext(vault: Address | undefined, id: bigint | undefined) {
  return useReadContract({
    address: vault,
    abi: vaultAbi,
    functionName: "scoringContext",
    args: [id ?? 0n],
    chainId,
    query: { enabled: !!vault && id !== undefined, refetchInterval: 20_000 },
  });
}

/** Has `voter` voted on request `id`? */
export function useHasVoted(vault: Address | undefined, id: bigint, voter: Address | undefined) {
  return useReadContract({
    address: vault,
    abi: vaultAbi,
    functionName: "hasVoted",
    args: [id, voter!],
    chainId,
    query: { enabled: !!vault && !!voter, refetchInterval: REFRESH },
  });
}
