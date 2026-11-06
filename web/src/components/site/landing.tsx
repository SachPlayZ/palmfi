"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { HandShapes, PalmMark, ThermalPalm } from "./palm";
import { ChalkRays, Reveal, Sparkle, useIntro, useScroll } from "./fx";

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const seg = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

/* ───────────────────────── nav ───────────────────────── */
export function Nav() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    let last = scrollY;
    const on = () => {
      const el = ref.current;
      if (!el) return;
      if (scrollY > last && scrollY > 400) el.dataset.hide = "";
      else delete el.dataset.hide;
      last = scrollY;
    };
    addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, []);
  return (
    <header ref={ref} className="nav">
      <Link href="/" className="brand" aria-label="palmfi home">
        <PalmMark size={26} title="" />
        <span>palmfi</span>
      </Link>
      <Link href="/vaults" className="pill">
        Open the app <span aria-hidden>↗</span>
      </Link>
    </header>
  );
}

/* ───────────────────────── hero ─────────────────────────
   On load the palm warms up from cold. Scrolling dives the camera into the hottest part of the palm
   until the screen is nothing but body-heat red, which is where the poster begins. */
export function Hero() {
  const [warm, setWarm] = useState(0);
  useIntro(2600, setWarm);
  const ref = useScroll<HTMLElement>(true, (p, el) => {
    const dive = seg(p, 0.1, 0.92);
    el.style.setProperty("--z", (1 + Math.pow(dive, 2.6) * 18).toFixed(3));
    el.style.setProperty("--t", smooth(dive).toFixed(4));
    el.style.setProperty("--out", seg(p, 0.02, 0.28).toFixed(4));
    el.style.setProperty("--red", seg(p, 0.64, 0.9).toFixed(4));
  });

  return (
    <section ref={ref} className="s-hero" aria-labelledby="hero-title">
      <div className="hero-stage">
        <div className="hero-glow" aria-hidden />
        <h1 id="hero-title" className="hero-say">
          <span className="w w-l display">Say</span>
          <span className="sr-only"> </span>
          <span className="w w-r serif">no.</span>
        </h1>
        <div className="hero-zoom">
          <ThermalPalm
            interactive
            heat={lerp(0.3, 1.04, warm)}
            cold={1 - seg(warm, 0.05, 0.8)}
            label="palmfi's mark: a thermal heat-map of an open palm. Move over it to warm it."
          />
        </div>
        <div className="hero-foot">
          <p className="hero-lede">
            Your keys can be stolen.
            <br />
            <em className="serif">Your money can&apos;t leave faster than you can say no.</em>
          </p>
          <Link href="/onboard" className="btn btn-hot">
            Open a vault
          </Link>
        </div>
        <span className="hero-scroll mono" aria-hidden>
          scroll · feel the heat
        </span>
        <div className="hero-red" aria-hidden />
      </div>
    </section>
  );
}

/* ───────────────────────── red poster ───────────────────────── */
export function Poster() {
  const ref = useScroll<HTMLElement>();
  return (
    <section ref={ref} className="s-poster" aria-labelledby="poster-title">
      <p className="mono poster-date">29 · 10 · 2026</p>
      <h2 id="poster-title" className="display poster-big">
        $2.5B
      </h2>
      <p className="serif poster-line">gone in one signature.</p>
      <p className="poster-copy">
        The attackers never took the keys. They got the signer to sign. palmfi puts the brakes where a valid signature can&apos;t reach.
      </p>
    </section>
  );
}

/* ───────────────────────── three temperatures (pinned) ───────────────────────── */
const STATES = [
  { word: "Spend", title: "Small stays instant.", body: "Everyday amounts leave right away, from a budget that refills over 24 hours." },
  { word: "Wait", title: "Big becomes a request.", body: "An independent Chainlink Sentinel gets time to say no. Even a clear waits 15 minutes." },
  { word: "Freeze", title: "Then everything goes cold.", body: "A flag freezes the vault. Funds can only go to the recovery vault you chose on day one." },
];
const T_MIN = -10, T_MAX = 45;

export function States() {
  const [p, setP] = useState(0);
  const ref = useScroll<HTMLElement>(true, (v) => setP(v));
  const step = p < 0.36 ? 0 : p < 0.68 ? 1 : 2;
  const heat = lerp(0.95, 1.18, seg(p, 0.28, 0.42)) * (1 - seg(p, 0.64, 0.8) * 0.5);
  const cold = seg(p, 0.62, 0.8);
  const temp = p < 0.62 ? lerp(36.6, 41.8, seg(p, 0.28, 0.42)) : lerp(41.8, -4, seg(p, 0.62, 0.8));
  const s = STATES[step];

  return (
    <section ref={ref} id="how" className="s-states" data-step={step} aria-labelledby="how-title">
      <div className="states-stage">
        <h2 id="how-title" className="mono states-kicker">
          <span>How it says no</span>
          <span aria-hidden>0{step + 1} / 03</span>
        </h2>

        <div className="states-word display" aria-hidden>
          {STATES.map((x, i) => (
            <span key={x.word} data-on={i === step ? "" : undefined}>
              {x.word}
            </span>
          ))}
        </div>

        <div className="states-palm">
          <ThermalPalm heat={heat} cold={cold} pulse={step === 1 ? 1.3 : 5} label="" />
        </div>

        <div className="states-foot">
          <p className="states-temp mono" aria-hidden>
            {temp.toFixed(1)}°
          </p>
          <div className="states-copy" aria-hidden>
            <b className="serif">{s.title}</b>
            <span>{s.body}</span>
          </div>
          <div className="states-scale" aria-hidden>
            <i style={{ left: `${((temp - T_MIN) / (T_MAX - T_MIN)) * 100}%` }} />
          </div>
        </div>

        <ol className="sr-only">
          {STATES.map((x) => (
            <li key={x.word}>
              {x.word}. {x.title} {x.body}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ───────────────────────── principles, as a slow drift ───────────────────────── */
const RULES: [string, string][] = [
  ["Bound", "what a signature can do"],
  ["Delay", "so someone can say no"],
  ["Commit", "where rescued funds go"],
  ["Share", "one incident with everyone"],
];

export function Drift() {
  const ref = useScroll<HTMLElement>();
  const row = (hidden: boolean) => (
    <span className="drift-row" aria-hidden={hidden || undefined}>
      {RULES.map(([w, t]) => (
        <span key={w} className="drift-item">
          <em className="serif">{w}</em> {t}
          <PalmMark size={40} title="" className="drift-mark" />
        </span>
      ))}
    </span>
  );
  return (
    <section ref={ref} className="s-drift" aria-label="Written into the contract">
      <div className="drift-track">
        {row(false)}
        {row(true)}
      </div>
    </section>
  );
}

/* ───────────────────────── hold to sign ─────────────────────────
   Press and hold: your hand warms the print. Let go early and it cools away, nothing moves. */
type SignState = "idle" | "holding" | "signed" | "cooled";

export function HoldToSign() {
  const [level, setLevel] = useState(0);
  const [state, setState] = useState<SignState>("idle");
  const holding = useRef(false);
  const lv = useRef(0);
  const raf = useRef(0);

  const loop = useCallback(() => {
    let last = performance.now();
    const tick = (t: number) => {
      const dt = (t - last) / 1000;
      last = t;
      lv.current = clamp(lv.current + (holding.current ? dt / 1.6 : -dt / 2.4));
      setLevel(lv.current);
      if (holding.current && lv.current >= 1) {
        holding.current = false;
        setState("signed");
        return;
      }
      if (!holding.current && lv.current <= 0) return;
      raf.current = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(tick);
  }, []);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const start = () => {
    if (state === "signed") return;
    holding.current = true;
    setState("holding");
    loop();
  };
  const stop = () => {
    if (!holding.current) return;
    holding.current = false;
    setState(lv.current >= 1 ? "signed" : "cooled");
    loop();
  };
  const reset = () => {
    lv.current = 0;
    setLevel(0);
    setState("idle");
  };

  const line =
    state === "signed"
      ? "Signed · $8,000 leaves after the 15-minute floor"
      : state === "holding"
        ? `Warming · ${Math.round(level * 100)}%`
        : state === "cooled"
          ? "Your hand left. Nothing moved."
          : "Press and hold · $8,000 → 0x9fe…e10";

  return (
    <section id="sign" className="s-sign" aria-labelledby="sign-title">
      <Reveal className="sign-copy">
        <h2 id="sign-title" className="stack rv">
          <span className="display">Big moves need</span>
          <span className="serif">your hand on it.</span>
        </h2>
      </Reveal>

      <div className="sign-pad">
        <button
          type="button"
          className="scanner"
          data-state={state}
          style={{ "--lv": level } as CSSProperties}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            start();
          }}
          onPointerUp={stop}
          onPointerCancel={stop}
          onKeyDown={(e) => {
            if ((e.key === " " || e.key === "Enter") && !e.repeat) {
              e.preventDefault();
              start();
            }
          }}
          onKeyUp={(e) => {
            if (e.key === " " || e.key === "Enter") stop();
          }}
          onContextMenu={(e) => e.preventDefault()}
          aria-label="Press and hold to sign the $8,000 request"
        >
          <svg className="scan-ghost" viewBox="-40 -40 480 540" aria-hidden>
            <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeDasharray="1 10" strokeLinecap="round">
              <HandShapes />
            </g>
          </svg>
          <span className="scan-heat">
            <ThermalPalm heat={0.5 + level * 0.6} cold={1 - level} pulse={state === "holding" ? 1.1 : 5} label="" />
          </span>
        </button>
        <p className="mono sign-line" aria-live="polite">
          {line}
        </p>
        {state === "signed" || state === "cooled" ? (
          <button type="button" className="mono sign-reset" onClick={reset}>
            again ↺
          </button>
        ) : (
          <span className="sign-reset" />
        )}
        <p className="sign-note">Above your hard cap, your passkey signs the exact request and the vault checks it onchain.</p>
      </div>
    </section>
  );
}

/* ───────────────────────── network ───────────────────────── */
export function Network() {
  const ref = useScroll<HTMLElement>();
  const [alarm, setAlarm] = useState(0);
  return (
    <section ref={ref} id="network" className="s-net" data-alarm={alarm ? "" : undefined} aria-labelledby="net-title">
      <ChalkRays key={alarm} className="net-rays" rays={34} seed={23} />
      <div className="net-hole" aria-hidden />
      <Reveal className="net-copy">
        <PalmMark size={56} title="" className="net-mark rv" />
        <h2 id="net-title" className="stack rv">
          <span className="display">One bad day</span>
          <span className="serif">warns every vault.</span>
        </h2>
        <p className="rv" style={{ "--d": 1 } as CSSProperties}>
          Every ray is a member. When one is flagged, the attacker joins a shared blocklist and everyone stops paying them.
        </p>
        <div className="rv net-actions" style={{ "--d": 2 } as CSSProperties}>
          <button type="button" className="btn btn-line" onClick={() => setAlarm((a) => a + 1)}>
            Simulate an incident
          </button>
          <span className="mono" aria-live="polite">
            {alarm ? `0x9fe…e10 blocklisted · ${alarm * 71} vaults warned` : ""}
          </span>
        </div>
      </Reveal>
    </section>
  );
}

/* ───────────────────────── footer: the flame ───────────────────────── */
export function Footer() {
  const ref = useScroll<HTMLElement>();
  return (
    <footer ref={ref} className="s-foot" aria-labelledby="foot-title">
      <div className="flame" aria-hidden>
        <span className="flame-glow" />
        <Sparkle className="flame-spark" />
      </div>
      <Reveal className="foot-copy">
        <h2 id="foot-title" className="serif rv">
          Keep your hand up.
        </h2>
        <div className="foot-cta rv" style={{ "--d": 1 } as CSSProperties}>
          <Link href="/onboard" className="btn btn-hot">
            Open a vault
          </Link>
          <Link href="/vaults" className="btn btn-line">
            Open the app
          </Link>
        </div>
      </Reveal>
      <p className="display foot-word" aria-hidden>
        palmfi
      </p>
      <div className="foot-meta mono">
        <span>Ethereum Sepolia · palmfi.eth</span>
        <span>Chainlink CRE · Uniswap v4 · ENS</span>
        <a href="https://github.com/SachPlayZ/palmfi">GitHub</a>
        <span>ETHGlobal Mumbai · 2026</span>
      </div>
    </footer>
  );
}
