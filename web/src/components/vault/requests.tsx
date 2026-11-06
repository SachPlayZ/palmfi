"use client";

import { useState } from "react";
import { vaultAbi } from "@/abi";
import { deployments } from "@/lib/deployments";
import { assess, type ScoringContext } from "@/lib/deviation";
import { KIND, REQ, REQ_LABEL, decodeReasonCodes, formatBits, formatUsd } from "@/lib/palm";
import { requestTimeline, voteProgress } from "@/lib/requests";
import { TxStatus, useTx } from "@/lib/tx";
import { useHasVoted, useScoringContext, type VaultRequest, type VaultView } from "@/lib/vault";
import { Badge, Button, Card, Mono, short } from "../ui";
import { eq, useNow, useRoles } from "./common";

const stateTone: Record<number, "gray" | "green" | "amber" | "red" | "blue"> = { 1: "blue", 2: "green", 3: "amber", 4: "gray", 5: "red", 6: "gray" };

/** Re-runs the Sentinel's pure model on the same onchain inputs, so the delay is explained term by term. */
function WhyDelay({ v, r }: { v: VaultView; r: VaultRequest }) {
  const ctx = useScoringContext(v.vault, r.id);
  if (!ctx.data) return <p className="text-xs text-[var(--subtle)]">Loading the Sentinel&apos;s inputs…</p>;
  const a = assess(ctx.data as unknown as ScoringContext, deployments.scoring);
  const rows: [string, number][] = [
    ["Amount vs usual", a.terms.amount],
    ["Destination", a.terms.dest],
    ["Time of day", a.terms.time],
    ["Velocity", a.terms.velocity],
    ["Flags", a.terms.flags],
  ];
  return (
    <div className="rounded-lg bg-[var(--muted)] p-2 text-xs">
      <p className="mb-1">
        Surprise score <strong>{formatBits(a.score)}</strong> ({a.scope} baseline) → {a.action === "FLAG" ? "FLAG (freeze)" : `delay ${Math.round(Number(a.delay) / 60)} min`}
      </p>
      <ul className="grid grid-cols-2 gap-x-4">
        {rows.map(([k, mb]) => (
          <li key={k} className="flex justify-between">
            <span className="text-[var(--subtle)]">{k}</span>
            <span className="tabular">{formatBits(mb)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[var(--subtle)]">Every {deployments.scoring.k / 1000} bits double the delay; ≥ {deployments.scoring.sFlag / 1000} bits freezes the Vault.</p>
    </div>
  );
}

function RequestRow({ v, r }: { v: VaultView; r: VaultRequest }) {
  const roles = useRoles(v);
  const now = useNow();
  const tx = useTx();
  const [why, setWhy] = useState(false);
  const voted = useHasVoted(v.vault, r.id, roles.address);
  const t = requestTimeline(r, now);
  const votes = voteProgress(r);
  const reasons = decodeReasonCodes(r.reasonCodes);
  const pending = r.state === REQ.PENDING;
  const mine = eq(r.requester, roles.address);
  const canVote = pending && roles.isWallet && voted.data === false;
  const send = (functionName: string, args: unknown[], label: string) => tx.send({ address: v.vault!, abi: vaultAbi, functionName, args }, label);

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-[var(--border)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-xs text-[var(--subtle)]">#{r.id.toString()}</span>
          <span className="tabular font-semibold">{formatUsd(r.amount)}</span>
          <span className="text-sm">
            {r.kind === KIND.SWAP ? "pool swap clearance" : r.kind === KIND.PAYMENT ? "pay Vault" : "unwrap to"}{" "}
            {r.kind !== KIND.SWAP && <Mono>{short(r.destination)}</Mono>}
          </span>
          <span className="text-xs text-[var(--subtle)]">by {short(r.requester)}</span>
        </div>
        <div className="flex items-center gap-1">
          {r.scored && <Badge tone="blue">{formatBits(r.score)}</Badge>}
          <Badge tone={stateTone[r.state]}>{REQ_LABEL[r.state]}</Badge>
        </div>
      </div>
      <p className={`text-sm ${t.ready ? "text-emerald-600 dark:text-emerald-400" : "text-[var(--subtle)]"}`}>{t.text}</p>
      {pending && (
        <p className="text-xs text-[var(--subtle)]">
          Veto {votes.veto.have}/{votes.veto.need} NO · Fast-track {votes.fastTrack.have}/{votes.fastTrack.need} YES · {r.voterCount} Voters
          {voted.data && " · you voted"}
        </p>
      )}
      {reasons.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {reasons.map((x) => (
            <span key={x.bit} title={x.description}>
              <Badge tone={x.code === "CRE_SILENT" ? "gray" : "amber"}>{x.code}</Badge>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {canVote && !mine && (
          <Button variant="danger" onClick={() => send("vote", [r.id, false], "Veto vote")} disabled={tx.busy}>
            Veto
          </Button>
        )}
        {canVote && (
          <Button variant="secondary" onClick={() => send("vote", [r.id, true], "Fast-track vote")} disabled={tx.busy}>
            Fast-track
          </Button>
        )}
        {pending && mine && (
          <Button variant="secondary" onClick={() => send("cancel", [r.id], "Cancel")} disabled={tx.busy}>
            Cancel
          </Button>
        )}
        {pending && t.ready && r.kind === KIND.SWAP && <span className="text-xs text-[var(--subtle)]">Cleared: pay from the Orbital pool card</span>}
        {pending && t.ready && r.kind !== KIND.SWAP && (
          <Button onClick={() => send("execute", [r.id], "Execute")} disabled={tx.busy}>
            Execute
          </Button>
        )}
        {pending && t.expired && (
          <Button variant="secondary" onClick={() => send("expire", [r.id], "Close expired")} disabled={tx.busy}>
            Close (refund bond)
          </Button>
        )}
        {pending && (
          <Button variant="ghost" onClick={() => setWhy((x) => !x)}>
            {why ? "Hide" : "Why this delay?"}
          </Button>
        )}
      </div>
      {why && <WhyDelay v={v} r={r} />}
      <TxStatus state={tx.state} />
    </li>
  );
}

export function RequestsCard({ v }: { v: VaultView }) {
  return (
    <Card title="Queued requests">
      {v.requests.length === 0 ? (
        <p className="text-sm text-[var(--subtle)]">No requests yet. Anything above the Instant budget lands here.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {v.requests.map((r) => (
            <RequestRow key={r.id.toString()} v={v} r={r} />
          ))}
        </ul>
      )}
    </Card>
  );
}
