import { useEffect, useRef } from "react";
import { paintKnobGlass, type KnobBackdropLayer } from "../lib/knob-glass-paint";

/**
 * KnobGlass — the pressed knob's material, painted per pixel in float.
 *
 * Sits inside the knob and paints what the knob covers, refracted: the track
 * beneath it and the panel behind that. It replaces the SVG displacement-map
 * backdrop-filter for knobs (see knob-glass-paint.ts for why), and it reads
 * every colour and rect from the LIVE DOM rather than duplicating CSS — so
 * theme flips, an on/off track colour and the press swell all come through
 * without this file knowing any of them.
 *
 * Repaints while pressed (the knob slides across the track, so the backdrop
 * under it changes every frame) and stops the moment the press ends.
 */
export function KnobGlass({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !active) return;
    const knob = canvas.parentElement;
    if (!knob) return;

    let raf = 0;
    const paint = () => {
      const knobRect = knob.getBoundingClientRect();
      // The DISPLAYED size, which already includes the press transform — this
      // is what makes the canvas sharp at 2x with no map to magnify.
      const w = knobRect.width;
      const h = knobRect.height;
      if (w < 2 || h < 2) { raf = requestAnimationFrame(paint); return; }

      // The track (or the slider's rail) is whatever glass control owns us.
      const control = knob.closest(".glass-toggle, .glass-range-wrap");
      const layers: KnobBackdropLayer[] = [];
      let base = "rgb(240,240,242)";
      if (control) {
        const cRect = control.getBoundingClientRect();
        const cs = getComputedStyle(control);
        layers.push({
          x: cRect.left - knobRect.left,
          y: cRect.top - knobRect.top,
          w: cRect.width,
          h: cRect.height,
          r: parseFloat(cs.borderRadius) || cRect.height / 2,
          color: cs.backgroundColor,
        });
        // Whatever is behind the control: walk up for the first opaque paint.
        let p: HTMLElement | null = control.parentElement;
        while (p) {
          const bg = getComputedStyle(p).backgroundColor;
          const m = bg.match(/[\d.]+/g);
          if (m && (m.length < 4 || Number(m[3]) > 0.6)) { base = bg; break; }
          p = p.parentElement;
        }
      }

      paintKnobGlass(canvas, {
        w, h,
        dpr: Math.min(window.devicePixelRatio || 1, 3),
        base,
        layers,
        // The knob's own translucent surface. Read from --knob-fill, NOT from
        // backgroundColor: the painted knob sets its background transparent so
        // the canvas is the surface, which would otherwise read as "no tint".
        fill: getComputedStyle(knob).getPropertyValue("--knob-fill").trim()
          || "rgba(255,255,255,0.18)",
      });
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  if (!active) return null;
  return <canvas ref={ref} className="knob-glass-canvas" aria-hidden="true" />;
}
