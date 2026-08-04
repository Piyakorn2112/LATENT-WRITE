/**
 * probe-glass-field-symmetry.ts — READ-ONLY DIAGNOSIS, no rendering.
 *
 * The long-standing complaint about the SVG glass is that the refracted content
 * "leans left at the top and right at the bottom". That is a HORIZONTAL
 * displacement that changes sign with vertical position — a shear/rotation in
 * the displacement field, on edges where the surface normal is purely vertical
 * and dx must therefore be zero.
 *
 * There are only two places it can come from:
 *
 *   OURS      — the displacement map we generate already contains it, in which
 *               case Chromium is faithfully rendering a field we got wrong;
 *   CHROMIUM  — the map is clean and the lean appears only after
 *               feDisplacementMap gathers through it.
 *
 * This decides between them WITHOUT rendering anything: it builds the map the
 * app actually ships for the real toolbar geometry, decodes the packed bytes
 * back into element pixels, and measures the field's own symmetry.
 *
 * A correct field for a shape symmetric about both axes must satisfy:
 *   dx(x, y) = -dx(-x, y)   and   dx(x, y) =  dx(x, -y)
 *   dy(x, y) =  dy(-x, y)   and   dy(x, y) = -dy(x, -y)
 * A lean is precisely a violation of `dx(x, y) = dx(x, -y)` — dx picking up an
 * ODD component in y.
 *
 *   ./node_modules/.bin/tsx scripts/probe-glass-field-symmetry.ts
 */

// The worker module assigns self.onmessage at import time (same shim
// test-liquid-glass-exact.ts uses).
(globalThis as unknown as { self: unknown }).self = { onmessage: null };
const { buildMapPixels } = await import("../src/lib/liquid-glass-worker.ts");
type MapRequest = Parameters<typeof buildMapPixels>[0];

/**
 * feDisplacementMap's own arithmetic is `DISP_PX * (byte/255 - 0.5)`, but 128
 * is not 127.5, so a "zero" texel decodes to +0.0784px. That is a UNIFORM
 * offset in +x/+y, identical everywhere, and it swamps a symmetry test: any
 * mirrored pair sums to 2 x 0.0784 no matter how symmetric the field is.
 * Decoding relative to the neutral byte removes it and leaves only the thing
 * a symmetry test is for — whether +v and -v were quantised the same way.
 */
const DISP_PX = 40;
const decode = (byte: number) => (DISP_PX * (byte - 128)) / 255;

interface Case { label: string; req: MapRequest }

const CASES: Case[] = [
  {
    label: "toolbar 920x46 r23",
    req: { elemW: 920, elemH: 46, radius: 23, overflow: 40, preset: "default",
      bezel: null, mapPad: null, dispPx: DISP_PX } as MapRequest,
  },
  {
    label: "panel 370x620 r24",
    req: { elemW: 370, elemH: 620, radius: 24, overflow: 40, preset: "default",
      bezel: null, mapPad: null, dispPx: DISP_PX } as MapRequest,
  },
  {
    label: "square 300x300 r24",
    req: { elemW: 300, elemH: 300, radius: 24, overflow: 40, preset: "default",
      bezel: null, mapPad: null, dispPx: DISP_PX } as MapRequest,
  },
];

function analyse(label: string, req: MapRequest) {
  const m = buildMapPixels(req);
  const { data, mw, mh } = m;
  const at = (mx: number, my: number) => {
    const i = (my * mw + mx) * 4;
    return { dx: decode(data[i]), dy: decode(data[i + 1]) };
  };

  // Map texel → element coordinate, centred on the element.
  const cx = (mw - 1) / 2;
  const cy = (mh - 1) / 2;

  let maxOddDxInY = 0;      // dx(x,y) vs dx(x,-y)  — THE LEAN
  let maxEvenDxInX = 0;     // dx(x,y) vs -dx(-x,y) — a translation in x
  let maxOddDyInX = 0;      // dy(x,y) vs dy(-x,y)  — a translation in y
  let maxEvenDyInY = 0;     // dy(x,y) vs -dy(x,-y)
  let peak = 0;
  let leanAtX = 0, leanAtY = 0;

  const step = Math.max(1, Math.floor(mw / 400));
  for (let my = 0; my < mh; my += 1) {
    const mirrorY = Math.round(2 * cy - my);
    if (mirrorY < 0 || mirrorY >= mh) continue;
    for (let mx = 0; mx < mw; mx += step) {
      const mirrorX = Math.round(2 * cx - mx);
      if (mirrorX < 0 || mirrorX >= mw) continue;
      const a = at(mx, my);
      const vy = at(mx, mirrorY);
      const vx = at(mirrorX, my);
      peak = Math.max(peak, Math.abs(a.dx), Math.abs(a.dy));

      // dx should be EVEN in y: dx(x,y) - dx(x,-y) = 0.
      const oddDx = Math.abs(a.dx - vy.dx);
      if (oddDx > maxOddDxInY) {
        maxOddDxInY = oddDx;
        leanAtX = Math.round(mx - cx);
        leanAtY = Math.round(my - cy);
      }
      // dx should be ODD in x: dx(x,y) + dx(-x,y) = 0.
      maxEvenDxInX = Math.max(maxEvenDxInX, Math.abs(a.dx + vx.dx));
      // dy should be EVEN in x, ODD in y.
      maxOddDyInX = Math.max(maxOddDyInX, Math.abs(a.dy - vx.dy));
      maxEvenDyInY = Math.max(maxEvenDyInY, Math.abs(a.dy + vy.dy));
    }
  }

  // The neutral byte, on its own. 128/255 is not 0.5, so a "zero" texel still
  // displaces — the same amount everywhere, in +x and +y.
  const neutral = decode(128);

  console.log(`\n── ${label}   map ${mw}x${mh}, peak |d| ${peak.toFixed(3)}px`);
  console.log(`   neutral byte 128 decodes to ${neutral.toFixed(4)}px (a uniform +x/+y bias, not a lean)`);
  console.log(`   ★ dx odd-in-y  (THE LEAN)        ${maxOddDxInY.toFixed(4)} px   worst at (${leanAtX}, ${leanAtY})`);
  console.log(`     dx even-in-x (x translation)   ${maxEvenDxInX.toFixed(4)} px`);
  console.log(`     dy odd-in-x  (y translation)   ${maxOddDyInX.toFixed(4)} px`);
  console.log(`     dy even-in-y                   ${maxEvenDyInY.toFixed(4)} px`);
  return { maxOddDxInY, peak };
}

console.log("MAP FIELD SYMMETRY — is the lean already in the map we generate?");
console.log("(one displacement byte = " + (DISP_PX / 255).toFixed(4) + " element px, so anything");
console.log(" at or below that is quantisation, not a field error)");

let worst = 0;
for (const c of CASES) worst = Math.max(worst, analyse(c.label, c.req).maxOddDxInY);

const lsb = DISP_PX / 255;
console.log(`\n━━ VERDICT ━━`);
console.log(`worst dx odd-in-y across all shapes: ${worst.toFixed(4)} px  (1 LSB = ${lsb.toFixed(4)} px)`);
if (worst <= lsb * 1.01) {
  console.log(`→ the MAP IS CLEAN to within one quantisation step. The field we hand`);
  console.log(`  Chromium has no lean in it, so a lean in the RENDER is produced`);
  console.log(`  downstream — by feDisplacementMap's gather, not by our math.`);
} else {
  console.log(`→ the MAP ITSELF carries the lean, ${(worst / lsb).toFixed(1)}x the quantisation step.`);
  console.log(`  Chromium is faithfully rendering a field we got wrong.`);
}
