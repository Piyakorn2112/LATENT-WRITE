/**
 * test-lens-legacy-math.ts — the lens really is on the OLD math.
 *
 * The scene-break / re-paragraph bubble lens is pinned to the pre-fold-free
 * profile while every other surface takes the new one. "Pinned" is a claim, and
 * the repo already owns the instrument that can settle it: `liquid-glass-
 * baseline.ts` is a frozen copy of the original algorithm, kept precisely so a
 * change can be proved byte-identical.
 *
 * So the gate is exact rather than approximate:
 *
 *   live(legacyProfile: true)  ===  frozen baseline      byte for byte
 *   live(legacyProfile: false) !==  frozen baseline      (or the fix is a no-op)
 *
 * The second half matters as much as the first. Without it this passes just as
 * happily on an engine where the flag does nothing at all.
 *
 *   ./node_modules/.bin/tsx scripts/test-lens-legacy-math.ts
 */

import { buildMapPixels as baseline, type MapRequest } from "./liquid-glass-baseline.ts";

(globalThis as unknown as { self: unknown }).self = { onmessage: null };
const live = (await import("../src/lib/liquid-glass-worker.ts")) as {
  buildMapPixels: (req: MapRequest & { legacyProfile?: boolean }) => { data: Uint8ClampedArray };
};

const ovf = (disp: number, blur: number) => disp + blur * 2 + 4;

// The lens as liquid-glass-filter.ts asks for it: LENS_REFRACTION 20,
// LENS_REFRACTION_RADIUS 20, LENS_BLUR 0.2, LENS_SUPERSAMPLE 4 — plus a couple
// of other shapes, because a one-shape gate proves one shape.
interface Case extends MapRequest { label: string }
const CASES: Case[] = [
  { label: "lens 220x220 r110", id: "t", elemW: 220, elemH: 220, radius: 110,
    overflow: ovf(20, 0.2), preset: "default", bezel: 20, superSample: 4, mapPad: null },
  { label: "lens 320x320 r160", id: "t", elemW: 320, elemH: 320, radius: 160,
    overflow: ovf(20, 0.2), preset: "default", bezel: 20, superSample: 4, mapPad: null },
  { label: "lens 180x140 r70", id: "t", elemW: 180, elemH: 140, radius: 70,
    overflow: ovf(20, 0.2), preset: "default", bezel: 20, superSample: 4, mapPad: null },
  { label: "toolbar 920x46 r23", id: "t", elemW: 920, elemH: 46, radius: 23,
    overflow: ovf(40, 0.9), preset: "default", bezel: null, superSample: 1, mapPad: null },
] as Case[];

function diff(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  if (a.length !== b.length) return { bytes: -1, max: 0 };
  let bytes = 0, max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d) { bytes++; if (d > max) max = d; }
  }
  return { bytes, max };
}

console.log("THE LENS IS PINNED TO THE OLD MATH — proved against the frozen baseline.\n");
console.log("case                    legacy vs baseline      new vs baseline");
let failed = 0;
for (const c of CASES) {
  const { label, ...req } = c;
  const ref = baseline(req).data;
  const old = live.buildMapPixels({ ...req, legacyProfile: true }).data;
  const neu = live.buildMapPixels({ ...req, legacyProfile: false }).data;
  const dOld = diff(ref, old);
  const dNew = diff(ref, neu);

  const legacyOk = dOld.bytes === 0;
  // The fix must actually DO something, or "legacy matches" is vacuous.
  const fixFires = dNew.bytes > 0;
  if (!legacyOk || !fixFires) failed++;
  console.log(
    `${label.padEnd(22)}  ${(legacyOk ? "✓ identical" : `✗ ${dOld.bytes} bytes (max ${dOld.max})`).padEnd(22)}` +
    `  ${fixFires ? `✓ differs, ${dNew.bytes} bytes (max ${dNew.max})` : "✗ IDENTICAL — the fix does nothing here"}`);
}

console.log(failed
  ? `\nFAILED ${failed}/${CASES.length}`
  : `\nPASS — legacyProfile reproduces the frozen original exactly, and the new`
    + `\n       profile genuinely differs from it on every shape tested.`);
process.exit(failed ? 1 : 0);
