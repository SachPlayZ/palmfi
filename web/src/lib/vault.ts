"use client";

import { useMemo } from "react";
import { erc20Abi, isAddress, type Address, type Hex } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { sepolia } from "wagmi/chains";
import { hubAbi, vaultAbi, vaultFactoryAbi } from "@/abi";
import { deployments } from "./deployments";
import { network } from "./network";

const REFRESH = 12_000;
const chainId = sepolia.id;

export type VaultRequest = {
  id: bigint;
  asset: Address;
  destination: Address;
  requester: Address;
  amount: bigint;
  usdValue: bigint;
  createdAt: bigint;
  executableAt: bigint;
  state: number;
  asWeth: boolean;
  secondFactor: boolean;
  recoveryApproved: boolean;
  reasonCodes: bigint;
  requestHash: Hex;
  executable: boolean;
};

export type VaultChange = { id: bigint; kind: number; eta: bigint; done: boolean; data: Hex };

export type AssetInfo = {
  underlying: Address;
  token: Address;
  symbol: string;
  underlyingSymbol: string;
  decimals: number;
  mode: number;
  balances: { wallet: Address; balance: bigint }[];
  total: bigint;
  reserves: bigint;
};

const SCALARS = [
  "owner",
  "institution",
  "guardian",
  "recoveryKey",
  "recoveryVault",
  "approver",
  "passkeyX",
  "passkeyY",
  "defaultReceiver",
  "budget24h",
  "budget7d",
  "hardCap",
  "floorDelay",
  "fullDelay",
  "paused",
  "availableBudgetUsd",
  "hotWallets",
  "underlyings",
  "openRequestIds",
  "nextRequestId",
  "nextChangeId",
  "sensitivePending",
  "unfreezeChallenge",
  "pendingCount",
] as const;

type Scalars = {
  owner: Address;
  institution: boolean;
  guardian: Address;
  recoveryKey: Address;
  recoveryVault: Address;
  approver: Address;
  passkeyX: Hex;
  passkeyY: Hex;
  defaultReceiver: Address;
  budget24h: bigint;
  budget7d: bigint;
  hardCap: bigint;
  floorDelay: number;
  fullDelay: number;
  paused: boolean;
  availableBudgetUsd: bigint;
  hotWallets: readonly Address[];
  underlyings: readonly Address[];
  openRequestIds: readonly bigint[];
  nextRequestId: bigint;
  nextChangeId: bigint;
  sensitivePending: bigint;
  unfreezeChallenge: Hex;
  pendingCount: bigint;
};

/** Resolves a route id (label, name or 0x address) to a Vault address through the factory. */
export function useVaultAddress(id: string | undefined) {
  const decoded = id ? decodeURIComponent(id).toLowerCase() : "";
  const direct = isAddress(decoded) ? (decoded as Address) : undefined;
  const label = !direct && decoded ? decoded.replace(new RegExp(`\\.${network.ensParent.replace(".", "\\.")}$`), "") : "";
  const q = useReadContract({
    address: deployments.factory,
    abi: vaultFactoryAbi,
    functionName: "vaultOf",
    args: [label],
    chainId,
    query: { enabled: !!label && !!deployments.factory },
  });
  const viaName = q.data && q.data !== "0x0000000000000000000000000000000000000000" ? (q.data as Address) : undefined;
  return { vault: direct ?? viaName, isLoading: q.isLoading, notFound: !!label && q.isSuccess && !viaName };
}

export function useVault(vault: Address | undefined) {
  const enabled = !!vault;
  const base = useReadContracts({
    allowFailure: true,
    contracts: [
      ...SCALARS.map((functionName) => ({ address: vault, abi: vaultAbi, functionName, chainId }) as const),
      { address: deployments.hub, abi: hubAbi, functionName: "statusOf", args: [vault!], chainId },
      { address: deployments.hub, abi: hubAbi, functionName: "lastHeartbeat", chainId },
      { address: deployments.factory, abi: vaultFactoryAbi, functionName: "labelOf", args: [vault!], chainId },
    ],
    query: { enabled: enabled && !!deployments.hub, refetchInterval: REFRESH },
  });

  const s = useMemo(() => {
    if (!base.data) return undefined;
    const out: Record<string, unknown> = {};
    SCALARS.forEach((k, i) => (out[k] = base.data[i]?.result));
    if (out.owner === undefined) return undefined; // not a Vault
    return out as Scalars;
  }, [base.data]);
  const tail = base.data?.slice(SCALARS.length);
  const status = tail?.[0]?.result as number | undefined;
  const lastHeartbeat = tail?.[1]?.result as bigint | undefined;
  const label = tail?.[2]?.result as string | undefined;

  const underlyings = s?.underlyings ?? [];
  const hot = s?.hotWallets ?? [];

  const assetsQ = useReadContracts({
    allowFailure: true,
    contracts: underlyings.flatMap((u) => [
      { address: vault, abi: vaultAbi, functionName: "protectedToken", args: [u], chainId } as const,
      { address: vault, abi: vaultAbi, functionName: "marketModeOf", args: [u], chainId } as const,
      { address: u, abi: erc20Abi, functionName: "symbol", chainId } as const,
      { address: u, abi: erc20Abi, functionName: "decimals", chainId } as const,
      { address: u, abi: erc20Abi, functionName: "balanceOf", args: [vault!], chainId } as const,
    ]),
    query: { enabled: enabled && underlyings.length > 0, refetchInterval: REFRESH },
  });
  const tokens = underlyings.map((_, i) => assetsQ.data?.[i * 5]?.result as Address | undefined);

  const balancesQ = useReadContracts({
    allowFailure: true,
    contracts: tokens.flatMap((t) => [
      { address: t, abi: erc20Abi, functionName: "symbol", chainId } as const,
      ...hot.map((h) => ({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [h], chainId }) as const),
    ]),
    query: { enabled: tokens.length > 0 && tokens.every(Boolean), refetchInterval: REFRESH },
  });

  const assets: AssetInfo[] = underlyings.map((u, i) => {
    const per = 1 + hot.length;
    const balances = hot.map((w, j) => ({ wallet: w, balance: (balancesQ.data?.[i * per + 1 + j]?.result as bigint) ?? 0n }));
    return {
      underlying: u,
      token: tokens[i] ?? ("0x" as Address),
      underlyingSymbol: (assetsQ.data?.[i * 5 + 2]?.result as string) ?? "?",
      decimals: Number(assetsQ.data?.[i * 5 + 3]?.result ?? 18),
      mode: Number(assetsQ.data?.[i * 5 + 1]?.result ?? 0),
      reserves: (assetsQ.data?.[i * 5 + 4]?.result as bigint) ?? 0n,
      symbol: (balancesQ.data?.[i * per]?.result as string) ?? "…",
      balances,
      total: balances.reduce((a, b) => a + b.balance, 0n),
    };
  });

  // Requests: every open one plus the 8 most recent.
  const ids = useMemo(() => {
    if (!s) return [] as bigint[];
    const set = new Set<bigint>(s.openRequestIds);
    for (let i = s.nextRequestId; i > 0n && i > s.nextRequestId - 8n; i--) set.add(i);
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
      const r = reqQ.data?.[i * 2]?.result as Omit<VaultRequest, "id" | "executable"> | undefined;
      if (!r) return undefined;
      return {
        ...r,
        id,
        state: Number(r.state),
        createdAt: BigInt(r.createdAt),
        executableAt: BigInt(r.executableAt),
        executable: Boolean(reqQ.data?.[i * 2 + 1]?.result),
      };
    })
    .filter((r): r is VaultRequest => !!r);

  const changeIds = useMemo(() => {
    if (!s) return [] as bigint[];
    const out: bigint[] = [];
    for (let i = s.nextChangeId; i > 0n && i > s.nextChangeId - 12n; i--) out.push(i);
    return out;
  }, [s]);
  const chQ = useReadContracts({
    allowFailure: true,
    contracts: changeIds.map((id) => ({ address: vault, abi: vaultAbi, functionName: "getChange", args: [id], chainId }) as const),
    query: { enabled: changeIds.length > 0, refetchInterval: REFRESH },
  });
  const changes: VaultChange[] = changeIds
    .map((id, i) => {
      const c = chQ.data?.[i]?.result as { kind: number; eta: bigint; done: boolean; data: Hex } | undefined;
      return c ? { id, kind: Number(c.kind), eta: BigInt(c.eta), done: c.done, data: c.data } : undefined;
    })
    .filter((c): c is VaultChange => !!c);

  return {
    vault,
    s,
    status,
    label,
    name: label ? `${label}.${network.ensParent}` : undefined,
    lastHeartbeat,
    assets,
    requests,
    changes,
    isLoading: base.isLoading,
    notVault: base.isSuccess && !s,
    refetch: () => {
      base.refetch();
      assetsQ.refetch();
      balancesQ.refetch();
      reqQ.refetch();
      chQ.refetch();
    },
  };
}

export type VaultView = ReturnType<typeof useVault>;
