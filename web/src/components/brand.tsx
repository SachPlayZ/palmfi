"use client";

import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useAccount } from "wagmi";
import { addressUrl } from "@/lib/network";

/* ───────────── helpers ───────────── */

export const r2 = (n: number) => Math.round(n * 100) / 100;
export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));

/** Stable 32-bit hash (FNV-1a) so an org always gets the same card. */
export function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** window.location.origin after mount ("" during SSR and hydration, so markup matches). */
export function useOrigin() {
  const [o, setO] = useState("");
  useEffect(() => setO(window.location.origin), []);
  return o;
}

/** The current page URL after mount. */
export function useHref() {
  const [h, setH] = useState("");
  useEffect(() => setH(window.location.href), []);
  return h;
}

export const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ───────────── mark ───────────── */

export function Mark({ className = "" }: { className?: string }) {
  return (
    <svg className={`pf-mark ${className}`} viewBox="0 0 24 24" aria-hidden>
      {Array.from({ length: 12 }, (_, i) => (
        <rect key={i} x="11" y="1.5" width="2" height="9" rx="1" transform={`rotate(${i * 30} 12 12)`} />
      ))}
    </svg>
  );
}

/* ───────────── glyphs: bold line-stroke marks from the lane deck ───────────── */

export type GlyphKind = "sun" | "bars" | "ladder" | "swirl" | "rings" | "grid" | "wave" | "fan";
export const GLYPHS: GlyphKind[] = ["sun", "bars", "ladder", "swirl", "rings", "grid", "wave", "fan"];

export function Glyph({ kind, seed = 1, className = "", style }: { kind: GlyphKind; seed?: number; className?: string; style?: CSSProperties }) {
  const R = rng(seed);
  const lines: ReactNode[] = [];
  const L = (k: string | number, x1: number, y1: number, x2: number, y2: number, w: number) =>
    lines.push(<line key={k} x1={r2(x1)} y1={r2(y1)} x2={r2(x2)} y2={r2(y2)} strokeWidth={w} />);
  if (kind === "sun") {
    const n = 13 + Math.floor(R() * 6);
    for (let i = 0; i < n; i++) {
      const a = ((-82 + (i * 164) / (n - 1)) * Math.PI) / 180;
      L(i, 10 + Math.cos(a) * 16, 50 + Math.sin(a) * 16, 10 + Math.cos(a) * 46, 50 + Math.sin(a) * 46, 3.4);
    }
  } else if (kind === "bars") {
    for (let i = 0; i < 7; i++) {
      const l = 18 + R() * 56;
      L(`a${i}`, 4, 10 + i * 13, 4 + l, 10 + i * 13, 7.5);
      L(`b${i}`, 14 + l, 10 + i * 13, 96, 10 + i * 13, 7.5);
    }
  } else if (kind === "ladder") {
    for (let i = 0; i < 17; i++) {
      const y = 6 + i * 5.5;
      L(`l${i}`, 18, y, 44, y, 2.8);
      if (R() > 0.25) L(`r${i}`, 54, y, R() > 0.5 ? 82 : 70, y, 2.8);
    }
    L("v1", 18, 4, 18, 96, 2.8);
    L("v2", 54, 4, 54, 96, 2.8);
  } else if (kind === "swirl") {
    const start = 20 + R() * 40;
    for (let i = 0; i < 26; i++) {
      const a = ((start + i * 11) * Math.PI) / 180;
      L(i, 50 + Math.cos(a) * 22, 50 + Math.sin(a) * 22, 50 + Math.cos(a) * 42, 50 + Math.sin(a) * 42, 3);
    }
    for (let i = 0; i < 12; i++) {
      const a = ((start + 180 + i * 22) * Math.PI) / 180;
      L(`s${i}`, 50 + Math.cos(a) * 6, 50 + Math.sin(a) * 6, 50 + Math.cos(a) * 15, 50 + Math.sin(a) * 15, 2.6);
    }
  } else if (kind === "rings") {
    for (let r = 0; r < 5; r++) {
      const rad = 10 + r * 9;
      const seg = 14 + r * 4;
      for (let i = 0; i < seg; i++) {
        if (R() < 0.2) continue;
        const a0 = (i / seg) * Math.PI * 2;
        const a1 = a0 + (Math.PI * 2) / seg - 0.12;
        L(`${r}-${i}`, 50 + Math.cos(a0) * rad, 50 + Math.sin(a0) * rad, 50 + Math.cos(a1) * rad, 50 + Math.sin(a1) * rad, 4);
      }
    }
  } else if (kind === "grid") {
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const on = R() > 0.38;
        if (on) L(`${x}-${y}`, 8 + x * 12, 8 + y * 12, 8 + x * 12 + 7, 8 + y * 12, 7);
      }
  } else if (kind === "wave") {
    const ph = R() * 6;
    for (let i = 0; i < 9; i++) {
      const y = 12 + i * 9.5;
      for (let s = 0; s < 10; s++) {
        const x0 = 4 + s * 9.2;
        const x1 = x0 + 7;
        L(`${i}-${s}`, x0, y + Math.sin(s * 0.8 + i * 0.6 + ph) * 3, x1, y + Math.sin((s + 0.8) * 0.8 + i * 0.6 + ph) * 3, 3.6);
      }
    }
  } else {
    const n = 15;
    for (let i = 0; i < n; i++) {
      const a = ((200 + (i * 140) / (n - 1)) * Math.PI) / 180;
      L(i, 50, 92, 50 + Math.cos(a) * (40 + (i % 3) * 6), 92 + Math.sin(a) * (40 + (i % 3) * 6) * 1.05, 3.2);
    }
  }
  return (
    <svg viewBox="0 0 100 100" className={className} style={style} aria-hidden>
      {lines}
    </svg>
  );
}

/* ───────────── org identity ───────────── */

const PALETTES = [
  { bg: "#fbfaf4", fg: "#1f2a1e", gl: "#2f6b3a", paper: true },
  { bg: "#e9d95c", fg: "#1f2a1e", gl: "#1f2a1e", paper: false },
  { bg: "#1d3a2a", fg: "#e8f2c8", gl: "#cfe86a", paper: false },
  { bg: "#8dbd6b", fg: "#fbfdf3", gl: "#fbfdf3", paper: false },
];

export function orgIdentity(name: string) {
  const h = hash(name || "?");
  const p = PALETTES[h % PALETTES.length];
  return { ...p, kind: GLYPHS[(h >>> 3) % GLYPHS.length], seed: h };
}

/** A small card in the deck's colours, unique per org name. */
export function OrgCard({
  name,
  width = 56,
  tilt,
  showName = true,
  className = "",
}: {
  name: string;
  width?: number;
  tilt?: boolean;
  showName?: boolean;
  className?: string;
}) {
  const id = orgIdentity(name);
  return (
    <span
      className={`pf-org ${id.paper ? "paper" : ""} ${tilt ? "tilt" : ""} ${className}`}
      style={{ width, fontSize: width, "--bg": id.bg, "--fg": id.fg, "--gl": id.gl } as CSSProperties}
      aria-hidden
    >
      <Glyph kind={id.kind} seed={id.seed} />
      {showName && width >= 72 && <span className="nm">{name}</span>}
      <i className="pf-grain" />
    </span>
  );
}

/* ───────────── motion ───────────── */

/** Masked words that rise in sequence on mount. */
export function Words({ text, base = 0, step = 0.05 }: { text: string; base?: number; step?: number }) {
  return (
    <>
      {text.split(" ").map((w, i) => (
        <Fragment key={i}>
          <span className="pf-w">
            <span style={{ "--d": `${base + i * step}s` } as CSSProperties}>{w}</span>
          </span>{" "}
        </Fragment>
      ))}
    </>
  );
}

/** Reveals every [data-pf] under `root` as it scrolls in, including nodes added later (route changes, async data). */
export function useRevealAll(root: HTMLElement | null) {
  useEffect(() => {
    if (!root) return;
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }),
      { threshold: 0.08, rootMargin: "0px 0px -4% 0px" },
    );
    const scan = () => root.querySelectorAll("[data-pf]:not(.in)").forEach((el) => io.observe(el));
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, [root]);
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/* ───────────── layout pieces ───────────── */

export function PageHead({
  index,
  title,
  em,
  lede,
  actions,
  aside,
}: {
  index?: string;
  title: string;
  em?: string;
  lede?: ReactNode;
  actions?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="pf-pagehead">
      <div>
        {index && (
          <span className="pf-mono pf-dim" style={{ animation: "pf-fade .7s var(--ease) both" }}>
            {index}
          </span>
        )}
        <h1 className="pf-h1">
          <Words text={title} />
          {em && (
            <em>
              <Words text={em} base={title.split(" ").length * 0.05 + 0.05} />
            </em>
          )}
        </h1>
        {lede && (
          <p className="pf-lede" style={{ animation: "pf-fade .9s var(--ease) .25s both" }}>
            {lede}
          </p>
        )}
        {actions && (
          <div className="flex flex-wrap gap-2.5" style={{ animation: "pf-fade .9s var(--ease) .35s both" }}>
            {actions}
          </div>
        )}
      </div>
      {aside && <div style={{ animation: "pf-pop 1s var(--ease) .2s both" }}>{aside}</div>}
    </header>
  );
}

export function Section({ label, title, action, children, id }: { label?: string; title?: ReactNode; action?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="pf-section" data-pf id={id}>
      {(label || title || action) && (
        <header>
          <div className="flex flex-col gap-2">
            {label && <span className="pf-mono pf-dim">{label}</span>}
            {title && <h2 className="pf-h2">{title}</h2>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/* ───────────── small widgets ───────────── */

export function useCopy() {
  const [done, setDone] = useState(false);
  return {
    done,
    copy: async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      } catch {
        /* clipboard blocked: leave it */
      }
    },
  };
}

const CopyIcon = ({ ok }: { ok: boolean }) =>
  ok ? (
    <svg viewBox="0 0 16 16" aria-hidden>
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" aria-hidden>
      <rect x="5" y="5" width="8" height="8" rx="2" />
      <path d="M3 10V4a1 1 0 011-1h6" />
    </svg>
  );

export function AddressChip({ address, label, explorer = true }: { address?: string; label?: string; explorer?: boolean }) {
  const c = useCopy();
  if (!address) return <span className="pf-skel inline-block h-6 w-28" />;
  return (
    <span className="pf-addr" title={address}>
      <span className="truncate">{label ?? `${address.slice(0, 6)}…${address.slice(-4)}`}</span>
      <button type="button" onClick={() => c.copy(address)} aria-label="Copy address">
        <CopyIcon ok={c.done} />
      </button>
      {explorer && (
        <a href={addressUrl(address)} target="_blank" rel="noreferrer" aria-label="Open in Arcscan">
          <svg viewBox="0 0 16 16" aria-hidden>
            <path d="M6 3h7v7M13 3L5 11" />
          </svg>
        </a>
      )}
    </span>
  );
}

export function CopyButton({ text, label = "Copy link", className = "" }: { text: string; label?: string; className?: string }) {
  const c = useCopy();
  return (
    <button type="button" className={`pf-btn line ${className}`} onClick={() => c.copy(text)}>
      {c.done ? "Copied" : label}
    </button>
  );
}

export function Skeleton({ h = 18, w = "100%", className = "" }: { h?: number; w?: number | string; className?: string }) {
  return <span className={`pf-skel block ${className}`} style={{ height: h, width: w }} />;
}

export function EmptyState({
  glyph = "sun",
  title,
  body,
  action,
  seed = 7,
}: {
  glyph?: GlyphKind;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  seed?: number;
}) {
  return (
    <div className="flex flex-col items-center gap-4 px-4 py-12 text-center" style={{ animation: "pf-fade .8s var(--ease) both" }}>
      <Glyph kind={glyph} seed={seed} className="h-16 w-16" style={{ stroke: "var(--moss)", fill: "none" }} />
      <h3 className="pf-serif text-[28px] leading-none tracking-tight">{title}</h3>
      {body && <p className="max-w-[44ch] text-[15px] leading-relaxed text-[var(--subtle)]">{body}</p>}
      {action}
    </div>
  );
}

export function Steps({ n, active, frac = 1, onPick, labels }: { n: number; active: number; frac?: number; onPick?: (i: number) => void; labels?: string[] }) {
  return (
    <div className="pf-steps">
      <span className="pf-mono tabular">{String(active + 1).padStart(2, "0")}</span>
      <div className="pf-steps-bars">
        {Array.from({ length: n }, (_, i) => (
          <button
            key={i}
            type="button"
            className={i === active ? "on" : ""}
            onClick={() => onPick?.(i)}
            aria-label={labels?.[i] ?? `Step ${i + 1}`}
            aria-current={i === active}
            style={{ "--f": i < active ? 1 : i === active ? clamp(frac) : 0 } as CSSProperties}
          >
            <i />
          </button>
        ))}
      </div>
      <span className="pf-mono tabular pf-dim">{String(n).padStart(2, "0")}</span>
    </div>
  );
}

export function Ring({ value, size = 84, color, children }: { value: number; size?: number; color?: string; children?: ReactNode }) {
  const C = 2 * Math.PI * 44;
  return (
    <span className="relative inline-grid place-items-center" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="pf-ring absolute inset-0" style={{ "--c": color } as CSSProperties} aria-hidden>
        <circle className="bg" cx="50" cy="50" r="44" />
        <circle className="fg" cx="50" cy="50" r="44" strokeDasharray={C} strokeDashoffset={C * (1 - clamp(value))} />
      </svg>
      <span className="relative text-center">{children}</span>
    </span>
  );
}

export function Meter({ value, color, at }: { value: number; color?: string; at?: number }) {
  return (
    <div
      className="pf-meter"
      style={{ "--w": `${clamp(value) * 100}%`, "--c": color, "--at": at !== undefined ? `${clamp(at) * 100}%` : undefined } as CSSProperties}
    >
      <b />
      {at !== undefined && <em />}
    </div>
  );
}

/** Dots for a vote: filled = votes cast, ring = needed to pass. */
export function VoteDots({ have, need, total, tone }: { have: number; need: number; total: number; tone: "red" | "green" }) {
  const c = tone === "red" ? "var(--red)" : "var(--leaf)";
  return (
    <span className="inline-flex flex-wrap gap-1.5" aria-label={`${have} of ${need} needed`}>
      {Array.from({ length: Math.max(total, need) }, (_, i) => (
        <span
          key={i}
          className="h-3 w-3 rounded-full transition-all duration-500"
          style={{
            background: i < have ? c : "transparent",
            boxShadow: i < need ? `inset 0 0 0 1.5px ${c}` : "inset 0 0 0 1.5px var(--line)",
            transitionDelay: `${i * 40}ms`,
          }}
        />
      ))}
    </span>
  );
}

/** The footer hills image as a scene behind content. */
export function HillsBand({ children, className = "", style }: { children?: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`pf-hills ${className}`} style={style}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/landing/footer-hills.webp" alt="" />
      <i className="pf-grain" />
      <div className="relative z-[2]">{children}</div>
    </div>
  );
}

/** Asks for a wallet before showing wallet-only content. */
export function WalletGate({ children, title = "Connect a wallet", body }: { children: ReactNode; title?: string; body?: ReactNode }) {
  const { isConnected } = useAccount();
  if (isConnected) return <>{children}</>;
  return (
    <div className="pf-card flex flex-col items-center gap-5 py-14 text-center" style={{ animation: "pf-fade .8s var(--ease) both" }}>
      <span className="text-[40px] text-[var(--leaf)]">
        <Mark />
      </span>
      <h2 className="pf-h2">{title}</h2>
      <p className="max-w-[46ch] text-[15px] leading-relaxed text-[var(--subtle)]">
        {body ?? "palmfi reads which vaults your wallet votes in. Nothing is signed until you confirm an action."}
      </p>
      <ConnectButton />
    </div>
  );
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="pf-link">
      {children}
    </Link>
  );
}
