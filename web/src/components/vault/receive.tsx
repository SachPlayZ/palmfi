"use client";

import { useMemo, useState } from "react";
import { AddressChip, CopyButton, useOrigin } from "../brand";
import { Card, Field, Input } from "../ui";
import { useV } from "./frame";

/**
 * How money reaches this vault (brief §6.2, §6.4): other vaults pay by name through
 * the Orbital pool, and the vault's own wallets deposit USDC to mint the Protected token.
 * Pay links are plain /pay URLs; nothing is stored.
 */
export function ReceiveTab() {
  const v = useV();
  const name = v.name ?? "";
  const origin = useOrigin();
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const url = useMemo(() => {
    if (!origin || !name) return "";
    const u = new URL("/pay", origin);
    u.searchParams.set("to", name);
    if (Number(amount) > 0) u.searchParams.set("amount", amount);
    if (memo) u.searchParams.set("memo", memo);
    return u.toString();
  }, [origin, name, amount, memo]);
  return (
    <div className="pf-grid2">
      <Card label="Get paid by name" title={`Anyone on palmfi can pay “${name}”`}>
        <div className="flex flex-col gap-4">
          <p className="text-[14px] text-[var(--subtle)]">
            Other vaults pay you through the Orbital pool. They send their token, you receive {v.symbol}, backed 1:1 by USDC.
          </p>
          <Field label="Amount (USDC, optional)">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="Any amount" />
          </Field>
          <Field label="Memo (optional)" hint={`${memo.length}/80`}>
            <Input value={memo} maxLength={80} onChange={(e) => setMemo(e.target.value)} placeholder="Invoice 2026-114" />
          </Field>
          <div className="flex items-center gap-2 rounded-2xl bg-[var(--paper-2)] p-2 pl-4">
            <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{url || "…"}</span>
            <CopyButton text={url} label="Copy link" className="sm" />
          </div>
        </div>
      </Card>
      <Card label="Add USDC yourself" title="Deposit from one of your wallets">
        <div className="flex flex-col gap-4">
          <p className="text-[14px] text-[var(--subtle)]">
            Deposits mint {v.symbol} 1:1 to one of this vault&apos;s wallets. Use the Deposit card on the Overview tab.
          </p>
          <dl className="pf-kv">
            <dt>Vault</dt>
            <dd>
              <AddressChip address={v.vault} />
            </dd>
            <dt>Token</dt>
            <dd>{v.symbol}</dd>
          </dl>
        </div>
      </Card>
    </div>
  );
}
