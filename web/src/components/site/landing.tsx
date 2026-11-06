"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { Shader, type Uniforms } from "./shader";
import { FLUID, ORB, THERMAL } from "./shaders";
import { ThermalPalm } from "./thermal-palm";

/* ───────────────────────── helpers ───────────────────────── */

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const hex = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const mix3 = (a: number[], b: number[], t: number) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

/** Calls `cb(p)` on scroll. sticky: 0..1 while the element is pinned. view: 0..1 from entering to leaving. */
function useProgress(ref: RefObject<HTMLElement | null>, cb: (p: number) => void, mode: "sticky" | "view" = "sticky") {
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
      const p = mode === "sticky" ? -r.top / Math.max(1, r.height - vh) : (vh - r.top) / (r.height + vh);
      const c = clamp(p);
      el.style.setProperty("--p", c.toFixed(4));
      fn.current(c);
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
      { threshold: 0.2, rootMargin: "0px 0px -8% 0px" },
    );
    document.querySelectorAll("[data-reveal]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

/* ───────────────────────── page ───────────────────────── */

export function Landing() {
  useReveals();
  return (
    <div className="site">
      <div className="grain" aria-hidden />
      <Nav />
      <main>
        <Hero />
        <Manifesto />
        <Rays />
        <Temperatures />
        <Freeze />
        <Network />
        <Hold />
      </main>
      <Footer />
    </div>
  );
}

function Nav() {
  return (
    <header className="nav">
      <Link href="/" className="nav-mark" aria-label="palmfi home">
        <ThermalPalm size={28} />
        <span className="brat">palmfi</span>
      </Link>
      <nav className="nav-links mono">
        <a href="#how">how</a>
        <a href="#freeze">freeze</a>
        <Link href="/vaults" className="nav-app">
          open app
        </Link>
      </nav>
    </header>
  );
}

/* ───────────────────────── hero ───────────────────────── */

function Hero() {
  const sec = useRef<HTMLElement>(null);
  const tag = useRef<HTMLDivElement>(null);
  const u = useRef<Uniforms>({ u_trail: new Float32Array(48), u_palm: [0, 0], u_size: 400, u_cool: 0 });

  useProgress(sec, (p) => (u.current.u_cool = clamp(p * 1.3)), "sticky");

  useEffect(() => {
    const el = sec.current!;
    const pts = Array.from({ length: 16 }, () => ({ x: -999, y: -999, s: 0 }));
    let head = 0;
    let mx = -999,
      my = -999,
      moved = false,
      lastMove = 0,
      raf = 0,
      inside = false;

    const place = () => {
      const w = el.clientWidth,
        h = el.clientHeight;
      const wide = w > 860;
      const size = Math.min(h * (wide ? 0.62 : 0.42), w * (wide ? 0.34 : 0.62));
      u.current.u_size = size;
      u.current.u_palm = [wide ? w * 0.73 : w * 0.5, wide ? h * 0.4 : h * 0.33];
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);

    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      mx = e.clientX - r.left;
      my = e.clientY - r.top;
      moved = true;
      lastMove = performance.now();
      inside = true;
      if (tag.current) {
        const [px, py] = u.current.u_palm as number[];
        const d = Math.hypot(mx - px, my - py) / (u.current.u_size as number);
        const temp = 30.4 + 6.4 * Math.exp(-d * 1.6);
        tag.current.textContent = `${temp.toFixed(1)}°`;
        tag.current.style.transform = `translate(${mx + 16}px, ${my + 14}px)`;
        tag.current.style.opacity = "1";
      }
    };
    const onLeave = () => {
      inside = false;
      if (tag.current) tag.current.style.opacity = "0";
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);

    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      // idle: a ghost hand drifts so touch screens still see heat move
      if (!reduce && (!inside || now - lastMove > 2600)) {
        const t = now / 1000;
        const [px, py] = u.current.u_palm as number[];
        const s = u.current.u_size as number;
        mx = px + Math.sin(t * 0.53) * s * 0.85 - s * 0.25;
        my = py + Math.sin(t * 0.37 + 1.3) * s * 0.45;
        moved = true;
      }
      if (moved) {
        pts[head] = { x: mx, y: my, s: inside && now - lastMove < 2600 ? 0.13 : 0.06 };
        head = (head + 1) % pts.length;
        moved = false;
      }
      const a = u.current.u_trail as Float32Array;
      pts.forEach((p, i) => {
        p.s *= 0.94;
        a[i * 3] = p.x;
        a[i * 3 + 1] = p.y;
        a[i * 3 + 2] = p.s;
      });
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <section ref={sec} className="hero">
      <div className="hero-pin fade-edges">
        <Shader frag={THERMAL} uniforms={u} className="gl" />
        <div className="hero-copy">
          <p className="mono eyebrow">fig. 01 — a warm hand, seen in infrared</p>
          <h1 className="brat hero-title">palmfi</h1>
          <div className="hero-foot">
            <p>
              keys get stolen. warmth doesn&apos;t. palmfi vaults let a valid signature move a bounded amount and
              nothing more.
            </p>
            <div className="cta-row">
              <Link className="btn btn-hot" href="/onboard">
                open a vault
              </Link>
              <a className="btn btn-ghost" href="#how">
                how it works
              </a>
            </div>
          </div>
        </div>
        <div ref={tag} className="temp-tag mono" aria-hidden />
        <span className="mono scroll-cue">scroll — watch it cool</span>
      </div>
    </section>
  );
}

/* ───────────────────────── manifesto ───────────────────────── */

// site palette (the thermal ramp), used everywhere colour appears
const P = {
  ink: "#0b0a0d",
  paper: "#f3eee8",
  indigo: "#3d3fff",
  lilac: "#8f86ff",
  mint: "#38cc8e",
  butter: "#ffd34d",
  orange: "#ff7a1f",
  red: "#ff2a1f",
  pink: "#ff7ab8",
  ice: "#cdd8ff",
};

const LINES: { text: string; c1: string; c2: string }[] = [
  { text: "keys leak.", c1: P.lilac, c2: P.indigo },
  { text: "seeds get phished.", c1: P.butter, c2: P.mint },
  { text: "signatures lie.", c1: P.pink, c2: P.red },
  { text: "warmth can't.", c1: "#ffe7b0", c2: P.orange },
];

/** One phrase in focus at a time; the rest blur away. x runs 0..n. */
function crossfade(els: (HTMLElement | null)[], x: number, drift = 6) {
  const n = els.length;
  els.forEach((el, i) => {
    if (!el) return;
    let d = Math.abs(x - (i + 0.5));
    if (i === n - 1 && x > i + 0.5) d = 0;
    if (i === 0 && x < 0.5) d = 0;
    const o = clamp(1 - (d - 0.22) * 3.2);
    el.style.opacity = o.toFixed(3);
    el.style.filter = `blur(${(Math.max(0, d - 0.12) * 46 + 0.6).toFixed(1)}px)`;
    el.style.transform = `translateY(${((x - (i + 0.5)) * -drift).toFixed(2)}vh) scale(${(0.94 + o * 0.06).toFixed(3)})`;
  });
}

function Manifesto() {
  const sec = useRef<HTMLElement>(null);
  const lines = useRef<(HTMLSpanElement | null)[]>([]);
  const count = useRef<HTMLSpanElement>(null);
  const u = useRef<Uniforms>({
    u_c1: hex(LINES[0].c1),
    u_c2: hex(LINES[0].c2),
    u_bg: hex(P.ink),
    u_center: [0.5, 0.5],
    u_rad: 0.3,
    u_star: 0,
  });

  useProgress(sec, (p) => {
    const n = LINES.length;
    const x = p * n;
    crossfade(lines.current, x);
    const f = clamp(x - 0.5, 0, n - 1);
    const i = Math.floor(f);
    const t = f - i;
    const j = Math.min(n - 1, i + 1);
    u.current.u_c1 = mix3(hex(LINES[i].c1), hex(LINES[j].c1), t);
    u.current.u_c2 = mix3(hex(LINES[i].c2), hex(LINES[j].c2), t);
    u.current.u_rad = 0.22 + 0.14 * Math.sin(p * Math.PI) + (p > 0.8 ? (p - 0.8) * 0.6 : 0);
    u.current.u_star = clamp((p - 0.78) * 5);
    if (count.current) count.current.textContent = `0${Math.min(n, Math.floor(x) + 1)} / 0${n}`;
  });

  return (
    <section ref={sec} className="manifesto" aria-label="why palmfi">
      <div className="pin fade-edges">
        <Shader frag={ORB} uniforms={u} className="gl" quality={0.8} />
        <h2 className="manifesto-lines">
          {LINES.map((l, i) => (
            <span key={l.text} ref={(el) => void (lines.current[i] = el)} className="brat manifesto-line">
              {l.text}
            </span>
          ))}
        </h2>
        <span ref={count} className="mono manifesto-count">
          01 / 04
        </span>
      </div>
    </section>
  );
}

/* ───────────────────────── rays ───────────────────────── */

const CHALK = [P.paper, P.pink, P.orange, P.lilac, P.mint, P.butter, P.indigo, P.red, P.paper, P.ice];

function seeded(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

function Rays() {
  const sec = useRef<HTMLElement>(null);
  useProgress(sec, () => {});

  // rays run well past the frame; a soft radial mask decides how far they reach
  const rays = useMemo(() => {
    const r = seeded(11);
    const q = (n: number) => Math.round(n * 100) / 100;
    return Array.from({ length: 30 }, (_, i) => {
      const a = (i / 30) * Math.PI * 2 + (r() - 0.5) * 0.3;
      const start = 10 + r() * 30;
      return {
        x1: q(500 + Math.cos(a) * start),
        y1: q(500 + Math.sin(a) * start),
        x2: q(500 + Math.cos(a) * 900),
        y2: q(500 + Math.sin(a) * 900),
        w: q(2.5 + r() * 9),
        c: CHALK[i % CHALK.length],
        o: q(0.45 + r() * 0.45),
        dash: r() > 0.8,
      };
    });
  }, []);

  return (
    <section ref={sec} id="how" className="rays">
      <div className="pin fade-edges">
        <svg className="rays-svg" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice" aria-hidden>
          <defs>
            <filter id="chalk" x="-5%" y="-5%" width="110%" height="110%">
              <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="4" result="n" />
              <feDisplacementMap in="SourceGraphic" in2="n" scale="6" xChannelSelector="R" yChannelSelector="G" result="d" />
              <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -3 2.1" result="holes" />
              <feComposite in="d" in2="holes" operator="in" />
            </filter>
            <radialGradient id="reach-g" cx="500" cy="500" r="500" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fff" />
              <stop offset=".35" stopColor="#fff" stopOpacity=".95" />
              <stop offset=".7" stopColor="#fff" stopOpacity=".35" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
            <mask id="reach" maskUnits="userSpaceOnUse" x="-500" y="-500" width="2000" height="2000">
              <circle cx="500" cy="500" r="500" fill="url(#reach-g)" className="rays-reach" />
            </mask>
            <radialGradient id="core">
              <stop offset="0" stopColor="#fff" />
              <stop offset=".25" stopColor="#ffe7b0" stopOpacity=".8" />
              <stop offset="1" stopColor={P.orange} stopOpacity="0" />
            </radialGradient>
          </defs>
          <g mask="url(#reach)">
            <g filter="url(#chalk)" className="rays-spin">
              {rays.map((r, i) => (
                <line
                  key={i}
                  x1={r.x1}
                  y1={r.y1}
                  x2={r.x2}
                  y2={r.y2}
                  stroke={r.c}
                  strokeOpacity={r.o}
                  strokeWidth={r.w}
                  strokeLinecap="round"
                  pathLength={1}
                  className={r.dash ? "ray-dash" : undefined}
                />
              ))}
            </g>
          </g>
          <circle cx="500" cy="500" r="46" fill="url(#core)" className="rays-core" />
        </svg>
        <div className="rays-copy">
          <p className="mono eyebrow">fig. 02 — one vault, many hands</p>
          <h2 className="brat h2">spend from anywhere you trust.</h2>
          <p className="body">
            whitelist your hot wallets. each one draws from the same vault, instantly, up to a shared instant budget
            that refills over 24 hours and 7 days.
          </p>
        </div>
        <span className="mono rays-label">your vault</span>
      </div>
    </section>
  );
}

/* ───────────────────────── temperatures ───────────────────────── */

// one palm, read three times as it cools
const STATES: { name: string; deg: number; title: string; body: string }[] = [
  {
    name: "hot",
    deg: 37.0,
    title: "moves instantly.",
    body: "inside your instant budget, payments clear right away from any hot wallet you’ve whitelisted.",
  },
  {
    name: "warm",
    deg: 33.5,
    title: "waits for you.",
    body: "past the budget, nothing leaves until your second factor confirms it. a signature alone isn’t enough.",
  },
  {
    name: "cold",
    deg: 4.0,
    title: "stays frozen.",
    body: "freeze the vault and every hot key goes dead. only your recovery key, kept cold, can thaw it.",
  },
];

function Temperatures() {
  const sec = useRef<HTMLElement>(null);
  const pin = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLDivElement | null)[]>([]);
  const deg = useRef<HTMLSpanElement>(null);
  const ticks = useRef<(HTMLSpanElement | null)[]>([]);
  const u = useRef<Uniforms>({ u_trail: new Float32Array(48), u_palm: [0, 0], u_size: 300, u_cool: 0 });

  useEffect(() => {
    const el = pin.current!;
    const place = () => {
      const w = el.clientWidth,
        h = el.clientHeight;
      const wide = w > 860;
      u.current.u_size = Math.min(h * (wide ? 0.56 : 0.34), w * (wide ? 0.3 : 0.56));
      u.current.u_palm = [wide ? w * 0.3 : w * 0.5, wide ? h * 0.44 : h * 0.3];
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useProgress(sec, (p) => {
    const n = STATES.length;
    const x = p * n;
    crossfade(items.current, x, 3);
    const f = clamp(x - 0.5, 0, n - 1);
    const i = Math.floor(f);
    const j = Math.min(n - 1, i + 1);
    const t = f - i;
    u.current.u_cool = clamp(f / (n - 1));
    if (deg.current) deg.current.textContent = `${mix(STATES[i].deg, STATES[j].deg, t).toFixed(1).padStart(4, "0")}°`;
    ticks.current.forEach((k, idx) => k?.classList.toggle("on", Math.round(f) === idx));
  });

  return (
    <section ref={sec} className="temps" aria-label="vault temperatures">
      <div ref={pin} className="pin fade-edges">
        <Shader frag={THERMAL} uniforms={u} className="gl" quality={0.9} />
        <p className="mono eyebrow temps-eyebrow">fig. 03 — one hand, three readings</p>
        <div className="temps-side">
          <span ref={deg} className="brat temps-deg">
            37.0°
          </span>
          <div className="temps-states">
            {STATES.map((s, i) => (
              <div key={s.name} ref={(el) => void (items.current[i] = el)} className="temps-state">
                <h3 className="brat h3">{s.title}</h3>
                <p className="body">{s.body}</p>
              </div>
            ))}
          </div>
          <div className="mono temps-ticks">
            {STATES.map((s, i) => (
              <span key={s.name} ref={(el) => void (ticks.current[i] = el)}>
                {s.name}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── freeze ───────────────────────── */

function Freeze() {
  const sec = useRef<HTMLElement>(null);
  const a = useRef<HTMLSpanElement>(null);
  const b = useRef<HTMLSpanElement>(null);
  const u = useRef<Uniforms>({ u_p: 0, u_flow: 0 });

  // the fluid slows to a stop as it freezes
  useEffect(() => {
    let raf = 0,
      last = performance.now();
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!reduce) u.current.u_flow = (u.current.u_flow as number) + dt * 0.07 * (1 - 0.92 * (u.current.u_p as number));
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  useProgress(sec, (p) => {
    u.current.u_p = p;
    const ea = clamp(p * 2.2);
    const eb = clamp(p * 2.2 - 0.6);
    for (const [el, e] of [
      [a.current, ea],
      [b.current, eb],
    ] as const) {
      if (!el) continue;
      el.style.fontStretch = `${mix(125, 62, e).toFixed(1)}%`;
      el.style.filter = `blur(${mix(16, 0.8, e).toFixed(1)}px)`;
      el.style.opacity = `${mix(0, 1, e)}`;
    }
  });

  return (
    <section ref={sec} id="freeze" className="freeze">
      <div className="pin fade-edges">
        <Shader frag={FLUID} uniforms={u} className="gl" quality={0.75} />
        <h2 className="freeze-title brat">
          <span ref={a}>stolen key?</span>
          <span ref={b}>cold money.</span>
        </h2>
        <p className="freeze-body body">
          freeze in one move. then migrate everything to the recovery vault you fixed on day one. the thief keeps a
          key to an empty room.
        </p>
        <p className="mono eyebrow freeze-eyebrow">fig. 04 — incident</p>
      </div>
    </section>
  );
}

/* ───────────────────────── network: heat travelling vault to vault ───────────────────────── */

const RAMP: [number, string][] = [
  [0.0, P.ink],
  [0.16, "#1a1640"],
  [0.3, P.indigo],
  [0.44, P.mint],
  [0.58, P.butter],
  [0.7, P.orange],
  [0.84, P.red],
  [1.0, "#ffd6e6"],
];
const RAMP_RGB = RAMP.map(([s, c]) => [s, ...hex(c)] as [number, number, number, number]);
function heatColor(v: number) {
  // banded, like the hero
  const x = Math.round(clamp(v) * 9) / 9;
  for (let i = 1; i < RAMP_RGB.length; i++) {
    const [s1, r1, g1, b1] = RAMP_RGB[i];
    const [s0, r0, g0, b0] = RAMP_RGB[i - 1];
    if (x <= s1) {
      const t = (x - s0) / (s1 - s0);
      return `rgb(${(mix(r0, r1, t) * 255) | 0},${(mix(g0, g1, t) * 255) | 0},${(mix(b0, b1, t) * 255) | 0})`;
    }
  }
  return "#ffd6e6";
}

function DotMatrix({ text, progress }: { text: string; progress: RefObject<number> }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    let cells: { x: number; y: number; ox: number; oy: number; r: number; jx: number; jy: number }[] = [];
    let step = 6;
    let w = 1;
    let raf = 0;
    let visible = false;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

    const build = async () => {
      await document.fonts.ready;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = c.clientWidth;
      const h = c.clientHeight;
      c.width = w * dpr;
      c.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      step = Math.max(3, Math.round(w / 190));
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const o = off.getContext("2d")!;
      const fam = getComputedStyle(document.documentElement).getPropertyValue("--font-display") || "sans-serif";
      const setFont = (fs: number) => {
        o.font = `500 ${fs}px ${fam}`;
        if ("fontStretch" in o) o.fontStretch = "ultra-condensed";
      };
      let fs = h * 0.86;
      setFont(fs);
      const mw = o.measureText(text).width;
      if (mw > w * 0.96) fs *= (w * 0.96) / mw;
      setFont(fs);
      o.textAlign = "center";
      o.textBaseline = "middle";
      o.fillStyle = "#fff";
      o.fillText(text, w / 2, h * 0.5);
      const data = o.getImageData(0, 0, w, h).data;
      const rnd = seeded(5);
      cells = [];
      for (let y = 0; y < h; y += step)
        for (let x = 0; x < w; x += step)
          if (data[(y * w + x) * 4 + 3] > 120)
            cells.push({ x, y, ox: (rnd() - 0.5) * w * 0.8, oy: (rnd() - 0.5) * h * 1.6, r: rnd(), jx: (rnd() - 0.5) * step, jy: (rnd() - 0.5) * step });
    };

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (!visible) return;
      const p = reduce ? 1 : (progress.current ?? 0);
      const k = 1 - Math.pow(1 - clamp((p - 0.12) / 0.38), 3);
      ctx.clearRect(0, 0, c.width, c.height);
      // a wide pulse of heat leaves the left vault and arrives at the right one
      const phase = reduce ? 0.5 : ((now / 4200) % 1) * 1.6 - 0.3;
      for (const cell of cells) {
        if (!reduce && Math.random() < 0.14) continue; // sensor grain
        const u = cell.x / w - phase;
        const heat = (0.17 + cell.r * 0.1 + 0.78 * Math.exp(-(u * u) / 0.03)) * (0.4 + 0.6 * k);
        const x = cell.x + cell.jx + cell.ox * (1 - k);
        const y = cell.y + cell.jy + cell.oy * (1 - k);
        const s = step * (0.38 + 0.5 * clamp(heat));
        ctx.fillStyle = heatColor(heat);
        ctx.globalAlpha = 0.25 + 0.75 * k;
        ctx.fillRect(x, y, s, s);
      }
      ctx.globalAlpha = 1;
    };

    build();
    const ro = new ResizeObserver(() => build());
    ro.observe(c);
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(c);
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, [text, progress]);

  return <canvas ref={ref} className="dots" role="img" aria-label={text} />;
}

function Network() {
  const sec = useRef<HTMLElement>(null);
  const p = useRef(0);
  useProgress(sec, (v) => (p.current = v), "view");
  return (
    <section ref={sec} className="network">
      <div className="dots-wrap">
        <DotMatrix text="vault to vault" progress={p} />
        <span className="mono dots-end dots-l">burn</span>
        <span className="mono dots-end dots-r">mint</span>
      </div>
      <div className="network-copy" data-reveal>
        <p className="mono eyebrow">fig. 05 — members</p>
        <p className="body">
          between member institutions, a network transfer burns the payer’s protected token and mints the
          payee’s. the underlying moves straight from one vault to the other.
        </p>
      </div>
    </section>
  );
}

/* ───────────────────────── hold to open ───────────────────────── */

function Hold() {
  const router = useRouter();
  const btn = useRef<HTMLButtonElement>(null);
  const u = useRef<Uniforms>({
    u_c1: hex("#ffe7b0"),
    u_c2: hex("#ff4a2a"),
    u_bg: hex(P.ink),
    u_center: [0.5, 0.58],
    u_rad: 0.2,
    u_star: 0.35,
  });

  useEffect(() => {
    const b = btn.current!;
    let h = 0,
      down = false,
      raf = 0,
      last = performance.now(),
      done = false;
    const label = b.querySelector(".hold-label")!;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      h = clamp(h + (down ? dt / 1.3 : -dt * 1.6));
      b.style.setProperty("--h", h.toFixed(3));
      u.current.u_rad = 0.2 + h * 0.22;
      u.current.u_star = 0.35 + h * 1.3;
      u.current.u_c2 = mix3(hex("#ff4a2a"), hex("#ff2a8a"), h);
      if (h >= 1 && !done) {
        done = true;
        label.textContent = "opening…";
        router.push("/onboard");
      }
    };
    raf = requestAnimationFrame(loop);
    const start = (e: Event) => {
      e.preventDefault();
      down = true;
    };
    const stop = () => (down = false);
    const key = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        down = e.type === "keydown";
      }
    };
    b.addEventListener("pointerdown", start);
    window.addEventListener("pointerup", stop);
    b.addEventListener("pointerleave", stop);
    b.addEventListener("keydown", key);
    b.addEventListener("keyup", key);
    return () => {
      cancelAnimationFrame(raf);
      b.removeEventListener("pointerdown", start);
      window.removeEventListener("pointerup", stop);
      b.removeEventListener("pointerleave", stop);
      b.removeEventListener("keydown", key);
      b.removeEventListener("keyup", key);
    };
  }, [router]);

  return (
    <section className="hold fade-edges">
      <Shader frag={ORB} uniforms={u} className="gl" quality={0.8} />
      <div className="hold-copy">
        <h2 className="brat hold-title" data-reveal>
          put your hand on it.
        </h2>
        <div className="hold-act">
        <button ref={btn} className="hold-btn" type="button" aria-label="press and hold to open a vault">
          <span className="hold-fill" aria-hidden />
          <span className="hold-label mono">press &amp; hold to open a vault</span>
        </button>
        <p className="mono hold-hint">or just <Link href="/vaults">open the app</Link></p>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="foot">
      <div className="foot-mark">
        <ThermalPalm size={44} temp="warm" />
        <span className="brat">palmfi</span>
      </div>
      <nav className="mono foot-links">
        <Link href="/vaults">app</Link>
        <Link href="/onboard">onboard</Link>
        <Link href="/institution">institutions</Link>
        <a href="https://github.com/SachPlayZ/palmfi">github</a>
      </nav>
      <p className="mono foot-small">© 2026 palmfi · body heat not required, but appreciated.</p>
    </footer>
  );
}
