"use client";

import Link from "next/link";
import { STATUS, formatDuration } from "@/lib/palm";
import type { VaultView } from "@/lib/vault";
import { AddressChip, OrgCard, Words, useNow } from "../brand";
import { Badge, Notice } from "../ui";
import { useRoles } from "./common";

export function VaultHeader({ v }: { v: VaultView }) {
  const now = useNow(5000);
  const roles = useRoles(v);
  const hb = v.lastHeartbeat ? now - Number(v.lastHeartbeat) : undefined;
  const name = v.name ?? "vault";
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex items-end gap-5 sm:gap-7">
          <span style={{ animation: "pf-pop 1s var(--ease) both" }}>
            <OrgCard name={name} width={88} tilt />
          </span>
          <div className="flex min-w-0 flex-col gap-3">
            {v.verified && (
              <div style={{ animation: "pf-fade .7s var(--ease) .1s both" }}>
                <Badge tone="blue">verified</Badge>
              </div>
            )}
            <h1 className="pf-h1 break-words">
              <Words text={name} />
            </h1>
            <div
              className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-[var(--subtle)]"
              style={{ animation: "pf-fade .8s var(--ease) .25s both" }}
            >
              <AddressChip address={v.vault} />
              <span>{v.s?.wallets.length} wallets</span>
              <span>{v.symbol}</span>
              {hb !== undefined && (
                <span className="inline-flex items-center gap-1.5">
                  <i className={`h-1.5 w-1.5 rounded-full ${v.creLive ? "bg-[var(--leaf)]" : "bg-[var(--amber)]"}`} />
                  Sentinel {v.lastHeartbeat === 0n ? "never seen" : `${formatDuration(hb)} ago`}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2" style={{ animation: "pf-fade .8s var(--ease) .3s both" }}>
          <Link href={`/o/${v.name ?? v.vault}`} className="pf-btn line">
            Public page
          </Link>
          {roles.isWallet && (
            <Link href={`/vault/${v.name ?? v.vault}?action=send`} className="pf-btn dark">
              Send or pay
            </Link>
          )}
        </div>
      </div>
      {v.status === STATUS.FROZEN && (
        <Notice tone="red">
          <strong>Frozen.</strong> Outflows have stopped, except Lifeline payments to past counterparties that the recovery key and a majority approve. Deposits still arrive.{" "}
          <Link className="pf-link" href={`/vault/${v.name ?? v.vault}/incident`}>
            See what happened and how to recover
          </Link>
          .
        </Notice>
      )}
      {v.status === STATUS.MIGRATED && <Notice tone="amber">This Vault was migrated to its Recovery vault.</Notice>}
      {v.status === STATUS.REVOKED && <Notice tone="red">This Vault&apos;s name was revoked.</Notice>}
    </div>
  );
}
