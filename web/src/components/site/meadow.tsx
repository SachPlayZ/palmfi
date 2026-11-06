"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

/* ───────────────────────── helpers ───────────────────────── */

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const r2 = (n: number) => Math.round(n * 100) / 100;
const ease = (t: number) => 1 - Math.pow(1 - clamp(t), 3);
const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Writes scroll progress to `--p`. sticky: 0..1 while pinned. view: 0..1 from entering to leaving. */
function useProgress(ref: RefObject<HTMLElement | null>, mode: "sticky" | "view" = "view", cb?: (p: number) => void) {
  const fn = useRef(cb);
  fn.current = cb;
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const p = clamp(mode === "sticky" ? -r.top / Math.max(1, r.height - vh) : (vh - r.top) / (r.height + vh));
      el.style.setProperty("--p", p.toFixed(4));
      fn.current?.(p);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
    };
  }, [ref, mode]);
}

/** Adds `.in` to every [data-r] once it scrolls into view. */
function useReveals() {
  useEffect(() => {
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }),
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
    );
    document.querySelectorAll("[data-r]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

function useInView<T extends Element>(ref: RefObject<T | null>, threshold = 0.3) {
  const [v, setV] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (setV(true), io.disconnect()), { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, threshold]);
  return v;
}

/** Masked words that rise in sequence once an ancestor [data-r] gets `.in`. */
function Words({ text, base = 0, step = 0.05 }: { text: string; base?: number; step?: number }) {
  return (
    <>
      {text.split(" ").map((w, i) => (
        <Fragment key={i}>
          <span className="m-w">
            <span style={{ "--d": `${base + i * step}s` } as CSSProperties}>{w}</span>
          </span>{" "}
        </Fragment>
      ))}
    </>
  );
}

function Counter({ to, prefix = "", suffix = "", decimals = 0, dur = 1600 }: { to: number; prefix?: string; suffix?: string; decimals?: number; dur?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useInView(ref, 0.5);
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!seen) return;
    if (reduced()) return setV(to);
    let raf = 0;
    const t0 = performance.now();
    const f = (t: number) => {
      const k = clamp((t - t0) / dur);
      setV(to * (1 - Math.pow(1 - k, 4)));
      if (k < 1) raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [seen, to, dur]);
  return (
    <span ref={ref} className="tabular">
      {prefix}
      {v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      {suffix}
    </span>
  );
}

/** Segmented lane progress: one bar per step, the active bar fills with scroll. */
function Steps({ n, active, frac = 1, onPick, labels }: { n: number; active: number; frac?: number; onPick?: (i: number) => void; labels?: string[] }) {
  return (
    <div className="m-steps">
      <span className="mono tabular">{String(active + 1).padStart(2, "0")}</span>
      <div className="m-steps-bars">
        {Array.from({ length: n }, (_, i) => (
          <button
            key={i}
            className={i < active ? "done" : i === active ? "on" : ""}
            onClick={() => onPick?.(i)}
            aria-label={labels?.[i] ?? `Step ${i + 1}`}
            aria-current={i === active}
            style={{ "--f": i === active ? clamp(frac).toFixed(3) : i < active ? 1 : 0 } as CSSProperties}
          >
            <i />
          </button>
        ))}
      </div>
      <span className="mono tabular dim">{String(n).padStart(2, "0")}</span>
    </div>
  );
}

function scrollToStep(el: HTMLElement | null, i: number, n: number) {
  if (!el) return;
  const span = el.offsetHeight - window.innerHeight;
  window.scrollTo({ top: el.offsetTop + span * ((i + 0.5) / n), behavior: reduced() ? "auto" : "smooth" });
}

/* ───────────────────────── hills: grainy rolling meadow ───────────────────────── */

const LAYERS = [
  { y: 0.42, a: 0.09, f: 1.1, c: ["#e3ecd0", "#b5d28e", "#f2e08f"] },
  { y: 0.52, a: 0.1, f: 1.6, c: ["#9cc574", "#6aa24c", "#d7d76c"] },
  { y: 0.63, a: 0.08, f: 0.9, c: ["#e9d95c", "#86b058", "#3f7d3a"] },
  { y: 0.74, a: 0.07, f: 1.9, c: ["#e8c24a", "#efe07a", "#78a64d"] },
  { y: 0.86, a: 0.06, f: 1.3, c: ["#2f6b3a", "#e3cf52", "#d9a83c"] },
];

function Hills({ className, speed = 1, sky = ["#ffffff", "#fbf9ef", "#f4ecc0"] }: { className?: string; speed?: number; sky?: [string, string, string] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const W = 240;
    const H = 130;
    c.width = W;
    c.height = H;
    const still = reduced();
    let raf = 0;
    let vis = true;
    const draw = (t: number) => {
      raf = 0;
      const time = (t / 1000) * speed;
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, sky[0]);
      g.addColorStop(0.45, sky[1]);
      g.addColorStop(1, sky[2]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      LAYERS.forEach((L, i) => {
        ctx.beginPath();
        ctx.moveTo(0, H);
        const dir = i % 2 ? 1 : -1;
        for (let x = 0; x <= W; x += 3) {
          const u = x / W;
          const y =
            H *
            (L.y +
              L.a *
                (Math.sin(u * L.f * 6.283 + time * 0.12 * dir + i * 1.7) * 0.6 +
                  Math.sin(u * L.f * 13.1 - time * 0.07 + i * 2.3) * 0.3 +
                  Math.sin(u * 3.1 + time * 0.05 * dir) * 0.25));
          ctx.lineTo(x, y);
        }
        ctx.lineTo(W, H);
        ctx.closePath();
        const s = (Math.sin(time * 0.08 + i) + 1) * 0.12;
        const gg = ctx.createLinearGradient(0, 0, W, H * 0.4);
        gg.addColorStop(0, L.c[0]);
        gg.addColorStop(0.45 + s, L.c[1]);
        gg.addColorStop(1, L.c[2]);
        ctx.fillStyle = gg;
        ctx.fill();
      });
      if (!still && vis) raf = requestAnimationFrame(draw);
    };
    const io = new IntersectionObserver(([e]) => {
      vis = e.isIntersecting;
      if (vis && !raf) raf = requestAnimationFrame(draw);
    });
    io.observe(c);
    raf = requestAnimationFrame(draw);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [speed, sky]);
  return <canvas ref={ref} className={`m-hills ${className ?? ""}`} aria-hidden />;
}

/* ───────────────────────── nav ───────────────────────── */

function Nav() {
  const [state, setState] = useState({ solid: false, hide: false });
  useEffect(() => {
    let last = window.scrollY;
    const on = () => {
      const y = window.scrollY;
      setState({ solid: y > 24, hide: y > 500 && y > last });
      last = y;
      document.documentElement.style.setProperty("--doc-p", (y / Math.max(1, document.body.scrollHeight - innerHeight)).toFixed(4));
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <header className={`m-nav ${state.solid ? "solid" : ""} ${state.hide ? "hide" : ""}`}>
      <div className="m-progress" />
      <Link href="/" className="m-logo" aria-label="palmfi home">
        <Mark />
        <span>palmfi</span>
      </Link>
      <nav className="m-links">
        <a href="#lanes">Lanes</a>
        <a href="#try">Try it</a>
        <a href="#sentinel">Sentinel</a>
        <a href="#network">Network</a>
        <a href="#pieces">Protocol</a>
      </nav>
      <Link href="/onboard" className="m-pill">
        Open a vault
      </Link>
    </header>
  );
}

function Mark() {
  return (
    <svg className="m-mark" viewBox="0 0 24 24" aria-hidden>
      {Array.from({ length: 12 }, (_, i) => (
        <rect key={i} x="11" y="1.5" width="2" height="9" rx="1" transform={`rotate(${i * 30} 12 12)`} />
      ))}
    </svg>
  );
}

/* ───────────────────────── hero: the flow, the gate, the lanes ───────────────────────── */

const NL = 18;
const GATE = 500;
const ly = (i: number) => r2(70 + i * (360 / (NL - 1)));
const LANE_OF = (i: number) => (i < 4 ? 0 : i < 11 ? 1 : i < 14 ? 2 : 3);
const LANE_COL = ["#3f7d3a", "#cdb935", "#1d3a2a", "#8dbd6b"];
const LANE_LBL = [
  { t: "INSTANT · $500 / 24H", x: 960, y: 92, a: "end" },
  { t: "QUEUED · SENTINEL SCORES IT", x: 770, y: 318, a: "middle" },
  { t: "PASSKEY ABOVE $5K", x: 762, y: 382, a: "middle" },
  { t: "RECOVERY VAULT · FIXED AT ONBOARDING", x: 960, y: 470, a: "end" },
] as const;

function lanePath(i: number) {
  const y = ly(i);
  const lane = LANE_OF(i);
  if (lane === 0) {
    const t = 110 + i * 5;
    return `M${GATE},${y} C${GATE + 120},${y} ${GATE + 120},${t} ${GATE + 260},${t} L960,${t}`;
  }
  if (lane === 1) {
    const r = 16 + (i - 4) * 5;
    return `M${GATE},${y} C${GATE + 100},${y} ${GATE + 130},238 ${770 - r},238 a${r},${r} 0 1 0 ${2 * r},0 a${r},${r} 0 1 0 ${-2 * r},0`;
  }
  if (lane === 2) return `M${GATE},${y} C${GATE + 120},${y} ${GATE + 150},356 748,356`;
  const t = 412 + (i - 14) * 9;
  return `M${GATE},${y} C${GATE + 140},${y} ${GATE + 170},${t} 860,${t}`;
}

const CAPS = [
  { k: "The drain", t: "One valid signature. One transaction. $2.5B gone." },
  { k: "The gate", t: "A palmfi vault puts a gate where a signature can't reach." },
  { k: "The lanes", t: "Past the gate, every payment takes a lane." },
  { k: "The brake", t: "A stolen key still works. It moves $500 today. The rest waits." },
];

function Hero() {
  const ref = useRef<HTMLElement>(null);
  const [p, setP] = useState(0);
  useProgress(ref, "sticky", setP);
  const stage = Math.min(3, Math.floor(p * 4));
  const drainOff = p < 0.26 ? 1 - ease((p - 0.02) / 0.16) : -ease((p - 0.26) / 0.14);
  const gate = ease((p - 0.25) / 0.12);
  const labels = clamp((p - 0.7) / 0.08);
  return (
    <section className="m-hero" ref={ref}>
      <div className="m-hero-pin">
        <svg className={`m-flow ${p > 0.72 ? "live" : ""}`} viewBox="0 0 1000 500" aria-label="Funds flowing from a signature, stopped by a gate and split into lanes">
          <g className="m-flow-a">
            {Array.from({ length: NL }, (_, i) => (
              <path key={i} d={`M110,250 C260,250 300,${ly(i)} ${GATE},${ly(i)}`} pathLength={1} style={{ "--d": `${i * 0.03}s` } as CSSProperties} />
            ))}
          </g>
          <g className="m-flow-b">
            {Array.from({ length: NL }, (_, i) => (
              <path key={i} d={`M${GATE},${ly(i)} L960,${ly(i)}`} pathLength={1} style={{ strokeDashoffset: drainOff }} />
            ))}
          </g>
          <text className="m-flow-note" x="960" y="40" textAnchor="end" style={{ opacity: clamp((p - 0.1) * 8) * (1 - clamp((p - 0.3) * 8)) }}>
            $2.5B · ONE TRANSACTION · NO WAY TO SAY NO
          </text>
          <g className="m-flow-lanes">
            {Array.from({ length: NL }, (_, i) => {
              const lane = LANE_OF(i);
              const k = ease((p - 0.44 - lane * 0.04) / 0.16);
              return (
                <path key={i} d={lanePath(i)} pathLength={1} className={`lane-${lane}`} style={{ stroke: LANE_COL[lane], strokeDashoffset: 1 - k }} />
              );
            })}
          </g>
          <g className="m-flow-pulse">
            {Array.from({ length: 4 }, (_, i) => (
              <path key={i} d={lanePath(i)} pathLength={1} style={{ "--d": `${i * -0.35}s` } as CSSProperties} />
            ))}
          </g>
          <rect className="m-flow-gate" x={GATE - 3} y={r2(250 - 205 * gate)} width="6" height={r2(410 * gate)} rx="3" />
          <g style={{ opacity: clamp((p - 0.56) * 6) }}>
            <rect className="m-flow-key" x="748" y="346" width="20" height="20" rx="5" />
            <rect className="m-flow-box" x="860" y="398" width="100" height="56" rx="8" />
          </g>
          <g className="m-flow-lbl" style={{ opacity: labels }}>
            {LANE_LBL.map((l) => (
              <text key={l.t} x={l.x} y={l.y} textAnchor={l.a}>
                {l.t}
              </text>
            ))}
            <text x={GATE} y="34" textAnchor="middle">
              THE VAULT
            </text>
          </g>
          <circle className="m-flow-src" cx="110" cy="250" r="7" />
          <path className="m-flow-sig" d="M62,226 c6,-14 12,-14 10,0 s-6,16 4,4 s8,-14 12,-6 s2,8 8,0 s6,-6 10,-2" />
          <text className="m-flow-lbl static" x="110" y="282" textAnchor="middle">
            A VALID SIGNATURE
          </text>
        </svg>
        <div className="m-hero-foot">
          <div className="m-hero-cap" key={stage}>
            <span className="mono dim">{CAPS[stage].k}</span>
            <p className="serif">{CAPS[stage].t}</p>
          </div>
          <Steps n={4} active={stage} frac={p * 4 - stage} labels={CAPS.map((c) => c.k)} onPick={(i) => scrollToStep(ref.current, i, 4)} />
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── statement ───────────────────────── */

function Statement() {
  return (
    <section className="m-state">
      <div data-r>
        <span className="mono dim">(000) palmfi — protected vaults on Ethereum</span>
        <h1 className="m-h1 serif">
          <Words text="Your keys can be stolen." />
          <em>
            <Words text="Your money can't leave" base={0.25} />
          </em>{" "}
          <Words text="faster than you can say no." base={0.5} />
        </h1>
      </div>
      <div className="m-state-row" data-r style={{ "--d": "0.5s" } as CSSProperties}>
        <p>Deposit USDC or ETH, receive your own protected token, and know that a stolen key or a hijacked signing system can only move what you&rsquo;d tolerate losing on a bad day.</p>
        <div className="m-ctas">
          <Link href="/onboard" className="m-btn dark">
            <Mark /> Open a vault
          </Link>
          <a href="#try" className="m-btn">
            Try a payout
          </a>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── logo strip ───────────────────────── */

const BUILT = ["Chainlink CRE", "Uniswap v4", "ENS", "Ethereum", "Circle USDC", "Passkeys · P-256", "Data Feeds", "EIP-7951"];

function Strip() {
  return (
    <div className="m-strip" aria-label="Built with">
      <div className="m-strip-track">
        {[...BUILT, ...BUILT].map((b, i) => (
          <span key={i} className={i % 3 === 1 ? "serif" : i % 3 === 2 ? "mono" : ""}>
            {b}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── facts ───────────────────────── */

function Facts() {
  return (
    <section className="m-facts">
      <div className="m-sec-head" data-r>
        <span className="mono">(001) 29 October 2026</span>
        <p className="m-lede">
          Attackers never stole Binance&rsquo;s keys. They got its signing system to sign for them. The threat to design for is <em className="serif">&ldquo;the attacker can produce valid signatures.&rdquo;</em>
        </p>
      </div>
      <div className="m-facts-row">
        {[
          { v: <Counter to={6.3} prefix="$" suffix="B" decimals={1} />, l: "left hot wallets in under an hour" },
          { v: <Counter to={50} />, l: "pre-signed EIP-7702 authorizations in one transaction" },
          { v: <Counter to={20} suffix=" min" />, l: "to swap $325M into ETH, ahead of any freeze" },
        ].map((f, i) => (
          <div key={i} className="m-fact" data-r style={{ "--d": `${i * 0.12}s` } as CSSProperties}>
            <i className="m-rule" />
            <b className="serif">{f.v}</b>
            <span className="mono">{f.l}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ───────────────────────── inline-clip sentence ───────────────────────── */

function Sentence() {
  const ref = useRef<HTMLElement>(null);
  useProgress(ref, "view");
  return (
    <section className="m-sentence" ref={ref}>
      <p className="m-sent-line">
        <span>Wrapped assets</span>
        <span className="m-clip">
          <Hills className="m-clip-fill" speed={3} />
          <i className="m-grain" />
        </span>
        <span>with brakes.</span>
      </p>
    </section>
  );
}

/* ───────────────────────── card deck: lanes ───────────────────────── */

type Glyph = "sun" | "bars" | "ladder" | "swirl";

function GlyphArt({ g }: { g: Glyph }) {
  let lines: ReactNode[] = [];
  if (g === "sun") {
    lines = Array.from({ length: 17 }, (_, i) => {
      const a = ((-80 + i * 10) * Math.PI) / 180;
      return <line key={i} x1={r2(10 + Math.cos(a) * 16)} y1={r2(50 + Math.sin(a) * 16)} x2={r2(10 + Math.cos(a) * 46)} y2={r2(50 + Math.sin(a) * 46)} strokeWidth="3.4" />;
    });
  } else if (g === "bars") {
    const L = [52, 30, 64, 22, 46, 72, 36];
    lines = L.flatMap((l, i) => [
      <line key={`a${i}`} x1="4" x2={4 + l} y1={10 + i * 13} y2={10 + i * 13} strokeWidth="7.5" />,
      <line key={`b${i}`} x1={14 + l} x2="96" y1={10 + i * 13} y2={10 + i * 13} strokeWidth="7.5" />,
    ]);
  } else if (g === "ladder") {
    const R = rng(5);
    lines = Array.from({ length: 17 }, (_, i) => {
      const y = 6 + i * 5.5;
      const out: ReactNode[] = [<line key={`l${i}`} x1="18" x2="44" y1={y} y2={y} strokeWidth="2.8" />];
      if (R() > 0.25) out.push(<line key={`r${i}`} x1="54" x2={R() > 0.5 ? "82" : "70"} y1={y} y2={y} strokeWidth="2.8" />);
      return out;
    }).flat();
    lines.push(<line key="v1" x1="18" x2="18" y1="4" y2="96" strokeWidth="2.8" />, <line key="v2" x1="54" x2="54" y1="4" y2="96" strokeWidth="2.8" />);
  } else {
    lines = Array.from({ length: 26 }, (_, i) => {
      const a = ((40 + i * 11) * Math.PI) / 180;
      return <line key={i} x1={r2(50 + Math.cos(a) * 22)} y1={r2(50 + Math.sin(a) * 22)} x2={r2(50 + Math.cos(a) * 42)} y2={r2(50 + Math.sin(a) * 42)} strokeWidth="3" />;
    }).concat(
      Array.from({ length: 12 }, (_, i) => {
        const a = ((200 + i * 22) * Math.PI) / 180;
        return <line key={`s${i}`} x1={r2(50 + Math.cos(a) * 6)} y1={r2(50 + Math.sin(a) * 6)} x2={r2(50 + Math.cos(a) * 15)} y2={r2(50 + Math.sin(a) * 15)} strokeWidth="2.6" />;
      }),
    );
  }
  return (
    <svg viewBox="0 0 100 100" className="m-glyph" aria-hidden>
      {lines}
    </svg>
  );
}

const DECK: {
  k: string;
  g: Glyph;
  bg: string;
  fg: string;
  ink: string;
  card: string;
  title: string;
  body: string;
  meta: string;
}[] = [
  {
    k: "Instant lane",
    g: "sun",
    bg: "#fbfaf4",
    fg: "#1f2a1e",
    ink: "#2f6b3a",
    card: "Pay any allowed address within your rolling 24h and 7d budgets. No CRE in the path.",
    title: "Small spending, no one in the way.",
    body: "Everyday payments go straight out, measured in USD with Chainlink Data Feeds and shared across USDC and WETH. They keep working even if Chainlink is down.",
    meta: "$500 / 24h · $2,000 / 7d",
  },
  {
    k: "Queued lane",
    g: "bars",
    bg: "#e9d95c",
    fg: "#1f2a1e",
    ink: "#1f2a1e",
    card: "Above budget, a request waits for the Sentinel. CLEAR shortens the wait, never to zero.",
    title: "Big payouts wait for a second look.",
    body: "The Sentinel scores every queued request CLEAR, HOLD or FLAG. A CLEAR only shortens the delay to a 15-minute floor. A FLAG freezes the vault on the spot.",
    meta: "floor 15 min · full delay 24h",
  },
  {
    k: "Second factor",
    g: "ladder",
    bg: "#1d3a2a",
    fg: "#e8f2c8",
    ink: "#cfe86a",
    card: "Above the hard cap, a phone passkey or an approver key must sign too. Verified onchain.",
    title: "A key your laptop doesn't hold.",
    body: "Individuals confirm with a phone passkey checked by the P-256 precompile. Institutions confirm with approver keys kept apart from their hot wallets, so one compromise can't own both.",
    meta: "EIP-7951 · P256VERIFY at 0x100",
  },
  {
    k: "Recovery",
    g: "swirl",
    bg: "#8dbd6b",
    fg: "#fbfdf3",
    ink: "#fbfdf3",
    card: "One cold key can migrate everything to the recovery vault fixed at onboarding.",
    title: "Rescue goes to one place, set in advance.",
    body: "No one can redirect funds mid-incident, not even voters. The factory deploys a fresh vault and re-points your ENS name. Changing the recovery address itself takes seven days.",
    meta: "recovery change · 7-day timelock",
  },
];

function Deck() {
  const ref = useRef<HTMLElement>(null);
  const [i, setI] = useState(0);
  const [frac, setFrac] = useState(0);
  const N = DECK.length;
  useProgress(ref, "sticky", (p) => {
    const f = p * N * 0.999;
    const k = Math.min(N - 1, Math.floor(f));
    setI(k);
    setFrac(f - k);
  });
  const tilt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--rx", `${((e.clientY - r.top) / r.height - 0.5) * -8}deg`);
    e.currentTarget.style.setProperty("--ry", `${((e.clientX - r.left) / r.width - 0.5) * 10}deg`);
  };
  const untilt = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.style.setProperty("--rx", "0deg");
    e.currentTarget.style.setProperty("--ry", "0deg");
  };
  return (
    <section className="m-deck-sec" id="lanes" ref={ref}>
      <div className="m-deck-pin">
        <div className="m-deck-head">
          <span className="mono">(002) How a vault spends</span>
          <span className="mono dim tabular">
            0{i + 1} / 0{N}
          </span>
        </div>
        <div className="m-deck-stage">
          <div className="m-deck">
            {DECK.map((c, j) => {
              const depth = (j - i + N) % N;
              const style: CSSProperties =
                depth === 0
                  ? { transform: "translate3d(62%, -3%, 0) rotate(5deg)", zIndex: 10 }
                  : { transform: `translate3d(${-(depth - 1) * 11}%, ${(depth - 1) * 2.5}%, 0) rotate(${-4 - (depth - 1) * 7}deg)`, zIndex: 10 - depth };
              return (
                <div
                  key={c.k}
                  className={`m-card ${depth === 0 ? "front" : ""}`}
                  style={{ ...style, "--bg": c.bg, "--fg": c.fg, "--ink": c.ink } as CSSProperties}
                  onPointerMove={depth === 0 ? tilt : undefined}
                  onPointerLeave={untilt}
                  onClick={() => scrollToStep(ref.current, j, N)}
                >
                  <div className="m-card-in">
                    <GlyphArt g={c.g} />
                    <div className="m-card-txt">
                      <b>{c.k}</b>
                      <span>{c.card}</span>
                    </div>
                    <i className="m-grain" />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="m-deck-text">
            {DECK.map((c, j) => (
              <div key={c.k} className={`m-dt ${j === i ? "on" : j < i ? "past" : "next"}`} aria-hidden={j !== i}>
                <span className="mono dim">{c.k}</span>
                <h3 className="serif">{c.title}</h3>
                <p>{c.body}</p>
                <span className="mono">{c.meta}</span>
              </div>
            ))}
          </div>
        </div>
        <Steps n={N} active={i} frac={frac} labels={DECK.map((c) => c.k)} onPick={(j) => scrollToStep(ref.current, j, N)} />
      </div>
    </section>
  );
}

/* ───────────────────────── try a payout ───────────────────────── */

const BUDGET = 500;
const CAP = 5000;
const STEPS = ["Signed", "Budget", "Sentinel", "Funds"];

function Try() {
  const [amt, setAmt] = useState(320);
  const [attack, setAttack] = useState(false);
  const [passkey, setPasskey] = useState(true);
  const lane = attack ? "flag" : amt <= BUDGET ? "instant" : amt <= CAP ? "queued" : "cap";
  const out = {
    instant: { v: "PAID", t: "now", note: "Inside your instant budget. No one is asked, nothing waits.", reach: 4, skip: [2] },
    queued: { v: "CLEAR", t: "15 min", note: "Queued. The Sentinel scores it CLEAR, and the 15-minute floor runs out.", reach: 4, skip: [] as number[] },
    cap: passkey
      ? { v: "CLEAR + PASSKEY", t: "15 min", note: "Above the $5,000 hard cap. Your phone passkey co-signed, so the floor applies.", reach: 4, skip: [] as number[] }
      : { v: "CLEAR, NO PASSKEY", t: "24 h", note: "Above the hard cap with no second factor: the full 24-hour delay applies.", reach: 4, skip: [] as number[] },
    flag: { v: "FLAG", t: "never", note: "Unknown 7702 delegate signing. The vault freezes; funds wait for your recovery key.", reach: 3, skip: [] as number[] },
  }[lane];
  const used = Math.min(amt, BUDGET) / BUDGET;
  return (
    <section className="m-try" id="try">
      <div className="m-sec-head" data-r>
        <span className="mono">(003) Try a payout</span>
        <h2 className="m-h2 serif">
          <Words text="Drag the amount." /> <em><Words text="Watch the vault decide." base={0.2} /></em>
        </h2>
      </div>
      <div className="m-try-box" data-r>
        <div className="m-try-ctl">
          <label className="mono" htmlFor="amt">
            Unwrap amount
          </label>
          <div className="m-amt serif tabular">${amt.toLocaleString("en-US")}</div>
          <input
            id="amt"
            type="range"
            min={20}
            max={12000}
            step={20}
            value={amt}
            onChange={(e) => setAmt(+e.target.value)}
            style={{ "--k": `${((amt - 20) / 11980) * 100}%` } as CSSProperties}
          />
          <div className="m-ticks mono">
            <span style={{ left: `${(BUDGET / 12000) * 100}%` }}>budget</span>
            <span style={{ left: `${(CAP / 12000) * 100}%` }}>hard cap</span>
            <span>$12k</span>
          </div>
          <div className="m-toggles">
            <button className={`m-tog ${attack ? "on danger" : ""}`} onClick={() => setAttack((a) => !a)} aria-pressed={attack}>
              <i /> Signer is compromised
            </button>
            <button className={`m-tog ${passkey ? "on" : ""}`} onClick={() => setPasskey((a) => !a)} aria-pressed={passkey} disabled={lane !== "cap"}>
              <i /> Phone passkey signs
            </button>
          </div>
          <div className="m-ring-row">
            <svg viewBox="0 0 120 120" className="m-ring" aria-hidden>
              <circle cx="60" cy="60" r="50" />
              <circle cx="60" cy="60" r="50" className="fg" style={{ strokeDashoffset: 314 - 314 * used }} />
            </svg>
            <div>
              <span className="mono dim">Instant budget left today</span>
              <b className="serif tabular">${Math.max(0, BUDGET - Math.min(amt, BUDGET)).toLocaleString("en-US")}</b>
              <span className="mono dim">refills over 24h · shared across USDC + WETH</span>
            </div>
          </div>
        </div>
        <div className={`m-try-out lane-${lane}`}>
          <div className="m-track" key={lane + passkey}>
            {STEPS.map((s, j) => (
              <div key={s} className={`m-step ${j < out.reach ? "hit" : ""} ${out.skip.includes(j) ? "skip" : ""}`} style={{ "--d": `${j * 0.3}s` } as CSSProperties}>
                <i />
                <span className="mono">{s}</span>
              </div>
            ))}
            <span className="m-runner" style={{ "--to": `${((out.reach - 1) / (STEPS.length - 1)) * 100}%` } as CSSProperties} />
          </div>
          <div className="m-verdict">
            <span className="mono dim">Verdict</span>
            <b key={out.v}>{out.v}</b>
          </div>
          <div className="m-verdict">
            <span className="mono dim">Time to funds</span>
            <b className="serif" key={out.t}>
              {out.t}
            </b>
          </div>
          <p>{out.note}</p>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── sentinel: radial signal burst ───────────────────────── */

const LABELS = [
  { t: "NEW_DESTINATION", a: -2.45, r: 196 },
  { t: "DELEGATION_CHANGED", a: -2.9, r: 210 },
  { t: "BLOCKLISTED", a: 2.75, r: 190 },
  { t: "VELOCITY", a: -0.95, r: 205 },
  { t: "LOOSENING_PENDING", a: -0.25, r: 215 },
  { t: "STALE_FEED", a: 0.55, r: 180 },
];
const REQS = [
  { r: "unwrap 420 USDC → allowlisted", v: "CLEAR" },
  { r: "unwrap 9,800 USDC → new address", v: "HOLD" },
  { r: "7702 delegate → unknown sweeper", v: "FLAG" },
  { r: "hook swap 0.4 WETH → USDC", v: "CLEAR" },
];

function Sentinel() {
  const box = useRef<HTMLDivElement>(null);
  const seen = useInView(box, 0.35);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!seen) return;
    const t = setInterval(() => setN((x) => (x + 1) % REQS.length), 2400);
    return () => clearInterval(t);
  }, [seen]);
  const nodes = useMemo(() => {
    const R = rng(42);
    return Array.from({ length: 64 }, () => {
      const a = R() * Math.PI * 2;
      const r = 40 + Math.pow(R(), 0.7) * 150;
      return { x: r2(260 + Math.cos(a) * r), y: r2(240 + Math.sin(a) * r), eco: R() > 0.5, s: r2(3 + R() * 4), d: r2(R()) };
    });
  }, []);
  const q = REQS[n];
  return (
    <section className="m-sentinel" id="sentinel">
      <div className={`m-sent-wrap ${seen ? "in" : ""}`} ref={box}>
        <div className="m-sent-card">
          <GlyphArt g="ladder" />
          <div className="m-sent-caption">
            <span className="mono">(004) Sentinel</span>
            <h2 className="serif">Every request, scored before it leaves.</h2>
            <p>One shared Chainlink CRE workflow watches the Hub for every vault. When unsure, it holds. When it sees an attacker, it freezes in seconds, and one victim&rsquo;s attacker lands on everyone&rsquo;s blocklist.</p>
          </div>
          <i className="m-grain" />
        </div>
        <div className="m-sent-burst">
          <svg viewBox="0 0 520 480" aria-hidden>
            <g className="lines">
              {nodes.map((p, i) => (
                <line key={i} x1="260" y1="240" x2={p.x} y2={p.y} style={{ "--d": `${p.d * 0.9}s` } as CSSProperties} />
              ))}
              {LABELS.map((l) => (
                <line key={l.t} x1="260" y1="240" x2={r2(260 + Math.cos(l.a) * l.r)} y2={r2(240 + Math.sin(l.a) * l.r)} style={{ "--d": "0.4s" } as CSSProperties} />
              ))}
            </g>
            <g className="dots">
              {nodes.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={p.s} className={p.eco ? "eco" : "tech"} style={{ "--d": `${0.5 + p.d * 0.9}s`, transformOrigin: `${p.x}px ${p.y}px` } as CSSProperties} />
              ))}
            </g>
            <g className="labels">
              {LABELS.map((l) => {
                const x = r2(260 + Math.cos(l.a) * l.r);
                const y = r2(240 + Math.sin(l.a) * l.r);
                const left = Math.cos(l.a) < 0;
                return (
                  <g key={l.t}>
                    <circle cx={x} cy={y} r="3" className="eco" />
                    <line x1={x} y1={y} x2={left ? x - 70 : x + 70} y2={y} className="lead" />
                    <text x={left ? x - 70 : x + 70} y={y - 6} textAnchor={left ? "start" : "end"}>
                      {l.t}
                    </text>
                  </g>
                );
              })}
            </g>
            <circle cx="260" cy="240" r="7" className={`core v-${q.v}`} />
            <circle cx="260" cy="240" r="7" className={`pulse v-${q.v}`} key={n} />
          </svg>
          <div className="m-sent-legend mono">
            <span>
              <i className="tech" /> Onchain signals
            </span>
            <span>
              <i className="eco" /> Network signals
            </span>
          </div>
          <div className="m-sent-feed mono" key={n}>
            <span className="dim">{q.r}</span>
            <b className={`v-${q.v}`}>{q.v}</b>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── asymmetry ───────────────────────── */

const TIGHT = ["Lower the budget", "Lengthen the delay", "Remove a destination", "Pause the vault", "Blocklist an address"];
const LOOSE = [
  { t: "Raise the budget", h: 48 },
  { t: "Add a destination", h: 48 },
  { t: "Change guardian", h: 168 },
  { t: "Change recovery", h: 168 },
  { t: "Change approver keys", h: 168 },
];

function Asymmetry() {
  return (
    <section className="m-asym" id="config">
      <div className="m-sec-head" data-r>
        <span className="mono">(005) Config is asymmetric</span>
        <div>
          <h2 className="m-h2 serif">
            <Words text="Tighten in a click." /> <em><Words text="Loosen in days." base={0.2} /></em>
          </h2>
          <p className="m-sec-p">Otherwise an attacker&rsquo;s first move is setting the delay to zero. Any withdrawal requested while a loosening change is pending gets flagged.</p>
        </div>
      </div>
      <div className="m-asym-grid">
        <div className="m-asym-col" data-r>
          <span className="mono dim">Tightening · instant</span>
          {TIGHT.map((t, i) => (
            <div className="m-asym-row" key={t} style={{ "--d": `${i * 0.08}s` } as CSSProperties}>
              <span>{t}</span>
              <span className="mono">0s</span>
              <i className="bar" style={{ "--w": "2%" } as CSSProperties} />
            </div>
          ))}
        </div>
        <div className="m-asym-col" data-r style={{ "--d": "0.15s" } as CSSProperties}>
          <span className="mono dim">Loosening · timelocked</span>
          {LOOSE.map((l, i) => (
            <div className="m-asym-row" key={l.t} style={{ "--d": `${0.2 + i * 0.1}s` } as CSSProperties}>
              <span>{l.t}</span>
              <span className="mono">{l.h === 168 ? "7 days" : "48h"}</span>
              <i className="bar slow" style={{ "--w": `${(l.h / 168) * 100}%` } as CSSProperties} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── network: shared blocklist orbit ───────────────────────── */

const MEMBERS = ["northwind", "halcyon", "kestrel", "orbital", "meridian", "lumen", "tessera", "quill", "alder", "beacon", "cinder", "marlow"];
const NODE_BG = ["#fbfaf4", "#e9d95c", "#1d3a2a", "#8dbd6b"];

function Orbit() {
  const box = useRef<HTMLDivElement>(null);
  const seen = useInView(box, 0.3);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!seen || reduced()) return;
    const t = setInterval(() => setTick((x) => x + 1), 3400);
    return () => clearInterval(t);
  }, [seen]);
  const src = (tick * 5 + 2) % MEMBERS.length;
  const C = 300;
  const R = 200;
  const pos = MEMBERS.map((_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / MEMBERS.length;
    return { x: r2(C + Math.cos(a) * R), y: r2(C + Math.sin(a) * R), lx: r2(C + Math.cos(a) * (R + 34)), ly: r2(C + Math.sin(a) * (R + 34)), c: Math.cos(a) };
  });
  const s = pos[src];
  const addr = `0x${((tick + 3) * 2654435761 >>> 0).toString(16).slice(0, 4)}…${((tick + 7) * 40503 >>> 0).toString(16).slice(-4)}`;
  return (
    <div className={`m-orbit ${seen ? "in" : ""}`} ref={box}>
      <svg viewBox="0 0 600 600" aria-label="Member vaults around the Hub sharing a blocklist">
        <circle className="ring" cx={C} cy={C} r={R} />
        <circle className="ring dash" cx={C} cy={C} r={R * 0.52} />
        {pos.map((q, i) => (
          <line key={i} className="spoke" x1={C} y1={C} x2={q.x} y2={q.y} style={{ "--d": `${i * 0.05}s` } as CSSProperties} />
        ))}
        <g className="burst" key={`b${tick}`}>
          <line className="up" x1={s.x} y1={s.y} x2={C} y2={C} pathLength={1} />
          {pos.map((q, i) =>
            i === src ? null : (
              <line key={i} x1={C} y1={C} x2={q.x} y2={q.y} pathLength={1} style={{ "--d": `${0.45 + ((i - src + MEMBERS.length) % MEMBERS.length) * 0.04}s` } as CSSProperties} />
            ),
          )}
        </g>
        {pos.map((q, i) => (
          <g key={i} className={`node ${i === src ? "src" : ""}`} style={{ "--d": `${0.2 + i * 0.05}s`, transformOrigin: `${q.x}px ${q.y}px` } as CSSProperties}>
            <rect x={q.x - 11} y={q.y - 14} width="22" height="28" rx="4" fill={NODE_BG[i % 4]} />
            {i !== src && <circle key={`k${tick}`} className="got" cx={q.x + 11} cy={q.y - 14} r="4" style={{ "--d": `${0.9 + ((i - src + MEMBERS.length) % MEMBERS.length) * 0.04}s` } as CSSProperties} />}
            {i === src && <circle key={`r${tick}`} className="hit" cx={q.x} cy={q.y} r="18" />}
            <text x={q.lx} y={q.ly + 3} textAnchor={q.c > 0.2 ? "start" : q.c < -0.2 ? "end" : "middle"}>
              {MEMBERS[i]}
            </text>
          </g>
        ))}
        <rect className="hub" x={C - 22} y={C - 22} width="44" height="44" rx="10" />
        <text className="hub-t" x={C} y={C + 3} textAnchor="middle">
          HUB
        </text>
      </svg>
      <div className="m-orbit-feed mono" key={tick}>
        <b>FLAG</b> at {MEMBERS[src]}.palmfi.eth · {addr} added to every member&rsquo;s blocklist
      </div>
    </div>
  );
}

function Network() {
  return (
    <section className="m-net" id="network">
      <span className="mono m-net-k" data-r>
        (006) The network
      </span>
      <Orbit />
      <p className="m-net-q serif" data-r>
        <Words text="One member's attacker lands on every member's blocklist." />{" "}
        <em>
          <Words text="An incident at one can never freeze another's receivables." base={0.35} />
        </em>
      </p>
      <div className="m-net-stats">
        {[
          { v: <Counter to={15} suffix=" min" />, l: "minimum delay a CLEAR can reach" },
          { v: <Counter to={72} suffix="h" />, l: "fail-open if CRE is silent (individuals)" },
          { v: <Counter to={100} suffix="%" />, l: "reserves backing every protected token" },
        ].map((s, i) => (
          <div key={i} data-r style={{ "--d": `${i * 0.1}s` } as CSSProperties}>
            <i className="m-rule" />
            <b className="serif">{s.v}</b>
            <span className="mono">{s.l}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ───────────────────────── protocol index ───────────────────────── */

const PIECES = [
  { n: "Vault", k: "Immutable · per owner", d: "Holds the Underlying 1:1, mints your Protected token, enforces every lane, timelock and the 7702 delegation check." },
  { n: "Hub", k: "One address to watch", d: "Every vault reports through it; every CRE verdict arrives through it. Authenticated, bound, single-use reports." },
  { n: "Sentinel", k: "Chainlink CRE", d: "Scores unwraps, config changes and swaps: CLEAR, HOLD or FLAG, with onchain reason codes." },
  { n: "Reconciler", k: "Chainlink CRE · scheduled", d: "Catches missed requests, checks reserves ≥ supply, polls delegations, publishes market modes, writes the heartbeat." },
  { n: "VaultHook", k: "Uniswap v4", d: "A 1:1 pool per vault, so any Uniswap route can pay into it under the same budget and rules." },
  { n: "palmfi.eth", k: "ENS names", d: "Non-transferable names for verified vaults, with a live status record. Pay a name, not a hex string." },
];

function Pieces() {
  const [open, setOpen] = useState(0);
  return (
    <section className="m-pieces" id="pieces">
      <div className="m-sec-head" data-r>
        <span className="mono">(007) Protocol</span>
        <h2 className="m-h2 serif">
          <Words text="Six pieces." /> <em><Words text="No path for an admin to touch your funds." base={0.15} /></em>
        </h2>
      </div>
      <div className="m-pieces-list">
        {PIECES.map((p, i) => (
          <button key={p.n} className={`m-piece ${open === i ? "open" : ""}`} onMouseEnter={() => setOpen(i)} onFocus={() => setOpen(i)} onClick={() => setOpen(i)} data-r style={{ "--d": `${i * 0.06}s` } as CSSProperties}>
            <span className="mono">{String(i + 1).padStart(2, "0")}</span>
            <span className="m-piece-n">{p.n}</span>
            <span className="mono dim hide-sm">{p.k}</span>
            <span className="m-piece-arrow">↗</span>
            <span className="m-piece-d">
              <span>{p.d}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ───────────────────────── footer ───────────────────────── */

function Footer() {
  const scene = useRef<HTMLDivElement>(null);
  useProgress(scene, "view");
  return (
    <footer className="m-foot">
      <div className="m-foot-cta" data-r>
        <h2 className="serif">
          <Words text="Say no" /> <em><Words text="in time." base={0.15} /></em>
        </h2>
        <div className="m-ctas">
          <Link href="/onboard" className="m-btn dark">
            <Mark /> Open a vault
          </Link>
          <Link href="/institution" className="m-btn">
            For institutions
          </Link>
        </div>
      </div>
      <div className="m-foot-scene" ref={scene}>
        <div className="m-foot-bg" aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/landing/footer-hills.webp" alt="" loading="lazy" decoding="async" />
          <i className="m-grain" />
        </div>
      <div className="m-foot-top">
        <div className="m-foot-brand">
          <Link href="/" className="m-logo big">
            <Mark />
            <span>palmfi</span>
          </Link>
          <p>Protected vaults on Ethereum. Built at ETHGlobal Mumbai, November 2026.</p>
        </div>
        <div className="m-foot-cols">
          <div>
            <b>App</b>
            <Link href="/onboard">Open a vault</Link>
            <Link href="/vaults">Your vaults</Link>
            <Link href="/pay">Pay a name</Link>
            <Link href="/approver">Approver</Link>
          </div>
          <div>
            <b>Protocol</b>
            <a href="#lanes">Exit lanes</a>
            <a href="#sentinel">Sentinel</a>
            <a href="#network">Network</a>
            <a href="#pieces">Contracts</a>
          </div>
          <div>
            <b>Built with</b>
            <span>Chainlink CRE</span>
            <span>Uniswap v4</span>
            <span>ENS</span>
            <span>Passkeys</span>
          </div>
        </div>
      </div>
      <div className="m-foot-bar">
        <span>© 2026 palmfi · palmfi.eth</span>
        <span>Ethereum Sepolia testnet</span>
      </div>
      </div>
    </footer>
  );
}

/* ───────────────────────── page ───────────────────────── */

export function Meadow() {
  useReveals();
  return (
    <div className="meadow">
      <Nav />
      <main>
        <Hero />
        <Statement />
        <Strip />
        <Facts />
        <Sentence />
        <Deck />
        <Try />
        <Sentinel />
        <Asymmetry />
        <Network />
        <Pieces />
      </main>
      <Footer />
      <div className="m-paper" aria-hidden />
    </div>
  );
}
