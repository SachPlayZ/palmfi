"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, type ReactNode } from "react";
import { deployments, isDeployed } from "@/lib/deployments";
import { REQ, STATUS } from "@/lib/palm";
import { useVault, useVaultAddress, type VaultView } from "@/lib/vault";
import { EmptyState, Skeleton } from "../brand";
import { Notice } from "../ui";
import { VaultHeader } from "./header";

const Ctx = createContext<VaultView | null>(null);

/** The Vault loaded by the surrounding /vault/[id] layout. */
export function useV(): VaultView {
  const v = useContext(Ctx);
  if (!v) throw new Error("useV outside VaultFrame");
  return v;
}

export function useVaultBase() {
  const path = usePathname();
  return path.split("/").slice(0, 3).join("/");
}

function FrameSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy>
      <div className="flex items-center gap-6">
        <Skeleton h={118} w={88} className="rounded-xl" />
        <div className="flex flex-1 flex-col gap-3">
          <Skeleton h={14} w={120} />
          <Skeleton h={56} w="min(420px, 70%)" />
          <Skeleton h={14} w={260} />
        </div>
      </div>
      <Skeleton h={44} w="min(640px, 100%)" className="rounded-full" />
      <div className="pf-grid2">
        <Skeleton h={260} className="rounded-[18px]" />
        <Skeleton h={260} className="rounded-[18px]" />
      </div>
    </div>
  );
}

export function VaultFrame({ id, children }: { id: string; children: ReactNode }) {
  const { vault, isLoading, notFound } = useVaultAddress(id);
  const v = useVault(vault);
  const path = usePathname();
  const base = `/vault/${id}`;

  if (!isDeployed(deployments)) return null;
  if (notFound)
    return (
      <div className="pf-card">
        <EmptyState
          glyph="rings"
          title={`No vault called “${decodeURIComponent(id)}”`}
          body="Names are first come, first served. Check the spelling, browse the directory, or take the name yourself."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link className="pf-btn line" href="/directory">
                Browse directory
              </Link>
              <Link className="pf-btn dark" href={`/onboard?name=${encodeURIComponent(decodeURIComponent(id))}`}>
                Create this vault
              </Link>
            </div>
          }
        />
      </div>
    );
  if (isLoading || v.isLoading || (!v.s && !v.notVault)) return <FrameSkeleton />;
  if (v.notVault || !v.s) return <Notice tone="amber">That address isn&apos;t a palmfi Vault.</Notice>;

  const open = v.requests.filter((r) => r.state === REQ.PENDING).length;
  const changes = v.changes.filter((c) => !c.done).length;
  const frozen = v.status === STATUS.FROZEN;
  const tabs: { href: string; label: string; n?: number; red?: boolean }[] = [
    { href: "", label: "Overview" },
    { href: "/requests", label: "Requests", n: open },
    { href: "/send", label: "Send" },
    { href: "/receive", label: "Receive" },
    { href: "/wallets", label: "Wallets" },
    { href: "/settings", label: "Settings", n: changes },
    { href: "/activity", label: "Activity" },
    { href: "/incident", label: "Incident", n: frozen ? 1 : 0, red: true },
  ];
  const isOn = (h: string) => (h === "" ? path === base : path.startsWith(base + h));

  return (
    <Ctx.Provider value={v}>
      <VaultHeader v={v} />
      <nav className="pf-tabs" aria-label="Vault sections" style={{ animation: "pf-fade .7s var(--ease) .2s both" }}>
        {tabs.map((t) => (
          <Link key={t.label} href={base + t.href} className={`pf-tab ${isOn(t.href) ? "on" : ""}`} aria-current={isOn(t.href) ? "page" : undefined}>
            {t.label}
            {!!t.n && <span className={`n ${t.red ? "red" : ""}`}>{t.red ? "!" : t.n}</span>}
          </Link>
        ))}
      </nav>
      <div className="pf-enter flex flex-col gap-6" key={path}>
        {children}
      </div>
    </Ctx.Provider>
  );
}
