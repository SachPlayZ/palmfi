"use client";

import Link from "next/link";
import { STATUS, STATUS_LABEL, formatDuration } from "@/lib/palm";
import { useNameProfile } from "@/lib/ens";
import type { VaultView } from "@/lib/vault";
import { VerifiedBadge } from "../name-card";
import { Badge, Button, Mono, Notice, StatusBadge } from "../ui";
import { useNow, useRoles } from "./common";

export function VaultHeader({ v }: { v: VaultView }) {
  const now = useNow(5000);
  const roles = useRoles(v);
  const profile = useNameProfile(v.name ?? null);
  const status = v.status !== undefined ? STATUS_LABEL[v.status] : undefined;
  const hb = v.lastHeartbeat ? now - Number(v.lastHeartbeat) : undefined;
  const role = roles.isRecovery ? "Recovery key" : roles.isGuardian ? "Guardian" : roles.isApprover ? "Approver" : roles.isHot ? "Hot wallet" : roles.isOwner ? "Owner" : undefined;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{v.name ?? "Vault"}</h1>
            <StatusBadge status={status} />
            <VerifiedBadge verified={profile.verified} type={profile.type ?? (v.s?.institution ? "institution" : "personal")} />
            {v.s?.paused && <Badge tone="amber">paused</Badge>}
            {role && <Badge>you: {role}</Badge>}
          </div>
          <p className="text-xs text-[var(--subtle)]">
            {v.s?.institution ? "Institution treasury" : "Individual"} · <Mono>{v.vault}</Mono>
            {hb !== undefined && (
              <>
                {" "}
                · Sentinel heartbeat {v.lastHeartbeat === 0n ? "never" : `${formatDuration(hb)} ago`}
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Link href={`/vault/${v.vault}/incident`}>
            <Button variant={v.status === STATUS.FROZEN ? "danger" : "secondary"}>Incident view</Button>
          </Link>
        </div>
      </div>
      {v.status === STATUS.FROZEN && (
        <Notice tone="red">
          <strong>Frozen.</strong> Every outflow has stopped. Deposits and incoming payments still arrive.{" "}
          <Link className="underline" href={`/vault/${v.vault}/incident`}>
            See what happened and your recovery options
          </Link>
          .
        </Notice>
      )}
      {v.status === STATUS.MIGRATED && <Notice tone="amber">This Vault was migrated to its Recovery vault. The Recovery key can reissue the name onto a fresh Vault.</Notice>}
      {v.status === STATUS.REVOKED && <Notice tone="red">This Vault&apos;s name was revoked.</Notice>}
    </div>
  );
}
