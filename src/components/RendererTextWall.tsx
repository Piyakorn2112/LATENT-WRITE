/**
 * Scaled-down canvas text wall — ported from renderer-site HeroSection.
 * Runs at ~20fps (throttled), 2 fbm octaves, low opacity.
 * Positioned as an artistic background layer, not interactive UI.
 */
import { useEffect, useRef } from "react";
import { fbm } from "../lib/perlin";
import { getRendererTextLines } from "../lib/renderer-text";

// Reduced parameters vs HeroSection for performance
// Darker grey — more contrast on the light panel background
const GREY_BASE:    [number, number, number] = [110, 110, 110];
const ACCENT_LIGHT: [number, number, number] = [237, 186, 109];
const ACCENT:       [number, number, number] = [255, 156, 0];
const ACCENT_SAT:   [number, number, number] = [255, 113, 0];

const GREY_THRESHOLD = 0.18;
const COLOR_LIGHT_END = 0.35;
const COLOR_MID_END   = 0.52;
const BASE_ALPHA      = 0.46;  // was 0.32 — more visible on light bg
const COLOR_ALPHA_MIN = 0.64;  // was 0.55
const COLOR_ALPHA_GAIN = 0.72; // was 0.65
const ANIMATION_SPEED = 0.006; // was 0.004 — 50% faster
const NOISE_SCALE_X   = 0.25;
const NOISE_SCALE_Y   = 0.25;
const QUANTIZE_STEPS  = 4;
const FRAME_SKIP      = 3; // draw every Nth frame → ~20fps at 60fps

type C3 = readonly [number, number, number];
function mix(a: C3, b: C3, t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const TEXT_LINES = getRendererTextLines(9);

export function RendererTextWall() {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const wrapRef    = useRef<HTMLDivElement>(null);
  const tRef       = useRef(0);
  const rafRef     = useRef(0);
  const frameCount = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap   = wrapRef.current!;
    const ctx    = canvas.getContext("2d")!;
    let running  = true;

    function frame() {
      if (!running) return;
      rafRef.current = requestAnimationFrame(frame);
      frameCount.current++;
      if (frameCount.current % FRAME_SKIP !== 0) return; // throttle

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w === 0 || h === 0) return;

      const cw = Math.round(w * dpr);
      const ch = Math.round(h * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width  = cw;
        canvas.height = ch;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const time     = tRef.current;
      const fontSize = Math.max(9, Math.min(14, w * 0.032)); // was 9–12px
      const lineH    = fontSize * 1.9;
      ctx.font          = `700 ${fontSize}px Georgia, "Times New Roman", serif`;
      ctx.textBaseline  = "top";

      const totalH  = TEXT_LINES.length * lineH;
      const y0      = (h - totalH) / 2;
      const centerX = w / 2;
      const centerY = h / 2;
      const maxR    = Math.max(w, h) * 0.52;

      for (let i = 0; i < TEXT_LINES.length; i++) {
        const y    = y0 + i * lineH;
        const line = TEXT_LINES[i];
        const lineW  = ctx.measureText(line).width;
        const copies = Math.ceil(w / (lineW + 50)) + 1;

        for (let copy = 0; copy < copies; copy++) {
          const baseX = copy * (lineW + 50) - 25;
          const words = line.split(" ");
          let x       = baseX;
          const spW   = ctx.measureText(" ").width;

          for (const word of words) {
            const ww = ctx.measureText(word).width;
            const mx = x + ww / 2;
            const my = y + fontSize / 2;

            // 4 octaves — matches HeroSection for identical visual quality
            const nRaw = (fbm(
              mx / (w * NOISE_SCALE_X) + time * 0.18,
              my / (h * NOISE_SCALE_Y) + time * 0.09,
              4, 2.2, 0.5,
            ) + 1) * 0.5;
            const n = Math.floor(nRaw * QUANTIZE_STEPS) / QUANTIZE_STEPS;

            let c: [number, number, number];
            if      (n < GREY_THRESHOLD)  c = [...GREY_BASE];
            else if (n < COLOR_LIGHT_END)  c = mix(GREY_BASE,    ACCENT_LIGHT, (n - GREY_THRESHOLD)  / (COLOR_LIGHT_END - GREY_THRESHOLD));
            else if (n < COLOR_MID_END)    c = mix(ACCENT_LIGHT, ACCENT,       (n - COLOR_LIGHT_END) / (COLOR_MID_END   - COLOR_LIGHT_END));
            else                           c = mix(ACCENT,       ACCENT_SAT,   Math.min(1, (n - COLOR_MID_END) / (1 - COLOR_MID_END)));

            const dx      = mx - centerX;
            const dy      = my - centerY;
            const dist    = Math.sqrt(dx * dx + dy * dy);
            const edgeFade = Math.max(0, 1 - (dist / maxR) ** 2);
            const strength = n > GREY_THRESHOLD
              ? COLOR_ALPHA_MIN + (n - GREY_THRESHOLD) * COLOR_ALPHA_GAIN
              : BASE_ALPHA;
            const a = Math.max(0, Math.min(1, edgeFade * strength));

            ctx.fillStyle = `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a.toFixed(3)})`;
            ctx.fillText(word, x, y);
            x += ww + spW;
          }
        }
      }

      tRef.current += ANIMATION_SPEED;
    }

    rafRef.current = requestAnimationFrame(frame);
    return () => { running = false; cancelAnimationFrame(rafRef.current); };
  }, []);

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
        height: 500,
        top: "-20px",
        filter: "blur(1px)",
        // Tight top-only mask: full opacity for just the peak area (~12%),
        // fades to transparent by ~38%. Keeps the text wall contained to the
        // top of the panel without bleeding into the form controls below.
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
