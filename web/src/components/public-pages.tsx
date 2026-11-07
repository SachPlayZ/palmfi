"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { isAddress, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { hubAbi, orbitalHookAbi } from "@/abi";
import { ago, useHubEvents, usePoolEvents } from "@/lib/activity";
import { deployments } from "@/lib/deployments";
import { useNames, useNetworkHealth, useVaultIndex } from "@/lib/hub";
import { arcTestnet, network, txUrl } from "@/lib/network";
import { STATUS, STATUS_LABEL, formatDuration, formatUsd } from "@/lib/palm";
import { TxStatus, useTx } from "@/lib/tx";
import { useVault, useVaultAddress } from "@/lib/vault";
import { AddressChip, EmptyState, Glyph, OrgCard, PageHead, Section, Skeleton, orgIdentity, r2, useNow } from "./brand";
import { Badge, Card, Notice, StatusBadge } from "./ui";
import { fmtAmount, useRoles } from "./vault/common";

const chainId = arcTestnet.id;

/* ───────────── /o/[name] ───────────── */

export function OrgProfile({ id }: { id: string }) {
  const { vault, isLoading, notFound } = useVaultAddress(id);
  const v = useVault(vault);
  const roles = useRoles(v);
  if (notFound)
    return (
      <div className="pf-card">
        <EmptyState
          glyph="rings"
          title={`No org called “${decodeURIComponent(id)}”`}
          body="Check the spelling, or browse every org in the directory."
          action={
            <Link className="pf-btn line" href="/directory">
              Browse directory
            </Link>
          }
        />
      </div>
    );
  if (isLoading || v.isLoading || !v.s)
    return (
      <div className="flex flex-col gap-8">
        <div className="flex items-end gap-8">
          <Skeleton h={260} w={196} className="rounded-2xl" />
          <div className="flex flex-1 flex-col gap-4">
            <Skeleton h={18} w={140} />
            <Skeleton h={80} w="60%" />
          </div>
        </div>
        <Skeleton h={180} className="rounded-[18px]" />
      </div>
    );
  const name = v.name ?? "vault";
  const active = v.status === STATUS.ACTIVE;
  const inPool = v.poolLiquidity > 0n;
  const [held] = v.s.reserves;
  return (
    <>
      <header className="grid items-end gap-10 md:grid-cols-[auto_1fr]">
        <span style={{ animation: "pf-pop 1s var(--ease) both" }}>
          <OrgCard name={name} width={196} tilt />
        </span>
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap gap-2" style={{ animation: "pf-fade .7s var(--ease) .1s both" }}>
            <StatusBadge status={STATUS_LABEL[v.status ?? 0]} />
            {v.verified ? <Badge tone="blue">verified business</Badge> : <Badge>not verified</Badge>}
            {active && inPool ? (
              <Badge tone="green">accepting payments</Badge>
            ) : (
              <Badge tone="amber">{active ? "not in the pool yet" : "not accepting payments"}</Badge>
            )}
          </div>
          <h1 className="pf-h1" style={{ fontSize: "clamp(56px, 9vw, 140px)" }}>
            {name}
          </h1>
          <div className="flex flex-wrap gap-2" style={{ animation: "pf-fade .8s var(--ease) .25s both" }}>
            {active && (
              <Link className="pf-btn dark" href={`/pay?to=${encodeURIComponent(name)}`}>
                Pay {name}
              </Link>
            )}
            {roles.isWallet && (
              <Link className="pf-btn line" href={`/vault/${name}`}>
                Open dashboard
              </Link>
            )}
            <Link className="pf-btn ghost" href={`/request/new?to=${encodeURIComponent(name)}`}>
              Payment link
            </Link>
          </div>
        </div>
      </header>
      {v.status === STATUS.FROZEN && (
        <Notice tone="red">This org&apos;s vault is frozen. Payments to it are paused until a majority of its wallets unfreezes it.</Notice>
      )}
      <div className="pf-grid3">
        {[
          { k: "Voters", v: String(v.s.wallets.length), d: "wallets, one vote each" },
          { k: "USDC reserves", v: formatUsd(held), d: `behind ${v.symbol}, 1:1` },
          { k: "In the Orbital pool", v: fmtAmount(v.poolLiquidity, 6, 2), d: `${v.symbol} available to receive payments` },
        ].map((x, i) => (
          <div key={x.k} className="pf-card flex flex-col gap-2" data-pf style={{ "--d": `${i * 0.06}s` } as CSSProperties}>
            <span className="pf-mono pf-dim">{x.k}</span>
            <span className="pf-big">{x.v}</span>
            <span className="text-[13px] text-[var(--subtle)]">{x.d}</span>
          </div>
        ))}
      </div>
      <Section label="What paying this org means" title="Paid by name, protected by its team.">
        <div className="pf-grid3">
          {[
            {
              g: "fan" as const,
              t: "You pay in your token",
              d: `Your vault swaps your own Protected token into the Orbital pool; ${name} receives ${v.symbol}. Neither side ever holds the other's token.`,
            },
            {
              g: "bars" as const,
              t: "Your budget applies",
              d: "The swap-in counts against your Instant budget. Anything larger is queued and scored like any other payment.",
            },
            {
              g: "ladder" as const,
              t: v.verified ? "A verified business" : "Not verified yet",
              d: v.verified
                ? "The palmfi team checked this org's identity. The badge carries no power over funds."
                : "Names are first come, first served. Confirm the name with the org before a large payment.",
            },
          ].map((x) => (
            <div key={x.t} className="pf-card flex flex-col gap-3">
              <Glyph kind={x.g} seed={3} className="h-10 w-10" style={{ stroke: "var(--leaf)", fill: "none" }} />
              <h3 className="pf-h3">{x.t}</h3>
              <p className="text-[14px] leading-relaxed text-[var(--subtle)]">{x.d}</p>
            </div>
          ))}
        </div>
      </Section>
      <Card label="Onchain">
        <dl className="pf-kv">
          <dt>Vault</dt>
          <dd>
            <AddressChip address={v.vault} />
          </dd>
          <dt>Token</dt>
          <dd>
            <AddressChip address={v.s.token} label={v.symbol} />
          </dd>
          <dt>Recovery vault</dt>
          <dd>
            <AddressChip address={v.s.recoveryVault} />
          </dd>
        </dl>
      </Card>
    </>
  );
}

/* ───────────── /directory ───────────── */

export function Directory() {
  const idx = useVaultIndex();
  const [q, setQ] = useState("");
  const [f, setF] = useState<"all" | "verified" | "active" | "frozen">("all");
  const list = idx.entries.filter(
    (e) =>
      (!q || (e.name ?? e.vault).toLowerCase().includes(q.toLowerCase())) &&
      (f === "all" || (f === "verified" && e.verified) || (f === "active" && e.status === STATUS.ACTIVE) || (f === "frozen" && e.status === STATUS.FROZEN)),
  );
  const count = (fx: typeof f) =>
    idx.entries.filter(
      (e) =>
        fx === "all" || (fx === "verified" && e.verified) || (fx === "active" && e.status === STATUS.ACTIVE) || (fx === "frozen" && e.status === STATUS.FROZEN),
    ).length;
  return (
    <>
      <PageHead
        index="(Directory)"
        title="Every org,"
        em="by name."
        lede="Each org has one vault, one token and one name. Pay any of them by name through the Orbital pool."
      />
      <div className="flex flex-wrap items-center justify-between gap-4" data-pf>
        <div className="flex flex-wrap gap-1.5">
          {(["all", "active", "verified", "frozen"] as const).map((k) => (
            <button key={k} className={`pf-chip ${f === k ? "on" : ""}`} onClick={() => setF(k)}>
              {k[0].toUpperCase() + k.slice(1)} <span className="n">{count(k)}</span>
            </button>
          ))}
        </div>
        <input className="pf-input max-w-[320px]" placeholder="Search names" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search orgs" />
      </div>
      {idx.isLoading ? (
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} h={240} className="rounded-[18px]" />
          ))}
        </div>
      ) : !list.length ? (
        <div className="pf-card">
          <EmptyState
            glyph="grid"
            title={q ? `No org matches “${q}”` : "No orgs here yet"}
            action={
              <Link className="pf-btn dark" href={`/onboard${q ? `?name=${encodeURIComponent(q.toLowerCase())}` : ""}`}>
                {q ? `Claim “${q.toLowerCase()}”` : "Create the first"}
              </Link>
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
          {list.map((e, i) => (
            <Link
              key={e.vault}
              href={`/o/${e.name ?? e.vault}`}
              className="pf-card lift group flex flex-col items-start gap-5"
              data-pf
              style={{ "--d": `${(i % 8) * 0.04}s` } as CSSProperties}
            >
              <OrgCard name={e.name ?? e.vault} width={92} tilt />
              <span className="flex w-full flex-col gap-2">
                <span className="pf-serif truncate text-[30px] leading-none tracking-tight">{e.name ?? "unnamed"}</span>
                <span className="flex flex-wrap gap-1.5">
                  <StatusBadge status={STATUS_LABEL[e.status ?? 0]} />
                  {e.verified && <Badge tone="blue">verified</Badge>}
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

/* ───────────── /status ───────────── */

function useRpcLatency() {
  const client = usePublicClient({ chainId });
  const [ms, setMs] = useState<number>();
  const [block, setBlock] = useState<bigint>();
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    const run = async () => {
      try {
        const t = performance.now();
        const b = await client!.getBlockNumber();
        if (!live) return;
        setMs(Math.round(performance.now() - t));
        setBlock(b);
        setErr(false);
      } catch {
        if (live) setErr(true);
      }
    };
    run();
    const id = setInterval(run, 15_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [client]);
  return { ms, block, err };
}

function SystemDiagram({ ok, vaults }: { ok: boolean; vaults: number }) {
  const n = Math.max(3, Math.min(vaults, 9));
  return (
    <svg viewBox="0 0 900 260" className="w-full" aria-label="Chainlink CRE reports through the Hub to every vault">
      <defs>
        <style>{`.ln{fill:none;stroke:#1b1b18;stroke-width:1}.flow{fill:none;stroke-width:2;stroke-dasharray:.04 .08;animation:fl 2.4s linear infinite}@keyframes fl{to{stroke-dashoffset:-.24}}.lb{font:10px var(--font-mono-site),monospace;letter-spacing:.06em;fill:#44423c}`}</style>
      </defs>
      {[
        { x: 70, y: 80, t: "SENTINEL" },
        { x: 70, y: 180, t: "RECONCILER" },
      ].map((s) => (
        <g key={s.t}>
          <rect x={s.x - 50} y={s.y - 22} width="100" height="44" rx="22" fill="#1d3a2a" />
          <text x={s.x} y={s.y + 4} textAnchor="middle" className="lb" style={{ fill: "#cfe86a" }}>
            {s.t}
          </text>
          <path className="ln" pathLength={1} d={`M${s.x + 50},${s.y} C 220,${s.y} 230,130 300,130`} />
          <path className="flow" pathLength={1} d={`M${s.x + 50},${s.y} C 220,${s.y} 230,130 300,130`} style={{ stroke: ok ? "#5caa3a" : "#c8962e" }} />
        </g>
      ))}
      <rect x="300" y="108" width="120" height="44" rx="10" fill="#fff" stroke="#1b1b18" />
      <text x="360" y="134" textAnchor="middle" className="lb">
        FORWARDER
      </text>
      <path className="ln" d="M420,130 L500,130" />
      <path className="flow" pathLength={1} d="M420,130 L500,130" style={{ stroke: ok ? "#5caa3a" : "#c8962e" }} />
      <rect x="500" y="98" width="110" height="64" rx="14" fill="#1b1b18" />
      <text x="555" y="134" textAnchor="middle" className="lb" style={{ fill: "#fdfdfb" }}>
        HUB
      </text>
      {Array.from({ length: n }, (_, i) => {
        const y = 30 + (i * 200) / (n - 1);
        const id = orgIdentity(`v${i}`);
        return (
          <g key={i}>
            <path className="ln" pathLength={1} d={`M610,130 C 700,130 720,${y} 800,${y}`} style={{ stroke: "#cfccc3" }} />
            <path
              className="flow"
              pathLength={1}
              d={`M610,130 C 700,130 720,${y} 800,${y}`}
              style={{ stroke: ok ? "#8dbd6b" : "#e9d95c", animationDelay: `${i * -0.3}s` }}
            />
            <rect x="800" y={y - 13} width="20" height="26" rx="4" fill={id.bg} stroke="#1b1b18" strokeWidth=".7" />
          </g>
        );
      })}
      <text x="860" y="134" className="lb">
        {vaults} VAULTS
      </text>
    </svg>
  );
}

export function Status() {
  const h = useNetworkHealth();
  const idx = useVaultIndex();
  const rpc = useRpcLatency();
  const now = useNow(1000);
  const reports = useHubEvents(["ReportAccepted", "ReportRejected", "Frozen", "Blocked"], "status", 40_000n);
  const age = h.lastHeartbeat ? now - Number(h.lastHeartbeat) : undefined;
  const stale = h.staleAfter ? Number(h.staleAfter) : 3600;
  const beatOk = age !== undefined && h.lastHeartbeat !== 0n && age < stale;
  const ok = beatOk && !!h.creLive && !rpc.err;
  const checks = [
    {
      k: "Sentinel heartbeat",
      ok: beatOk,
      v: h.lastHeartbeat === 0n ? "never" : age !== undefined ? `${formatDuration(age)} ago` : "…",
      d: `Stale after ${formatDuration(stale)}. While stale, queued requests wait the max delay.`,
    },
    {
      k: "Chainlink CRE",
      ok: !!h.creLive,
      v: h.creLive ? "live" : "quiet",
      d: "Live means every outflow is scored; quiet means the direct instant lane applies.",
    },
    {
      k: "Arc RPC",
      ok: !rpc.err,
      v: rpc.err ? "unreachable" : rpc.ms !== undefined ? `${rpc.ms} ms` : "…",
      d: rpc.block ? `Block ${rpc.block.toLocaleString()}` : "Public endpoint; it rate-limits under load.",
    },
    { k: "Vaults", ok: true, v: String(idx.count), d: `${idx.entries.filter((e) => e.status === STATUS.FROZEN).length} frozen right now` },
    { k: "Orbital pool", ok: true, v: `${h.poolTokens ?? "…"} tokens`, d: "Every org's token in one Uniswap v4 hook pool." },
  ];
  return (
    <>
      <PageHead
        index="(Status)"
        title={ok ? "Everything is" : "Running,"}
        em={ok ? "working." : "with a caveat."}
        lede={
          ok
            ? "The Sentinel is reporting, every outflow is being scored and Arc is reachable."
            : "Something below needs attention. Funds stay protected: without the Sentinel, queued requests simply wait the full max delay."
        }
        aside={
          <Badge tone={ok ? "green" : "amber"} live>
            {ok ? "operational" : "degraded"}
          </Badge>
        }
      />
      <Card label="Live system">
        <SystemDiagram ok={ok} vaults={idx.count} />
      </Card>
      <div className="pf-list" data-pf>
        {checks.map((c) => (
          <div key={c.k} className="pf-row">
            <i
              className="h-2.5 w-2.5 flex-none rounded-full"
              style={{ background: c.ok ? "var(--leaf)" : "var(--amber)", boxShadow: `0 0 0 4px ${c.ok ? "#e8f2df" : "#faf3cc"}` }}
            />
            <span className="grow flex flex-col">
              <span className="text-[16px]">{c.k}</span>
              <span className="text-[13px] text-[var(--subtle)]">{c.d}</span>
            </span>
            <span className="pf-serif text-[24px] tabular">{c.v}</span>
          </div>
        ))}
      </div>
      <div className="pf-grid2">
        <Card label="Recent reports and alerts" title="From the last ~40k blocks">
          {reports.isLoading ? (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} h={36} />
              ))}
            </div>
          ) : !reports.data?.length ? (
            <p className="text-[14px] text-[var(--subtle)]">No reports in this window.</p>
          ) : (
            <ul className="flex flex-col">
              {reports.data.slice(0, 12).map((a) => (
                <li key={`${a.tx}-${a.logIndex}`} className="flex items-center justify-between gap-3 border-b border-[var(--line)] py-3 text-[14px]">
                  <span className="flex items-center gap-3">
                    <Badge tone={a.event === "ReportAccepted" ? "green" : a.event === "ReportRejected" ? "amber" : "red"}>
                      {a.event.replace("Report", "")}
                    </Badge>
                    {a.event === "ReportAccepted"
                      ? `type ${a.args.reportType}${Number(a.args.requestId) ? ` · request #${a.args.requestId}` : ""}`
                      : a.event === "Blocked"
                        ? "destination blocklisted"
                        : a.event === "Frozen"
                          ? "a vault froze"
                          : `reason ${a.args.reason}`}
                  </span>
                  <a className="pf-link text-[var(--subtle)]" href={txUrl(a.tx)} target="_blank" rel="noreferrer">
                    ≈ {ago(a.at)}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card label="Contracts" title="Arc testnet">
          <dl className="pf-kv">
            {[
              ["Hub", deployments.hub],
              ["Vault factory", deployments.factory],
              ["Orbital hook", deployments.hook],
              ["Orbital router", deployments.router],
              ["Uniswap v4 PoolManager", network.poolManager],
              ["USDC", network.usdc],
              ["Admin (no fund powers)", h.admin],
            ].map(([k, a]) => (
              <div key={k} className="contents">
                <dt>{k}</dt>
                <dd>
                  <AddressChip address={a} />
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </>
  );
}

/* ───────────── /pool ───────────── */

function usePoolTokens() {
  const count = useReadContract({
    address: deployments.hook,
    abi: orbitalHookAbi,
    functionName: "tokenCount",
    chainId,
    query: { enabled: !!deployments.hook },
  });
  const n = Number(count.data ?? 0n);
  const toks = useReadContracts({
    allowFailure: true,
    contracts: Array.from(
      { length: n },
      (_, i) => ({ address: deployments.hook, abi: orbitalHookAbi, functionName: "tokens", args: [BigInt(i)], chainId }) as const,
    ),
    query: { enabled: n > 0 },
  });
  const tokens = (toks.data ?? []).map((t) => t.result as Address | undefined).filter((t): t is Address => !!t);
  const meta = useReadContracts({
    allowFailure: true,
    contracts: tokens.flatMap((t) => [
      { address: deployments.hook, abi: orbitalHookAbi, functionName: "vaultOf", args: [t], chainId } as const,
      { address: deployments.hook, abi: orbitalHookAbi, functionName: "reserveOf", args: [t], chainId } as const,
      { address: deployments.hook, abi: orbitalHookAbi, functionName: "liquidityOf", args: [t], chainId } as const,
    ]),
    query: { enabled: tokens.length > 0, refetchInterval: 15_000 },
  });
  const rows = tokens.map((t, i) => ({
    token: t,
    vault: meta.data?.[i * 3]?.result as Address | undefined,
    reserve: (meta.data?.[i * 3 + 1]?.result as bigint) ?? 0n,
    liquidity: (meta.data?.[i * 3 + 2]?.result as bigint) ?? 0n,
  }));
  const names = useNames(rows.map((r) => r.vault));
  const statuses = useReadContracts({
    allowFailure: true,
    contracts: rows.map((r) => ({ address: deployments.hub, abi: hubAbi, functionName: "statusOf", args: [r.vault!], chainId }) as const),
    query: { enabled: rows.length > 0 && rows.every((r) => !!r.vault) },
  });
  return {
    rows: rows.map((r, i) => ({ ...r, name: names(r.vault), status: statuses.data?.[i]?.result as number | undefined })),
    isLoading: count.isLoading || toks.isLoading || meta.isLoading,
  };
}

function PoolRing({ rows, swap }: { rows: { token: Address; name?: string; reserve: bigint }[]; swap?: { from: number; to: number; k: number } }) {
  const C = 300;
  const R = 200;
  const total = rows.reduce((a, r) => a + r.reserve, 0n) || 1n;
  const pos = rows.map((r, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(rows.length, 1);
    const share = Number((r.reserve * 1000n) / total) / 1000;
    return {
      x: r2(C + Math.cos(a) * R),
      y: r2(C + Math.sin(a) * R),
      lx: r2(C + Math.cos(a) * (R + 40)),
      ly: r2(C + Math.sin(a) * (R + 40)),
      c: Math.cos(a),
      s: 14 + share * 30,
      id: orgIdentity(r.name ?? r.token),
    };
  });
  return (
    <svg viewBox="0 0 600 600" className="mx-auto w-full max-w-[560px] overflow-visible" aria-label="Orbital pool: every org's token around one pool">
      <circle cx={C} cy={C} r={R} fill="none" stroke="#1b1b18" strokeWidth=".7" />
      <circle cx={C} cy={C} r={R * 0.52} fill="none" stroke="#b9b6ad" strokeWidth=".7" strokeDasharray="2 5" />
      {pos.map((p, i) => (
        <line key={i} x1={C} y1={C} x2={p.x} y2={p.y} stroke="#cfccc3" strokeWidth=".6" />
      ))}
      {swap && pos[swap.from] && pos[swap.to] && (
        <g key={swap.k}>
          <line
            x1={pos[swap.from].x}
            y1={pos[swap.from].y}
            x2={C}
            y2={C}
            pathLength={1}
            stroke="#cdb935"
            strokeWidth="1.8"
            strokeDasharray="1 1"
            style={{ animation: "pf-draw 1s var(--ease) both" }}
          />
          <line
            x1={C}
            y1={C}
            x2={pos[swap.to].x}
            y2={pos[swap.to].y}
            pathLength={1}
            stroke="#3f7d3a"
            strokeWidth="1.8"
            strokeDasharray="1 1"
            style={{ animation: "pf-draw 1s var(--ease) .7s both" }}
          />
        </g>
      )}
      {pos.map((p, i) => (
        <g key={rows[i].token} style={{ animation: `pf-pop .8s var(--ease) ${i * 0.05}s both`, transformOrigin: `${p.x}px ${p.y}px` }}>
          <rect x={p.x - p.s / 2} y={p.y - (p.s * 1.3) / 2} width={p.s} height={p.s * 1.3} rx={p.s * 0.18} fill={p.id.bg} stroke="#1b1b18" strokeWidth=".7" />
          <text
            x={p.lx}
            y={p.ly + 3}
            textAnchor={p.c > 0.2 ? "start" : p.c < -0.2 ? "end" : "middle"}
            style={{ font: "11px var(--font-mono-site), monospace", fill: "#44423c" }}
          >
            {rows[i].name ?? `${rows[i].token.slice(0, 6)}…`}
          </text>
        </g>
      ))}
      <circle cx={C} cy={C} r="34" fill="#1b1b18" />
      <text x={C} y={C + 3} textAnchor="middle" style={{ font: "9px var(--font-mono-site), monospace", letterSpacing: ".1em", fill: "#fdfdfb" }}>
        ORBITAL
      </text>
    </svg>
  );
}

export function Pool() {
  const { rows, isLoading } = usePoolTokens();
  const ev = usePoolEvents();
  const swaps = useMemo(() => (ev.data ?? []).filter((e) => e.event === "OrbitalSwap"), [ev.data]);
  const [tick, setTick] = useState(0);
  const tx = useTx();
  const { isConnected } = useAccount();
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 3200);
    return () => clearInterval(t);
  }, []);
  const idxOf = (t: unknown) => rows.findIndex((r) => r.token.toLowerCase() === String(t).toLowerCase());
  const s = swaps.length ? swaps[tick % Math.min(swaps.length, 8)] : undefined;
  const swap = s ? { from: idxOf(s.args.tokenIn), to: idxOf(s.args.tokenOut), k: tick } : undefined;
  const total = rows.reduce((a, r) => a + r.reserve, 0n);
  const nameOfToken = (t: unknown) => rows[idxOf(t)]?.name ?? String(t).slice(0, 8);
  return (
    <>
      <PageHead
        index="(Orbital pool)"
        title="One pool,"
        em="every org's token."
        lede="Orgs pay each other by swapping their own Protected token in and the payee's out. The pool is a single Uniswap v4 hook using Paradigm's Orbital N-token curve; issuers settle foreign inventory back in USDC."
      />
      <div className="grid items-center gap-8 lg:grid-cols-[1.2fr_1fr]">
        <Card>
          {isLoading ? (
            <Skeleton h={480} />
          ) : rows.length ? (
            <PoolRing rows={rows} swap={swap} />
          ) : (
            <EmptyState glyph="rings" title="No tokens in the pool yet" />
          )}
        </Card>
        <div className="flex flex-col gap-6">
          <div className="pf-card flex flex-col gap-2" data-pf>
            <span className="pf-mono pf-dim">Total reserves</span>
            <span className="pf-big">{fmtAmount(total, 6, 2)}</span>
            <span className="text-[13px] text-[var(--subtle)]">
              across {rows.length} tokens · {swaps.length} recent swaps
            </span>
          </div>
          <Card label="Settlement" title="Send foreign inventory home">
            <p className="text-[14px] leading-relaxed text-[var(--subtle)]">
              The pool ends up holding more of some tokens than others. Settling redeems them from their issuers&apos; vaults for USDC. Anyone can trigger it.
            </p>
            <div className="mt-4">
              <button
                className="pf-btn line"
                disabled={!isConnected || tx.busy}
                onClick={() => tx.send({ address: deployments.hook!, abi: orbitalHookAbi, functionName: "settle" }, "Settle pool")}
              >
                {tx.busy && <span className="spin" />}
                Settle pool
              </button>
              <TxStatus state={tx.state} />
            </div>
          </Card>
        </div>
      </div>
      <Section label="Tokens" title="Who's in the pool">
        <div className="pf-list">
          {rows.map((r) => (
            <Link key={r.token} href={`/o/${r.name ?? r.vault}`} className="pf-row group">
              <OrgCard name={r.name ?? r.token} width={30} />
              <span className="grow flex flex-col">
                <span className="text-[16px]">{r.name ?? r.token}</span>
                <span className="pf-mono pf-dim">{STATUS_LABEL[r.status ?? 0]}</span>
              </span>
              <span className="hidden flex-col items-end sm:flex">
                <span className="pf-mono pf-dim">reserve</span>
                <span className="tabular">{fmtAmount(r.reserve, 6, 2)}</span>
              </span>
              <span className="flex flex-col items-end">
                <span className="pf-mono pf-dim">liquidity</span>
                <span className="tabular">{fmtAmount(r.liquidity, 6, 2)}</span>
              </span>
              <span className="text-[var(--subtle)] transition-transform duration-500 group-hover:translate-x-1">→</span>
            </Link>
          ))}
        </div>
      </Section>
      {swaps.length > 0 && (
        <Section label="Recent payments through the pool">
          <div className="pf-list">
            {swaps.slice(0, 10).map((e) => (
              <a key={`${e.tx}-${e.logIndex}`} href={`/pay/${e.tx}`} className="pf-row group">
                <span className="grow text-[15px]">
                  {nameOfToken(e.args.tokenIn)} paid {nameOfToken(e.args.tokenOut)}{" "}
                  <span className="tabular">{fmtAmount(BigInt(e.args.amountOut as bigint), 6, 2)}</span>
                </span>
                <span className="text-[13px] text-[var(--subtle)]">≈ {ago(e.at)}</span>
                <span className="text-[var(--subtle)] transition-transform duration-500 group-hover:translate-x-1">receipt →</span>
              </a>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

/* ───────────── /blocklist ───────────── */

export function Blocklist() {
  const ev = useHubEvents(["Blocked"], "blocked");
  const rows = ev.data ?? [];
  const names = useNames(rows.map((r) => r.args.sourceVault as Address));
  const active = useReadContracts({
    allowFailure: true,
    contracts: rows.map((r) => ({ address: deployments.hub, abi: hubAbi, functionName: "isBlocked", args: [r.args.account as Address], chainId }) as const),
    query: { enabled: rows.length > 0 },
  });
  const [q, setQ] = useState("");
  const valid = isAddress(q.trim());
  const check = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: deployments.hub, abi: hubAbi, functionName: "isBlocked", args: [q.trim() as Address], chainId },
      { address: deployments.hub, abi: hubAbi, functionName: "blockedUntil", args: [q.trim() as Address], chainId },
    ],
    query: { enabled: valid },
  });
  const blocked = check.data?.[0]?.result as boolean | undefined;
  const until = check.data?.[1]?.result as bigint | undefined;
  return (
    <>
      <PageHead
        index="(Blocklist)"
        title="One victim's attacker,"
        em="everyone's warning."
        lede="When the Sentinel flags a payment, its destination is blocklisted for every vault on the network. Check an address before you pay it."
      />
      <Card label="Check an address">
        <div className="flex flex-col gap-4">
          <input className="pf-input mono" placeholder="0x…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Address to check" />
          {valid && check.isSuccess && (
            <div style={{ animation: "pf-fade .5s var(--ease) both" }}>
              {blocked ? (
                <Notice tone="red">
                  <strong>Blocklisted</strong> until {until ? new Date(Number(until) * 1000).toLocaleString() : "further notice"}. Payments to this address are
                  flagged on every vault.
                </Notice>
              ) : (
                <Notice tone="green">Not on the blocklist. That alone doesn&apos;t make it safe: confirm the address with the payee.</Notice>
              )}
            </div>
          )}
        </div>
      </Card>
      <Section label="History" title={rows.length ? `${rows.length} addresses blocklisted` : "Blocklisted addresses"}>
        {ev.isLoading ? (
          <Skeleton h={160} className="rounded-[18px]" />
        ) : !rows.length ? (
          <div className="pf-card">
            <EmptyState glyph="ladder" title="Nothing blocklisted" body="No payment on the network has been flagged yet." />
          </div>
        ) : (
          <div className="pf-list">
            {rows.map((r, i) => {
              const on = active.data?.[i]?.result === true;
              const src = names(r.args.sourceVault as string);
              return (
                <div key={`${r.tx}-${r.logIndex}`} className="pf-row">
                  <AddressChip address={r.args.account as string} />
                  <span className="grow text-[14px] text-[var(--subtle)]">
                    flagged by{" "}
                    {src ? (
                      <Link className="pf-link" href={`/o/${src}`}>
                        {src}
                      </Link>
                    ) : (
                      "a vault"
                    )}{" "}
                    · ≈ {ago(r.at)}
                  </span>
                  <span className="hidden text-[13px] text-[var(--subtle)] sm:inline">until {new Date(Number(r.args.until) * 1000).toLocaleDateString()}</span>
                  <Badge tone={on ? "red" : "gray"}>{on ? "blocked" : "expired"}</Badge>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </>
  );
}
