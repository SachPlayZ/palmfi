import { HAND_GLSL } from "./hand";

const HEAD = `
precision highp float;
uniform vec2 u_res;
uniform float u_t;
uniform float u_dpr;
const vec3 INK = vec3(.043, .039, .051); // #0b0a0d, the page black
float hash(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1.,0.)), u.x), mix(hash(i+vec2(0.,1.)), hash(i+vec2(1.,1.)), u.x), u.y);
}
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ v += a*noise(p); p = p*2.03 + 1.7; a *= 0.5; } return v; }
// per-frame sensor grain, sampled on device pixels
float grain(){ return hash(gl_FragCoord.xy + fract(u_t * 7.13) * vec2(97.1, 53.7)); }
`;

/* ─────────── hero: thermal camera looking at a palm ─────────── */
export const THERMAL = `${HEAD}
uniform vec3 u_trail[16];   // css px (x, y-down), strength
uniform vec2 u_palm;        // css px centre of palm box
uniform float u_size;       // css px per 100 hand units
uniform float u_cool;       // 0 warm .. 1 cold (scroll)

float sdSeg(vec2 p, vec2 a, vec2 b){ vec2 pa = p-a, ba = b-a; float h = clamp(dot(pa,ba)/dot(ba,ba), 0., 1.); return length(pa - ba*h); }
float smin(float a, float b, float k){ float h = clamp(.5 + .5*(b-a)/k, 0., 1.); return mix(b, a, h) - k*h*(1.-h); }
${HAND_GLSL}

vec3 thermal(float x){
  vec3 c = INK;
  c = mix(c, vec3(.10, .08, .24), smoothstep(.06, .16, x));
  c = mix(c, vec3(.24, .25, 1.0), smoothstep(.16, .30, x));
  c = mix(c, vec3(.22, .80, .56), smoothstep(.30, .44, x));
  c = mix(c, vec3(1.0, .84, .30), smoothstep(.44, .58, x));
  c = mix(c, vec3(1.0, .48, .12), smoothstep(.58, .70, x));
  c = mix(c, vec3(1.0, .17, .13), smoothstep(.70, .84, x));
  c = mix(c, vec3(1.0, .80, .88), smoothstep(.93, 1.08, x));
  return c;
}

void main(){
  vec2 res = u_res / u_dpr;
  vec2 px = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y) / u_dpr;
  float t = u_t;

  // palm, gently warped like air shimmer
  vec2 hp = (px - u_palm) / (u_size / 100.) + vec2(54., 66.);
  hp += (vec2(fbm(hp*.045 + vec2(t*.18, 0.)), fbm(hp*.045 + vec2(7.3, -t*.14))) - .5) * 9.;
  float d = hand(hp);
  float v = d < 0. ? .32 - d/19. : .32 * exp(-d/9.);
  v += .035 * sin(t*1.25) * smoothstep(0., -10., d);
  v = min(v, 1.05) * mix(1., .3, u_cool);

  // your cursor is warm too
  float r = res.y * .07;
  for (int i = 0; i < 16; i++){
    vec2 q = px - u_trail[i].xy;
    v += u_trail[i].z * exp(-dot(q,q) / (r*r));
  }

  // ambient room noise
  vec2 uv = px / res.y;
  v += (fbm(uv*2.4 + vec2(t*.03, -t*.02)) - .45) * .12;

  // quantise with dither -> painted bands with grainy edges
  float g = grain();
  float N = 9.;
  float vq = floor(v*N + (g - .5)*1.1 + .5) / N;
  vec3 col = thermal(vq);
  col += (g - .5) * .09;
  float vig = smoothstep(1.25, .2, length((px - res*.5) / res.y));
  col = mix(INK, col, mix(.35, 1., vig));
  gl_FragColor = vec4(col, 1.);
}`;

/* ─────────── freeze: grainy fluid that cools from warm to ice as you scroll ─────────── */
export const FLUID = `${HEAD}
uniform float u_p;     // 0 warm .. 1 frozen
uniform float u_flow;  // time that slows down as it freezes
void main(){
  vec2 uv = gl_FragCoord.xy / u_res.y;
  float t = u_flow;
  vec2 q = vec2(fbm(uv*1.5 + t), fbm(uv*1.5 - t + 3.1));
  vec2 w = vec2(fbm(uv*1.7 + 2.4*q + vec2(1.7, 9.2) + t*.7), fbm(uv*1.7 + 2.4*q + vec2(8.3, 2.8) - t*.5));
  float f = fbm(uv*1.3 + 2.2*w);
  float m = smoothstep(.46, .78, f);
  // keep the middle calm so the type reads
  vec2 c = (gl_FragCoord.xy - u_res*.5) / u_res.y;
  m *= mix(.35, 1., smoothstep(.12, .62, length(c * vec2(.75, 1.25))));
  float g = grain();
  float k = mix(m, step(g, m), .6);
  float cold = smoothstep(.15, .85, u_p);
  vec3 hot  = mix(vec3(1., .48, .12), vec3(1., .48, .72), w.x);   // orange -> pink
  vec3 ice  = mix(vec3(.24, .25, 1.), vec3(.80, .86, 1.), w.y);   // indigo -> ice
  vec3 tint = mix(hot, ice, cold);
  vec3 col = mix(INK, tint, k * .85);
  col += (g - .5) * .07;
  gl_FragColor = vec4(col, 1.);
}`;

/* ─────────── orb: stippled glow, candle / mood light ─────────── */
export const ORB = `${HEAD}
uniform vec3 u_c1;      // core
uniform vec3 u_c2;      // rim
uniform vec3 u_bg;
uniform vec2 u_center;  // 0..1 of canvas
uniform float u_rad;    // fraction of min side
uniform float u_star;   // 0..1 star flare
void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (uv - u_center) * u_res / min(u_res.x, u_res.y);
  float t = u_t;
  vec2 w = vec2(fbm(p*2. + t*.12), fbm(p*2. - t*.1 + 4.)) - .5;
  vec2 pp = p + w*.18;
  pp.y *= .82;                                    // a touch taller, like a flame
  float d = length(pp) / u_rad;
  float m = 1. - smoothstep(.0, 1.05, d);
  m = pow(m, 1.25);
  float g = grain();
  float s = step(g, m);
  float k = mix(m, s, .62);
  vec3 tint = mix(u_c2, u_c1, smoothstep(.15, .85, m + w.x*.4));
  vec3 col = mix(u_bg, tint, k);
  // four-point sparkle at the heart
  vec2 a = abs(p) / max(u_rad, .001);
  float star = .012 / max(a.x * a.y * 9. + .002, .0001) * smoothstep(.55, 0., length(a));
  star += .03 / (length(a) + .03) * .35;
  col += vec3(1., .97, .99) * clamp(star, 0., 1.6) * u_star;
  col += (g - .5) * .08;
  gl_FragColor = vec4(col, 1.);
}`;
