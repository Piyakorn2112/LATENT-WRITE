/**
 * glass-lab.ts — SANDBOX. Not imported by the app.
 *
 * Drives glass-lab.html. Exposes `window.__lab` so
 * scripts/probe-glass-lab.cjs can switch which path renders, ask for timings,
 * and take a screenshot of each — including one of the backdrop ALONE, which is
 * the ground truth the reconstruction gets diffed against.
 *
 * ★ THE FIDELITY GATE IS A SCREENSHOT DIFF, NOT MY OPINION OF THE RENDER.
 *   "The reconstruction looks right" is exactly the kind of claim that has been
 *   wrong before in this repo. The harness captures the real page with the
 *   glass hidden, captures the reconstruction over the same rect, and compares
 *   the two crops pixel for pixel.
 */

import { initLiquidGlassFilter } from "./lib/liquid-glass-filter";
import { reconstructBackdrop, type ReconstructStats } from "./lab/backdrop-reconstruct";
import { GlassGL } from "./lab/glass-gl";

// ── The backdrop content ────────────────────────────────────────────────────
//
// Real prose, marked up the way the app marks it: entity fills, action fills,
// and an underline. Long enough that a surface placed anywhere over it lands on
// wrapped text rather than on a convenient gap.
const PARAS = [
  `She had been thinking about it for a long time. She <span class="mark-under">remembered what</span> he had <span class="mark-action">told her</span>, and she wondered whether he had understood what he was saying. She <span class="mark-entity">considered it</span> again, and believed now that she had understood nothing at all.`,
  `&ldquo;You will not go,&rdquo; he said. &ldquo;I forbid it.&rdquo;`,
  `&ldquo;You have no right to forbid me anything,&rdquo; she answered. She refused to look at <span class="mark-entity">him</span>. He demanded to know who had helped her. She denied that anyone had. He <span class="mark-action">accused her of lying</span>, and she did not trouble to deny that either.`,
  `He came upon the house at dusk. <span class="mark-under">The light fell across the cold stone of the hall</span>, and the air smelled of rain and of the sea beyond the wall. Nothing moved in the room at all, and the lamps had not <span class="mark-action">been lit</span>.`,
  `She said nothing. She would not look at him, and she refused to explain herself. <span class="mark-entity">The silence stretched between them</span> until it had a weight of its own, and still she turned away.`,
  `In the morning the house was full of people, and none of them spoke of what had happened. <span class="mark-action">She went down</span> to the shore alone and stood a long while where the water came in over the stones.`,
];

const CHIPS = [
  ["confrontation", ""], ["revelation", "b"], ["buildup", "c"],
  ["two peaks", ""], ["hook 65", "b"], ["fluid", "c"], ["cliffhanger", ""],
];

function buildBackdrop(): void {
  document.getElementById("prose")!.innerHTML =
    PARAS.map((p) => `<p>${p}</p>`).join("");
  document.getElementById("chips")!.innerHTML =
    CHIPS.map(([t, k]) => `<span class="chip ${k}">${t}</span>`).join("");
  const rail = document.getElementById("rail")!;
  let html = "";
  for (let i = 0; i < 22; i++) {
    const accent = i % 7 === 3;
    html += `<div class="rail-row${accent ? " rail-accent" : ""}" style="top:${
      30 + i * 34}px;width:${accent ? 240 : 120 + ((i * 53) % 160)}px"></div>`;
  }
  rail.innerHTML = html;
}

// ── The surface under test ──────────────────────────────────────────────────

export interface LabRect { x: number; y: number; w: number; h: number; r: number }

/** The app's real surfaces, from scripts/probe-glass-backdrops.cjs. */
const PRESETS: Record<string, LabRect> = {
  tab:      { x: 300, y: 180, w: 26,  h: 73,  r: 13 },
  pill:     { x: 200, y: 250, w: 180, h: 34,  r: 17 },
  toolbar:  { x: 120, y: 120, w: 920, h: 46,  r: 23 },
  popover:  { x: 180, y: 200, w: 420, h: 120, r: 14 },
  panel:    { x: 180, y: 150, w: 420, h: 620, r: 24 },
  overlay:  { x: 30,  y: 20,  w: 1140, h: 860, r: 28 },
  // ★ ISOLATES THE GRADIENT. `toolbar` is the only preset whose flat-pixel
  //   error is not ~0, and it is also the only one that crosses the dark
  //   gradient rail — so put a surface entirely ON the rail and entirely OFF
  //   it, and the two numbers say whether the gradient is the cause or the
  //   correlation is a coincidence.
  gradonly: { x: 840, y: 100, w: 280, h: 200, r: 16 },
  proseonly:{ x: 120, y: 100, w: 280, h: 200, r: 16 },
};

const svgEl = document.getElementById("target-svg") as HTMLDivElement;
const glCanvas = document.getElementById("target-gl") as HTMLCanvasElement;
const reconCanvas = document.getElementById("target-recon") as HTMLCanvasElement;
/** Off-screen: the reconstructed backdrop the shader reads. */
const srcCanvas = document.createElement("canvas");

let gl: GlassGL | null = null;
let current: LabRect = PRESETS.popover;
const DPR = () => Math.min(window.devicePixelRatio || 1, 3);

/** Never let the painter see the glass, or it reconstructs its own output. */
const EXCLUDE = new Set<Element>([svgEl, glCanvas, reconCanvas]);
const exclude = (el: Element) => EXCLUDE.has(el);

function place(el: HTMLElement, r: LabRect): void {
  el.style.left = `${r.x}px`;
  el.style.top = `${r.y}px`;
  el.style.width = `${r.w}px`;
  el.style.height = `${r.h}px`;
  el.style.borderRadius = `${r.r}px`;
}

/**
 * ★ THE BEVEL IS A FRACTION OF THE HALF SHORT SIDE, NOT OF THE SHORT SIDE.
 *
 * knob-glass-paint.ts reads `BEZEL_FRAC = 0.34` against `min(halfW, halfH)`.
 * The first version here applied the same 0.34 to the FULL short side, which
 * made every bevel twice as thick and — since the pull scales with it — the
 * refraction roughly twice as strong as the shipping optics ask for. On a
 * 420x120 popover that put a 41px bevel and a 49px pull on a surface only 120px
 * tall, and the corners drew visible caustic wedges where the converging normals
 * crossed. Not a defect in the method: a defect in reading the constant.
 *
 * PULL_X_BEZEL is left at the knob's 4.0 only for knob-sized shapes. A large
 * panel gets a gentler multiple, because the knob's ratio exists to make a 24px
 * lozenge read as a thick lens and a 620px panel does not want to be one.
 */
function bevelFor(r: LabRect): { bezel: number; peak: number } {
  const halfShort = Math.min(r.w, r.h) / 2;
  const bezel = Math.max(2, halfShort * 0.34);
  const pullMultiple = halfShort <= 24 ? 4.0 : halfShort <= 80 ? 2.0 : 1.2;
  return { bezel, peak: bezel * pullMultiple };
}

/** Reconstruct the backdrop under `r` into `srcCanvas`. */
function reconstruct(r: LabRect): ReconstructStats {
  return reconstructBackdrop(srcCanvas, {
    rect: { x: r.x, y: r.y, w: r.w, h: r.h },
    dpr: DPR(),
    exclude,
  });
}

/** Blur the reconstruction in place, matching the chain's backdrop blur. */
function blurSource(px: number): number {
  if (px <= 0) return 0;
  const t0 = performance.now();
  const tmp = document.createElement("canvas");
  tmp.width = srcCanvas.width; tmp.height = srcCanvas.height;
  const tctx = tmp.getContext("2d")!;
  tctx.filter = `blur(${px * DPR()}px)`;
  tctx.drawImage(srcCanvas, 0, 0);
  const sctx = srcCanvas.getContext("2d")!;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, srcCanvas.width, srcCanvas.height);
  sctx.drawImage(tmp, 0, 0);
  return performance.now() - t0;
}

interface FrameTimings {
  reconstruct: number;
  blur: number;
  upload: number;
  render: number;
  total: number;
}

function renderGL(r: LabRect, blurPx: number): { timings: FrameTimings; stats: ReconstructStats } {
  if (!gl) gl = new GlassGL(glCanvas);
  const t0 = performance.now();
  const stats = reconstruct(r);
  const tBlur = blurSource(blurPx);
  const t1 = performance.now();
  gl.upload(srcCanvas);
  const t2 = performance.now();
  gl.render({
    w: r.w, h: r.h, dpr: DPR(),
    radius: r.r,
    ...bevelFor(r),
    chroma: 0.04,
    saturate: 1.45,
    fill: [1, 1, 1, 0.22],
    edgeHi: 0.5, edgeDark: 0.14, rimPx: 1.2,
  });
  gl.finish();
  const t3 = performance.now();
  return {
    timings: {
      reconstruct: stats.ms, blur: tBlur,
      upload: t2 - t1, render: t3 - t2, total: t3 - t0,
    },
    stats,
  };
}

// ── The probe surface for the harness ───────────────────────────────────────

type Mode = "backdrop" | "recon" | "svg" | "gl";

function setMode(mode: Mode, presetName: string, blurPx: number): unknown {
  current = PRESETS[presetName] ?? PRESETS.popover;
  svgEl.hidden = true; glCanvas.hidden = true; reconCanvas.hidden = true;

  if (mode === "backdrop") return { mode, rect: current };

  if (mode === "svg") {
    place(svgEl, current);
    svgEl.hidden = false;
    return { mode, rect: current };
  }

  if (mode === "recon") {
    const stats = reconstruct(current);
    blurSource(blurPx);
    place(reconCanvas, current);
    reconCanvas.width = srcCanvas.width;
    reconCanvas.height = srcCanvas.height;
    reconCanvas.getContext("2d")!.drawImage(srcCanvas, 0, 0);
    reconCanvas.hidden = false;
    return { mode, rect: current, stats };
  }

  const out = renderGL(current, blurPx);
  place(glCanvas, current);
  glCanvas.hidden = false;
  return { mode, rect: current, ...out };
}

/** Time a steady-state frame of the GL path, reconstruction included. */
function benchmark(presetName: string, blurPx: number, iterations: number): unknown {
  const r = PRESETS[presetName] ?? PRESETS.popover;
  if (!gl) gl = new GlassGL(glCanvas);
  renderGL(r, blurPx);   // warm: shader compile, texture allocation

  const acc: FrameTimings = { reconstruct: 0, blur: 0, upload: 0, render: 0, total: 0 };
  let stats: ReconstructStats | null = null;
  for (let i = 0; i < iterations; i++) {
    const out = renderGL(r, blurPx);
    stats = out.stats;
    for (const k of Object.keys(acc) as Array<keyof FrameTimings>) acc[k] += out.timings[k];
  }
  for (const k of Object.keys(acc) as Array<keyof FrameTimings>) acc[k] /= iterations;

  // ★ AND THE SAME SURFACE WITH THE BACKDROP HELD STILL — because a static
  //   backdrop is the common case (prose does not move unless it is scrolled or
  //   typed into), and it is the only number that says what an idle glass
  //   surface costs.
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    gl.render({
      w: r.w, h: r.h, dpr: DPR(), radius: r.r,
      ...bevelFor(r),
      chroma: 0.04, saturate: 1.45, fill: [1, 1, 1, 0.22],
      edgeHi: 0.5, edgeDark: 0.14, rimPx: 1.2,
    });
  }
  gl.finish();
  const cachedMs = (performance.now() - t0) / iterations;

  return {
    preset: presetName, rect: r, dpr: DPR(),
    devPx: Math.round(r.w * DPR()) * Math.round(r.h * DPR()),
    perFrame: acc, cachedMs,
    reuseTexture: gl.lastUploadWasSubImage,
    stats,
  };
}

interface LabWindow extends Window {
  __lab?: {
    setMode: (m: Mode, preset: string, blur: number) => unknown;
    benchmark: (preset: string, blur: number, n: number) => unknown;
    presets: () => string[];
    rect: () => LabRect;
  };
  __labReady?: boolean;
}

buildBackdrop();
initLiquidGlassFilter();

const w = window as LabWindow;
w.__lab = {
  setMode,
  benchmark,
  presets: () => Object.keys(PRESETS),
  rect: () => current,
};
// The SVG engine binds on idle; give it a beat before declaring ready.
requestAnimationFrame(() => requestAnimationFrame(() => { w.__labReady = true; }));
