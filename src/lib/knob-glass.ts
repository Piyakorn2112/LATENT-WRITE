/**
 * knob-glass.ts — the SVG displacement-map engine for knob-shaped presets.
 *
 * ★ THE APP NO LONGER PAINTS ITS KNOBS THROUGH THIS. GlassToggle and
 * GlassRange render `KnobGlass`, which evaluates the same optics PER PIXEL IN
 * FLOAT on a canvas (src/lib/knob-glass-paint.ts) — because every artifact
 * these knobs ever showed (folds, combs, banding, 1-LSB asymmetries) came
 * from the 8-bit map and the compositor's gather, not from the optics. This
 * module remains as the reference implementation and is still exercised by
 * the dev bench/diagnostic pages (glass-gpu-bench, glass-direction), which
 * render knob-sized specs against the SVG chain.
 *
 * ─── WHY THE KNOBS GET THEIR OWN ENGINE ──────────────────────────────────────
 *
 * `liquid-glass-worker.ts` is a general rounded-rectangle engine: it has to
 * serve a 1100×44 toolbar, a 900×700 panel and a 20×14 knob from one routine,
 * so it carries machinery that exists ONLY for the big shapes:
 *
 *   · a SMOOTH-MAX SDF variant (`GRAD_K = 40`) whose whole purpose is to hide
 *     the gradient discontinuity that a large rectangle with a small corner
 *     radius shows along its 45° diagonal;
 *   · a THREE-PROBE FINITE-DIFFERENCE gradient (3 extra SDF evaluations plus a
 *     hypot per pixel) to find the surface normal numerically.
 *
 * A knob is a PILL — `border-radius: 999px`, so `r === min(halfW, halfH)`. It
 * has no straight-edge/corner seam to hide, and its normal is available in
 * CLOSED FORM. On a 32×24 knob the 40-element-pixel smoothing band is WIDER
 * THAN THE KNOB, so the seam-hiding blend is active over the entire shape and
 * perturbs a normal that was exact to begin with.
 *
 * ─── THE METHOD, FROM THE STM ABOUT-PAGE HERO ────────────────────────────────
 *
 * The /about hero (`stm-page` GlassBars) renders its glass stripes as
 * "analytic infinite bands (rotated half-plane pairs) — exact SDF + constant
 * normal per side, no corners at all", and refracts with the SAME physics this
 * engine uses (squircle height profile → Snell, air→glass η = 1/1.5). Its
 * lesson is the one applied here: WHEN THE SHAPE IS ANALYTIC, SOLVE IT
 * ANALYTICALLY — do not sample a numerical gradient of a shape whose normal
 * you can write down.
 *
 * The companion lesson comes from the same family (`EventOrbit/glassRefract`):
 * for a shape whose displacement depends on ONE scalar, the profile collapses
 * to a 1-D lookup table computed once, not `pow()` calls per pixel.
 *
 * So this engine is:
 *   1. EXACT capsule SDF and EXACT outward normal — no probes, no smooth-max.
 *   2. A 1-D displacement LUT over `distToEdge / bezel`, built once per module
 *      load and shared by every knob (the profile is shape-independent).
 *   3. Authored at the density the knob is actually DISPLAYED at, which for a
 *      knob means AT FULL PRESS — see `displayScale`.
 *
 * ─── WHY DISPLAY DENSITY IS THE PRODUCT FIX ──────────────────────────────────
 *
 * The knob only wears its glass WHILE PRESSED (GlassToggle/GlassRange attach
 * `liquid-glass-control-knob` for the press and its settle), and the press is
 * exactly when CSS scales it to 2×. The map was authored from the LAYOUT box,
 * which `transform: scale()` never changes, so at the moment the knob is
 * biggest and most looked-at, a 32×24-authored map was magnified across a
 * 64×48 knob — measured and recorded by `scripts/verify-toggle-press.cjs` as
 * "material is STRETCHED over the swell".
 *
 * `displayScale` multiplies the OUTPUT density only. The internal render
 * resolution (SSAA) is unchanged, so this costs no extra CPU per pixel and no
 * extra GPU except the texels that were missing. It does NOT undo the
 * approved 12 → 3 density cut: 3 texels per LAYOUT pixel is 1.5 per DISPLAYED
 * pixel at full press, and this restores the intended 3 where it is seen.
 */

/** Air → glass. */
const N1 = 1;
const N2 = 1.5;

export type KnobPreset = "control-knob" | "toggle-control-knob";

/** Displacement packed into the R/G channels, per preset. Unchanged. */
const CHANNEL_GAIN: Record<KnobPreset, number> = {
  "control-knob": 0.35,
  "toggle-control-knob": 0.24,
};

/** Edge antialias span, in map texels. Unchanged. */
const EDGE_AA_SPAN: Record<KnobPreset, number> = {
  "control-knob": 1.25,
  "toggle-control-knob": 1.1,
};

/**
 * Output texels per ELEMENT pixel. 3 is the approved value (12 → 3 cost two
 * knobs 13.3 ms/frame → 0.4 on an M1 Pro); `displayScale` then puts those 3
 * texels per DISPLAYED pixel rather than per layout pixel.
 */
const MAP_OVERSAMPLE = 3;
/** Internal render density, averaged down to the output. Real SSAA. */
const MAP_RENDER_OVERSAMPLE = 16;

const BEZEL_PX = 120;
const BLUR_EDGE_MIN = 0.85;
const BLUR_TRANSITION_PCT = 0.25;
const BLUR_EXP = 2;
const MAP_DIVISOR = 1;
const RADIUS_FLOOR = 1;

/**
 * Convex squircle bezel profile, h(t) = (1 − (1 − t)⁴)^¼ — steepest at the rim,
 * flat inside. Identical to the general engine's; the harness asserts that.
 */
function h(t: number): number {
  return (1 - (1 - t) ** 4) ** 0.25;
}
function dh(t: number): number {
  const dt = 5e-4;
  return (h(Math.min(t + dt, 1)) - h(Math.max(t - dt, 0))) / (2 * dt);
}

/**
 * Snell's-law lateral displacement for a convex surface profile. Returns a
 * positive scalar; the caller projects it onto X/Y with the surface normal.
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

/**
 * ★ THE FOLD-FREE FALLOFF — the shape of the pull across the bezel, and the
 * fix for the reported banding stripes.
 *
 * `feDisplacementMap` GATHERS: `out(P) = backdrop(P + disp(P))`. The backdrop
 * is BENT only while the sampling position keeps increasing —
 * `d/dy [ y + disp(y) ] > 0`. Writing the pull as `disp(d) = A · g(d/bezel)`:
 *
 *      A · max|g′| ≤ bezel
 *
 * The squircle→Snell profile fails that badly on a knob. Its slope is clamped
 * at 5 right at the rim and collapses within ~10% of the bezel, so max|g′| is
 * an order of magnitude past 1. Measured on the SHIPPED knob map with that
 * profile: 1228 of 6580 interior texels sample BACKWARDS — 19% of the knob —
 * evenly split top/bottom/left/right, with the sampling running to −0.88×
 * normal at the rim. Backwards sampling re-reads backdrop it has already
 * read, mirrored and compressed; over the toggle track's hard edge that is a
 * comb of stripes, and magnified 2× by the press it is impossible to miss.
 *
 * ★ THE FIX IS THE SHAPE, NOT THE STRENGTH — a FLATTER falloff lets the SAME
 * pull stay fold-free. This is the smoothstep complement g(t) = (1−t)²(1+2t):
 * g(0)=1, g(1)=0, zero slope at both ends, max|g′| = 1.5 exactly (at t = ½).
 * The budget is then bezel/1.5 = 6.4px for the 32×24 knob against the 4.78px
 * it asks for — the same rim strength it has today, with no fold at all.
 *
 * ★ AND "0 FOLDS" MEASURED AFTER A FIX IS NOT EVIDENCE THE FIX WAS
 * UNNECESSARY. This profile was reverted once mid-investigation on exactly
 * that reasoning: the fold count read 0, so the change looked unjustified —
 * but the 0 was there BECAUSE of it. Restoring the old profile put 1228 folds
 * straight back. Re-measure the ORIGINAL, not the patched, before concluding
 * a change did nothing.
 */
const MAX_G_SLOPE = 1.5;

/** Bounded-derivative falloff: 1 at the rim → 0 at the bezel depth. */
function falloff(t: number): number {
  const u = 1 - t;
  return u * u * (1 + 2 * t);
}

/** The rim magnitude, straight from the physics — the squircle's steepest
 *  slope refracted through Snell. Unchanged; only the decay inward is
 *  reshaped, so the glass bends exactly as hard at its edge as before. */
const RIM_DISP = snellDisp(Math.min(dh(0), 5.0), N1 / N2);

/**
 * ★ THE 1-D PROFILE LUT. `disp` is a pure function of t = distToEdge / bezel,
 * so it is the same curve for every knob at every size — built once, here, and
 * read with linear interpolation instead of two `pow()` calls per pixel.
 *
 * 4096 samples, linearly interpolated. Measured against the exact per-pixel
 * math it replaces: 1.6x faster on the range knob, 2.5x on the toggle knob.
 *
 * ★ IT IS NOT BIT-EXACT, AND IT CANNOT BE — that claim was written here first
 * and the fuzz refuted it. The output is quantised with `(… + 0.5) | 0`, so a
 * value sitting exactly on a rounding boundary flips under ANY perturbation,
 * however small; no table resolution removes that. What is TRUE is measured
 * and bounded: 8 texels of 2,396,160 on the worst fuzzed geometry, always by
 * a single LSB, i.e. 1/255 of a displacement channel that is itself packed at
 * a gain of 0.24-0.35. `scripts/test-knob-glass.ts` gates that bound rather
 * than asserting an equality that does not hold.
 */
const LUT_N = 4096;
const DISP_LUT = (() => {
  const lut = new Float64Array(LUT_N + 1);
  for (let i = 0; i <= LUT_N; i++) lut[i] = RIM_DISP * falloff(i / LUT_N);
  return lut;
})();

function dispAt(t: number): number {
  if (t <= 0) return DISP_LUT[0];
  if (t >= 1) return DISP_LUT[LUT_N];
  const x = t * LUT_N;
  const i = x | 0;
  const f = x - i;
  return DISP_LUT[i] + (DISP_LUT[i + 1] - DISP_LUT[i]) * f;
}

/** Exact math, for the harness to compare the LUT against. */
export function dispExact(t: number): number {
  return RIM_DISP * falloff(Math.min(Math.max(t, 0), 1));
}

/** The fold-free budget for a given bezel: the largest peak pull that cannot
 *  tear the backdrop with this profile. Exported so the harness derives it
 *  rather than trusting a number here. */
export function foldFreeBudget(bezelPx: number): number {
  return bezelPx / MAX_G_SLOPE;
}

/**
 * ★ THE MAP'S USEFUL DENSITY IS CAPPED BY THE 8-BIT CHANNEL, not by how big
 * the element is drawn. This is the whole finding of the banding
 * investigation, so it lives next to the arithmetic that causes it.
 *
 * A displacement byte moves the sample by `dispPx/255` element px — 0.157px
 * at DISP_PX 40. A texel advances `1/density` element px. The map can only
 * change in WHOLE bytes, so what a texel does is quantised:
 *
 *   density 3  → advance 0.333px ≈ 2 LSB → the usual step is 1 of 2 → the
 *                sampling advances ~0.53x, smoothly, everywhere.
 *   density 6  → advance 0.167px ≈ 1 LSB → each texel either steps a whole
 *                LSB (advance 0.06x, a STALL) or none (advance 1.0x). The
 *                band alternates stall/advance — measured 56% stalled — and
 *                that alternation is a COMB. Over a hard backdrop edge,
 *                magnified 2x by the press, it reads as banding stripes.
 *
 * So the ceiling is where one texel is worth about two bytes:
 *
 *      density ≤ 255 / (2 · dispPx)      = 3.19 at DISP_PX 40
 *
 * Authoring "at display density" — which is what the press-scale change did —
 * is the right instinct for a colour texture and the WRONG one for a
 * quantised vector field: past this ceiling there is no more information to
 * carry, and the extra texels can only stair-step. If a sharper pressed knob
 * is ever wanted, the lever is a finer encoding (a second channel for the low
 * byte) or a smaller DISP_PX — never more texels.
 */
export function maxUsefulDensity(dispPx: number): number {
  return 255 / (2 * dispPx);
}

function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

export interface KnobMapRequest {
  elemW: number;
  elemH: number;
  radius: number;
  overflow: number;
  preset: KnobPreset;
  bezel?: number | null;
  /**
   * How much bigger than its layout box the knob is DISPLAYED at when the
   * glass is on. 2 for both knobs — the pressed CSS rule scales them to
   * `scale(2)`, and the glass class is only ever attached during that press.
   */
  displayScale?: number;
  /** Element px of neutral margin to bake in (the rest is an feFlood). */
  mapPad?: number | null;
  /**
   * The filter's `feDisplacementMap` scale (DISP_PX in liquid-glass-filter).
   * The engine needs it to know how many ELEMENT PIXELS its packed bytes will
   * become, which is what the fold-free budget is measured in.
   */
  dispPx?: number;
}

export interface KnobMapPixels {
  /** 1 when the requested pull fit the fold-free budget; below 1 when it had
   *  to be scaled to keep the backdrop from tearing. */
  foldFreeClamp: number;
  /** Texels per element pixel this map was authored at — the caller and the
   *  harness both need it to check the quantisation ceiling. */
  density: number;
  data: Uint8ClampedArray<ArrayBuffer>;
  mw: number;
  mh: number;
  outW: number;
  outH: number;
  needsDownscale: boolean;
  padX: number;
  padY: number;
}

function computeMapSize(
  elemW: number, elemH: number, overflow: number, divisor: number, oversample: number,
) {
  const elemWidth = Math.max(8, Math.round((elemW * oversample) / divisor));
  const elemHeight = Math.max(8, Math.round((elemH * oversample) / divisor));
  const overflowX = Math.max(1, Math.round((overflow * elemWidth) / elemW));
  const overflowY = Math.max(1, Math.round((overflow * elemHeight) / elemH));
  return {
    elemWidth, elemHeight, overflowX, overflowY,
    width: elemWidth + 2 * overflowX,
    height: elemHeight + 2 * overflowY,
  };
}

/**
 * Only shrink the baked margin when the map's texels-per-element-pixel is
 * EXACTLY the element scale on both axes — <feImage> stretches the map onto
 * its rect, so a changed scale would resample the refraction. (Same guard, and
 * same reason, as the general engine.)
 */
function resolveMapPad(
  elemW: number, elemH: number, overflow: number,
  divisor: number, mapOversample: number, requested: number | null | undefined,
): number {
  if (requested == null || !(requested < overflow)) return overflow;
  const full = computeMapSize(elemW, elemH, overflow, divisor, mapOversample);
  if (full.width / (elemW + 2 * overflow) !== full.elemWidth / elemW) return overflow;
  if (full.height / (elemH + 2 * overflow) !== full.elemHeight / elemH) return overflow;
  const small = computeMapSize(elemW, elemH, requested, divisor, mapOversample);
  if ((small.overflowX * elemW) / small.elemWidth !== requested) return overflow;
  if ((small.overflowY * elemH) / small.elemHeight !== requested) return overflow;
  return requested;
}

/**
 * Build a knob's displacement map.
 *
 * `useLut = false` runs the identical geometry with the exact per-pixel
 * profile instead of the table — the harness uses it to prove the LUT is
 * byte-invisible, and nothing else should.
 */
export function buildKnobMapPixels(req: KnobMapRequest, useLut = true): KnobMapPixels {
  const { elemW, elemH, radius, overflow, preset } = req;
  const channelGain = CHANNEL_GAIN[preset];
  const displayScale = Math.max(1, req.displayScale ?? 1);

  // ★ Density is authored per DISPLAYED pixel. The internal render density is
  // untouched, so this buys resolution where the knob is actually seen without
  // spending another SSAA pass.
  // ★ Density is requested by the caller but CAPPED here — see
  // maxUsefulDensity. A caller asking for press density gets it only as far
  // as the 8-bit channel can carry it.
  const ceiling = maxUsefulDensity(req.dispPx ?? 40);
  const mapOversample = Math.min(MAP_OVERSAMPLE * displayScale, Math.max(1, Math.floor(ceiling)));
  // ★ THE SSAA RATIO MUST BE A WHOLE NUMBER.
  //
  // Render 16 → output 6 is a ratio of 2.667, so each output texel averages a
  // different number of render texels (2,3,3,2,3,3…) and that pattern does not
  // mirror about the element's centre. Measured on the shipped map: the top
  // rim's transition began ONE TEXEL EARLIER than the bottom's (G = 158 at the
  // top edge where the bottom still read 128), while the rest of the field was
  // perfectly odd-symmetric. At the rim the profile moves 30 bytes in a single
  // texel, so that one-texel phase slip is a third of a displayed pixel of
  // refraction — the top and bottom edges blending unequally, which is exactly
  // what was reported.
  //
  // An integer ratio makes the downscale a symmetric box average, so whatever
  // the top rim gets, the bottom rim gets. Pick the whole multiple closest to
  // the SSAA target rather than the target itself.
  const ssaaSteps = Math.max(1, Math.round(MAP_RENDER_OVERSAMPLE / mapOversample));
  const renderOversample = mapOversample * ssaaSteps;

  const pad = resolveMapPad(elemW, elemH, overflow, MAP_DIVISOR, mapOversample, req.mapPad);
  const renderSize = computeMapSize(elemW, elemH, pad, MAP_DIVISOR, renderOversample);
  const outputSize = computeMapSize(elemW, elemH, pad, MAP_DIVISOR, mapOversample);

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
  // The straight run of the capsule, per axis. For a true pill one of these is
  // exactly 0 — which is what makes the normal exact almost everywhere.
  const flatX = halfW - r;
  const flatY = halfH - r;

  const bezel = Math.min(req.bezel ?? BEZEL_PX, halfShorter * 0.8);

  // ── THE AMPLITUDE CLAMP, and it is not decoration.
  //
  // The packed byte becomes `dispPx · (byte/255 − 0.5)` element px, so this
  // map's peak pull is `dispPx · 127 · gain / 255`. Fold-free needs it inside
  // foldFreeBudget(bezel). Measured: the 32x24 toggle knob asks 4.78px of a
  // 6.40px budget and passes untouched; the 20x14 RANGE knob asks 6.97px of
  // 3.73px — it wants to bend the backdrop further than its own lens is
  // thick, which cannot be done without the backdrop tearing. Its pull is
  // scaled to fit (about half) rather than shipped as a comb of stripes.
  const dispPx2 = req.dispPx ?? 40;
  const peakPx = (dispPx2 * 127 * channelGain) / 255;
  const budgetPx = foldFreeBudget(bezel);
  const foldFreeClamp = peakPx > budgetPx ? budgetPx / peakPx : 1;


  const blurRimEnd = Math.max(1, Math.min(halfShorter * BLUR_TRANSITION_PCT, halfShorter));

  const sxInv = elemW / mwElem;
  const syInv = elemH / mhElem;
  const edgeAaWidth = EDGE_AA_SPAN[preset] * Math.max(sxInv, syInv);

  const data = new Uint8ClampedArray(new ArrayBuffer(mw * mh * 4));
  const baselineMask = (BLUR_EDGE_MIN * 255 + 0.5) | 0;

  // Prefill as one 32-bit word per pixel (endian-agnostic: seed pixel 0 first).
  data[0] = 128; data[1] = 128; data[2] = baselineMask; data[3] = 255;
  const words = new Uint32Array(data.buffer);
  words.fill(words[0]);

  const elemPixels = mwElem * mhElem;
  const raw = new Float32Array(elemPixels * 2);
  const maskBuf = new Uint8ClampedArray(elemPixels);
  maskBuf.fill(baselineMask);

  let maxMag = 0;

  for (let py = 0; py < mhElem; py++) {
    const ey = (py + 0.5) * syInv;
    const yRel = ey - halfH;
    const ay = Math.abs(yRel) - flatY;
    const cy = ay > 0 ? ay : 0;
    const sy = yRel < 0 ? -1 : 1;

    for (let px = 0; px < mwElem; px++) {
      const ex = (px + 0.5) * sxInv;
      const xRel = ex - halfW;
      const ax = Math.abs(xRel) - flatX;
      const cx = ax > 0 ? ax : 0;

      // ── EXACT capsule SDF. Identical arithmetic to the general engine's
      //    sharp SDF, so the DISTANCE — and everything the look derives from
      //    it — is unchanged; only the normal below is solved rather than
      //    probed.
      const outside = cx === 0 ? cy : cy === 0 ? cx : Math.hypot(cx, cy);
      const inside = Math.min(Math.max(ax, ay), 0);
      const distToEdge = -(outside + inside - r);

      const i = py * mwElem + px;

      const edgeCoverage = edgeAaWidth > 0
        ? clamp01(0.5 + distToEdge / edgeAaWidth)
        : distToEdge > 0 ? 1 : 0;
      if (edgeCoverage <= 0) continue;

      // ── Progressive blur mask (unchanged).
      const maskDist = distToEdge > 0 ? distToEdge : 0;
      let targetMask = baselineMask;
      if (maskDist >= blurRimEnd) {
        targetMask = 255;
      } else {
        const t0 = blurRimEnd > 0 ? maskDist / blurRimEnd : 1;
        const eased = clamp01(t0) ** BLUR_EXP;
        targetMask = (BLUR_EDGE_MIN + (1 - BLUR_EDGE_MIN) * eased) * 255 + 0.5;
      }
      maskBuf[i] = baselineMask + (targetMask - baselineMask) * edgeCoverage + 0.5;

      const bezelCoverage = edgeAaWidth > 0
        ? clamp01(0.5 + (bezel - distToEdge) / edgeAaWidth)
        : distToEdge < bezel ? 1 : 0;
      const dispCoverage = Math.min(edgeCoverage, bezelCoverage);
      if (dispCoverage <= 0) continue;

      const t = Math.min(Math.max(distToEdge, 0), bezel) / bezel;
      const disp = useLut ? dispAt(t) : dispExact(t);
      if (disp < 1e-6) continue;

      // ── ★ EXACT OUTWARD NORMAL, no probes.
      //    On the rounded run the nearest surface point is on the corner arc,
      //    so the normal is the normalised (cx, cy) carrying the pixel's
      //    signs. On a straight run one component is exactly 0, giving an
      //    exactly axis-aligned normal — the same answer the three-probe
      //    finite difference converges to, without the probes and without the
      //    smooth-max blend that a knob never needed.
      let nx: number;
      let ny: number;
      if (cx > 0 || cy > 0) {
        const len = cx === 0 ? cy : cy === 0 ? cx : Math.hypot(cx, cy);
        nx = (xRel < 0 ? -cx : cx) / len;
        ny = (cy * sy) / len;
      } else {
        // Deep interior: the nearest edge is the one whose q is larger.
        if (ax > ay) { nx = xRel < 0 ? -1 : 1; ny = 0; }
        else { nx = 0; ny = sy; }
      }

      const dx = -nx * disp * dispCoverage;
      const dy = -ny * disp * dispCoverage;
      const idx = i * 2;
      raw[idx] = dx;
      raw[idx + 1] = dy;

      const mag = dx === 0 ? Math.abs(dy) : dy === 0 ? Math.abs(dx) : Math.hypot(dx, dy);
      if (mag > maxMag) maxMag = mag;
    }
  }

  // Both channels share one scale, so refraction strength is uniform around
  // the whole perimeter.
  const norm = maxMag > 0 ? maxMag : 1;

  for (let py = 0; py < mhElem; py++) {
    for (let px = 0; px < mwElem; px++) {
      const i = py * mwElem + px;
      const rx = raw[i * 2];
      const ry = raw[i * 2 + 1];
      const mask = maskBuf[i];
      // Untouched pixels already carry the prefill exactly.
      if (rx === 0 && ry === 0 && mask === baselineMask) continue;
      const b = ((py + ovY) * mw + (px + ovX)) * 4;
      // ★ SYMMETRIC ROUNDING. `(128 + v + 0.5) | 0` floors, which rounds +v
      // up and −v down — so a displacement of +0.5 and one of −0.5 land on
      // bytes 129 and 128, not 129 and 127. That is a 1-LSB (dispPx/255 =
      // 0.157px) bias between the top half of the knob and the bottom, and it
      // showed up as the top and bottom rims blending unequally. Rounding
      // away from zero keeps the field exactly odd about the centre.
      const vx = (rx / norm) * 127 * channelGain * foldFreeClamp;
      const vy = (ry / norm) * 127 * channelGain * foldFreeClamp;
      data[b] = 128 + (vx < 0 ? -Math.round(-vx) : Math.round(vx));
      data[b + 1] = 128 + (vy < 0 ? -Math.round(-vy) : Math.round(vy));
      data[b + 2] = mask;
      data[b + 3] = 255;
    }
  }

  return {
    foldFreeClamp,
    density: mapOversample,
    data,
    mw,
    mh,
    outW: outputSize.width,
    outH: outputSize.height,
    needsDownscale: renderOversample > mapOversample + 0.01,
    padX: pad === overflow ? overflow : (outputSize.overflowX * elemW) / outputSize.elemWidth,
    padY: pad === overflow ? overflow : (outputSize.overflowY * elemH) / outputSize.elemHeight,
  };
}
