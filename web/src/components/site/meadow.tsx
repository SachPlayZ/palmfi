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
        <a href="#network">Orbital pool</a>
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
  { t: "INSTANT BUDGET · 24H / 7D", x: 960, y: 92, a: "end" },
  { t: "QUEUED · DELAY GROWS WITH SURPRISE", x: 770, y: 318, a: "middle" },
  { t: "YOUR WALLETS VOTE", x: 762, y: 382, a: "middle" },
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
  { k: "The risk", t: "Today, one valid signature can move an entire treasury." },
  { k: "The vault", t: "palmfi puts a gate where a signature alone can't reach." },
  { k: "The lanes", t: "Past the gate, every payment takes a lane." },
  { k: "The brake", t: "A compromised key only reaches the budget. The rest waits for your team." },
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
            ONE SIGNATURE · ONE TRANSACTION · NO WAY TO SAY NO
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
        <span className="mono dim">Protected USDC treasury for teams</span>
        <h1 className="m-h1 serif">
          <Words text="Your keys can be stolen." />
          <em>
            <Words text="Your treasury can't leave" base={0.25} />
          </em>{" "}
          <Words text="faster than your team can say no." base={0.5} />
        </h1>
      </div>
      <div className="m-state-row" data-r style={{ "--d": "0.5s" } as CSSProperties}>
        <p>Every organisation gets its own USDC vault and Protected token. Small payments go out instantly within a budget. Anything larger waits as long as it is unusual, and a majority of your own wallets can veto it.</p>
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

const BUILT = ["Arc", "Chainlink CRE", "Uniswap v4", "Circle USDC", "Orbital pool", "EIP-7702 checks", "Arc Studio", "Telegram alerts"];

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
        <span className="mono">Why palmfi</span>
        <p className="m-lede">
          Keys leak. Signers get phished. Signing systems get tricked. palmfi is built for the day someone else <em className="serif">can produce valid signatures</em> for your treasury, and still can&rsquo;t take it.
        </p>
      </div>
      <div className="m-facts-row">
        {[
          { v: <Counter to={15} suffix=" min" />, l: "minimum hold on any payout above budget" },
          { v: <Counter to={1} />, l: "wallet is all it takes to freeze the vault" },
          { v: <Counter to={7} suffix=" days" />, l: "to change where rescued funds can go" },
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
    card: "Pay any address within your rolling 24h and 7d budget. Nothing waits.",
    title: "Small spending, no one in the way.",
    body: "Everyday unwraps and pay-by-name payments go straight out, charged to one Instant budget that refills gradually over 24 hours and 7 days.",
    meta: "rolling 24h · 7d budget",
  },
  {
    k: "Queued lane",
    g: "bars",
    bg: "#e9d95c",
    fg: "#1f2a1e",
    ink: "#1f2a1e",
    card: "Above budget, a payment waits. The more unusual it is, the longer it waits.",
    title: "Unusual payouts wait longer.",
    body: "The Sentinel scores each queued request in bits of surprise against that wallet's and that vault's own history. The delay doubles every 2.5 bits from a 15-minute floor, so routine payroll waits about half an hour.",
    meta: "floor 15 min · 72h until scored",
  },
  {
    k: "Your team",
    g: "ladder",
    bg: "#1d3a2a",
    fg: "#e8f2c8",
    ink: "#cfe86a",
    card: "While it waits, a majority of your own wallets can veto it or fast-track it.",
    title: "Your team can say no.",
    body: "More than half of the other wallets voting NO cancels the request. More than half of all wallets voting YES makes it executable at the floor. Every Voter gets a Telegram alert, so honest wallets are there to vote.",
    meta: "3+ wallets · one vote each",
  },
  {
    k: "Recovery",
    g: "swirl",
    bg: "#8dbd6b",
    fg: "#fbfdf3",
    ink: "#fbfdf3",
    card: "Any one wallet can freeze the vault. Frozen funds can only go to the recovery vault.",
    title: "Rescue goes to one place, set in advance.",
    body: "A frozen vault stops every outflow except migration to the recovery vault fixed at onboarding. Changing that address takes seven days, so no one can redirect funds mid-incident.",
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
          <span className="mono">How a vault spends</span>
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
const FLOOR = 15;
const STEPS = ["Signed", "Budget", "Sentinel", "Funds"];

/** Illustrative surprise score: grows with how far past the budget the amount is. */
const bitsFor = (amt: number) => 3 + 2.2 * Math.log2(amt / BUDGET + 1);
const fmtMin = (m: number) => (m < 60 ? `${Math.round(m)} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`);

function Try() {
  const [amt, setAmt] = useState(320);
  const [attack, setAttack] = useState(false);
  const [fast, setFast] = useState(false);
  const lane = attack ? "flag" : amt <= BUDGET ? "instant" : amt <= CAP ? "queued" : "cap";
  const bits = bitsFor(amt);
  const delay = FLOOR * Math.pow(2, bits / 2.5);
  const queued = (min: number, note: string) =>
    fast
      ? { v: "FAST-TRACKED", t: `${FLOOR} min`, note: "More than half of your wallets voted YES, so it can execute at the floor.", reach: 4, skip: [] as number[] }
      : { v: `${bits.toFixed(1)} BITS`, t: fmtMin(min), note, reach: 4, skip: [] as number[] };
  const out = {
    instant: { v: "PAID", t: "now", note: "Inside your Instant budget. No one is asked, nothing waits.", reach: 4, skip: [2] },
    queued: queued(delay, "Queued with a 1 USDC bond. The delay doubles every 2.5 bits of surprise from the 15-minute floor, and your wallets can veto it meanwhile."),
    cap: queued(Math.max(delay, 24 * 60), "Above the $5,000 hard cap: at least 24 hours, unless a majority of your wallets fast-tracks it."),
    flag: { v: "FLAG", t: "never", note: "A fresh 7702 delegate sending to a new address scores past 28 bits. The vault freezes and the destination is blocklisted.", reach: 3, skip: [] as number[] },
  }[lane];
  const used = Math.min(amt, BUDGET) / BUDGET;
  return (
    <section className="m-try" id="try">
      <div className="m-sec-head" data-r>
        <span className="mono">Try a payout</span>
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
            <button className={`m-tog ${fast ? "on" : ""}`} onClick={() => setFast((a) => !a)} aria-pressed={fast} disabled={lane === "instant" || lane === "flag"}>
              <i /> Team fast-tracks it
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
              <span className="mono dim">refills gradually over 24h and 7d</span>
            </div>
          </div>
        </div>
        <div className={`m-try-out lane-${lane}`}>
          <div className="m-track" key={lane + fast}>
            {STEPS.map((s, j) => (
              <div key={s} className={`m-step ${j < out.reach ? "hit" : ""} ${out.skip.includes(j) ? "skip" : ""}`} style={{ "--d": `${j * 0.3}s` } as CSSProperties}>
                <i />
                <span className="mono">{s}</span>
              </div>
            ))}
            <span className="m-runner" style={{ "--to": `${((out.reach - 1) / (STEPS.length - 1)) * 100}%` } as CSSProperties} />
          </div>
          <div className="m-verdict">
            <span className="mono dim">Verdict · illustrative</span>
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
  { t: "BLOCKLISTED_DEST", a: 2.75, r: 190 },
  { t: "UNUSUAL_AMOUNT", a: -0.95, r: 205 },
  { t: "CONFIG_CHANGE_PENDING", a: -0.25, r: 215 },
  { t: "OFF_HOURS", a: 0.55, r: 180 },
];
const REQS = [
  { r: "payroll 4,200 USDC → usual address", v: "3 BITS · 30 MIN", c: "CLEAR" },
  { r: "45,000 USDC at 3am → new address", v: "15 BITS · 1 H", c: "HOLD" },
  { r: "7702 delegate → unknown sweeper", v: "FLAG", c: "FLAG" },
  { r: "vendor 900 USDC → known address", v: "4 BITS · 45 MIN", c: "CLEAR" },
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
            <span className="mono">Sentinel</span>
            <h2 className="serif">Every request, scored before it leaves.</h2>
            <p>One shared Chainlink CRE workflow scores every outflow against that wallet&rsquo;s and that vault&rsquo;s own history, with pure integer math. The more surprising a request, the longer it waits. Past the threshold it flags: the vault freezes and the destination lands on the shared blocklist.</p>
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
            <circle cx="260" cy="240" r="7" className={`core v-${q.c}`} />
            <circle cx="260" cy="240" r="7" className={`pulse v-${q.c}`} key={n} />
          </svg>
          <div className="m-sent-legend mono">
            <span>
              <i className="tech" /> Wallet signals
            </span>
            <span>
              <i className="eco" /> Vault signals
            </span>
          </div>
          <div className="m-sent-feed mono" key={n}>
            <span className="dim">{q.r}</span>
            <b className={`v-${q.c}`}>{q.v}</b>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── asymmetry ───────────────────────── */

const TIGHT = ["Remove a wallet", "Freeze the vault", "Migrate to the recovery vault"];
const LOOSE = [
  { t: "Add a wallet", h: 48 },
  { t: "Raise the budget", h: 48 },
  { t: "Loosen limits or delays", h: 48 },
  { t: "Add a destination", h: 48 },
  { t: "Change recovery vault", h: 168 },
  { t: "Change recovery key", h: 168 },
];

function Asymmetry() {
  return (
    <section className="m-asym" id="config">
      <div className="m-sec-head" data-r>
        <span className="mono">Settings</span>
        <div>
          <h2 className="m-h2 serif">
            <Words text="Tighten in a click." /> <em><Words text="Loosen in days." base={0.2} /></em>
          </h2>
          <p className="m-sec-p">Every settings change is a majority vote of your wallets. Tightening lands now; loosening waits out a timelock, and while it&rsquo;s pending, every payment looks more unusual to the Sentinel.</p>
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

const ORGS = ["northwind", "halcyon", "kestrel", "tessera", "meridian", "lumen", "alder", "quill", "beacon", "cinder", "marlow", "orchid"];
const NODE_BG = ["#fbfaf4", "#e9d95c", "#1d3a2a", "#8dbd6b"];
const AMOUNTS = [3, 120, 48, 900, 15, 260];

/** Orgs around one Orbital pool: the payer swaps its token in, the payee receives its own token out. */
function Orbit() {
  const box = useRef<HTMLDivElement>(null);
  const seen = useInView(box, 0.3);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!seen || reduced()) return;
    const t = setInterval(() => setTick((x) => x + 1), 3000);
    return () => clearInterval(t);
  }, [seen]);
  const from = (tick * 5 + 2) % ORGS.length;
  const to = (from + 4 + (tick % 5)) % ORGS.length;
  const C = 300;
  const R = 200;
  const pos = ORGS.map((_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / ORGS.length;
    return { x: r2(C + Math.cos(a) * R), y: r2(C + Math.sin(a) * R), lx: r2(C + Math.cos(a) * (R + 34)), ly: r2(C + Math.sin(a) * (R + 34)), c: Math.cos(a) };
  });
  const a = pos[from];
  const b = pos[to];
  return (
    <div className={`m-orbit ${seen ? "in" : ""}`} ref={box}>
      <svg viewBox="0 0 600 600" aria-label="Organisations paying each other through one Orbital pool">
        <circle className="ring" cx={C} cy={C} r={R} />
        <circle className="ring dash" cx={C} cy={C} r={R * 0.52} />
        {pos.map((q, i) => (
          <line key={i} className="spoke" x1={C} y1={C} x2={q.x} y2={q.y} style={{ "--d": `${i * 0.05}s` } as CSSProperties} />
        ))}
        <g className="burst" key={`b${tick}`}>
          <line className="in-leg" x1={a.x} y1={a.y} x2={C} y2={C} pathLength={1} />
          <line className="out-leg" x1={C} y1={C} x2={b.x} y2={b.y} pathLength={1} style={{ "--d": "0.7s" } as CSSProperties} />
        </g>
        {pos.map((q, i) => (
          <g key={i} className={`node ${i === from ? "from" : ""} ${i === to ? "to" : ""}`} style={{ "--d": `${0.2 + i * 0.05}s`, transformOrigin: `${q.x}px ${q.y}px` } as CSSProperties}>
            <rect x={q.x - 11} y={q.y - 14} width="22" height="28" rx="4" fill={NODE_BG[i % 4]} />
            {i === to && <circle key={`k${tick}`} className="got" cx={q.x + 11} cy={q.y - 14} r="4" style={{ "--d": "1.3s" } as CSSProperties} />}
            {i === from && <circle key={`r${tick}`} className="hit" cx={q.x} cy={q.y} r="18" />}
            <text x={q.lx} y={q.ly + 3} textAnchor={q.c > 0.2 ? "start" : q.c < -0.2 ? "end" : "middle"}>
              {ORGS[i]}
            </text>
          </g>
        ))}
        <circle className="hub" cx={C} cy={C} r="30" />
        <text className="hub-t" x={C} y={C + 3} textAnchor="middle">
          ORBITAL
        </text>
      </svg>
      <div className="m-orbit-feed mono" key={tick}>
        <b>{ORGS[from]}</b> pays <b className="to">{ORGS[to]}</b> {AMOUNTS[tick % AMOUNTS.length]} USDC · {ORGS[from]}USDC in, {ORGS[to]}USDC out
      </div>
    </div>
  );
}

function Network() {
  return (
    <section className="m-net" id="network">
      <span className="mono m-net-k" data-r>
        Paying other orgs
      </span>
      <Orbit />
      <p className="m-net-q serif" data-r>
        <Words text="Orgs pay each other by name through one Orbital pool." />{" "}
        <em>
          <Words text="You pay in your token, they receive theirs, and it counts against your budget." base={0.35} />
        </em>
      </p>
      <div className="m-net-stats">
        {[
          { v: <Counter to={15} suffix=" min" />, l: "the floor: shortest wait for any queued payment" },
          { v: <Counter to={72} suffix="h" />, l: "default delay until the Sentinel scores a request" },
          { v: <Counter to={100} suffix="%" />, l: "USDC reserves behind every Protected token" },
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
  { n: "Vault", k: "Per org · USDC on Arc", d: "Holds USDC 1:1 behind your Protected token and enforces the budget, the queue, the votes, the freeze and the 7702 delegation check." },
  { n: "Hub", k: "One address to watch", d: "The name directory, every vault's status, the shared blocklist, and the receiver for every Chainlink CRE report." },
  { n: "Sentinel", k: "Chainlink CRE", d: "Scores every outflow in bits of surprise and reports a delay or a FLAG, with onchain reason codes." },
  { n: "Reconciler", k: "Chainlink CRE · scheduled", d: "Writes the heartbeat, scores anything missed, checks reserves and 7702 delegations, and settles pool inventory." },
  { n: "Orbital pool", k: "Uniswap v4 hook", d: "One N-token pool holding every org's Protected token. A payer's swap-in is charged to its own budget." },
  { n: "Votes", k: "3+ wallets · one each", d: "Veto, fast-track, freeze and every settings change are decided by a majority of the org's own wallets." },
];

function Pieces() {
  const [open, setOpen] = useState(0);
  return (
    <section className="m-pieces" id="pieces">
      <div className="m-sec-head" data-r>
        <span className="mono">Protocol</span>
        <h2 className="m-h2 serif">
          <Words text="Six pieces." /> <em><Words text="Your team holds every rule." base={0.15} /></em>
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
          <Link href="/pay" className="m-btn">
            Pay by name
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
          <p>Protected USDC vaults for teams. Instant everyday payments, brakes on everything else.</p>
        </div>
        <div className="m-foot-cols">
          <div>
            <b>App</b>
            <Link href="/onboard">Open a vault</Link>
            <Link href="/vaults">Your vaults</Link>
            <Link href="/pay">Pay by name</Link>
          </div>
          <div>
            <b>Protocol</b>
            <a href="#lanes">Exit lanes</a>
            <a href="#sentinel">Sentinel</a>
            <a href="#network">Orbital pool</a>
            <a href="#pieces">Contracts</a>
          </div>
          <div>
            <b>Built with</b>
            <span>Arc</span>
            <span>Chainlink CRE</span>
            <span>Uniswap v4</span>
            <span>Circle USDC</span>
          </div>
        </div>
      </div>
      <div className="m-foot-bar">
        <span>© 2026 palmfi</span>
        <span>Arc testnet</span>
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
