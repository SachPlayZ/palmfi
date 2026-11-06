"use client";

import type { NameProfile } from "@/lib/ens";
import { Badge, Mono, StatusBadge } from "./ui";

export function VerifiedBadge({ verified, type }: { verified: boolean; type?: string }) {
  if (verified) return <Badge tone="blue">verified {type === "institution" ? "Institution" : ""}</Badge>;
  return <Badge tone="gray">{type === "institution" ? "unverified Institution" : type === "personal" ? "personal" : "not verified"}</Badge>;
}

export function NameCard({ p }: { p: NameProfile }) {
  if (!p.name) return null;
  if (p.isLoading) return <p className="text-sm text-[var(--subtle)]">Resolving {p.name}…</p>;
  if (!p.found) return <p className="text-sm text-[var(--subtle)]">{p.name} doesn&apos;t resolve on Sepolia.</p>;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        {p.avatar && /^https?:\/\//.test(p.avatar) && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.avatar} alt="" className="h-7 w-7 rounded-full object-cover" />
        )}
        <span className="font-semibold">{p.name}</span>
        <VerifiedBadge verified={p.verified} type={p.type} />
        <StatusBadge status={p.status} />
        {p.ensStatus && p.status !== p.ensStatus && (
          <span className="text-xs text-[var(--subtle)]">(ENS still shows {p.ensStatus})</span>
        )}
      </div>
      <div className="text-xs text-[var(--subtle)]">
        Vault <Mono>{p.vault ?? "(address cleared)"}</Mono>
      </div>
      {p.tokens.length > 0 && (
        <div className="flex flex-wrap gap-1 text-xs">
          {p.tokens.map((t) => (
            <Badge key={t.address}>
              {t.symbol} <span className="ml-1 font-mono">{t.address.slice(0, 8)}…</span>
            </Badge>
          ))}
        </div>
      )}
      {p.url && (
        <a href={p.url} target="_blank" rel="noreferrer" className="text-xs underline">
          {p.url}
        </a>
      )}
      {p.status === "frozen" && <p className="text-sm text-red-600 dark:text-red-400">This Vault is Frozen. Payments in still arrive; nothing leaves.</p>}
      {p.status === "revoked" && <p className="text-sm text-red-600 dark:text-red-400">This name was revoked. Do not pay it.</p>}
      {p.status === "migrated" && <p className="text-sm text-amber-600">This Vault was migrated; wait for the Owner to reissue the name.</p>}
    </div>
  );
}
