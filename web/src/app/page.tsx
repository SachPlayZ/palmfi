"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId } from "wagmi";
import { network } from "@/lib/network";

export default function Home() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 px-4 py-16">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">palmfi</h1>
        <ConnectButton />
      </header>
      <p className="text-lg">Your keys can be stolen. Your money can&apos;t leave faster than you can say no.</p>
      <section className="rounded-lg border p-4 text-sm">
        <p>Network: Ethereum Sepolia ({network.chainId})</p>
        <p>Names: *.{network.ensParent}</p>
        {isConnected && (
          <p>
            Connected: {address} {chainId === network.chainId ? "✓ Sepolia" : "— switch to Sepolia"}
          </p>
        )}
      </section>
    </main>
  );
}
