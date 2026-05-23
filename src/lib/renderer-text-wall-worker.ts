/**
 * Off-thread text-wall renderer.
 *
 * Creates its own OffscreenCanvas, renders at 3 fps, and sends a
 * transferred ImageBitmap to the main thread each frame. The main
 * thread does one drawImage call — no rasterization, no block time.
 *
 * Optimisations vs. the original inline approach:
 *   • Off-thread — zero main-thread JS cost during frame draw.
 *   • Batched draws — words grouped by (colour, alpha) bucket so
 *     fillStyle changes ≤ 5 per frame instead of ~2 000.
 *   • Radial-fade checked before fbm — skips Perlin for words that
 *     would be invisible anyway.
 *   • Vertical fade baked into per-word alpha — no CSS mask-image
 *     compositor layer on the main thread.
 *   • 3 fps (333 ms) — ANIMATION_SPEED = 0.006/frame; the pattern
 *     shifts so slowly that halving the frame rate is imperceptible.
 *   • Lines past the fade band are skipped in the layout loop.
 */

import { fbm } from "./perlin";
import { getRendererTextLines } from "./renderer-text";

const GREY_BASE:    readonly [number, number, number] = [110, 110, 110];
const ACCENT_LIGHT: readonly [number, number, number] = [237, 186, 109];
const ACCENT:       readonly [number, number, number] = [255, 156, 0];
const ACCENT_SAT:   readonly [number, number, number] = [255, 113, 0];

const GREY_THRESHOLD   = 0.18;
const COLOR_LIGHT_END  = 0.35;
const COLOR_MID_END    = 0.52;
const BASE_ALPHA       = 0.46;
const COLOR_ALPHA_MIN  = 0.64;
const COLOR_ALPHA_GAIN = 0.72;
const ANIMATION_SPEED  = 0.006;
const NOISE_SCALE_X    = 0.25;
const NOISE_SCALE_Y    = 0.25;
const QUANTIZE_STEPS   = 4;
const FRAME_INTERVAL   = 2300; // ms → 0.5 fps — near-static; pattern drifts imperceptibly
const CANVAS_SCALE     = 0.21; // render at 21% CSS size — 5.6× CSS upscale, very soft blur

// Vertical fade — mirrors the removed CSS mask-image gradient.
// relY < FADE_OPAQUE: fully opaque; FADE_OPAQUE–FADE_END: linear fade; ≥ FADE_END: skip.
const FADE_OPAQUE = 0.10;
const FADE_END    = 0.18; // top 18% of height only

type C3 = readonly [number, number, number];
function mix(a: C3, b: C3, t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const TEXT_LINES = getRendererTextLines(9);

interface ColorEntry { r: number; g: number; b: number; strength: number; }
const COLOR_TABLE: ColorEntry[] = Array.from({ length: QUANTIZE_STEPS + 1 }, (_, i) => {
  const n = i / QUANTIZE_STEPS;
  let c: [number, number, number];
  if      (n < GREY_THRESHOLD)  c = [GREY_BASE[0], GREY_BASE[1], GREY_BASE[2]];
  else if (n < COLOR_LIGHT_END) c = mix(GREY_BASE,    ACCENT_LIGHT, (n - GREY_THRESHOLD)  / (COLOR_LIGHT_END - GREY_THRESHOLD));
  else if (n < COLOR_MID_END)   c = mix(ACCENT_LIGHT, ACCENT,       (n - COLOR_LIGHT_END) / (COLOR_MID_END   - COLOR_LIGHT_END));
  else                          c = mix(ACCENT,        ACCENT_SAT,   Math.min(1, (n - COLOR_MID_END) / (1 - COLOR_MID_END)));
  const strength = n > GREY_THRESHOLD
    ? COLOR_ALPHA_MIN + (n - GREY_THRESHOLD) * COLOR_ALPHA_GAIN
    : BASE_ALPHA;
  return { r: c[0] | 0, g: c[1] | 0, b: c[2] | 0, strength };
});

const ALPHA_LEVELS = 16;
const STYLE_TABLE: string[][] = COLOR_TABLE.map(({ r, g, b }) =>
  Array.from({ length: ALPHA_LEVELS + 1 }, (_, ai) => {
    const a = ai / ALPHA_LEVELS;
    return `rgba(${r},${g},${b},${a.toFixed(3)})`;
  }),
);

interface WordLayout { word: string; x: number; ww: number; }
interface LineLayout { y: number; copies: WordLayout[][]; }
interface MetricsCache {
  w: number; h: number; fontSize: number;
  lineH: number; spW: number;
  layouts: LineLayout[];
}

// Pre-allocated per-bucket arrays reused every frame — no GC pressure.
const BUCKET_COUNT = (QUANTIZE_STEPS + 1) * (ALPHA_LEVELS + 1); // 85
const bWords: string[][] = Array.from({ length: BUCKET_COUNT }, () => []);
const bXs:    number[][] = Array.from({ length: BUCKET_COUNT }, () => []);
const bYs:    number[][] = Array.from({ length: BUCKET_COUNT }, () => []);

// ── Worker state ──────────────────────────────────────────────────────────
let oc:      OffscreenCanvas | null = null;
let ctx:     OffscreenCanvasRenderingContext2D | null = null;
let cssW     = 0;
let cssH     = 0;
let fontScale = 1;
let opacity  = 1;
let active   = true;
let t        = 0;
let timer    = 0;
let metrics: MetricsCache | null = null;

function buildMetrics(): MetricsCache {
  if (!ctx) return { w: 0, h: 0, fontSize: 0, lineH: 0, spW: 0, layouts: [] };
  const fontSize = Math.max(9 * fontScale, Math.min(14 * fontScale, cssW * 0.032 * fontScale));
  const lineH    = fontSize * 1.9;
  ctx.font       = `700 ${fontSize}px Georgia, "Times New Roman", serif`;
  const spW      = ctx.measureText(" ").width;
  const totalH   = TEXT_LINES.length * lineH;
  const y0       = (cssH - totalH) / 2;

  const layouts: LineLayout[] = [];
  for (let i = 0; i < TEXT_LINES.length; i++) {
    const line  = TEXT_LINES[i];
    const lineW = ctx.measureText(line).width;
    const nCopies = Math.ceil(cssW / (lineW + 50)) + 1;
    const words = line.split(" ");
    const copies: WordLayout[][] = [];
    for (let copy = 0; copy < nCopies; copy++) {
      let x = copy * (lineW + 50) - 25;
      const laid: WordLayout[] = [];
      for (const word of words) {
        const ww = ctx.measureText(word).width;
        laid.push({ word, x, ww });
        x += ww + spW;
      }
      copies.push(laid);
    }
    layouts.push({ y: y0 + i * lineH, copies });
  }
  return { w: cssW, h: cssH, fontSize, lineH, spW, layouts };
}

function frame() {
  timer = self.setTimeout(frame, FRAME_INTERVAL) as unknown as number;

  if (!active || !oc || !ctx || cssW === 0 || cssH === 0) return;

  const cw = Math.round(cssW * CANVAS_SCALE);
  const ch = Math.round(cssH * CANVAS_SCALE);
  if (oc.width !== cw || oc.height !== ch) {
    oc.width  = cw;
    oc.height = ch;
    // width/height change clears the canvas; ctx remains valid
    metrics = null;
  }

  ctx.setTransform(CANVAS_SCALE, 0, 0, CANVAS_SCALE, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (!metrics || metrics.w !== cssW || metrics.h !== cssH) {
    metrics = buildMetrics();
  }

  const mc = metrics;
  ctx.font         = `700 ${mc.fontSize}px Georgia, "Times New Roman", serif`;
  ctx.textBaseline = "top";

  const centerX = cssW * 0.5;
  const centerY = cssH * 0.5;
  const maxRSq  = (Math.max(cssW, cssH) * 0.52) ** 2;
  const invWSX  = 1 / (cssW * NOISE_SCALE_X);
  const invHSY  = 1 / (cssH * NOISE_SCALE_Y);
  const timeX   = t * 0.18;
  const timeY   = t * 0.09;
  const halfFS  = mc.fontSize * 0.5;

  // Clear buckets (O(1) length reset, no allocation).
  for (let i = 0; i < BUCKET_COUNT; i++) {
    bWords[i].length = 0;
    bXs[i].length    = 0;
    bYs[i].length    = 0;
  }

  for (const layout of mc.layouts) {
    const y    = layout.y;
    const relY = y / cssH;

    // Skip lines fully outside the visible fade band.
    if (relY >= FADE_END) continue;

    const my   = y + halfFS;
    const dy   = my - centerY;
    const dySq = dy * dy;

    const vFade = relY < FADE_OPAQUE
      ? 1.0
      : 1.0 - (relY - FADE_OPAQUE) / (FADE_END - FADE_OPAQUE);

    for (const copyWords of layout.copies) {
      for (const { word, x, ww } of copyWords) {
        const mx      = x + ww * 0.5;
        const dx      = mx - centerX;
        const distSq  = dx * dx + dySq;
        const edgeFade = 1 - distSq / maxRSq;

        // Check radial fade BEFORE fbm to avoid the Perlin cost for invisible words.
        if (edgeFade <= 0) continue;

        const nRaw = (fbm(
          mx * invWSX + timeX,
          my * invHSY + timeY,
          2, 2.2, 0.5,
        ) + 1) * 0.5;
        const qi    = Math.min(Math.floor(nRaw * QUANTIZE_STEPS), QUANTIZE_STEPS);
        const entry = COLOR_TABLE[qi];

        const a  = edgeFade * vFade * entry.strength * opacity;
        const ai = Math.min(ALPHA_LEVELS, (a * ALPHA_LEVELS + 0.5) | 0);
        if (ai === 0) continue;

        const bucketIdx = qi * (ALPHA_LEVELS + 1) + ai;
        bWords[bucketIdx].push(word);
        bXs[bucketIdx].push(x);
        bYs[bucketIdx].push(y);
      }
    }
  }

  // Draw each non-empty bucket with a single fillStyle set.
  for (let bucketIdx = 0; bucketIdx < BUCKET_COUNT; bucketIdx++) {
    const words = bWords[bucketIdx];
    if (words.length === 0) continue;
    const qi = (bucketIdx / (ALPHA_LEVELS + 1)) | 0;
    const ai = bucketIdx % (ALPHA_LEVELS + 1);
    ctx.fillStyle = STYLE_TABLE[qi][ai];
    const xs = bXs[bucketIdx];
    const ys = bYs[bucketIdx];
    for (let j = 0; j < words.length; j++) {
      ctx.fillText(words[j], xs[j], ys[j]);
    }
  }

  // transferToImageBitmap: zero-copy GPU transfer, clears oc for next frame.
  const bitmap = oc.transferToImageBitmap();
  (self as unknown as Worker).postMessage(
    { type: "frame", bitmap },
    [bitmap as unknown as Transferable],
  );

  t += ANIMATION_SPEED;
}

type WorkerMsg =
  | { type: "start"; fontScale: number; opacity: number; active: boolean; cssW: number; cssH: number }
  | { type: "resize"; cssW: number; cssH: number }
  | { type: "config"; active?: boolean; fontScale?: number; opacity?: number }
  | { type: "stop" };

self.onmessage = (e: MessageEvent<WorkerMsg>) => {
  const msg = e.data;
  switch (msg.type) {
    case "start": {
      fontScale = msg.fontScale;
      opacity   = msg.opacity;
      active    = msg.active;
      cssW      = msg.cssW;
      cssH      = msg.cssH;
      oc  = new OffscreenCanvas(
        Math.max(1, Math.round(cssW * CANVAS_SCALE)),
        Math.max(1, Math.round(cssH * CANVAS_SCALE)),
      );
      ctx     = oc.getContext("2d")!;
      metrics = null;
      self.clearTimeout(timer);
      timer = self.setTimeout(frame, 0) as unknown as number;
      break;
    }
    case "resize": {
      cssW    = msg.cssW;
      cssH    = msg.cssH;
      metrics = null;
      break;
    }
    case "config": {
      if (msg.active    !== undefined) active    = msg.active;
      if (msg.fontScale !== undefined) { fontScale = msg.fontScale; metrics = null; }
      if (msg.opacity   !== undefined) opacity   = msg.opacity;
      break;
    }
    case "stop": {
      self.clearTimeout(timer);
      break;
    }
  }
};
