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
//   overflow = disp + blur * 2 + 4
const ovf = (disp: number, blur: number) => disp + blur * 2 + 4;

interface Case extends MapRequest { label: string }
const CASES: Case[] = [
  { label: "range knob        20x14   ", id: "c", elemW: 20, elemH: 14, radius: 999, overflow: ovf(40, 0), preset: "control-knob", bezel: null, superSample: 1 },
  { label: "toggle knob       32x24   ", id: "c", elemW: 32, elemH: 24, radius: 999, overflow: ovf(40, 0), preset: "toggle-control-knob", bezel: null, superSample: 1 },
  { label: "loading lens     100x100  ", id: "c", elemW: 100, elemH: 100, radius: 50, overflow: ovf(20, 0.2), preset: "default", bezel: 20, superSample: 4 },
  { label: "toolbar         1100x44   ", id: "c", elemW: 1100, elemH: 44, radius: 22, overflow: ovf(40, 1.2), preset: "default", bezel: null, superSample: 1 },
  { label: "analysis tab     160x36   ", id: "c", elemW: 160, elemH: 36, radius: 18, overflow: ovf(40, 1.2), preset: "default", bezel: null, superSample: 1 },
  { label: "status pill      120x28   ", id: "c", elemW: 120, elemH: 28, radius: 14, overflow: ovf(40, 1.2), preset: "default", bezel: null, superSample: 1 },
  { label: "annot. popover   320x180  ", id: "c", elemW: 320, elemH: 180, radius: 14, overflow: ovf(40, 2), preset: "default", bezel: null, superSample: 1 },
  { label: "annot. panel     300x520  ", id: "c", elemW: 300, elemH: 520, radius: 16, overflow: ovf(40, 2), preset: "default", bezel: null, superSample: 1 },
  { label: "settings panel   420x620  ", id: "c", elemW: 420, elemH: 620, radius: 18, overflow: ovf(40, 3), preset: "default", bezel: null, superSample: 1 },
  { label: "wide panel       900x700  ", id: "c", elemW: 900, elemH: 700, radius: 18, overflow: ovf(40, 5), preset: "default", bezel: null, superSample: 1 },
  { label: "square-ish       260x260  ", id: "c", elemW: 260, elemH: 260, radius: 24, overflow: ovf(40, 5), preset: "default", bezel: null, superSample: 1 },
  { label: "tiny pill         48x20   ", id: "c", elemW: 48, elemH: 20, radius: 10, overflow: ovf(40, 1.2), preset: "default", bezel: null, superSample: 1 },
  // Edge cases: radius 0, radius = half (circle), thin sliver, bezel > halfShorter
  { label: "sharp corners    200x120 r0", id: "c", elemW: 200, elemH: 120, radius: 0, overflow: ovf(40, 5), preset: "default", bezel: null, superSample: 1 },
  { label: "circle           140x140  ", id: "c", elemW: 140, elemH: 140, radius: 70, overflow: ovf(40, 5), preset: "default", bezel: null, superSample: 1 },
  { label: "sliver           600x8    ", id: "c", elemW: 600, elemH: 8, radius: 4, overflow: ovf(40, 1.2), preset: "default", bezel: null, superSample: 1 },
  { label: "big+divisor10   1000x400  ", id: "c", elemW: 1000, elemH: 400, radius: 20, overflow: ovf(40, 5), preset: "default", bezel: null, superSample: 1 },
  { label: "odd frac      333.5x77.5  ", id: "c", elemW: 333.5, elemH: 77.5, radius: 15.5, overflow: ovf(40, 1.2), preset: "default", bezel: null, superSample: 1 },
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
