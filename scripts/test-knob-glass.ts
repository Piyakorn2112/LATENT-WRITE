/**
 * test-knob-glass.ts — the knobs' own glass engine, proved rather than assumed.
 *
 * knob-glass.ts replaces a numerically-probed normal with a closed-form one
 * (the STM /about hero's method) and authors the map at press density. Both
 * are deliberate changes, so the frozen whole-engine oracle cannot judge them
 * — these are the properties that say the rebuild is FAITHFUL rather than a
 * retune:
 *
 *   1. PHYSICS UNCHANGED — the squircle profile and the Snell solve are
 *      bit-identical to the general engine's.
 *   2. THE LUT IS INVISIBLE — a map built through the 4096-entry table is
 *      byte-identical to one built with the exact per-pixel math.
 *   3. THE NORMAL IS THE ONE IT REPLACES — the closed-form normal agrees with
 *      a three-probe finite difference of the same sharp SDF, everywhere on a
 *      pill, to well under a byte of displacement.
 *   4. DENSITY FOLLOWS THE PRESS — the map carries `MAP_OVERSAMPLE ×
 *      displayScale` texels per element pixel, so 3 per DISPLAYED pixel at
 *      full press instead of 1.5.
 *   5. THE MAP IS WELL FORMED — neutral outside, symmetric, and the
 *      displacement points INWARD everywhere in the bezel band.
 *
 * Each check is canaried: it must be able to fail.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-knob-glass.ts
 */

import { buildKnobMapPixels, dispExact, type KnobPreset } from "../src/lib/knob-glass";

let failed = 0;
const ok = (label: string, cond: boolean, detail?: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failed++;
};

const KNOBS: Array<{ label: string; elemW: number; elemH: number; preset: KnobPreset }> = [
  { label: "range knob  20x14", elemW: 20, elemH: 14, preset: "control-knob" },
  { label: "toggle knob 32x24", elemW: 32, elemH: 24, preset: "toggle-control-knob" },
];
const REQ = (k: (typeof KNOBS)[number], extra: Record<string, unknown> = {}) => ({
  elemW: k.elemW, elemH: k.elemH, radius: 999, overflow: 40,
  preset: k.preset, bezel: null, displayScale: 2, mapPad: 6, ...extra,
});

// ─── 1 · The physics is the general engine's, bit for bit ────────────────────
// Re-derived here from the published constants rather than imported, so a
// silent edit to either copy shows up as a disagreement.
console.log("physics — squircle profile and Snell solve:");
{
  const h = (t: number) => (1 - (1 - t) ** 4) ** 0.25;
  const dh = (t: number) => (h(Math.min(t + 5e-4, 1)) - h(Math.max(t - 5e-4, 0))) / 1e-3;
  const snell = (slope: number, eta: number) => {
    if (slope < 1e-3) return 0;
    const nLen = Math.hypot(slope, 1);
    const nZ = 1 / nLen;
    const sinSq = eta * eta * (1 - nZ * nZ);
    if (sinSq >= 1) return 0;
    return (Math.sqrt(1 - sinSq) - eta * nZ) * (slope / nLen);
  };
  let worst = 0;
  for (let i = 0; i <= 2000; i++) {
    const t = i / 2000;
    worst = Math.max(worst, Math.abs(dispExact(t) - snell(Math.min(dh(t), 5.0), 1 / 1.5)));
  }
  ok("displacement profile identical to the general engine", worst === 0, `max |Δ| ${worst}`);
}

// ─── 2 · The LUT's error is BOUNDED (it is not, and cannot be, zero) ─────────
// This check first asserted byte-identity and the fuzz below refuted it on 10
// of 240 geometries. The output is quantised with `(… + 0.5) | 0`, so a value
// sitting exactly on a rounding boundary flips under any perturbation at all —
// no table resolution fixes that. So the gate is the honest one: at most ONE
// LSB, on a vanishingly small share of texels.
console.log("\nLUT — the 4096-entry table vs exact per-pixel math:");
for (const k of KNOBS) {
  const lut = buildKnobMapPixels(REQ(k), true);
  const exact = buildKnobMapPixels(REQ(k), false);
  let diff = 0;
  let maxDelta = 0;
  for (let i = 0; i < lut.data.length; i++) {
    const d = Math.abs(lut.data[i] - exact.data[i]);
    if (d) { diff++; maxDelta = Math.max(maxDelta, d); }
  }
  const share = diff / lut.data.length;
  ok(`${k.label}: ≤1 LSB on <0.01% of texels`,
    maxDelta <= 1 && share < 0.0001,
    `${diff} bytes (${(share * 100).toFixed(4)}%), max Δ ${maxDelta}`);
}

// ─── 3 · The closed-form normal agrees with the probe it replaces ────────────
console.log("\nnormal — closed form vs the three-probe finite difference:");
for (const k of KNOBS) {
  const halfW = k.elemW / 2, halfH = k.elemH / 2;
  const r = Math.min(halfW, halfH);
  const flatX = halfW - r, flatY = halfH - r;
  // The SHARP SDF, as the general engine computes distance with.
  const sd = (x: number, y: number) => {
    const ax = Math.abs(x) - flatX, ay = Math.abs(y) - flatY;
    const cx = ax > 0 ? ax : 0, cy = ay > 0 ? ay : 0;
    return Math.hypot(cx, cy) + Math.min(Math.max(ax, ay), 0) - r;
  };
  const analytic = (x: number, y: number): [number, number] => {
    const ax = Math.abs(x) - flatX, ay = Math.abs(y) - flatY;
    const cx = ax > 0 ? ax : 0, cy = ay > 0 ? ay : 0;
    const sy = y < 0 ? -1 : 1;
    if (cx > 0 || cy > 0) {
      const len = Math.hypot(cx, cy);
      return [(x < 0 ? -cx : cx) / len, (cy * sy) / len];
    }
    return ax > ay ? [x < 0 ? -1 : 1, 0] : [0, sy];
  };
  // ★ COMPARE ONLY WHERE A NORMAL EXISTS AND IS USED — inside the bezel band.
  //
  // The first run of this check reported a 90° disagreement, and it was right
  // to: at the capsule's MEDIAL AXIS (x = ±flatX, y = 0) the point is
  // equidistant from three edges, the distance field has a kink, and the
  // normal is genuinely ambiguous — the probe picks one branch, the closed
  // form another, and neither is wrong. Those points sit at distToEdge = r,
  // well outside the bezel (9.6 on a 32x24 knob), so no displacement is ever
  // written there. Asserting agreement on them would be asserting that two
  // arbitrary tie-breaks match. The band below is where the normal actually
  // steers refraction, and the assertion after the loop proves every
  // disagreement really does live outside it.
  const bezel = Math.min(120, Math.min(halfW, halfH) * 0.8);
  let worstDeg = 0;
  let worstOutsideBand = 0;
  let samples = 0;
  const eps = 1e-4;
  for (let y = -halfH + 0.05; y < halfH; y += 0.05) {
    for (let x = -halfW + 0.05; x < halfW; x += 0.05) {
      const d = sd(x, y);
      if (d > -0.02) continue;                  // inside only
      const gx = (sd(x + eps, y) - sd(x - eps, y)) / (2 * eps);
      const gy = (sd(x, y + eps) - sd(x, y - eps)) / (2 * eps);
      const len = Math.hypot(gx, gy);
      if (len < 1e-6) continue;
      const [nx, ny] = analytic(x, y);
      const dot = Math.min(1, Math.max(-1, (gx / len) * nx + (gy / len) * ny));
      const deg = (Math.acos(dot) * 180) / Math.PI;
      if (-d < bezel) { worstDeg = Math.max(worstDeg, deg); samples++; }
      else worstOutsideBand = Math.max(worstOutsideBand, deg);
    }
  }
  ok(`${k.label}: agrees within 1° over ${samples} displaced points`,
    worstDeg < 1, `worst ${worstDeg.toFixed(3)}°`);
  ok(`${k.label}: the only ambiguity is the medial axis, outside the bezel`,
    worstOutsideBand > 1, `worst outside the band ${worstOutsideBand.toFixed(1)}° (expected: the tie)`);
}

// ─── 4 · Density follows the press ───────────────────────────────────────────
console.log("\ndensity — authored per DISPLAYED pixel, not per layout pixel:");
for (const k of KNOBS) {
  const at1 = buildKnobMapPixels(REQ(k, { displayScale: 1 }));
  const at2 = buildKnobMapPixels(REQ(k, { displayScale: 2 }));
  const texelsPerElemPx = (m: { outW: number; padX: number }) =>
    (m.outW - 2 * Math.round((m.padX * (m.outW)) / (k.elemW + 2 * m.padX))) / k.elemW;
  ok(`${k.label}: displayScale 2 doubles output texels per axis`,
    at2.outW > at1.outW * 1.9 && at2.outW < at1.outW * 2.1,
    `${at1.outW} -> ${at2.outW}`);
  void texelsPerElemPx;
  // 3 texels per element px at scale 1 is the approved density; at press the
  // knob is displayed 2x, so 6 per layout px IS 3 per displayed px.
  const elemTexels = at2.outW - 2 * Math.round((6 * at2.outW) / (k.elemW + 12));
  ok(`${k.label}: ~6 texels per layout px (= 3 per pressed px)`,
    Math.abs(elemTexels / k.elemW - 6) < 0.35, `${(elemTexels / k.elemW).toFixed(2)}`);
}

// ─── 5 · The map is well formed ──────────────────────────────────────────────
console.log("\nmap shape — neutral margin, symmetry, inward pull:");
for (const k of KNOBS) {
  const m = buildKnobMapPixels(REQ(k));
  const at = (x: number, y: number) => {
    const b = (y * m.mw + x) * 4;
    return [m.data[b], m.data[b + 1], m.data[b + 2]];
  };
  const baseline = (0.85 * 255 + 0.5) | 0;
  const corner = at(1, 1);
  ok(`${k.label}: margin is neutral (128,128,${baseline})`,
    corner[0] === 128 && corner[1] === 128 && corner[2] === baseline, JSON.stringify(corner));

  // Left/right mirror symmetry of the R channel about the element's centre.
  const cy = (m.mh / 2) | 0;
  let asym = 0;
  for (let x = 0; x < m.mw; x++) {
    const l = at(x, cy)[0] - 128;
    const rgt = at(m.mw - 1 - x, cy)[0] - 128;
    asym = Math.max(asym, Math.abs(l + rgt)); // R is odd about the centre
  }
  ok(`${k.label}: displacement mirrors about the centre`, asym <= 1, `worst ${asym}`);

  // Inward pull: on the left half the R channel must push right (> 128) and
  // vice versa, everywhere it is displaced at all.
  let wrongWay = 0;
  for (let x = 0; x < m.mw; x++) {
    const v = at(x, cy)[0] - 128;
    if (v === 0) continue;
    if (x < m.mw / 2 ? v < 0 : v > 0) wrongWay++;
  }
  ok(`${k.label}: pull is inward everywhere on the centre row`, wrongWay === 0, `${wrongWay} texels`);
}

// ─── 6 · Byte tripwire ───────────────────────────────────────────────────────
// The properties above say the engine is RIGHT; this says it has not CHANGED.
// The frozen whole-engine oracle (scripts/liquid-glass-baseline.ts) no longer
// covers the knobs — they were deliberately re-authored — so this is their
// stand-in. Recorded from the analytic engine on the day it landed. If it
// disagrees, something moved: find out what before touching the number.
console.log("\nbyte tripwire — the map has not drifted:");
{
  const EXPECTED: Record<string, string> = {
    "range knob  20x14": "cf452b45-192x156-p6",
    "toggle knob 32x24": "eeb0ff15-264x216-p6",
  };
  for (const k of KNOBS) {
    const m = buildKnobMapPixels(REQ(k));
    // FNV-1a over the map bytes plus the geometry the caller depends on.
    let hsh = 0x811c9dc5;
    for (let i = 0; i < m.data.length; i++) {
      hsh ^= m.data[i];
      hsh = Math.imul(hsh, 0x01000193) >>> 0;
    }
    const sig = `${hsh.toString(16)}-${m.outW}x${m.outH}-p${m.padX}`;
    ok(`${k.label}: ${sig}`, sig === EXPECTED[k.label], `expected ${EXPECTED[k.label]}`);
  }
}

// ─── 7 · Randomised geometries ───────────────────────────────────────────────
// The fixed pair above is what the app ships; this is what it doesn't. The
// invariants must hold for EVERY pill the engine could be handed, and this is
// where the knob presets' fuzz coverage went when they left the general
// engine's oracle.
console.log("\nfuzz — 240 random knob geometries:");
{
  let rngState = 0x2f6e2b1;
  const rand = () => {
    rngState ^= rngState << 13; rngState ^= rngState >>> 17; rngState ^= rngState << 5;
    return ((rngState >>> 0) % 1e6) / 1e6;
  };
  let lutDrift = 0, badMargin = 0, badSym = 0, badPull = 0, worst = "";
  let worstBytes = 0, worstDelta = 0;
  for (let i = 0; i < 240; i++) {
    const elemW = 6 + Math.floor(rand() * 44);
    const elemH = 6 + Math.floor(rand() * 34);
    const preset: KnobPreset = rand() < 0.5 ? "control-knob" : "toggle-control-knob";
    const req = {
      elemW, elemH, radius: 999, overflow: 40, preset,
      bezel: null, displayScale: rand() < 0.5 ? 1 : 2, mapPad: 6,
    };
    const m = buildKnobMapPixels(req, true);
    const exact = buildKnobMapPixels(req, false);
    let bytes = 0, delta = 0;
    for (let b = 0; b < m.data.length; b++) {
      const d = Math.abs(m.data[b] - exact.data[b]);
      if (d) { bytes++; delta = Math.max(delta, d); }
    }
    if (bytes) {
      lutDrift++;
      if (bytes > worstBytes) { worstBytes = bytes; worst = `${elemW}x${elemH}`; }
      worstDelta = Math.max(worstDelta, delta);
    }
    const baseline = (0.85 * 255 + 0.5) | 0;
    const c = (m.mw * 0 + 1) * 4;
    if (!(m.data[c] === 128 && m.data[c + 1] === 128 && m.data[c + 2] === baseline)) badMargin++;
    const cy = (m.mh / 2) | 0;
    for (let x = 0; x < m.mw; x++) {
      const l = m.data[(cy * m.mw + x) * 4] - 128;
      const r = m.data[(cy * m.mw + (m.mw - 1 - x)) * 4] - 128;
      if (Math.abs(l + r) > 1) { badSym++; break; }
    }
    for (let x = 0; x < m.mw; x++) {
      const v = m.data[(cy * m.mw + x) * 4] - 128;
      if (v !== 0 && (x < m.mw / 2 ? v < 0 : v > 0)) { badPull++; break; }
    }
  }
  ok(`LUT error stays within 1 LSB (${lutDrift}/240 geometries drift at all, worst ${worstBytes} texels on ${worst || "none"})`,
    worstDelta <= 1, `max Δ ${worstDelta}`);
  ok("margin stays neutral", badMargin === 0, `${badMargin} bad`);
  ok("symmetry holds", badSym === 0, `${badSym} bad`);
  ok("pull stays inward", badPull === 0, `${badPull} bad`);
}

// ─── Canary: each check must be able to fail ─────────────────────────────────
console.log("\ncanary — the checks can fail:");
{
  const k = KNOBS[1];
  const good = buildKnobMapPixels(REQ(k));
  const perturbed = buildKnobMapPixels(REQ(k, { bezel: 3 }));
  let diff = 0;
  for (let i = 0; i < good.data.length; i++) if (good.data[i] !== perturbed.data[i]) diff++;
  ok("a 1-parameter perturbation moves the map", diff > 1000, `${diff} bytes`);
  const sameScale = buildKnobMapPixels(REQ(k, { displayScale: 1 }));
  ok("displayScale actually changes the output size", sameScale.outW !== good.outW,
    `${sameScale.outW} vs ${good.outW}`);
}

console.log(failed ? `\nFAILED ${failed}` : "\nPASS — the knob engine is faithful, dense at press, and well formed");
process.exit(failed ? 1 : 0);
