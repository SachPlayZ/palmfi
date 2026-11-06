"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { formatUnits } from "viem";
import { ago, useVaultActivity, type Activity } from "@/lib/activity";
import { useNames } from "@/lib/hub";
import { txUrl } from "@/lib/network";
import { CHANGE_LABEL, REQ, REQ_LABEL, STATUS_LABEL, decodeReasonCodes, formatBits, formatUsd } from "@/lib/palm";
import { LiquidityCard, PoolPayCard } from "../pay";
import { TelegramLink } from "../telegram-link";
import { CopyButton, EmptyState, Glyph, Skeleton, useOrigin } from "../brand";
import { Card, Notice } from "../ui";
import { BalancesCard, BudgetCard, DepositCard } from "./balances";
import { useRoles } from "./common";
import { useV, useVaultBase } from "./frame";
import { IncidentBody } from "./incident";
import { RequestDetail, RequestList } from "./request-ui";
import { SendCard } from "./send";
import { FreezeCard, PendingChanges, SettingsCard, WalletsCard } from "./settings";

/* ───────────── overview ───────────── */

export function OverviewTab() {
  const v = useV();
  const base = useVaultBase();
  const roles = useRoles(v);
  const open = v.requests.filter((r) => r.state === REQ.PENDING);
  const changes = v.changes.filter((c) => !c.done);
  return (
    <>
      <Card label="Needs attention" title={open.length + changes.length ? `${open.length + changes.length} waiting on your team` : "All quiet"}>
        {open.length + changes.length === 0 ? (
          <div className="flex items-center gap-4 text-[15px] text-[var(--subtle)]">
            <Glyph kind="sun" seed={4} className="h-12 w-12 flex-none" style={{ stroke: "var(--moss)", fill: "none" }} />
            Nothing queued and no settings changes pending. Payments within the budget go straight out.
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {open.length > 0 && <RequestList v={v} base={base} filter={(r) => r.state === REQ.PENDING} />}
            {changes.length > 0 && <PendingChanges v={v} compact />}
          </div>
        )}
      </Card>
      <div className="pf-grid2">
        <BudgetCard v={v} />
        <BalancesCard v={v} />
      </div>
      <div className="pf-grid2">
        <DepositCard v={v} />
        <Card label="Shortcuts" title="Common moves">
          <div className="pf-list">
            {[
              { href: `${base}/send`, t: "Send or pay another org", d: "Instant within the budget; anything larger is queued and scored." },
              { href: `/request/new?to=${encodeURIComponent(v.name ?? "")}`, t: "Request a payment", d: "A link another org can open to pay you." },
              { href: `${base}/wallets`, t: "Invite your voters", d: "Each wallet should link alerts so someone is there to say no." },
              { href: `${base}/activity`, t: "Export activity", d: "Every request, vote and payment as CSV." },
            ].map((x) => (
              <Link key={x.t} href={x.href} className="pf-row group">
                <span className="grow flex flex-col">
                  <span className="text-[15px]">{x.t}</span>
                  <span className="text-[13px] text-[var(--subtle)]">{x.d}</span>
                </span>
                <span className="text-[var(--subtle)] transition-transform duration-500 group-hover:translate-x-1">→</span>
              </Link>
            ))}
          </div>
          {!roles.isWallet && (
            <p className="mt-4 text-[13px] text-[var(--subtle)]">You&apos;re viewing as a guest. Connect one of this vault&apos;s wallets to act.</p>
          )}
        </Card>
      </div>
    </>
  );
}

/* ───────────── requests ───────────── */

const FILTERS = [
  { k: "open", label: "Open", f: (s: number) => s === REQ.PENDING },
  { k: "done", label: "Finished", f: (s: number) => s !== REQ.PENDING },
  { k: "all", label: "All", f: () => true },
] as const;

export function RequestsTab() {
  const v = useV();
  const base = useVaultBase();
  const [k, setK] = useState<(typeof FILTERS)[number]["k"]>("open");
  const f = FILTERS.find((x) => x.k === k)!;
  const count = (fx: (s: number) => boolean) => v.requests.filter((r) => fx(r.state)).length;
  const list = v.requests.filter((r) => f.f(r.state));
  return (
    <Card
      label="Queued requests"
      title="Payments above the budget"
      actions={
        <div className="flex gap-1.5">
          {FILTERS.map((x) => (
            <button key={x.k} className={`pf-chip ${k === x.k ? "on" : ""}`} onClick={() => setK(x.k)}>
              {x.label} <span className="n">{count(x.f)}</span>
            </button>
          ))}
        </div>
      }
    >
      {list.length ? (
        <RequestList v={v} base={base} filter={(r) => f.f(r.state)} />
      ) : (
        <EmptyState
          glyph="bars"
          title={k === "open" ? "Nothing queued" : "No requests here"}
          body="Anything above the Instant budget lands here: the Sentinel scores it, and your wallets can veto or fast-track it."
          action={
            <Link className="pf-btn line" href={`${base}/send`}>
              Send a payment
            </Link>
          }
        />
      )}
      <p className="mt-5 text-[13px] text-[var(--subtle)]">
        Showing open requests and the 8 most recent. The full history is in{" "}
        <Link className="pf-link" href={`${base}/activity`}>
          Activity
        </Link>
        .
      </p>
    </Card>
  );
}

export function RequestDetailTab({ rid }: { rid: string }) {
  const v = useV();
  const base = useVaultBase();
  let id: bigint | undefined;
  try {
    id = BigInt(rid);
  } catch {
    id = undefined;
  }
  if (id === undefined) return <Notice tone="amber">That isn&apos;t a request number.</Notice>;
  return <RequestDetail v={v} id={id} base={base} />;
}

/* ───────────── send & pay ───────────── */

export function SendTab() {
  const v = useV();
  return (
    <>
      <div className="pf-grid2">
        <SendCard v={v} />
        <PoolPayCard v={v} />
      </div>
      <div className="pf-grid2">
        <DepositCard v={v} />
        <LiquidityCard v={v} />
      </div>
    </>
  );
}

/* ───────────── wallets ───────────── */

export function WalletsTab() {
  const v = useV();
  const roles = useRoles(v);
  const join = `${useOrigin()}/join/${v.name ?? v.vault}`;
  return (
    <>
      <div className="pf-grid2">
        <WalletsCard v={v} />
        <div className="flex flex-col gap-6">
          <Card label="Invite your voters" title="Send each wallet owner this link">
            <p className="text-[15px] leading-relaxed text-[var(--ink-2)]">
              Votes only protect the vault if people are there to cast them. The link shows each voter what they agreed to, links their alerts and drops them in
              their inbox.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <code className="pf-addr max-w-full truncate px-3 py-2">{join}</code>
              <CopyButton text={join} />
            </div>
          </Card>
          {(roles.isWallet || roles.isRecovery) && (
            <Card label="Your alerts" title="Telegram">
              <TelegramLink vault={v.vault!} />
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

/* ───────────── settings ───────────── */

export function SettingsTab() {
  const v = useV();
  const pending = v.changes.filter((c) => !c.done).length;
  return (
    <>
      {pending > 0 && (
        <Card label="Pending" title="Settings changes waiting for votes" tone="warn">
          <PendingChanges v={v} />
        </Card>
      )}
      <SettingsCard v={v} />
      <FreezeCard v={v} />
    </>
  );
}

/* ───────────── activity ───────────── */

const EVENT_TONE: Record<string, string> = {
  RequestQueued: "var(--butter)",
  RequestUpdated: "var(--sky)",
  Voted: "var(--moss)",
  Outflow: "var(--leaf)",
  ConfigChange: "var(--butter)",
  Frozen: "var(--red)",
  Flagged: "var(--red)",
  Unfrozen: "var(--leaf)",
  StatusChanged: "var(--ink-2)",
  Migrated: "var(--amber)",
  VaultRegistered: "var(--forest)",
  NameVerified: "var(--sky)",
};

const usd = (x: unknown) => formatUsd(BigInt((x as bigint) ?? 0n));
const shortA = (a: unknown) => (typeof a === "string" ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

function describe(a: Activity, name: (x?: string) => string | undefined): { title: string; detail?: string } {
  const g = a.args;
  const who = (x: unknown) => name(x as string) ?? shortA(x);
  switch (a.event) {
    case "RequestQueued":
      return { title: `Request #${g.requestId} queued: ${usd(g.amount)} to ${who(g.destination)}`, detail: `by ${shortA(g.wallet)}` };
    case "RequestUpdated":
      return {
        title: `Request #${g.requestId} ${REQ_LABEL[Number(g.state)]?.toLowerCase() ?? "updated"}`,
        detail: Number(g.score)
          ? `${formatBits(Number(g.score))}${
              decodeReasonCodes(g.reasonCodes as bigint).length
                ? " · " +
                  decodeReasonCodes(g.reasonCodes as bigint)
                    .map((r) => r.code)
                    .join(", ")
                : ""
            }`
          : undefined,
      };
    case "Voted":
      return {
        title: `${shortA(g.voter)} voted ${g.yes ? "yes (fast-track)" : "no (veto)"} on #${g.requestId}`,
        detail: `${g.yesVotes} yes · ${g.noVotes} no`,
      };
    case "Outflow":
      return { title: `${usd(g.amount)} sent to ${who(g.destination)}`, detail: `${g.viaPool ? "through the Orbital pool · " : ""}by ${shortA(g.wallet)}` };
    case "ConfigChange":
      return {
        title: `${CHANGE_LABEL[Number(g.kind)] ?? "Settings change"} · change #${g.changeId}`,
        detail: `${g.yesVotes} yes${Number(g.eta) ? ` · applies ${new Date(Number(g.eta) * 1000).toLocaleString()}` : ""}`,
      };
    case "Frozen":
      return {
        title: "Vault frozen",
        detail:
          decodeReasonCodes(g.reasonCodes as bigint)
            .map((r) => r.code)
            .join(", ") || `by ${shortA(g.by)}`,
      };
    case "Flagged":
      return { title: `Request #${g.requestId} flagged`, detail: `destination ${shortA(g.destination)} blocklisted` };
    case "Unfrozen":
      return { title: "Vault unfrozen" };
    case "StatusChanged":
      return { title: `Status: ${STATUS_LABEL[Number(g.status)] ?? g.status}` };
    case "Migrated":
      return { title: "Migrated to the recovery vault", detail: shortA(g.recoveryVault) };
    case "VaultRegistered":
      return { title: `Vault created as “${g.name}”` };
    case "NameVerified":
      return { title: g.verified ? "Name verified" : "Verification removed" };
    default:
      return { title: a.event };
  }
}

function toCsv(rows: Activity[], name: (x?: string) => string | undefined) {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = ["time_utc_approx,block,event,summary,detail,amount_usdc,tx"];
  for (const a of rows) {
    const d = describe(a, name);
    const amt = a.args.amount !== undefined ? formatUnits(BigInt(a.args.amount as bigint), 6) : "";
    lines.push([new Date(a.at * 1000).toISOString(), a.block.toString(), a.event, esc(d.title), esc(d.detail ?? ""), amt, a.tx].join(","));
  }
  return lines.join("\n");
}

export function ActivityTab() {
  const v = useV();
  const q = useVaultActivity(v.vault);
  const [kind, setKind] = useState<string>("all");
  const rows = useMemo(() => q.data ?? [], [q.data]);
  const name = useNames(rows.flatMap((a) => [a.args.destination as string | undefined]).filter((x, i, arr) => x && arr.indexOf(x) === i) as `0x${string}`[]);
  const kinds = useMemo(() => [...new Set(rows.map((r) => r.event))], [rows]);
  const shown = kind === "all" ? rows : rows.filter((r) => r.event === kind);

  function download() {
    const blob = new Blob([toCsv(shown, name)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${v.name ?? "vault"}-activity.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <Card
      label="Activity"
      title="Everything this vault has done"
      actions={
        <button className="pf-btn line sm" onClick={download} disabled={!shown.length}>
          Export CSV
        </button>
      }
    >
      {kinds.length > 1 && (
        <div className="mb-5 flex flex-wrap gap-1.5">
          <button className={`pf-chip ${kind === "all" ? "on" : ""}`} onClick={() => setKind("all")}>
            All <span className="n">{rows.length}</span>
          </button>
          {kinds.map((k) => (
            <button key={k} className={`pf-chip ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>
              {k.replace(/([a-z])([A-Z])/g, "$1 $2")} <span className="n">{rows.filter((r) => r.event === k).length}</span>
            </button>
          ))}
        </div>
      )}
      {q.isLoading ? (
        <div className="flex flex-col gap-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} h={42} />
          ))}
          <p className="text-[13px] text-[var(--subtle)]">Reading the Hub&apos;s history from Arc…</p>
        </div>
      ) : q.error ? (
        <Notice tone="amber">Couldn&apos;t read history right now (the public Arc RPC may be rate-limiting). It retries on its own.</Notice>
      ) : !shown.length ? (
        <EmptyState glyph="wave" title="No activity yet" body="Deposits show up in balances; requests, votes, payments and settings changes appear here." />
      ) : (
        <ol className="relative flex flex-col pl-7">
          <span className="absolute left-[5px] top-3 bottom-3 w-px bg-[var(--line)]" aria-hidden />
          {shown.slice(0, 120).map((a, i) => {
            const d = describe(a, name);
            return (
              <li
                key={`${a.tx}-${a.logIndex}`}
                className="relative flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-[var(--line)] py-3.5"
                style={{ animation: `pf-fade .5s var(--ease) ${Math.min(i, 12) * 0.03}s both` }}
              >
                <span className="absolute -left-7 top-[19px] h-[11px] w-[11px] rounded-full" style={{ background: EVENT_TONE[a.event] ?? "var(--ink-2)" }} />
                <span className="flex min-w-0 flex-col">
                  <span className="text-[15px]">{d.title}</span>
                  {d.detail && <span className="text-[13px] text-[var(--subtle)]">{d.detail}</span>}
                </span>
                <span className="flex items-center gap-3 text-[13px] text-[var(--subtle)]">
                  <span title={new Date(a.at * 1000).toLocaleString()}>≈ {ago(a.at)}</span>
                  <a className="pf-link" href={txUrl(a.tx)} target="_blank" rel="noreferrer">
                    tx
                  </a>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

/* ───────────── incident ───────────── */

export function IncidentTab() {
  const v = useV();
  return <IncidentBody v={v} />;
}
