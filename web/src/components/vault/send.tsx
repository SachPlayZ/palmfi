"use client";

import { useState } from "react";
import { isAddress, type Address } from "viem";
import { useEnsAddress, useReadContract } from "wagmi";
import { sepolia } from "wagmi/chains";
import { vaultAbi, vaultFactoryAbi } from "@/abi";
import { deployments } from "@/lib/deployments";
import { toFullName } from "@/lib/ens";
import { BOND_WEI, formatUsd } from "@/lib/palm";
import { TxStatus, useTx } from "@/lib/tx";
import type { VaultView } from "@/lib/vault";
import { Badge, Button, Card, Field, Input, Mono, Notice, Select } from "../ui";
import { assetLabel, fmtAmount, isWeth, safeParse, useRoles } from "./common";

/** Resolves an address or a name (alice → alice.palmfi.eth) through ENS on Sepolia. */
export function useDestination(input: string) {
  const trimmed = input.trim();
  const direct = isAddress(trimmed) ? (trimmed as Address) : undefined;
  const name = !direct && trimmed ? toFullName(trimmed) : null;
  const ens = useEnsAddress({ name: name ?? undefined, chainId: sepolia.id, query: { enabled: !!name } });
  const address = direct ?? ((ens.data ?? undefined) as Address | undefined);
  const isVault = useReadContract({
    address: deployments.factory,
    abi: vaultFactoryAbi,
    functionName: "isVault",
    args: [address!],
    chainId: sepolia.id,
    query: { enabled: !!address && !!deployments.factory },
  });
  return { address, name, resolving: ens.isLoading, isVault: !!isVault.data };
}

export function SendCard({ v }: { v: VaultView }) {
  const roles = useRoles(v);
  const [assetAddr, setAssetAddr] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [dest, setDest] = useState("");
  const [asWeth, setAsWeth] = useState(false);
  const tx = useTx();
  const s = v.s;
  const asset = v.assets.find((a) => a.underlying === assetAddr) ?? v.assets[0];
  const amt = asset ? safeParse(amount, asset.decimals) : undefined;
  const d = useDestination(dest);
  const myBal = asset?.balances.find((b) => b.wallet.toLowerCase() === roles.address?.toLowerCase())?.balance ?? 0n;

  const usd = useReadContract({
    address: v.vault,
    abi: vaultAbi,
    functionName: "valueUsd",
    args: [asset?.underlying as Address, amt ?? 0n],
    chainId: sepolia.id,
    query: { enabled: !!asset && !!amt && !!v.vault },
  });
  const usdValue = usd.data?.[0];
  const stale = usd.data?.[1];
  const instant = usdValue !== undefined && s ? usdValue <= s.availableBudgetUsd && !stale : undefined;

  async function go() {
    if (!v.vault || !asset || !amt || !d.address) return;
    if (instant) {
      await tx.send(
        { address: v.vault, abi: vaultAbi, functionName: "unwrap", args: [asset.underlying, amt, d.address, asWeth] },
        d.isVault ? "Network transfer" : "Unwrap",
      );
    } else {
      await tx.send(
        { address: v.vault, abi: vaultAbi, functionName: "requestUnwrap", args: [asset.underlying, amt, d.address, asWeth], value: BOND_WEI },
        "Queued request",
      );
    }
  }

  return (
    <Card title="Unwrap / send">
      {!roles.isHot && <Notice tone="amber">Connect one of this Vault&apos;s Hot wallets to spend.</Notice>}
      <div className="mt-2 flex flex-col gap-3">
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Field label="Amount" hint={asset ? `This Hot wallet holds ${fmtAmount(myBal, asset.decimals)} ${asset.symbol}` : undefined}>
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
          </Field>
          <Field label="Asset">
            <Select value={asset?.underlying ?? ""} onChange={(e) => setAssetAddr(e.target.value)}>
              {v.assets.map((a) => (
                <option key={a.underlying} value={a.underlying}>
                  {assetLabel(a)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Destination" hint={d.name ? (d.resolving ? "Resolving…" : d.address ? <>→ <Mono>{d.address}</Mono></> : "Name doesn't resolve") : "Address or name"}>
          <Input value={dest} onChange={(e) => setDest(e.target.value)} placeholder="0x… or bob" />
        </Field>
        {isWeth(asset?.underlying) && !d.isVault && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={asWeth} onChange={(e) => setAsWeth(e.target.checked)} /> Receive WETH instead of native ETH
          </label>
        )}
        {usdValue !== undefined && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="tabular">≈ {formatUsd(usdValue)}</span>
            {stale ? (
              <Badge tone="red">price stale</Badge>
            ) : instant ? (
              <Badge tone="green">{d.isVault ? "instant Network transfer" : "instant lane"}</Badge>
            ) : (
              <Badge tone="amber">Queued request: 0.001 ETH bond</Badge>
            )}
            {!instant && s && usdValue > s.hardCap && !s.institution && <span className="text-xs text-[var(--subtle)]">above Hard cap: needs Face ID</span>}
          </div>
        )}
        <Button onClick={go} disabled={!roles.isHot || !amt || !d.address || tx.busy || usdValue === undefined}>
          {instant ? (d.isVault ? "Send Network transfer" : "Unwrap now") : "Create Queued request"}
        </Button>
        <TxStatus state={tx.state} />
      </div>
    </Card>
  );
}
