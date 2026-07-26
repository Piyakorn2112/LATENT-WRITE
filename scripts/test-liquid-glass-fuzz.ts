/**
 * Randomised byte-exactness fuzz for the liquid-glass map.
 *
 * Two independent invariants, over the same random geometries:
 *
 *  1. MATH — the live per-pixel map equals a frozen copy of the original
 *     algorithm, byte for byte. The fixed case list in
 *     test-liquid-glass-exact.ts covers the shapes the app uses; this hunts the
 *     ones it doesn't (extreme aspect ratios, radius exactly at the pill/circle
 *     boundary, bezel larger than the element, fractional sizes), because the
 *     row narrowing and the axis-table branches fail only on a geometry nobody
 *     thought to try. That is how the AA-skirt gap in the row span was caught.
 *
 *  2. MARGIN SHRINK — when a smaller neutral margin is baked in (mapPad), the
 *     element's own pixels must be untouched, the collar must be exactly the
 *     neutral value the main thread floods with, and the reported padX/padY
 *     must reproduce the map's authored scale. Otherwise <feImage> samples the
 *     refraction at the wrong scale, which the map bytes alone would not catch.
 */

import { buildMapPixels as baseline, type MapRequest, type MapPreset } from "./liquid-glass-baseline.ts";
(globalThis as any).self = { onmessage: null };
interface Built {
  data: Uint8ClampedArray;
  mw: number;
  mh: number;
  outW: number;
  outH: number;
  padX: number;
  padY: number;
}
const live = (await import(
  "../src/lib/liquid-glass-worker.ts"
)) as { buildMapPixels: (req: MapRequest & { mapPad?: number | null }) => Built };

/** Blue channel of the neutral margin — must match MAP_NEUTRAL_MASK in liquid-glass-filter.ts. */
const NEUTRAL_MASK = 217;
/** Element px of collar the main thread asks for. */
const MAP_PAD = 4;

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
let shrunk = 0;

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
  // Both falloff models, weighted toward the one the app now ships everywhere.
  const profile = rand() < 0.3 ? "snell" as const : "foldfree" as const;

  const req: MapRequest = {
    id: "f", elemW: w, elemH: h, radius, overflow, preset, bezel, superSample, profile,
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
    continue;
  }

  // ── Invariant 2: the shrunk-margin map ──────────────────────────────────
  const padded = live.buildMapPixels({ ...req, mapPad: MAP_PAD });
  if (padded.padX >= overflow) {
    // Fell back to the full margin (the scale would not have been preserved).
    // Then it must be byte-identical to the unpadded build.
    if (padded.mw !== b.mw || padded.mh !== b.mh) {
      console.log(`✗ seed ${i}: fallback changed dims  ${JSON.stringify(req)}`);
      fails++;
    }
    continue;
  }
  shrunk++;

  // The authored scale must survive: texels per element px, both axes.
  const scaleX = padded.outW / (w + 2 * padded.padX);
  const scaleY = padded.outH / (h + 2 * padded.padY);
  const fullScaleX = b.outW / (w + 2 * overflow);
  const fullScaleY = b.outH / (h + 2 * overflow);
  if (scaleX !== fullScaleX || scaleY !== fullScaleY) {
    console.log(
      `✗ seed ${i}: SCALE moved ${fullScaleX}/${fullScaleY} -> ${scaleX}/${scaleY}\n` +
      `   ${JSON.stringify(req)}`,
    );
    fails++;
    continue;
  }

  // The element's pixels must be identical, and the collar must be exactly the
  // neutral value the main thread floods the rest of the region with.
  const scale = padded.mw / (w + 2 * padded.padX); // render-resolution scale
  const elemW = Math.round(padded.mw - 2 * padded.padX * scale);
  const elemH = Math.round(padded.mh - 2 * padded.padY * scale);
  const padTexX = Math.round(padded.padX * scale);
  const padTexY = Math.round(padded.padY * scale);
  const fullPadTexX = Math.round((b.mw - elemW) / 2);
  const fullPadTexY = Math.round((b.mh - elemH) / 2);

  let elemBad = 0;
  let collarBad = 0;
  for (let y = 0; y < elemH; y++) {
    for (let x = 0; x < elemW; x++) {
      const pi = ((y + padTexY) * padded.mw + (x + padTexX)) * 4;
      const fi = ((y + fullPadTexY) * b.mw + (x + fullPadTexX)) * 4;
      for (let c = 0; c < 4; c++) if (padded.data[pi + c] !== b.data[fi + c]) elemBad++;
    }
  }
  // Sample the collar: the outermost ring of the shrunk map.
  for (let x = 0; x < padded.mw; x++) {
    for (const y of [0, padded.mh - 1]) {
      const p = (y * padded.mw + x) * 4;
      if (padded.data[p] !== 128 || padded.data[p + 1] !== 128 ||
          padded.data[p + 2] !== NEUTRAL_MASK || padded.data[p + 3] !== 255) collarBad++;
    }
  }
  if (elemBad || collarBad) {
    console.log(
      `✗ seed ${i}: pad path — ${elemBad} element bytes differ, ${collarBad} collar px not neutral\n` +
      `   ${JSON.stringify(req)}`,
    );
    fails++;
  }
}

console.log(
  `\n${checked} random shapes checked (largest map ${(maxPx / 1e6).toFixed(1)}Mpx, ` +
  `${shrunk} took the shrunk-margin path) — ` +
  (fails === 0 ? "ALL BYTE-IDENTICAL ✓" : `${fails} FAILED ✗`),
);
process.exit(fails ? 1 : 0);
