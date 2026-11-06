"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseAbiItem, type Address } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { vaultAbi } from "@/abi";
import { Button, Card, Input, Mono } from "@/components/ui";
import { deployments } from "@/lib/deployments";
import { arcTestnet } from "@/lib/network";

const registered = parseAbiItem("event VaultRegistered(address indexed vault, string name, address token)");

/** Vaults where the connected account is a wallet: Hub VaultRegistered logs, then isWallet per Vault. */
function useMyVaults(me: Address | undefined) {
  const client = usePublicClient({ chainId: arcTestnet.id });
  return useQuery({
    queryKey: ["myVaults", me, deployments.hub],
    enabled: !!me && !!deployments.hub && !!client,
    queryFn: async () => {
      const latest = await client!.getBlockNumber();
      const all: { vault: Address; name: string }[] = [];
      const step = 40_000n;
      for (let from = deployments.fromBlock; from <= latest; from += step) {
        const to = from + step - 1n > latest ? latest : from + step - 1n;
        const logs = await client!.getLogs({ address: deployments.hub, event: registered, fromBlock: from, toBlock: to });
        for (const l of logs) all.push({ vault: l.args.vault!, name: l.args.name! });
      }
      const mine = await client!.multicall({
        allowFailure: true,
        contracts: all.map((v) => ({ address: v.vault, abi: vaultAbi, functionName: "isWallet", args: [me!] }) as const),
      });
      return all.filter((_, i) => mine[i]?.result === true).reverse();
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
        <h1 className="text-3xl font-semibold tracking-tight">Your keys can be stolen. Your treasury can&apos;t leave faster than your team can say no.</h1>
        <p className="max-w-2xl text-[var(--subtle)]">
          A palmfi Vault holds your org&apos;s USDC on Arc behind its own Protected token. Small payments go out instantly within the Instant budget.
          Anything larger waits: Chainlink CRE scores how unusual it is and sets the delay, and any majority of your wallets can veto or fast-track it.
          Orgs pay each other by name through one Orbital pool on Uniswap v4.
        </p>
        <div className="mt-2 flex gap-2">
          <Link href="/onboard">
            <Button>Create a Vault</Button>
          </Link>
          <Link href="/pay">
            <Button variant="secondary">Pay by name</Button>
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
          <Input placeholder="nvidia or 0x…" value={q} onChange={(e) => setQ(e.target.value)} className="flex-1" aria-label="Vault name or address" />
          <Button type="submit">Open</Button>
        </form>
      </Card>

      {address && (
        <Card title="Your Vaults">
          {!deployments.hub && <p className="text-sm text-[var(--subtle)]">Not deployed yet.</p>}
          {mine.isLoading && <p className="text-sm text-[var(--subtle)]">Scanning the Hub…</p>}
          {mine.error && <p className="text-sm text-red-600">Couldn&apos;t scan logs: open your Vault by name above.</p>}
          {mine.data?.length === 0 && <p className="text-sm text-[var(--subtle)]">This account isn&apos;t a wallet of any Vault yet.</p>}
          <ul className="flex flex-col gap-2">
            {mine.data?.map((v) => (
              <li key={v.vault}>
                <Link href={`/vault/${v.name}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] p-3 hover:bg-[var(--muted)]">
                  <span className="font-medium">{v.name}</span>
                  <Mono>{v.vault}</Mono>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
