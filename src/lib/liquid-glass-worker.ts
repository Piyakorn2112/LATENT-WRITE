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

// Map resolution.
// Small elements (shorter side ≤ MAP_DIVISOR_BREAK) keep divisor=7 for full
// bezel fidelity. Large elements raise to 9 — the SDF gradient is smooth
// enough at that scale that the coarser map is imperceptible (~23% fewer
// worker pixels).
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

function sdRoundedBox(px: number, py: number, bx: number, by: number, r: number): number {
  const qx = Math.abs(px) - (bx - r);
  const qy = Math.abs(py) - (by - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
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
function sdRoundedBoxSmooth(px: number, py: number, bx: number, by: number, r: number): number {
  const qx = Math.abs(px) - (bx - r);
  const qy = Math.abs(py) - (by - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const d = Math.max(GRAD_K - Math.abs(qx - qy), 0) / GRAD_K;
  const inside = Math.min(Math.max(qx, qy) + d * d * GRAD_K * 0.25, 0);
  return outside + inside - r;
}

function sdfGrad(
  px: number, py: number, bx: number, by: number, r: number,
): [number, number] {
  const eps = 0.5;
  const d = sdRoundedBoxSmooth(px, py, bx, by, r);
  const gx = sdRoundedBoxSmooth(px + eps, py, bx, by, r) - d;
  const gy = sdRoundedBoxSmooth(px, py + eps, bx, by, r) - d;
  const len = Math.hypot(gx, gy);
  if (len < 1e-6) return [0, 0];
  return [gx / len, gy / len];
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

async function encodeCanvas(canvas: OffscreenCanvas): Promise<Blob> {
  return await canvas.convertToBlob({ type: "image/webp", quality: 1.0 });
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

async function buildMapBlob(req: MapRequest): Promise<Blob> {
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

  const canvas = new OffscreenCanvas(mw, mh);
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(mw, mh);
  const data = img.data;

  // Pre-fill: neutral displacement (RG=128) + mask baseline in B. The mask
  // baseline EXTENDS past the rounded shape into the overflow margin and the
  // bounding-box corners — so when the SVG's bilinear sampling lands on the
  // rim it averages two equally-high mask values, not one high + one zero.
  // The visible rim stays at full blur intensity instead of bleeding sharp
  // pixels in from outside.
  const baselineMask = ((BLUR_EDGE_MIN * 255 + 0.5) | 0);
  for (let i = 0; i < mw * mh; i++) {
    const b = i * 4;
    data[b] = 128;
    data[b + 1] = 128;
    data[b + 2] = baselineMask;
    data[b + 3] = 255;
  }

  const elemPixels = mwElem * mhElem;
  const raw = new Float32Array(elemPixels * 2);
  const maskBuf = new Uint8ClampedArray(elemPixels);
  // Seed the per-element mask buffer with the same baseline; pixels outside
  // the rounded rect (bounding-box corners) hit `continue` and inherit it.
  maskBuf.fill(baselineMask);

  let maxMag = 0;

  for (let py = 0; py < mhElem; py++) {
    const ey = (py + 0.5) * syInv;
    const py_rel = ey - halfH;
    for (let px = 0; px < mwElem; px++) {
      const ex = (px + 0.5) * sxInv;
      const px_rel = ex - halfW;

      const sdf = sdRoundedBox(px_rel, py_rel, halfW, halfH, r);
      const distToEdge = -sdf;
      const i = py * mwElem + px;
      const idx = i * 2;

      const edgeCoverage = edgeAaWidth > 0
        ? clamp01(0.5 + distToEdge / edgeAaWidth)
        : distToEdge > 0 ? 1 : 0;

      if (edgeCoverage <= 0) continue;

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
      maskBuf[i] = baselineMask + (targetMask - baselineMask) * edgeCoverage + 0.5;

      const bezelCoverage = edgeAaWidth > 0
        ? clamp01(0.5 + (bezel - distToEdge) / edgeAaWidth)
        : distToEdge < bezel ? 1 : 0;
      const dispCoverage = Math.min(edgeCoverage, bezelCoverage);

      if (dispCoverage <= 0) continue;

      // ── Single-computation Snell + directional projection ────────────────
      // One scalar displacement from the bezel profile at the SDF distance,
      // projected onto X/Y via the finite-difference SDF gradient. Gives
      // uniform refraction strength at any given distance from the edge —
      // identical on straight edges and corners.
      const t = Math.min(Math.max(distToEdge, 0), bezel) / bezel;
      const slope = Math.min(dh(t), 5.0);
      const disp = snellDisp(slope, eta);

      if (disp < 1e-6) continue;

      const [gx, gy] = sdfGrad(px_rel, py_rel, halfW, halfH, r);
      const dx = -gx * disp * dispCoverage;
      const dy = -gy * disp * dispCoverage;

      raw[idx]     = dx;
      raw[idx + 1] = dy;

      const mag = Math.hypot(dx, dy);
      if (mag > maxMag) maxMag = mag;
    }
  }

  // Magnitude normalisation: both channels share the same scale so
  // displacement strength is uniform around the entire perimeter.
  const norm = maxMag > 0 ? maxMag : 1;

  for (let py = 0; py < mhElem; py++) {
    for (let px = 0; px < mwElem; px++) {
      const i = py * mwElem + px;
      const cx = px + ovX;
      const cy = py + ovY;
      const b = (cy * mw + cx) * 4;
      data[b]     = (128 + (raw[i * 2]     / norm) * 127 * channelGain + 0.5) | 0;
      data[b + 1] = (128 + (raw[i * 2 + 1] / norm) * 127 * channelGain + 0.5) | 0;
      data[b + 2] = maskBuf[i];
      data[b + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);

  // Knob presets keep their final oversampled map (6x currently), but can
  // render internally at an even higher raster size and smooth down to that
  // final oversampled target for actual SSAA edge averaging.
  if (renderOversample > mapOversample + 0.01) {
    const finalCanvas = new OffscreenCanvas(outputSize.width, outputSize.height);
    const finalCtx = finalCanvas.getContext("2d")!;
    finalCtx.imageSmoothingEnabled = true;
    finalCtx.imageSmoothingQuality = "high";
    finalCtx.drawImage(canvas, 0, 0, outputSize.width, outputSize.height);
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