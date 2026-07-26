/**
 * Dev-only shear diagnostic (see glass-shear.html + scripts/glass-shear.cjs).
 * Publishes the specimen rectangles on `window.__specs` so the analyser knows
 * exactly which pixels belong to which piece of glass.
 * Not imported by the app.
 */

import { initLiquidGlassFilter } from "./lib/liquid-glass-filter";

export interface ShearSpec { cls: string; w: number; h: number; r: number; x: number; y: number; label: string }

const SPECS: ShearSpec[] = [
  // the real toolbar geometry — the shape in the report
  { label: "toolbar 1100x44 r22", cls: "liquid-glass toolbar", w: 1100, h: 44, r: 22, x: 50, y: 120 },
  // a tall panel: top/bottom edges far apart, so a shear is unmistakable
  { label: "panel 600x300 r18", cls: "liquid-glass settings-panel", w: 600, h: 300, r: 18, x: 50, y: 260 },
  // a square with big corners, and a circle — different gradient regimes
  { label: "square 300x300 r24", cls: "liquid-glass", w: 300, h: 300, r: 24, x: 700, y: 260 },
  { label: "circle 220x220 r110", cls: "liquid-glass", w: 220, h: 220, r: 110, x: 700, y: 610 },
];

const dir = new URLSearchParams(location.search).get("dir") === "h" ? "h" : "v";
document.body.dataset.dir = dir;
(window as unknown as Record<string, unknown>).__dir = dir;

const host = document.getElementById("specimens")!;
for (const spec of SPECS) {
  const el = document.createElement("div");
  el.className = `spec ${spec.cls}`;
  el.style.left = `${spec.x}px`;
  el.style.top = `${spec.y}px`;
  el.style.width = `${spec.w}px`;
  el.style.height = `${spec.h}px`;
  el.style.borderRadius = `${spec.r}px`;
  host.appendChild(el);
}
(window as unknown as Record<string, unknown>).__specs = SPECS;

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
  if (n < total && performance.now() - started < 20000) return;
  window.clearInterval(poll);
  let frames = 0;
  const settle = () => {
    if (++frames < 12) { requestAnimationFrame(settle); return; }
    (window as unknown as Record<string, unknown>).__glassBound = n;
    (window as unknown as Record<string, unknown>).__glassTotal = total;
    (window as unknown as Record<string, unknown>).__glassReady = true;
  };
  requestAnimationFrame(settle);
}, 50);
