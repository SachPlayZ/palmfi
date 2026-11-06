"use client";

import { useState } from "react";
import { DirectPayCard, NetworkPayCard } from "@/components/pay";
import { Card, Field, Input } from "@/components/ui";
import { VaultGate } from "@/components/vault/dashboard";
import { network } from "@/lib/network";

export default function PayPage() {
  const [from, setFrom] = useState("");
  const [open, setOpen] = useState("");
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Pay by name</h1>
        <p className="text-sm text-[var(--subtle)]">Type a name to see who you&apos;re paying: verified badge and live status, straight from ENS and the Hub.</p>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <DirectPayCard />
        <div className="flex flex-col gap-5">
          <Card title="Or pay from your Vault">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setOpen(from.trim().toLowerCase());
              }}
            >
              <Field label="Your Vault" hint="Uses a Network transfer: burn your Protected token, mint theirs.">
                <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder={`palantir.${network.ensParent}`} onBlur={() => setOpen(from.trim().toLowerCase())} />
              </Field>
            </form>
          </Card>
          {open && <VaultGate id={open}>{(v) => <NetworkPayCard v={v} />}</VaultGate>}
        </div>
      </div>
    </>
  );
}
