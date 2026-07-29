/* ─────────────────────────────────────────────────────────────────────────
   OrbEngine — self-contained WebGL intelligence orb.

   Replaces the legacy 18-dot blurred-DOM orb (Toolbar.tsx IntelBtn /
   Onboarding.tsx HeroOrb) with a single tiny fragment-shader canvas.

   The look — six FLAT petals in a ring, under an invisible lens:
     · solid colour, hard (antialiased) edges, no gradient, glow, outline
       or shadow anywhere; the petals composite PREMULTIPLIED, which is
       what keeps antialiased edges from darkening into a fake outline
     · the motion is a separate pure engine (orbPhysics.ts): each petal
       reaches out and swells then comes back, offset around the ring, on
       springs — the renderer only draws where the rig says
     · a spherical lens (1−√(1−d²)) bends the petals near the rim, with a
       whisper of per-channel dispersion. It has no body of its own, so
       all you ever see of it is the petals bending inside it.
     · the palette is FIXED. Nothing cycles; the only colour change in the
       whole engine is the eased drain to grey when intelligence is off.

   GPU budget — the app is already compositing-heavy, so the engine is
   deliberately frugal:
     · one quad, one draw call, ~30×30 css px canvas in the toolbar
     · powerPreference "low-power", no depth/stencil/antialias
     · 30 fps cap; eases to 20 under body.scroll-edge-idle (idle is not
       frozen — the ring keeps turning); fully stops on document.hidden and
       body.electron-window-unfocused-orb-paused
     · prefers-reduced-motion → renders exactly one frame per state change

   Reversibility — every legacy CSS class (.intel-mesh-dot etc.) is left
   untouched in styles.css. If WebGL is unavailable or the context is lost
   the engine renders the legacy markup instead, and the USE_ORB_ENGINE
   flags at the call sites flip the whole feature off in one line.
   ───────────────────────────────────────────────────────────────────────── */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { OrbWorld, PETAL_COUNT } from "./orbPhysics";
import { PETAL_RGB, OFF_GREY_LIGHT, OFF_GREY_DARK } from "./orbColors";
import { LENS, LENS_FALLOFF_GLSL } from "./orbLens";
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

const IDLE_BODY_CLASS = "scroll-edge-idle";
const PAUSED_BODY_CLASS = "electron-window-unfocused-orb-paused";

/** Fill `out` (6 × rgb floats). `off` eases 0 → 1 as intelligence is
 *  switched off, so the drain to grey is a transition, not a cut. */
function petalPalette(off: number, dark: boolean, out: Float32Array) {
  const greys = dark ? OFF_GREY_DARK : OFF_GREY_LIGHT;
  for (let i = 0; i < PETAL_COUNT; i++) {
    const c = PETAL_RGB[i];
    const g = greys[i];
    out[i * 3] = c[0] + (g - c[0]) * off;
    out[i * 3 + 1] = c[1] + (g - c[1]) * off;
    out[i * 3 + 2] = c[2] + (g - c[2]) * off;
  }
}

/* ── Shader ──────────────────────────────────────────────────────────── */
const VERT = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision mediump float;
uniform vec2  u_res;
uniform float u_e;      // energy 0..1 (idle → analyzing)
uniform float u_vib;    // extra vibrance (0 = neutral)
uniform float u_ab;     // lens dispersion boost (0 = base)
uniform float u_px;     // one backing pixel in p-units (edge antialiasing)
// The six petals, straight from the rig:
uniform vec4  u_pa[6];  // cx, cy, cos(rot), sin(rot)
uniform vec2  u_pb[6];  // semi-major, semi-minor
uniform vec3  u_pc[6];  // colour

/* ── Six FLAT petals under an invisible lens. ──────────────────────────
   Flat is the whole point: solid colour, a hard (antialiased) edge, no
   gradient, no glow, no outline and no shadow. The orb used to be a
   translucent cloud, and a translucent mid-dark colour composited over a
   light page ALWAYS leaves a grey penumbra — that was the "dark shadow
   outside" the shapes. Opaque coverage cannot produce one.

   The lens is a real refraction and nothing else: a spherical falloff
   (1 - sqrt(1 - d²), zero at the centre, strongest at the rim) displaces
   the point we sample the petals at, per channel so the rim disperses
   slightly. It has no body of its own — no tint, no rim light, no
   shadow — so all you can see of it is the petals bending inside it. */

/* The lens profile, injected from orbLens.ts so the shader and the SVG
   exporter cannot describe different curves. */
${LENS_FALLOFF_GLSL}

/** the petal field, evaluated at one (already refracted) point.
    Returns PREMULTIPLIED colour. This matters more than it looks: mixing
    straight colours toward a black backdrop and carrying coverage
    separately darkens every antialiased edge to half strength, which is
    exactly what a dark outline around each shape looks like. Compositing
    premultiplied — src·a over dst·(1−a) — is the only version where a
    half-covered edge pixel is the petal's own colour at half alpha. */
vec4 petals(vec2 q) {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 6; i++) {
    vec4 A = u_pa[i];
    vec2 v = q - A.xy;
    // into the ellipse's own frame
    vec2 e = vec2(v.x * A.z + v.y * A.w, -v.x * A.w + v.y * A.z);
    vec2 ab = u_pb[i];
    float d = length(vec2(e.x / ab.x, e.y / ab.y));
    // antialias in normalised units: one pixel is worth more on a small axis
    float aa = max(u_px / min(ab.x, ab.y), 0.004) * 1.4;
    float c = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
    // painter's order — opaque shapes stacking, never additive light
    acc.rgb = u_pc[i] * c + acc.rgb * (1.0 - c);
    acc.a = c + acc.a * (1.0 - c);
  }
  return acc;
}

void main() {
  vec2 p = ((gl_FragCoord.xy / u_res) * 2.0 - 1.0) / 0.72;
  float r = length(p);
  if (r > 1.30) { gl_FragColor = vec4(0.0); return; }

  // ── the invisible lens (profile in orbLens.ts). Spherical falloff, zero
  //    at the centre, strongest toward the rim, TAPERED back to nothing past
  //    the petals' reach: an untapered rim keeps displacing where there is
  //    no glass left to see, which drags a petal tip out as a sliver.
  float k = lensFalloff(r);
  vec2 dir = r > 1e-4 ? p / r : vec2(0.0);
  float bend = (${LENS.BEND_BASE} + ${LENS.BEND_ENERGY} * u_e) * k;
  float disp = (${LENS.DISP_BASE} + ${LENS.DISP_AB} * u_ab) * k;

  vec4 fg = petals(p - dir * bend);
  float a = fg.a;
  if (a <= 0.0) { gl_FragColor = vec4(0.0); return; }

  // Dispersion rides the MIDDLE sample's coverage: alpha comes from it
  // alone, so no pixel can be opaque where the shape itself is not, and a
  // channel whose own sample misses falls back to the middle colour rather
  // than to black — that fallback is what keeps the fringe from turning
  // into a dark notch at the tips.
  vec3 mid = fg.rgb / a;
  vec4 fr = petals(p - dir * (bend + disp));
  vec4 fb = petals(p - dir * (bend - disp));
  vec3 col = vec3(
    fr.a > 0.004 ? fr.r / fr.a : mid.r,
    mid.g,
    fb.a > 0.004 ? fb.b / fb.a : mid.b
  ) * a;

  // brightness/saturation live on the flat colour itself — no bloom, no
  // tonemap, nothing that could bleed past the edge. Scaling premultiplied
  // colour is safe; the saturation mix uses the same premultiplied domain.
  // NOTE: orbLens.ts shadeColor mirrors these three lines, so the SVG
  // export ships the colour that is actually on screen, not the raw hex.
  // (No backticks in here: this whole shader is a template literal.)
  col *= 0.94 + 0.1 * u_e;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, 1.0 + 0.12 * u_vib) * (1.0 + 0.06 * u_vib);
  col = clamp(col, 0.0, a); // never brighter than its own coverage

  gl_FragColor = vec4(col, a); // premultiplied
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
      // No lean when no phase is set — the glow twin must sit on the same
      // equal cycle as the button orb, or the two drift apart at idle.
      data-resolved={isAuto && resolvedLevel ? resolvedLevel : undefined}
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
  for (const name of ["u_res", "u_e", "u_vib", "u_ab", "u_px", "u_pa", "u_pb", "u_pc"]) {
    uniforms[name] = gl.getUniformLocation(prog, name);
  }
  return { gl, uniforms };
}

export function OrbEngine({
  mode, resolvedLevel, analyzing = false, size = 20, flowScale = 1,
  resolutionScale = 2, maxFps = 30, vibrance = 0, aberration = 0, className,
}: OrbEngineProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
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
    const host = hostRef.current;
    if (!host) return;

    // The canvas is created HERE, one fresh element per effect run — never
    // rendered by React. loseContext() below is permanent for a canvas, and
    // under StrictMode's dev double-mount the second effect run would get
    // the same dead context back from the same element and fail to compile
    // (silently falling back to the legacy orb). A fresh element = a fresh
    // context, every time.
    const canvas = document.createElement("canvas");
    canvas.className = "orb-engine-canvas";
    host.appendChild(canvas);

    const cssSize = size * 1.5;
    canvas.style.width = `${cssSize}px`;
    canvas.style.height = `${cssSize}px`;
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
    // one backing pixel in p-units — the petal edges antialias against
    // this, so they stay equally crisp at 20px and at hero size
    gl.uniform1f(uniforms.u_px, 2 / (0.72 * backing));

    let raf = 0;
    let disposed = false;
    let lost = false;

    // ── animation state (energy lives in the rig, which springs it)
    let offAmt = mode === "off" ? 1 : 0;   // eased drain to grey
    let vib = 0;                           // smoothed vibrance
    let lastNow = performance.now();
    let pending = 0;                       // time accrued since last draw
    let lastWake = wakeRef.current;

    // ── the motion: the petal rig, warmed before the first frame so the
    //    orb arrives as a composed flower rather than mid-gesture. A
    //    per-instance seed keeps two orbs on screen out of lockstep.
    const world = new OrbWorld((Math.random() * 0x7fffffff) | 0);
    world.warm();
    const pa = new Float32Array(PETAL_COUNT * 4);
    const pb = new Float32Array(PETAL_COUNT * 2);
    const pc = new Float32Array(PETAL_COUNT * 3);

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

    const drawFrame = (dt: number) => {
      const { mode: m, analyzing: busy } = propsRef.current;
      const idle = bodyIdle && !busy;

      // The rig owns the transition: hand it the TARGET and it springs
      // there itself, so every amplitude — the sizing wave, the spin, the
      // throw, the ring's growth — moves on one timeline. Nothing here
      // eases, and nothing in CSS animates the working state either.
      world.target = m === "off" ? 0.08 : busy ? 1.0 : idle ? 0.28 : 0.55;
      world.step(dt * propsRef.current.flowScale);
      const energy = world.energy;
      vib += (propsRef.current.vibrance - vib) * Math.min(1, dt * 2.2);

      // Fixed colours; the only easing is the drain to grey when
      // intelligence is switched off.
      offAmt += ((m === "off" ? 1 : 0) - offAmt) * Math.min(1, dt * 2.6);
      petalPalette(offAmt, darkMq.matches, pc);
      for (let i = 0; i < PETAL_COUNT; i++) {
        const t = world.petals[i];
        pa[i * 4] = t.x;
        pa[i * 4 + 1] = t.y;
        pa[i * 4 + 2] = Math.cos(t.rot);
        pa[i * 4 + 3] = Math.sin(t.rot);
        pb[i * 2] = t.a;
        pb[i * 2 + 1] = t.b;
      }

      gl.uniform1f(uniforms.u_e, energy);
      gl.uniform1f(uniforms.u_ab, propsRef.current.aberration);
      gl.uniform1f(uniforms.u_vib, vib);
      gl.uniform4fv(uniforms.u_pa, pa);
      gl.uniform2fv(uniforms.u_pb, pb);
      gl.uniform3fv(uniforms.u_pc, pc);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const fpsCap = (): number => {
      if (lost || bodyPaused || document.hidden) return 0;
      if (motionMq.matches) return 0;
      const { mode: m, analyzing: busy, maxFps: cap } = propsRef.current;
      // Throttle on what the simulation is DOING, not on a timer: a
      // settled cluster is nearly static so a few frames a second is
      // plenty, while a pop always gets the full rate. Low-fps motion
      // only chops when there is real speed behind it.
      // Idle does NOT mean frozen. Dropping to a few frames a second read
      // as a stalled graphic rather than a resting one, so the idle floor
      // is a real frame rate — still a saving over the active cap, but the
      // ring visibly keeps turning while the app sits quiet.
      const quiet = world.activity() < 0.06;
      if (bodyIdle && !busy) return quiet ? Math.min(cap, 20) : cap;
      if (m === "off") return quiet ? Math.min(cap, 6) : cap;
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
      canvas.remove();
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
      ref={hostRef}
      className={`orb-engine${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {fallback && <LegacyOrb mode={mode} resolvedLevel={resolvedLevel} />}
    </span>
  );
}
