"use client";

import { erc20Abi, maxUint256, type Address } from "viem";
import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { sepolia } from "wagmi/chains";
import { vaultAbi } from "@/abi";
import { MODE_LABEL, formatUsd } from "@/lib/palm";
import { TxStatus, useTx } from "@/lib/tx";
import type { VaultView } from "@/lib/vault";
import { Badge, Button, Card, Field, Input, Mono, Select, short } from "../ui";
import { assetLabel, fmtAmount, isWeth, safeParse, useRoles } from "./common";

export function BalancesCard({ v }: { v: VaultView }) {
  return (
    <Card title="Protected tokens">
      {v.assets.length === 0 && <p className="text-sm text-[var(--subtle)]">Loading…</p>}
      <div className="flex flex-col gap-3">
        {v.assets.map((a) => (
          <div key={a.underlying} className="rounded-lg border border-[var(--border)] p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-2">
                <span className="tabular text-2xl font-semibold">{fmtAmount(a.total, a.decimals)}</span>
                <span className="font-medium">{a.symbol}</span>
                <span className="text-xs text-[var(--subtle)]">1:1 {assetLabel(a)}</span>
              </div>
              <Badge tone={a.mode === 0 ? "green" : a.mode === 1 ? "amber" : "red"}>{MODE_LABEL[a.mode]}</Badge>
            </div>
            <ul className="mt-2 flex flex-col gap-0.5 text-xs text-[var(--subtle)]">
              {a.balances.map((b) => (
                <li key={b.wallet} className="flex justify-between gap-2">
                  <Mono>{short(b.wallet)}</Mono>
                  <span className="tabular">{fmtAmount(b.balance, a.decimals)}</span>
                </li>
              ))}
              <li className="flex justify-between gap-2 border-t border-[var(--border)] pt-1">
                <span>Reserves held by the Vault</span>
                <span className="tabular">
                  {fmtAmount(a.reserves, a.decimals)} {a.underlyingSymbol}
                </span>
              </li>
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function BudgetCard({ v }: { v: VaultView }) {
  const s = v.s;
  if (!s) return null;
  const avail = s.availableBudgetUsd;
  const cap = s.budget24h < s.budget7d ? s.budget24h : s.budget7d;
  const pct = cap > 0n ? Number((avail * 100n) / cap) : 0;
  return (
    <Card title="Instant budget">
      <div className="flex items-baseline gap-2">
        <span className="tabular text-3xl font-semibold">{formatUsd(avail)}</span>
        <span className="text-sm text-[var(--subtle)]">available now</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--muted)]" aria-hidden>
        <div className="h-full bg-[var(--accent)]" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-[var(--subtle)]">24h budget</dt>
        <dd className="tabular text-right">{formatUsd(s.budget24h)}</dd>
        <dt className="text-[var(--subtle)]">7d budget</dt>
        <dd className="tabular text-right">{formatUsd(s.budget7d)}</dd>
        <dt className="text-[var(--subtle)]">Hard cap</dt>
        <dd className="tabular text-right">{formatUsd(s.hardCap)}</dd>
        <dt className="text-[var(--subtle)]">Floor</dt>
        <dd className="tabular text-right">{Math.round(s.floorDelay / 60)} min</dd>
        <dt className="text-[var(--subtle)]">Full delay</dt>
        <dd className="tabular text-right">{(s.fullDelay / 3600).toFixed(1)} h</dd>
      </dl>
      <p className="mt-2 text-xs text-[var(--subtle)]">Refills gradually over the 24h and 7d windows, shared across all assets.</p>
      {s.sensitivePending > 0n && (
        <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
          A Guardian / Recovery / passkey change is pending, so the Instant budget is zero until it executes or is cancelled.
        </p>
      )}
    </Card>
  );
}

const ETH_NATIVE = "native" as const;

export function DepositCard({ v }: { v: VaultView }) {
  const { address } = useAccount();
  const roles = useRoles(v);
  const [asset, setAsset] = useState<string>(ETH_NATIVE);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState<string>("");
  const tx = useTx();
  const s = v.s;
  const selected = asset === ETH_NATIVE ? undefined : v.assets.find((a) => a.underlying === asset);
  const decimals = selected?.decimals ?? 18;
  const amt = safeParse(amount, decimals);
  const recipient = (to || (roles.isHot ? address : s?.defaultReceiver)) as Address | undefined;

  const allowance = useReadContract({
    address: selected?.underlying,
    abi: erc20Abi,
    functionName: "allowance",
    args: [address!, v.vault!],
    chainId: sepolia.id,
    query: { enabled: !!selected && !!address && !!v.vault },
  });
  const bal = useReadContract({
    address: selected?.underlying,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address!],
    chainId: sepolia.id,
    query: { enabled: !!selected && !!address },
  });
  const needsApprove = !!selected && !!amt && (allowance.data ?? 0n) < amt;

  async function go() {
    if (!v.vault || !amt || !recipient) return;
    if (asset === ETH_NATIVE) {
      await tx.send({ address: v.vault, abi: vaultAbi, functionName: "depositETH", args: [recipient], value: amt }, "Deposit ETH");
    } else if (needsApprove) {
      await tx.send({ address: selected!.underlying, abi: erc20Abi, functionName: "approve", args: [v.vault, maxUint256] }, `Approve ${selected!.underlyingSymbol}`);
    } else {
      await tx.send({ address: v.vault, abi: vaultAbi, functionName: "deposit", args: [selected!.underlying, amt, recipient] }, `Deposit ${selected!.underlyingSymbol}`);
    }
  }

  return (
    <Card title="Deposit">
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Field label="Amount" hint={selected && bal.data !== undefined ? `Wallet: ${fmtAmount(bal.data, decimals)} ${selected.underlyingSymbol}` : undefined}>
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
          </Field>
          <Field label="Asset">
            <Select value={asset} onChange={(e) => setAsset(e.target.value)}>
              <option value={ETH_NATIVE}>ETH (native)</option>
              {v.assets.map((a) => (
                <option key={a.underlying} value={a.underlying}>
                  {a.underlyingSymbol}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Mint to Hot wallet" hint="Protected tokens can only be held by this Vault's Hot wallets">
          <Select value={recipient ?? ""} onChange={(e) => setTo(e.target.value)}>
            {s?.hotWallets.map((h) => (
              <option key={h} value={h}>
                {h} {h === s.defaultReceiver ? "(default)" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Button onClick={go} disabled={!amt || !recipient || tx.busy}>
          {asset === ETH_NATIVE ? "Deposit ETH" : needsApprove ? `Approve ${selected?.underlyingSymbol}` : `Deposit ${selected?.underlyingSymbol ?? ""}`}
        </Button>
        {asset !== ETH_NATIVE && isWeth(selected?.underlying) && <p className="text-xs text-[var(--subtle)]">WETH deposits mint the same ETH Protected token.</p>}
        <TxStatus state={tx.state} />
      </div>
    </Card>
  );
}
