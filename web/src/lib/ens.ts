"use client";

import { normalize } from "viem/ens";
import type { Address } from "viem";
import { useEnsAddress, useEnsText, useReadContract } from "wagmi";
import { sepolia } from "wagmi/chains";
import { hubAbi } from "@/abi";
import { deployments } from "./deployments";
import { network } from "./network";
import { STATUS_LABEL, labelFromName, parseTokensRecord } from "./palm";

/** "alice" → "alice.palmfi.eth"; full names under other parents pass through. */
export function toFullName(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (s.includes(".")) {
    try {
      return normalize(s);
    } catch {
      return null;
    }
  }
  const l = labelFromName(s, network.ensParent);
  return l ? `${l}.${network.ensParent}` : null;
}

/**
 * A name's public profile, read only through viem ENS actions on Sepolia (Universal Resolver from viem's chain
 * definition, nothing hard-coded): addr + text records type / verified / status / tokens / url / avatar,
 * plus the live Hub status (the source of truth that ENS mirrors).
 */
export function useNameProfile(name: string | null) {
  const q = { chainId: sepolia.id, query: { enabled: !!name, refetchInterval: 15_000 } } as const;
  const n = name ?? undefined;
  const addr = useEnsAddress({ name: n, ...q });
  const type = useEnsText({ name: n, key: "type", ...q });
  const verified = useEnsText({ name: n, key: "verified", ...q });
  const status = useEnsText({ name: n, key: "status", ...q });
  const tokens = useEnsText({ name: n, key: "tokens", ...q });
  const url = useEnsText({ name: n, key: "url", ...q });
  const avatar = useEnsText({ name: n, key: "avatar", ...q });
  const vault = (addr.data ?? undefined) as Address | undefined;
  const hub = useReadContract({
    address: deployments.hub,
    abi: hubAbi,
    functionName: "statusOf",
    args: [vault!],
    chainId: sepolia.id,
    query: { enabled: !!vault && !!deployments.hub, refetchInterval: 10_000 },
  });
  const liveStatus = hub.data !== undefined ? STATUS_LABEL[Number(hub.data)] : undefined;
  return {
    name,
    vault,
    type: type.data ?? undefined,
    verified: verified.data === "true",
    ensStatus: status.data ?? undefined,
    /** Hub status when readable, else the ENS mirror. */
    status: liveStatus && liveStatus !== "unknown" ? liveStatus : (status.data ?? undefined),
    tokens: parseTokensRecord(tokens.data),
    url: url.data ?? undefined,
    avatar: avatar.data ?? undefined,
    isLoading: addr.isLoading || status.isLoading,
    error: addr.error ?? status.error,
    found: !!vault || !!status.data,
  };
}

export type NameProfile = ReturnType<typeof useNameProfile>;
