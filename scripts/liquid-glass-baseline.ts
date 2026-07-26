/**
 * FROZEN BASELINE — verbatim copy of the per-pixel math in
 * src/lib/liquid-glass-worker.ts as of commit a6d7caf (working tree).
 *
 * Canvas/encode calls are replaced by a plain buffer so this runs in Node.
 * Uint8ClampedArray is preserved for `data` and `maskBuf` because their
 * assignment-rounding semantics (round-half-to-even) are part of the output.
 *
 * DO NOT EDIT — with one documented exception below (MAP_OVERSAMPLE). This is
 * the oracle for the zero-visual-change proof, and it is only useful for as
 * long as it is allowed to disagree with the code.
 */

const N1 = 1;
const N2 = 1.5;
export type MapPreset = "default" | "control-knob" | "toggle-control-knob";
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
// ⚠ The ONLY value in this file changed since it was frozen: 12 -> 3, on
// 2026-07-26, deliberately and with sign-off. See MAP_OVERSAMPLE in
// liquid-glass-worker.ts for the measurement and reasoning.
//
// It is mirrored here because this oracle guards the per-pixel ALGORITHM, not
// the tunables — left at 12, every knob case would report a diff forever and
// the harness would stop meaning anything.
//
// This is NOT licence to sync other values. If a change makes this file
// disagree, the change is what needs justifying; that is the whole point of
// keeping a frozen copy.
const MAP_OVERSAMPLE: Record<MapPreset, number> = {
  default: 1,
  "control-knob": 3,
  "toggle-control-knob": 3,
};
const MAP_RENDER_OVERSAMPLE: Record<MapPreset, number> = {
  default: 1,
  "control-knob": 16,
  "toggle-control-knob": 16,
};

const BEZEL_PX = 120;

const BLUR_EDGE_MIN = 0.85;
const BLUR_TRANSITION_PCT = 0.25;
const BLUR_EXP = 2;

const MAP_DIVISOR = 1;
const MAP_DIVISOR_LARGE = 10;
const MAP_DIVISOR_BREAK = 320;

const RADIUS_FLOOR = 1;

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

function snellDisp(slope: number, eta: number): number {
  if (slope < 1e-3) return 0;
  const nLen = Math.hypot(slope, 1);
  const nZ = 1 / nLen;
  const sinSq = eta * eta * (1 - nZ * nZ);
  if (sinSq >= 1) return 0;
  const nSurface = slope / nLen;
  return (Math.sqrt(1 - sinSq) - eta * nZ) * nSurface;
}

export interface MapRequest {
  id: string;
  elemW: number;
  elemH: number;
  radius: number;
  overflow: number;
  preset: MapPreset;
  bezel?: number | null;
  fullQuality?: boolean;
  superSample?: number;
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

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export interface MapPixels {
  data: Uint8ClampedArray;
  mw: number;
  mh: number;
  outW: number;
  outH: number;
  needsDownscale: boolean;
}

export function buildMapPixels(req: MapRequest): MapPixels {
  const { elemW, elemH, radius, overflow } = req;
  const preset = req.preset === "toggle-control-knob"
    ? "toggle-control-knob"
    : req.preset === "control-knob"
      ? "control-knob"
      : "default";
  const channelGain = CHANNEL_GAIN[preset];
  const ss = Math.max(1, req.superSample ?? 1);
  const mapOversample = MAP_OVERSAMPLE[preset] * ss;
  const renderOversample = Math.max(mapOversample, MAP_RENDER_OVERSAMPLE[preset] * ss);

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
  const blurRimEnd = Math.max(1, Math.min(halfShorter * BLUR_TRANSITION_PCT, halfShorter));

  const sxInv = elemW / mwElem;
  const syInv = elemH / mhElem;
  const eta = N1 / N2;
  const edgeAaWidth = EDGE_AA_SPAN[preset] * Math.max(sxInv, syInv);

  const data = new Uint8ClampedArray(mw * mh * 4);

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

  return {
    data,
    mw,
    mh,
    outW: outputSize.width,
    outH: outputSize.height,
    needsDownscale: renderOversample > mapOversample + 0.01,
  };
}
