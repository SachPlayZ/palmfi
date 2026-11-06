"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseAbiItem, type Address } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { sepolia } from "wagmi/chains";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, Input, Mono } from "@/components/ui";
import { deployments } from "@/lib/deployments";
import { network } from "@/lib/network";
import { decodeDnsName as decodeDns } from "@/lib/palm";

const registered = parseAbiItem("event VaultRegistered(address indexed vault, address indexed owner, bytes dnsName, bool institution)");

/** Vaults whose Owner is the connected account, from Hub VaultRegistered logs. */
function useMyVaults(owner: Address | undefined) {
  const client = usePublicClient({ chainId: sepolia.id });
  return useQuery({
    queryKey: ["myVaults", owner, deployments.hub],
    enabled: !!owner && !!deployments.hub && !!client,
    queryFn: async () => {
      const latest = await client!.getBlockNumber();
      const out: { vault: Address; name: string; institution: boolean }[] = [];
      const step = 40_000n;
      for (let from = deployments.fromBlock; from <= latest; from += step) {
        const to = from + step - 1n > latest ? latest : from + step - 1n;
        const logs = await client!.getLogs({ address: deployments.hub, event: registered, args: { owner }, fromBlock: from, toBlock: to });
        for (const l of logs) out.push({ vault: l.args.vault!, name: decodeDns(l.args.dnsName!), institution: !!l.args.institution });
      }
      return out.reverse();
    },
    staleTime: 60_000,
  });
}

export default function Home() {
  const router = useRouter();
  const { address } = useAccount();
  const [q, setQ] = useState("");
  const mine = useMyVaults(address);

  return (
    <>
      <section className="flex flex-col gap-2 py-4">
        <h1 className="text-3xl font-semibold tracking-tight">Your keys can be stolen. Your money can&apos;t leave faster than you can say no.</h1>
        <p className="max-w-2xl text-[var(--subtle)]">
          A palmfi Vault holds your USDC and ETH behind your own Protected token. Small payments go out instantly within your
          Instant budget; anything larger becomes a Queued request that the Sentinel checks, and above your Hard cap it needs your
          Face ID too.
        </p>
        <div className="mt-2 flex gap-2">
          <Link href="/onboard">
            <Button>Create my Vault</Button>
          </Link>
          <Link href="/pay">
            <Button variant="secondary">Pay a name</Button>
          </Link>
        </div>
      </section>

      <Card title="Open a Vault">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) router.push(`/vault/${encodeURIComponent(q.trim().toLowerCase())}`);
          }}
        >
          <Input placeholder={`alice.${network.ensParent} or 0x…`} value={q} onChange={(e) => setQ(e.target.value)} className="flex-1" aria-label="Vault name or address" />
          <Button type="submit">Open</Button>
        </form>
      </Card>

      {address && (
        <Card title="Vaults you own">
          {!deployments.hub && <p className="text-sm text-[var(--subtle)]">Not deployed yet.</p>}
          {mine.isLoading && <p className="text-sm text-[var(--subtle)]">Scanning the Hub…</p>}
          {mine.error && <p className="text-sm text-red-600">Couldn&apos;t scan logs: open your Vault by name above.</p>}
          {mine.data?.length === 0 && <p className="text-sm text-[var(--subtle)]">No Vault owned by this account yet.</p>}
          <ul className="flex flex-col gap-2">
            {mine.data?.map((v) => (
              <li key={v.vault}>
                <Link href={`/vault/${v.vault}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] p-3 hover:bg-[var(--muted)]">
                  <span className="font-medium">{v.name}</span>
                  <span className="text-xs text-[var(--subtle)]">
                    {v.institution ? "Institution" : "Individual"} · <Mono>{v.vault}</Mono>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
