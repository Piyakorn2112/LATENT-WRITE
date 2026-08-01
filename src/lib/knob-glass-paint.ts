/**
 * knob-glass-paint.ts — the control knobs' glass, painted PER PIXEL IN FLOAT.
 *
 * ─── WHY THIS REPLACES THE DISPLACEMENT MAP ──────────────────────────────────
 *
 * Every artifact this knob has ever shown — folds, combs, stalls, banding,
 * 1-LSB top/bottom asymmetries — came from the ENCODING, not the optics. The
 * SVG path bakes the refraction into an 8-BIT displacement map and lets the
 * compositor GATHER through it:
 *
 *   · one byte moves the sample by dispPx/255 = 0.157 element px, so the
 *     sampling advances in quantised jumps. Once a texel is worth about one
 *     byte the band alternates stall / full-advance — a comb of stripes.
 *   · a gather map tears wherever the sampling stops increasing, so the
 *     profile has to fight a fold-free budget it cannot always meet.
 *   · the map is authored in the LAYOUT box, then magnified by the press
 *     transform, so it is soft exactly when the knob is biggest.
 *
 * stm-page solves the SAME optics without any of that: `GlassBars` (the
 * /about hero) evaluates the refraction analytically per pixel in a shader,
 * and `EventOrbit/glassRefract.ts` does it as a one-time canvas RESAMPLE with
 * bilinear sampling. Both work in float, so there is no quantisation to comb,
 * no gather to tear, and resolution is whatever the canvas is sized to.
 *
 * This is that method, for a pill:
 *   1. draw the backdrop the knob covers (the track, the panel behind it) into
 *      a source buffer at DISPLAYED device resolution;
 *   2. for every pixel inside the pill, take the exact capsule SDF, read a
 *      1-D bezel profile, and BILINEAR-SAMPLE the source inward along the
 *      exact outward normal — with the channels split slightly for dispersion;
 *   3. composite the knob's own translucent surface and its rim shading
 *      (white where the rim faces up/down, dark where it faces the sides —
 *      the glass-editor `--shadow-glass` tell).
 *
 * The pull is bounded so the resample stays monotone (`A·max|g′| ≤ bezel`),
 * which is cheap to guarantee here because nothing is quantised.
 *
 * ─── WHY THE BEZEL IS SMALL ──────────────────────────────────────────────────
 *
 * A knob is a flat pill of glass with a rounded edge, not a dome: the lens
 * belongs AT THE RIM. The displacement-map version used a bezel of
 * 0.8 × half-height — on a 24px knob that is the whole thing — and got away
 * with it only because the squircle profile crammed its pull into the first
 * pixel. With an honest bounded profile that same bezel spreads the
 * refraction across the entire knob, which reads as the whole button
 * smearing rather than a glass edge. BEZEL_FRAC keeps it to the rim.
 */

/** Air → glass. */
const ETA = 1 / 1.5;

/** Bezel depth as a fraction of the pill's half-short-side. Rim-hugging. */
const BEZEL_FRAC = 0.34;
/** Bounded-derivative falloff: max|g′| is exactly 1.5, at t = ½. */
const MAX_G_SLOPE = 1.5;

function falloff(t: number): number {
  const u = 1 - t;
  return u * u * (1 + 2 * t);
}

/** Squircle height profile, and its slope — the same optics as everywhere else. */
function h(t: number): number {
  return (1 - (1 - t) ** 4) ** 0.25;
}
function snellDisp(slope: number, eta: number): number {
  if (slope < 1e-3) return 0;
  const nLen = Math.hypot(slope, 1);
  const nZ = 1 / nLen;
  const sinSq = eta * eta * (1 - nZ * nZ);
  if (sinSq >= 1) return 0;
  return (Math.sqrt(1 - sinSq) - eta * nZ) * (slope / nLen);
}

/** The rim magnitude, in units of the bezel — the physics, evaluated once. */
const RIM_DISP = (() => {
  const dt = 5e-4;
  const slope = Math.min((h(dt) - h(0)) / dt, 5);
  return snellDisp(slope, ETA);
})();

/** Refraction profile over the bezel band, sampled once. */
const LUT_N = 512;
const PROFILE = (() => {
  const lut = new Float32Array(LUT_N + 1);
  for (let i = 0; i <= LUT_N; i++) lut[i] = RIM_DISP * falloff(i / LUT_N);
  return lut;
})();

export interface KnobBackdropLayer {
  /** Rect in knob-local CSS px (origin = the knob's top-left, as DISPLAYED). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Corner radius in CSS px. */
  r: number;
  /** Any canvas fillStyle. */
  color: string;
}

export interface KnobGlassScene {
  /** The knob's DISPLAYED size in CSS px (i.e. after the press transform). */
  w: number;
  h: number;
  /** Device pixel ratio to render at. */
  dpr: number;
  /** What lies behind everything (the panel). */
  base: string;
  /** Backdrop shapes, painted in order (typically just the track). */
  layers: KnobBackdropLayer[];
  /** The knob's own surface tint, as rgba. */
  fill: string;
  /** Specular strength on the up/down-facing rim, and the dark side border.
   *  Both live in a HAIRLINE at the very edge — see rimPx. */
  edgeHi?: number;
  edgeDark?: number;
  /** Width of the rim-shading hairline, in CSS px. The refraction bezel is
   *  much wider; the shading is a border, not a band. Painting the shading
   *  across the whole bezel turned the knob into a black lozenge. */
  rimPx?: number;
  /** Channel separation at the rim, as a fraction of the displacement. Kept
   *  low: it is a glass tell, and past ~0.1 it reads as a colour bug at a
   *  hard backdrop edge rather than dispersion. */
  chroma?: number;
  /** Saturation of the refracted backdrop — the filter chain's saturate(1.45),
   *  which the painted path has to supply itself. */
  saturate?: number;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Parse `rgb()` / `rgba()` into premultiplied-free components. */
function parseRgba(css: string): [number, number, number, number] {
  const m = css.match(/[\d.]+/g);
  if (!m || m.length < 3) return [255, 255, 255, 1];
  return [Number(m[0]), Number(m[1]), Number(m[2]), m.length > 3 ? Number(m[3]) : 1];
}

/**
 * Paint one knob. `canvas` is sized here; it must be laid out at the knob's
 * DISPLAYED size with `width/height: 100%` so the backing store carries the
 * press scale (this is what makes it sharp — there is no map to magnify).
 */
export function paintKnobGlass(canvas: HTMLCanvasElement, scene: KnobGlassScene): void {
  const { w, h, dpr } = scene;
  if (w < 2 || h < 2) return;
  const W = Math.max(2, Math.round(w * dpr));
  const H = Math.max(2, Math.round(h * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;

  // ── 1 · The backdrop, in device px.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = scene.base;
  ctx.fillRect(0, 0, W, H);
  for (const l of scene.layers) {
    ctx.fillStyle = l.color;
    roundRect(ctx, l.x * dpr, l.y * dpr, l.w * dpr, l.h * dpr, l.r * dpr);
    ctx.fill();
  }
  const src = ctx.getImageData(0, 0, W, H);
  const s = src.data;
  const out = ctx.createImageData(W, H);
  const d = out.data;

  // ── 2 · Geometry, in device px.
  const halfW = W / 2;
  const halfH = H / 2;
  const r = Math.min(halfW, halfH);       // a pill
  const flatX = halfW - r;
  const flatY = halfH - r;
  const bezel = Math.max(1, Math.min(halfW, halfH) * BEZEL_FRAC);
  // Bounded so the resample cannot fold: A·max|g′| ≤ bezel.
  const amp = Math.min(RIM_DISP * bezel * 2.2, bezel / MAX_G_SLOPE) / Math.max(RIM_DISP, 1e-6);
  const chroma = scene.chroma ?? 0.07;
  const sat = scene.saturate ?? 1.45;
  const [fr, fg, fb, fa] = parseRgba(scene.fill);
  const edgeHi = scene.edgeHi ?? 0.5;
  const edgeDark = scene.edgeDark ?? 0.16;
  const rim = Math.max(1, (scene.rimPx ?? 1.2) * dpr);
  const lim = 1e-4;
  const maxX = W - 1;
  const maxY = H - 1;
  const row = W * 4;

  const sample = (fx: number, fy: number, ch: number): number => {
    const cx2 = fx < 0 ? 0 : fx > maxX ? maxX : fx;
    const cy2 = fy < 0 ? 0 : fy > maxY ? maxY : fy;
    const ix = cx2 | 0;
    const iy = cy2 | 0;
    const tx = cx2 - ix;
    const ty = cy2 - iy;
    const ix1 = ix < maxX ? 4 : 0;
    const iy1 = iy < maxY ? row : 0;
    const i = (iy * W + ix) * 4 + ch;
    return s[i] * (1 - tx) * (1 - ty) + s[i + ix1] * tx * (1 - ty)
      + s[i + iy1] * (1 - tx) * ty + s[i + iy1 + ix1] * tx * ty;
  };

  for (let y = 0; y < H; y++) {
    const yRel = y + 0.5 - halfH;
    const ay = Math.abs(yRel) - flatY;
    const cyq = ay > 0 ? ay : 0;
    const sy = yRel < 0 ? -1 : 1;

    for (let x = 0; x < W; x++) {
      const xRel = x + 0.5 - halfW;
      const ax = Math.abs(xRel) - flatX;
      const cxq = ax > 0 ? ax : 0;

      // Exact capsule SDF.
      const outside = cxq === 0 ? cyq : cyq === 0 ? cxq : Math.hypot(cxq, cyq);
      const sd = outside + Math.min(Math.max(ax, ay), 0) - r;
      const o = (y * W + x) * 4;

      // Coverage: one device pixel of antialiasing at the silhouette.
      const cov = sd <= -1 ? 1 : sd >= 0 ? 0 : -sd;
      if (cov <= 0) { d[o + 3] = 0; continue; }

      const dist = -sd;
      const t = dist >= bezel ? 1 : dist / bezel;
      const disp = t >= 1 ? 0 : PROFILE[(t * LUT_N) | 0] * amp;

      let R: number, G: number, B: number;
      if (disp < 0.05) {
        R = s[o]; G = s[o + 1]; B = s[o + 2];
      } else {
        // Exact outward normal — no probes (the shape is analytic).
        let nx: number, ny: number;
        if (cxq > 0 || cyq > 0) {
          const len = cxq === 0 ? cyq : cyq === 0 ? cxq : Math.hypot(cxq, cyq);
          nx = (xRel < 0 ? -cxq : cxq) / len;
          ny = (cyq * sy) / len;
        } else if (ax > ay) {
          nx = xRel < 0 ? -1 : 1; ny = 0;
        } else {
          nx = 0; ny = sy;
        }
        // Sample INWARD, channels split for dispersion (red nearest, blue furthest).
        const sep = disp * chroma;
        R = sample(x - nx * (disp - sep), y - ny * (disp - sep), 0);
        G = sample(x - nx * disp, y - ny * disp, 1);
        B = sample(x - nx * (disp + sep), y - ny * (disp + sep), 2);
      }

      // ── 3 · Saturate the refracted backdrop (the chain's saturate(1.45)),
      //        then the knob's own surface over it.
      if (sat !== 1) {
        const lum = 0.213 * R + 0.715 * G + 0.072 * B;
        R = lum + (R - lum) * sat;
        G = lum + (G - lum) * sat;
        B = lum + (B - lum) * sat;
        R = R < 0 ? 0 : R > 255 ? 255 : R;
        G = G < 0 ? 0 : G > 255 ? 255 : G;
        B = B < 0 ? 0 : B > 255 ? 255 : B;
      }
      R = R * (1 - fa) + fr * fa;
      G = G * (1 - fa) + fg * fa;
      B = B * (1 - fa) + fb * fa;

      // Rim shading: a HAIRLINE at the very edge — white where the rim faces
      // up/down, dark where it faces the sides (the surface curving away
      // tangentially reads dark). Cubed so it stays crisp.
      if (dist < rim) {
        const ring = 1 - dist / rim;
        const sharp = ring * ring * ring;
        const len2 = cxq === 0 && cyq === 0 ? 1 : Math.hypot(cxq, cyq) || 1;
        const vy = cyq / len2;
        const vFrac = vy * vy;
        const hi = sharp * vFrac * edgeHi;
        const dk = sharp * (1 - vFrac) * edgeDark;
        R = (R + (255 - R) * hi) * (1 - dk);
        G = (G + (255 - G) * hi) * (1 - dk);
        B = (B + (255 - B) * hi) * (1 - dk);
      }

      d[o] = R;
      d[o + 1] = G;
      d[o + 2] = B;
      d[o + 3] = cov * 255;
    }
  }
  void lim;
  ctx.putImageData(out, 0, 0);
}
