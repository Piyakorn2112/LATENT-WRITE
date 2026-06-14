/* ─────────────────────────────────────────────────────────────────────────
   OrbEngine — self-contained WebGL intelligence orb.

   Replaces the legacy 18-dot blurred-DOM orb (Toolbar.tsx IntelBtn /
   Onboarding.tsx HeroOrb) with a single tiny fragment-shader canvas:

     · a flowing aurora ribbon with a sharp white-hot core over soft colour
       spill — the "depth of field" read of the Siri orb reference
     · angular rim light that brightens where the ribbon meets the edge
     · soft lobed plasma halo just past the silhouette (stays circular)
     · palette interpolation in OKLab + additive blending and tonemapping
       in linear space, so colours blend vividly instead of going muddy

   GPU budget — the app is already compositing-heavy, so the engine is
   deliberately frugal:
     · one quad, one draw call, ~30×30 css px canvas in the toolbar
     · powerPreference "low-power", no depth/stencil/antialias
     · 30 fps cap; drops to 8 fps under body.scroll-edge-idle; fully
       stops on document.hidden and body.electron-window-unfocused-orb-paused
     · prefers-reduced-motion → renders exactly one frame per state change

   Reversibility — every legacy CSS class (.intel-mesh-dot etc.) is left
   untouched in styles.css. If WebGL is unavailable or the context is lost
   the engine renders the legacy markup instead, and the USE_ORB_ENGINE
   flags at the call sites flip the whole feature off in one line.
   ───────────────────────────────────────────────────────────────────────── */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import "./orb-engine.css";

export type OrbEngineMode = "off" | "fast" | "default" | "high" | "auto";
export type OrbEngineLevel = "fast" | "default" | "high";

export type OrbPalette = { a: string; b: string; c: string };

// Same hexes as Toolbar.tsx ORB_COLORS — the engine keeps the app's core
// orb colours per mode (fast=amber, default=electric blue, high=violet).
const STATIC_COLORS: Record<OrbEngineLevel, OrbPalette> = {
  fast:    { a: "#FF9F0A", b: "#FF5E2A", c: "#FFD24A" },
  default: { a: "#1A5BFF", b: "#33E9FF", c: "#B8E6FF" },
  high:    { a: "#A02BF5", b: "#E04DFF", c: "#FFA6F0" },
};

const OFF_COLORS_LIGHT: OrbPalette = { a: "#b9b9be", b: "#dcdce2", c: "#97979e" };
const OFF_COLORS_DARK: OrbPalette  = { a: "#56565e", b: "#79798a", c: "#45454d" };

// Auto mode — blue-led cycle through violet and pink, tuned a step more
// vivid than the legacy autoFrontCycle hues. The resolved level picks
// which family the middle stop leans toward.
const AUTO_CYCLE: Record<OrbEngineLevel, OrbPalette[]> = {
  default: [
    { a: "#2B4BFF", b: "#7E5BFF", c: "#D9B4FF" },
    { a: "#3A52FF", b: "#A94DFF", c: "#FF8FE5" },
    { a: "#2356FF", b: "#4E9BFF", c: "#9BE9FF" },
  ],
  fast: [
    { a: "#2B4BFF", b: "#7E5BFF", c: "#D9B4FF" },
    { a: "#4452FF", b: "#C44DFF", c: "#FF9DC9" },
    { a: "#2E55FF", b: "#7E7BFF", c: "#FFC9A8" },
  ],
  high: [
    { a: "#2B47FF", b: "#8A4BFF", c: "#E0A8FF" },
    { a: "#3A47FF", b: "#A93BFF", c: "#FF7BF0" },
    { a: "#2450FF", b: "#6E66FF", c: "#C0B4FF" },
  ],
};

const AUTO_SEGMENT_SECONDS = 4.2;

// Complementary fringe colours per mode — the "chromatic aberration" tint
// the twin lets bleed in at the cloud's edge, kept opposite the mode's
// hue family so it reads as lens fringing, not a palette change.
const COMP_COLORS: Record<OrbEngineLevel, string> = {
  fast:    "#4FB6FF", // amber/coral → sky blue
  default: "#FF9D8A", // blue/cyan   → warm peach
  high:    "#8AF5E3", // violet/pink → mint ice
};
const AUTO_COMP = "#FFD9A8";       // blue-violet cycle → soft gold
const OFF_COMP_LIGHT = "#c8c8cc";
const OFF_COMP_DARK = "#66666e";

const IDLE_BODY_CLASS = "scroll-edge-idle";
const PAUSED_BODY_CLASS = "electron-window-unfocused-orb-paused";

/* ── OKLab colour math — palettes interpolate here so blends stay vivid
      (sRGB lerp drags blue→pink mixes through grey mud). ─────────────── */
type Lab = [number, number, number];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

const s2l = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const l2s = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const cbrt = Math.cbrt;

function rgbToOklab([r, g, b]: [number, number, number]): Lab {
  const lr = s2l(r), lg = s2l(g), lb = s2l(b);
  const l = cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, A, B]: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [
    clamp(l2s(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp(l2s(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp(l2s(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
}

const hexToLab = (hex: string): Lab => rgbToOklab(hexToRgb(hex));

function mixLab(x: Lab, y: Lab, t: number): Lab {
  return [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
}

type LabPalette = [Lab, Lab, Lab];
const paletteToLab = (p: OrbPalette): LabPalette => [hexToLab(p.a), hexToLab(p.b), hexToLab(p.c)];

/* ── Shader ──────────────────────────────────────────────────────────── */
const VERT = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision mediump float;
uniform vec2  u_res;
uniform float u_t;      // flow phase (speed-warped in JS, wrapped)
uniform float u_e;      // energy 0..1 (idle → analyzing)
uniform float u_light;  // 1 = light colour scheme
uniform vec3  u_a;      // dominant
uniform vec3  u_b;      // complement
uniform vec3  u_c;      // highlight
uniform vec3  u_d;      // chromatic-fringe complementary
uniform float u_ab;     // fringe amount (0 = off)
uniform float u_vib;    // extra vibrance (0 = neutral)

vec3 lin(vec3 c) { return c * c; } // cheap sRGB→linear, inverse is sqrt

// soft gaussian blob — the WebGL analogue of one blurred mesh dot
float g(vec2 q, float s) { return exp(-dot(q, q) / s); }

// ── Faithful to the original orb: six soft colour dots (two per palette
//    slot) drifting on offset orbits, merging additively into a gooey
//    glowing cloud with NO silhouette — alpha is purely the gaussian
//    tails fading to nothing. The WebGL upgrade over the CSS original is
//    the blending (linear-space additive + tonemap, OKLab palette drift)
//    and a faint tighter kernel inside three of the dots, which gives the
//    cloud an in-focus inner shimmer (depth of field) without ever
//    introducing an edge.
void main() {
  vec2 p = ((gl_FragCoord.xy / u_res) * 2.0 - 1.0) / 0.72;
  if (length(p) > 1.5) { gl_FragColor = vec4(0.0); return; }
  float t = u_t;

  vec3 A = lin(u_a), B = lin(u_b), C = lin(u_c);

  // slow whole-cloud breath, a touch wider when energised
  p *= 1.0 - 0.04 * sin(t * 0.5) - 0.10 * u_e;

  // orbit periods echo the legacy keyframes (~2.9–3.8 s at speed 1);
  // the second dot of each colour runs counter-phase like the legacy
  // "reverse" animations, so the cloud never collapses to one side
  vec2 c1 = vec2(sin(t * 1.9),       cos(t * 1.5 + 1.3)) * 0.30;
  vec2 c2 = vec2(sin(t * 1.6 + 2.1), cos(t * 2.0 + 4.0)) * 0.34;
  vec2 c3 = vec2(sin(t * 2.2 + 4.2), cos(t * 1.7 + 2.2)) * 0.27;
  vec2 c4 = vec2(sin(-t * 1.7 + 3.6), cos(-t * 1.4 + 0.6)) * 0.32;
  vec2 c5 = vec2(sin(-t * 1.5 + 5.0), cos(-t * 1.9 + 2.8)) * 0.36;
  vec2 c6 = vec2(sin(-t * 2.1 + 1.1), cos(-t * 1.3 + 5.5)) * 0.25;

  vec3 acc = vec3(0.0);
  acc += A * (g(p - c1, 0.150) * 0.62 + g(p - c4, 0.180) * 0.55);
  acc += B * (g(p - c2, 0.135) * 0.60 + g(p - c5, 0.165) * 0.52);
  acc += C * (g(p - c3, 0.115) * 0.58 + g(p - c6, 0.150) * 0.48);

  // in-focus kernels — small bright centres breathing inside the blur,
  // the "defined" layer; they ride the same orbits so they always sit
  // inside colour, never on empty ground
  float k = 0.24 + 0.40 * u_e;
  acc += mix(C, vec3(1.0), 0.38) * g(p - c3, 0.022) * k * (0.75 + 0.25 * sin(t * 1.7));
  acc += mix(B, vec3(1.0), 0.30) * g(p - c2, 0.028) * k * (0.75 + 0.25 * sin(t * 1.3 + 2.0));
  acc += mix(A, vec3(1.0), 0.24) * g(p - c1, 0.034) * k * (0.75 + 0.25 * sin(t * 1.5 + 4.1));

  // chromatic fringe — two complementary ghost blobs riding just off the
  // B-dot orbits, the offset slowly circling so the fringe wanders around
  // the cloud's edge like lens aberration; faint by design
  vec2 ab = vec2(cos(t * 0.6), sin(t * 0.6)) * 0.16;
  vec3 D = lin(u_d);
  acc += D * (g(p - c2 - ab, 0.085) * 0.30 + g(p - c5 + ab, 0.105) * 0.24) * u_ab;

  acc *= (0.85 + 0.65 * u_e) * (1.0 + 0.10 * u_light + 0.12 * u_vib);

  // Tonemap (soft-clips additive overlaps into luminous cores, never
  // hard white) + gentle saturation pop.
  vec3 col = 1.0 - exp(-acc * 1.15);
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = clamp(mix(vec3(lum), col, 1.24 + 0.14 * u_vib), 0.0, 1.0);

  // Coverage follows brightness only — gaussian tails dissolve the cloud
  // into the toolbar glass with no boundary of its own. Crucially this is
  // measured in LINEAR light, before the sqrt below: the sRGB transfer
  // lifts a 1% tail to ~10%, which painted a grey veil out to the canvas
  // edge when alpha was derived after conversion.
  float aCov = clamp(max(max(col.r, col.g), col.b) * 1.55 - 0.015, 0.0, 1.0);
  // On light glass a translucent colour cloud can only darken the white
  // behind it, so wide tails read as a grey penumbra — tighten the alpha
  // falloff in light mode only; dark mode keeps the full soft bloom.
  aCov = pow(aCov, 1.0 + 0.6 * u_light);

  col = sqrt(col);
  gl_FragColor = vec4(col * aCov, aCov); // premultiplied
}
`;

/* ── Legacy fallback markup — same DOM the old orb used; all its CSS is
      still in styles.css, so this is pixel-identical to the old look. ── */
const legacyVars = (p: OrbPalette): CSSProperties =>
  ({ "--orb-a": p.a, "--orb-b": p.b, "--orb-c": p.c } as CSSProperties);

function LegacyOrb({ mode, resolvedLevel }: { mode: OrbEngineMode; resolvedLevel?: OrbEngineLevel }) {
  const isAuto = mode === "auto";
  const palette = mode === "fast" || mode === "default" || mode === "high"
    ? STATIC_COLORS[mode]
    : undefined;
  const vars = palette ? legacyVars(palette) : undefined;
  const dots = [0, 1, 2, 3, 4, 5].map((i) => <span key={i} className="intel-mesh-dot-orb" />);
  const layer = (cls: string) => (
    <span
      className={cls}
      data-mode={mode}
      data-resolved={isAuto ? (resolvedLevel ?? "default") : undefined}
      style={vars}
      aria-hidden="true"
    >
      {dots}
    </span>
  );
  return (
    <>
      {layer("intel-mesh-dot")}
      {layer("intel-mesh-dot intel-mesh-dot--accent")}
      {layer("intel-mesh-dot intel-mesh-dot--ghost")}
    </>
  );
}

/* ── Engine component ────────────────────────────────────────────────── */
interface OrbEngineProps {
  mode: OrbEngineMode;
  /** When mode === "auto", the level the prescan currently resolves to. */
  resolvedLevel?: OrbEngineLevel;
  analyzing?: boolean;
  /** Orb diameter in css px (canvas extends ~50% beyond for the halo). */
  size?: number;
  /** Flow speed multiplier — large hero orbs read calmer below 1. */
  flowScale?: number;
  /** Backing-store multiplier on top of dpr. 2 (default) supersamples for
      crisp direct viewing; 1 halves each axis — right for an orb that
      lives behind backdrop blur, where the extra pixels are invisible. */
  resolutionScale?: number;
  /** Active-state fps ceiling (idle/hidden throttles still apply). */
  maxFps?: number;
  /** 0..1 extra saturation/brightness lift. */
  vibrance?: number;
  /** 0..1 complementary chromatic-fringe strength. */
  aberration?: number;
  className?: string;
}

interface EngineGL {
  gl: WebGLRenderingContext;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

function initGL(canvas: HTMLCanvasElement): EngineGL | null {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
  }) as WebGLRenderingContext | null;
  if (!gl) return null;

  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn("OrbEngine shader error:", gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  };

  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("OrbEngine link error:", gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const uniforms: EngineGL["uniforms"] = {};
  for (const name of ["u_res", "u_t", "u_e", "u_light", "u_a", "u_b", "u_c", "u_d", "u_ab", "u_vib"]) {
    uniforms[name] = gl.getUniformLocation(prog, name);
  }
  return { gl, uniforms };
}

export function OrbEngine({
  mode, resolvedLevel, analyzing = false, size = 20, flowScale = 1,
  resolutionScale = 2, maxFps = 30, vibrance = 0, aberration = 0, className,
}: OrbEngineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fallback, setFallback] = useState(false);

  // Live props readable from the render loop without restarting it.
  const propsRef = useRef({ mode, resolvedLevel, analyzing, flowScale, maxFps, vibrance, aberration });
  propsRef.current = { mode, resolvedLevel, analyzing, flowScale, maxFps, vibrance, aberration };

  // Wake signal: bump on any prop change so a paused/static loop redraws.
  const wakeRef = useRef(0);
  wakeRef.current += 1;
  const scheduleRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (fallback) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const cssSize = size * 1.5;
    // resolutionScale=2 supersamples on top of dpr — the cloud's kernel
    // detail lives at sub-css-pixel scale on a 20px orb. The behind-glass
    // twin passes 1: backdrop blur erases anything finer. Capped — at
    // hero sizes the dpr alone already provides the pixels.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const backing = Math.min(Math.round(cssSize * dpr * resolutionScale), 480);
    canvas.width = backing;
    canvas.height = backing;

    const engine = initGL(canvas);
    if (!engine) {
      setFallback(true);
      return;
    }
    const { gl, uniforms } = engine;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uniforms.u_res, canvas.width, canvas.height);

    let raf = 0;
    let disposed = false;
    let lost = false;

    // ── animation state
    let phase = Math.random() * 100;       // flow clock (speed-warped)
    let autoT = Math.random() * 100;       // auto palette clock
    let energy = 0.55;
    let lastNow = performance.now();
    let pending = 0;                       // time accrued since last draw
    let lastWake = wakeRef.current;

    // palette smoothing — current chases target in OKLab
    const seed: OrbPalette = mode === "fast" || mode === "default" || mode === "high"
      ? STATIC_COLORS[mode]
      : AUTO_CYCLE.default[0];
    const current: LabPalette = paletteToLab(seed);
    let currentComp: Lab = hexToLab(AUTO_COMP);

    // ── environment state (power saving)
    const darkMq = window.matchMedia("(prefers-color-scheme: dark)");
    const motionMq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let bodyIdle = document.body.classList.contains(IDLE_BODY_CLASS);
    let bodyPaused = document.body.classList.contains(PAUSED_BODY_CLASS);

    const bodyObserver = new MutationObserver(() => {
      bodyIdle = document.body.classList.contains(IDLE_BODY_CLASS);
      bodyPaused = document.body.classList.contains(PAUSED_BODY_CLASS);
      schedule();
    });
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });

    const targetPalette = (): LabPalette => {
      const { mode: m, resolvedLevel: lvl } = propsRef.current;
      if (m === "off") {
        return paletteToLab(darkMq.matches ? OFF_COLORS_DARK : OFF_COLORS_LIGHT);
      }
      if (m === "auto") {
        const stops = AUTO_CYCLE[lvl ?? "default"];
        const seg = autoT / AUTO_SEGMENT_SECONDS;
        const i = Math.floor(seg) % stops.length;
        const j = (i + 1) % stops.length;
        let f = seg - Math.floor(seg);
        f = f * f * (3 - 2 * f); // smoothstep between stops
        const sa = paletteToLab(stops[i]);
        const sb = paletteToLab(stops[j]);
        return [mixLab(sa[0], sb[0], f), mixLab(sa[1], sb[1], f), mixLab(sa[2], sb[2], f)];
      }
      return paletteToLab(STATIC_COLORS[m]);
    };

    const targetComp = (): Lab => {
      const { mode: m, resolvedLevel: lvl } = propsRef.current;
      if (m === "off") return hexToLab(darkMq.matches ? OFF_COMP_DARK : OFF_COMP_LIGHT);
      if (m === "auto") return hexToLab(lvl && lvl !== "default" ? COMP_COLORS[lvl] : AUTO_COMP);
      return hexToLab(COMP_COLORS[m]);
    };

    const drawFrame = (dt: number) => {
      const { mode: m, analyzing: busy } = propsRef.current;
      const idle = bodyIdle && !busy;

      const targetEnergy = m === "off" ? 0.08 : busy ? 1.0 : idle ? 0.28 : 0.55;
      energy += (targetEnergy - energy) * Math.min(1, dt * 3.0);

      const speed = (0.45 + 1.65 * energy * energy) * propsRef.current.flowScale;
      phase = (phase + dt * speed) % 6283.18;
      autoT = (autoT + dt * (0.8 + 0.4 * energy)) % (AUTO_SEGMENT_SECONDS * 3);

      const tgt = targetPalette();
      const k = Math.min(1, dt * 2.4);
      current[0] = mixLab(current[0], tgt[0], k);
      current[1] = mixLab(current[1], tgt[1], k);
      current[2] = mixLab(current[2], tgt[2], k);
      currentComp = mixLab(currentComp, targetComp(), k);

      const [ra, ga, ba] = oklabToRgb(current[0]);
      const [rb, gb, bb] = oklabToRgb(current[1]);
      const [rc, gc, bc] = oklabToRgb(current[2]);
      const [rd, gd, bd] = oklabToRgb(currentComp);

      gl.uniform1f(uniforms.u_t, phase);
      gl.uniform1f(uniforms.u_e, energy);
      gl.uniform1f(uniforms.u_light, darkMq.matches ? 0 : 1);
      gl.uniform3f(uniforms.u_a, ra, ga, ba);
      gl.uniform3f(uniforms.u_b, rb, gb, bb);
      gl.uniform3f(uniforms.u_c, rc, gc, bc);
      gl.uniform3f(uniforms.u_d, rd, gd, bd);
      gl.uniform1f(uniforms.u_ab, propsRef.current.aberration);
      gl.uniform1f(uniforms.u_vib, propsRef.current.vibrance);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const fpsCap = (): number => {
      if (lost || bodyPaused || document.hidden) return 0;
      if (motionMq.matches) return 0;
      const { mode: m, analyzing: busy, maxFps: cap } = propsRef.current;
      if (bodyIdle && !busy) return Math.min(cap, 8);
      if (m === "off") return Math.min(cap, 14);
      return cap;
    };

    const tick = (now: number) => {
      raf = 0;
      if (disposed) return;
      const dt = Math.min((now - lastNow) / 1000, 0.1);
      lastNow = now;
      pending += dt;

      const fps = fpsCap();
      if (fps === 0) {
        // Paused — render one final settled frame if props just changed
        // (covers prefers-reduced-motion: state changes still show).
        if (lastWake !== wakeRef.current && !lost) {
          lastWake = wakeRef.current;
          drawFrame(Math.min(pending, 0.1));
          pending = 0;
        }
        return; // no reschedule; schedule() restarts us
      }

      if (pending >= 1 / fps) {
        lastWake = wakeRef.current;
        drawFrame(Math.min(pending, 0.1));
        pending = 0;
      }
      raf = requestAnimationFrame(tick);
    };

    const schedule = () => {
      if (disposed || raf) return;
      lastNow = performance.now();
      raf = requestAnimationFrame(tick);
    };
    scheduleRef.current = schedule;

    const onVisibility = () => schedule();
    document.addEventListener("visibilitychange", onVisibility);
    darkMq.addEventListener?.("change", schedule);
    motionMq.addEventListener?.("change", schedule);

    const onLost = (e: Event) => {
      e.preventDefault();
      lost = true;
    };
    const onRestored = () => {
      lost = false;
      setFallback(true); // simplest safe path: swap to the CSS orb
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);

    schedule();

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      darkMq.removeEventListener?.("change", schedule);
      motionMq.removeEventListener?.("change", schedule);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      bodyObserver.disconnect();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallback, size, resolutionScale]);

  // Nudge the loop awake on prop changes — a paused loop (reduced motion,
  // hidden, unfocused) renders exactly one settled frame for the new state.
  useEffect(() => {
    scheduleRef.current?.();
  }, [mode, resolvedLevel, analyzing]);

  return (
    <span
      className={`orb-engine${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {fallback
        ? <LegacyOrb mode={mode} resolvedLevel={resolvedLevel} />
        : (
          <canvas
            ref={canvasRef}
            className="orb-engine-canvas"
            style={{ width: size * 1.5, height: size * 1.5 }}
          />
        )}
    </span>
  );
}

/* ── OrbBackGlow — the refraction layer behind the toolbar glass ───────
   Mounted as a *sibling painted before* the liquid-glass pill, so the
   pill's backdrop-filter genuinely refracts everything in it. It carries
   a real WebGL orb (OrbEngine) pinned to the exact position of the
   toolbar's orb button — a twin sitting *behind* the glass, refracted by
   it, while the original CSS orb renders on top inside the button. The
   bloom/spectral layers stay as faint supporting light; all CSS
   animation is transform/opacity only — compositor-cheap. */
export function OrbBackGlow({
  mode, resolvedLevel, analyzing,
}: { mode: OrbEngineMode; resolvedLevel?: OrbEngineLevel; analyzing?: boolean }) {
  const palette = mode === "fast" || mode === "default" || mode === "high"
    ? STATIC_COLORS[mode]
    : undefined;
  return (
    <span
      className="orb-backglow"
      data-mode={mode}
      data-resolved={mode === "auto" ? (resolvedLevel ?? "default") : undefined}
      data-analyzing={analyzing ? "true" : undefined}
      style={palette ? legacyVars(palette) : undefined}
      aria-hidden="true"
    >
      <span className="orb-backglow-bloom" />
      <span className="orb-backglow-spectral" />
      <span className="orb-backglow-orb">
        {/* Twin budget: behind blur(6px) glass, dpr-only resolution and
            20 fps are visually indistinguishable from the full-rate
            engine — ~6× less fragment work. The fringe + vibrance lift
            survives the blur and is what reads through the glass. */}
        <OrbEngine
          mode={mode}
          resolvedLevel={resolvedLevel}
          analyzing={analyzing}
          size={26}
          resolutionScale={1}
          maxFps={20}
          vibrance={1}
          aberration={1}
        />
      </span>
    </span>
  );
}
