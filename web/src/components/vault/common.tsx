"use client";

import { useEffect, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { useAccount } from "wagmi";
import type { AssetInfo, VaultView } from "@/lib/vault";
import { network } from "@/lib/network";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function useRoles(v: VaultView) {
  const { address } = useAccount();
  const s = v.s;
  return {
    address,
    isHot: !!s && !!address && s.hotWallets.some((h) => eq(h, address)),
    isOwner: eq(s?.owner, address),
    isRecovery: eq(s?.recoveryKey, address),
    isGuardian: eq(s?.guardian, address),
    isApprover: eq(s?.approver, address),
  };
}

export function fmtAmount(v: bigint, decimals: number, max = 6): string {
  const s = formatUnits(v, decimals);
  const [w, f = ""] = s.split(".");
  const frac = f.slice(0, max).replace(/0+$/, "");
  return frac ? `${w}.${frac}` : w;
}

export function safeParse(amount: string, decimals: number): bigint | undefined {
  try {
    const v = parseUnits(amount.trim(), decimals);
    return v > 0n ? v : undefined;
  } catch {
    return undefined;
  }
}

export function assetLabel(a: AssetInfo): string {
  if (a.underlying.toLowerCase() === network.tokens.weth.toLowerCase()) return "ETH";
  return a.underlyingSymbol;
}

export function isWeth(a: Address | undefined) {
  return !!a && a.toLowerCase() === network.tokens.weth.toLowerCase();
}

export function findAsset(v: VaultView, underlying: Address | undefined) {
  return v.assets.find((a) => eq(a.underlying, underlying));
}
