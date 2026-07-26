/**
 * Dev-only refraction-direction diagnostic (see glass-direction.html).
 * Same readiness contract as glass-verify.ts so glass-pixel-diff.cjs can
 * drive it with GLASS_VERIFY_URL=http://localhost:5173/glass-direction.html.
 * Not imported by the app.
 */

import { initLiquidGlassFilter } from "./lib/liquid-glass-filter";

interface Spec { cls: string; w: number; h: number; r: number; x: number; y: number }

interface SpecX extends Spec { style?: Partial<CSSStyleDeclaration> }

const SPECS: SpecX[] = [
  // over VERTICAL stripes — reveals horizontal displacement
  { cls: "liquid-glass", w: 400, h: 260, r: 28,  x: 100, y: 60 },
  { cls: "liquid-glass", w: 240, h: 240, r: 120, x: 180, y: 420 },
  // over HORIZONTAL stripes — reveals vertical displacement
  { cls: "liquid-glass", w: 400, h: 260, r: 28,  x: 700, y: 60 },
  { cls: "liquid-glass", w: 240, h: 240, r: 120, x: 780, y: 420 },
  // the app's actual hero shapes: the toolbar pill spans BOTH stripe fields
  { cls: "liquid-glass toolbar",        w: 1100, h: 44, r: 22, x: 50,  y: 710 },
  { cls: "liquid-glass settings-panel", w: 260, h: 260, r: 24, x: 330, y: 380,
    style: { zIndex: "2" } },
  // knob presets at real layout size, CSS-magnified 6x for inspection (the
  // transform does not change the filter, only the displayed raster)
  { cls: "glass-range-knob liquid-glass-control-knob",  w: 20, h: 14, r: 999,
    x: 80, y: 800, style: { transform: "scale(6)", transformOrigin: "0 0", zIndex: "2" } },
  { cls: "glass-toggle-knob liquid-glass-control-knob", w: 32, h: 24, r: 999,
    x: 300, y: 795, style: { transform: "scale(6)", transformOrigin: "0 0", zIndex: "2" } },
];

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

initLiquidGlassFilter();

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
