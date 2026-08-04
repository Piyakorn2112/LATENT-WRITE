/**
 * Liquid-glass displacement-map worker.
 *
 * Computes the per-pixel SDF + Snell + progressive-blur-mask values, draws
 * them into an OffscreenCanvas, and PNG-encodes via convertToBlob — all
 * off the main thread. The main thread receives a Blob and turns it into
 * an object URL for the SVG <feImage>.
 *
 * Tunables here mirror the constants in `liquid-glass-filter.ts`. They
 * deliberately duplicate rather than import from main, because Workers
 * pull in only their own module graph (no DOM, no `document`).
 *
 * ── Corner refraction ────────────────────────────────────────────────────
 *
 * Single-computation Snell with directional projection. One scalar
 * displacement is computed from the bezel profile at the pixel's SDF
 * distance, then projected onto X/Y via the SDF's outward-normal gradient.
 * On edges only one axis is active; at corners both axes share the same
 * magnitude rotated by the gradient direction — giving uniform refraction
 * strength around the entire perimeter at any given SDF distance.
 *
 * The SDF gradient is computed via finite differences of the rounded-rect
 * SDF (matching the WebGL reference approach), which naturally handles the
 * edge-to-corner transition without any smoothstep blending.
 *
 * Magnitude normalisation: a single maxMag value normalises both channels
 * so displacement strength is identical on edges and corners.
 *
 * ── Cost structure (read before optimising) ──────────────────────────────
 *
 * The map is SEPARABLE almost everywhere. Away from the four corner arcs the
 * rounded-rect SDF collapses to `max(qx, qy) − r`, so one axis alone decides
 * the distance — and everything derived from distance (edge coverage, blur
 * mask, bezel coverage, the squircle profile, the Snell solve) is therefore a
 * per-row or per-column constant, not per-pixel work. Only the corner arcs,
 * where both q are positive, are genuinely two-dimensional. The build exploits
 * this with axis tables; see sdSharpQ and the GRAD_FLAT gradient shortcut.
 *
 * That matters most on the shapes the app actually uses: a 1100x44 toolbar is
 * ~2% corner arc, and the control-knob presets rasterise their map at 16x
 * oversample, where a 20x14 knob becomes a 1728x1632 buffer that is 97%
 * constant margin.
 *
 * Any change here must stay byte-identical. Two harnesses prove it:
 *   · unit        — scratchpad lg-verify.ts byte-compares buildMapPixels
 *                   against a frozen copy of the original math.
 *   · integration — scripts/glass-pixel-diff.cjs screenshots
 *                   /glass-verify.html in real Chromium and compares pixels.
 * Verify a harness can FAIL (perturb BEZEL_PX by 1) before trusting a pass.
 */

import { buildKnobMapPixels } from "./knob-glass";

// Air → glass.
const N1 = 1;
const N2 = 1.5;
type MapPreset = "default" | "control-knob" | "toggle-control-knob";
const CHANNEL_GAIN: Record<MapPreset, number> = {
  default: 1,
  "control-knob": 0.35,
  "toggle-control-knob": 0.24,
};
const EDGE_AA_SPAN: Record<MapPreset, number> = {
  default: 0,
  "control-knob": 1.25,
  "toggle-control-knob": 1.1,
};
// Texels per element px in the FINAL map — the density the compositor has to
// resample every frame the backdrop changes.
//
// ★★ DO NOT RAISE THIS BACK TO 12. It was 12, and that was the single most
// expensive thing in the whole glass system: two knobs cost 13.31 ms/frame on
// an M1 Pro, roughly 40x the entire 1100x44 toolbar. The cause is minification,
// not size — `filterRes` rasterises the knob presets at 2 device px per element
// px (see readFilterResConfig), so a 12-texel/px map is reduced ~36x per pixel
// every frame and almost all of it is thrown away. Ablation: dropping density
// alone, changing nothing else, measured 13.31 -> 0.39 ms/frame (33x).
//
// 3 still exceeds the 2 device px/element px the filter can actually display,
// so no showable detail is lost, and MAP_RENDER_OVERSAMPLE below keeps the
// worker supersampling from 16x and averaging down — the bezel is still built
// at high precision, it is simply stored at a sane density.
//
// This is the one place the glass rendering deliberately changed: ~750 px on
// the two knobs (max channel delta 53), indistinguishable at 6x magnification,
// approved explicitly. Everything else in the engine is pixel-frozen.
const MAP_OVERSAMPLE: Record<MapPreset, number> = {
  default: 1,
  "control-knob": 3,
  "toggle-control-knob": 3,
};
// Internal render density, averaged down to MAP_OVERSAMPLE for real SSAA. Keep
// this well above MAP_OVERSAMPLE — it is what makes the knob bezel smooth, and
// it costs worker CPU only, never per-frame GPU.
const MAP_RENDER_OVERSAMPLE: Record<MapPreset, number> = {
  default: 1,
  "control-knob": 16,
  "toggle-control-knob": 16,
};

// Visual bezel thickness in element pixels (must match main-thread filter).
//
// ★ THINNER EDGE. Was 120px capped at 0.8 of the half-short-side, which on a
// 46px-tall toolbar put the bevel at 18.4 of 23 available px — nearly the whole
// half, so the bend was spread across the entire bar and never read as an edge.
// A real glass slab is FLAT over almost its whole area and rolls over in a
// narrow band; this is that band.
//
// ★ AND IT IS COUPLED TO THE STRENGTH, deliberately. The fold-free budget is
// `bezel / 1.5`, so a thinner bevel also caps the pull harder — that is the
// arithmetic of not tearing the backdrop in an 8-bit gather, not a separate
// choice. Widen the bevel if more refraction is wanted; do not raise the pull
// past the budget.
const BEZEL_PX = 80;
const BEZEL_FRAC = 0.5;

// Progressive blur — sharp-rim → blurred-interior gradient.
//   BLUR_EDGE_MIN       — mask value at the very edge. >0 means blur is already
//                         visible at the rim; the ramp goes from this baseline
//                         up to 1 over the transition zone, so there's no
//                         sharp band immediately inside the boundary.
//   BLUR_TRANSITION_PCT — distance (% of half-shorter-side) over which the
//                         mask ramps from BLUR_EDGE_MIN up to fully blurred.
//   BLUR_EXP            — easing exponent on the ramp.
const BLUR_EDGE_MIN = 0.85;
const BLUR_TRANSITION_PCT = 0.25;
const BLUR_EXP = 2;

// Map resolution: the map is built at (element px / divisor), so a LARGER
// divisor means a coarser, cheaper map.
// Small elements (shorter side ≤ MAP_DIVISOR_BREAK) use divisor 1 — one map
// texel per element pixel — for full bezel fidelity. Above the break the
// divisor jumps to 10: the SDF gradient is smooth enough at that scale that
// the coarser map is imperceptible, and it drops a 900x700 panel from 630k
// worker pixels to 6.3k. (The values named in this comment used to be 7 and 9;
// they are 1 and 10.)
const MAP_DIVISOR       = 1;
const MAP_DIVISOR_LARGE = 10;
const MAP_DIVISOR_BREAK = 320;

const RADIUS_FLOOR = 1;

// Convex squircle h(t) = (1−(1−t)⁴)^¼  — Apple-style bezel profile.
const h = (t: number) => (1 - (1 - t) ** 4) ** 0.25;
const dh = (t: number) => {
  const dt = 5e-4;
  return (h(Math.min(t + dt, 1)) - h(Math.max(t - dt, 0))) / (2 * dt);
};

// ── Bit-exact fast paths ─────────────────────────────────────────────────
//
// Math.hypot is a builtin call V8 will not inline, and the SDF + gradient
// evaluate it up to five times per pixel — the most expensive single thing in
// the map. But hypot(a, 0) === |a| EXACTLY (V8 computes max·sqrt(1+0); fuzzed
// over 3M values including subnormals and extremes, zero mismatches), and on
// every straight run of the shape one component is exactly zero. So the
// axis-aligned majority of each map skips it with an identical result.
//
// NOTE: do NOT "simplify" this to sqrt(a*a + b*b) — that disagrees with
// Math.hypot on ~5% of inputs (a*a underflows to 0 for subnormal a).
function hypot2(a: number, b: number): number {
  if (a === 0) return Math.abs(b);
  if (b === 0) return Math.abs(a);
  return Math.hypot(a, b);
}

// The rounded-box SDF, on q values the caller has already computed once per
// row / per column:  qx = |px| − (halfW − r),  qy = |py| − (halfH − r).
// Math.max(q, 0) is written as a ternary — identical for every finite input,
// including −0 — so the hypot fast path above can see the exact zero.
//
// ★ KEY IDENTITY, used throughout: unless qx > 0 AND qy > 0 (the corner-arc
// quadrant) this reduces to max(qx, qy) − r bit-for-bit:
//   · both ≤ 0 → outside = hypot(0,0) = 0, inside = max(qx,qy)
//   · one  > 0 → outside = that one,       inside = 0
// so ONE axis alone decides the distance, and everything derived from the
// distance is separable into per-row / per-column tables.
function sdSharpQ(qx: number, qy: number, r: number): number {
  const outside = hypot2(qx > 0 ? qx : 0, qy > 0 ? qy : 0);
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

// Smooth-max variant — polynomial blend (Inigo Quilez) replaces the
// hard max(qx, qy) inside the rounded box. The sharp max has a gradient
// discontinuity along the qx=qy diagonal (45° from each corner center).
// On pill shapes this line falls outside the bezel; on large rectangles
// with small corner radii it cuts through, producing a visible diagonal
// refraction seam. The smooth variant blends the gradient over ±GRAD_K
// element-pixels around that diagonal, eliminating the seam.
// Used ONLY for gradient direction — the sharp SDF drives distance.
const GRAD_K = 40;
function sdSmoothQ(qx: number, qy: number, r: number): number {
  const outside = hypot2(qx > 0 ? qx : 0, qy > 0 ? qy : 0);
  const d = Math.max(GRAD_K - Math.abs(qx - qy), 0) / GRAD_K;
  const inside = Math.min(Math.max(qx, qy) + d * d * GRAD_K * 0.25, 0);
  return outside + inside - r;
}

// Finite-difference probe offset for the gradient, in element pixels.
const GRAD_EPS = 0.5;
// Where one axis leads the other by at least this much, all three smooth-SDF
// probes have d = 0 (smooth ≡ sharp) even after the ±GRAD_EPS shift, and the
// normalised gradient is exactly (0, ±1) or (±1, 0) — a per-row or per-column
// constant instead of three SDF evaluations plus a hypot per pixel.
// GRAD_K + 1 because the probe can move a q value by at most GRAD_EPS.
const GRAD_FLAT = GRAD_K + 1;

// ── Per-distance scalars ─────────────────────────────────────────────────
// Everything between the SDF and the gradient — edge coverage, the blur mask,
// bezel coverage, the squircle slope and the Snell displacement — is a pure
// function of distToEdge. Computing it through this one routine lets the
// caller hoist it to per-row / per-column tables (see sdSharpQ) while keeping
// the arithmetic, and therefore the bits, identical to the per-pixel form.
// Results land in module scratch rather than a returned record so the hot
// loop allocates nothing.
const S_SKIP = 0;      // edgeCoverage <= 0 → pixel untouched
const S_MASK_ONLY = 1; // inside, but no displacement here
const S_FULL = 2;      // mask + displacement
let S_flag = S_SKIP;
let S_mask = 0;        // pre-rounding; assign into a Uint8ClampedArray to round
let S_disp = 0;
let S_cov = 0;

function scalarsFor(
  distToEdge: number,
  edgeAaWidth: number,
  baselineMask: number,
  blurRimEnd: number,
  bezel: number,
): void {
  const edgeCoverage = edgeAaWidth > 0
    ? clamp01(0.5 + distToEdge / edgeAaWidth)
    : distToEdge > 0 ? 1 : 0;

  if (edgeCoverage <= 0) {
    S_flag = S_SKIP;
    return;
  }

  // ── Progressive blur mask ────────────────────────────────────────────
  const maskDist = Math.max(distToEdge, 0);
  let targetMask = baselineMask;
  if (maskDist >= blurRimEnd) {
    targetMask = 255;
  } else {
    const t = blurRimEnd > 0 ? maskDist / blurRimEnd : 1;
    const eased = (t < 0 ? 0 : t > 1 ? 1 : t) ** BLUR_EXP;
    targetMask = (BLUR_EDGE_MIN + (1 - BLUR_EDGE_MIN) * eased) * 255 + 0.5;
  }
  S_mask = baselineMask + (targetMask - baselineMask) * edgeCoverage + 0.5;

  const bezelCoverage = edgeAaWidth > 0
    ? clamp01(0.5 + (bezel - distToEdge) / edgeAaWidth)
    : distToEdge < bezel ? 1 : 0;
  const dispCoverage = Math.min(edgeCoverage, bezelCoverage);

  if (dispCoverage <= 0) {
    S_flag = S_MASK_ONLY;
    return;
  }

  // ── Snell displacement from the bezel profile ────────────────────────
  //
  // ★★ THE FOLD-FREE FALLOFF. This is the fix for the refracted content
  // doubling and smearing behind a glass surface — the thing that reads as the
  // content leaning one way at the top of the bar and the other way at the
  // bottom.
  //
  // feDisplacementMap GATHERS: out(P) = backdrop(P + disp(P)). The backdrop is
  // bent only while the sampling position keeps ADVANCING —
  //
  //     d/dy [ y + disp(y) ] > 0        i.e.   A · max|g'| ≤ bezel
  //
  // The raw squircle→Snell profile fails that badly. Its slope is clamped at 5
  // right at the rim and collapses within ~10% of the bezel, so max|g'| is an
  // order of magnitude past 1. Measured on the SHIPPED maps
  // (scripts/probe-glass-fold.ts), fraction of interior texels whose sampling
  // runs BACKWARDS:
  //
  //     toolbar 920x46   37.2%   worst -4.33x normal
  //     tab      26x34   43.7%   worst -7.00x
  //     pill    180x34   41.0%   worst -5.59x
  //     popover 420x120  18.7%   worst -3.86x
  //
  // Backwards sampling re-reads backdrop the gather has already read, mirrored
  // and compressed — over prose that doubles the letterforms, which is exactly
  // what the toolbar shows over a chapter title.
  //
  // ★ THE FIX IS THE SHAPE, NOT THE STRENGTH. A FLATTER falloff lets the SAME
  // rim pull stay fold-free: the smoothstep complement g(t) = (1−t)²(1+2t) has
  // g(0)=1, g(1)=0, zero slope at both ends and max|g'| = 1.5 exactly. The rim
  // magnitude is untouched — only the decay inward is reshaped — so the glass
  // bends exactly as hard at its edge as before.
  //
  // ★ AND IT IS NOT A NEW IDEA HERE. knob-glass.ts has carried precisely this
  // for the control knobs since their own banding investigation, with the same
  // constant and the same reasoning; the general worker simply never got it.
  //
  // ★ WHY THE CANVAS PATH COULD FOLD HAPPILY AND THIS CANNOT. knob-glass-paint
  // folds ON PURPOSE — in float, with bilinear sampling, a fold is a smooth
  // compressed reflection and it is what makes a rim read as thick glass. In an
  // 8-BIT map the same fold is quantised into a comb. The fold is not the
  // defect; folding inside this encoding is.
  const t = Math.min(Math.max(distToEdge, 0), bezel) / bezel;
  const disp = RIM_DISP * falloff(t);

  if (disp < 1e-6) {
    S_flag = S_MASK_ONLY;
    return;
  }

  S_flag = S_FULL;
  S_disp = disp;
  S_cov = dispCoverage;
}

/**
 * Bounded-derivative falloff: 1 at the rim → 0 at the bezel depth, with
 * max|g'| = 1.5 exactly (at t = ½). Identical to knob-glass.ts's.
 */
const MAX_G_SLOPE = 1.5;
function falloff(t: number): number {
  const u = 1 - t;
  return u * u * (1 + 2 * t);
}

/**
 * The rim magnitude, straight from the physics — the squircle's steepest slope
 * refracted through Snell. Unchanged from before: only the decay INWARD is
 * reshaped, so the glass bends exactly as hard at its edge as it always did.
 */
const RIM_DISP = snellDisp(Math.min(dh(0), 5.0), N1 / N2);

/** The largest peak pull a bezel of this width can carry without folding. */
export function foldFreeBudget(bezelPx: number): number {
  return bezelPx / MAX_G_SLOPE;
}

/**
 * Snell's law lateral displacement for a convex surface profile.
 * Returns a positive scalar — the caller projects it onto X/Y
 * via the SDF gradient direction.
 */
function snellDisp(slope: number, eta: number): number {
  if (slope < 1e-3) return 0;
  const nLen = Math.hypot(slope, 1);
  const nZ = 1 / nLen;
  const sinSq = eta * eta * (1 - nZ * nZ);
  if (sinSq >= 1) return 0;
  const nSurface = slope / nLen;
  return (Math.sqrt(1 - sinSq) - eta * nZ) * nSurface;
}

interface MapRequest {
  id: string;
  elemW: number;
  elemH: number;
  radius: number;
  overflow: number;
  preset: MapPreset;
  /** Per-element bezel (refraction radius) override; undefined/null → BEZEL_PX. */
  bezel?: number | null;
  /** Full quality: keep the fine map divisor regardless of element size. */
  fullQuality?: boolean;
  /** Supersample factor for the displacement-map resolution (1 = normal). */
  superSample?: number;
  /**
   * Element px of neutral margin to BAKE into the map, when that is less than
   * `overflow`. The map only needs real data inside the element — the rest of
   * the filter region is a constant, which the caller can supply with an
   * feFlood instead of storing it in a texture. Only honoured when it is
   * provably free of visual change; see `padX`/`padY` on the response.
   */
  mapPad?: number | null;
  /**
   * Knob presets only: how much bigger than its layout box the knob is
   * DISPLAYED at while the glass is attached (the press swell). Authors the
   * map at that density — see knob-glass.ts.
   */
  displayScale?: number;
  /** The filter's feDisplacementMap scale — knob presets need it to size
   *  their fold-free budget. */
  dispPx?: number;
}

interface MapResponse {
  id: string;
  blob: Blob;
  /**
   * Element px of margin actually baked in, per axis. The caller MUST place
   * <feImage> at exactly (−padX, −padY, elemW + 2·padX, elemH + 2·padY), and
   * flood the rest of the region, or the map will be sampled at the wrong
   * scale. Equals `overflow` when the full-margin map was used.
   */
  padX: number;
  padY: number;
}

function computeMapSize(
  elemW: number,
  elemH: number,
  overflow: number,
  divisor: number,
  oversample: number,
) {
  const elemWidth = Math.max(8, Math.round((elemW * oversample) / divisor));
  const elemHeight = Math.max(8, Math.round((elemH * oversample) / divisor));
  const overflowX = Math.max(1, Math.round((overflow * elemWidth) / elemW));
  const overflowY = Math.max(1, Math.round((overflow * elemHeight) / elemH));
  return {
    elemWidth,
    elemHeight,
    overflowX,
    overflowY,
    width: elemWidth + 2 * overflowX,
    height: elemHeight + 2 * overflowY,
  };
}

// The map must round-trip EXACTLY — feDisplacementMap reads these bytes as
// vectors, so any lossy compression is visible as refraction noise.
//
// PNG rather than WebP: `image/webp` at quality 1.0 does encode losslessly
// (verified — a decode round-trip returns byte-identical pixels), but WebP's
// lossless mode is 5-7× slower to encode than PNG and produces a 2-4× LARGER
// file for this kind of image (huge flat margin + a smooth gradient band):
// the 1296×1224 range-knob map is 39.6ms / 401KB as WebP against 6.1ms / 108KB
// as PNG. Both decode to identical pixels, so this is pure profit.
async function encodeCanvas(canvas: OffscreenCanvas): Promise<Blob> {
  return await canvas.convertToBlob({ type: "image/png" });
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export interface MapPixels {
  /**
   * RGBA bytes of the render-resolution map, row-major, mw × mh. Explicitly
   * backed by an ArrayBuffer (not ArrayBufferLike) so it can be handed
   * straight to the ImageData constructor without a copy.
   */
  data: Uint8ClampedArray<ArrayBuffer>;
  mw: number;
  mh: number;
  /** Final (post-SSAA-downscale) size. Equals mw/mh unless needsDownscale. */
  outW: number;
  outH: number;
  needsDownscale: boolean;
  /** Element px of margin baked in, per axis (see MapResponse.padX). */
  padX: number;
  padY: number;
}

/**
 * Decide how much neutral margin to bake into the map.
 *
 * The map only carries real data inside the element; the rest of the filter
 * region is one constant colour. Storing that constant as texture is what makes
 * the knob maps enormous — a 20x14 range knob bakes a 1296x1224 map of which
 * 97% by area is padding — and Chromium re-samples the whole feImage every
 * frame the backdrop changes, so it is a *per-frame GPU* cost, not just memory.
 * Measured on an M1 Pro: two knobs cost 13.31 ms/frame, and shrinking the map
 * (nothing else) took that to 0.40 ms.
 *
 * ★ THE CONSTRAINT. <feImage> stretches the map onto its rect, so the map's
 * texels-per-element-px must not change or the refraction is resampled and the
 * look shifts. Deriving the rect from the texel margin makes the new scale
 * exactly `elemWidth / elemW` algebraically — but that is only a no-op if the
 * CURRENT full-margin map already sits at that same scale. It does for the knob
 * presets (12.000000, because their overflow x oversample lands on an integer)
 * and it does NOT for the toolbar (0.999329) or the lens (4.005376), whose
 * maps are very slightly stretched today. That stretch is part of how they
 * render right now, so those keep the full-margin map untouched.
 *
 * Hence: shrink only when the current scale is *exactly* the element scale on
 * both axes. The check is here, next to the arithmetic it guards, rather than
 * duplicated in the main thread.
 */
function resolveMapPad(
  elemW: number, elemH: number, overflow: number,
  divisor: number, mapOversample: number, requested: number | null | undefined,
): number {
  if (requested == null || !(requested < overflow)) return overflow;

  const full = computeMapSize(elemW, elemH, overflow, divisor, mapOversample);
  // Scale the map is sampled at today, vs the scale its element portion is
  // authored at. Must match bit-for-bit on both axes.
  const currentScaleX = full.width / (elemW + 2 * overflow);
  const currentScaleY = full.height / (elemH + 2 * overflow);
  if (currentScaleX !== full.elemWidth / elemW) return overflow;
  if (currentScaleY !== full.elemHeight / elemH) return overflow;

  // And the shrunk map must still round to a whole texel margin cleanly, so
  // the rect the caller derives lands back on exactly `requested`.
  const small = computeMapSize(elemW, elemH, requested, divisor, mapOversample);
  if ((small.overflowX * elemW) / small.elemWidth !== requested) return overflow;
  if ((small.overflowY * elemH) / small.elemHeight !== requested) return overflow;

  return requested;
}

/**
 * Pure per-pixel map computation — no canvas, no encode. Exported so the
 * zero-visual-change harness can byte-compare it against the frozen baseline
 * (scripts/liquid-glass-baseline.ts) in Node.
 */
export function buildMapPixels(req: MapRequest): MapPixels {
  // ★ THE KNOBS HAVE THEIR OWN ENGINE. A knob is a pill: its normal is
  // available in closed form, and the smooth-max blend below exists only to
  // hide a diagonal seam that large rectangles have and pills do not (on a
  // 32x24 knob the 40px blend band is wider than the knob itself). knob-glass
  // solves it analytically — the STM /about hero's method — and authors the
  // map at the density the knob is DISPLAYED at, which for a knob means at
  // full press. Everything below stays exactly as it was for every other
  // preset, which is what keeps this file pixel-frozen.
  if (req.preset === "control-knob" || req.preset === "toggle-control-knob") {
    return buildKnobMapPixels({
      elemW: req.elemW,
      elemH: req.elemH,
      radius: req.radius,
      overflow: req.overflow,
      preset: req.preset,
      bezel: req.bezel,
      displayScale: req.displayScale,
      mapPad: req.mapPad,
      dispPx: req.dispPx,
    });
  }

  const { elemW, elemH, radius, overflow } = req;
  // Knob presets returned above, so only "default" can reach here — the
  // compiler agrees (the old three-way normalisation is now provably dead
  // code). Every constant below is therefore read at its "default" entry,
  // exactly as before for every non-knob element.
  const preset: MapPreset = "default";
  const channelGain = CHANNEL_GAIN[preset];
  // Supersample boosts the map's pixel resolution so a CSS scale-up of the
  // element (the lens) stays smooth instead of revealing stair-step ridges.
  const ss = Math.max(1, req.superSample ?? 1);
  const mapOversample = MAP_OVERSAMPLE[preset] * ss;
  const renderOversample = Math.max(mapOversample, MAP_RENDER_OVERSAMPLE[preset] * ss);

  // fullQuality (the lens) keeps the fine divisor at any size — it ignores the
  // large-element coarsening that trades map resolution for perf above the break.
  const divisor = req.fullQuality
    ? MAP_DIVISOR
    : Math.min(elemW, elemH) > MAP_DIVISOR_BREAK ? MAP_DIVISOR_LARGE : MAP_DIVISOR;
  const pad = resolveMapPad(elemW, elemH, overflow, divisor, mapOversample, req.mapPad);
  const renderSize = computeMapSize(elemW, elemH, pad, divisor, renderOversample);
  const outputSize = computeMapSize(elemW, elemH, pad, divisor, mapOversample);
  const mwElem = renderSize.elemWidth;
  const mhElem = renderSize.elemHeight;
  const ovX = renderSize.overflowX;
  const ovY = renderSize.overflowY;
  const mw = renderSize.width;
  const mh = renderSize.height;

  const halfW = elemW / 2;
  const halfH = elemH / 2;
  const halfShorter = Math.min(halfW, halfH);
  const r = Math.min(Math.max(radius, RADIUS_FLOOR), halfShorter);

  const bezel = Math.min(req.bezel ?? BEZEL_PX, halfShorter * BEZEL_FRAC);
  // Ramp goes from the actual rim (distToEdge = 0) up to blurRimEnd. Within
  // that band, mask starts at BLUR_EDGE_MIN (so the very edge is already
  // partly blurred — no sharp band) and rises to 1 (full blur).
  const blurRimEnd = Math.max(1, Math.min(halfShorter * BLUR_TRANSITION_PCT, halfShorter));

  const sxInv = elemW / mwElem;
  const syInv = elemH / mhElem;
  const edgeAaWidth = EDGE_AA_SPAN[preset] * Math.max(sxInv, syInv);

  const data = new Uint8ClampedArray(new ArrayBuffer(mw * mh * 4));

  // Pre-fill: neutral displacement (RG=128) + mask baseline in B. The mask
  // baseline EXTENDS past the rounded shape into the overflow margin and the
  // bounding-box corners — so when the SVG's bilinear sampling lands on the
  // rim it averages two equally-high mask values, not one high + one zero.
  // The visible rim stays at full blur intensity instead of bleeding sharp
  // pixels in from outside.
  //
  // Written as one 32-bit word per pixel instead of four byte stores. The
  // margin dwarfs the element on the oversampled knob presets (a 20×14 knob
  // renders a 1728×1632 map, 97% of it this constant), and that made the
  // pre-fill a quarter of the whole map build. Seeding the first pixel and
  // reading it back as a word keeps this byte-order agnostic.
  const baselineMask = ((BLUR_EDGE_MIN * 255 + 0.5) | 0);
  data[0] = 128;
  data[1] = 128;
  data[2] = baselineMask;
  data[3] = 255;
  const words = new Uint32Array(data.buffer, 0, mw * mh);
  words.fill(words[0]);

  const elemPixels = mwElem * mhElem;
  const raw = new Float32Array(elemPixels * 2);
  const maskBuf = new Uint8ClampedArray(elemPixels);
  // Seed the per-element mask buffer with the same baseline; pixels outside
  // the rounded rect (bounding-box corners) hit `continue` and inherit it.
  maskBuf.fill(baselineMask);

  // ── Axis tables ──────────────────────────────────────────────────────────
  // q values for each pixel centre, plus the gradient probes.
  //
  // ★★ THE PROBE IS CENTRED ON THE PIXEL, AND IT HAS TO BE. This is the fix for
  // the long-standing report that refracted content "leans left at the top and
  // right at the bottom".
  //
  // The probe used to be one-sided: `|px_rel + GRAD_EPS| - insetX`, differenced
  // against the pixel's own q. Putting the +EPS inside the abs is what makes
  // the difference carry the outward sign for free, and that part is right. But
  // a one-sided difference estimates the derivative at p + EPS/2, not at p —
  // and because the step is taken in p, that offset points the SAME absolute
  // way above and below the centreline. So the normal is read from a field
  // shifted down and right, and the resulting angular error is NOT
  // mirror-symmetric: it tilts one way at the top edge and the other way at the
  // bottom. That is a lean, by construction, and no amount of tuning the
  // profile or the falloff removes it.
  //
  // Measured on the shape's own SDF in FLOAT, with no packing anywhere — the
  // largest |gx(x, y) − gx(x, −y)| inside the bezel, which a correct field
  // makes exactly zero (scripts/probe-glass-gradient-bias.ts):
  //
  //     shape                       one-sided      centred
  //     toolbar  920x46  r23           0.0320       0.0000
  //     panel    370x620 r24           0.8896       0.0000
  //     square   300x300 r24           0.8896       0.0000
  //     circle   220x220 r110          0.0073       0.0000
  //
  // 0.032 of a unit normal is ~1.8°, which against the 20px peak pull is ~0.6px
  // of horizontal displacement with opposite signs top and bottom — four times
  // feDisplacementMap's own 0.157px quantisation step. So this was never a
  // rounding artifact and never a Chromium limitation; it was ours.
  //
  // The error is largest inside the GRAD_K smooth-max blend band, because that
  // is where the normal actually rotates. A stadium keeps that band outside its
  // bezel, which is why the toolbar's number is 20x smaller than the panel's —
  // but still not zero, and still visible on a 46px-tall bar.
  //
  // Cost: one extra SDF evaluation per pixel, and only in the blend branch —
  // the axis-aligned fast paths below still take none.
  const insetX = halfW - r;
  const insetY = halfH - r;
  const GRAD_HALF = GRAD_EPS * 0.5;

  const QX = new Float64Array(mwElem);
  const QXA = new Float64Array(mwElem);
  const QXB = new Float64Array(mwElem);
  for (let px = 0; px < mwElem; px++) {
    const px_rel = (px + 0.5) * sxInv - halfW;
    QX[px] = Math.abs(px_rel) - insetX;
    QXA[px] = Math.abs(px_rel - GRAD_HALF) - insetX;
    QXB[px] = Math.abs(px_rel + GRAD_HALF) - insetX;
  }
  const QY = new Float64Array(mhElem);
  const QYA = new Float64Array(mhElem);
  const QYB = new Float64Array(mhElem);
  for (let py = 0; py < mhElem; py++) {
    const py_rel = (py + 0.5) * syInv - halfH;
    QY[py] = Math.abs(py_rel) - insetY;
    QYA[py] = Math.abs(py_rel - GRAD_HALF) - insetY;
    QYB[py] = Math.abs(py_rel + GRAD_HALF) - insetY;
  }

  // Per-axis scalars + axis-aligned gradient. On every straight run of the
  // shape the SDF is max(qx, qy) − r (see sdSharpQ), so the squircle profile
  // and the Snell solve — two Math.pow calls, ~40% of the map build — depend
  // on one axis only and are hoisted here. The corner arcs, where both q are
  // positive, still solve per pixel below.
  const colFlag = new Uint8Array(mwElem);
  const colMask = new Uint8ClampedArray(mwElem);
  const colDisp = new Float64Array(mwElem);
  const colCov = new Float64Array(mwElem);
  const colGx = new Float64Array(mwElem);
  for (let px = 0; px < mwElem; px++) {
    const qx = QX[px];
    scalarsFor(r - qx, edgeAaWidth, baselineMask, blurRimEnd, bezel);
    colFlag[px] = S_flag;
    colMask[px] = S_mask;
    colDisp[px] = S_disp;
    colCov[px] = S_cov;
    // Where this column leads, sd = qx − r for every probe, so gy is exactly 0
    // and the normalised gx is exactly ±1 (or 0,0 when the length guard trips).
    // Centred now: the difference is between the two probes, not probe-minus-
    // centre, which is what makes the two halves of the shape mirror exactly.
    const g = QXB[px] - QXA[px];
    colGx[px] = Math.abs(g) < 1e-6 ? 0 : g < 0 ? -1 : 1;
  }

  const rowFlag = new Uint8Array(mhElem);
  const rowMask = new Uint8ClampedArray(mhElem);
  const rowDisp = new Float64Array(mhElem);
  const rowCov = new Float64Array(mhElem);
  const rowGy = new Float64Array(mhElem);
  for (let py = 0; py < mhElem; py++) {
    const qy = QY[py];
    scalarsFor(r - qy, edgeAaWidth, baselineMask, blurRimEnd, bezel);
    rowFlag[py] = S_flag;
    rowMask[py] = S_mask;
    rowDisp[py] = S_disp;
    rowCov[py] = S_cov;
    const g = QYB[py] - QYA[py];
    rowGy[py] = Math.abs(g) < 1e-6 ? 0 : g < 0 ? -1 : 1;
  }

  // Row narrowing slack, in map texels: enough to cover the AA half-span plus
  // a whole element pixel, and never fewer than 3 texels, so no pixel the
  // original would have written can be skipped by the analytic span.
  const slackX = 3 + Math.ceil((edgeAaWidth * 0.5 + 1) / sxInv);
  // Radius the row-narrowing below must respect. With edge AA the shape keeps
  // a half-span skirt OUTSIDE its geometry (edgeCoverage stays > 0 until
  // distToEdge < −edgeAaWidth/2), so the span has to be measured against the
  // skirt, not the geometric radius. This matters specifically in the last row
  // or two, where qy approaches r and the chord sqrt turns near-vertical: at
  // r = 7, qy = 6.99 the geometric chord is 0.37px but the AA chord is 3.05px,
  // more than the flat slack would have covered.
  const rSpan = r + edgeAaWidth * 0.5;

  let maxMag = 0;

  for (let py = 0; py < mhElem; py++) {
    const qy = QY[py];
    const qya = QYA[py];
    const qyb = QYB[py];
    const rFlag = rowFlag[py];
    const rMask = rowMask[py];
    const rDisp = rowDisp[py];
    const rCov = rowCov[py];
    const rGy = rowGy[py];
    const rowBase = py * mwElem;

    // Narrow the row to the pixels that can lie inside the shape (or its AA
    // skirt). In the corner-arc band a pixel is only ever written where
    // |px_rel| < insetX + chord; past that the SDF is negative, and the
    // original loop `continue`s there without writing anything, so skipping is
    // a no-op — on a circle that is a fifth of the bounding box.
    //
    // qy can never exceed r (|py_rel| <= halfH and insetY = halfH − r), so the
    // chord is always real.
    let pxLo = 0;
    let pxHi = mwElem - 1;
    if (qy > 0) {
      const chord = qy >= rSpan ? 0 : Math.sqrt(rSpan * rSpan - qy * qy);
      const reach = insetX + chord;
      const lo = Math.floor((halfW - reach) / sxInv - 0.5) - slackX;
      const hi = Math.ceil((halfW + reach) / sxInv - 0.5) + slackX;
      if (lo > pxLo) pxLo = lo;
      if (hi < pxHi) pxHi = hi;
    }

    for (let px = pxLo; px <= pxHi; px++) {
      const qx = QX[px];

      let flag: number;
      let maskV: number;
      let disp: number;
      let cov: number;
      if (qx > 0 && qy > 0) {
        // Corner arc — genuinely two-dimensional, solve per pixel.
        scalarsFor(-sdSharpQ(qx, qy, r), edgeAaWidth, baselineMask, blurRimEnd, bezel);
        flag = S_flag;
        maskV = S_mask;
        disp = S_disp;
        cov = S_cov;
      } else if (qy >= qx) {
        flag = rFlag;
        maskV = rMask;
        disp = rDisp;
        cov = rCov;
      } else {
        flag = colFlag[px];
        maskV = colMask[px];
        disp = colDisp[px];
        cov = colCov[px];
      }

      if (flag === S_SKIP) continue;

      const i = rowBase + px;
      maskBuf[i] = maskV;

      if (flag === S_MASK_ONLY) continue;

      // ── Single-computation Snell + directional projection ────────────────
      // One scalar displacement from the bezel profile at the SDF distance,
      // projected onto X/Y via the finite-difference SDF gradient. Gives
      // uniform refraction strength at any given distance from the edge —
      // identical on straight edges and corners.
      let gx: number;
      let gy: number;
      if (qy - qx >= GRAD_FLAT && qx <= -GRAD_EPS) {
        gx = 0;
        gy = rGy;
      } else if (qx - qy >= GRAD_FLAT && qy <= -GRAD_EPS) {
        gx = colGx[px];
        gy = 0;
      } else {
        // Centred difference: both probes straddle the pixel, so the estimate
        // belongs to the pixel rather than to a point a quarter-pixel down and
        // to the right. See the axis-table note above for the measurement.
        const rawGx = sdSmoothQ(QXB[px], qy, r) - sdSmoothQ(QXA[px], qy, r);
        const rawGy = sdSmoothQ(qx, qyb, r) - sdSmoothQ(qx, qya, r);
        const len = hypot2(rawGx, rawGy);
        if (len < 1e-6) {
          gx = 0;
          gy = 0;
        } else {
          gx = rawGx / len;
          gy = rawGy / len;
        }
      }

      const dx = -gx * disp * cov;
      const dy = -gy * disp * cov;

      const idx = i * 2;
      raw[idx]     = dx;
      raw[idx + 1] = dy;

      const mag = hypot2(dx, dy);
      if (mag > maxMag) maxMag = mag;
    }
  }

  // Magnitude normalisation: both channels share the same scale so
  // displacement strength is uniform around the entire perimeter.
  const norm = maxMag > 0 ? maxMag : 1;

  // ★ AND THE AMPLITUDE CLAMP — the flatter falloff alone is not enough.
  //
  // The packed byte becomes `dispPx · (byte/255 − 0.5)` element px, so this
  // map's peak pull is `dispPx · 127 · gain / 255` = 19.92px for the default
  // preset. Fold-free needs that inside `bezel / 1.5`, which on the 46px-tall
  // toolbar (bezel 18.4) is 12.27px. Asking for more does not make the glass
  // stronger — it makes the backdrop tear — so the pull is scaled to fit rather
  // than shipped as a doubled, mirrored band over the prose behind it.
  const peakPx = ((req.dispPx ?? 40) * 127 * channelGain) / 255;
  const budgetPx = foldFreeBudget(bezel);
  const foldFreeClamp = peakPx > budgetPx ? budgetPx / peakPx : 1;

  for (let py = 0; py < mhElem; py++) {
    const rowBase = py * mwElem;
    const dstBase = ((py + ovY) * mw + ovX) * 4;
    for (let px = 0; px < mwElem; px++) {
      const i = rowBase + px;
      const rx = raw[i * 2];
      const ry = raw[i * 2 + 1];
      const b = dstBase + px * 4;
      if (rx === 0 && ry === 0) {
        // Undisplaced pixel: R/G quantise to exactly the 128 the pre-fill
        // already wrote (for +0 and −0 alike), and A is already 255. Only the
        // mask can differ. This is most of the map on every shape.
        const m = maskBuf[i];
        if (m !== baselineMask) data[b + 2] = m;
        continue;
      }
      // ★★ SYMMETRIC ROUNDING — the fix for "the bottom is straight, the top
      // still leans".
      //
      // `(128 + v + 0.5) | 0` FLOORS, because `128 + v` is always positive. So
      // it rounds +v up and −v toward zero: a displacement of +0.5 and one of
      // −0.5 land on bytes 129 and 128, not 129 and 127. The top half of a
      // surface carries the opposite sign to the bottom half, so that is a
      // systematic 1-LSB (dispPx/255 = 0.157px) bias between them — one rim
      // blending harder than the other, which is exactly the residual
      // asymmetry left once the fold was gone.
      //
      // knob-glass.ts has rounded away from zero since its own investigation
      // and records the same symptom; the general worker never got the fix.
      const vx = (rx / norm) * 127 * channelGain * foldFreeClamp;
      const vy = (ry / norm) * 127 * channelGain * foldFreeClamp;
      data[b]     = 128 + (vx < 0 ? -Math.round(-vx) : Math.round(vx));
      data[b + 1] = 128 + (vy < 0 ? -Math.round(-vy) : Math.round(vy));
      data[b + 2] = maskBuf[i];
      data[b + 3] = 255;
    }
  }

  return {
    data,
    mw,
    mh,
    outW: outputSize.width,
    outH: outputSize.height,
    needsDownscale: renderOversample > mapOversample + 0.01,
    // When the full margin was kept, report `overflow` verbatim rather than
    // re-deriving it — the derivation rounds, and for the stretched presets
    // that rounding would move <feImage> off its current rect.
    padX: pad === overflow ? overflow : (outputSize.overflowX * elemW) / outputSize.elemWidth,
    padY: pad === overflow ? overflow : (outputSize.overflowY * elemH) / outputSize.elemHeight,
  };
}

async function buildMapBlob(req: MapRequest): Promise<{ blob: Blob; padX: number; padY: number }> {
  const { data, mw, mh, outW, outH, needsDownscale, padX, padY } = buildMapPixels(req);

  const canvas = new OffscreenCanvas(mw, mh);
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(data, mw, mh), 0, 0);

  // Knob presets keep their final oversampled map (6x currently), but can
  // render internally at an even higher raster size and smooth down to that
  // final oversampled target for actual SSAA edge averaging.
  if (needsDownscale) {
    const finalCanvas = new OffscreenCanvas(outW, outH);
    const finalCtx = finalCanvas.getContext("2d")!;
    finalCtx.imageSmoothingEnabled = true;
    finalCtx.imageSmoothingQuality = "high";
    finalCtx.drawImage(canvas, 0, 0, outW, outH);
    return { blob: await encodeCanvas(finalCanvas), padX, padY };
  }

  return { blob: await encodeCanvas(canvas), padX, padY };
}

self.onmessage = async (e: MessageEvent<MapRequest>) => {
  try {
    const { blob, padX, padY } = await buildMapBlob(e.data);
    const resp: MapResponse = { id: e.data.id, blob, padX, padY };
    (self as unknown as Worker).postMessage(resp);
  } catch (err) {
    // If the worker fails (unlikely — pure math + OffscreenCanvas), the
    // main thread's pending request will time out and the element keeps
    // its CSS fallback blur.
    console.error("[lg-worker] map build failed:", err);
  }
};