/**
 * Dev-only harness: one specimen per liquid-glass preset over a hostile
 * backdrop, driven by the real `initLiquidGlassFilter()` engine.
 *
 * Used by scripts/glass-pixel-diff.cjs to prove a change to the glass engine
 * is pixel-identical. Every specimen carries the class the engine dispatches
 * on (readBlur / readDisp / readBezel / readSuperSample / readMapPreset all
 * key off classes) plus an explicit size and border-radius, because those are
 * the only element properties the engine reads.
 *
 * Not imported by the app.
 */

import { initLiquidGlassFilter } from "./lib/liquid-glass-filter";

interface Spec {
  cls: string;
  w: number;
  h: number;
  r: number;
  x: number;
  y: number;
  /** Extra inline styles (the lens is normally scaled + hidden by CSS). */
  style?: Partial<CSSStyleDeclaration>;
}

// Sizes mirror what the app actually lays out; see styles.css.
const SPECS: Spec[] = [
  { cls: "liquid-glass toolbar",                     w: 1100, h: 44,  r: 22, x: 40,  y: 20 },
  { cls: "liquid-glass analysis-tab",                w: 160,  h: 36,  r: 18, x: 40,  y: 90 },
  { cls: "liquid-glass status-pill",                 w: 120,  h: 28,  r: 14, x: 230, y: 94 },
  { cls: "liquid-glass annotation-popover",          w: 320,  h: 180, r: 14, x: 400, y: 90 },
  { cls: "liquid-glass annotation-panel",            w: 300,  h: 320, r: 16, x: 760, y: 90 },
  { cls: "liquid-glass settings-panel",              w: 260,  h: 260, r: 24, x: 40,  y: 150 },
  { cls: "liquid-glass",                             w: 200,  h: 120, r: 0,  x: 40,  y: 440 },
  { cls: "liquid-glass",                             w: 140,  h: 140, r: 70, x: 270, y: 440 },
  { cls: "liquid-glass",                             w: 600,  h: 8,   r: 4,  x: 40,  y: 600 },
  { cls: "liquid-glass",                             w: 48,   h: 20,  r: 10, x: 660, y: 440 },
  // Control knobs: their own map preset (channel gain + edge AA + 12/16×
  // oversample), so they exercise a completely different code path.
  { cls: "glass-range-knob liquid-glass-control-knob",  w: 20, h: 14, r: 999, x: 740, y: 452 },
  { cls: "glass-toggle-knob liquid-glass-control-knob", w: 32, h: 24, r: 999, x: 790, y: 448 },
  // The loading lens: supersampled map, its own refraction/bezel/saturate.
  {
    cls: "liquid-glass-lens",
    w: 100, h: 100, r: 50, x: 900, y: 620,
    style: { transform: "translate(0, 0) scale(2)", opacity: "1" },
  },
];

function build() {
  // Deterministic filler text — no Math.random, no Date.
  const filler = document.getElementById("filler")!;
  let s = "";
  for (let i = 0; i < 240; i++) {
    s += `${String(i).padStart(3, "0")} the quick brown fox jumps over the lazy dog 0123456789 `;
  }
  filler.textContent = s;

  const host = document.getElementById("specimens")!;
  for (const spec of SPECS) {
    const el = document.createElement("div");
    el.className = `spec ${spec.cls}`;
    el.style.left = `${spec.x}px`;
    el.style.top = `${spec.y}px`;
    el.style.width = `${spec.w}px`;
    el.style.height = `${spec.h}px`;
    el.style.borderRadius = `${spec.r}px`;
    if (spec.style) Object.assign(el.style, spec.style);
    host.appendChild(el);
  }
  return host;
}

const host = build();
initLiquidGlassFilter();

// Signal readiness only once every specimen has a generated filter bound (the
// engine defers to requestIdleCallback and then to a worker round-trip), then
// give the compositor a few frames to raster the backdrop-filters.
const total = SPECS.length;
function bound(): number {
  let n = 0;
  for (const el of Array.from(host.children) as HTMLElement[]) {
    if (el.style.backdropFilter.startsWith("url(")) n++;
  }
  return n;
}

const started = performance.now();
const poll = window.setInterval(() => {
  const n = bound();
  const timedOut = performance.now() - started > 20000;
  if (n < total && !timedOut) return;
  window.clearInterval(poll);
  let frames = 0;
  const settle = () => {
    if (++frames < 12) {
      requestAnimationFrame(settle);
      return;
    }
    (window as unknown as Record<string, unknown>).__glassBound = n;
    (window as unknown as Record<string, unknown>).__glassTotal = total;
    (window as unknown as Record<string, unknown>).__glassReady = true;
  };
  requestAnimationFrame(settle);
}, 50);
