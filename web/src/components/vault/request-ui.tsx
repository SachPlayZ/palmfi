"use client";

import Link from "next/link";
import { useState, type CSSProperties } from "react";
import type { Address } from "viem";
import { useReadContracts } from "wagmi";
import { vaultAbi } from "@/abi";
import { deployments } from "@/lib/deployments";
import { assess, type ScoringContext } from "@/lib/deviation";
import { useNames } from "@/lib/hub";
import { arcTestnet } from "@/lib/network";
import { KIND, REQ, REQ_LABEL, decodeReasonCodes, formatBits, formatDuration, formatUsd } from "@/lib/palm";
import { requestTimeline, voteProgress } from "@/lib/requests";
import { TxStatus, useTx } from "@/lib/tx";
import { useHasVoted, useScoringContext, type VaultRequest, type VaultView } from "@/lib/vault";
import { AddressChip, CopyButton, Meter, OrgCard, Ring, Skeleton, VoteDots, useNow, useHref } from "../brand";
import { Badge, Button, Card, Notice, type Tone } from "../ui";
import { eq, useRoles } from "./common";

export const STATE_TONE: Record<number, Tone> = { 1: "amber", 2: "green", 3: "gray", 4: "gray", 5: "red", 6: "gray" };

const kindLabel = (k: number) => (k === KIND.SWAP ? "Pool swap clearance" : k === KIND.PAYMENT ? "Pay a vault" : "Unwrap to address");

/** Any request by id (not just the recent ones the dashboard loads). */
export function useRequest(vault: Address | undefined, id: bigint | undefined) {
  const q = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: vault, abi: vaultAbi, functionName: "getRequest", args: [id ?? 0n], chainId: arcTestnet.id },
      { address: vault, abi: vaultAbi, functionName: "isExecutable", args: [id ?? 0n], chainId: arcTestnet.id },
    ],
    query: { enabled: !!vault && id !== undefined, refetchInterval: 6_000 },
  });
  const r = q.data?.[0]?.result as ScoringContext["request"] | undefined;
  const req: VaultRequest | undefined = r && r.state !== 0 && id !== undefined ? { ...r, id, executable: Boolean(q.data?.[1]?.result) } : undefined;
  return { req, isLoading: q.isLoading, missing: q.isSuccess && !req };
}

/** Progress from queued to executable, 0..1. */
function waitFrac(r: VaultRequest, now: number) {
  const a = Number(r.createdAt);
  const b = Number(r.executableAt);
  if (r.executable || r.state !== REQ.PENDING) return 1;
  return b > a ? Math.min(1, Math.max(0, (now - a) / (b - a))) : 0;
}

/** One request as a list row; the whole row opens the detail page. */
export function RequestLine({ v, r, base, showVault }: { v: VaultView; r: VaultRequest; base: string; showVault?: boolean }) {
  const now = useNow();
  const roles = useRoles(v);
  const voted = useHasVoted(v.vault, r.id, roles.address);
  const name = useNames([r.destination])(r.destination);
  const pending = r.state === REQ.PENDING;
  const t = requestTimeline(r, now);
  const votes = voteProgress(r);
  const needsYou = pending && roles.isWallet && voted.data === false && !eq(r.requester, roles.address);
  return (
    <Link href={`${base}/requests/${r.id}`} className="pf-row group" style={{ paddingInline: 8 }}>
      <Ring value={waitFrac(r, now)} size={48} color={r.state === REQ.FLAGGED ? "var(--red)" : t.ready ? "var(--leaf)" : "var(--butter)"}>
        <span className="pf-mono text-[10px]">#{r.id.toString()}</span>
      </Ring>
      <div className="grow flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="pf-serif text-[26px] leading-none tracking-tight tabular">{formatUsd(r.amount)}</span>
          <span className="text-sm text-[var(--ink-2)]">
            {r.kind === KIND.SWAP ? (
              "pool swap"
            ) : name ? (
              <>to {name}</>
            ) : (
              <>
                to {r.destination.slice(0, 6)}…{r.destination.slice(-4)}
              </>
            )}
          </span>
          {showVault && v.name && <span className="pf-mono pf-dim">· {v.name}</span>}
        </div>
        <span className={`text-[13px] ${t.ready ? "text-[var(--leaf)]" : "text-[var(--subtle)]"}`}>{t.text}</span>
      </div>
      {pending && (
        <div className="hidden flex-col items-end gap-1.5 sm:flex">
          <VoteDots have={votes.veto.have} need={votes.veto.need} total={votes.veto.need} tone="red" />
          <VoteDots have={votes.fastTrack.have} need={votes.fastTrack.need} total={votes.fastTrack.need} tone="green" />
        </div>
      )}
      <div className="flex flex-col items-end gap-1.5">
        {needsYou ? (
          <Badge tone="forest" live>
            your vote
          </Badge>
        ) : (
          <Badge tone={STATE_TONE[r.state]}>{REQ_LABEL[r.state]}</Badge>
        )}
        {r.scored && <span className="pf-mono pf-dim">{formatBits(r.score)}</span>}
      </div>
      <span className="text-lg text-[var(--subtle)] transition-transform duration-500 group-hover:translate-x-1" aria-hidden>
        →
      </span>
    </Link>
  );
}

/** The Sentinel's terms for one request, re-run with the same model on the same onchain inputs. */
export function WhyDelay({ v, id }: { v: VaultView; id: bigint }) {
  const ctx = useScoringContext(v.vault, id);
  if (!ctx.data)
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} h={14} />
        ))}
      </div>
    );
  const a = assess(ctx.data as unknown as ScoringContext, deployments.scoring);
  const flagAt = deployments.scoring.sFlag;
  const rows: [string, string, number][] = [
    ["Amount", "vs this wallet's and vault's usual outflows", a.terms.amount],
    ["Destination", "how familiar the address is", a.terms.dest],
    ["Time of day", "inside or outside business hours", a.terms.time],
    ["Velocity", "how many outflows lately", a.terms.velocity],
    ["Flags", "new wallet, pending wallet add, blocklist", a.terms.flags],
  ];
  const max = Math.max(flagAt, a.score, 1);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <span className="pf-mono pf-dim">Surprise score · {a.scope} baseline</span>
          <div className="pf-big">{formatBits(a.score)}</div>
        </div>
        <Badge tone={a.action === "FLAG" ? "red" : "amber"}>{a.action === "FLAG" ? "flag · freeze" : `delay ${formatDuration(Number(a.delay))}`}</Badge>
      </div>
      <div className="flex flex-col gap-1.5">
        <Meter value={a.score / max} color={a.action === "FLAG" ? "var(--red)" : "var(--butter)"} at={flagAt / max} />
        <div className="flex justify-between pf-mono pf-dim text-[10px]">
          <span>0 bits</span>
          <span>flag at {flagAt / 1000} bits</span>
        </div>
      </div>
      <ul className="flex flex-col gap-3">
        {rows.map(([k, hint, mb], i) => (
          <li
            key={k}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto] items-center gap-4"
            style={{ animation: `pf-fade .6s var(--ease) ${i * 0.06}s both` }}
          >
            <span className="flex flex-col">
              <span className="text-sm">{k}</span>
              <span className="text-[12px] text-[var(--subtle)]">{hint}</span>
            </span>
            <Meter value={mb / max} color="var(--moss)" />
            <span className="tabular pf-mono w-16 text-right">{formatBits(mb)}</span>
          </li>
        ))}
      </ul>
      <p className="text-[13px] text-[var(--subtle)]">
        Every {deployments.scoring.k / 1000} bits doubles the delay from the floor; {flagAt / 1000} bits or more freezes the vault.
      </p>
    </div>
  );
}

function Timeline({ r, now }: { r: VaultRequest; now: number }) {
  const done = r.state !== REQ.PENDING;
  const steps = [
    { k: "Queued", on: true, t: new Date(Number(r.createdAt) * 1000).toLocaleString() },
    {
      k: r.scored ? `Scored ${formatBits(r.score)}` : "Waiting for the Sentinel",
      on: r.scored,
      t: r.scored ? "delay set from the score" : "max delay applies until scored",
    },
    { k: r.fastTracked ? "Fast-tracked" : "Team can veto", on: r.fastTracked || r.no > 0 || r.yes > 0, t: `${r.yes} yes · ${r.no} no of ${r.voterCount}` },
    {
      k: done ? REQ_LABEL[r.state] : r.executable ? "Executable now" : `Executable in ${formatDuration(Number(r.executableAt) - now)}`,
      on: done || r.executable,
      t: done ? "final" : new Date(Number(r.executableAt) * 1000).toLocaleString(),
    },
  ];
  return (
    <ol className="relative flex flex-col gap-6 pl-7">
      <span className="absolute left-[7px] top-2 bottom-2 w-px bg-[var(--line)]" aria-hidden />
      {steps.map((s, i) => (
        <li key={i} className="relative flex flex-col gap-0.5" style={{ animation: `pf-fade .6s var(--ease) ${i * 0.08}s both` }}>
          <span
            className="absolute -left-7 top-1 h-[15px] w-[15px] rounded-full transition-colors duration-500"
            style={{ background: s.on ? (r.state === REQ.FLAGGED && i === 3 ? "var(--red)" : "var(--ink)") : "#fff", boxShadow: "inset 0 0 0 1px var(--ink)" }}
          />
          <span className="text-[15px]">{s.k}</span>
          <span className="text-[12.5px] text-[var(--subtle)]">{s.t}</span>
        </li>
      ))}
    </ol>
  );
}

export function RequestDetail({ v, id, base }: { v: VaultView; id: bigint; base: string }) {
  const { req: r, isLoading, missing } = useRequest(v.vault, id);
  const now = useNow();
  const roles = useRoles(v);
  const tx = useTx();
  const voted = useHasVoted(v.vault, id, roles.address);
  const names = useNames([r?.destination, r?.requester]);
  const [hover, setHover] = useState<"veto" | "fast" | null>(null);
  const link = useHref();

  if (isLoading) return <Skeleton h={420} className="rounded-[18px]" />;
  if (missing || !r) return <Notice tone="amber">Request #{id.toString()} doesn&apos;t exist on this vault.</Notice>;

  const pending = r.state === REQ.PENDING;
  const t = requestTimeline(r, now);
  const votes = voteProgress(r);
  const reasons = decodeReasonCodes(r.reasonCodes);
  const mine = eq(r.requester, roles.address);
  const canVote = pending && roles.isWallet && voted.data === false;
  const send = (functionName: string, args: unknown[], label: string) => tx.send({ address: v.vault!, abi: vaultAbi, functionName, args }, label);
  const destName = names(r.destination);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={`${base}/requests`} className="pf-link text-sm">
          ← All requests
        </Link>
        <CopyButton text={link} label="Copy link for your team" className="sm" />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
        <Card
          label={`Request #${r.id} · ${kindLabel(r.kind)}`}
          actions={
            <Badge tone={STATE_TONE[r.state]} live={pending}>
              {REQ_LABEL[r.state]}
            </Badge>
          }
        >
          <div className="flex flex-col gap-7">
            <div className="flex flex-wrap items-center gap-6">
              <Ring value={waitFrac(r, now)} size={132} color={r.state === REQ.FLAGGED ? "var(--red)" : t.ready ? "var(--leaf)" : "var(--butter)"}>
                <span className="flex flex-col items-center">
                  <span className="pf-mono pf-dim text-[9px]">{pending ? (t.ready ? "ready" : "waits") : "done"}</span>
                  <span className="pf-serif text-[22px] leading-none">{pending && !t.ready ? formatDuration(Number(r.executableAt) - now) : "✓"}</span>
                </span>
              </Ring>
              <div className="flex min-w-0 flex-col gap-2">
                <span className="pf-big" style={{ fontSize: "clamp(48px,6vw,88px)" }}>
                  {formatUsd(r.amount)}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-[15px] text-[var(--ink-2)]">
                  {r.kind !== KIND.SWAP && (
                    <>
                      to{" "}
                      {destName ? (
                        <Link className="pf-link inline-flex items-center gap-2" href={`/o/${destName}`}>
                          <OrgCard name={destName} width={18} />
                          {destName}
                        </Link>
                      ) : (
                        <AddressChip address={r.destination} />
                      )}
                    </>
                  )}
                  <span className="pf-dim">· requested by</span> <AddressChip address={r.requester} label={mine ? "you" : undefined} />
                </span>
              </div>
            </div>
            <p className={`text-[15px] ${t.ready ? "text-[var(--leaf)]" : "text-[var(--ink-2)]"}`}>{t.text}</p>
            {reasons.length > 0 && (
              <ul className="flex flex-col gap-2">
                {reasons.map((x) => (
                  <li key={x.bit} className="flex items-start gap-3 text-sm">
                    <Badge tone={x.code === "CRE_SILENT" ? "gray" : x.code === "BLOCKLISTED_DEST" ? "red" : "amber"}>{x.code}</Badge>
                    <span className="text-[var(--ink-2)]">{x.description}</span>
                  </li>
                ))}
              </ul>
            )}
            <hr className="pf-rule" />
            <Timeline r={r} now={now} />
          </div>
        </Card>

        <div className="flex flex-col gap-6">
          <Card label="Your team decides" title={pending ? "Vote on this payment" : "Votes"}>
            <div className="flex flex-col gap-5">
              <div
                className={`flex flex-col gap-2 rounded-2xl p-4 transition-colors duration-500 ${hover === "veto" ? "bg-[#fcebe7]" : "bg-[var(--paper-2)]"}`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm">Veto</span>
                  <span className="pf-mono tabular">
                    {votes.veto.have}/{votes.veto.need} no
                  </span>
                </div>
                <VoteDots have={votes.veto.have} need={votes.veto.need} total={Math.max(r.voterCount - 1, votes.veto.need)} tone="red" />
                <span className="text-[12.5px] text-[var(--subtle)]">More than half of the other wallets saying no cancels it and refunds the bond.</span>
              </div>
              <div
                className={`flex flex-col gap-2 rounded-2xl p-4 transition-colors duration-500 ${hover === "fast" ? "bg-[#edf5e6]" : "bg-[var(--paper-2)]"}`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm">Fast-track</span>
                  <span className="pf-mono tabular">
                    {votes.fastTrack.have}/{votes.fastTrack.need} yes
                  </span>
                </div>
                <VoteDots have={votes.fastTrack.have} need={votes.fastTrack.need} total={r.voterCount} tone="green" />
                <span className="text-[12.5px] text-[var(--subtle)]">More than half of all wallets saying yes makes it executable at the floor.</span>
              </div>
              {voted.data && pending && <Notice tone="green">You voted on this request.</Notice>}
              {!roles.isWallet && pending && <Notice>Connect one of this vault&apos;s wallets to vote.</Notice>}
              <div className="flex flex-wrap gap-2">
                {canVote && !mine && (
                  <Button
                    variant="danger"
                    onMouseEnter={() => setHover("veto")}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => send("vote", [r.id, false], "Veto vote")}
                    busy={tx.busy}
                    disabled={tx.busy}
                  >
                    Veto
                  </Button>
                )}
                {canVote && (
                  <Button
                    variant="line"
                    onMouseEnter={() => setHover("fast")}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => send("vote", [r.id, true], "Fast-track vote")}
                    disabled={tx.busy}
                  >
                    Fast-track
                  </Button>
                )}
                {pending && t.ready && r.kind !== KIND.SWAP && (
                  <Button onClick={() => send("execute", [r.id], "Execute")} busy={tx.busy} disabled={tx.busy}>
                    Execute payment
                  </Button>
                )}
                {pending && mine && (
                  <Button variant="ghost" onClick={() => send("cancel", [r.id], "Cancel")} disabled={tx.busy}>
                    Cancel my request
                  </Button>
                )}
                {pending && t.expired && (
                  <Button variant="line" onClick={() => send("expire", [r.id], "Close expired")} disabled={tx.busy}>
                    Close and refund bond
                  </Button>
                )}
              </div>
              {pending && t.ready && r.kind === KIND.SWAP && <p className="text-sm text-[var(--subtle)]">Cleared: finish the payment from Send &amp; pay.</p>}
              <TxStatus state={tx.state} />
            </div>
          </Card>
          <Card label="Why this delay?">
            {pending || r.scored ? <WhyDelay v={v} id={r.id} /> : <p className="text-sm text-[var(--subtle)]">This request was never scored.</p>}
          </Card>
        </div>
      </div>
    </div>
  );
}

export function RequestList({ v, base, filter }: { v: VaultView; base: string; filter: (r: VaultRequest) => boolean }) {
  const list = v.requests.filter(filter);
  if (!list.length) return null;
  return (
    <div className="pf-list" style={{ "--d": "0s" } as CSSProperties}>
      {list.map((r) => (
        <RequestLine key={r.id.toString()} v={v} r={r} base={base} />
      ))}
    </div>
  );
}
