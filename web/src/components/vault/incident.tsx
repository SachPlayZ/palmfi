"use client";

import Link from "next/link";
import { encodeAbiParameters, parseAbiItem } from "viem";
import { vaultAbi } from "@/abi";
import { deployments } from "@/lib/deployments";
import { useEventLogs } from "@/lib/logs";
import { txUrl } from "@/lib/network";
import { CHANGE, REQ, decodeReasonCodes, formatUsd } from "@/lib/palm";
import { TxStatus, useTx } from "@/lib/tx";
import type { VaultView } from "@/lib/vault";
import { Badge, Button, Card, Mono, Notice, short } from "../ui";
import { useRoles } from "./common";
import { VaultGate } from "./dashboard";
import { VaultHeader } from "./header";
import { PendingChanges } from "./settings";

const frozenEv = parseAbiItem("event Frozen(address indexed vault, address by, uint256 reasonCodes)");
const flaggedEv = parseAbiItem("event Flagged(address indexed vault, uint256 indexed requestId, uint256 reasonCodes, address destination)");
const unfrozenEv = parseAbiItem("event Unfrozen(address indexed vault)");

function ReasonList({ bitmap }: { bitmap: bigint }) {
  const codes = decodeReasonCodes(bitmap);
  if (!codes.length) return <span className="text-xs text-[var(--subtle)]">no reason codes (manual freeze)</span>;
  return (
    <ul className="flex flex-col gap-1">
      {codes.map((c) => (
        <li key={c.code} className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="red">{c.code}</Badge>
          <span className="text-[var(--subtle)]">{c.description}</span>
        </li>
      ))}
    </ul>
  );
}

function IncidentBody({ v }: { v: VaultView }) {
  const roles = useRoles(v);
  const tx = useTx();
  const frozen = useEventLogs("frozen", { address: deployments.hub, event: frozenEv, args: { vault: v.vault } });
  const flagged = useEventLogs("flagged", { address: deployments.hub, event: flaggedEv, args: { vault: v.vault } });
  const unfrozen = useEventLogs("unfrozen", { address: deployments.hub, event: unfrozenEv, args: { vault: v.vault } });
  const isFrozen = v.status === 2;
  const flaggedReqs = v.requests.filter((r) => r.state === REQ.FLAGGED);
  const propose = (kind: number, label: string) =>
    tx.send({ address: v.vault!, abi: vaultAbi, functionName: "proposeChange", args: [kind, kind === CHANGE.MIGRATE || kind === CHANGE.UNFREEZE ? "0x" : encodeAbiParameters([{ type: "address" }], [v.s!.recoveryVault])] }, label);

  return (
    <>
      <VaultHeader v={v} />
      <Link href={`/vault/${v.vault}`} className="text-sm underline">
        ← Back to dashboard
      </Link>
      {!isFrozen && <Notice tone="green">Not frozen. Outflows are open.</Notice>}

      <Card title="What happened" tone={isFrozen ? "danger" : undefined}>
        {frozen.isLoading && <p className="text-sm text-[var(--subtle)]">Reading Hub events…</p>}
        {frozen.data?.length === 0 && <p className="text-sm text-[var(--subtle)]">This Vault has never been frozen.</p>}
        <ul className="flex flex-col gap-3">
          {frozen.data?.map((l) => (
            <li key={`${l.transactionHash}-${l.logIndex}`} className="flex flex-col gap-1 rounded-lg border border-[var(--border)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  Frozen by <Mono>{short(l.args.by)}</Mono> {l.args.by?.toLowerCase() === deployments.hub?.toLowerCase() ? "(Sentinel FLAG)" : ""}
                </span>
                <a className="text-xs underline" href={txUrl(l.transactionHash!)} target="_blank" rel="noreferrer">
                  tx
                </a>
              </div>
              <ReasonList bitmap={l.args.reasonCodes ?? 0n} />
            </li>
          ))}
        </ul>
        {!!flagged.data?.length && (
          <div className="mt-4">
            <h3 className="mb-2 text-sm font-medium">Flagged requests</h3>
            <ul className="flex flex-col gap-2">
              {flagged.data.map((l) => {
                const r = flaggedReqs.find((x) => x.id === l.args.requestId);
                return (
                  <li key={`${l.transactionHash}-${l.logIndex}`} className="rounded-lg border border-red-500/40 p-2 text-sm">
                    #{l.args.requestId?.toString()} {r && formatUsd(r.amount)} → <Mono>{short(l.args.destination)}</Mono> (destination blocklisted network-wide)
                    <ReasonList bitmap={l.args.reasonCodes ?? 0n} />
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {!!unfrozen.data?.length && <p className="mt-3 text-xs text-[var(--subtle)]">Unfrozen {unfrozen.data.length} time(s) before.</p>}
      </Card>

      {isFrozen && (
        <Card title="Recovery options">
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
            <li>
              A majority of wallets votes <strong>Unfreeze</strong> (applies at once). Use this when the alarm was false.
              {roles.isWallet && (
                <Button className="ml-2" variant="secondary" disabled={tx.busy} onClick={() => propose(CHANGE.UNFREEZE, "Propose unfreeze")}>
                  Propose unfreeze
                </Button>
              )}
            </li>
            <li>
              If wallets are compromised: remove them by majority, or a majority votes <strong>Migrate</strong>, sending every USDC to the Recovery vault <Mono>{short(v.s!.recoveryVault)}</Mono>.
              {roles.isWallet && (
                <Button className="ml-2" variant="danger" disabled={tx.busy} onClick={() => propose(CHANGE.MIGRATE, "Propose migrate")}>
                  Propose migrate
                </Button>
              )}
            </li>
            <li>
              The Recovery key alone can unfreeze or migrate (it can do nothing else).
              {roles.isRecovery && (
                <span className="ml-2 inline-flex gap-2">
                  <Button variant="secondary" disabled={tx.busy} onClick={() => tx.send({ address: v.vault!, abi: vaultAbi, functionName: "recoveryUnfreeze" }, "Recovery unfreeze")}>
                    Unfreeze
                  </Button>
                  <Button variant="danger" disabled={tx.busy} onClick={() => tx.send({ address: v.vault!, abi: vaultAbi, functionName: "recoveryMigrate" }, "Recovery migrate")}>
                    Migrate
                  </Button>
                </span>
              )}
            </li>
          </ol>
          <TxStatus state={tx.state} />
          <div className="mt-4">
            <PendingChanges v={v} compact />
          </div>
        </Card>
      )}
    </>
  );
}

export function IncidentView({ id }: { id: string }) {
  return <VaultGate id={id}>{(v) => <IncidentBody v={v} />}</VaultGate>;
}
