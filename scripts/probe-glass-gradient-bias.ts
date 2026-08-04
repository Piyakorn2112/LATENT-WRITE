/**
 * probe-glass-gradient-bias.ts — READ-ONLY. Is the lean the QUANTISATION, or
 * the gradient estimator?
 *
 * probe-glass-field-symmetry.ts shows the shipped map's dx picking up an
 * odd-in-y component — 1 quantisation step on a stadium, 42 steps on a large
 * rectangle with a small corner radius. A byte can only explain the first.
 *
 * This reruns the worker's own geometry in FLOAT, with no packing anywhere, and
 * compares the two ways of estimating the surface normal:
 *
 *   FORWARD  — what ships. `QXE[px] = |px_rel + EPS| - insetX`, i.e. the probe
 *              steps +EPS in p on BOTH sides of the shape, so the derivative is
 *              evaluated at p + EPS/2 in every quadrant.
 *   CENTRAL  — the same field probed symmetrically about p.
 *
 * If FORWARD is asymmetric and CENTRAL is not, the lean is the estimator and
 * has nothing to do with 8 bits.
 *
 *   ./node_modules/.bin/tsx scripts/probe-glass-gradient-bias.ts
 */

const GRAD_K = 40;
const EPS = 0.5;

const hypot2 = (a: number, b: number) => Math.hypot(a, b);

/** The worker's smooth-max SDF, verbatim. */
function sdSmoothQ(qx: number, qy: number, r: number): number {
  const outside = hypot2(qx > 0 ? qx : 0, qy > 0 ? qy : 0);
  const d = Math.max(GRAD_K - Math.abs(qx - qy), 0) / GRAD_K;
  const inside = Math.min(Math.max(qx, qy) + d * d * GRAD_K * 0.25, 0);
  return outside + inside - r;
}

interface Shape { label: string; w: number; h: number; r: number }
const SHAPES: Shape[] = [
  { label: "toolbar  920x46  r23 (stadium)", w: 920, h: 46, r: 23 },
  { label: "panel    370x620 r24 (big rect, small corner)", w: 370, h: 620, r: 24 },
  { label: "square   300x300 r24 (big rect, small corner)", w: 300, h: 300, r: 24 },
  { label: "circle   220x220 r110", w: 220, h: 220, r: 110 },
];

type Grad = (px: number, py: number, insetX: number, insetY: number, r: number)
  => { gx: number; gy: number };

/** As shipped: one-sided probe, +EPS in p, in every quadrant. */
const forward: Grad = (px, py, insetX, insetY, r) => {
  const qx = Math.abs(px) - insetX;
  const qy = Math.abs(py) - insetY;
  const qxe = Math.abs(px + EPS) - insetX;
  const qye = Math.abs(py + EPS) - insetY;
  const d0 = sdSmoothQ(qx, qy, r);
  const rawGx = sdSmoothQ(qxe, qy, r) - d0;
  const rawGy = sdSmoothQ(qx, qye, r) - d0;
  const len = hypot2(rawGx, rawGy);
  return len < 1e-9 ? { gx: 0, gy: 0 } : { gx: rawGx / len, gy: rawGy / len };
};

/** Symmetric about p — same field, same step size, no evaluation-point shift. */
const central: Grad = (px, py, insetX, insetY, r) => {
  const q = (a: number, inset: number) => Math.abs(a) - inset;
  const rawGx = sdSmoothQ(q(px + EPS / 2, insetX), q(py, insetY), r)
    - sdSmoothQ(q(px - EPS / 2, insetX), q(py, insetY), r);
  const rawGy = sdSmoothQ(q(px, insetX), q(py + EPS / 2, insetY), r)
    - sdSmoothQ(q(px, insetX), q(py - EPS / 2, insetY), r);
  const len = hypot2(rawGx, rawGy);
  return len < 1e-9 ? { gx: 0, gy: 0 } : { gx: rawGx / len, gy: rawGy / len };
};

/** Largest |gx(x,y) - gx(x,-y)| over the bezel band — the lean, in normal units. */
function leanOf(s: Shape, grad: Grad): { lean: number; at: [number, number] } {
  const halfW = s.w / 2, halfH = s.h / 2;
  const r = Math.min(s.r, Math.min(halfW, halfH));
  const insetX = halfW - r, insetY = halfH - r;
  const bezel = Math.min(120, Math.min(halfW, halfH) * 0.8);

  let lean = 0;
  let at: [number, number] = [0, 0];
  for (let py = -halfH + 0.5; py < halfH; py += 1) {
    for (let px = -halfW + 0.5; px < halfW; px += 1) {
      // Only inside the bezel: outside it the displacement is zero anyway.
      const qx = Math.abs(px) - insetX;
      const qy = Math.abs(py) - insetY;
      const dist = -(hypot2(qx > 0 ? qx : 0, qy > 0 ? qy : 0)
        + Math.min(Math.max(qx, qy), 0) - r);
      if (dist < 0 || dist > bezel) continue;
      const a = grad(px, py, insetX, insetY, r);
      const b = grad(px, -py, insetX, insetY, r);
      const d = Math.abs(a.gx - b.gx);
      if (d > lean) { lean = d; at = [Math.round(px), Math.round(py)]; }
    }
  }
  return { lean, at };
}

console.log("GRADIENT ESTIMATOR BIAS — float only, no packing, no 8-bit anywhere.");
console.log("Reported: max |gx(x, y) - gx(x, -y)| inside the bezel.");
console.log("A correct field is EVEN in y here, so a correct estimator reads 0.\n");
console.log("shape                                          FORWARD (shipped)   CENTRAL");
for (const s of SHAPES) {
  const f = leanOf(s, forward);
  const c = leanOf(s, central);
  console.log(
    `${s.label.padEnd(46)} ${f.lean.toFixed(4).padStart(8)} @${String(f.at).padEnd(11)} ` +
    `${c.lean.toFixed(4).padStart(8)}`);
}
console.log("\n(gx is a unit-vector component, so 0.02 is ~1.1 degrees of normal rotation;");
console.log(" multiplied by a 20px peak pull that is ~0.4px of horizontal displacement");
console.log(" where there should be none, with OPPOSITE signs top and bottom.)");
