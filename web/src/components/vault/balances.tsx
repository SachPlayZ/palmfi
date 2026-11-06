"use client";

import { erc20Abi, maxUint256 } from "viem";
import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { vaultAbi } from "@/abi";
import { arcTestnet, network } from "@/lib/network";
import { formatDuration, formatUsd } from "@/lib/palm";
import { TxStatus, useTx } from "@/lib/tx";
import type { VaultView } from "@/lib/vault";
import { Badge, Button, Card, Field, Input, Mono, Select, short } from "../ui";
import { fmtAmount, outflowsOpen, safeParse, statusLabel, useRoles } from "./common";

export function BalancesCard({ v }: { v: VaultView }) {
  const [held, supply] = v.s?.reserves ?? [0n, 0n];
  const backed = held >= supply;
  return (
    <Card title={`${v.symbol} (Protected USDC)`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="tabular text-2xl font-semibold">{fmtAmount(v.totalTokens)}</span>
          <span className="font-medium">{v.symbol}</span>
          <span className="text-xs text-[var(--subtle)]">1:1 USDC</span>
        </div>
        <Badge tone={backed ? "green" : "red"}>{backed ? "fully backed" : "reserve short"}</Badge>
      </div>
      <ul className="mt-2 flex flex-col gap-0.5 text-xs text-[var(--subtle)]">
        {v.balances.map((b) => (
          <li key={b.wallet} className="flex justify-between gap-2">
            <Mono>{short(b.wallet)}</Mono>
            <span className="tabular">{fmtAmount(b.balance)}</span>
          </li>
        ))}
        <li className="flex justify-between gap-2 border-t border-[var(--border)] pt-1">
          <span>In the Orbital pool (yours to withdraw)</span>
          <span className="tabular">
            {fmtAmount(v.poolLiquidity)} (pool holds {fmtAmount(v.poolReserve)})
          </span>
        </li>
        <li className="flex justify-between gap-2">
          <span>USDC reserves / token supply</span>
          <span className="tabular">
            {fmtAmount(held)} / {fmtAmount(supply)}
          </span>
        </li>
      </ul>
    </Card>
  );
}

export function BudgetCard({ v }: { v: VaultView }) {
  const s = v.s;
  if (!s) return null;
  const avail = s.availableBudget;
  const cap = s.budget24h < s.budget7d ? s.budget24h : s.budget7d;
  const pct = cap > 0n ? Number((avail * 100n) / cap) : 0;
  return (
    <Card title="Instant budget">
      <div className="flex items-baseline gap-2">
        <span className="tabular text-3xl font-semibold">{formatUsd(avail)}</span>
        <span className="text-sm text-[var(--subtle)]">{outflowsOpen(v) ? "available now" : `paused while ${statusLabel(v)}`}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--muted)]" aria-hidden>
        <div className="h-full bg-[var(--accent)]" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-[var(--subtle)]">24h / 7d budget</dt>
        <dd className="tabular text-right">
          {formatUsd(s.budget24h)} / {formatUsd(s.budget7d)}
        </dd>
        <dt className="text-[var(--subtle)]">Hard cap</dt>
        <dd className="tabular text-right">{formatUsd(s.hardCap)}</dd>
        <dt className="text-[var(--subtle)]">Floor / CapDelay / MaxDelay</dt>
        <dd className="tabular text-right">
          {formatDuration(s.floorDelay)} / {formatDuration(s.capDelay)} / {formatDuration(s.maxDelay)}
        </dd>
        <dt className="text-[var(--subtle)]">Business hours (UTC)</dt>
        <dd className="tabular text-right">
          {s.bizStartHourUtc}:00–{s.bizEndHourUtc}:00
        </dd>
      </dl>
      <p className="mt-2 text-xs text-[var(--subtle)]">
        Above the budget, a payment is a Queued request: the Sentinel sets its delay from how unusual it is, and any majority of wallets can veto or fast-track it.
      </p>
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
    <Card title="Deposit USDC">
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
          <a className="underline" href="https://faucet.circle.com" target="_blank" rel="noreferrer">
            Circle faucet
          </a>{" "}
          (Arc testnet).
        </p>
        <TxStatus state={tx.state} />
      </div>
    </Card>
  );
}
