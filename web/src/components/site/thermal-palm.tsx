import { useId } from "react";
import { FINGERS, PALM } from "./hand";

// The logo: one palm drawn as nested heat bands, outer (cool) to inner (hot),
// like a thermal camera print. Each band is the same hand, inset a little more.
// A turbulence filter makes the edges wobble like paint and adds sensor grain.

export type Temp = "hot" | "warm" | "cold";

// outer -> inner. last entry is the palm-only core.
const BANDS: Record<Temp, string[]> = {
  hot: ["#3d3fff", "#38cc8e", "#ffd34d", "#ff2a1f", "#ff8a3d"],
  warm: ["#3d3fff", "#3d3fff", "#38cc8e", "#ffd34d", "#ff7a1f"],
  cold: ["#121648", "#2a2fbf", "#4f6bff", "#9db4ff", "#e6efff"],
};

// how much each band grows (+) or shrinks (-) the hand, in hand units
const INSET = [5, 1.5, -2, -4.6];

export function ThermalPalm({
  temp = "hot",
  size = 40,
  breathe = true,
  className,
  title,
}: {
  temp?: Temp;
  size?: number;
  breathe?: boolean;
  className?: string;
  title?: string;
}) {
  const id = useId().replace(/:/g, "");
  const c = BANDS[temp];
  const fine = size >= 80;
  return (
    <svg
      viewBox="-4 4 108 112"
      width={size}
      height={(size * 112) / 108}
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <defs>
        {/* bands bleed softly into each other, edges wobble a touch like warm air */}
        <filter id={`th-${id}`} x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="3" result="w" />
          <feDisplacementMap in="SourceGraphic" in2="w" scale={fine ? 3 : 2} xChannelSelector="R" yChannelSelector="G" result="d" />
          <feGaussianBlur in="d" stdDeviation={fine ? 1.6 : 0.6} />
        </filter>
      </defs>
      <g filter={`url(#th-${id})`}>
        {INSET.map((k, i) => (
          <g key={i} fill={c[i]} stroke={c[i]} strokeLinecap="round">
            <ellipse cx={PALM.cx} cy={PALM.cy} rx={PALM.rx + k} ry={PALM.ry + k} stroke="none" />
            {FINGERS.map((g, j) => (
              <line
                key={j}
                x1={g.a[0]}
                y1={g.a[1]}
                x2={g.b[0]}
                y2={g.b[1]}
                strokeWidth={Math.max(1.5, (g.r + k) * 2)}
              />
            ))}
          </g>
        ))}
        {/* palm core: hottest spot, slightly off-centre like a real reading */}
        <ellipse cx={PALM.cx + 2} cy={PALM.cy + 3} rx={PALM.rx * 0.48} ry={PALM.ry * 0.42} fill={c[4]}>
          {breathe && <animate attributeName="rx" values={`${PALM.rx * 0.44};${PALM.rx * 0.56};${PALM.rx * 0.44}`} dur="3.6s" repeatCount="indefinite" />}
        </ellipse>
      </g>
    </svg>
  );
}
