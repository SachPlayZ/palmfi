"use client";

import { useEffect, useId, useRef, type CSSProperties, type ElementType, type ReactNode } from "react";

const reduced = () => typeof window !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ───────────────────────── reveal ─────────────────────────
   Sets data-in once the element enters the viewport; children with .rv come into focus in turn. */
export function Reveal({
  as: Tag = "div",
  children,
  className = "",
  style,
  threshold = 0.2,
}: {
  as?: ElementType;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  threshold?: number;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          el.dataset.in = "";
          io.disconnect();
        }
      },
      { threshold, rootMargin: "0px 0px -6% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return (
    <Tag ref={ref} className={`reveal ${className}`} style={style}>
      {children}
    </Tag>
  );
}

/* ───────────────────────── scroll progress ─────────────────────────
   Writes --p (0 → 1) on the element: while it crosses the viewport, or, when `pinned`, while its
   extra height scrolls past a sticky child. The callback drives JS-side scenes. */
export function useScroll<T extends HTMLElement>(pinned = false, onProgress?: (p: number, el: T) => void) {
  const ref = useRef<T>(null);
  const cb = useRef(onProgress);
  cb.current = onProgress;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const tick = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const vh = innerHeight;
      const raw = pinned ? -r.top / Math.max(1, r.height - vh) : (vh - r.top) / (vh + r.height);
      const p = Math.min(1, Math.max(0, raw));
      el.style.setProperty("--p", p.toFixed(4));
      cb.current?.(p, el);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    tick();
    addEventListener("scroll", on, { passive: true });
    addEventListener("resize", on);
    return () => {
      removeEventListener("scroll", on);
      removeEventListener("resize", on);
      cancelAnimationFrame(raf);
    };
  }, [pinned]);
  return ref;
}

/** Calls fn(t), t eased 0 → 1, over `ms` once on mount. */
export function useIntro(ms: number, fn: (t: number) => void) {
  const cb = useRef(fn);
  cb.current = fn;
  useEffect(() => {
    if (reduced()) return cb.current(1);
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const x = Math.min(1, (t - t0) / ms);
      cb.current(1 - Math.pow(1 - x, 3));
      if (x < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ms]);
}

/* ───────────────────────── body-heat cursor ─────────────────────────
   The whole page is a thermal camera pointed at you. Wherever the pointer moves it leaves warmth
   that spreads and cools: a coarse grid (one cell per 9px), diffused and decayed each frame and
   painted through the thermal ramp, upscaled smooth. Sleeps when everything has cooled. */
const RAMP: [number, number, number, number][] = [
  [0, 20, 14, 80],
  [0.18, 30, 64, 224],
  [0.34, 24, 166, 230],
  [0.48, 31, 209, 138],
  [0.6, 184, 236, 60],
  [0.72, 255, 226, 58],
  [0.84, 255, 154, 31],
  [1, 255, 58, 31],
];

export function HeatTrail() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx || !matchMedia("(pointer: fine)").matches || reduced()) return;

    const lut = new Uint8ClampedArray(1024);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let k = 0;
      while (k < RAMP.length - 2 && t > RAMP[k + 1][0]) k++;
      const [a, ...ca] = RAMP[k];
      const [b, ...cb] = RAMP[k + 1];
      const f = Math.min(1, Math.max(0, (t - a) / (b - a)));
      for (let c = 0; c < 3; c++) lut[i * 4 + c] = ca[c] + (cb[c] - ca[c]) * f;
      lut[i * 4 + 3] = Math.min(255, Math.pow(t, 0.7) * 320);
    }

    const CELL = 9;
    let W = 0, H = 0;
    let heat = new Float32Array(0), next = new Float32Array(0);
    let img = ctx.createImageData(1, 1);
    const size = () => {
      W = Math.ceil(innerWidth / CELL);
      H = Math.ceil(innerHeight / CELL);
      cv.width = W;
      cv.height = H;
      heat = new Float32Array(W * H);
      next = new Float32Array(W * H);
      img = ctx.createImageData(W, H);
    };
    size();

    let raf = 0, px = -1, py = -1;
    const deposit = (x: number, y: number, amt: number) => {
      const cx = x / CELL, cy = y / CELL, R = 4;
      for (let j = Math.max(0, Math.floor(cy - R)); j < Math.min(H, cy + R); j++)
        for (let i = Math.max(0, Math.floor(cx - R)); i < Math.min(W, cx + R); i++) {
          const d = ((i - cx) ** 2 + (j - cy) ** 2) / (R * R);
          if (d < 1) heat[j * W + i] = Math.min(1.2, heat[j * W + i] + amt * (1 - d) * (1 - d));
        }
    };
    const frame = () => {
      raf = 0;
      let live = 0;
      for (let j = 0; j < H; j++)
        for (let i = 0; i < W; i++) {
          const k = j * W + i;
          const n = (i > 0 ? heat[k - 1] : 0) + (i < W - 1 ? heat[k + 1] : 0) + (j > 0 ? heat[k - W] : 0) + (j < H - 1 ? heat[k + W] : 0);
          const v = (heat[k] * 0.6 + n * 0.1) * 0.966;
          next[k] = v < 0.004 ? 0 : v;
          live += next[k];
        }
      [heat, next] = [next, heat];
      const d = img.data;
      for (let k = 0; k < heat.length; k++) {
        const li = Math.min(255, (heat[k] * 255) | 0) * 4;
        d[k * 4] = lut[li];
        d[k * 4 + 1] = lut[li + 1];
        d[k * 4 + 2] = lut[li + 2];
        d[k * 4 + 3] = lut[li + 3];
      }
      ctx.putImageData(img, 0, 0);
      if (live > 0.01) raf = requestAnimationFrame(frame);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const x = e.clientX, y = e.clientY;
      if (px < 0) [px, py] = [x, y];
      const dist = Math.hypot(x - px, y - py);
      const steps = Math.max(1, Math.ceil(dist / (CELL * 2)));
      const amt = Math.min(0.5, 0.05 + dist / 900) / steps;
      for (let s = 1; s <= steps; s++) deposit(px + ((x - px) * s) / steps, py + ((y - py) * s) / steps, amt);
      [px, py] = [x, y];
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const leave = () => (px = -1);
    addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    addEventListener("resize", size);
    return () => {
      removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
      removeEventListener("resize", size);
      cancelAnimationFrame(raf);
    };
  }, []);
  return <canvas ref={ref} className="heat-trail" aria-hidden />;
}

/* ───────────────────────── chalk rays ─────────────────────────
   Pastel chalk strokes from one point on black paper: roughened by displacement, eaten by grain,
   drawn outward via stroke-dashoffset. */
const CHALK = ["#f2e6d8", "#e86a9a", "#7f8cff", "#ff5a3c", "#9ad08a", "#ffb03a", "#c9a4ff", "#ff8fa8", "#6fc3ff", "#f7d36a"];
const r2 = (v: number) => Math.round(v * 100) / 100;

export function ChalkRays({ rays = 30, seed = 7, className = "" }: { rays?: number; seed?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const list = Array.from({ length: rays }, (_, i) => ({
    a: (i / rays) * 360 + rnd() * 10,
    len: 0.5 + rnd() * 0.55,
    w: 3 + rnd() * 6,
    c: CHALK[Math.floor(rnd() * CHALK.length)],
    dash: rnd() < 0.2,
    d: rnd(),
  }));
  return (
    <svg viewBox="-500 -500 1000 1000" className={`rays ${className}`} aria-hidden preserveAspectRatio="xMidYMid slice">
      <defs>
        <filter id={`${id}-c`} x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="5" result="g" />
          <feDisplacementMap in="SourceGraphic" in2="g" scale="5" result="rough" />
          <feColorMatrix in="g" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.2 1.55" result="holes" />
          <feComposite in="rough" in2="holes" operator="in" />
        </filter>
      </defs>
      <g filter={`url(#${id}-c)`} strokeLinecap="round">
        {list.map((ray, i) => {
          const L = Math.round(700 * ray.len);
          const rad = (ray.a * Math.PI) / 180;
          return (
            <line
              key={i}
              className="ray"
              x1={r2(Math.cos(rad) * 16)}
              y1={r2(Math.sin(rad) * 16)}
              x2={r2(Math.cos(rad) * L)}
              y2={r2(Math.sin(rad) * L)}
              stroke={ray.c}
              strokeWidth={r2(ray.w)}
              strokeDasharray={ray.dash ? "3 22" : `${L} ${L}`}
              style={{ "--len": L, "--d": r2(ray.d) } as CSSProperties}
              opacity={r2(0.5 + ray.d * 0.5)}
            />
          );
        })}
      </g>
    </svg>
  );
}

/** Four-point sparkle: the white-hot light at the centre of a flame. */
export function Sparkle({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="-50 -50 100 100" className={className} aria-hidden>
      <path d="M0 -48 Q4 -4 48 0 Q4 4 0 48 Q-4 4 -48 0 Q-4 -4 0 -48Z" fill="currentColor" />
    </svg>
  );
}
