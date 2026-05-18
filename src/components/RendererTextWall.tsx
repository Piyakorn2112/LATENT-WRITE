/**
 * Scaled-down canvas text wall — ported from renderer-site HeroSection.
 * Runs at 8fps via setTimeout. Canvas renders at 0.5× CSS size (the output
 * is blurred + masked so detail is invisible). Word metrics are cached on
 * resize. Per-word color is a table lookup from pre-quantized noise bands
 * — no string allocation or color math in the hot loop.
 */
import { useEffect, useRef } from "react";
import { fbm } from "../lib/perlin";
import { getRendererTextLines } from "../lib/renderer-text";

const GREY_BASE:    [number, number, number] = [110, 110, 110];
const ACCENT_LIGHT: [number, number, number] = [237, 186, 109];
const ACCENT:       [number, number, number] = [255, 156, 0];
const ACCENT_SAT:   [number, number, number] = [255, 113, 0];

const GREY_THRESHOLD  = 0.18;
const COLOR_LIGHT_END = 0.35;
const COLOR_MID_END   = 0.52;
const BASE_ALPHA      = 0.46;
const COLOR_ALPHA_MIN = 0.64;
const COLOR_ALPHA_GAIN = 0.72;
const ANIMATION_SPEED = 0.006;
const NOISE_SCALE_X   = 0.25;
const NOISE_SCALE_Y   = 0.25;
const QUANTIZE_STEPS  = 4;
const FRAME_INTERVAL  = 125; // ms → 8fps
const CANVAS_SCALE    = 0.5; // render at half CSS size

interface RendererTextWallProps {
  fontScale?: number;
  height?: number;
  topOffset?: number;
  opacity?: number;
}

type C3 = readonly [number, number, number];
function mix(a: C3, b: C3, t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const TEXT_LINES = getRendererTextLines(9);

// Pre-build a color lookup table for each quantized noise level.
// Index = Math.floor(nRaw * QUANTIZE_STEPS), value = { r, g, b, baseAlpha }.
// This avoids per-word branching and mix() calls in the hot loop.
interface ColorEntry { r: number; g: number; b: number; strength: number; }
const COLOR_TABLE: ColorEntry[] = Array.from({ length: QUANTIZE_STEPS + 1 }, (_, i) => {
  const n = i / QUANTIZE_STEPS;
  let c: [number, number, number];
  if      (n < GREY_THRESHOLD)   c = [GREY_BASE[0], GREY_BASE[1], GREY_BASE[2]];
  else if (n < COLOR_LIGHT_END)  c = mix(GREY_BASE,    ACCENT_LIGHT, (n - GREY_THRESHOLD)  / (COLOR_LIGHT_END - GREY_THRESHOLD));
  else if (n < COLOR_MID_END)    c = mix(ACCENT_LIGHT, ACCENT,       (n - COLOR_LIGHT_END) / (COLOR_MID_END   - COLOR_LIGHT_END));
  else                           c = mix(ACCENT,       ACCENT_SAT,   Math.min(1, (n - COLOR_MID_END) / (1 - COLOR_MID_END)));
  const strength = n > GREY_THRESHOLD
    ? COLOR_ALPHA_MIN + (n - GREY_THRESHOLD) * COLOR_ALPHA_GAIN
    : BASE_ALPHA;
  return { r: c[0] | 0, g: c[1] | 0, b: c[2] | 0, strength };
});

// Pre-build fillStyle strings for each color entry at ~16 alpha levels.
// Avoids string allocation in the hot loop entirely.
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

export function RendererTextWall({
  fontScale = 1,
  height = 500,
  topOffset = -20,
  opacity = 1,
}: RendererTextWallProps = {}) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const wrapRef    = useRef<HTMLDivElement>(null);
  const tRef       = useRef(0);
  const timerRef   = useRef(0);
  const metricsRef = useRef<MetricsCache | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap   = wrapRef.current!;
    const ctx    = canvas.getContext("2d")!;
    let running  = true;

    let visible = true;
    const visIO = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    }, { threshold: 0 });
    visIO.observe(wrap);

    function buildMetrics(w: number, h: number): MetricsCache {
      const fontSize = Math.max(9 * fontScale, Math.min(14 * fontScale, w * 0.032 * fontScale));
      const lineH    = fontSize * 1.9;
      ctx.font       = `700 ${fontSize}px Georgia, "Times New Roman", serif`;
      const spW      = ctx.measureText(" ").width;
      const totalH   = TEXT_LINES.length * lineH;
      const y0       = (h - totalH) / 2;

      const layouts: LineLayout[] = [];
      for (let i = 0; i < TEXT_LINES.length; i++) {
        const line  = TEXT_LINES[i];
        const lineW = ctx.measureText(line).width;
        const nCopies = Math.ceil(w / (lineW + 50)) + 1;
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
      return { w, h, fontSize, lineH, spW, layouts };
    }

    function frame() {
      if (!running) return;
      timerRef.current = window.setTimeout(frame, FRAME_INTERVAL);

      if (!visible) return;

      const cssW = wrap.clientWidth;
      const cssH = wrap.clientHeight;
      if (cssW === 0 || cssH === 0) return;

      const cw = Math.round(cssW * CANVAS_SCALE);
      const ch = Math.round(cssH * CANVAS_SCALE);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width  = cw;
        canvas.height = ch;
      }
      ctx.setTransform(CANVAS_SCALE, 0, 0, CANVAS_SCALE, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      let mc = metricsRef.current;
      if (!mc || mc.w !== cssW || mc.h !== cssH) {
        mc = buildMetrics(cssW, cssH);
        metricsRef.current = mc;
      }

      const time    = tRef.current;
      ctx.font      = `700 ${mc.fontSize}px Georgia, "Times New Roman", serif`;
      ctx.textBaseline = "top";
      const centerX = cssW * 0.5;
      const centerY = cssH * 0.5;
      const maxRSq  = (Math.max(cssW, cssH) * 0.52) ** 2;
      const invWSX  = 1 / (cssW * NOISE_SCALE_X);
      const invHSY  = 1 / (cssH * NOISE_SCALE_Y);
      const timeX   = time * 0.18;
      const timeY   = time * 0.09;
      const halfFS  = mc.fontSize * 0.5;

      for (const layout of mc.layouts) {
        const y = layout.y;
        const my = y + halfFS;
        const dy = my - centerY;
        const dySq = dy * dy;

        for (const copyWords of layout.copies) {
          for (const { word, x, ww } of copyWords) {
            const mx = x + ww * 0.5;

            const nRaw = (fbm(
              mx * invWSX + timeX,
              my * invHSY + timeY,
              2, 2.2, 0.5,
            ) + 1) * 0.5;
            const qi = Math.min(Math.floor(nRaw * QUANTIZE_STEPS), QUANTIZE_STEPS);
            const entry = COLOR_TABLE[qi];

            const dx = mx - centerX;
            const distSq = dx * dx + dySq;
            const edgeFade = 1 - distSq / maxRSq;
            if (edgeFade <= 0) continue;

            const a = edgeFade * entry.strength;
            const ai = (a * ALPHA_LEVELS + 0.5) | 0;
            ctx.fillStyle = STYLE_TABLE[qi][ai > ALPHA_LEVELS ? ALPHA_LEVELS : ai];
            ctx.fillText(word, x, y);
          }
        }
      }

      tRef.current += ANIMATION_SPEED;
    }

    timerRef.current = window.setTimeout(frame, FRAME_INTERVAL);
    return () => {
      running = false;
      clearTimeout(timerRef.current);
      visIO.disconnect();
    };
  }, [fontScale]);

  return (
    <div
      ref={wrapRef}
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: "inherit",
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 0,
        height,
        top: `${topOffset}px`,
        filter: "blur(1px)",
        opacity,
        maskImage: "linear-gradient(to bottom, black 0%, black 12%, transparent 32%)",
        WebkitMaskImage: "linear-gradient(to bottom, black 0%, black 12%, transparent 32%)",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%" }}
        aria-hidden="true"
      />
    </div>
  );
}
