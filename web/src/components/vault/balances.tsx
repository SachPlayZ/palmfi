"use client";

import { erc20Abi, maxUint256 } from "viem";
import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { vaultAbi } from "@/abi";
import { arcTestnet, network } from "@/lib/network";
import { formatDuration, formatUsd } from "@/lib/palm";
import { TxStatus, useTx } from "@/lib/tx";
import type { VaultView } from "@/lib/vault";
import { AddressChip, Meter, Ring } from "../brand";
import { Badge, Button, Card, Field, Input, Select } from "../ui";
import { fmtAmount, safeParse, useRoles } from "./common";

export function BalancesCard({ v }: { v: VaultView }) {
  const [held, supply] = v.s?.reserves ?? [0n, 0n];
  const backed = held >= supply;
  const max = v.balances.reduce((a, b) => (b.balance > a ? b.balance : a), 1n);
  return (
    <Card label="Protected USDC" title={v.symbol} actions={<Badge tone={backed ? "green" : "red"}>{backed ? "fully backed" : "reserve short"}</Badge>}>
      <div className="flex items-baseline gap-3">
        <span className="pf-big">{fmtAmount(v.totalTokens, 6, 2)}</span>
        <span className="pf-mono pf-dim">{v.symbol} · 1:1 USDC</span>
      </div>
      <ul className="mt-6 flex flex-col gap-3">
        {v.balances.map((b) => (
          <li key={b.wallet} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 text-sm">
            <AddressChip address={b.wallet} explorer={false} />
            <Meter value={Number((b.balance * 1000n) / max) / 1000} color="var(--moss)" />
            <span className="tabular w-20 text-right">{fmtAmount(b.balance, 6, 2)}</span>
          </li>
        ))}
      </ul>
      <dl className="pf-kv mt-6 border-t border-[var(--line)] pt-4">
        <dt>In the Orbital pool</dt>
        <dd className="tabular">
          {fmtAmount(v.poolLiquidity, 6, 2)} <span className="pf-dim">(pool holds {fmtAmount(v.poolReserve, 6, 2)})</span>
        </dd>
        <dt>Reserves / supply</dt>
        <dd className="tabular">
          {fmtAmount(held, 6, 2)} / {fmtAmount(supply, 6, 2)}
        </dd>
      </dl>
    </Card>
  );
}

export function BudgetCard({ v }: { v: VaultView }) {
  const s = v.s;
  if (!s) return null;
  const avail = s.availableBudget;
  const cap = s.budget24h < s.budget7d ? s.budget24h : s.budget7d;
  const frac = cap > 0n ? Number((avail * 1000n) / cap) / 1000 : 0;
  return (
    <Card label="Instant budget" title="Spend now, no wait">
      <div className="flex items-center gap-6">
        <Ring value={frac} size={104} color="var(--moss)">
          <span className="pf-mono">{Math.round(frac * 100)}%</span>
        </Ring>
        <div className="flex flex-col gap-1">
          <span className="pf-big">{formatUsd(avail)}</span>
          <span className="pf-mono pf-dim">available now · refills over 24h / 7d</span>
        </div>
      </div>
      <dl className="pf-kv mt-6 border-t border-[var(--line)] pt-4">
        <dt>24h / 7d budget</dt>
        <dd className="tabular">
          {formatUsd(s.budget24h)} / {formatUsd(s.budget7d)}
        </dd>
        <dt>Hard cap</dt>
        <dd className="tabular">{formatUsd(s.hardCap)}</dd>
        <dt>Floor · Cap delay · Max delay</dt>
        <dd className="tabular">
          {formatDuration(s.floorDelay)} · {formatDuration(s.capDelay)} · {formatDuration(s.maxDelay)}
        </dd>
        <dt>Business hours</dt>
        <dd className="tabular">
          {s.bizStartHourUtc}:00–{s.bizEndHourUtc}:00 UTC
        </dd>
      </dl>
    </Card>
  );
}

export function DepositCard({ v }: { v: VaultView }) {
  const { address } = useAccount();
  const roles = useRoles(v);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState<string>("");
  const tx = useTx();
  const s = v.s;
  const amt = safeParse(amount);
  const recipient = to || (roles.isWallet ? address : s?.wallets[0]);

  const allowance = useReadContract({
    address: network.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: [address!, v.vault!],
    chainId: arcTestnet.id,
    query: { enabled: !!address && !!v.vault },
  });
  const bal = useReadContract({
    address: network.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address!],
    chainId: arcTestnet.id,
    query: { enabled: !!address },
  });
  const needsApprove = !!amt && (allowance.data ?? 0n) < amt;
  const short = !!amt && bal.data !== undefined && bal.data < amt;

  async function go() {
    if (!v.vault || !amt || !recipient) return;
    if (needsApprove) await tx.send({ address: network.usdc, abi: erc20Abi, functionName: "approve", args: [v.vault, maxUint256] }, "Approve USDC");
    else await tx.send({ address: v.vault, abi: vaultAbi, functionName: "deposit", args: [amt, recipient] }, "Deposit USDC");
  }

  return (
    <Card label="Deposit" title="Add USDC, receive your token">
      <div className="flex flex-col gap-3">
        <Field label="Amount" hint={bal.data !== undefined ? `This wallet: ${fmtAmount(bal.data)} USDC` : undefined}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
        </Field>
        <Field label={`Mint ${v.symbol} to`} hint="Protected tokens can only be held by this Vault's wallets">
          <Select value={recipient ?? ""} onChange={(e) => setTo(e.target.value)}>
            {s?.wallets.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </Select>
        </Field>
        <Button onClick={go} disabled={!amt || !recipient || short || tx.busy}>
          {short ? "Not enough USDC in this wallet" : needsApprove ? "Approve USDC" : "Deposit USDC"}
        </Button>
        <p className="text-xs text-[var(--subtle)]">
          Need testnet USDC?{" "}
          <a className="pf-link" href="https://faucet.circle.com" target="_blank" rel="noreferrer">
            Circle faucet
          </a>{" "}
          (Arc testnet).
        </p>
        <TxStatus state={tx.state} />
      </div>
    </Card>
  );
}
