/**
 * Liquid-glass edge colour — a standalone, opt-in layer that lights each glass
 * surface with the colours of the content around it (Apple's Liquid Glass: "its
 * colour is informed by surrounding content").
 *
 * ── Two layers ───────────────────────────────────────────────────────────────
 *   1. BODY GLOW — a sibling inserted just BEHIND the glass (its previous
 *      sibling, lower in paint order, same stacking context). It is NOT a child:
 *      a child paints above its parent's backdrop and is never refracted. As a
 *      preceding sibling it sits IN the glass's backdrop, so the glass's OWN,
 *      already-running `backdrop-filter` refracts + blurs it for free — we add
 *      zero GPU filter passes. Because the glass blurs it anyway, the body is
 *      rendered into an `S×`-smaller backing texture and scaled back up (its
 *      own `blur()` then runs over S² fewer pixels — the main per-scroll-frame
 *      GPU cost) via `resolutionScale`. Painted as a mesh of soft ELLIPTICAL glows, one
 *      per nearby source, each sized to that source's facing extent (a tall
 *      paragraph makes a tall glow, not a dot) and pinned to the glass edge
 *      nearest the source. A 4-gradient rim-band mask keeps it near the
 *      perimeter so it doesn't wash the centre.
 *   2. SPECULAR RIM — a child on top (not refracted, stays crisp) carrying thin,
 *      bright colour bands at the very edge facing each nearby source, blended
 *      `screen`. This is the "really bright" catch. Like the body, its extent is
 *      pure background-size/position — no mask (a masked conic ring rendered as a
 *      whole-element gradient with a centre point on some compositor paths).
 *
 * ── Colour: read the highlight layer directly ───────────────────────────────
 * No window capture (a flat capture is occluded by the glass and can't ignore
 * neighbouring glass). We index the highlight layer's colour-source elements by
 * geometry — entity boxes (`--entity-color`), action text (`--ap-color`) and
 * speech (`.edge-color-src`, speaker colour).
 *
 * ── Cost: event-driven, idle-free, real-time on scroll ───────────────────────
 * Repaints only while something moves and settles to a full stop when idle. On
 * scroll the cached source positions are TRANSLATED by the scroll delta every
 * frame (no layout reads), so the glow tracks the content at scroll speed; a
 * throttled full rebuild (every `sourceRefreshMs`) re-reads positions/colours to
 * correct drift. Overlay geometry is set on adopt/resize (and re-synced for a
 * fixed surface only when its rect actually changes), never blindly per frame.
 *
 * Nothing here mutates the glass engine; opt in by class.
 */

export interface EdgeColorOptions {
  /** Glass surfaces that get the edge glow. Default ".liquid-glass-color". */
  selector?: string;
  /** Colour-source elements read by geometry (the highlight layer). */
  colorSources?: string;
  /** Farthest a source can be from a surface and still light it, css px. Default 100. */
  reach?: number;
  /** Max inward DEPTH of the edge glow, css px (auto-capped to the surface). Default 60. */
  glowRadius?: number;
  /** Max glow blobs per surface (strongest sources win). Default 8. */
  maxSources?: number;
  /** Glow alpha multiplier. Default 1.3. */
  intensity?: number;
  /** Saturation (vibrancy) multiplier on caught colours. Default 1. */
  saturate?: number;
  /** Brightness multiplier on caught colours. Default 1. */
  brightness?: number;
  /** Body-glow overlay opacity. Default 0.3. */
  opacity?: number;
  /** Opacity for large surfaces (the toolbar). Default 0.3. */
  opacityLarge?: number;
  /** Surfaces with max(w,h) ≥ this use opacityLarge. Default 500. */
  largeThreshold?: number;
  /** Put the body glow under the refraction (refracted sibling). Default true. */
  refract?: boolean;
  /** Edge bias 0..1 — how shallow the glow's inward depth is (higher = hugs the rim). Default 0.55. */
  edgeBias?: number;
  /** Blur that softens the shaped glow into a soft edge glow, css px. Default 10. */
  softness?: number;
  /**
   * Backing-store resolution of the BODY glow, 0.1..1 (1 = full res). The body
   * is refracted + blurred by the glass anyway, so it never needs to be sharp:
   * we render it into a `S×`-smaller texture and `transform: scale(1/S)` it back
   * up, so its `blur()` runs over `S²` fewer pixels — the big per-scroll-frame
   * GPU cost. The glass's own blur hides the low-res. The rim stays full res.
   * Default 0.5 (quarter the body raster/blur work).
   */
  resolutionScale?: number;
  /** Specular-rim thickness, css px. 0 disables the rim. Default 2. */
  rimWidth?: number;
  /** Specular-rim alpha multiplier. Default 1.2. */
  rimIntensity?: number;
  /** Specular-rim brightness multiplier (the bright catch). Default 1.7. */
  rimBrightness?: number;
  /** Specular-rim blend mode. Default "screen". */
  rimBlend?: string;
  /** Body-glow mix-blend-mode. Default "normal". */
  blendMode?: string;
  /** Chroma below this contributes nothing (greys ignored). Default 0.05. */
  minChroma?: number;
  /** Chroma at/above this contributes fully. Default 0.30. */
  maxChroma?: number;
  /** How often to rebuild the colour-source index, ms. Default 80. */
  sourceRefreshMs?: number;
  /** Loop fps while active. Default 60. */
  maxFps?: number;
  /** Frames of inactivity before the loop fully stops. Default 3. */
  settleFrames?: number;
}

const DEFAULTS: Required<EdgeColorOptions> = {
  selector: ".liquid-glass-color",
  colorSources: ".entity-tag, .action-phrase, .edge-color-src",
  reach: 100,
  glowRadius: 20,
  maxSources: 8,
  intensity: 1.3,
  saturate: 1.4,
  brightness: 1.2,
  // The body wash stays at full strength. The rim carries the colour IDENTITY,
  // but the body is what gives the surface its depth — pulling it back left the
  // glass looking flat, so it keeps its original presence.
  opacity: 0.5,
  opacityLarge: 0.5,
  largeThreshold: 500,
  refract: true,
  edgeBias: 0.4,
  softness: 28,
  // ★ The body is refracted AND blurred by the glass, then blurred again by its
  // own `softness` — so its backing store carries far more detail than anything
  // downstream can show. Its blur cost scales with S², so 0.5 → 0.3 is ~2.8x
  // less raster and blur work for the layer, and the glass hides the difference.
  // Do not raise this back for "quality": the sharpness is destroyed twice over
  // before it reaches the screen.
  resolutionScale: 0.3,
  // ★ The rim is the primary colour catch, but it has to stay a WHISPER at the
  // very edge — a hint of the nearby colour on the rim, not a drawn outline.
  // Tuning history worth keeping, because it is easy to overshoot:
  //   · THIN is the whole point. The band must read as being ON the edge, so
  //     sub-pixel width plus a slightly wider blur beats a thick band; a wide
  //     band stops looking like an edge and starts looking like a border.
  //   · `screen`, NOT `plus-lighter`. Additive blending on a thin bright line
  //     over already-bright glass goes harsh immediately — it reads as a sharp
  //     stroke rather than light caught on a curve. screen's compression toward
  //     white is exactly the softness wanted here.
  //   · Brightness/intensity stay BELOW 1. Pushing them (2.4/1.9, then 1.5/1.0)
  //     turns the catch into a bright outline. The colour should be a tint the
  //     eye reads as the edge picking something up, not a lit stroke.
  //   · rimWidth is the HAIRLINE, ~1px. The softness comes from RIM_FALLOFF's
  //     stops, not from thickening this — a thicker core reads as a border.
  rimWidth: 1,
  rimIntensity: 0.5,
  rimBrightness: 1.12,
  rimBlend: "screen",
  blendMode: "normal",
  minChroma: 0.05,
  maxChroma: 0.3,
  sourceRefreshMs: 80,
  maxFps: 60,
  settleFrames: 3,
};

const RADIUS_FLOOR = 1;

/**
 * Exponential inward falloff for the specular rim, as [blurMultiple, alphaMultiple]
 * of `rimWidth`. The first stop is the hairline sitting exactly ON the edge; the
 * rest are the light diffusing into the material. Stacked blurs approximate e^-x
 * far better than any single gradient stop.
 *
 * Stacked inset shadows are why this works at all: each one follows the element's
 * `border-radius`, so the whole falloff bends around a corner together.
 *
 * ★ The TAIL is what decides whether this reads as a rim or as a glow. An earlier
 * curve ran out to 9x width at 0.11 alpha, and that far stop — not the core — is
 * what made the catch look thick and prominent: a wide low-alpha halo is
 * perceived as the edge being fat rather than as light falling off. Keep the tail
 * short and steep. Widening it is the single easiest way to lose the effect.
 */
const RIM_FALLOFF: ReadonlyArray<readonly [number, number]> = [
  [1.0, 1.0],   // the hairline itself, sitting on the edge
  [2.4, 0.20],  // immediate soft halo
  [5.5, 0.05],  // a whisper, and no further
];

type Mode = "fixed" | "flow";

interface Entry {
  glass: HTMLElement;
  body: HTMLDivElement;   // refracted glow, sibling behind the glass
  rim: HTMLDivElement | null; // specular ring, child on top
  mode: Mode;
  visible: boolean;
  radius: number;         // cached; read on adopt / resize, never per frame
  shape: string;          // last shape key (size × radius × opacity tier)
  // last geometry written to the body overlay (fixed mode re-syncs on change only)
  gx: number; gy: number; gw: number; gh: number;
  restorePosition: string | null;
}

interface ColorSrc { cx: number; cy: number; x0: number; y0: number; x1: number; y1: number; r: number; g: number; b: number; w: number; }

/** Which side of the glass a light band sits on. */
type Edge = "l" | "r" | "t" | "b";

export interface EdgeColorHandle {
  refresh(): void;
  destroy(): void;
}

function parseHex(s: string): [number, number, number, number] | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(s.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) return null;
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a];
}
function parseRgb(s: string): [number, number, number, number] | null {
  const m = /rgba?\(([^)]+)\)/i.exec(s);
  if (!m) return null;
  const p = m[1].split(/[,/]/).map((x) => parseFloat(x.trim()));
  if (![p[0], p[1], p[2]].every(Number.isFinite)) return null;
  return [p[0], p[1], p[2], p.length >= 4 && Number.isFinite(p[3]) ? p[3] : 1];
}
function parseAnyColor(s: string): [number, number, number, number] | null {
  return parseHex(s) ?? parseRgb(s);
}
function smoothstep(a: number, b: number, x: number): number {
  if (a === b) return x < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function boostSaturation(r: number, g: number, b: number, k: number): [number, number, number] {
  if (k === 1) return [r, g, b];
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const mx = Math.max(rn, gn, bn), mn = Math.min(rn, gn, bn);
  const l = (mx + mn) / 2, d = mx - mn;
  if (d <= 0) return [r, g, b];
  let s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === rn) h = ((gn - bn) / d) % 6;
  else if (mx === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h /= 6;
  if (h < 0) h += 1;
  s = Math.min(1, s * k);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (tt: number): number => {
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [Math.round(hue(h + 1 / 3) * 255), Math.round(hue(h) * 255), Math.round(hue(h - 1 / 3) * 255)];
}

export function initEdgeColor(options: EdgeColorOptions = {}): EdgeColorHandle {
  const opt = { ...DEFAULTS, ...options };
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { refresh() {}, destroy() {} };
  }

  // Body-glow backing-store scale (clamped). 1 = full res / no transform.
  const S = Math.min(1, Math.max(0.1, opt.resolutionScale));
  const INV_S = 1 / S;

  const entries = new Map<HTMLElement, Entry>();
  let rafId = 0;
  let lastFrame = 0;
  let idleFrames = 0;
  let dirty = true;

  // ── colour-source index (the highlight layer, read directly) ────────────────
  let sources: ColorSrc[] = [];
  let lastSourceBuild = -1e9;
  let sourcesStale = true;

  // ── scroll tracking → real-time translation between throttled rebuilds ──────
  let primaryScroller: Element | null = null;
  let lastScrollX = 0;
  let lastScrollY = 0;
  let scrollBaseValid = false;

  function scrollPos(): [number, number] {
    if (primaryScroller) return [primaryScroller.scrollLeft, primaryScroller.scrollTop];
    return [window.scrollX || 0, window.scrollY || 0];
  }
  function translateSources(dx: number, dy: number): void {
    if (!dx && !dy) return;
    for (const sc of sources) {
      sc.cx -= dx; sc.cy -= dy;
      sc.x0 -= dx; sc.x1 -= dx;
      sc.y0 -= dy; sc.y1 -= dy;
    }
  }

  function chromaWeight(c: [number, number, number, number]): number {
    const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
    return smoothstep(opt.minChroma, opt.maxChroma, (mx - mn) / 255) * c[3];
  }
  // Most chromatic of: --entity-color, --ap-color (action), background, text colour.
  function resolveSourceColor(el: Element): [number, number, number, number] | null {
    const cs = getComputedStyle(el);
    const ev = cs.getPropertyValue("--entity-color").trim();
    const av = cs.getPropertyValue("--ap-color").trim();
    const cands = [
      ev ? parseAnyColor(ev) : null,
      av ? parseAnyColor(av) : null,
      parseRgb(cs.backgroundColor),
      parseRgb(cs.color),
    ];
    let best: [number, number, number, number] | null = null;
    let bestW = 0;
    for (const c of cands) {
      if (!c || c[3] < 0.05) continue;
      const w = chromaWeight(c);
      if (w > bestW) { bestW = w; best = c; }
    }
    return bestW > 0 ? best : null;
  }
  function rebuildSources(): void {
    sources = [];
    if (!opt.colorSources) return;
    const vw = window.innerWidth, vh = window.innerHeight, m = opt.reach;
    let count = 0;
    for (const el of document.querySelectorAll(opt.colorSources)) {
      if (count >= 1500) break;
      const rc = el.getBoundingClientRect();
      if (rc.width < 1 || rc.height < 1) continue;
      if (rc.right < -m || rc.left > vw + m || rc.bottom < -m || rc.top > vh + m) continue; // off-screen
      const col = resolveSourceColor(el);
      if (!col) continue;
      const w = chromaWeight(col);
      if (w <= 0) continue;
      sources.push({
        cx: (rc.left + rc.right) / 2, cy: (rc.top + rc.bottom) / 2,
        x0: rc.left, y0: rc.top, x1: rc.right, y1: rc.bottom,
        r: col[0], g: col[1], b: col[2], w,
      });
      count++;
    }
    // re-baseline the scroll delta — positions are authoritative at this scroll pos
    [lastScrollX, lastScrollY] = scrollPos();
    scrollBaseValid = true;
  }

  // ── shape: rim-band mask (body) + ring mask (rim), set only on change ────────
  function opacityFor(w: number, h: number): number {
    return Math.max(w, h) >= opt.largeThreshold ? opt.opacityLarge : opt.opacity;
  }
  function applyShape(entry: Entry, _w: number, _h: number, r: number, op: number): void {
    const s = entry.body.style;
    // The body box is rendered at S× scale (see layoutBody), so every length it
    // carries lives in that downscaled space: radius, clip and blur are × S.
    s.borderRadius = `${(r * S).toFixed(2)}px`;
    // clip-path contains the soft shaped glow inside the rounded glass silhouette
    // (applied AFTER filter, so the blur can't leak past the corners).
    s.clipPath = `inset(0 round ${(r * S).toFixed(2)}px)`;
    s.opacity = String(op);
    s.backgroundRepeat = "no-repeat";
    // Soften the shaped (rectangular) glow into a nice edge glow. Painting-based
    // (cached when static); the glass's own backdrop-filter softens it further.
    // blur × S so the up-scaled result matches the requested softness while the
    // filter runs over S² fewer pixels.
    const f = opt.softness > 0 ? `blur(${(opt.softness * S).toFixed(2)}px)` : "";
    s.filter = f;
    (s as unknown as { webkitFilter: string }).webkitFilter = f;

    if (entry.rim) {
      const rs = entry.rim.style;
      rs.borderRadius = `${r}px`;
      rs.clipPath = `inset(0 round ${r}px)`;
      rs.backgroundRepeat = "no-repeat";
      // ★ NO filter on the rim. Its softness is the RIM_FALLOFF shadow stops,
      // and those follow the corner radius; a CSS blur on top would smear the
      // bright hairline that is the whole point of the catch, and would add a
      // real filter pass over a live layer for nothing. (This used to be
      // `softness * 0.25` — 7px over a ~2px band — which dissolved the specular
      // into the body wash entirely.)
      if (rs.filter) { rs.filter = ""; (rs as unknown as { webkitFilter: string }).webkitFilter = ""; }
    }
  }

  // ── per-source glow geometry, then paint both layers ────────────────────────
  // Each source becomes a RECTANGLE pinned to the glass edge nearest it, shaped to
  // the source's actual extent along that edge (a tall paragraph → a tall edge
  // band, not an oval). The body layer fades inward (soft edge glow); the rim
  // layer is a thin, bright band right at the edge (the specular catch). Extent
  // comes purely from background-size/position — NO mask (masks render
  // unreliably through some compositor paths and produced a centre-point conic).
  function paint(entry: Entry, gr: DOMRect): void {
    if (gr.width < 2 || gr.height < 2) return;
    const reach = opt.reach;
    const gw = gr.width, gh = gr.height;
    const minSpan = 24;
    const depth = Math.max(6, Math.min(opt.glowRadius, Math.min(gw, gh) * (1 - opt.edgeBias) * 0.5));
    // (no rim DEPTH here any more — the rim's inward extent comes from the
    // RIM_FALLOFF blur stops, which follow the corner radius; see below.)
    const images: string[] = [], sizes: string[] = [], positions: string[] = [];
    const rShadows: string[] = [];

    // edge band layer geometry → push a fading gradient rect into the given
    // arrays. `k` maps from glass px into the target layer's coordinate space
    // (S for the down-scaled body, 1 for the full-res rim).
    function band(
      img: string[], sz: string[], pos: string[],
      edge: Edge, alongStart: number, span: number, d: number,
      col: string, aStart: number, aEnd: number, k: number,
      soften = false,
    ): void {
      let x: number, y: number, w: number, h: number, dir: string;
      if (edge === "l" || edge === "r") {
        w = d; h = span; y = alongStart; x = edge === "l" ? 0 : gw - d;
        dir = edge === "l" ? "to right" : "to left";
      } else {
        w = span; h = d; x = alongStart; y = edge === "t" ? 0 : gh - d;
        dir = edge === "t" ? "to bottom" : "to top";
      }
      if (soften) {
        // ★ Soft ENDS. A linear-gradient only falls off across the band, so the
        // line stopped dead at both ends — two hard stops that read as a drawn
        // dash rather than light gathering on an edge. An ellipse centred ON the
        // edge line falls off in BOTH axes at once: inward over `d`, and along
        // the edge over half the span, so the line fades out at its ends with no
        // extra layers. Radii are explicit — `closest-side` would collapse a long
        // thin band into a circle of radius `d`.
        const at = edge === "l" ? "0% 50%" : edge === "r" ? "100% 50%"
                 : edge === "t" ? "50% 0%" : "50% 100%";
        const rx = edge === "l" || edge === "r" ? d : span / 2;
        const ry = edge === "l" || edge === "r" ? span / 2 : d;
        img.push(
          `radial-gradient(ellipse ${(rx * k).toFixed(1)}px ${(ry * k).toFixed(1)}px at ${at}, ` +
          `${col}${aStart.toFixed(3)}) 0%, ${col}${(aStart * 0.45).toFixed(3)}) 52%, ${col}0) 100%)`,
        );
      } else {
        img.push(`linear-gradient(${dir}, ${col}${aStart.toFixed(3)}) 0%, ${col}${aEnd.toFixed(3)}) 100%)`);
      }
      sz.push(`${(w * k).toFixed(1)}px ${(h * k).toFixed(1)}px`);
      pos.push(`${(x * k).toFixed(1)}px ${(y * k).toFixed(1)}px`);
    }

    const near: Array<{ sc: ColorSrc; dist: number }> = [];
    for (const sc of sources) {
      const dx = sc.cx < gr.left ? gr.left - sc.cx : sc.cx > gr.right ? sc.cx - gr.right : 0;
      const dy = sc.cy < gr.top ? gr.top - sc.cy : sc.cy > gr.bottom ? sc.cy - gr.bottom : 0;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > reach) continue;
      near.push({ sc, dist });
    }
    near.sort((a, b) => b.sc.w * (1 - b.dist / reach) - a.sc.w * (1 - a.dist / reach));
    if (near.length > opt.maxSources) near.length = opt.maxSources;

    for (const { sc, dist } of near) {
      const wgt = sc.w * (1 - dist / reach);
      if (wgt <= 0.01) continue;
      const [br0, bg0, bb0] = boostSaturation(sc.r, sc.g, sc.b, opt.saturate);
      const bri = opt.brightness;
      const r = Math.round(Math.min(255, br0 * bri)), g = Math.round(Math.min(255, bg0 * bri)), b = Math.round(Math.min(255, bb0 * bri));
      const a = Math.min(1, wgt * opt.intensity);
      const c = `rgba(${r},${g},${b},`;

      // source rect in glass-local coords, and its clamped footprint on the glass
      const sx0 = sc.x0 - gr.left, sx1 = sc.x1 - gr.left;
      const sy0 = sc.y0 - gr.top, sy1 = sc.y1 - gr.top;
      const ox0 = Math.max(0, Math.min(gw, sx0)), ox1 = Math.max(0, Math.min(gw, sx1));
      const oy0 = Math.max(0, Math.min(gh, sy0)), oy1 = Math.max(0, Math.min(gh, sy1));
      // ── which edges does this source light? ──────────────────────────────
      // How far the source pokes past each side. Opposite sides can never both
      // be positive, but ADJACENT ones can — which is exactly a source sitting
      // off a corner.
      const outL = Math.max(0, -sx0), outR = Math.max(0, sx1 - gw);
      const outT = Math.max(0, -sy0), outB = Math.max(0, sy1 - gh);
      const maxOut = Math.max(outL, outR, outT, outB);

      // ★ Weight the edges rather than picking a single winner. Taking the max
      // meant a source off a corner lit ONE side, so the light stopped dead at
      // the corner while the rounded arc beside it stayed dark — it read as a
      // cut-off rectangle instead of light wrapping the glass. Sharing the
      // source's weight across the sides it actually faces lets both adjacent
      // bands rise together so the highlight travels around the arc, and because
      // the weights SUM TO 1 the corner does not double-brighten.
      const edgeWeights: Array<[Edge, number]> = [];
      if (maxOut > 0) {
        const tot = outL + outR + outT + outB;
        for (const [e, o] of [["l", outL], ["r", outR], ["t", outT], ["b", outB]] as Array<[Edge, number]>) {
          if (o > 0) edgeWeights.push([e, o / tot]);
        }
      } else {
        // Fully overlapping the glass: fall off by distance to each side, so a
        // source near a corner still feeds both of its sides.
        const mx = (sx0 + sx1) / 2, my = (sy0 + sy1) / 2;
        const half = Math.max(1, Math.min(gw, gh) / 2);
        const raw: Array<[Edge, number]> = [];
        let tot = 0;
        for (const [e, d] of [["l", mx], ["r", gw - mx], ["t", my], ["b", gh - my]] as Array<[Edge, number]>) {
          // 1 at the edge, 0 by half the short side; squared so the nearest side
          // clearly dominates while its neighbours still contribute.
          const t = Math.max(0, 1 - Math.max(0, d) / half);
          const v = t * t;
          if (v > 0) { raw.push([e, v]); tot += v; }
        }
        for (const [e, v] of raw) edgeWeights.push([e, v / tot]);
      }

      // ★ Cap the fan-out. Each band is another background layer to composite
      // on every repaint, and weighting the edges instead of picking one winner
      // made a source emit up to four. A corner is bounded by exactly TWO sides,
      // so two is all the blend ever needs. Unbounded fan-out measured ~0.5 ms
      // for the glow layer; capped it sits in the 0.1-0.35 ms range.
      // ⚠ Treat single glow measurements with suspicion: repeat runs of
      // `npm run profile:glass-app` swing this layer by ~±0.2 ms, which is the
      // same size as the effect. Only differences well above that (the knobs'
      // 13 ms, say) are real from one sample.
      edgeWeights.sort((p, q) => q[1] - p[1]);
      if (edgeWeights.length > 2) edgeWeights.length = 2;

      for (const [edge, ew] of edgeWeights) {
        // ★ FADE the band in, don't switch it on. A hard `if (ew < t) continue`
        // means a band appears at full strength the instant a moving source
        // crosses the threshold, and vanishes just as abruptly — the popping is
        // what made the light feel mechanical rather than like something
        // gathering on the glass. Ramping over the cutoff makes a source drifting
        // past a corner hand its light from one side to the other continuously.
        const ef = smoothstep(0.10, 0.34, ew);
        if (ef <= 0.001) continue;

        // extent + start along the edge axis (the source's actual shape)
        let span: number, alongStart: number;
        if (edge === "l" || edge === "r") {
          span = Math.max(minSpan, oy1 - oy0);
          const mid = oy1 > oy0 ? (oy0 + oy1) / 2 : Math.max(0, Math.min(gh, sc.cy - gr.top));
          alongStart = Math.max(0, Math.min(gh - span, mid - span / 2));
        } else {
          span = Math.max(minSpan, ox1 - ox0);
          const mid = ox1 > ox0 ? (ox0 + ox1) / 2 : Math.max(0, Math.min(gw, sc.cx - gr.left));
          alongStart = Math.max(0, Math.min(gw - span, mid - span / 2));
        }
        // ★ Let a band that sits against a corner run the full way into it.
        // Clamping the span to the box stops it short of the corner, which is
        // exactly where the two adjacent bands must overlap to blend.
        const along = edge === "l" || edge === "r" ? gh : gw;
        const reach2 = Math.min(entry.radius, along - span);
        if (reach2 > 0) {
          if (alongStart <= entry.radius) {
            const grow = Math.min(reach2, alongStart);
            alongStart -= grow; span += grow + reach2;
          } else if (alongStart + span >= along - entry.radius) {
            span += reach2;
          }
          span = Math.min(span, along - alongStart);
        }

        // body: soft inward glow (fades to nothing at `depth`) — down-scaled space
        band(images, sizes, positions, edge, alongStart, span, depth, c, a * ef, 0, S);
      }

      // ── rim: light that follows the CONTOUR, not the four sides ──────────
      // ★★ THIS is why corners never looked right before. The rim was built from
      // axis-aligned rectangular bands, and two rectangles meeting at a rounded
      // corner form an L — they cannot bend along the arc, no matter how they are
      // weighted or blended. An INSET box-shadow follows `border-radius` exactly,
      // so the light curves around the corner by construction, and because the
      // direction below is a continuous vector the highlight ROTATES around the
      // contour as the source moves instead of being handed between sides.
      // (Same idiom as `.toolbar-ambient-orb` in styles.css, which uses stacked
      // inset shadows precisely because they hug the pill's rounded cap.)
      // Emitted once per SOURCE, not per edge — the shadow handles the geometry,
      // so there is nothing left for the per-edge split to do here.
      if (entry.rim) {
        // ★ HUE-ACCURATE brightening. Multiplying each channel and clamping at
        // 255 per channel is what made the caught colour wrong: the dominant
        // channel clips while the others keep climbing, so a saturated red drifts
        // to pink and a deep blue to lavender. Scaling ALL channels by one factor,
        // limited by the headroom of the largest, brightens without clipping any
        // channel, so the ratio between them — the hue — is preserved exactly.
        // Brightness the headroom cannot supply is handed to alpha, which does
        // not distort colour.
        const peak = Math.max(r, g, b, 1);
        const k = Math.min(opt.rimBrightness, 255 / peak);
        const rr = Math.round(r * k), rg = Math.round(g * k), rb = Math.round(b * k);
        const spill = opt.rimBrightness > k ? Math.min(1.25, opt.rimBrightness / k) : 1;
        const ra = Math.min(1, wgt * opt.rimIntensity * spill);

        // Direction from the glass centre toward the source; the shadow is offset
        // AGAINST it so the light lands on the facing part of the perimeter.
        let nx = (sc.cx - gr.left) - gw / 2;
        let ny = (sc.cy - gr.top) - gh / 2;
        const nl = Math.hypot(nx, ny) || 1;
        nx /= nl; ny /= nl;
        // ★ The offset must stay SMALL. An inset offset does not slide a line
        // along the edge, it grows the shadow on that side — push it far and the
        // "rim" floods half the surface instead of hugging the edge. A couple of
        // band-widths biases the ring toward the source while keeping it a rim.
        const w0 = Math.max(0.35, opt.rimWidth);
        // ★ Keep the bias to about one hairline. This offset is also what smears
        // the catch off the edge: every px of it thickens the lit side, so a
        // larger push trades precision for reach and the rim stops looking like
        // it is ON the contour. One width is enough to tell which side the colour
        // is coming from.
        const push = w0 * 1.1;
        const ox = (-nx * push).toFixed(2), oy = (-ny * push).toFixed(2);

        // ★ Exponential falloff: brightest hairline exactly AT the edge, then
        // each stop roughly triples in width and drops to about a third of the
        // alpha. Stacked blurs approximate an exponential far better than one
        // gradient stop, which is what makes it read as light diffusing into the
        // material rather than a drawn border.
        for (const [mulB, mulA] of RIM_FALLOFF) {
          const a = ra * mulA;
          if (a < 0.004) continue;
          rShadows.push(
            `inset ${ox}px ${oy}px ${(w0 * mulB).toFixed(2)}px rgba(${rr},${rg},${rb},${a.toFixed(3)})`,
          );
        }
      }
    }

    const bs = entry.body.style;
    if (images.length === 0) {
      if (bs.backgroundImage) { bs.backgroundImage = ""; bs.backgroundSize = ""; bs.backgroundPosition = ""; }
    } else {
      bs.backgroundImage = images.join(",");
      bs.backgroundSize = sizes.join(",");
      bs.backgroundPosition = positions.join(",");
    }
    if (entry.rim) {
      // One box-shadow list, however many sources — no background layers at all.
      const rs = entry.rim.style;
      const next = rShadows.join(",");
      if (rs.boxShadow !== next) rs.boxShadow = next;
    }
  }

  // ── geometry (radius cached) ────────────────────────────────────────────────
  function radiusOf(host: HTMLElement, w: number, h: number): number {
    const raw = parseFloat(getComputedStyle(host).borderTopLeftRadius) || 0;
    return Math.min(Math.max(raw, RADIUS_FLOOR), Math.min(w, h) / 2);
  }
  // Position the body overlay to overlap the glass. Fixed glass → fixed overlay
  // (viewport rect); flow glass → absolute overlay in the shared offset-parent
  // (tracks the glass natively on scroll, so no per-frame geometry writes).
  function layoutBody(entry: Entry, gr: DOMRect): void {
    const s = entry.body.style;
    let x: number, y: number, w: number, h: number;
    if (entry.mode === "fixed") {
      x = gr.left; y = gr.top; w = gr.width; h = gr.height;
    } else {
      const g = entry.glass;
      x = g.offsetLeft; y = g.offsetTop; w = g.offsetWidth; h = g.offsetHeight;
    }
    entry.gx = x; entry.gy = y; entry.gw = w; entry.gh = h;
    s.left = `${x}px`; s.top = `${y}px`;
    // Render the box at S× and scale it back to full size from the top-left, so
    // the backing texture (and its blur) covers S² fewer pixels. transform-origin
    // 0 0 keeps it pinned to the glass's top-left corner.
    s.width = `${(w * S).toFixed(2)}px`; s.height = `${(h * S).toFixed(2)}px`;
    if (S !== 1) {
      const t = `scale(${INV_S.toFixed(4)})`;
      s.transform = t;
      (s as unknown as { webkitTransform: string }).webkitTransform = t;
      s.transformOrigin = "0 0";
    }
  }

  // ── per-element lifecycle ───────────────────────────────────────────────────
  function adopt(glass: HTMLElement): void {
    if (entries.has(glass)) return;
    const cs = getComputedStyle(glass);
    const mode: Mode = cs.position === "fixed" ? "fixed" : "flow";
    let restorePosition: string | null = null;
    if (mode === "flow" && cs.position === "static") {
      // a static glass: the rim child needs the glass to be a stacking context /
      // positioned ancestor; promote to relative (belt-and-braces — glass is
      // usually already a stacking context via backdrop-filter).
      restorePosition = glass.style.position;
      glass.style.position = "relative";
    }

    // body glow — sibling behind the glass (refracted by the glass's backdrop)
    const body = document.createElement("div");
    body.className = "lqg-edge-color";
    const bs = body.style;
    bs.position = mode === "fixed" ? "fixed" : "absolute";
    bs.pointerEvents = "none";
    bs.boxSizing = "border-box";
    bs.mixBlendMode = opt.blendMode;
    glass.parentNode?.insertBefore(body, glass);

    // specular rim — child on top, crisp (not refracted)
    let rim: HTMLDivElement | null = null;
    if (opt.rimWidth > 0) {
      rim = document.createElement("div");
      rim.className = "lqg-edge-rim";
      const rsx = rim.style;
      rsx.position = "absolute";
      rsx.inset = "0";
      rsx.zIndex = "1";
      rsx.pointerEvents = "none";
      rsx.boxSizing = "border-box";
      rsx.mixBlendMode = opt.rimBlend;
      glass.appendChild(rim);
    }

    const rect = glass.getBoundingClientRect();
    const radius = radiusOf(glass, Math.max(2, rect.width), Math.max(2, rect.height));
    const entry: Entry = {
      glass, body, rim, mode, visible: true, radius, shape: "",
      gx: 0, gy: 0, gw: 0, gh: 0, restorePosition,
    };
    entries.set(glass, entry);
    layoutBody(entry, rect);
    io?.observe(glass);
    ro?.observe(glass);
    wake();
  }
  function release(glass: HTMLElement): void {
    const entry = entries.get(glass);
    if (!entry) return;
    entries.delete(glass);
    io?.unobserve(glass);
    ro?.unobserve(glass);
    entry.body.remove();
    entry.rim?.remove();
    if (entry.restorePosition !== null) glass.style.position = entry.restorePosition;
  }

  // ── frame loop ──────────────────────────────────────────────────────────────
  function frame(now: number): void {
    rafId = 0;
    if (now - lastFrame < 1000 / opt.maxFps) { schedule(); return; }
    lastFrame = now;
    if (dirty) {
      if (sourcesStale && now - lastSourceBuild >= opt.sourceRefreshMs) {
        rebuildSources();
        lastSourceBuild = now;
        sourcesStale = false;
      } else if (scrollBaseValid) {
        // real-time: translate cached sources by the scroll delta this frame
        const [sx, sy] = scrollPos();
        translateSources(sx - lastScrollX, sy - lastScrollY);
        lastScrollX = sx; lastScrollY = sy;
      }
      for (const entry of entries.values()) {
        if (!entry.visible) continue;
        const gr = entry.glass.getBoundingClientRect();
        const op = opacityFor(gr.width, gr.height);
        const key = `${Math.round(gr.width)}x${Math.round(gr.height)}x${Math.round(entry.radius)}x${op}`;
        if (key !== entry.shape) { entry.shape = key; applyShape(entry, gr.width, gr.height, entry.radius, op); }
        // re-sync a fixed overlay only if the glass actually moved/resized
        if (entry.mode === "fixed" && (gr.left !== entry.gx || gr.top !== entry.gy || gr.width !== entry.gw || gr.height !== entry.gh)) {
          layoutBody(entry, gr);
        }
        paint(entry, gr);
      }
      dirty = false;
      idleFrames = 0;
      schedule();
    } else if (idleFrames++ < opt.settleFrames) {
      schedule();
    }
  }
  function schedule(): void {
    if (rafId || document.hidden) return;
    rafId = requestAnimationFrame(frame);
  }
  function wake(): void {
    dirty = true;
    sourcesStale = true;
    idleFrames = 0;
    schedule();
  }

  // ── observers / events ──────────────────────────────────────────────────────
  const io = "IntersectionObserver" in window
    ? new IntersectionObserver((records) => {
        for (const rec of records) {
          const entry = entries.get(rec.target as HTMLElement);
          if (entry) entry.visible = rec.isIntersecting;
        }
        wake();
      })
    : null;
  const ro = "ResizeObserver" in window
    ? new ResizeObserver((records) => {
        for (const rec of records) {
          const entry = entries.get(rec.target as HTMLElement);
          if (!entry) continue;
          const rect = rec.target.getBoundingClientRect();
          entry.radius = radiusOf(entry.glass, Math.max(2, rect.width), Math.max(2, rect.height));
          entry.shape = "";          // re-shape on next frame
          layoutBody(entry, rect);   // re-position the body overlay
        }
        wake();
      })
    : null;

  function scan(node: ParentNode): void {
    node.querySelectorAll?.(opt.selector).forEach((el) => adopt(el as HTMLElement));
  }
  const mo = new MutationObserver((records) => {
    let changed = false;
    for (const rec of records) {
      rec.addedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement)) return;
        if (n.classList.contains("lqg-edge-color") || n.classList.contains("lqg-edge-rim")) return;
        if (n.matches?.(opt.selector)) adopt(n);
        scan(n);
        changed = true;
      });
      rec.removedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement)) return;
        if (entries.has(n)) release(n);
        n.querySelectorAll?.(opt.selector).forEach((el) => release(el as HTMLElement));
        changed = true;
      });
    }
    if (changed) wake();
  });

  const onScroll = (e?: Event) => {
    const t = (e?.target ?? null) as Node | null;
    const next = t && t.nodeType === 1 && t !== document.documentElement && t !== document.body
      ? (t as Element)
      : null;
    // Only re-baseline when the SCROLLER changes; on repeat scrolls of the same
    // scroller we keep the baseline so per-frame translation stays continuous.
    if (next !== primaryScroller) { primaryScroller = next; scrollBaseValid = false; }
    wake();
  };
  const onResize = () => wake();
  const onMotion = () => wake();
  const onVisibility = () => schedule();

  scan(document);
  mo.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  window.addEventListener("resize", onResize, { passive: true });
  document.addEventListener("transitionrun", onMotion, { capture: true, passive: true });
  document.addEventListener("animationstart", onMotion, { capture: true, passive: true });
  document.addEventListener("visibilitychange", onVisibility);
  wake();

  return {
    refresh() { sourcesStale = true; scan(document); wake(); },
    destroy() {
      if (rafId) cancelAnimationFrame(rafId);
      mo.disconnect();
      io?.disconnect();
      ro?.disconnect();
      document.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("transitionrun", onMotion, { capture: true } as EventListenerOptions);
      document.removeEventListener("animationstart", onMotion, { capture: true } as EventListenerOptions);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const glass of [...entries.keys()]) release(glass);
    },
  };
}
