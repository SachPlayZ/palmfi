"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { deployments, isDeployed } from "@/lib/deployments";
import { useMyVaults, useOpenRequests } from "@/lib/hub";
import { arcTestnet } from "@/lib/network";
import { REQ } from "@/lib/palm";
import { Mark, useRevealAll } from "./brand";
import { Notice } from "./ui";

const BASE_LINKS: { href: string; label: string; inbox?: boolean; match?: string[] }[] = [
  { href: "/vaults", label: "Dashboard", match: ["/vaults", "/vault/"] },
  { href: "/inbox", label: "Inbox", inbox: true },
  { href: "/directory", label: "Directory", match: ["/directory", "/o/"] },
];

const MORE = [
  { href: "/onboard", label: "Create a vault" },
  { href: "/pay", label: "Pay by name" },
  { href: "/pool", label: "Orbital pool" },
  { href: "/status", label: "Network status" },
  { href: "/request/new", label: "Request a payment" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/faq", label: "FAQ" },
  { href: "/blocklist", label: "Blocklist" },
  { href: "/verify", label: "Get verified" },
  { href: "/security", label: "Security" },
  { href: "/developers", label: "Developers" },
  { href: "/settings", label: "Notifications" },
];

/** Open requests waiting in the connected wallet's vaults. */
export function useInboxCount() {
  const { address } = useAccount();
  const my = useMyVaults(address);
  const open = useOpenRequests();
  return useMemo(() => {
    const set = new Set(my.mine.map((m) => m.vault.toLowerCase()));
    return (open.data ?? []).filter((r) => r.state === REQ.PENDING && set.has(r.vault.toLowerCase())).length;
  }, [my.mine, open.data]);
}

export function Shell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const path = usePathname();
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const count = useInboxCount();
  const { address } = useAccount();
  const my = useMyVaults(address);
  const home = my.mine.length === 1 ? `/vault/${my.mine[0].name ?? my.mine[0].vault}` : "/vaults";
  const LINKS = BASE_LINKS.map((l) => (l.label === "Dashboard" ? { ...l, href: home } : l));
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [main, setMain] = useState<HTMLElement | null>(null);
  useRevealAll(main);

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  const active = (l: (typeof LINKS)[number]) => (l.match ?? [l.href]).some((m) => path === m || path.startsWith(m.endsWith("/") ? m : `${m}/`) || path === m);

  return (
    <div className="pf-app">
      <header className={`pf-nav ${scrolled ? "scrolled" : ""}`}>
        <Link href="/" className="pf-logo" aria-label="palmfi home">
          <Mark />
          <span>palmfi</span>
        </Link>
        <nav className="pf-navlinks" aria-label="App">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={active(l) ? "on" : ""} aria-current={active(l) ? "page" : undefined}>
              {l.label}
              {l.inbox && count > 0 && <span className="n">{count}</span>}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <ConnectButton showBalance={false} chainStatus="icon" accountStatus={{ smallScreen: "avatar", largeScreen: "address" }} />
          <button className="pf-burger" onClick={() => setOpen((o) => !o)} aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open}>
            <svg viewBox="0 0 16 16" aria-hidden>
              {open ? <path d="M4 4l8 8M12 4l-8 8" /> : <path d="M3 6h10M3 10h10" />}
            </svg>
          </button>
        </div>
      </header>

      <div className={`pf-drawer ${open ? "open" : ""}`} aria-hidden={!open}>
        {[...LINKS, ...MORE].map((l, i) => (
          <Link key={l.href} href={l.href} style={{ "--i": i } as CSSProperties} tabIndex={open ? 0 : -1}>
            {l.label}
            {l.href === "/inbox" && count > 0 && <sup className="ml-2 font-mono text-sm text-[var(--red)]">{count}</sup>}
          </Link>
        ))}
      </div>

      {(!isDeployed(deployments) || (isConnected && chainId !== arcTestnet.id)) && (
        <div className="pf-banner mt-3 flex flex-col gap-2">
          {!isDeployed(deployments) && <NotDeployed />}
          {isConnected && chainId !== arcTestnet.id && (
            <Notice tone="amber">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>Your wallet is on another network. palmfi runs on Arc testnet.</span>
                <button className="pf-btn sm dark" onClick={() => switchChain({ chainId: arcTestnet.id })}>
                  Switch to Arc
                </button>
              </div>
            </Notice>
          )}
        </div>
      )}

      <main ref={setMain} className={`pf-main ${wide ? "wide" : ""}`}>
        {children}
      </main>

      <footer className="pf-foot">
        <div className="pf-foot-bg" aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/landing/footer-hills.webp" alt="" loading="lazy" />
        </div>
        <div className="pf-foot-in">
          <div className="flex flex-col gap-2">
            <Link href="/" className="pf-logo">
              <Mark />
              <span>palmfi</span>
            </Link>
            <span className="pf-dim">Protected USDC vaults on Arc testnet.</span>
          </div>
          <nav aria-label="More">
            {MORE.map((l) => (
              <Link key={l.href} href={l.href}>
                {l.label}
              </Link>
            ))}
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/risk">Risk</Link>
          </nav>
        </div>
      </footer>
      <div className="pf-paper" aria-hidden />
    </div>
  );
}

export function NotDeployed() {
  return (
    <Notice tone="amber">
      <strong>Not deployed yet.</strong> No palmfi contract addresses are configured. Run the deploy script so deployments/arc.json exists, then{" "}
      <code>pnpm sync:deployments</code>.
    </Notice>
  );
}
