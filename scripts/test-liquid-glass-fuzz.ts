/**
 * Randomised byte-exactness fuzz for the liquid-glass map.
 *
 * The fixed case list in lg-verify.ts covers the shapes the app uses; this
 * hunts for the shapes it doesn't — extreme aspect ratios, radius exactly at
 * the pill/circle boundary, bezel larger than the element, fractional sizes —
 * because the row-narrowing and the axis-table branches are the kind of
 * optimisation that fails only on a geometry nobody thought to try.
 */

import { buildMapPixels as baseline, type MapRequest, type MapPreset } from "./liquid-glass-baseline.ts";
(globalThis as any).self = { onmessage: null };
const live = (await import(
  "../src/lib/liquid-glass-worker.ts"
)) as { buildMapPixels: (req: MapRequest) => { data: Uint8ClampedArray; mw: number; mh: number } };

// mulberry32 — deterministic, so a failure is reproducible.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRESETS: MapPreset[] = ["default", "control-knob", "toggle-control-knob"];
const N = Number(process.argv[2] ?? 400);

let fails = 0;
let checked = 0;
let maxPx = 0;

for (let i = 0; i < N; i++) {
  const rand = rng(i * 2654435761);
  const preset = PRESETS[Math.floor(rand() * 3)];
  const knob = preset !== "default";

  // Knob presets oversample 16x, so keep those elements small or the map
  // explodes; default preset roams the full size range the app can produce.
  const w = knob
    ? 6 + Math.floor(rand() * 40)
    : 4 + Math.floor(rand() * 700) + (rand() < 0.25 ? rand() : 0);
  const h = knob
    ? 6 + Math.floor(rand() * 30)
    : 4 + Math.floor(rand() * 700) + (rand() < 0.25 ? rand() : 0);

  const half = Math.min(w, h) / 2;
  // Bias radius hard toward the interesting boundaries: 0, 1 (RADIUS_FLOOR),
  // exactly half (pill/circle), just under and just over half.
  const rPick = rand();
  const radius =
    rPick < 0.15 ? 0 :
    rPick < 0.25 ? 1 :
    rPick < 0.45 ? half :
    rPick < 0.55 ? half - 0.01 :
    rPick < 0.65 ? half + 0.01 :
    rPick < 0.75 ? 999 :
    rand() * half * 1.2;

  const blur = [0, 0.2, 1.2, 2, 3, 5][Math.floor(rand() * 6)];
  const disp = rand() < 0.3 ? 20 : 40;
  const overflow = disp + blur * 2 + 4;
  // Bezel: null (BEZEL_PX=120, usually >> element), or small, or huge.
  const bPick = rand();
  const bezel = bPick < 0.4 ? null : bPick < 0.7 ? 5 + rand() * 40 : rand() * 400;
  const superSample = knob ? 1 : rand() < 0.15 ? 1 + Math.floor(rand() * 4) : 1;

  const req: MapRequest = {
    id: "f", elemW: w, elemH: h, radius, overflow, preset, bezel, superSample,
  };

  // Guard against accidentally generating a multi-hundred-megapixel map.
  const est = ((w * (knob ? 16 : superSample)) + 2 * overflow * (knob ? 16 : superSample))
            * ((h * (knob ? 16 : superSample)) + 2 * overflow * (knob ? 16 : superSample));
  if (est > 12e6) continue;

  const a = baseline(req);
  const b = live.buildMapPixels(req);
  checked++;
  maxPx = Math.max(maxPx, a.mw * a.mh);

  if (a.mw !== b.mw || a.mh !== b.mh) {
    console.log(`✗ seed ${i}: DIM ${a.mw}x${a.mh} vs ${b.mw}x${b.mh}  ${JSON.stringify(req)}`);
    fails++;
    continue;
  }
  let bad = 0;
  let firstIdx = -1;
  let maxD = 0;
  for (let k = 0; k < a.data.length; k++) {
    const d = Math.abs(a.data[k] - b.data[k]);
    if (d) {
      bad++;
      maxD = Math.max(maxD, d);
      if (firstIdx < 0) firstIdx = k;
    }
  }
  if (bad) {
    const p = firstIdx >> 2;
    console.log(
      `✗ seed ${i}: ${bad} bytes (max ${maxD}) first px (${p % a.mw},${(p / a.mw) | 0}) ch ${firstIdx & 3}\n` +
      `   ${JSON.stringify(req)}`,
    );
    fails++;
  }
}

console.log(
  `\n${checked} random shapes checked (largest map ${(maxPx / 1e6).toFixed(1)}Mpx) — ` +
  (fails === 0 ? "ALL BYTE-IDENTICAL ✓" : `${fails} FAILED ✗`),
);
process.exit(fails ? 1 : 0);
