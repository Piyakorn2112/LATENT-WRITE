/**
 * backdrop.ts — repaint what lies under a glass surface, so the surface can
 * refract it itself instead of asking the compositor for a backdrop.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `KnobGlass` refracts properly because it RECONSTRUCTS its backdrop: it reads
 * the track and the panel out of the live DOM and repaints them into a canvas,
 * then refracts those pixels per pixel in float. That works because the only
 * thing under a knob is a rounded rect on a flat fill.
 *
 * Every other glass surface in this app sits over something harder — a flat
 * page fill under the toolbar, and LIVE PROSE under everything that opens over
 * the editor. So the reconstruction problem here is not "rasterise arbitrary
 * DOM"; it is "rects, gradients, and text in the app's own fonts".
 *
 * ─── ★★ ONE WALK, MANY SURFACES ──────────────────────────────────────────────
 *
 * The expensive half of a reconstruction is not the pixels, it is the WALK:
 * `getComputedStyle` and `getBoundingClientRect` on every element in the
 * region, plus a Range measurement per line box of text. The first version paid
 * that per surface, so seven surfaces walked the same DOM seven times and a
 * full refresh could not fit in a frame — which is what made the glass lag
 * behind a scroll instead of tracking it.
 *
 * So the walk now happens ONCE per frame and produces a DISPLAY LIST in
 * viewport coordinates. Each surface replays the subset that intersects it,
 * which is pure canvas drawing with no style resolution at all. N surfaces cost
 * one walk plus N cheap replays.
 *
 * ★ WHAT IT DELIBERATELY DOES NOT DO. It is not a CSS engine. No stacking
 * contexts, no transforms, no box-shadows, no blend modes, no filters on the
 * backdrop elements, no background-image except linear-gradient, no
 * background-size or background-position other than the default.
 *
 * ★ AND IT REPORTS WHEN IT IS OUT OF ITS DEPTH — `unpaintable`. An element that
 * carries one of those constructs AND actually paints something is a pixel this
 * module will get wrong. Counting only what was SKIPPED would not catch it: the
 * worst errors ever measured here were elements the painter drew, confidently,
 * wrong.
 */

// ── Public shapes ───────────────────────────────────────────────────────────

export interface ReconstructStats {
  /** Wall-clock for the whole reconstruction, ms. */
  ms: number;
  /** How many elements painted a background. */
  rects: number;
  /** How many gradient layers were painted. */
  gradients: number;
  /** How many borders were stroked. */
  borders: number;
  /** How many line boxes of text were drawn. */
  lines: number;
  /** How many glyphs were drawn. */
  glyphs: number;
  /** Elements skipped because this painter cannot express them, by reason. */
  skipped: Record<string, number>;
  /**
   * ★ THE GATE. Elements that carry a construct this painter cannot express AND
   * paint something anyway — i.e. pixels it is knowingly getting wrong.
   */
  unpaintable: number;
  /** What made it unpaintable, for the log — element description → reason. */
  unpaintableWhy: string[];
  /** Nested canvases blitted straight in (the orb, another glass surface). */
  blits: number;
  /** Elements the walk descended into, and how many it pruned. */
  visited: number;
  pruned: number;
  /** Range measurements spent finding line-box splits — the text path's cost. */
  rangeOps: number;
  /** Diagnostic paint log, when `debug` is set. */
  ops?: Array<{ el: string; rect: number[]; kind: string; paint: string; area: number }>;
}

interface Box { x: number; y: number; w: number; h: number }

/** A parsed linear-gradient, resolved into a canvas gradient only at replay. */
interface GradientSpec {
  deg: number;
  stops: Array<{ at: number; css: string }>;
}

/** One `background-image` layer. Flat colour or a gradient; never both. */
interface BgLayer {
  color?: string;
  grad?: GradientSpec;
}

type Op =
  | {
    k: "bg"; el: Element; bbox: Box; alpha: number; radius: number;
    boxes: Box[]; color: string | null; layers: BgLayer[];
  }
  | {
    k: "border"; el: Element; bbox: Box; alpha: number;
    segs: Array<{ x1: number; y1: number; x2: number; y2: number; w: number; color: string }>;
  }
  | {
    k: "text"; el: Element; bbox: Box; alpha: number;
    font: string; color: string; ls: number;
    runs: Array<{ t: string; x: number; y: number; w: number; h: number }>;
  }
  | { k: "blit"; el: Element; bbox: Box; alpha: number; src: HTMLCanvasElement };

export interface DisplayList {
  ops: Op[];
  /** Elements this painter would draw wrong, so a surface can refuse them. */
  unpaintables: Array<{ el: Element; bbox: Box; why: string }>;
  /** The page's own base tone, painted under everything. */
  baseColor: string;
  /** Build-time cost and counters. */
  stats: ReconstructStats;
}

// ── Capability checks ───────────────────────────────────────────────────────

/** Everything the painter cannot express, so the caller can count it. */
const UNSUPPORTED: Array<[string, (cs: CSSStyleDeclaration, el: Element) => boolean]> = [
  ["transform", (cs) => cs.transform !== "none"],
  ["filter", (cs) => cs.filter !== "none"],
  ["box-shadow", (cs) => cs.boxShadow !== "none"],
  ["blend-mode", (cs) => cs.mixBlendMode !== "normal"],
  ["mask", (cs) => cs.maskImage !== "none" && cs.maskImage !== ""],
  // CANVAS is deliberately absent — it is blitted exactly with drawImage, so it
  // is supported rather than skipped. Everything else replaced still is not.
  ["replaced", (_cs, el) => ["IMG", "VIDEO", "IFRAME"].includes(el.tagName)
    || el.tagName.toLowerCase() === "svg"],
];

/** Short human label for the gate's log — enough to find the element again. */
function describe(el: Element): string {
  const cls = (el.className || "").toString().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
  return el.tagName.toLowerCase() + (cls ? "." + cls : "");
}

/**
 * Does this element put ink anywhere? Only these get to disqualify a surface.
 * Deliberately generous — a false "yes" costs one surface its canvas path and
 * falls back to something correct, a false "no" ships a wrong pixel.
 */
function paintsSomething(el: Element, cs: CSSStyleDeclaration): boolean {
  if (["IMG", "VIDEO", "IFRAME"].includes(el.tagName)) return true;
  if (el.tagName.toLowerCase() === "svg") return true;
  if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
  if (colorAlpha(cs.backgroundColor) > 0.004) return true;
  for (const w of [cs.borderTopWidth, cs.borderBottomWidth, cs.borderLeftWidth, cs.borderRightWidth]) {
    if (parseFloat(w) > 0) return true;
  }
  if (cs.boxShadow && cs.boxShadow !== "none") return true;
  for (const n of el.childNodes) {
    if (n.nodeType === 3 && (n.textContent || "").trim()) return true;
  }
  return false;
}

// ── CSS value parsing ───────────────────────────────────────────────────────

/**
 * ★ NEVER REGEX A COLOUR INTO NUMBERS. Chromium serialises modern colours as
 * `color(srgb 0 0.65098 0.588235 / 0.2)`, and pulling `[\d.]+` out of that and
 * writing it back as `rgba(0, 0.65098, 0.588235, 0.16)` yields BLACK at 16%
 * instead of teal — rgba() wants 0-255 and color() gives 0-1. That is exactly
 * how the entity and action highlight tints came out nearly black behind the
 * glass while looking perfectly correct on the page: the numbers were all
 * there, in the wrong units, and nothing threw.
 *
 * Canvas accepts the whole CSS Color 4 syntax natively — verified,
 * `fillStyle = "color(srgb 0 0.65098 0.588235 / 0.2)"` paints
 * rgba(0,165,150,51) — so pass the computed string THROUGH and extract only the
 * one number actually needed: the alpha, to know whether the paint is worth
 * recording at all.
 */
export function colorAlpha(css: string): number {
  const s = (css || "").trim();
  if (!s || s === "none" || s === "transparent") return 0;
  const rgba = s.match(/^rgba?\(([^)]*)\)$/i);
  if (rgba) {
    const p = rgba[1].split(/[\s,/]+/).filter(Boolean);
    if (p.length > 3) return p[3].endsWith("%") ? parseFloat(p[3]) / 100 : Number(p[3]);
    return 1;
  }
  // color() / lab() / lch() / oklab() / oklch() / hsl() all take `/ <alpha>`.
  const slash = s.match(/\/\s*([\d.]+%?)\s*\)\s*$/);
  if (slash) return slash[1].endsWith("%") ? parseFloat(slash[1]) / 100 : Number(slash[1]);
  return 1;
}

/** Split a CSS list on commas that are not inside parentheses. */
function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Parse ONE `linear-gradient(...)` into a resolvable spec.
 *
 * ★ ONE LAYER. The first version sliced from the first "(" to the LAST ")" of
 * the whole `background-image`, which spans every layer at once — so the
 * two-layer fills the highlight system uses
 * (`linear-gradient(<tint> 0 0), linear-gradient(<page> 0 0)`) parsed as
 * garbage and the entity tags never appeared behind the glass at all. Split the
 * layers first; this only ever sees one.
 */
function parseLinearGradient(layer: string): GradientSpec | null {
  if (!layer.startsWith("linear-gradient")) return null;
  const open = layer.indexOf("(");
  const close = layer.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const parts = splitTopLevel(layer.slice(open + 1, close));
  if (parts.length < 2) {
    // `linear-gradient(<color> 0 0)` collapses to one part in some forms; a
    // single stop is a flat fill, which the caller handles.
    if (parts.length === 1) {
      const only = parts[0].replace(/\s+[\d.]+(px|%)?(\s+[\d.]+(px|%)?)?\s*$/, "").trim();
      if (only) return { deg: 180, stops: [{ at: 0, css: only }, { at: 1, css: only }] };
    }
    return null;
  }

  // ★ THE ANGLE, DONE PROPERLY. Chromium's computed value OMITS the direction
  //   whenever it is the default, so `linear-gradient(180deg, …)`, `to bottom`
  //   and the bare form all arrive with no direction token. Defaulting to
  //   horizontal painted them sideways — measured MAE 7.97/255 against 0.29
  //   over prose. Use the spec's construction instead of guessing an axis.
  let deg = 180;                        // CSS default: to bottom
  let first = 0;
  const head = parts[0].toLowerCase();
  if (/^to\s/.test(head)) {
    first = 1;
    const up = head.includes("top"), down = head.includes("bottom");
    const left = head.includes("left"), right = head.includes("right");
    if ((up || down) && (left || right)) deg = right ? (up ? 45 : 135) : (up ? 315 : 225);
    else if (up) deg = 0;
    else if (right) deg = 90;
    else if (down) deg = 180;
    else if (left) deg = 270;
  } else if (/^[-\d.]+(deg|turn|rad|grad)/.test(head)) {
    first = 1;
    const v = parseFloat(head);
    deg = head.includes("turn") ? v * 360
      : head.includes("rad") ? (v * 180) / Math.PI
      : head.includes("grad") ? v * 0.9
      : v;
  }

  const stopParts = parts.slice(first);
  if (!stopParts.length) return null;

  // ★ ZERO-ALPHA STOPS MUST BORROW THEIR NEIGHBOUR'S COLOUR, or the ramp runs
  //   through grey. CSS interpolates gradients in PREMULTIPLIED alpha; canvas
  //   `createLinearGradient` does not, so CSS's `#eef0f3 → transparent` fades
  //   out staying light while the identical stops on a canvas run toward
  //   `rgba(0,0,0,0)` and pass through rgba(119,120,121,0.5) on the way.
  //   Measured on the running app: one such overlay across the toolbar was
  //   MAE 46.65/255 with 98% of pixels off by more than 32.
  const parsed: Array<{ at: number; css: string; a: number }> = [];
  stopParts.forEach((sp, i) => {
    const pos = sp.match(/([\d.]+)%\s*$/);
    const colour = (pos ? sp.slice(0, pos.index) : sp)
      // A stop may carry lengths rather than percentages ("… 0 0").
      .replace(/\s+[-\d.]+px\s*$/, "").trim();
    const at = pos ? Number(pos[1]) / 100 : stopParts.length === 1 ? i : i / (stopParts.length - 1);
    if (!colour) return;
    parsed.push({
      at: Math.min(1, Math.max(0, at)),
      css: colour,
      a: colorAlpha(colour),
    });
  });
  if (!parsed.length) return null;
  if (parsed.length === 1) parsed.push({ ...parsed[0], at: 1 });

  // A zero-alpha stop borrows its nearest visible neighbour's COLOUR, keeping
  // its own (zero) alpha — the premultiplied-vs-not fix, expressed without
  // taking the colour apart.
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].a > 0.0001) continue;
    let src = -1;
    for (let d = 1; d < parsed.length && src < 0; d++) {
      if (parsed[i - d] && parsed[i - d].a > 0.0001) src = i - d;
      else if (parsed[i + d] && parsed[i + d].a > 0.0001) src = i + d;
    }
    if (src >= 0) parsed[i].css = fadeToZero(parsed[src].css);
  }

  return { deg, stops: parsed.map((q) => ({ at: q.at, css: q.css })) };
}

/**
 * ★ ASK THE BROWSER FOR THE NUMBERS. Any CSS colour, resolved to 8-bit sRGB by
 * painting one pixel and reading it back — exact for every syntax, and the only
 * way to do arithmetic on a colour without knowing which of the dozen CSS
 * Color 4 forms it arrived in. Cached: the app has a few dozen distinct colours
 * and they repeat on every element.
 */
const rgbaCache = new Map<string, [number, number, number, number]>();
let probeCtx: CanvasRenderingContext2D | null = null;

function resolveRgba(css: string): [number, number, number, number] {
  const hit = rgbaCache.get(css);
  if (hit) return hit;
  if (!probeCtx) {
    const c = document.createElement("canvas");
    c.width = 1; c.height = 1;
    probeCtx = c.getContext("2d", { willReadFrequently: true });
  }
  let out: [number, number, number, number] = [0, 0, 0, 1];
  if (probeCtx) {
    probeCtx.clearRect(0, 0, 1, 1);
    probeCtx.fillStyle = "#000";
    probeCtx.fillStyle = css;          // an invalid value leaves the previous one
    probeCtx.fillRect(0, 0, 1, 1);
    const d = probeCtx.getImageData(0, 0, 1, 1).data;
    const a = d[3] / 255;
    out = a > 0 ? [d[0], d[1], d[2], a] : [0, 0, 0, 0];
  }
  rgbaCache.set(css, out);
  return out;
}

/**
 * The same colour with alpha 0.
 *
 * ★ NOT `color-mix(in srgb, X 0%, transparent)`. That is 0% of X and 100% of
 * `transparent` — and `transparent` IS `rgba(0,0,0,0)`, so the hue is thrown
 * away and the ramp runs through grey again, which is the exact bug this
 * function exists to prevent. Measured: it put the toolbar back to MAE 6.01
 * from 0.31. Resolve the numbers and zero the alpha.
 */
function fadeToZero(css: string): string {
  const [r, g, b] = resolveRgba(css);
  return `rgba(${r}, ${g}, ${b}, 0)`;
}

/** Is this gradient one flat colour? Then it is a fill, not a ramp. */
function flatColourOf(g: GradientSpec): string | null {
  const first = g.stops[0]?.css;
  return g.stops.every((s) => s.css === first) ? first ?? null : null;
}

/**
 * Every `background-image` layer, in PAINT order (last first). CSS paints the
 * first layer on top, and a canvas paints in call order, so the list is
 * reversed here and the caller can just iterate.
 */
function parseBgLayers(cs: CSSStyleDeclaration): { layers: BgLayer[]; unsupported: boolean } {
  const raw = cs.backgroundImage;
  if (!raw || raw === "none") return { layers: [], unsupported: false };
  const layers: BgLayer[] = [];
  let unsupported = false;
  for (const layer of splitTopLevel(raw)) {
    const g = parseLinearGradient(layer);
    if (!g) { unsupported = true; continue; }
    const flat = flatColourOf(g);
    layers.push(flat ? { color: flat } : { grad: g });
  }
  layers.reverse();
  return { layers, unsupported };
}

/**
 * `background-size` / `background-position` other than the default would move a
 * layer inside its box, which this painter does not model. Report it rather
 * than silently painting the layer full-bleed.
 */
function hasNonDefaultBgGeometry(cs: CSSStyleDeclaration): boolean {
  const size = (cs.backgroundSize || "auto").trim();
  const pos = (cs.backgroundPosition || "0% 0%").trim();
  const sizeOk = splitTopLevel(size).every((s) => s === "auto" || s === "auto auto" || s === "100% 100%");
  const posOk = splitTopLevel(pos).every((s) => s === "0% 0%" || s === "0px 0px" || s === "left top");
  return !(sizeOk && posOk);
}

// ── Drawing helpers ─────────────────────────────────────────────────────────

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (rr === 0) { ctx.rect(x, y, w, h); return; }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Build the canvas gradient for a layer, in the replay's local coordinates. */
function makeGradient(
  ctx: CanvasRenderingContext2D, g: GradientSpec, b: Box, ox: number, oy: number,
): CanvasGradient | null {
  // Spec construction: for angle A over W×H the gradient line runs along
  // (sin A, −cos A) through the centre, length |W·sin A| + |H·cos A|.
  const a = ((g.deg % 360) + 360) % 360;
  const rad = (a * Math.PI) / 180;
  const dx = Math.sin(rad), dy = -Math.cos(rad);
  const len = Math.abs(b.w * dx) + Math.abs(b.h * dy);
  const cx = b.x - ox + b.w / 2, cy = b.y - oy + b.h / 2;
  const grad = ctx.createLinearGradient(
    cx - (dx * len) / 2, cy - (dy * len) / 2,
    cx + (dx * len) / 2, cy + (dy * len) / 2);
  let ok = 0;
  for (const s of g.stops) {
    try { grad.addColorStop(s.at, s.css); ok++; } catch { /* unparseable */ }
  }
  return ok >= 2 ? grad : null;
}

/**
 * ★ WHERE THE BASELINE ACTUALLY IS, MEASURED — not derived from font metrics.
 *
 * `lineBox.top + halfLeading + fontBoundingBoxAscent` is the textbook
 * construction and is wrong by one device pixel on every surface: canvas's font
 * metrics and the ascent the layout engine uses to position a line box are not
 * obliged to agree. Ask the browser instead — an empty inline-block with
 * `vertical-align: baseline` has zero height, so its box top IS the baseline.
 * Cached per (font, line-height); the registration test caught this at
 * MAE 6.09 → 0.03.
 */
const baselineCache = new Map<string, number>();

function baselineOffset(el: Element, cs: CSSStyleDeclaration, lineTop: number): number {
  const key = `${cs.font}|${cs.lineHeight}|${cs.fontSize}`;
  const hit = baselineCache.get(key);
  if (hit !== undefined) return hit;

  const marker = document.createElement("span");
  marker.style.cssText =
    "display:inline-block;width:0;height:0;vertical-align:baseline;padding:0;margin:0;border:0";
  el.insertBefore(marker, el.firstChild);
  const top = marker.getBoundingClientRect().top;
  el.removeChild(marker);

  const off = top - lineTop;
  if (!Number.isFinite(off) || off < 0 || off > parseFloat(cs.fontSize) * 3) return NaN;
  baselineCache.set(key, off);
  return off;
}

/**
 * ★ SPLIT A TEXT NODE INTO ITS LINE BOXES.
 *
 * `Range.getClientRects()` gives one rect per line box but not the text in it,
 * and the whole point of a text backdrop is that the glyphs land where the
 * browser put them. Find the offsets where the rect count increments by BINARY
 * SEARCH rather than by walking every character.
 */
interface SplitCache { data: string; lines: number; wrapWidth: number; breaks: number[] }
const splitCache = new WeakMap<Text, SplitCache>();

function lineBoxes(node: Text, range: Range): { boxes: Array<[string, DOMRect]>; ops: number } {
  const s = node.data;
  const n = s.length;
  range.selectNodeContents(node);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0.01 && r.height > 0.01);
  let ops = 1;
  if (rects.length === 0) return { boxes: [], ops };
  if (rects.length === 1) return { boxes: [[s, rects[0]]], ops };

  // ★ THE SPLIT OFFSETS DO NOT MOVE WHEN THE PAGE SCROLLS — only the rects do.
  //
  //   Finding where a text node breaks across lines costs O(lines × log chars)
  //   Range measurements, and each one forces layout. Doing that every frame
  //   for every visible paragraph was 5.2 ms of a 16.7 ms budget, which is
  //   what kept the glass from refreshing on every frame.
  //
  //   Scrolling changes none of it: the same characters break in the same
  //   places, at new coordinates. So cache the offsets against the three things
  //   that WOULD change them — the text, how many lines it occupies, and the
  //   width it wraps in — and on a hit the whole search collapses to the single
  //   `getClientRects()` above.
  const wrapWidth = Math.round((node.parentElement?.clientWidth ?? 0) * 10) / 10;
  const hit = splitCache.get(node);
  if (hit && hit.data === s && hit.lines === rects.length && hit.wrapWidth === wrapWidth) {
    const cached: Array<[string, DOMRect]> = [];
    for (let i = 0; i < rects.length; i++) {
      const t = s.slice(hit.breaks[i], hit.breaks[i + 1]);
      if (t.trim()) cached.push([t, rects[i]]);
    }
    return { boxes: cached, ops };
  }

  const countUpTo = (i: number): number => {
    range.setStart(node, 0);
    range.setEnd(node, i);
    ops++;
    return [...range.getClientRects()].filter((r) => r.width > 0.01 && r.height > 0.01).length;
  };

  const breaks: number[] = [0];
  for (let line = 1; line < rects.length; line++) {
    let lo = breaks[breaks.length - 1], hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (countUpTo(mid) > line) hi = mid; else lo = mid + 1;
    }
    breaks.push(lo - 1 < breaks[breaks.length - 1] ? breaks[breaks.length - 1] : lo - 1);
  }
  breaks.push(n);
  splitCache.set(node, { data: s, lines: rects.length, wrapWidth, breaks });

  const boxes: Array<[string, DOMRect]> = [];
  for (let i = 0; i < rects.length; i++) {
    const t = s.slice(breaks[i], breaks[i + 1]);
    if (t.trim()) boxes.push([t, rects[i]]);
  }
  return { boxes, ops };
}

// ── Building the display list ───────────────────────────────────────────────

export interface BuildOptions {
  /** Region of interest, in viewport CSS px. Nothing outside it is recorded. */
  region: { x: number; y: number; w: number; h: number };
  /** Elements to treat as invisible, subtree included. */
  exclude?: (el: Element) => boolean;
  /** Root to walk. Defaults to document.body. */
  root?: Element;
  /** Record every op into `stats.ops`. Diagnostic only. */
  debug?: boolean;
}

const emptyStats = (): ReconstructStats => ({
  ms: 0, rects: 0, gradients: 0, borders: 0, lines: 0, glyphs: 0,
  skipped: {}, unpaintable: 0, unpaintableWhy: [], blits: 0,
  visited: 0, pruned: 0, rangeOps: 0,
});

const boxOf = (r: DOMRect): Box => ({ x: r.left, y: r.top, w: r.width, h: r.height });
const overlaps = (a: Box, b: Box) =>
  a.x + a.w > b.x && a.x < b.x + b.w && a.y + a.h > b.y && a.y < b.y + b.h;
const unionBox = (boxes: Box[]): Box => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
};

/**
 * Walk the DOM once and record everything paintable inside `region`, in
 * viewport coordinates. Nothing here touches a canvas.
 */
export function buildDisplayList(opts: BuildOptions): DisplayList {
  const t0 = performance.now();
  const region: Box = { x: opts.region.x, y: opts.region.y, w: opts.region.w, h: opts.region.h };
  const exclude = opts.exclude ?? (() => false);
  const root = opts.root ?? document.body;
  const stats = emptyStats();
  if (opts.debug) stats.ops = [];

  const ops: Op[] = [];
  const unpaintables: DisplayList["unpaintables"] = [];
  const skip = (why: string) => { stats.skipped[why] = (stats.skipped[why] || 0) + 1; };
  const note = (el: Element, b: Box, kind: string, paint: string) => {
    if (!stats.ops) return;
    stats.ops.push({
      el: describe(el),
      rect: [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)],
      kind, paint: paint.slice(0, 60), area: Math.round(b.w * b.h),
    });
  };
  const flagUnpaintable = (el: Element, b: Box, why: string) => {
    unpaintables.push({ el, bbox: b, why });
    stats.unpaintable++;
    if (stats.unpaintableWhy.length < 8) stats.unpaintableWhy.push(`${describe(el)}: ${why}`);
  };

  const rootBg = getComputedStyle(document.documentElement).backgroundColor;
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const baseColor = /rgba\(0, 0, 0, 0\)|transparent/.test(bodyBg) ? rootBg : bodyBg;

  const range = document.createRange();

  // ★ DOM ORDER, NOT PAINT ORDER. A faithful painter would resolve stacking
  // contexts and z-index; this walks the tree and records as it goes, which is
  // correct only while the backdrop does not overlap itself out of order.
  const walk = (el: Element): void => {
    if (exclude(el)) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const alpha = Number(cs.opacity);
    if (!(alpha > 0.004)) return;
    const r = el.getBoundingClientRect();
    // ★ PRUNE A SUBTREE THAT CANNOT REACH THE REGION.
    //
    //   The earlier version only pruned when `overflow` was not visible, which
    //   in a normal document is almost never — so the walk descended into every
    //   paragraph of the chapter to find the two lines that sit under the
    //   toolbar. That was the bulk of a 5ms display list.
    //
    //   A laid-out element with a non-empty box bounds its in-flow children, so
    //   if its box misses the region its subtree does too. The exception is a
    //   positioned descendant escaping the box, which `contain` cannot tell us
    //   about cheaply — so this is a heuristic, and it is gated by measurement
    //   rather than by argument: scripts/probe-glass-real-app.cjs reports the
    //   reconstruction error against real screenshots, and it did not move.
    if ((r.width > 0 || r.height > 0) && !overlaps(boxOf(r), region)) {
      stats.pruned++;
      return;
    }
    stats.visited++;

    const bb = boxOf(r);
    if (overlaps(bb, region) && r.width > 0.01 && r.height > 0.01) {
      const reasons: string[] = [];
      for (const [why, test] of UNSUPPORTED) if (test(cs, el)) { skip(why); reasons.push(why); }

      // ★ A NESTED CANVAS IS BLITTED, NOT APPROXIMATED. The intelligence orb and
      //   any glass surface already claimed by this engine both paint into
      //   canvases, and drawImage reproduces them exactly.
      if (el instanceof HTMLCanvasElement) {
        if (el.width > 0 && el.height > 0) {
          if (cs.transform === "none") {
            ops.push({ k: "blit", el, bbox: bb, alpha, src: el });
            stats.blits++;
            note(el, bb, "blit", `${el.width}x${el.height}`);
          } else {
            flagUnpaintable(el, bb, "transformed canvas");
          }
        }
        return;   // its children are fallback content and never paint
      }

      // ★ THE GATE, evaluated on what this element actually PAINTS. A mask on an
      //   empty box costs nothing and must not disqualify a surface.
      if (reasons.length && paintsSomething(el, cs)) {
        flagUnpaintable(el, bb, reasons.join("+"));
      }

      // ── Background: colour underneath, then every image layer.
      //
      // ★ PER LINE BOX FOR INLINE ELEMENTS. `.entity-tag` is `display: inline`
      //   with `box-decoration-break: clone`, so a mention that wraps paints its
      //   fill on EACH line. `getBoundingClientRect` returns the union of those
      //   lines — a single rectangle spanning the whole paragraph — which would
      //   have painted a slab of tint across the prose.
      const boxes: Box[] = cs.display.startsWith("inline")
        ? [...el.getClientRects()].filter((b) => b.width > 0.01 && b.height > 0.01).map(boxOf)
        : [bb];
      if (boxes.length) {
        const radius = parseFloat(cs.borderTopLeftRadius) || 0;
        const { layers, unsupported } = parseBgLayers(cs);
        if (unsupported) skip("bg-image");
        if (unsupported && paintsSomething(el, cs)) {
          flagUnpaintable(el, bb, "background-image this painter cannot express");
        }
        if (layers.length && hasNonDefaultBgGeometry(cs)) {
          skip("bg-geometry");
          flagUnpaintable(el, bb, "background-size/position");
        }
        const color = colorAlpha(cs.backgroundColor) > 0.004 ? cs.backgroundColor : null;

        if (color || layers.length) {
          ops.push({
            k: "bg", el, bbox: unionBox(boxes), alpha, radius, boxes, color, layers,
          });
          if (color) stats.rects++;
          stats.gradients += layers.length;
          note(el, bb, "bg", `${color ?? ""} +${layers.length} layer(s)`);
        }
      }

      // ── Borders, per EDGE: the app's marks are one-sided, and a uniform
      //    stroke would draw three edges that are not there.
      const edges: Array<[string, string, string, number, number, number, number]> = [
        ["top", cs.borderTopWidth, cs.borderTopColor, r.left, r.top, r.right, r.top],
        ["bottom", cs.borderBottomWidth, cs.borderBottomColor, r.left, r.bottom, r.right, r.bottom],
        ["left", cs.borderLeftWidth, cs.borderLeftColor, r.left, r.top, r.left, r.bottom],
        ["right", cs.borderRightWidth, cs.borderRightColor, r.right, r.top, r.right, r.bottom],
      ];
      const segs: Array<{ x1: number; y1: number; x2: number; y2: number; w: number; color: string }> = [];
      for (const [side, wRaw, colour, x1, y1, x2, y2] of edges) {
        const bw = parseFloat(wRaw);
        if (!(bw > 0)) continue;
        if (cs.getPropertyValue(`border-${side}-style`) !== "solid") {
          skip(`border-${cs.getPropertyValue(`border-${side}-style`)}`);
          continue;
        }
        if (colorAlpha(colour) <= 0.004) continue;
        // The border box sits INSIDE the rect, so each edge's centre line is
        // half a border-width in from the boundary.
        const ix = side === "left" ? bw / 2 : side === "right" ? -bw / 2 : 0;
        const iy = side === "top" ? bw / 2 : side === "bottom" ? -bw / 2 : 0;
        segs.push({ x1: x1 + ix, y1: y1 + iy, x2: x2 + ix, y2: y2 + iy, w: bw, color: colour });
      }
      if (segs.length) {
        ops.push({ k: "border", el, bbox: bb, alpha, segs });
        stats.borders += segs.length;
      }
    }

    // ── Text this element owns, recorded where the browser laid it out.
    for (const n of el.childNodes) {
      if (n.nodeType !== 3) continue;
      const text = n as Text;
      if (!text.data.trim()) continue;
      range.selectNodeContents(text);
      stats.rangeOps++;
      const tb = range.getBoundingClientRect();
      if (!overlaps(boxOf(tb), region)) continue;
      const { boxes: lines, ops: rangeOps } = lineBoxes(text, range);
      stats.rangeOps += rangeOps;
      if (!lines.length) continue;

      let off = baselineOffset(el, cs, lines[0][1].top);
      if (!Number.isFinite(off)) {
        // Fallback: the metric construction, one device pixel out but better
        // than not drawing the text at all.
        off = lines[0][1].height * 0.8;
      }
      const runs = lines
        .filter(([, br]) => overlaps(boxOf(br), region))
        .map(([t, br]) => ({ t, x: br.left, y: br.top + off, w: br.width, h: br.height }));
      if (!runs.length) continue;
      const ls = parseFloat(cs.letterSpacing);
      ops.push({
        k: "text", el,
        bbox: unionBox(runs.map((q) => ({ x: q.x, y: q.y - q.h, w: q.w, h: q.h * 2 }))),
        alpha,
        font: cs.font || `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`,
        color: cs.color,
        ls: Number.isFinite(ls) ? ls : 0,
        runs,
      });
      stats.lines += runs.length;
      for (const q of runs) stats.glyphs += q.t.length;
    }

    for (const child of el.children) walk(child);
  };

  walk(root);
  range.detach();
  stats.ms = performance.now() - t0;
  return { ops, unpaintables, baseColor, stats };
}

// ── Replaying it into one surface ───────────────────────────────────────────

export interface ReplayResult {
  ms: number;
  drawn: number;
  /** Unpaintable elements that actually overlap THIS surface. */
  unpaintable: number;
  unpaintableWhy: string[];
}

/**
 * Draw the part of `list` that lands under `rect` into `canvas`.
 *
 * `excludeRoot` is the glass surface itself: its own subtree paints OVER the
 * glass and is never part of its backdrop, and its own canvas would be a
 * feedback loop.
 */
export function paintDisplayList(
  canvas: HTMLCanvasElement,
  list: DisplayList,
  rect: { x: number; y: number; w: number; h: number },
  dpr: number,
  excludeRoot: Element | null,
): ReplayResult {
  const t0 = performance.now();
  const W = Math.max(1, Math.round(rect.w * dpr));
  const H = Math.max(1, Math.round(rect.h * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = list.baseColor;
  ctx.fillRect(0, 0, rect.w, rect.h);

  const ox = rect.x, oy = rect.y;
  const region: Box = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  const mine = (el: Element) =>
    excludeRoot !== null && (el === excludeRoot || excludeRoot.contains(el));

  let drawn = 0;
  for (const op of list.ops) {
    if (!overlaps(op.bbox, region)) continue;
    if (mine(op.el)) continue;
    ctx.globalAlpha = op.alpha;
    switch (op.k) {
      case "bg": {
        for (const b of op.boxes) {
          if (!overlaps(b, region)) continue;
          if (op.color) {
            ctx.fillStyle = op.color;
            roundRect(ctx, b.x - ox, b.y - oy, b.w, b.h, op.radius);
            ctx.fill();
          }
          for (const layer of op.layers) {
            const style = layer.color
              ? layer.color
              : layer.grad ? makeGradient(ctx, layer.grad, b, ox, oy) : null;
            if (!style) continue;
            ctx.fillStyle = style;
            roundRect(ctx, b.x - ox, b.y - oy, b.w, b.h, op.radius);
            ctx.fill();
          }
        }
        break;
      }
      case "border": {
        for (const s of op.segs) {
          ctx.strokeStyle = s.color;
          ctx.lineWidth = s.w;
          ctx.beginPath();
          ctx.moveTo(s.x1 - ox, s.y1 - oy);
          ctx.lineTo(s.x2 - ox, s.y2 - oy);
          ctx.stroke();
        }
        break;
      }
      case "text": {
        ctx.fillStyle = op.color;
        ctx.font = op.font;
        ctx.letterSpacing = op.ls ? `${op.ls}px` : "0px";
        ctx.textBaseline = "alphabetic";
        for (const q of op.runs) {
          if (q.x > rect.x + rect.w || q.x + q.w < rect.x) continue;
          ctx.fillText(q.t, q.x - ox, q.y - oy);
        }
        break;
      }
      case "blit": {
        try {
          ctx.drawImage(op.src, op.bbox.x - ox, op.bbox.y - oy, op.bbox.w, op.bbox.h);
        } catch { /* lost or tainted context */ }
        break;
      }
    }
    drawn++;
  }
  ctx.globalAlpha = 1;
  ctx.letterSpacing = "0px";
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  let unpaintable = 0;
  const why: string[] = [];
  for (const u of list.unpaintables) {
    if (!overlaps(u.bbox, region)) continue;
    if (mine(u.el)) continue;
    unpaintable++;
    if (why.length < 4) why.push(`${describe(u.el)}: ${u.why}`);
  }

  return { ms: performance.now() - t0, drawn, unpaintable, unpaintableWhy: why };
}

// ── Compatibility: build + paint in one call ────────────────────────────────

export interface ReconstructOptions {
  /** Region to rasterise, in viewport CSS px. */
  rect: { x: number; y: number; w: number; h: number };
  /** Device pixel ratio to paint at. */
  dpr: number;
  /** Elements to treat as invisible — the glass surface itself, and its kin. */
  exclude?: (el: Element) => boolean;
  /** Root to walk. Defaults to document.body. */
  root?: Element;
  /** Record every paint op into `stats.ops`. Diagnostic only. */
  debug?: boolean;
}

/**
 * Reconstruct one region on its own. The engine uses the two-phase path — one
 * `buildDisplayList` shared by every surface — but the harnesses and the lab
 * measure a single region, and this keeps that a one-liner.
 */
export function reconstructBackdrop(
  canvas: HTMLCanvasElement,
  opts: ReconstructOptions,
): ReconstructStats {
  const list = buildDisplayList({
    region: opts.rect, exclude: opts.exclude, root: opts.root, debug: opts.debug,
  });
  const res = paintDisplayList(canvas, list, opts.rect, opts.dpr, null);
  const stats = list.stats;
  stats.ms += res.ms;
  return stats;
}
