/* orbLens — the invisible refraction, as numbers both renderers share.

   The shader bends every shape as it approaches the rim. Anything else that
   draws the orb (the SVG exporter) has to apply the SAME bend or it draws a
   different picture — plain ellipses where the app shows refracted ones.
   So the constants live here in TS, the GLSL interpolates them into its own
   source, and the exporter calls the functions below. Neither can drift
   from the other, because there is only one set of numbers. */

export const LENS = {
  /** the nominal sphere the falloff is measured against */
  R: 0.95,
  /** the bend is tapered back to nothing between these radii, so it never
   *  keeps displacing where there is no glass left to see */
  TAPER_IN: 0.78,
  TAPER_OUT: 1.06,
  /** displacement at full falloff, at rest and the extra when working */
  BEND_BASE: 0.13,
  BEND_ENERGY: 0.05,
  /** per-channel split at the rim, and how much `aberration` adds */
  DISP_BASE: 0.006,
  DISP_AB: 0.008,
} as const;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/* ── The profile ─────────────────────────────────────────────────────────
   A literal sphere, 1 − √(1 − d²), tapered back to nothing past the
   shapes' reach. It is not curvature-continuous — the sphere term has a
   vertical tangent at d = 1 and the taper is a smoothstep (C1, not C2) —
   and a G2 version of it was tried and REJECTED on looks: the smooth bump
   reads flatter and loses the accelerating bend that makes this feel like
   glass. The maths is less tidy; the picture is better. Leave it. */
export function lensFalloff(r: number): number {
  const d = Math.min(r / LENS.R, 1);
  return (1 - Math.sqrt(1 - d * d)) * (1 - smoothstep(LENS.TAPER_IN, LENS.TAPER_OUT, r));
}

/** The same expression as GLSL, so the shader and this module cannot say
 *  different things. The shader interpolates this string; keep the two
 *  bodies identical if either is ever edited. */
export const LENS_FALLOFF_GLSL = /* glsl */ `
float lensFalloff(float r) {
  float d = min(r / ${LENS.R}, 1.0);
  return (1.0 - sqrt(1.0 - d * d)) * (1.0 - smoothstep(${LENS.TAPER_IN}, ${LENS.TAPER_OUT}, r));
}`;

/** How far the sample point is pulled inward at radius `r`. */
export function bendAt(r: number, energy: number): number {
  return (LENS.BEND_BASE + LENS.BEND_ENERGY * energy) * lensFalloff(r);
}

/* The shader reads the shapes at `p − dir·bend(|p|)`, so a point that IS at
   radius q in shape-space appears on screen at the radius r that satisfies
   r − bend(r) = q. Both the bend and the taper are smooth and the net map
   is monotonic over the range we draw, so a bisection finds r exactly. */
export function screenRadiusFor(q: number, energy: number): number {
  if (q <= 0) return 0;
  let lo = q;
  let hi = q + LENS.BEND_BASE + LENS.BEND_ENERGY + 0.05;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (mid - bendAt(mid, energy) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Map a point from shape-space to where the lens actually shows it. */
export function unwarp(x: number, y: number, energy: number): [number, number] {
  const q = Math.hypot(x, y);
  if (q < 1e-9) return [x, y];
  const r = screenRadiusFor(q, energy);
  const s = r / q;
  return [x * s, y * s];
}

/** The shader's own brightness/saturation pass, so exported colour matches
 *  what is on screen rather than the raw palette hex. */
export function shadeColor(
  rgb: [number, number, number],
  energy: number,
  vibrance = 0,
): [number, number, number] {
  const gain = 0.94 + 0.1 * energy;
  const c: [number, number, number] = [rgb[0] * gain, rgb[1] * gain, rgb[2] * gain];
  const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const sat = 1 + 0.12 * vibrance;
  const lift = 1 + 0.06 * vibrance;
  return [
    Math.min(1, Math.max(0, (lum + (c[0] - lum) * sat) * lift)),
    Math.min(1, Math.max(0, (lum + (c[1] - lum) * sat) * lift)),
    Math.min(1, Math.max(0, (lum + (c[2] - lum) * sat) * lift)),
  ];
}
