"use client";

import { useState } from "react";
import { erc20Abi, maxUint256, type Address } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { sepolia } from "wagmi/chains";
import { vaultAbi } from "@/abi";
import { toFullName, useNameProfile, type NameProfile } from "@/lib/ens";
import { network } from "@/lib/network";
import { BOND_WEI, formatUsd } from "@/lib/palm";
import { TxStatus, useTx } from "@/lib/tx";
import type { VaultView } from "@/lib/vault";
import { NameCard } from "./name-card";
import { Badge, Button, Card, Field, Input, Notice, Select } from "./ui";
import { assetLabel, fmtAmount, safeParse, useRoles } from "./vault/common";

export function NameLookup({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return (
    <Field label="Pay to name" hint={`e.g. nvidia or nvidia.${network.ensParent}`}>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="name" autoComplete="off" />
    </Field>
  );
}

function payable(p: NameProfile) {
  return !!p.vault && p.status !== "revoked" && p.status !== "migrated";
}

/** Member → Member Network transfer by name (burn payer's Protected token, mint payee's). */
export function NetworkPayCard({ v }: { v: VaultView }) {
  const roles = useRoles(v);
  const [to, setTo] = useState("");
  const [assetAddr, setAssetAddr] = useState("");
  const [amount, setAmount] = useState("");
  const tx = useTx();
  const p = useNameProfile(toFullName(to));
  const asset = v.assets.find((a) => a.underlying === assetAddr) ?? v.assets[0];
  const amt = asset ? safeParse(amount, asset.decimals) : undefined;
  const usd = useReadContract({
    address: v.vault,
    abi: vaultAbi,
    functionName: "valueUsd",
    args: [asset?.underlying as Address, amt ?? 0n],
    chainId: sepolia.id,
    query: { enabled: !!asset && !!amt && !!v.vault },
  });
  const usdValue = usd.data?.[0];
  const instant = usdValue !== undefined && v.s ? usdValue <= v.s.availableBudgetUsd && !usd.data?.[1] : undefined;
  const self = p.vault?.toLowerCase() === v.vault?.toLowerCase();

  async function go() {
    if (!p.vault || !amt || !asset) return;
    if (instant) {
      await tx.send({ address: v.vault!, abi: vaultAbi, functionName: "networkTransfer", args: [asset.underlying, amt, p.vault] }, "Network transfer");
    } else {
      await tx.send({ address: v.vault!, abi: vaultAbi, functionName: "requestUnwrap", args: [asset.underlying, amt, p.vault, true], value: BOND_WEI }, "Queued Network transfer");
    }
  }

  return (
    <Card title="Network transfer by name">
      <div className="flex flex-col gap-3">
        <NameLookup value={to} onChange={setTo} />
        <NameCard p={p} />
        {p.type === "personal" && <Notice tone="gray">This is a personal name, not a verified Institution.</Notice>}
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Field label="Amount">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="12" />
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
        {usdValue !== undefined && (
          <div className="flex items-center gap-2 text-sm">
            ≈ {formatUsd(usdValue)}
            {instant ? <Badge tone="green">within Instant budget</Badge> : <Badge tone="amber">queues: 0.001 ETH bond</Badge>}
          </div>
        )}
        <Button onClick={go} disabled={!roles.isHot || !payable(p) || self || !amt || tx.busy}>
          {instant === false ? "Create Queued request" : "Pay"}
        </Button>
        {!roles.isHot && <p className="text-xs text-[var(--subtle)]">Connect a treasury Hot wallet to pay.</p>}
        <TxStatus state={tx.state} />
      </div>
    </Card>
  );
}

const NATIVE = "native";

/** Anyone pays into a name's Vault: deposit to the payee's receiving Hot wallet (mints their Protected token). */
export function DirectPayCard() {
  const { address } = useAccount();
  const [to, setTo] = useState("");
  const [asset, setAsset] = useState<string>(network.tokens.usdc);
  const [amount, setAmount] = useState("");
  const tx = useTx();
  const p = useNameProfile(toFullName(to));
  const decimals = useReadContract({ address: asset === NATIVE ? undefined : (asset as Address), abi: erc20Abi, functionName: "decimals", chainId: sepolia.id, query: { enabled: asset !== NATIVE } });
  const dec = asset === NATIVE ? 18 : (decimals.data ?? 6);
  const amt = safeParse(amount, dec);
  const receiver = useReadContract({ address: p.vault, abi: vaultAbi, functionName: "defaultReceiver", chainId: sepolia.id, query: { enabled: !!p.vault } });
  const allowance = useReadContract({
    address: asset === NATIVE ? undefined : (asset as Address),
    abi: erc20Abi,
    functionName: "allowance",
    args: [address!, p.vault!],
    chainId: sepolia.id,
    query: { enabled: asset !== NATIVE && !!address && !!p.vault },
  });
  const bal = useReadContract({
    address: asset === NATIVE ? undefined : (asset as Address),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address!],
    chainId: sepolia.id,
    query: { enabled: asset !== NATIVE && !!address },
  });
  const needsApprove = asset !== NATIVE && !!amt && (allowance.data ?? 0n) < amt;

  async function go() {
    if (!p.vault || !amt || !receiver.data) return;
    if (asset === NATIVE) {
      await tx.send({ address: p.vault, abi: vaultAbi, functionName: "depositETH", args: [receiver.data], value: amt }, "Pay ETH");
    } else if (needsApprove) {
      await tx.send({ address: asset as Address, abi: erc20Abi, functionName: "approve", args: [p.vault, maxUint256] }, "Approve");
    } else {
      await tx.send({ address: p.vault, abi: vaultAbi, functionName: "deposit", args: [asset as Address, amt, receiver.data] }, "Pay");
    }
  }

  return (
    <Card title="Pay by name">
      <div className="flex flex-col gap-3">
        <NameLookup value={to} onChange={setTo} />
        <NameCard p={p} />
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Field label="Amount" hint={bal.data !== undefined ? `Wallet: ${fmtAmount(bal.data, dec)}` : undefined}>
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="5" />
          </Field>
          <Field label="Asset">
            <Select value={asset} onChange={(e) => setAsset(e.target.value)}>
              <option value={network.tokens.usdc}>USDC</option>
              <option value={network.tokens.weth}>WETH</option>
              <option value={NATIVE}>ETH</option>
            </Select>
          </Field>
        </div>
        <p className="text-xs text-[var(--subtle)]">
          The payment lands in their Vault as their Protected token, so it&apos;s protected from the first block. It arrives even if their Vault is Frozen.
        </p>
        <Button onClick={go} disabled={!payable(p) || !amt || !receiver.data || tx.busy}>
          {needsApprove ? "Approve" : `Pay ${p.name ?? ""}`}
        </Button>
        <TxStatus state={tx.state} />
      </div>
    </Card>
  );
}
