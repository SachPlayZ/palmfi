// One palm, described once, drawn twice: as SVG strokes (logo) and as a
// signed-distance field (hero shader). Units: a 100 × 120 box, y pointing down.

export type Finger = { a: [number, number]; b: [number, number]; r: number };

export const PALM = { cx: 54, cy: 80, rx: 25, ry: 24 };

export const FINGERS: Finger[] = [
  { a: [37, 66], b: [29, 28], r: 7 }, // index
  { a: [50, 62], b: [48, 18], r: 7.5 }, // middle
  { a: [62, 64], b: [68, 25], r: 7 }, // ring
  { a: [72, 70], b: [85, 44], r: 6 }, // pinky
  { a: [36, 90], b: [11, 72], r: 8 }, // thumb
];

const f = (n: number) => n.toFixed(1);

/** GLSL body of `float hand(vec2 p)` built from the same numbers. */
export const HAND_GLSL = `
float hand(vec2 p){
  float d = (length((p - vec2(${f(PALM.cx)}, ${f(PALM.cy)})) / vec2(${f(PALM.rx)}, ${f(PALM.ry)})) - 1.0) * ${f(Math.min(PALM.rx, PALM.ry))};
${FINGERS.map(
  (g) =>
    `  d = smin(d, sdSeg(p, vec2(${f(g.a[0])}, ${f(g.a[1])}), vec2(${f(g.b[0])}, ${f(g.b[1])})) - ${f(g.r)}, 5.0);`,
).join("\n")}
  return d;
}`;
