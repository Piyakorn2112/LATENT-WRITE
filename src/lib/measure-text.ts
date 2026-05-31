/**
 * Accurate text-width measurement via a cached offscreen canvas.
 *
 * Used when sizing SVG label pills/badges: character-count × per-char estimates
 * systematically over- or under-shoot (the error scales with length, leaving a
 * growing gap inside the pill). measureText resolves the same system font the
 * SVG <text> uses, so the pill hugs the text regardless of glyph mix.
 */

const UI_FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

let _ctx: CanvasRenderingContext2D | null | undefined;

function ctx(): CanvasRenderingContext2D | null {
  if (_ctx === undefined) {
    _ctx = typeof document !== "undefined"
      ? document.createElement("canvas").getContext("2d")
      : null;
  }
  return _ctx;
}

export interface MeasureOpts {
  italic?: boolean;
  weight?: number | string;
  /** CSS letter-spacing in em (e.g. 0.08), applied between glyphs. */
  letterSpacingEm?: number;
  family?: string;
}

export function measureTextWidth(text: string, fontPx: number, opts: MeasureOpts = {}): number {
  const family = opts.family ?? UI_FONT_STACK;
  const letterSpacing = (opts.letterSpacingEm ?? 0) * fontPx * Math.max(0, text.length - 1);

  const c = ctx();
  if (c) {
    const style = opts.italic ? "italic " : "";
    const weight = opts.weight ? `${opts.weight} ` : "";
    c.font = `${style}${weight}${fontPx}px ${family}`;
    return c.measureText(text).width + letterSpacing;
  }

  // SSR / no-canvas fallback — approximate average glyph advance.
  return text.length * fontPx * 0.52 + letterSpacing;
}
