/**
 * probe-glass-fold.ts — READ-ONLY. Does the shipped map sample BACKWARDS?
 *
 * feDisplacementMap GATHERS: out(P) = backdrop(P + disp(P)). The backdrop is
 * bent only while the sampling position keeps advancing —
 *
 *     d/dy [ y + disp(y) ] > 0
 *
 * Where that derivative goes negative the gather re-reads backdrop it has
 * already read, mirrored and compressed. In FLOAT that is a smooth reflection
 * and it is what makes a rim read as thick glass; in an 8-BIT map it is a comb,
 * and over text it doubles the letterforms.
 *
 * knob-glass.ts fixed this for the control knobs — a bounded-derivative falloff
 * (max|g'| = 1.5) plus an amplitude clamp to `bezel / max|g'|` — and records
 * the measurement it was built from: "1228 of 6580 interior texels sample
 * BACKWARDS — 19% of the knob". The GENERAL worker never got that fix; it still
 * runs the raw squircle→Snell profile, whose slope is clamped at 5 and collapses
 * within ~10% of the bezel.
 *
 * This measures the same thing on the shapes the app actually ships.
 *
 *   ./node_modules/.bin/tsx scripts/probe-glass-fold.ts
 */

(globalThis as unknown as { self: unknown }).self = { onmessage: null };
const { buildMapPixels } = await import("../src/lib/liquid-glass-worker.ts");
type MapRequest = Parameters<typeof buildMapPixels>[0];

const DISP_PX = 40;
let ACTIVE_DISP = DISP_PX;
const decode = (byte: number) => ACTIVE_DISP * (byte / 255 - 0.5);

interface Case { label: string; w: number; h: number; r: number;
  bezel?: number; dispPx?: number; legacy?: boolean }
const CASES: Case[] = [
  // The scene-break / re-paragraph bubble, as liquid-glass-filter asks for it:
  // LENS_REFRACTION 20, LENS_REFRACTION_RADIUS 20.
  { label: "LENS 220x220 r110 OLD", w: 220, h: 220, r: 110, bezel: 20, dispPx: 20, legacy: true },
  { label: "LENS 220x220 r110 NEW", w: 220, h: 220, r: 110, bezel: 20, dispPx: 20, legacy: false },
  { label: "toolbar   920x46  r23", w: 920, h: 46, r: 23 },
  { label: "tab        26x34  r13", w: 26, h: 34, r: 13 },
  { label: "pill      180x34  r17", w: 180, h: 34, r: 17 },
  { label: "popover   420x120 r14", w: 420, h: 120, r: 14 },
  { label: "panel     370x620 r24", w: 370, h: 620, r: 24 },
];

console.log("SAMPLING DIRECTION — where does the gather run BACKWARDS?");
console.log("out(y) = backdrop(y + dy(y)); the backdrop is bent only while");
console.log("d/dy [y + dy] > 0. Below zero it mirrors what it already read.\n");
console.log("shape                    map        interior   BACKWARDS   worst d/dy   peak |dy|");

for (const c of CASES) {
  const req = {
    elemW: c.w, elemH: c.h, radius: c.r, overflow: 40, preset: "default",
    bezel: c.bezel ?? null, mapPad: null, dispPx: c.dispPx ?? DISP_PX,
    legacyProfile: c.legacy === true,
  } as MapRequest;
  ACTIVE_DISP = c.dispPx ?? DISP_PX;
  const m = buildMapPixels(req);
  const { data, mw, mh } = m;

  // Walk each column down the map, in ELEMENT pixels, and difference
  // (y + dy) between adjacent rows. Texels per element px:
  const texPerPxY = mh / (c.h + 80);

  let interior = 0, backwards = 0, worst = 0, peak = 0;
  for (let mx = 0; mx < mw; mx++) {
    for (let my = 1; my < mh; my++) {
      const a = decode(data[((my - 1) * mw + mx) * 4 + 1]);
      const b = decode(data[(my * mw + mx) * 4 + 1]);
      // Skip the neutral margin: both exactly the prefill means "not the shape".
      if (a === decode(128) && b === decode(128)) continue;
      interior++;
      peak = Math.max(peak, Math.abs(a), Math.abs(b));
      // Advance of the sampling position across one texel row.
      const dy = 1 / texPerPxY;                 // element px per texel row
      const advance = dy + (b - a);
      if (advance <= 0) backwards++;
      worst = Math.min(worst, advance / dy);    // as a fraction of normal
    }
  }
  const pct = interior ? (100 * backwards) / interior : 0;
  console.log(
    `${c.label.padEnd(24)} ${(mw + "x" + mh).padEnd(10)} ${String(interior).padStart(8)} ` +
    `${(backwards + " (" + pct.toFixed(1) + "%)").padStart(13)} ${worst.toFixed(2).padStart(11)}x ` +
    `${peak.toFixed(2).padStart(10)}px`);
}

console.log("\nA negative 'worst d/dy' means the sampling reverses: the gather walks");
console.log("back up the backdrop and re-reads it mirrored. Over text that doubles");
console.log("the letterforms; over a grating it does nothing at all, which is why");
console.log("the vertical-grating harness reported a clean toolbar.");
