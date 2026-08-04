/**
 * glass-canvas — the panel-class liquid-glass surfaces, refracted on the GPU
 * from a backdrop this app reconstructs itself.
 *
 * ─── WHAT THIS REPLACES, AND WHAT IT DELIBERATELY DOES NOT ───────────────────
 *
 * `liquid-glass-filter.ts` builds an 8-bit displacement map per element and
 * hands it to `backdrop-filter: url(...)`. That works, and every artifact the
 * knobs ever showed came from the encoding rather than the optics: one
 * displacement byte moves the sample by dispPx/255 element px, so the sampling
 * advances in quantised jumps and combs wherever a texel is worth about a byte.
 * `knob-glass-paint.ts` already escaped that for the control knobs by
 * RECONSTRUCTING its backdrop and refracting it per pixel in float.
 *
 * This is that method for the panel-class surfaces, on the GPU because JS
 * cannot carry it at panel sizes (measured: 4.83 ms/frame for the toolbar
 * alone, 40 ms for a settings panel — scripts/probe-refraction-cost.cjs).
 *
 * ★ THE KNOBS AND THE LENS ARE NEVER CLAIMED. `.liquid-glass-control-knob`,
 *   `.glass-toggle-knob`, `.glass-range-knob` and `.liquid-glass-lens` keep the
 *   engine they have. The knobs already look right via KnobGlass, the lens has
 *   its own supersampled displacement-only preset, and neither is worth the
 *   risk of a rewrite.
 *
 * ★ THE EDGE-GLOW SYSTEM IS NOT TOUCHED. `::before` (the specular ring) and
 *   `::after` (the plus-lighter glow) paint exactly as they do today — see the
 *   layering note on `claim()` for the one property that had to be added to
 *   keep that true.
 */

import {
  buildDisplayList, paintDisplayList,
  type DisplayList, type ReconstructStats,
} from "./backdrop";
import { GlassGL } from "./surface-gl";

/**
 * The surfaces this engine takes over. Deliberately the panel-class set only:
 * the same classes the SVG engine dispatches on, minus the knobs and the lens.
 */
const CLAIM_SELECTOR = ".liquid-glass, .analysis-tab, .analysis-action-group";
/** Never claimed, whatever else they carry. */
const NEVER_SELECTOR =
  ".liquid-glass-control-knob, .liquid-glass-lens, .glass-toggle-knob, .glass-range-knob";

/** Marks an element this engine owns. `liquid-glass-filter.ts` checks for it. */
export const CANVAS_GLASS_ATTR = "data-lqg-canvas";

// ── Parameters, taken from the shipping engine rather than invented ─────────
//
// liquid-glass-filter.ts: DISP_PX 40, SATURATE 2.15 (1.8 on the sidebar tabs),
// CHROMA_FLATTEN 0.5 (0 on the sidebar tabs), per-class blur below.
// liquid-glass-worker.ts: BEZEL_PX 120 clamped to halfShort * 0.8, GRAD_K 40,
// and CHANNEL_GAIN 1 for the default preset.
//
// ★ THE PEAK PULL IS DERIVED, NOT CHOSEN. The SVG path packs displacement into
//   a byte and feDisplacementMap scales it by DISP_PX, so the largest shift it
//   can produce is `DISP_PX * 127 * gain / 255` element px. Matching that is
//   what makes this engine a change of ENCODING rather than a change of look.
const DISP_PX = 40;
const PEAK_PULL_PX = (DISP_PX * 127 * 1) / 255;      // 19.92
const GRAD_K = 40;

/**
 * ★ THE MAP IS BUILT THE KNOB'S WAY, NOT THE GENERAL ENGINE'S.
 *
 * These two engines disagree about what a glass EDGE is, and the disagreement
 * is entirely in the bevel — not in the optics, which are the same squircle
 * through the same Snell solve in both.
 *
 *   liquid-glass-worker.ts (the general SVG engine)
 *       bezel = min(120px, halfShort * 0.8)
 *     A 120px bevel on a 46px-tall toolbar is the whole element, so the bend is
 *     spread thinly across all of it and the rim never reads as thick.
 *
 *   knob-glass-paint.ts (the control knobs, which look right)
 *       bezel = halfShort * 0.34
 *     A real glass slab is FLAT over almost its whole area — normal straight
 *     up, backdrop passes through undeviated — and then rolls over in a narrow
 *     band where the surface tips toward vertical. Because the deviation there
 *     is larger than the band is wide, that strip shows a COMPRESSED, partly
 *     mirrored view of the interior, and that is what reads as thickness.
 *
 * So the bevel fraction comes from the knob. `PEAK_PULL_PX` is deliberately
 * left alone — the refraction strength is not what was asked to change, and it
 * stays the 19.92px the 8-bit map could produce. The consequence is that the
 * pull is now several times the bevel width, which is exactly the knob's
 * arrangement and exactly why its rim folds.
 *
 * ★ THE FOLD IS THE POINT, AND IT IS ONLY SAFE HERE. `y + disp(y)` is not
 * monotone inside a bevel this narrow, so the band mirrors. In an 8-bit
 * displacement map that fold becomes a comb of stripes, which is why the SVG
 * engine has to bound its pull. This path samples in float with hardware
 * bilinear, so the same fold is a smooth compressed reflection.
 */
/**
 * ★ TWICE THE KNOB'S BAND. The knob uses 0.34 of the half-short-side, and on a
 * panel that band reads thin — a knob is 24px tall and a toolbar is 46, so the
 * same fraction gives an edge less than half as thick in absolute terms as the
 * eye expects from something that large. Doubled by request; the pull is
 * unchanged, so the fold is gentler and the compressed rim strip is wider.
 */
const BEZEL_FRAC = 0.68;
/**
 * Floor in CSS px. A bevel proportional to the shape vanishes on a thin
 * surface — the 8px-tall scroll rails would get a sub-pixel edge and no glass
 * at all — so it cannot go below something that still reads.
 */
const BEZEL_MIN_PX = 2.5;
const SATURATE = 2.15;
const SATURATE_SIDEBAR_TAB = 1.8;
const CHROMA_FLATTEN = 0.5;
const FLATTEN_TARGET_VAR = "--lqg-flatten-target";
const FLATTEN_TARGET_FALLBACK = 0.94;
/** Channel separation at the rim. The SVG chain has none; keep it subtle. */
const CHROMA_SPLIT = 0.03;

/** Same pause states the SVG engine honours — see syncLiquidGlassPauseState. */
const PAUSE_BODY_CLASSES = [
  "timeline-overlay-freeze",
  "renderer-workspace-freeze",
  "electron-window-unfocused",
  "scroll-edge-idle",
];

/** Per-class backdrop blur, mirroring liquid-glass-filter.ts's readBlur. */
function readBlur(el: Element): number {
  if (el.classList.contains("toolbar")) return 0.9;
  if (el.classList.contains("settings-panel")) return 2;
  if (el.matches(".analysis-tab, .analysis-action-group")) return 1.2;
  if (el.classList.contains("status-pill")) return 0.9;
  return 3;
}

function isSidebarTab(el: Element): boolean {
  return el.matches(".analysis-tab, .analysis-action-group");
}

function readSaturate(el: Element): number {
  return isSidebarTab(el) ? SATURATE_SIDEBAR_TAB : SATURATE;
}

function readFlatten(el: Element): number {
  return isSidebarTab(el) ? 0 : CHROMA_FLATTEN;
}

function readFlattenTarget(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(FLATTEN_TARGET_VAR).trim();
  const v = parseFloat(raw);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : FLATTEN_TARGET_FALLBACK;
}

function parseRgba(css: string): [number, number, number, number] {
  const m = (css || "").match(/[\d.]+/g);
  if (!m || m.length < 3) return [0, 0, 0, 0];
  return [Number(m[0]) / 255, Number(m[1]) / 255, Number(m[2]) / 255,
    m.length > 3 ? Number(m[3]) : 1];
}

// ── State ───────────────────────────────────────────────────────────────────

interface Surface {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  gl: GlassGL;
  /** Offscreen 2D buffer the backdrop is reconstructed into. */
  src: HTMLCanvasElement;
  dirty: boolean;
  /** Last painted geometry, so an unchanged surface can skip the work. */
  lastKey: string;
  /** What the last reconstruction found — read by the verifier. */
  lastStats: ReconstructStats | null;
  /** Paints completed, so a surface that never painted is distinguishable
   *  from one that painted something empty. */
  paints: number;
  /** Cheap re-renders done while the surface was moving — see paintMoving. */
  reflows: number;
  /** Last rect painted, to detect motion. */
  lastRect: { x: number; y: number; w: number; h: number } | null;
  /** Timer that forces a full repaint once motion stops. */
  settleTimer: number;
  /** One warning per surface when the fallback is off. */
  warnedUnpaintable: boolean;
  /** When this surface first became dirty, so a transition cannot starve it. */
  dirtySince: number;
}

const surfaces = new Map<HTMLElement, Surface>();
/** Elements this engine has looked at and refused, so it does not retry forever. */
const declined = new WeakSet<Element>();
let flattenTarget = FLATTEN_TARGET_FALLBACK;
let rafHandle = 0;
let paused = false;
let started = false;
/**
 * ★ CSS TRANSITIONS IN FLIGHT — the fix for the side-panel judder.
 *
 * The analysis panel slides on a 0.90s transform. Nothing mutates during that
 * slide, so the engine did no per-frame work — but the CLASS CHANGE that starts
 * it is a mutation, and it landed a full repaint of every overlapping surface on
 * the first frame of the animation. The most expensive frame in the sequence was
 * the one where the animation had to look smoothest.
 *
 * And then nothing repainted at all, so the panel finished its slide showing a
 * backdrop reconstructed from where it USED to be.
 *
 * Both are the same missing concept: a transition is a period during which the
 * backdrop is not worth rebuilding and afterwards it must be. So defer full
 * repaints while one is running, and rebuild on `transitionend`.
 */
/**
 * ★ A DEADLINE, NOT A COUNTER. Counting `transitionrun` up and `transitionend`
 * down looks right and is not: the two events do not reliably pair. An element
 * removed mid-transition never ends, a cancel can arrive alongside an end, and
 * a transition already running when the listener attaches decrements from zero.
 * Every one of those leaves the count wrong in a direction that either freezes
 * every backdrop or defeats the deferral silently — measured, it was the
 * latter.
 *
 * A timestamp cannot drift: each starting transition pushes the deadline out by
 * its own declared duration, and it expires on its own.
 */
let motionUntil = 0;

/**
 * ★ MODULE-LEVEL TOTALS, because the per-surface ones cannot be differenced.
 *
 * Opening the analysis panel remounts its subtree, so surfaces are unbound and
 * re-claimed with their counters back at zero. A harness sampling
 * `sum(surface.paints)` before and after therefore reads 0 — which looks
 * exactly like "the engine did nothing" and is really "the engine's bookkeeping
 * was replaced". These survive rebinding.
 */
let totalPaints = 0;
let totalReflows = 0;
let totalClaims = 0;
/** Display lists built, and the cost of the most recent one. */
let totalLists = 0;
let lastListMs = 0;
/** Scheduler branch counters — diagnostic only. */
const sched = { runs: 0, defers: 0, breaks: 0, calls: 0, skipped: 0 };

/** Surfaces repainted per frame. Reconstruction is ~0.2-1 ms each; this bounds
 *  a burst (a chapter switch dirties everything at once) to a fraction of a
 *  frame and lets the rest land on the next one. */
const MAX_REPAINTS_PER_FRAME = 64;
/**
 * ★ AND A TIME BUDGET, because a COUNT is not a budget. Three tabs cost 1.5 ms
 * and three big panels cost 6, and the count cannot tell them apart. Whichever
 * limit is reached first stops the pass; the rest are still dirty and land on
 * the next frame.
 */
const FRAME_BUDGET_MS = 6;
/** Ceiling on how far one transition can push the motion deadline out. */
const MOTION_MAX_MS = 1200;

/**
 * ★ THE FALLBACK IS OFF WHILE THIS IS BEING EVALUATED.
 *
 * With it on, a surface whose backdrop contains something the painter cannot
 * express hands itself back to `backdrop-filter` — which is the right shipping
 * behaviour and the wrong testing behaviour, because the defect then never
 * appears and the engine looks better than it is. Off, the same surface paints
 * anyway and the mistake is on screen where it can be found.
 *
 * `?lqg-fallback=1` turns it back on without a rebuild.
 */
let fallbackEnabled = false;

/** True while this engine owns the element — read by liquid-glass-filter.ts. */
export function canvasGlassOwns(el: Element): boolean {
  return el instanceof HTMLElement && surfaces.has(el);
}

// ── Claiming ────────────────────────────────────────────────────────────────

function eligible(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (typeof el.matches !== "function") return false;
  if (!el.matches(CLAIM_SELECTOR)) return false;
  if (el.matches(NEVER_SELECTOR)) return false;
  if (declined.has(el)) return false;
  return true;
}

/**
 * ★ THE LAYERING, AND THE ONE PROPERTY THAT HAD TO CHANGE.
 *
 * Inside a glass element the paint order today is: the element's own tint,
 * then `::before` (the 0.5px specular ring, z-index 0), then content, then
 * `::after` (the edge glow, z-index 5, mix-blend-mode plus-lighter). The
 * refracted backdrop has to land UNDER all three.
 *
 * A positioned child at `z-index: -1` paints in step 2 of the stacking
 * context's order — after the element's own background, before every
 * positioned descendant — which is exactly the slot wanted. But negative
 * z-index children only stay inside the element if the element FORMS a
 * stacking context, and today the only reason `.liquid-glass` forms one is
 * that it carries a `backdrop-filter`. Remove that and the canvas escapes
 * backwards past the element entirely.
 *
 * So `isolation: isolate` goes on in its place. That is not a new constraint
 * being introduced — it RESTORES the one `backdrop-filter` was already
 * imposing, which matters most for `::after`: `plus-lighter` blends against
 * its stacking context, so without isolation the glow would start blending
 * against the page instead and change on every surface. Keeping the context is
 * what keeps the edge-glow system untouched.
 *
 * The element's own background is deliberately LEFT ALONE. The canvas is opaque
 * and covers it, so it costs one hidden fill — and it means a surface whose GL
 * context dies still reads as a translucent glass panel rather than a hole.
 */
function claim(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);

  // Non-uniform corners would need four radii in the SDF; the shader takes one.
  const r0 = parseFloat(cs.borderTopLeftRadius) || 0;
  for (const rr of [cs.borderTopRightRadius, cs.borderBottomLeftRadius, cs.borderBottomRightRadius]) {
    if (Math.abs((parseFloat(rr) || 0) - r0) > 0.6) return false;
  }

  const canvas = document.createElement("canvas");
  canvas.className = "lqg-canvas";
  canvas.setAttribute("aria-hidden", "true");

  let gl: GlassGL;
  try {
    gl = new GlassGL(canvas);
  } catch {
    return false;                    // no WebGL2 — the SVG engine keeps it
  }

  // First child, so it precedes everything the element paints. z-index and
  // positioning live in styles.css (.lqg-canvas) rather than inline, so the
  // layering is inspectable in devtools like every other rule.
  el.insertBefore(canvas, el.firstChild);
  el.setAttribute(CANVAS_GLASS_ATTR, "");

  surfaces.set(el, {
    el, canvas, gl,
    src: document.createElement("canvas"),
    dirty: true, lastKey: "", lastStats: null, paints: 0,
    reflows: 0, lastRect: null, settleTimer: 0, warnedUnpaintable: false,
    dirtySince: performance.now(),
  });
  totalClaims++;
  return true;
}

/** Hand a surface back to the SVG engine, for good. */
function release(el: HTMLElement, why: string): void {
  const s = surfaces.get(el);
  if (!s) return;
  surfaces.delete(el);
  declined.add(el);
  s.canvas.remove();
  el.removeAttribute(CANVAS_GLASS_ATTR);
  if (import.meta.env?.DEV) {
    console.info(`[glass-canvas] released ${el.className || el.tagName}: ${why}`);
  }
  // The SVG engine's MutationObserver watches `class`; touching the attribute
  // is what makes it re-evaluate an element it previously skipped.
  el.classList.add("lqg-reclaim");
  el.classList.remove("lqg-reclaim");
}

function unbind(el: Element): void {
  if (!(el instanceof HTMLElement)) return;
  const s = surfaces.get(el);
  if (!s) return;
  surfaces.delete(el);
  s.canvas.remove();
  el.removeAttribute(CANVAS_GLASS_ATTR);
}

// ── Painting ────────────────────────────────────────────────────────────────

const dpr = () => Math.min(window.devicePixelRatio || 1, 3);

/**
 * ★ THE MOTION PATH, AND THE FIX FOR THE SIDEBAR JUDDER.
 *
 * Expanding the side panel animates a width over ~200ms. Every frame of that
 * animation moves and resizes several glass surfaces, and the first version
 * answered each frame with a full reconstruction — reconstruct + blur + upload,
 * which is 1.9 ms for the settings panel alone and lands two or three of those
 * in the same frame. That is the stutter.
 *
 * Almost none of that work is needed WHILE the shape is moving. The GL render
 * is 0.01 ms and it is the half that actually depends on the geometry — the
 * silhouette, the corner radius, where the bevel falls. The backdrop texture is
 * a fraction of a second stale during a transition, which nobody can see behind
 * a blurred, refracted, moving panel.
 *
 * So: while the rect is changing, re-render only. When it stops, one full
 * repaint catches up.
 */
function renderOnly(s: Surface, rect: DOMRect, cs: CSSStyleDeclaration, d: number): void {
  const halfShort = Math.min(rect.width, rect.height) / 2;
  const radius = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, halfShort);
  // The knob's construction: a narrow band that is a fraction of the shape,
  // with the pull free to exceed it. See BEZEL_FRAC.
  const bezel = Math.max(BEZEL_MIN_PX, Math.min(halfShort * BEZEL_FRAC, halfShort * 0.8));
  const [fr, fg, fb, fa] = parseRgba(cs.backgroundColor);
  s.gl.render({
    w: rect.width, h: rect.height, dpr: d,
    radius,
    bezel,
    // NOT clamped to the bevel. A pull larger than the band is what compresses
    // the interior into the rim; clamping it back was the general engine's
    // concession to its 8-bit encoding, and this path does not have one.
    peak: PEAK_PULL_PX,
    chroma: CHROMA_SPLIT,
    saturate: readSaturate(s.el),
    flatten: readFlatten(s.el),
    flattenTarget,
    fill: [fr, fg, fb, fa],
    // The rim shading belongs to ::before and ::after, which are untouched and
    // still paint on top. Adding it here would double the specular.
    edgeHi: 0, edgeDark: 0, rimPx: 1,
    gradK: GRAD_K,
  });
}

function paint(s: Surface, list: DisplayList): void {
  const { el } = s;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  // Entirely off-screen: nothing to show, and the backdrop is unknown anyway.
  if (rect.bottom <= 0 || rect.right <= 0
    || rect.top >= innerHeight || rect.left >= innerWidth) return;

  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden") return;

  const d = dpr();

  // ★ THE REPLAY, not a reconstruction. The DOM was walked once for the whole
  //   frame; this is canvas drawing with no style resolution in it, which is
  //   what lets every surface update on every frame instead of taking turns.
  const res = paintDisplayList(s.src, list, {
    x: rect.left, y: rect.top, w: rect.width, h: rect.height,
  }, d, el);

  const stats: ReconstructStats = {
    ...list.stats,
    ms: res.ms,
    unpaintable: res.unpaintable,
    unpaintableWhy: res.unpaintableWhy,
  };

  // ★ THE GATE. Anything under this surface that this painter would draw WRONG
  //   hands the surface back rather than shipping an approximation. Re-checked
  //   on every paint, because the DOM under a surface changes.
  //
  //   ★★ CURRENTLY DISABLED ON PURPOSE (fallbackEnabled === false), so every
  //   surface stays on the canvas path and its mistakes are VISIBLE instead of
  //   being quietly papered over by backdrop-filter. That is a testing posture,
  //   not a decision: with it off, an unpaintable element shows up as a wrong
  //   pixel rather than as a surface that silently reverted. Turn it back on
  //   with `?lqg-fallback=1` — or by flipping the constant — before shipping to
  //   anyone who is not deliberately looking for defects.
  s.lastStats = stats;
  if (stats.unpaintable > 0) {
    if (fallbackEnabled) {
      release(el, `${stats.unpaintable} unpaintable: ${stats.unpaintableWhy.slice(0, 3).join(", ")}`);
      return;
    }
    if (import.meta.env?.DEV && !s.warnedUnpaintable) {
      s.warnedUnpaintable = true;
      console.warn(`[glass-canvas] ${el.className || el.tagName}: ` +
        `${stats.unpaintable} unpaintable, PAINTING ANYWAY (fallback off) — ` +
        stats.unpaintableWhy.slice(0, 3).join(", "));
    }
  }

  const blurPx = readBlur(el);
  if (blurPx > 0) blurInPlace(s.src, blurPx * d);

  s.gl.upload(s.src);
  renderOnly(s, rect, cs, d);
  s.lastRect = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  s.paints++;
  totalPaints++;
}

/**
 * Diagnostic hook for scripts/verify-canvas-glass.cjs. Reporting what the
 * engine BELIEVES it did is not evidence it did it — the verifier reads pixels
 * out of the composited screenshot for that — but it is how a failure gets
 * attributed to the reconstruction rather than to the layering.
 */
interface GlassCanvasWindow extends Window {
  __lqgCanvas?: () => Array<Record<string, unknown>>;
  __lqgCanvasTotals?: () => Record<string, number | boolean>;
}
function installDebugHook(): void {
  (window as GlassCanvasWindow).__lqgCanvasTotals = () => ({
    paints: totalPaints,
    reflows: totalReflows,
    claims: totalClaims,
    surfaces: surfaces.size,
    motionActive: performance.now() < motionUntil,
    fallbackEnabled,
    paused,
    dirty: [...surfaces.values()].filter((s) => s.dirty).length,
    motionForMs: Math.max(0, Math.round(motionUntil - performance.now())),
    oldestDirtyMs: Math.round(Math.max(0, ...[...surfaces.values()]
      .filter((s) => s.dirty).map((s) => performance.now() - s.dirtySince))),
    rafPending: rafHandle !== 0,
    lists: totalLists,
    lastListMs: Math.round(lastListMs * 100) / 100,
    ...sched,
  });
  (window as GlassCanvasWindow).__lqgCanvas = () => [...surfaces.values()].map((s) => {
    const r = s.el.getBoundingClientRect();
    return {
      cls: (s.el.className || "").toString().split(/\s+/).filter(Boolean).slice(0, 3).join("."),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      canvas: [s.canvas.width, s.canvas.height],
      paints: s.paints,
      reflows: s.reflows,
      dirty: s.dirty,
      fallbackEnabled,
      stats: s.lastStats && {
        ms: +s.lastStats.ms.toFixed(2),
        rects: s.lastStats.rects, gradients: s.lastStats.gradients,
        borders: s.lastStats.borders, lines: s.lastStats.lines,
        glyphs: s.lastStats.glyphs, blits: s.lastStats.blits,
        unpaintable: s.lastStats.unpaintable,
        skipped: s.lastStats.skipped,
      },
    };
  });
}

/** Blur a canvas in place, matching the chain's backdrop blur. */
let blurScratch: HTMLCanvasElement | null = null;
function blurInPlace(c: HTMLCanvasElement, px: number): void {
  if (!(px > 0) || c.width < 1 || c.height < 1) return;
  if (!blurScratch) blurScratch = document.createElement("canvas");
  const t = blurScratch;
  if (t.width !== c.width) t.width = c.width;
  if (t.height !== c.height) t.height = c.height;
  const tc = t.getContext("2d");
  const sc = c.getContext("2d");
  if (!tc || !sc) return;
  tc.setTransform(1, 0, 0, 1, 0, 0);
  tc.clearRect(0, 0, t.width, t.height);
  tc.filter = `blur(${px}px)`;
  tc.drawImage(c, 0, 0);
  tc.filter = "none";
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.clearRect(0, 0, c.width, c.height);
  sc.drawImage(t, 0, 0);
}

/** A cheap fingerprint of everything a repaint depends on. */
function geometryKey(el: HTMLElement): string {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},` +
    `${Math.round(r.height)},${dpr()},${cs.backgroundColor},${cs.borderTopLeftRadius}`;
}

// ── Scheduling ──────────────────────────────────────────────────────────────

function markDirty(s: Surface): void {
  if (!s.dirty) {
    s.dirty = true;
    s.dirtySince = performance.now();
  }
}

function invalidateAll(): void {
  for (const s of surfaces.values()) markDirty(s);
  schedule();
}

/**
 * ★ INVALIDATE BY REGION, NOT WHOLESALE — this is a measured perf fix, not a
 * refinement.
 *
 * The first version dirtied every surface on any mutation anywhere, and this
 * app mutates inline styles continuously — the edge-colour engine rewrites its
 * gradient stack as its sources move — so every one of those writes was read as
 * "the world changed" and every backdrop was reconstructed every frame, on an
 * engine whose own draw call costs 0.01 ms.
 *
 * Measured after the fix: 0 reconstructions/sec while idle, against 86 across
 * 20 scroll steps. Idle is genuinely free, which backdrop-filter never is.
 *
 * Two rules do it, and both are about what CANNOT affect a given surface:
 *   · a mutation inside a claimed surface is its own CONTENT, which paints over
 *     the glass and is never part of its backdrop;
 *   · a mutation whose element does not overlap a surface cannot change that
 *     surface's backdrop, whatever else it changed.
 */
function invalidateNear(target: Node): void {
  const el = target.nodeType === 1 ? target as Element : target.parentElement;
  if (!el) return;

  // Layers this engine never paints: mutating them cannot change our output.
  // The edge-colour body and rim are the loud ones — they rewrite inline
  // styles as their sources move, and the reconstruction skips them anyway.
  if (el.closest?.(".lqg-edge-color, .lqg-edge-rim, .lqg-canvas")) return;

  const owner = el.closest?.("[" + CANVAS_GLASS_ATTR + "]");
  let r: DOMRect | null = null;
  try {
    r = (el as Element).getBoundingClientRect?.() ?? null;
  } catch { /* detached */ }

  let any = false;
  for (const s of surfaces.values()) {
    if (owner === s.el) continue;                  // its own content, not backdrop
    if (s.dirty) { any = true; continue; }
    if (r && (r.width > 0 || r.height > 0)) {
      const sr = s.el.getBoundingClientRect();
      const overlaps = r.right > sr.left && r.left < sr.right
        && r.bottom > sr.top && r.top < sr.bottom;
      if (!overlaps) continue;
    }
    markDirty(s);
    any = true;
  }
  if (any) schedule();
}

function schedule(): void {
  if (rafHandle || paused) return;
  rafHandle = requestAnimationFrame(() => {
    rafHandle = 0;
    sched.runs++;
    if (paused) { sched.skipped++; return; }
    const started = performance.now();

    // ★ ONE WALK FOR THE WHOLE FRAME. The region is the union of every dirty
    //   surface, so the DOM is traversed once no matter how many surfaces need
    //   repainting — which is the difference between all of them tracking a
    //   scroll and a few of them taking turns.
    const pending: Surface[] = [];
    for (const s of surfaces.values()) if (s.dirty) pending.push(s);
    if (!pending.length) return;

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of pending) {
      const r = s.el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top);
      x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
    }
    if (!Number.isFinite(x0)) { for (const s of pending) s.dirty = false; return; }

    let list: DisplayList;
    try {
      list = buildDisplayList({ region: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
    } catch (err) {
      console.error("[glass-canvas] display list failed", err);
      for (const s of pending) s.dirty = false;
      return;
    }
    lastListMs = list.stats.ms;
    totalLists++;

    let budget = MAX_REPAINTS_PER_FRAME;
    let remaining = false;
    for (const s of pending) {
      if (!s.dirty) continue;
      // ★ NO DEFERRAL. An earlier version held repaints back during CSS
      //   transitions and rate-limited them to two surfaces a frame, which is
      //   exactly what made the glass lag: at seven surfaces a full refresh
      //   took four frames, so a scroll left the backdrop visibly behind the
      //   page. With one shared walk a whole frame's worth of surfaces replays
      //   in a fraction of a millisecond, so they all update, every frame.
      //
      //   The budget survives only as a runaway guard for a pathological frame
      //   (a hundred surfaces, a giant panel); it is not expected to trip.
      if (budget <= 0 || performance.now() - started > FRAME_BUDGET_MS) {
        sched.breaks++;
        remaining = true;
        break;
      }
      s.dirty = false;
      budget--;
      try {
        sched.calls++;
        paint(s, list);
        s.lastKey = geometryKey(s.el);
      } catch (err) {
        // With the fallback off there is nowhere to hand the surface back to,
        // so a throwing surface is dropped rather than left mid-paint.
        if (fallbackEnabled) release(s.el, `paint threw: ${(err as Error)?.message ?? err}`);
        else console.error("[glass-canvas] paint threw", err);
      }
    }
    if (remaining) schedule();
  });
}

function syncPauseState(): void {
  const next = PAUSE_BODY_CLASSES.some((c) => document.body.classList.contains(c));
  if (next === paused) return;
  paused = next;
  // ★ COMING BACK FROM A PAUSE MUST REPAINT. While paused the canvas holds its
  //   last frame, which is correct only for as long as the backdrop is also
  //   frozen — and an unfocused window can be scrolled the moment it is focused
  //   again. Resuming without invalidating is how a surface ends up showing a
  //   backdrop from several seconds ago.
  if (!paused) invalidateAll();
}

// ── Entry point ─────────────────────────────────────────────────────────────

function scan(root: ParentNode): void {
  if (root instanceof Element && eligible(root)) {
    if (!surfaces.has(root) && !claim(root)) declined.add(root);
  }
  root.querySelectorAll?.(CLAIM_SELECTOR).forEach((el) => {
    if (!eligible(el)) return;
    if (surfaces.has(el as HTMLElement)) return;
    if (!claim(el as HTMLElement)) declined.add(el);
  });
}

/**
 * Turn the canvas path on. Safe to call more than once, and a complete no-op
 * when WebGL2 is unavailable — in which case every surface stays on the SVG
 * engine exactly as before.
 */
/**
 * ★ THE KILL SWITCH. A new rendering engine for every panel in the app needs a
 * way to be turned off that does not require a rebuild — for bisecting a visual
 * report, for A/B screenshots, and for the user who just wants the old one
 * back. `?lqg-canvas=0` on the URL, or `localStorage["lqg-canvas"] = "off"`.
 * Either one leaves every surface on the SVG engine exactly as before.
 */
function killed(): boolean {
  try {
    if (new URLSearchParams(location.search).get("lqg-canvas") === "0") return true;
    if (localStorage.getItem("lqg-canvas") === "off") return true;
  } catch {
    // Storage or URL unavailable (a sandboxed context) — not a reason to bail.
  }
  return false;
}

export function initCanvasGlass(): void {
  if (started) return;
  if (killed()) return;
  try {
    const q = new URLSearchParams(location.search).get("lqg-fallback");
    if (q === "1") fallbackEnabled = true;
    else if (q === "0") fallbackEnabled = false;
  } catch { /* no URL */ }
  // One probe context, so a machine without WebGL2 never creates per-surface
  // canvases it cannot use.
  const probe = document.createElement("canvas").getContext("webgl2");
  if (!probe) return;
  probe.getExtension("WEBGL_lose_context")?.loseContext();
  started = true;

  const startup = () => {
    installDebugHook();
    flattenTarget = readFlattenTarget();
    scan(document.body);
    syncPauseState();
    invalidateAll();

    // Anything appearing, moving or leaving invalidates: this engine's backdrop
    // is the whole document, not just the element.
    const mo = new MutationObserver((muts) => {
      for (const mut of muts) {
        if (mut.type === "childList") {
          mut.addedNodes.forEach((n) => { if (n.nodeType === 1) scan(n as Element); });
          mut.removedNodes.forEach((n) => {
            if (n.nodeType !== 1) return;
            const el = n as Element;
            unbind(el);
            el.querySelectorAll?.(CLAIM_SELECTOR).forEach(unbind);
          });
        } else if (mut.type === "attributes") {
          if (mut.target instanceof Element && eligible(mut.target)
            && !surfaces.has(mut.target)) {
            if (!claim(mut.target)) declined.add(mut.target);
          }
        }
        invalidateNear(mut.target);
      }
    });
    mo.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["class", "style"],
    });

    const bodyClasses = new MutationObserver(syncPauseState);
    bodyClasses.observe(document.body, { attributes: true, attributeFilter: ["class"] });

    // Scroll is the commonest backdrop change and does not mutate anything.
    window.addEventListener("scroll", invalidateAll, { passive: true, capture: true });
    window.addEventListener("resize", invalidateAll, { passive: true });

    // ★ TRANSITIONS, TRACKED EXPLICITLY. Only transitions, never animations:
    //   an infinite CSS animation fires `animationstart` once and would pin the
    //   counter above zero forever, freezing every backdrop in the app.
    /** Longest declared transition-duration on the element, in ms. */
    const durationOf = (el: Element): number => {
      const raw = getComputedStyle(el).transitionDuration || "0s";
      let max = 0;
      for (const part of raw.split(",")) {
        const t = part.trim();
        const v = parseFloat(t);
        if (!Number.isFinite(v)) continue;
        max = Math.max(max, t.endsWith("ms") ? v : v * 1000);
      }
      return max;
    };
    document.addEventListener("transitionrun", (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      // Ignore the layers this engine never paints, so their transitions do not
      // hold every other surface's backdrop hostage.
      if (t.closest(".lqg-edge-color, .lqg-edge-rim, .lqg-canvas")) return;
      const d = Math.min(durationOf(t), MOTION_MAX_MS);
      if (d <= 0) return;
      motionUntil = Math.max(motionUntil, performance.now() + d);
    }, { passive: true, capture: true });
    const ended = (e: Event) => {
      // Do NOT clear the deadline — another transition may still be running and
      // there is no way to know from here. It expires on its own.
      invalidateNear(e.target as Node);
    };
    document.addEventListener("transitionend", ended, { passive: true, capture: true });
    document.addEventListener("transitioncancel", ended, { passive: true, capture: true });

    const schemeMq = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    schemeMq?.addEventListener?.("change", () => {
      // The flatten target is the page's own tone, so it flips with the scheme.
      // Read it on the next frame: the CSS variable is resolved from a media
      // query that has not necessarily been applied when this fires.
      requestAnimationFrame(() => {
        flattenTarget = readFlattenTarget();
        invalidateAll();
      });
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startup, { once: true });
  } else {
    startup();
  }
}
