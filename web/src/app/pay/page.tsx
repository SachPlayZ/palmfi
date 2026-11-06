"use client";

import { useState } from "react";
import { PoolPayCard } from "@/components/pay";
import { Card, Field, Input } from "@/components/ui";
import { VaultGate } from "@/components/vault/dashboard";

export default function PayPage() {
  const [from, setFrom] = useState("");
  const [open, setOpen] = useState("");
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Pay by name</h1>
        <p className="text-sm text-[var(--subtle)]">
          Org-to-org payments go through one Orbital pool on Uniswap v4: you pay in your Protected token, they receive theirs, and both Vaults&apos; controls apply.
        </p>
      </div>
      <Card title="Pay from your Vault">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setOpen(from.trim().toLowerCase());
          }}
        >
          <Field label="Your Vault">
            <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="nvidia" onBlur={() => setOpen(from.trim().toLowerCase())} />
          </Field>
        </form>
      </Card>
      {open && <VaultGate id={open}>{(v) => <PoolPayCard v={v} />}</VaultGate>}
    </>
  );
}
