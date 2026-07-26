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
const MAP_OVERSAMPLE: Record<MapPreset, number> = {
  default: 1,
  "control-knob": 12,
  "toggle-control-knob": 12,
};
const MAP_RENDER_OVERSAMPLE: Record<MapPreset, number> = {
  default: 1,
  "control-knob": 16,
  "toggle-control-knob": 16,
};

// Visual bezel thickness in element pixels (must match main-thread filter).
const BEZEL_PX = 120;

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
  eta: number,
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
  const t = Math.min(Math.max(distToEdge, 0), bezel) / bezel;
  const slope = Math.min(dh(t), 5.0);
  const disp = snellDisp(slope, eta);

  if (disp < 1e-6) {
    S_flag = S_MASK_ONLY;
    return;
  }

  S_flag = S_FULL;
  S_disp = disp;
  S_cov = dispCoverage;
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
}

interface MapResponse {
  id: string;
  blob: Blob;
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
}

/**
 * Pure per-pixel map computation — no canvas, no encode. Exported so the
 * zero-visual-change harness can byte-compare it against the frozen baseline
 * (scratchpad/lg-verify.ts) in Node.
 */
export function buildMapPixels(req: MapRequest): MapPixels {
  const { elemW, elemH, radius, overflow } = req;
  const preset = req.preset === "toggle-control-knob"
    ? "toggle-control-knob"
    : req.preset === "control-knob"
      ? "control-knob"
      : "default";
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
  const renderSize = computeMapSize(elemW, elemH, overflow, divisor, renderOversample);
  const outputSize = computeMapSize(elemW, elemH, overflow, divisor, mapOversample);
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

  const bezel = Math.min(req.bezel ?? BEZEL_PX, halfShorter * 0.8);
  // Ramp goes from the actual rim (distToEdge = 0) up to blurRimEnd. Within
  // that band, mask starts at BLUR_EDGE_MIN (so the very edge is already
  // partly blurred — no sharp band) and rises to 1 (full blur).
  const blurRimEnd = Math.max(1, Math.min(halfShorter * BLUR_TRANSITION_PCT, halfShorter));

  const sxInv = elemW / mwElem;
  const syInv = elemH / mhElem;
  const eta = N1 / N2;
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
  // q values for each pixel centre, plus the +GRAD_EPS gradient probe. These
  // are exactly the values sdRoundedBox/sdRoundedBoxSmooth used to recompute
  // per pixel (same expressions, same order), so every consumer below sees
  // identical floats — but the abs/subtract now runs O(w + h) times.
  const insetX = halfW - r;
  const insetY = halfH - r;

  const QX = new Float64Array(mwElem);
  const QXE = new Float64Array(mwElem);
  for (let px = 0; px < mwElem; px++) {
    const px_rel = (px + 0.5) * sxInv - halfW;
    QX[px] = Math.abs(px_rel) - insetX;
    QXE[px] = Math.abs(px_rel + GRAD_EPS) - insetX;
  }
  const QY = new Float64Array(mhElem);
  const QYE = new Float64Array(mhElem);
  for (let py = 0; py < mhElem; py++) {
    const py_rel = (py + 0.5) * syInv - halfH;
    QY[py] = Math.abs(py_rel) - insetY;
    QYE[py] = Math.abs(py_rel + GRAD_EPS) - insetY;
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
    scalarsFor(r - qx, edgeAaWidth, baselineMask, blurRimEnd, bezel, eta);
    colFlag[px] = S_flag;
    colMask[px] = S_mask;
    colDisp[px] = S_disp;
    colCov[px] = S_cov;
    // Where this column leads, sd = qx − r and sd(probe) = qxe − r, so
    // gy is exactly 0 and the normalised gx is exactly ±1 (or 0,0 when the
    // original's length guard trips).
    const g = (QXE[px] - r) - (qx - r);
    colGx[px] = Math.abs(g) < 1e-6 ? 0 : g < 0 ? -1 : 1;
  }

  const rowFlag = new Uint8Array(mhElem);
  const rowMask = new Uint8ClampedArray(mhElem);
  const rowDisp = new Float64Array(mhElem);
  const rowCov = new Float64Array(mhElem);
  const rowGy = new Float64Array(mhElem);
  for (let py = 0; py < mhElem; py++) {
    const qy = QY[py];
    scalarsFor(r - qy, edgeAaWidth, baselineMask, blurRimEnd, bezel, eta);
    rowFlag[py] = S_flag;
    rowMask[py] = S_mask;
    rowDisp[py] = S_disp;
    rowCov[py] = S_cov;
    const g = (QYE[py] - r) - (qy - r);
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
    const qye = QYE[py];
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
        scalarsFor(-sdSharpQ(qx, qy, r), edgeAaWidth, baselineMask, blurRimEnd, bezel, eta);
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
        const d0 = sdSmoothQ(qx, qy, r);
        const rawGx = sdSmoothQ(QXE[px], qy, r) - d0;
        const rawGy = sdSmoothQ(qx, qye, r) - d0;
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
      data[b]     = (128 + (rx / norm) * 127 * channelGain + 0.5) | 0;
      data[b + 1] = (128 + (ry / norm) * 127 * channelGain + 0.5) | 0;
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
  };
}

async function buildMapBlob(req: MapRequest): Promise<Blob> {
  const { data, mw, mh, outW, outH, needsDownscale } = buildMapPixels(req);

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
    return await encodeCanvas(finalCanvas);
  }

  return await encodeCanvas(canvas);
}

self.onmessage = async (e: MessageEvent<MapRequest>) => {
  try {
    const blob = await buildMapBlob(e.data);
    const resp: MapResponse = { id: e.data.id, blob };
    (self as unknown as Worker).postMessage(resp);
  } catch (err) {
    // If the worker fails (unlikely — pure math + OffscreenCanvas), the
    // main thread's pending request will time out and the element keeps
    // its CSS fallback blur.
    console.error("[lg-worker] map build failed:", err);
  }
};