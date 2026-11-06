"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAccount } from "wagmi";
import { useMyVaults } from "@/lib/hub";
import { STATUS_LABEL } from "@/lib/palm";
import { AddressChip, OrgCard, PageHead, Skeleton, WalletGate } from "./brand";
import { Badge, Card, StatusBadge } from "./ui";

export function VaultsHome() {
  const router = useRouter();
  const { address } = useAccount();
  const my = useMyVaults(address);
  const [q, setQ] = useState("");
  return (
    <>
      <PageHead
        index="(Vaults)"
        title="Your vaults,"
        em="behind brakes."
        lede="Every vault your wallet votes in. Open one by name or address, or create one for your team in a single transaction."
        actions={
          <Link className="pf-btn dark" href="/onboard">
            Create a vault
          </Link>
        }
      />
      <Card label="Open a vault" title="Jump to any vault by name">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) router.push(`/vault/${encodeURIComponent(q.trim().toLowerCase())}`);
          }}
        >
          <input
            className="pf-input flex-1"
            placeholder="northwind or 0x…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Vault name or address"
          />
          <button className="pf-btn dark" type="submit" disabled={!q.trim()}>
            Open
          </button>
        </form>
      </Card>
      <WalletGate title="Connect to see your vaults">
        {my.isLoading ? (
          <div className="pf-grid3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} h={190} className="rounded-[18px]" />
            ))}
          </div>
        ) : my.mine.length === 0 ? (
          <Card>
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-[52ch] text-[15px] text-[var(--ink-2)]">
                This wallet isn&apos;t a voter in any vault yet. Create one, or ask your team to propose adding it.
              </p>
              <Link className="pf-btn line" href="/directory">
                Browse the directory
              </Link>
            </div>
          </Card>
        ) : (
          <div className="pf-grid3">
            {my.mine.map((m, i) => (
              <Link
                key={m.vault}
                href={`/vault/${m.name ?? m.vault}`}
                className="pf-card lift group flex flex-col gap-6"
                data-pf
                style={{ "--d": `${i * 0.06}s` } as React.CSSProperties}
              >
                <div className="flex items-start justify-between">
                  <OrgCard name={m.name ?? m.vault} width={64} tilt />
                  <span className="flex flex-col items-end gap-1.5">
                    <StatusBadge status={STATUS_LABEL[m.status ?? 0]} />
                    {m.verified && <Badge tone="blue">verified</Badge>}
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  <span className="pf-serif text-[34px] leading-none tracking-tight">{m.name ?? "vault"}</span>
                  <AddressChip address={m.vault} explorer={false} />
                </div>
                <span className="pf-mono pf-dim transition-colors group-hover:text-[var(--ink)]">Open dashboard →</span>
              </Link>
            ))}
          </div>
        )}
      </WalletGate>
    </>
  );
}
