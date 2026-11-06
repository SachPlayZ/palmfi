"use client";

import { useEffect, useRef, type RefObject } from "react";

export type Uniforms = Record<string, number | number[] | Float32Array>;

const VERT = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";

/**
 * Full-bleed fragment shader canvas. Renders only while on screen.
 * Built-ins: u_res (device px), u_t (seconds), u_dpr.
 * Uniform values: number -> float, [a,b(,c,d)] -> vecN, Float32Array -> vec3[].
 */
export function Shader({
  frag,
  uniforms,
  className,
  quality = 1,
}: {
  frag: string;
  uniforms?: RefObject<Uniforms>;
  className?: string;
  quality?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const gl = c.getContext("webgl", { antialias: false, premultipliedAlpha: false, alpha: true });
    if (!gl) {
      c.dataset.fallback = "1";
      return;
    }

    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) console.error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    const locs = new Map<string, WebGLUniformLocation | null>();
    const loc = (n: string) => {
      if (!locs.has(n)) locs.set(n, gl.getUniformLocation(prog, n));
      return locs.get(n)!;
    };

    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let dpr = 1;
    const resize = () => {
      const r = c.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 1.5) * quality;
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      gl.viewport(0, 0, c.width, c.height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(c);

    let visible = false;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), { rootMargin: "100px" });
    io.observe(c);

    const t0 = performance.now();
    let raf = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (!visible) return;
      gl.uniform2f(loc("u_res"), c.width, c.height);
      gl.uniform1f(loc("u_t"), reduce ? 6 : (now - t0) / 1000);
      gl.uniform1f(loc("u_dpr"), dpr);
      const u = uniforms?.current;
      if (u)
        for (const k in u) {
          const v = u[k];
          const l = loc(k);
          if (l === null) continue;
          if (typeof v === "number") gl.uniform1f(l, v);
          else if (v instanceof Float32Array) gl.uniform3fv(l, v);
          else if (v.length === 2) gl.uniform2f(l, v[0], v[1]);
          else if (v.length === 3) gl.uniform3f(l, v[0], v[1], v[2]);
          else if (v.length === 4) gl.uniform4f(l, v[0], v[1], v[2], v[3]);
        }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      gl.deleteProgram(prog);
      gl.deleteBuffer(buf);
    };
  }, [frag, uniforms, quality]);

  return <canvas ref={ref} className={className} aria-hidden />;
}
