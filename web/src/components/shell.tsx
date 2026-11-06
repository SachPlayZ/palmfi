"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId } from "wagmi";
import type { ReactNode } from "react";
import { deployments, isDeployed } from "@/lib/deployments";
import { arcTestnet } from "@/lib/network";
import { Notice } from "./ui";

const links = [
  { href: "/vaults", label: "Vaults" },
  { href: "/onboard", label: "Onboard" },
  { href: "/pay", label: "Pay by name" },
];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { isConnected } = useAccount();
  const chainId = useChainId();
  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/vaults" className="text-xl font-semibold tracking-tight">
          palmfi
        </Link>
        <nav className="order-3 flex w-full flex-wrap gap-1 text-sm sm:order-none sm:w-auto">
          {links.map((l) => {
            const active = l.href === "/vaults" ? path.startsWith("/vault") : path.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-md px-2.5 py-1.5 ${active ? "bg-[var(--muted)] font-medium" : "text-[var(--subtle)] hover:text-[var(--foreground)]"}`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <ConnectButton showBalance={false} chainStatus="icon" accountStatus="address" />
      </header>
      {!isDeployed(deployments) && <NotDeployed />}
      {isConnected && chainId !== arcTestnet.id && (
        <Notice tone="amber">Your wallet is on another network. palmfi runs on Arc testnet; transactions will ask to switch.</Notice>
      )}
      <main className="flex flex-col gap-5">{children}</main>
      <footer className="mt-auto pt-8 text-xs text-[var(--subtle)]">
        Live on Arc testnet (USDC gas). Your keys can be stolen; your money can&apos;t leave faster than you can say no.
      </footer>
    </div>
  );
}

export function NotDeployed() {
  return (
    <Notice tone="amber">
      <strong>Not deployed yet.</strong> No palmfi contract addresses are configured. Run the deploy script so
      deployments/arc.json exists, then <code>pnpm sync:deployments</code>.
    </Notice>
  );
}
