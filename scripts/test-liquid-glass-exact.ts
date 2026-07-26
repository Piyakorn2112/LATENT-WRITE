/**
 * Zero-visual-change harness for the liquid-glass displacement map.
 *
 * Run: npm run test:glass-exact
 *
 * Runs the FROZEN baseline and the LIVE worker over every glass shape the app
 * actually creates, and asserts the produced map bytes are IDENTICAL.
 * Also times both so the speedup is measured, not asserted.
 *
 * Exits 1 on any difference. See test-liquid-glass-fuzz.ts for the
 * randomised-geometry counterpart, and glass-pixel-diff.cjs for the
 * integration-level (real Chromium) proof.
 */

import { buildMapPixels as baseline, type MapRequest, type MapPixels } from "./liquid-glass-baseline.ts";

// The worker module assigns self.onmessage at import time.
(globalThis as any).self = { onmessage: null };

const live = (await import(
  "../src/lib/liquid-glass-worker.ts"
)) as { buildMapPixels: (req: MapRequest) => MapPixels };

// ── The real shapes ───────────────────────────────────────────────────────
// Each entry mirrors what liquid-glass-filter.ts computes for that element:
//   dispEff  = effectiveDisp(disp, w, h, r, bezel, profile)   (fold-free cap)
//   overflow = ceil(dispEff) + blur * 2 + 4
// Keep this mirror in sync with FOLD_SAFE / PROFILE_SLOPE / BEZEL_PX_MAIN.
const FOLD_SAFE = 0.85;
const PROFILE_SLOPE = 3;
const BEZEL_MAIN = 120;
function dispEff(
  disp: number, w: number, h: number, radius: number, bezel: number | null, profile: "snell" | "foldfree",
): number {
  if (profile === "snell") return disp;
  const halfShorter = Math.min(w, h) / 2;
  const bz = Math.min(bezel ?? BEZEL_MAIN, halfShorter * 0.8);
  const r = Math.min(Math.max(radius, 1), halfShorter);
  const edgeCap = (FOLD_SAFE * bz) / PROFILE_SLOPE;
  const cornerCap = Math.max(FOLD_SAFE * r, 0.3 * edgeCap);
  return Math.min(disp, edgeCap, cornerCap);
}
interface Geo { w: number; h: number; r: number; bezel?: number | null; profile?: "snell" | "foldfree" }
function mk(label: string, g: Geo, disp: number, blur: number, preset: MapRequest["preset"], superSample = 1): Case {
  const profile = g.profile ?? "foldfree";
  const overflow = Math.ceil(dispEff(disp, g.w, g.h, g.r, g.bezel ?? null, profile)) + blur * 2 + 4;
  return { label, id: "c", elemW: g.w, elemH: g.h, radius: g.r, overflow, preset, bezel: g.bezel ?? null, superSample, profile };
}

interface Case extends MapRequest { label: string }
const CASES: Case[] = [
  mk("range knob        20x14   ", { w: 20, h: 14, r: 999 }, 40, 0, "control-knob"),
  mk("toggle knob       32x24   ", { w: 32, h: 24, r: 999 }, 40, 0, "toggle-control-knob"),
  mk("loading lens     100x100  ", { w: 100, h: 100, r: 50, bezel: 20, profile: "snell" }, 20, 0.2, "default", 4),
  mk("toolbar         1100x44   ", { w: 1100, h: 44, r: 22 }, 40, 1.2, "default"),
  mk("analysis tab     160x36   ", { w: 160, h: 36, r: 18 }, 40, 1.2, "default"),
  mk("status pill      120x28   ", { w: 120, h: 28, r: 14 }, 40, 1.2, "default"),
  mk("annot. popover   320x180  ", { w: 320, h: 180, r: 14 }, 40, 2, "default"),
  mk("annot. panel     300x520  ", { w: 300, h: 520, r: 16 }, 40, 2, "default"),
  mk("settings panel   420x620  ", { w: 420, h: 620, r: 18 }, 40, 3, "default"),
  mk("wide panel       900x700  ", { w: 900, h: 700, r: 18 }, 40, 5, "default"),
  mk("square-ish       260x260  ", { w: 260, h: 260, r: 24 }, 40, 5, "default"),
  mk("tiny pill         48x20   ", { w: 48, h: 20, r: 10 }, 40, 1.2, "default"),
  // Edge cases: radius 0, radius = half (circle), thin sliver, bezel > halfShorter
  mk("sharp corners    200x120 r0", { w: 200, h: 120, r: 0 }, 40, 5, "default"),
  mk("circle           140x140  ", { w: 140, h: 140, r: 70 }, 40, 5, "default"),
  mk("sliver           600x8    ", { w: 600, h: 8, r: 4 }, 40, 1.2, "default"),
  mk("big+divisor10   1000x400  ", { w: 1000, h: 400, r: 20 }, 40, 5, "default"),
  mk("odd frac      333.5x77.5  ", { w: 333.5, h: 77.5, r: 15.5 }, 40, 1.2, "default"),
  // The legacy profile must keep working for arbitrary defaults too.
  mk("snell panel      320x180  ", { w: 320, h: 180, r: 14, profile: "snell" }, 40, 2, "default"),
];

function time(fn: () => MapPixels, warm: number, runs: number) {
  for (let i = 0; i < warm; i++) fn();
  const t0 = performance.now();
  let out!: MapPixels;
  for (let i = 0; i < runs; i++) out = fn();
  return { ms: (performance.now() - t0) / runs, out };
}

function diff(a: MapPixels, b: MapPixels) {
  if (a.mw !== b.mw || a.mh !== b.mh) return `DIM ${a.mw}x${a.mh} vs ${b.mw}x${b.mh}`;
  if (a.outW !== b.outW || a.outH !== b.outH) return `OUT ${a.outW}x${a.outH} vs ${b.outW}x${b.outH}`;
  if (a.needsDownscale !== b.needsDownscale) return `DOWNSCALE ${a.needsDownscale} vs ${b.needsDownscale}`;
  let bad = 0;
  let first = -1;
  let maxD = 0;
  const chan = [0, 0, 0, 0];
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i] - b.data[i]);
    if (d !== 0) {
      bad++;
      chan[i & 3]++;
      if (first < 0) first = i;
      if (d > maxD) maxD = d;
    }
  }
  if (bad === 0) return null;
  const px = first >> 2;
  return `${bad} bytes differ (max delta ${maxD}) R:${chan[0]} G:${chan[1]} B:${chan[2]} A:${chan[3]}` +
    ` · first at px (${px % a.mw},${(px / a.mw) | 0}) ch ${first & 3}`;
}

const isQuick = process.argv.includes("--quick");
let fails = 0;
let totBase = 0;
let totLive = 0;

console.log("shape                        map px    baseline    optimized   speedup   bytes");
console.log("─".repeat(88));

for (const c of CASES) {
  const runs = isQuick ? 1 : 3;
  const warm = isQuick ? 0 : 1;
  const b = time(() => baseline(c), warm, runs);
  const l = time(() => live.buildMapPixels(c), warm, runs);
  const d = diff(b.out, l.out);
  if (d) fails++;
  totBase += b.ms;
  totLive += l.ms;
  const mpx = (b.out.mw * b.out.mh / 1e6).toFixed(2);
  console.log(
    `${c.label} ${mpx.padStart(7)}M ${b.ms.toFixed(1).padStart(9)}ms ${l.ms.toFixed(1).padStart(9)}ms` +
    `${(b.ms / l.ms).toFixed(2).padStart(8)}x   ${d ? "✗ " + d : "identical"}`,
  );
}

console.log("─".repeat(88));
console.log(
  `TOTAL ${totBase.toFixed(1)}ms → ${totLive.toFixed(1)}ms  (${(totBase / totLive).toFixed(2)}x faster, ` +
  `${(100 - (totLive / totBase) * 100).toFixed(1)}% less CPU)`,
);
console.log(fails === 0 ? "\n✓ ALL MAPS BYTE-IDENTICAL — zero visual change proven" : `\n✗ ${fails} case(s) DIFFER`);
process.exit(fails === 0 ? 0 : 1);
