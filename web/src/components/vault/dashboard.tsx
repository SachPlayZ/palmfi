"use client";

import Link from "next/link";
import { useVault, useVaultAddress } from "@/lib/vault";
import { deployments, isDeployed } from "@/lib/deployments";
import { TelegramLink } from "../telegram-link";
import { Card, Notice } from "../ui";
import { BalancesCard, BudgetCard, DepositCard } from "./balances";
import { VaultHeader } from "./header";
import { RequestsCard } from "./requests";
import { SafeHarborCard } from "./safe-harbor";
import { SendCard } from "./send";
import { HotWalletsCard, PendingChanges, ProfileCard, SettingsCard } from "./settings";
import { NetworkPayCard } from "../pay";
import { useRoles } from "./common";

export function useVaultFromRoute(id: string) {
  const { vault, isLoading, notFound } = useVaultAddress(id);
  const v = useVault(vault);
  return { v, resolving: isLoading, notFound };
}

export function VaultGate({ id, children }: { id: string; children: (v: ReturnType<typeof useVault>) => React.ReactNode }) {
  const { v, resolving, notFound } = useVaultFromRoute(id);
  if (!isDeployed(deployments)) return null; // Shell shows the not-deployed notice
  if (notFound) return <Notice tone="amber">No Vault is registered under “{decodeURIComponent(id)}”.</Notice>;
  if (resolving || v.isLoading || (!v.s && !v.notVault)) return <p className="text-sm text-[var(--subtle)]">Loading Vault…</p>;
  if (v.notVault || !v.s) return <Notice tone="amber">That address isn&apos;t a palmfi Vault.</Notice>;
  return <>{children(v)}</>;
}

export function Dashboard({ id }: { id: string }) {
  return (
    <VaultGate id={id}>
      {(v) => <DashboardBody v={v} />}
    </VaultGate>
  );
}

function DashboardBody({ v }: { v: ReturnType<typeof useVault> }) {
  const roles = useRoles(v);
  const inst = v.s!.institution;
  return (
    <>
      <VaultHeader v={v} />
      {v.changes.some((c) => !c.done) && (
        <Card title="Pending settings changes" tone="warn">
          <PendingChanges v={v} compact />
        </Card>
      )}
      <div className="grid gap-5 md:grid-cols-2">
        <BudgetCard v={v} />
        <BalancesCard v={v} />
      </div>
      <RequestsCard v={v} />
      <div className="grid gap-5 md:grid-cols-2">
        {inst ? <NetworkPayCard v={v} /> : <SendCard v={v} />}
        <DepositCard v={v} />
      </div>
      {inst && <SendCard v={v} />}
      {inst && (
        <Notice tone="gray">
          Payouts above the Instant budget need the Approver&apos;s Payout approval. Your Approver signs from a separate browser in the{" "}
          <Link className="underline" href={`/approver?vault=${v.vault}`}>
            Approver view
          </Link>
          .
        </Notice>
      )}
      <div className="grid gap-5 md:grid-cols-2">
        <HotWalletsCard v={v} />
        <SafeHarborCard v={v} />
      </div>
      <SettingsCard v={v} />
      <ProfileCard v={v} />
      {(roles.isOwner || roles.isHot || roles.isRecovery) && (
        <Card title="Notifications">
          <TelegramLink vault={v.vault!} />
        </Card>
      )}
    </>
  );
}
