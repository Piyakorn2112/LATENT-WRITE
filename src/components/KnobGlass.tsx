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
/**
 * Parse the linear-gradients the app actually paints with: an explicit
 * `to right` / `to bottom` (or the equivalent computed angle), with rgb/rgba
 * stops. Anything else returns null and the caller uses the flat colour —
 * this is a backdrop reproduction, not a CSS engine.
 */
function parseLinearGradient(
  bgImage: string,
  rect: DOMRect,
  knobRect: DOMRect,
  opacity: number,
): KnobBackdropLayer["gradient"] | null {
  if (!bgImage || !bgImage.startsWith("linear-gradient")) return null;
  const body = bgImage.slice(bgImage.indexOf("(") + 1, bgImage.lastIndexOf(")"));
  // Split on commas that are NOT inside rgb()/rgba().
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  if (parts.length < 2) return null;

  let horizontal = true;
  let reversed = false;
  let first = 0;
  const head = parts[0].toLowerCase();
  if (/^(to\s|[\d.]+deg)/.test(head)) {
    first = 1;
    if (head.startsWith("to ")) {
      horizontal = head.includes("right") || head.includes("left");
      reversed = head.includes("left") || head.includes("top");
    } else {
      const deg = ((parseFloat(head) % 360) + 360) % 360;
      horizontal = deg > 45 && deg < 135 || deg > 225 && deg < 315;
      reversed = deg > 180;
    }
  }
  const stopParts = parts.slice(first);
  if (stopParts.length < 2) return null;

  const stops: Array<[number, string]> = [];
  stopParts.forEach((sp, i) => {
    const posMatch = sp.match(/([\d.]+)%\s*$/);
    const at = posMatch ? Number(posMatch[1]) / 100 : i / (stopParts.length - 1);
    const colour = posMatch ? sp.slice(0, posMatch.index).trim() : sp.trim();
    if (!colour) return;
    stops.push([Math.min(1, Math.max(0, at)), applyOpacity(colour, opacity)]);
  });
  if (stops.length < 2) return null;

  const x = rect.left - knobRect.left;
  const y = rect.top - knobRect.top;
  const a = horizontal
    ? { x0: x, y0: y, x1: x + rect.width, y1: y }
    : { x0: x, y0: y, x1: x, y1: y + rect.height };
  return reversed
    ? { x0: a.x1, y0: a.y1, x1: a.x0, y1: a.y0, stops }
    : { ...a, stops };
}

/** Fold an element's opacity into a colour the canvas will paint. */
function applyOpacity(colour: string, opacity: number): string {
  if (opacity >= 0.999) return colour;
  const m = colour.match(/^rgba?\(([^)]+)\)$/);
  if (!m) return colour;
  const n = m[1].split(",").map((v) => v.trim());
  const a = n.length > 3 ? Number(n[3]) : 1;
  return `rgba(${n[0]}, ${n[1]}, ${n[2]}, ${a * opacity})`;
}

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
        // ★ EVERY PAINTED THING IN THE CONTROL, in DOM order — not just the
        // control's own background. The toggle IS its track, but a slider's
        // track and its PROGRESS FILL are separate children (a 4px rail and a
        // fill div), so painting only the wrapper drew nothing at all and the
        // knob showed no progress through its glass.
        const paintables: Element[] = [control, ...control.querySelectorAll("*")];
        for (const el of paintables) {
          if (el === knob || knob.contains(el)) continue;   // never the knob itself
          const cs = getComputedStyle(el);
          // ★ OPACITY IS NOT OPTIONAL HERE. The slider's <input> is laid over
          // the whole control to catch pointer events and is hidden with
          // `opacity: 0` — but its COMPUTED backgroundColor is opaque white.
          // Painting it covered the track and the progress fill completely,
          // which is exactly why the slider knob showed nothing through its
          // glass. Fold the element's opacity into the layer's alpha instead
          // of reading the colour alone.
          const elemOpacity = Number(cs.opacity);
          if (!(elemOpacity > 0.02)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 0.5 || r.height < 0.5) continue;

          // ★ A GRADIENT BACKGROUND REPORTS NO backgroundColor. The colour
          // picker's brightness rail is `linear-gradient(to right, #000,
          // <hue>)` — reading the colour alone found `transparent` and the
          // knob showed nothing over the one control whose backdrop matters
          // most. Parse the simple horizontal/vertical case, which is what
          // the app actually uses, and fall through to the flat colour when
          // it is anything more exotic.
          const grad = parseLinearGradient(cs.backgroundImage, r, knobRect, elemOpacity);
          if (grad) {
            layers.push({
              x: r.left - knobRect.left, y: r.top - knobRect.top,
              w: r.width, h: r.height,
              r: parseFloat(cs.borderRadius) || 0,
              color: "transparent", gradient: grad,
            });
            continue;
          }

          const bg = cs.backgroundColor;
          const m = bg.match(/[\d.]+/g);
          if (!m || m.length < 3) continue;
          const alpha = (m.length > 3 ? Number(m[3]) : 1) * elemOpacity;
          if (alpha <= 0.01) continue;
          layers.push({
            x: r.left - knobRect.left,
            y: r.top - knobRect.top,
            w: r.width,
            h: r.height,
            r: parseFloat(cs.borderRadius) || 0,
            color: `rgba(${m[0]}, ${m[1]}, ${m[2]}, ${alpha})`,
          });
        }
        // Whatever is behind the control: the first opaque ancestor paint.
        let p: HTMLElement | null = control.parentElement;
        while (p) {
          const bg = getComputedStyle(p).backgroundColor;
          const m = bg.match(/[\d.]+/g);
          if (m && (m.length < 4 || Number(m[3]) > 0.6)) { base = bg; break; }
          p = p.parentElement;
        }
      }

      const knobStyle = getComputedStyle(knob);
      paintKnobGlass(canvas, {
        w, h,
        dpr: Math.min(window.devicePixelRatio || 1, 3),
        base,
        layers,
        // The knob's own translucent surface. Read from --knob-fill, NOT from
        // backgroundColor: the painted knob sets its background transparent so
        // the canvas is the surface, which would otherwise read as "no tint".
        fill: knobStyle.getPropertyValue("--knob-fill").trim()
          || "rgba(255,255,255,0.18)",
        // Per-knob bevel width, from CSS for the same reason the tint is: the
        // component stays ignorant of which control it is inside.
        bezelFrac: parseFloat(knobStyle.getPropertyValue("--knob-bezel-frac")) || undefined,
      });
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  if (!active) return null;
  return <canvas ref={ref} className="knob-glass-canvas" aria-hidden="true" />;
}
