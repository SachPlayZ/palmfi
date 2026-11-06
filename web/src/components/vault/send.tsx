"use client";

import { useState } from "react";
import { vaultAbi } from "@/abi";
import { BOND, formatUsd } from "@/lib/palm";
import { TxStatus, useTx } from "@/lib/tx";
import type { VaultView } from "@/lib/vault";
import { Badge, Button, Card, Field, Input, Mono, Notice } from "../ui";
import { eq, fmtAmount, safeParse, useDestination, useRoles } from "./common";

/** Unwrap to an address or pay a Vault: instant within the budget, else a Queued request (1 USDC bond). */
export function SendCard({ v }: { v: VaultView }) {
  const roles = useRoles(v);
  const [amount, setAmount] = useState("");
  const [dest, setDest] = useState("");
  const tx = useTx();
  const s = v.s!;
  const amt = safeParse(amount);
  const d = useDestination(dest);
  const myBal = v.balances.find((b) => eq(b.wallet, roles.address))?.balance ?? 0n;
  const instant = !!amt && amt <= s.availableBudget;
  const need = amt ? (instant ? amt : amt + BOND) : 0n;
  const self = eq(d.address, v.vault);

  async function go() {
    if (!v.vault || !amt || !d.address) return;
    const fn = instant ? (d.isVault ? "pay" : "unwrap") : d.isVault ? "requestPayment" : "requestUnwrap";
    const args = d.isVault ? [d.address, amt] : [amt, d.address];
    if (await tx.send({ address: v.vault, abi: vaultAbi, functionName: fn, args }, instant ? (d.isVault ? "Pay Vault" : "Unwrap") : "Queue request")) setAmount("");
  }

  return (
    <Card title="Send">
      {!roles.isWallet && <Notice tone="amber">Connect one of this Vault&apos;s wallets to spend.</Notice>}
      <div className="mt-2 flex flex-col gap-3">
        <Field label="Amount (USDC)" hint={`This wallet holds ${fmtAmount(myBal)} ${v.symbol}`}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
        </Field>
        <Field
          label="Destination"
          hint={
            d.name ? (d.resolving ? "Resolving…" : d.address ? <>→ Vault <Mono>{d.address}</Mono></> : "No Vault under that name") : d.isVault ? "palmfi Vault: paid in its own token" : "Address or Vault name"
          }
        >
          <Input value={dest} onChange={(e) => setDest(e.target.value)} placeholder="0x… or palantir" />
        </Field>
        {amt && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="tabular">{formatUsd(amt)}</span>
            {instant ? <Badge tone="green">instant</Badge> : <Badge tone="amber">Queued request · 1 USDC bond</Badge>}
            {amt > s.hardCap && <span className="text-xs text-[var(--subtle)]">above the Hard cap: at least {Math.round(s.capDelay / 3600)}h unless a majority fast-tracks</span>}
          </div>
        )}
        <Button onClick={go} disabled={!roles.isWallet || !amt || !d.address || self || myBal < need || tx.busy}>
          {amt && myBal < need ? `Not enough ${v.symbol} in this wallet` : instant ? (d.isVault ? "Pay now" : "Unwrap now") : "Queue request"}
        </Button>
        <TxStatus state={tx.state} />
      </div>
    </Card>
  );
}
