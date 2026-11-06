"use client";

import { useId, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";

/* ───────────────────────── the hand ─────────────────────────
   An open right palm, thumb out to the left. Fingers are tapered paths (wide at the knuckle,
   narrow and rounded at the tip, slightly bowed) on a palm with a thenar bulge and a rounded heel,
   so the silhouette reads as a real hand. The mark and the live heat map are both drawn from it. */
export const HAND_VIEWBOX = "0 0 400 460";

type Finger = { bx: number; by: number; a: number; len: number; wb: number; wt: number };
const FINGERS: Finger[] = [
  { bx: 141, by: 214, a: -13, len: 172, wb: 42, wt: 30 }, // index
  { bx: 189, by: 202, a: -3, len: 198, wb: 44, wt: 31 }, // middle
  { bx: 238, by: 206, a: 8, len: 180, wb: 42, wt: 29 }, // ring
  { bx: 283, by: 226, a: 21, len: 138, wb: 36, wt: 25 }, // little
  { bx: 146, by: 336, a: -57, len: 146, wb: 54, wt: 34 }, // thumb
];
const PALM =
  "M118 222 C112 262 116 300 132 338 C140 372 150 404 178 420 C205 434 250 432 272 412 C300 386 312 330 310 262 C308 240 304 228 298 222 Q210 186 118 222 Z";

const f1 = (v: number) => Math.round(v * 10) / 10;

function fingerPath({ bx, by, a, len, wb, wt }: Finger) {
  const r = (a * Math.PI) / 180;
  const dx = Math.sin(r), dy = -Math.cos(r); // along the finger
  const nx = Math.cos(r), ny = Math.sin(r); // across it
  const tx = bx + dx * (len - wt / 2), ty = by + dy * (len - wt / 2);
  const mx = bx + dx * len * 0.5, my = by + dy * len * 0.5;
  const bow = (wb + wt) * 0.06; // knuckle swell on both sides
  const P = (x: number, y: number) => `${f1(x)} ${f1(y)}`;
  return [
    `M${P(bx - (nx * wb) / 2, by - (ny * wb) / 2)}`,
    `Q${P(mx - nx * ((wb + wt) / 4 + bow), my - ny * ((wb + wt) / 4 + bow))} ${P(tx - (nx * wt) / 2, ty - (ny * wt) / 2)}`,
    `A${f1(wt / 2)} ${f1(wt / 2)} 0 0 1 ${P(tx + (nx * wt) / 2, ty + (ny * wt) / 2)}`,
    `Q${P(mx + nx * ((wb + wt) / 4 + bow), my + ny * ((wb + wt) / 4 + bow))} ${P(bx + (nx * wb) / 2, by + (ny * wb) / 2)}`,
    "Z",
  ].join(" ");
}
const FINGER_PATHS = FINGERS.map(fingerPath);
/** Fingertip centres, where a real hand runs warm. */
export const TIPS = FINGERS.map(({ bx, by, a, len, wt }) => {
  const r = (a * Math.PI) / 180;
  return { x: f1(bx + Math.sin(r) * (len - wt * 0.9)), y: f1(by - Math.cos(r) * (len - wt * 0.9)), r: f1(wt * 0.62) };
});

export function HandShapes() {
  return (
    <>
      <path d={PALM} />
      {FINGER_PATHS.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </>
  );
}

/* ───────────────────────── the mark ─────────────────────────
   The logo: a painted thermal handprint. The same silhouette drawn with shrinking strokes gives
   concentric bands (cold rim to hot core), then a hot palm and warm fingertips on top. */
export function PalmMark({ size = 32, className = "", title = "palmfi" }: { size?: number; className?: string; title?: string }) {
  const bands: [string, number][] = [
    ["#2440d8", 26],
    ["#14b4c8", 15],
    ["#3fd27a", 6],
  ];
  return (
    <svg viewBox="-24 -24 448 484" width={size} height={size} className={className} role="img" aria-label={title}>
      {bands.map(([c, w]) => (
        <g key={c} fill={c} stroke={c} strokeWidth={w} strokeLinejoin="round">
          <HandShapes />
        </g>
      ))}
      <g fill="#f5d33a">
        <HandShapes />
      </g>
      <ellipse cx="214" cy="318" rx="74" ry="80" fill="#ff8a1f" />
      <ellipse cx="210" cy="324" rx="50" ry="56" fill="#f1361f" />
      {TIPS.slice(0, 4).map((t, i) => (
        <circle key={i} cx={t.x} cy={t.y} r={t.r * 0.8} fill="#f1361f" />
      ))}
    </svg>
  );
}

/* ───────────────────────── the live heat map ─────────────────────────
   Heat comes from where a hand is actually warm, not from blurring the whole shape:
     · body   – the silhouette, barely blurred, so the outline stays crisp (cool cyan fingers, blue edge)
     · warm   – a broad glow across the palm (green channel of the source)
     · hot    – the palm core, the fingertips and the pointer (red channel)
   plus slow mottling noise, mapped through a thermal ramp, clipped to the hand, with a thin
   cyan halo outside it. `heat` scales the warm sources; `cold` crossfades to a frozen ramp. */

const RAMP_WARM = {
  r: "0.05 0.12 0.10 0.20 0.45 1 1 0.96 1",
  g: "0.03 0.25 0.62 0.86 0.92 0.88 0.52 0.16 0.46",
  b: "0.35 0.90 0.95 0.86 0.35 0.20 0.10 0.14 0.58",
};
const RAMP_COLD = {
  r: "0.02 0.05 0.10 0.20 0.38 0.60 0.80 0.92 1",
  g: "0.03 0.10 0.24 0.46 0.66 0.82 0.92 0.97 1",
  b: "0.16 0.42 0.78 0.94 1 1 1 1 1",
};

export function ThermalPalm({
  heat = 1,
  cold = 0,
  pulse = 5,
  interactive = false,
  className = "",
  style,
  label = "A thermal heat-map of an open palm",
}: {
  heat?: number;
  cold?: number;
  pulse?: number;
  interactive?: boolean;
  className?: string;
  style?: CSSProperties;
  label?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const [spot, setSpot] = useState<{ x: number; y: number; on: boolean }>({ x: 204, y: 300, on: false });

  const move = (e: RPointerEvent<SVGSVGElement>) => {
    if (!interactive) return;
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    setSpot({ x: ((e.clientX - r.left) / r.width) * 480 - 40, y: ((e.clientY - r.top) / r.height) * 540 - 40, on: true });
  };

  const k = Math.max(0, heat);
  const layer = (ramp: typeof RAMP_WARM, id: string, opacity: number) => (
    <g opacity={opacity} style={{ transition: "opacity .9s ease" }}>
      <defs>
        <filter id={id} filterUnits="userSpaceOnUse" x="-40" y="-40" width="480" height="540" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceAlpha" stdDeviation="6.5" result="body" />
          <feGaussianBlur in="SourceGraphic" stdDeviation="26" result="warmB">
            <animate attributeName="stdDeviation" values="24;31;24" dur={`${pulse}s`} repeatCount="indefinite" />
          </feGaussianBlur>
          <feColorMatrix in="warmB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 1 0 0 0" result="warm" />
          <feGaussianBlur in="SourceGraphic" stdDeviation="15" result="hotB" />
          <feColorMatrix in="hotB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0" result="hot" />
          <feTurbulence type="fractalNoise" baseFrequency="0.022" numOctaves="2" seed="9" result="n">
            <animate attributeName="baseFrequency" values="0.022;0.028;0.022" dur="12s" repeatCount="indefinite" />
          </feTurbulence>
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0" result="nA" />
          <feComposite in="body" in2="nA" operator="arithmetic" k1="0" k2="0.44" k3="0.36" k4="-0.18" result="h1" />
          <feComposite in="h1" in2="warm" operator="arithmetic" k1="0" k2="1" k3={0.25 * k} k4="0" result="h2" />
          <feComposite in="h2" in2="hot" operator="arithmetic" k1="0" k2="1" k3={0.36 * k} k4="0" result="heatA" />
          <feColorMatrix in="heatA" type="matrix" values="0 0 0 1 0  0 0 0 1 0  0 0 0 1 0  0 0 0 0 1" result="gray" />
          <feComponentTransfer in="gray" result="colour">
            <feFuncR type="table" tableValues={ramp.r} />
            <feFuncG type="table" tableValues={ramp.g} />
            <feFuncB type="table" tableValues={ramp.b} />
          </feComponentTransfer>
          {/* crisp clip to the hand */}
          <feGaussianBlur in="SourceAlpha" stdDeviation="0.9" result="edge" />
          <feComposite in="colour" in2="edge" operator="in" result="clipped" />
          {/* thin cool halo just outside the skin */}
          <feMorphology in="SourceAlpha" operator="dilate" radius="2" result="grown" />
          <feGaussianBlur in="grown" stdDeviation="8" result="haloA" />
          <feFlood floodColor={ramp === RAMP_COLD ? "#9fdcff" : "#2bc8ff"} floodOpacity="0.55" />
          <feComposite in2="haloA" operator="in" result="halo" />
          {/* sensor grain */}
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="2" result="g" />
          <feColorMatrix in="g" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 -2.6 1.3" result="speck" />
          <feComposite in="speck" in2="clipped" operator="in" result="speckIn" />
          <feBlend in="speckIn" in2="clipped" mode="screen" result="skin" />
          <feMerge>
            <feMergeNode in="halo" />
            <feMergeNode in="skin" />
          </feMerge>
        </filter>
      </defs>
      <g filter={`url(#${id})`}>
        <g fill="#000">
          <HandShapes />
        </g>
        {/* warm palm (green) and hot spots (red + green) */}
        <path d={PALM} fill="#00ff00" />
        <g fill="#ffff00" mask={`url(#${uid}-in)`}>
          <ellipse cx="206" cy="322" rx="44" ry="50" />
          <ellipse cx="164" cy="360" rx="18" ry="22" />
          <ellipse cx="258" cy="292" rx="16" ry="18" />
          {TIPS.map((t, i) => (
            <circle key={i} cx={t.x} cy={t.y} r={t.r * 0.55} />
          ))}
          <circle cx={spot.x} cy={spot.y} r="40" opacity={spot.on ? 1 : 0} />
        </g>
      </g>
    </g>
  );

  return (
    <svg
      ref={svgRef}
      viewBox="-40 -40 480 540"
      className={`thermal ${className}`}
      style={style}
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      onPointerMove={move}
      onPointerLeave={() => setSpot((s) => ({ ...s, on: false }))}
    >
      <defs>
        <mask id={`${uid}-in`} maskUnits="userSpaceOnUse" x="-40" y="-40" width="480" height="540">
          <g fill="#fff">
            <HandShapes />
          </g>
        </mask>
      </defs>
      {layer(RAMP_WARM, `${uid}-w`, 1 - cold)}
      {cold > 0 && layer(RAMP_COLD, `${uid}-c`, cold)}
    </svg>
  );
}
