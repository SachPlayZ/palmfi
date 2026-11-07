"use client";

import { useEffect, useState } from "react";
import { formatUnits, isAddress, parseUnits, type Address } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { hubAbi, vaultFactoryAbi } from "@/abi";
import { deployments } from "@/lib/deployments";
import { arcTestnet } from "@/lib/network";
import { STATUS, STATUS_LABEL } from "@/lib/palm";
import type { VaultView } from "@/lib/vault";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Unwraps, payments, requests and executes need an Active Vault (the contracts' outflowsOpen). */
export const outflowsOpen = (v: VaultView) => v.status === STATUS.ACTIVE;
export const statusLabel = (v: VaultView) => (v.status !== undefined ? STATUS_LABEL[v.status] : "inactive");

export const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Every wallet is a Voter; the Recovery key can only unfreeze or migrate. */
export function useRoles(v: VaultView) {
  const { address } = useAccount();
  const s = v.s;
  return {
    address,
    isWallet: !!s && !!address && s.wallets.some((w) => eq(w, address)),
    isRecovery: eq(s?.recoveryKey, address),
  };
}

export function fmtAmount(v: bigint, decimals = 6, max = 6): string {
  const s = formatUnits(v, decimals);
  const [w, f = ""] = s.split(".");
  const frac = f.slice(0, max).replace(/0+$/, "");
  return frac ? `${w}.${frac}` : w;
}

export function safeParse(amount: string, decimals = 6): bigint | undefined {
  try {
    const v = parseUnits(amount.trim(), decimals);
    return v > 0n ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Resolves an address or a Hub name to an address, and says whether it's a palmfi Vault. */
export function useDestination(input: string) {
  const trimmed = input.trim();
  const direct = isAddress(trimmed) ? (trimmed as Address) : undefined;
  const name = !direct && trimmed ? trimmed.toLowerCase() : "";
  const r = useReadContract({
    address: deployments.hub,
    abi: hubAbi,
    functionName: "resolve",
    args: [name],
    chainId: arcTestnet.id,
    query: { enabled: !!name && !!deployments.hub },
  });
  const viaName = r.data && !/^0x0{40}$/.test(r.data) ? (r.data as Address) : undefined;
  const address = direct ?? viaName;
  const isVault = useReadContract({
    address: deployments.factory,
    abi: vaultFactoryAbi,
    functionName: "isVault",
    args: [address!],
    chainId: arcTestnet.id,
    query: { enabled: !!address && !!deployments.factory },
  });
  return { address, name, resolving: r.isLoading, unknownName: !!name && r.isSuccess && !viaName, isVault: !!isVault.data };
}
