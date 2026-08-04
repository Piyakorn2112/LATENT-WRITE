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

import { reconstructBackdrop, type ReconstructStats } from "./backdrop";
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
const BEZEL_PX = 120;
const GRAD_K = 40;
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
}

const surfaces = new Map<HTMLElement, Surface>();
/** Elements this engine has looked at and refused, so it does not retry forever. */
const declined = new WeakSet<Element>();
let flattenTarget = FLATTEN_TARGET_FALLBACK;
let rafHandle = 0;
let paused = false;
let started = false;

/** Surfaces repainted per frame. Reconstruction is ~0.2-1 ms each; this bounds
 *  a burst (a chapter switch dirties everything at once) to a fraction of a
 *  frame and lets the rest land on the next one. */
const MAX_REPAINTS_PER_FRAME = 3;

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
  });
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

/** Never let a surface reconstruct itself, its own canvas, or its content. */
function excluderFor(el: HTMLElement) {
  return (candidate: Element) => candidate === el;
}

function paint(s: Surface): void {
  const { el } = s;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  // Entirely off-screen: nothing to show, and the backdrop is unknown anyway.
  if (rect.bottom <= 0 || rect.right <= 0
    || rect.top >= innerHeight || rect.left >= innerWidth) return;

  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden") return;

  const d = dpr();
  const stats: ReconstructStats = reconstructBackdrop(s.src, {
    rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
    dpr: d,
    exclude: excluderFor(el),
  });

  // ★ THE GATE. Anything under this surface that this painter would draw WRONG
  //   hands the surface back rather than shipping an approximation. Re-checked
  //   on every paint, because the DOM under a surface changes.
  s.lastStats = stats;
  if (stats.unpaintable > 0) {
    release(el, `${stats.unpaintable} unpaintable: ${stats.unpaintableWhy.slice(0, 3).join(", ")}`);
    return;
  }

  const blurPx = readBlur(el);
  if (blurPx > 0) blurInPlace(s.src, blurPx * d);

  s.gl.upload(s.src);

  const halfShort = Math.min(rect.width, rect.height) / 2;
  const radius = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, halfShort);
  const bezel = Math.min(BEZEL_PX, halfShort * 0.8);
  const [fr, fg, fb, fa] = parseRgba(cs.backgroundColor);

  s.gl.render({
    w: rect.width, h: rect.height, dpr: d,
    radius,
    bezel: Math.max(1, bezel),
    peak: Math.min(PEAK_PULL_PX, bezel),
    chroma: CHROMA_SPLIT,
    saturate: readSaturate(el),
    flatten: readFlatten(el),
    flattenTarget,
    fill: [fr, fg, fb, fa],
    // The rim shading belongs to ::before and ::after, which are untouched and
    // still paint on top. Adding it here would double the specular.
    edgeHi: 0, edgeDark: 0, rimPx: 1,
    gradK: GRAD_K,
  });
  s.paints++;
}

/**
 * Diagnostic hook for scripts/verify-canvas-glass.cjs. Reporting what the
 * engine BELIEVES it did is not evidence it did it — the verifier reads pixels
 * out of the composited screenshot for that — but it is how a failure gets
 * attributed to the reconstruction rather than to the layering.
 */
interface GlassCanvasWindow extends Window {
  __lqgCanvas?: () => Array<Record<string, unknown>>;
}
function installDebugHook(): void {
  (window as GlassCanvasWindow).__lqgCanvas = () => [...surfaces.values()].map((s) => {
    const r = s.el.getBoundingClientRect();
    return {
      cls: (s.el.className || "").toString().split(/\s+/).filter(Boolean).slice(0, 3).join("."),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      canvas: [s.canvas.width, s.canvas.height],
      paints: s.paints,
      dirty: s.dirty,
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

function invalidateAll(): void {
  for (const s of surfaces.values()) s.dirty = true;
  schedule();
}

/**
 * ★ INVALIDATE BY REGION, NOT WHOLESALE — this is a measured perf fix, not a
 * refinement.
 *
 * The first version dirtied every surface on any mutation anywhere. Measured
 * with scripts/glass-app-profile.cjs: 12.23 ms/frame against 9.37 with the
 * engine off — a 30% regression, on an engine whose own draw call costs 0.01 ms.
 * The cost was not the refraction, it was reconstructing every backdrop every
 * frame, because something in this app mutates inline styles continuously (the
 * edge-colour engine rewrites its gradient stack as its sources move) and every
 * one of those writes was being read as "the world changed".
 *
 * Two rules fix it, and both are about what CANNOT affect a given surface:
 *   · a mutation inside a claimed surface is its own CONTENT, which paints над
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
    s.dirty = true;
    any = true;
  }
  if (any) schedule();
}

function schedule(): void {
  if (rafHandle || paused) return;
  rafHandle = requestAnimationFrame(() => {
    rafHandle = 0;
    if (paused) return;
    let budget = MAX_REPAINTS_PER_FRAME;
    let remaining = false;
    for (const s of surfaces.values()) {
      if (!s.dirty) continue;
      if (budget <= 0) { remaining = true; break; }
      s.dirty = false;
      budget--;
      try {
        // Skip the work when nothing a repaint depends on has moved AND the
        // backdrop was not the thing that changed. `dirty` is set by the
        // observers, so reaching here means something did — the key only
        // short-circuits the geometry half.
        paint(s);
        s.lastKey = geometryKey(s.el);
      } catch (err) {
        release(s.el, `paint threw: ${(err as Error)?.message ?? err}`);
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
