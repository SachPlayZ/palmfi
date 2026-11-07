"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { decodeEventLog, type Address, type Hex } from "viem";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { hubAbi, orbitalHookAbi } from "@/abi";
import { deployments } from "@/lib/deployments";
import { useMyVaults, useNames } from "@/lib/hub";
import { arcTestnet, txUrl } from "@/lib/network";
import { isValidName } from "@/lib/palm";
import { useVault, useVaultAddress } from "@/lib/vault";
import { AddressChip, CopyButton, EmptyState, OrgCard, PageHead, Skeleton, WalletGate, useHref, useOrigin } from "./brand";
import { Badge, Field, Input, Notice } from "./ui";
import { fmtAmount } from "./vault/common";
import { SendCard } from "./vault/send";

const chainId = arcTestnet.id;

/* ───────────── /pay ───────────── */

function PayFrom({ id, to, amount }: { id: string; to: string; amount: string }) {
  const { vault, isLoading, notFound } = useVaultAddress(id);
  const v = useVault(vault);
  if (notFound) return <Notice tone="amber">No vault called “{id}”.</Notice>;
  if (isLoading || v.isLoading || !v.s) return <Skeleton h={360} className="rounded-[18px]" />;
  return <SendCard key={`${id}-${to}`} v={v} initialTo={to} initialAmount={amount} />;
}

export function PayFlow() {
  const params = useSearchParams();
  const to = (params.get("to") ?? "").toLowerCase();
  const amount = params.get("amount") ?? "";
  const memo = params.get("memo") ?? "";
  const { address } = useAccount();
  const my = useMyVaults(address);
  const [from, setFrom] = useState<string>(params.get("from") ?? "");
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!from && my.mine.length) setFrom(my.mine[0].name ?? my.mine[0].vault);
  }, [from, my.mine]);
  const isRequest = !!to && (!!amount || !!memo);

  return (
    <>
      <PageHead
        index="(Pay)"
        title={isRequest ? `Pay ${to}` : "Pay any org"}
        em={isRequest ? "from your vault." : "by name."}
        lede="Your Protected token is burned in your vault; they receive theirs, minted 1:1 in theirs. Your budget and your team's controls apply as usual."
      />
      {isRequest && (
        <div className="pf-card flex flex-wrap items-center gap-6" style={{ animation: "pf-fade .8s var(--ease) .2s both" }}>
          <OrgCard name={to} width={72} tilt />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="pf-mono pf-dim">Payment request from {to}</span>
            {amount && <span className="pf-big">${amount}</span>}
            {memo && <span className="text-[15px] text-[var(--ink-2)]">“{memo}”</span>}
          </div>
          <Link className="pf-link text-sm" href={`/o/${to}`}>
            Who is {to}? →
          </Link>
        </div>
      )}
      <WalletGate title="Connect to pay" body="Payments come from a vault your wallet votes in.">
        <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
          <div className="pf-card flex flex-col gap-5" data-pf>
            <span className="pf-mono pf-dim">Pay from</span>
            {my.isLoading ? (
              <Skeleton h={120} />
            ) : my.mine.length ? (
              <div className="pf-list">
                {my.mine.map((m) => {
                  const id = m.name ?? m.vault;
                  return (
                    <button key={m.vault} className="pf-row w-full text-left" onClick={() => setFrom(id)} aria-pressed={from === id}>
                      <OrgCard name={id} width={30} />
                      <span className="grow text-[16px]">{m.name ?? m.vault}</span>
                      <span
                        className={`h-4 w-4 rounded-full transition-all duration-300 ${from === id ? "bg-[var(--ink)] shadow-[inset_0_0_0_3px_#fff,0_0_0_1px_var(--ink)]" : "shadow-[inset_0_0_0_1px_var(--line)]"}`}
                      />
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-[14px] text-[var(--subtle)]">This wallet isn&apos;t a voter in any vault yet.</p>
            )}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (typed.trim()) setFrom(typed.trim().toLowerCase());
              }}
            >
              <input
                className="pf-input"
                placeholder="Or type a vault name"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                aria-label="Vault to pay from"
              />
              <button className="pf-btn line" type="submit" disabled={!typed.trim()}>
                Use
              </button>
            </form>
            {!my.mine.length && (
              <Link className="pf-btn dark w-fit" href="/onboard">
                Create a vault
              </Link>
            )}
          </div>
          <div>
            {from ? (
              <PayFrom id={from} to={to} amount={amount} />
            ) : (
              <div className="pf-card">
                <EmptyState glyph="fan" title="Pick a vault to pay from" />
              </div>
            )}
          </div>
        </div>
      </WalletGate>
    </>
  );
}

/* ───────────── /pay/[tx] receipt ───────────── */

type Swap = { tokenIn: Address; tokenOut: Address; payer: Address; amountIn: bigint; amountOut: bigint };

export function Receipt({ hash }: { hash: string }) {
  const client = usePublicClient({ chainId });
  const valid = /^0x[0-9a-fA-F]{64}$/.test(hash);
  const q = useQuery({
    queryKey: ["receipt", hash],
    enabled: !!client && valid,
    queryFn: async () => {
      const r = await client!.getTransactionReceipt({ hash: hash as Hex });
      const b = await client!.getBlock({ blockNumber: r.blockNumber });
      let swap: Swap | undefined;
      let outflows = 0;
      for (const l of r.logs) {
        try {
          if (l.address.toLowerCase() === deployments.hook?.toLowerCase()) {
            const d = decodeEventLog({ abi: orbitalHookAbi, topics: l.topics, data: l.data });
            if (d.eventName === "OrbitalSwap") swap = d.args as unknown as Swap;
          } else if (l.address.toLowerCase() === deployments.hub?.toLowerCase()) {
            const d = decodeEventLog({ abi: hubAbi, topics: l.topics, data: l.data });
            if (d.eventName === "Outflow") outflows++;
          }
        } catch {
          /* other logs */
        }
      }
      return { status: r.status, block: r.blockNumber, time: Number(b.timestamp), from: r.from, swap, outflows };
    },
  });
  const sw = q.data?.swap;
  const vaults = useReadContracts({
    allowFailure: true,
    contracts: sw
      ? ([
          { address: deployments.hook, abi: orbitalHookAbi, functionName: "vaultOf", args: [sw.tokenIn], chainId },
          { address: deployments.hook, abi: orbitalHookAbi, functionName: "vaultOf", args: [sw.tokenOut], chainId },
        ] as const)
      : [],
    query: { enabled: !!sw },
  });
  const payerVault = vaults.data?.[0]?.result as Address | undefined;
  const payeeVault = vaults.data?.[1]?.result as Address | undefined;
  const names = useNames([payerVault, payeeVault]);
  const payer = names(payerVault);
  const payee = names(payeeVault);
  const link = useHref();

  if (!valid) return <Notice tone="amber">That isn&apos;t a transaction hash.</Notice>;
  if (q.isLoading) return <Skeleton h={560} w="min(560px,100%)" className="mx-auto rounded-[18px]" />;
  if (q.error || !q.data)
    return (
      <div className="pf-card">
        <EmptyState glyph="wave" title="Couldn't find that transaction" body="It may still be confirming, or it isn't on Arc testnet." />
      </div>
    );
  const ok = q.data.status === "success";
  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5">
      <article className="pf-card relative overflow-hidden" style={{ animation: "pf-pop .8s var(--ease) both", padding: "clamp(28px,4vw,44px)" }}>
        <div className="flex items-center justify-between">
          <span className="pf-mono pf-dim">palmfi receipt</span>
          <Badge tone={ok ? "green" : "red"}>{ok ? "confirmed" : "failed"}</Badge>
        </div>
        {sw ? (
          <>
            <div className="mt-8 flex items-center justify-between gap-4">
              <span className="flex flex-col items-center gap-2">
                <OrgCard name={payer ?? sw.tokenIn} width={64} tilt />
                <span className="text-[14px]">{payer ?? "payer"}</span>
              </span>
              <svg viewBox="0 0 120 20" className="h-5 flex-1" aria-hidden>
                <path
                  d="M2 10 H110 M102 3 L112 10 L102 17"
                  fill="none"
                  stroke="var(--ink)"
                  strokeWidth="1.2"
                  pathLength={1}
                  strokeDasharray="1 1"
                  style={{ animation: "pf-draw 1.2s var(--ease) .4s both" }}
                />
              </svg>
              <span className="flex flex-col items-center gap-2">
                <OrgCard name={payee ?? sw.tokenOut} width={64} tilt />
                <span className="text-[14px]">{payee ?? "payee"}</span>
              </span>
            </div>
            <div className="mt-8 text-center">
              <span className="pf-mono pf-dim">{payee ?? "the payee"} received</span>
              <div className="pf-big" style={{ fontSize: "clamp(56px,8vw,88px)" }}>
                {fmtAmount(sw.amountOut, 6, 2)}
              </div>
              <span className="pf-mono pf-dim">USDC in {payee ?? "their"} token</span>
            </div>
          </>
        ) : (
          <p className="mt-8 text-[15px] text-[var(--ink-2)]">
            This transaction isn&apos;t an Orbital pool payment. It made {q.data.outflows} vault outflow{q.data.outflows === 1 ? "" : "s"}.
          </p>
        )}
        <div className="my-8 border-t border-dashed border-[var(--line)]" />
        <dl className="pf-kv">
          {sw && (
            <>
              <dt>Payer paid</dt>
              <dd className="tabular">{fmtAmount(sw.amountIn, 6, 4)} in its own token</dd>
              <dt>Pool spread</dt>
              <dd className="tabular">{fmtAmount(sw.amountIn - sw.amountOut, 6, 4)}</dd>
            </>
          )}
          <dt>Signed by</dt>
          <dd>
            <AddressChip address={q.data.from} />
          </dd>
          <dt>Time</dt>
          <dd>{new Date(q.data.time * 1000).toLocaleString()}</dd>
          <dt>Block</dt>
          <dd className="tabular">{q.data.block.toLocaleString()}</dd>
        </dl>
        <i className="pf-grain opacity-30" />
      </article>
      <div className="flex flex-wrap justify-center gap-2 print:hidden">
        <CopyButton text={link} label="Copy receipt link" />
        <a className="pf-btn line" href={txUrl(hash)} target="_blank" rel="noreferrer">
          View on Arcscan
        </a>
        <button className="pf-btn ghost" onClick={() => window.print()}>
          Print
        </button>
      </div>
    </div>
  );
}

/* ───────────── /request/new ───────────── */

export function RequestLink() {
  const params = useSearchParams();
  const { address } = useAccount();
  const my = useMyVaults(address);
  const [to, setTo] = useState((params.get("to") ?? "").toLowerCase());
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  useEffect(() => {
    if (!to && my.mine[0]?.name) setTo(my.mine[0].name);
  }, [to, my.mine]);
  const valid = isValidName(to) && (!amount || Number(amount) > 0);
  const origin = useOrigin();
  const url = useMemo(() => {
    if (!origin || !valid) return "";
    const u = new URL("/pay", origin);
    u.searchParams.set("to", to);
    if (amount) u.searchParams.set("amount", amount);
    if (memo) u.searchParams.set("memo", memo);
    return u.toString();
  }, [to, amount, memo, valid, origin]);
  const [canShare, setCanShare] = useState(false);
  useEffect(() => setCanShare("share" in navigator), []);
  return (
    <>
      <PageHead
        index="(Request a payment)"
        title="Send a link,"
        em="get paid by name."
        lede="Anyone with a palmfi vault opens the link and pays you vault to vault. Nothing is stored: the link carries the details."
      />
      <div className="grid gap-8 lg:grid-cols-[1fr_1fr]">
        <div className="pf-card flex flex-col gap-5" data-pf>
          <Field label="Pay to (your vault name)">
            <Input value={to} onChange={(e) => setTo(e.target.value.toLowerCase())} placeholder="northwind" />
          </Field>
          {my.mine.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {my.mine.map((m) => (
                <button key={m.vault} className={`pf-chip ${to === m.name ? "on" : ""}`} onClick={() => m.name && setTo(m.name)}>
                  {m.name}
                </button>
              ))}
            </div>
          )}
          <Field label="Amount (USDC, optional)">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="120" />
          </Field>
          <Field label="Memo (optional)" hint={`${memo.length}/80`}>
            <Input value={memo} maxLength={80} onChange={(e) => setMemo(e.target.value)} placeholder="Invoice 2026-114, design work" />
          </Field>
        </div>
        <div className="flex flex-col gap-5">
          <div className="pf-card relative overflow-hidden" style={{ minHeight: 320 } as CSSProperties}>
            <span className="pf-mono pf-dim">Preview</span>
            <div className="mt-6 flex items-start gap-5" key={to}>
              <span style={{ animation: "pf-pop .6s var(--ease) both" }}>
                <OrgCard name={to || "your-org"} width={80} tilt />
              </span>
              <div className="flex min-w-0 flex-col gap-2">
                <span className="text-[15px] text-[var(--ink-2)]">{to || "your vault"} requests</span>
                <span className="pf-big">{amount ? `$${amount}` : "any amount"}</span>
                {memo && <span className="text-[15px] text-[var(--ink-2)]">“{memo}”</span>}
              </div>
            </div>
            <div className="mt-8 flex">
              <span className="pf-btn dark pointer-events-none">Pay {to || "…"}</span>
            </div>
            <i className="pf-grain opacity-25" />
          </div>
          <div className="flex flex-wrap gap-2">
            <CopyButton text={url} label="Copy link" className={!url ? "pointer-events-none opacity-40" : ""} />
            {canShare && url && (
              <button className="pf-btn line" onClick={() => navigator.share({ title: `Pay ${to}`, text: memo || `Pay ${to} with palmfi`, url })}>
                Share
              </button>
            )}
            {url && (
              <Link className="pf-btn ghost" href={url.replace(origin, "")}>
                Open it
              </Link>
            )}
          </div>
          {!isValidName(to) && to && <span className="text-[13px] text-[var(--red)]">Names use lowercase letters, digits and hyphens.</span>}
        </div>
      </div>
    </>
  );
}
