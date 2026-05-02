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
 */

// Air → glass.
const N1 = 1;
const N2 = 1.5;

// Visual bezel thickness in element pixels (must match main-thread filter).
const BEZEL_PX = 100;

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
const BLUR_EXP = 1.6;

// Map resolution.
const MAP_DIVISOR = 4;
const MAP_MAX = 200;

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
function sdRoundedBoxGrad(
  px: number, py: number, bx: number, by: number, r: number,
): [number, number] {
  const sx = px >= 0 ? 1 : -1;
  const sy = py >= 0 ? 1 : -1;
  const qx = Math.abs(px) - (bx - r);
  const qy = Math.abs(py) - (by - r);
  if (qx > 0 && qy > 0) {
    const len = Math.hypot(qx, qy);
    if (len < 1e-6) return [sx, 0];
    return [(sx * qx) / len, (sy * qy) / len];
  }
  if (qx > qy) return [sx, 0];
  return [0, sy];
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
  // partly blurred — no sharp ring) and rises to 1 (full blur).
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

      if (distToEdge <= 0) continue;

      if (distToEdge >= blurRimEnd) {
        maskBuf[i] = 255;
      } else {
        const t = distToEdge / blurRimEnd;
        const eased = (t < 0 ? 0 : t > 1 ? 1 : t) ** BLUR_EXP;
        maskBuf[i] = (BLUR_EDGE_MIN + (1 - BLUR_EDGE_MIN) * eased) * 255 + 0.5;
      }

      if (distToEdge >= bezel) continue;

      // Analytical SDF gradient — exact radial direction in the corner arcs
      // where finite differences alias on the low-resolution map.
      const [dirX, dirY] = sdRoundedBoxGrad(px_rel, py_rel, halfW, halfH, r);

      const t = distToEdge / bezel;
      const slope = Math.min(dh(t), 5.0);
      if (slope < 1e-3) continue;

      const nLen = Math.hypot(slope, 1);
      const nX = (-slope * dirX) / nLen;
      const nY = (-slope * dirY) / nLen;
      const nZ = 1 / nLen;

      const sinSqT = eta * eta * (1 - nZ * nZ);
      if (sinSqT >= 1) continue;
      const kSnell = eta * nZ - Math.sqrt(1 - sinSqT);
      const dx = kSnell * nX;
      const dy = kSnell * nY;
      raw[idx] = dx;
      raw[idx + 1] = dy;

      const mag = Math.hypot(dx, dy);
      if (mag > maxMag) maxMag = mag;
    }
  }

  const norm = maxMag > 0 ? maxMag : 1;
  for (let py = 0; py < mhElem; py++) {
    for (let px = 0; px < mwElem; px++) {
      const i = py * mwElem + px;
      const cx = px + ovX;
      const cy = py + ovY;
      const b = (cy * mw + cx) * 4;
      data[b] = (128 + (raw[i * 2] / norm) * 127 + 0.5) | 0;
      data[b + 1] = (128 + (raw[i * 2 + 1] / norm) * 127 + 0.5) | 0;
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
