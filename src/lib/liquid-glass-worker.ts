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
 * ── Corner refraction fix ────────────────────────────────────────────────
 *
 * Previous approach: a single radial Snell computation driven by the SDF
 * outward-normal direction. At a 45° corner that direction is diagonal, so
 * each axis got only 1/√2 of the displacement a straight edge gets at the
 * same SDF distance. Background content was pulled *toward* the corner
 * centre (convergent / "squish").
 *
 * Current approach: *separable* displacement. The SDF outward-normal
 * direction (dirX, dirY) is used to project the bezel depth onto each axis
 * independently:
 *
 *   tX = distToEdge × |dirX| / bezel
 *   tY = distToEdge × |dirY| / bezel
 *
 * Snell's law is then run separately for X and Y. On straight edges one
 * component dominates (dirX≈1 or dirY≈1) and the result is identical to
 * the old code. At a 45° corner dirX = dirY = 0.707, so tX = tY =
 * 0.707 × t_sdf. Because 0.707 × t < t and dh is a decreasing function,
 * the slope *at the corner* is evaluated at a smaller t → it is larger,
 * not smaller, than the straight-edge slope at the same SDF distance. Both
 * dx and dy are now full-strength and applied simultaneously, producing the
 * divergent "bending-around" field that matches Apple's liquid glass look.
 *
 * Normalization is per-axis (separate maxMagX / maxMagY) so each channel
 * uses the full ±127 range independently, preserving the relative scale
 * between the two axes while letting corners reach maximum displacement in
 * both directions.
 */

// Air → glass.
const N1 = 1;
const N2 = 1.5;

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
const BLUR_EDGE_MIN = 0.9;
const BLUR_TRANSITION_PCT = 0.3;
const BLUR_EXP = 2;

// Map resolution.
const MAP_DIVISOR = 7;
const MAP_MAX = 170;

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

// Analytical outward unit normal of the rounded-box SDF at (px, py).
//   • Corner arc (qx > 0, qy > 0): radial unit vector from the corner-arc
//     centre — exact for the curved corners. Finite-difference gradients
//     alias here because at MAP_DIVISOR=4 the corner only spans 1–2 pixels.
//   • Straight-edge zone or interior: gradient aligns with the closer axis,
//     producing a pure horizontal/vertical normal with no subpixel noise.
const smootherstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

function sdRoundedBoxGrad(
  px: number, py: number, bx: number, by: number, r: number,
): [number, number] {
  const sx = px >= 0 ? 1 : -1;
  const sy = py >= 0 ? 1 : -1;

  const qx = Math.abs(px) - (bx - r);
  const qy = Math.abs(py) - (by - r);

  const blend = Math.max(1, r * 1);

  const cx = qx <= 0 ? 0 : qx >= blend ? qx : blend * smootherstep(0, blend, qx);
  const cy = qy <= 0 ? 0 : qy >= blend ? qy : blend * smootherstep(0, blend, qy);

  const len = Math.hypot(cx, cy);

  if (len < 1e-6) {
    return qx > qy ? [sx, 0] : [0, sy];
  }

  return [(sx * cx) / len, (sy * cy) / len];
}

/**
 * Run one axis of Snell's law for a surface whose outward normal is
 * (−slope × sign, 0, 1)/‖…‖ where sign is ±1 (the side of the element).
 *
 * Returns the displacement scalar dx (or dy). Zero if total internal
 * reflection would occur (shouldn't happen with N2 > N1 and slope ≤ 5).
 */
function snellAxis(slope: number, sign: number, eta: number): number {
  if (slope < 1e-3) return 0;
  const nLen = Math.hypot(slope, 1);
  const n_axis = (-slope * sign) / nLen; // outward-normal component along this axis
  const nZ    = 1 / nLen;
  const sinSq = eta * eta * (1 - nZ * nZ);
  if (sinSq >= 1) return 0; // total internal reflection — skip
  const k = eta * nZ - Math.sqrt(1 - sinSq);
  return k * n_axis;
}

interface MapRequest {
  id: string;
  elemW: number;
  elemH: number;
  radius: number;
  overflow: number;
}

interface MapResponse {
  id: string;
  blob: Blob;
}

async function buildMapBlob(req: MapRequest): Promise<Blob> {
  const { elemW, elemH, radius, overflow } = req;

  const mwElem = Math.max(8, Math.min(MAP_MAX, Math.round(elemW / MAP_DIVISOR)));
  const mhElem = Math.max(8, Math.min(MAP_MAX, Math.round(elemH / MAP_DIVISOR)));
  const ovX = Math.max(1, Math.round((overflow * mwElem) / elemW));
  const ovY = Math.max(1, Math.round((overflow * mhElem) / elemH));
  const mw = mwElem + 2 * ovX;
  const mh = mhElem + 2 * ovY;

  const halfW = elemW / 2;
  const halfH = elemH / 2;
  const halfShorter = Math.min(halfW, halfH);
  const r = Math.min(Math.max(radius, RADIUS_FLOOR), halfShorter);

  const bezel = Math.min(BEZEL_PX, halfShorter * 0.8);
  // Ramp goes from the actual rim (distToEdge = 0) up to blurRimEnd. Within
  // that band, mask starts at BLUR_EDGE_MIN (so the very edge is already
  // partly blurred — no sharp band) and rises to 1 (full blur).
  const blurRimEnd = Math.max(1, Math.min(halfShorter * BLUR_TRANSITION_PCT, halfShorter));

  const sxInv = elemW / mwElem;
  const syInv = elemH / mhElem;
  const eta = N1 / N2;

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

  // ── Per-axis max tracking for independent normalisation ──────────────────
  // Normalising each channel separately means both R and G use the full
  // ±127 range regardless of element aspect ratio. On straight edges this is
  // identical to magnitude normalisation (only one axis is nonzero). At
  // corners both axes are active and each reaches the same peak as a straight
  // edge → corners get full-strength displacement in X *and* Y simultaneously.
  let maxMagX = 0;
  let maxMagY = 0;

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

      if (distToEdge <= 0) continue;

      // ── Progressive blur mask (unchanged) ────────────────────────────────
      if (distToEdge >= blurRimEnd) {
        maskBuf[i] = 255;
      } else {
        const t = distToEdge / blurRimEnd;
        const eased = (t < 0 ? 0 : t > 1 ? 1 : t) ** BLUR_EXP;
        maskBuf[i] = (BLUR_EDGE_MIN + (1 - BLUR_EDGE_MIN) * eased) * 255 + 0.5;
      }

      if (distToEdge >= bezel) continue;

      // ── Analytical SDF gradient ──────────────────────────────────────────
      // dirX, dirY: outward unit normal of the rounded-rect SDF at this pixel.
      //   Straight right edge  → dirX = 1,    dirY = 0
      //   Top-right corner arc → dirX = 0.707, dirY = −0.707  (up-right)
      //   Straight top edge    → dirX = 0,    dirY = −1
      const [dirX, dirY] = sdRoundedBoxGrad(px_rel, py_rel, halfW, halfH, r);

      // ── Separable Snell displacement ─────────────────────────────────────
      //
      // Project distToEdge onto each axis via the outward-normal direction:
      //
      //   tX = distToEdge × |dirX| / bezel
      //   tY = distToEdge × |dirY| / bezel
      //
      // On a straight edge one projection is 1 and the other 0, recovering
      // the original single-axis behaviour.
      //
      // At a 45° corner dirX = dirY = 0.707, so both projections equal
      // distToEdge × 0.707 / bezel. Since 0.707 × t < t and dh(t) decreases
      // with t, the slope *at the corner projection* is evaluated higher on
      // the curve — larger than on a straight edge at the same SDF distance.
      // Combined with both axes being active at once, this produces the
      // divergent "bending-around" displacement field seen in Apple's glass.
      //
      // sign(px_rel) / sign(py_rel) gives the side of the element (±1) so
      // Snell bends content inward from outside on all four sides.

      const signX = px_rel >= 0 ? 1 : -1;
      const signY = py_rel >= 0 ? 1 : -1;

      const absDirX = Math.abs(dirX);
      const absDirY = Math.abs(dirY);

      let dx = 0;
      let dy = 0;

      // X component — driven by proximity to the vertical (left/right) edge.
      if (absDirX > 1e-6) {
        const tX = distToEdge * absDirX / bezel;
        if (tX < 1) {
          const sX = Math.min(dh(tX), 5.0);
          dx = snellAxis(sX, signX, eta);
        }
      }

      // Y component — driven by proximity to the horizontal (top/bottom) edge.
      if (absDirY > 1e-6) {
        const tY = distToEdge * absDirY / bezel;
        if (tY < 1) {
          const sY = Math.min(dh(tY), 5.0);
          dy = snellAxis(sY, signY, eta);
        }
      }

      raw[idx]     = dx;
      raw[idx + 1] = dy;

      if (Math.abs(dx) > maxMagX) maxMagX = Math.abs(dx);
      if (Math.abs(dy) > maxMagY) maxMagY = Math.abs(dy);
    }
  }

  // Per-axis normalisation: each channel independently fills ±127.
  // For symmetric pill shapes maxMagX ≈ maxMagY, so the scale is the same on
  // both axes. For asymmetric shapes (landscape pill) the bezel width is the
  // same on all sides (= min(halfW, halfH) × 0.8), so the peaks are also
  // equal and per-axis = magnitude normalisation in practice.
  const normX = maxMagX > 0 ? maxMagX : 1;
  const normY = maxMagY > 0 ? maxMagY : 1;

  for (let py = 0; py < mhElem; py++) {
    for (let px = 0; px < mwElem; px++) {
      const i = py * mwElem + px;
      const cx = px + ovX;
      const cy = py + ovY;
      const b = (cy * mw + cx) * 4;
      data[b]     = (128 + (raw[i * 2]     / normX) * 127 + 0.5) | 0;
      data[b + 1] = (128 + (raw[i * 2 + 1] / normY) * 127 + 0.5) | 0;
      data[b + 2] = maskBuf[i];
      data[b + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  return await canvas.convertToBlob({ type: "image/png" });
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