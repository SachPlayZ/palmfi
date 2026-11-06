"use client";

import Link from "next/link";
import { useAccount } from "wagmi";
import { fastTrackNeeded, vetoNeeded } from "@/lib/palm";
import { useVault, useVaultAddress } from "@/lib/vault";
import { AddressChip, CopyButton, EmptyState, Glyph, HillsBand, OrgCard, Skeleton, WalletGate, Words } from "./brand";
import { TelegramLink } from "./telegram-link";
import { Notice } from "./ui";
import { eq } from "./vault/common";

export function Join({ id }: { id: string }) {
  const { address } = useAccount();
  const { vault, isLoading, notFound } = useVaultAddress(id);
  const v = useVault(vault);
  if (notFound)
    return (
      <div className="pf-card">
        <EmptyState glyph="rings" title="This invite points at no vault" body="Ask whoever sent it for the exact vault name." />
      </div>
    );
  if (isLoading || v.isLoading || !v.s) return <Skeleton h={480} className="rounded-[18px]" />;
  const name = v.name ?? "vault";
  const n = v.s.wallets.length;
  const isVoter = !!address && v.s.wallets.some((w) => eq(w, address));

  return (
    <div className="flex flex-col gap-8">
      <HillsBand className="px-6 pt-14 pb-[min(26vw,280px)] text-center">
        <span className="mx-auto mb-6 block w-fit" style={{ animation: "pf-pop 1s var(--ease) both" }}>
          <OrgCard name={name} width={120} tilt />
        </span>
        <span className="pf-mono pf-dim">You&apos;ve been invited to vote for</span>
        <h1 className="pf-h1 mt-3">
          <Words text={name} />
        </h1>
        <p className="mx-auto mt-4 max-w-[50ch] text-[16px] text-[var(--ink-2)]">
          {n} wallets share one rule: a stolen key can only spend the budget. Anything bigger waits, and the team can say no.
        </p>
      </HillsBand>

      <WalletGate title="Connect the wallet you were invited with" body="We check it against the vault's voter list. Nothing is signed until you link alerts.">
        {isVoter ? (
          <div className="flex flex-col gap-6">
            <Notice tone="green">
              <span className="flex flex-wrap items-center gap-2">
                <AddressChip address={address} explorer={false} /> is one of {name}&apos;s {n} voters.
              </span>
            </Notice>
            <div className="pf-grid3">
              {[
                {
                  g: "wave" as const,
                  t: "Be reachable",
                  d: "Link Telegram so you hear about long delays, flags and settings changes in time.",
                  el: <TelegramLink vault={v.vault!} />,
                },
                {
                  g: "bars" as const,
                  t: "Vote within the delay",
                  d: `Veto needs ${vetoNeeded(n)} of the other ${n - 1} wallets; fast-track needs ${fastTrackNeeded(n)} of ${n}. Your inbox shows everything waiting on you.`,
                  el: (
                    <Link className="pf-btn dark sm" href="/inbox">
                      Open my inbox
                    </Link>
                  ),
                },
                {
                  g: "rings" as const,
                  t: "Freeze if it looks wrong",
                  d: "Any one wallet can freeze the vault. A majority unfreezes, or migrates everything to the recovery vault.",
                  el: (
                    <Link className="pf-btn line sm" href={`/vault/${name}`}>
                      Open the vault
                    </Link>
                  ),
                },
              ].map((x, i) => (
                <div key={x.t} className="pf-card flex flex-col gap-3" style={{ animation: `pf-fade .7s var(--ease) ${i * 0.08}s both` }}>
                  <Glyph kind={x.g} seed={i + 3} className="h-10 w-10" style={{ stroke: "var(--leaf)", fill: "none" }} />
                  <h3 className="pf-h3">{x.t}</h3>
                  <p className="text-[14px] leading-relaxed text-[var(--subtle)]">{x.d}</p>
                  <div className="mt-auto pt-2">{x.el}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="pf-card flex flex-col gap-4">
            <Notice tone="amber">This wallet isn&apos;t one of {name}&apos;s voters yet.</Notice>
            <p className="text-[15px] text-[var(--ink-2)]">
              Send your address to someone on the team. Any voter can propose <strong>Add wallet</strong>; once a majority agrees, it applies after 48 hours.
              Come back to this link then.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <AddressChip address={address} />
              {address && <CopyButton text={address} label="Copy my address" className="sm" />}
            </div>
          </div>
        )}
      </WalletGate>
    </div>
  );
}
