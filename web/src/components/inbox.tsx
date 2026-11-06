"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { vaultAbi } from "@/abi";
import { useMyVaults, useOpenRequests, type VaultEntry } from "@/lib/hub";
import { arcTestnet } from "@/lib/network";
import { REQ, STATUS, STATUS_LABEL } from "@/lib/palm";
import { useVault } from "@/lib/vault";
import { HillsBand, OrgCard, PageHead, Skeleton, WalletGate } from "./brand";
import { StatusBadge } from "./ui";
import { eq } from "./vault/common";
import { RequestLine } from "./vault/request-ui";
import { PendingChanges } from "./vault/settings";

type Filter = "mine" | "ready" | "all";

function VaultInbox({ entry, filter, me, onCount }: { entry: VaultEntry; filter: Filter; me: Address; onCount: (vault: string, n: number) => void }) {
  const v = useVault(entry.vault);
  const pending = useMemo(() => v.requests.filter((r) => r.state === REQ.PENDING), [v.requests]);
  const voted = useReadContracts({
    allowFailure: true,
    contracts: pending.map((r) => ({ address: entry.vault, abi: vaultAbi, functionName: "hasVoted", args: [r.id, me], chainId: arcTestnet.id }) as const),
    query: { enabled: pending.length > 0, refetchInterval: 10_000 },
  });
  const changes = v.changes.filter((c) => !c.done);
  const shown = pending.filter((r, i) => {
    if (filter === "ready") return r.executable;
    if (filter === "mine") return voted.data?.[i]?.result === false && !eq(r.requester, me);
    return true;
  });
  const frozen = v.status === STATUS.FROZEN;
  const total = shown.length + (filter === "ready" ? 0 : changes.length) + (frozen ? 1 : 0);
  useEffect(() => onCount(entry.vault, total), [entry.vault, total, onCount]);

  if (v.isLoading) return <Skeleton h={120} className="rounded-[18px]" />;
  if (!total) return null;
  const base = `/vault/${entry.name ?? entry.vault}`;
  return (
    <section className="pf-card" data-pf>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link href={base} className="group flex items-center gap-4">
          <OrgCard name={entry.name ?? entry.vault} width={40} tilt />
          <span className="flex flex-col">
            <span className="pf-serif text-[30px] leading-none tracking-tight">{entry.name ?? "vault"}</span>
            <span className="pf-mono pf-dim">
              {shown.length} request{shown.length === 1 ? "" : "s"}
              {filter !== "ready" && changes.length ? ` · ${changes.length} settings change${changes.length === 1 ? "" : "s"}` : ""}
            </span>
          </span>
        </Link>
        <StatusBadge status={STATUS_LABEL[v.status ?? 0]} />
      </header>
      {frozen && (
        <Link href={`${base}/incident`} className="mb-4 flex items-center justify-between gap-3 rounded-2xl bg-[#fcebe7] px-4 py-3 text-sm">
          <span>
            <strong>Frozen.</strong> A majority can unfreeze, remove a wallet or migrate to the recovery vault.
          </span>
          <span>→</span>
        </Link>
      )}
      {shown.length > 0 && (
        <div className="pf-list">
          {shown.map((r) => (
            <RequestLine key={r.id.toString()} v={v} r={r} base={base} />
          ))}
        </div>
      )}
      {filter !== "ready" && changes.length > 0 && (
        <div className="mt-5">
          <PendingChanges v={v} compact />
        </div>
      )}
    </section>
  );
}

export function Inbox() {
  const { address } = useAccount();
  const my = useMyVaults(address);
  const open = useOpenRequests();
  const [filter, setFilter] = useState<Filter>("mine");
  const [counts, setCounts] = useState<Record<string, number>>({});
  const onCount = useMemo(() => (vault: string, n: number) => setCounts((c) => (c[vault] === n ? c : { ...c, [vault]: n })), []);
  const total = my.mine.reduce((a, m) => a + (counts[m.vault] ?? 0), 0);
  const openMine = useMemo(() => {
    const set = new Set(my.mine.map((m) => m.vault.toLowerCase()));
    return (open.data ?? []).filter((r) => r.state === REQ.PENDING && set.has(r.vault.toLowerCase())).length;
  }, [my.mine, open.data]);
  const settled = my.mine.length > 0 && my.mine.every((m) => counts[m.vault] !== undefined);

  return (
    <>
      <PageHead
        index="(Inbox)"
        title="What needs"
        em="your say."
        lede={
          my.mine.length
            ? `Everything waiting on a vote across your ${my.mine.length} vault${my.mine.length === 1 ? "" : "s"}. Votes are what make a stolen key useless, so this is the page alerts link to.`
            : "Requests and settings changes that need your vote, across every vault your wallet belongs to."
        }
      />
      <WalletGate
        title="Connect to see your inbox"
        body="Your inbox is every request and settings change waiting on a vote, in each vault your wallet is a voter of."
      >
        {my.isLoading ? (
          <div className="flex flex-col gap-4">
            <Skeleton h={44} w={340} className="rounded-full" />
            <Skeleton h={160} className="rounded-[18px]" />
            <Skeleton h={160} className="rounded-[18px]" />
          </div>
        ) : !my.mine.length ? (
          <HillsBand className="px-6 pt-16 pb-[min(30vw,300px)] text-center">
            <h2 className="pf-h2">You&apos;re not a voter in any vault yet</h2>
            <p className="mx-auto mt-4 max-w-[46ch] text-[15px] text-[var(--ink-2)]">
              Create a vault for your team, or ask a team that uses palmfi to add this wallet (it takes a majority vote and 48 hours).
            </p>
            <div className="mt-6 flex justify-center gap-2">
              <Link className="pf-btn dark" href="/onboard">
                Create a vault
              </Link>
              <Link className="pf-btn line" href="/directory">
                Browse the directory
              </Link>
            </div>
          </HillsBand>
        ) : (
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-4" data-pf>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ["mine", "Needs my vote"],
                    ["ready", "Ready to execute"],
                    ["all", "Everything open"],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} className={`pf-chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
                    {label}
                    {filter === k && settled && <span className="n">{total}</span>}
                  </button>
                ))}
              </div>
              <span className="pf-mono pf-dim">
                {openMine} open request{openMine === 1 ? "" : "s"} across {my.mine.length} vault{my.mine.length === 1 ? "" : "s"}
              </span>
            </div>
            {my.mine.map((m) => (
              <VaultInbox key={m.vault} entry={m} filter={filter} me={address!} onCount={onCount} />
            ))}
            {settled && total === 0 && (
              <HillsBand className="px-6 pt-16 pb-[min(30vw,300px)] text-center">
                <span className="pf-mono pf-dim">All clear</span>
                <h2 className="pf-h2 mt-3">
                  {filter === "ready" ? "Nothing ready to execute." : filter === "mine" ? "Nothing needs your vote." : "Nothing open."}
                </h2>
                <p className="mx-auto mt-4 max-w-[44ch] text-[15px] text-[var(--ink-2)]">
                  Link alerts on each vault&apos;s Wallets tab so you hear about the next one in time.
                </p>
                <div className="mt-6 flex justify-center">
                  <Link className="pf-btn line" href="/settings">
                    Notification settings
                  </Link>
                </div>
              </HillsBand>
            )}
          </div>
        )}
      </WalletGate>
    </>
  );
}
