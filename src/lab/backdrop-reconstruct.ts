/**
 * backdrop-reconstruct.ts — SANDBOX. Not imported by the app.
 *
 * ─── THE QUESTION THIS EXISTS TO ANSWER ──────────────────────────────────────
 *
 * `KnobGlass` refracts properly because it RECONSTRUCTS its backdrop: it reads
 * the track and the panel out of the live DOM and repaints them into a canvas,
 * then refracts those pixels per pixel in float. That works because the only
 * thing under a knob is a rounded rect on a flat fill.
 *
 * Every other glass surface in this app sits over something harder. The census
 * (scripts/probe-glass-backdrops.cjs) says what: a flat page fill under the
 * toolbar, and LIVE PROSE under everything that opens over the editor. So the
 * reconstruction problem for this app is not "rasterise arbitrary DOM" — it is
 * "rects, gradients, and text in the app's own fonts". That is a much smaller
 * problem, and this module is the test of whether it is small enough.
 *
 * ★ IT ONLY EVER RASTERISES THE CLIP REGION. The glass rect plus the
 * refraction's reach, nothing else. A surface is small and a chapter is long,
 * so bounding the work by the SURFACE rather than by the document is what keeps
 * this affordable — a 26x73 tab over prose touches four line boxes, not four
 * hundred.
 *
 * ★ WHAT IT DELIBERATELY DOES NOT DO. It is not a CSS engine. No stacking
 * contexts, no transforms, no box-shadows, no blend modes, no filters on the
 * backdrop elements, no background-image except linear-gradient. Every one of
 * those is a real limitation and the harness measures what they cost in pixels
 * rather than leaving them as a caveat in a comment.
 */

export interface ReconstructStats {
  /** Wall-clock for the whole reconstruction, ms. */
  ms: number;
  /** How many elements painted a background. */
  rects: number;
  /** How many gradient fills were painted. */
  gradients: number;
  /** How many borders were stroked. */
  borders: number;
  /** How many line boxes of text were drawn. */
  lines: number;
  /** How many glyphs were drawn. */
  glyphs: number;
  /** Elements skipped because this painter cannot express them, by reason. */
  skipped: Record<string, number>;
  /** Range measurements spent finding line-box splits — the text path's cost. */
  rangeOps: number;
  /**
   * Every paint op, when `debug` is set. A count of what the painter skipped
   * says nothing about what it wrongly DREW, and the first whole-surface
   * failure on the real app was the latter — so the log records both sides.
   */
  ops?: Array<{ el: string; rect: number[]; kind: string; paint: string; area: number }>;
}

/** Everything the painter cannot express, so the harness can count it. */
const UNSUPPORTED: Array<[string, (cs: CSSStyleDeclaration, el: Element) => boolean]> = [
  ["transform", (cs) => cs.transform !== "none"],
  ["filter", (cs) => cs.filter !== "none"],
  ["box-shadow", (cs) => cs.boxShadow !== "none"],
  ["blend-mode", (cs) => cs.mixBlendMode !== "normal"],
  ["mask", (cs) => cs.maskImage !== "none" && cs.maskImage !== ""],
  ["bg-image", (cs) => cs.backgroundImage !== "none" && !cs.backgroundImage.includes("gradient")],
  ["replaced", (_cs, el) => ["IMG", "CANVAS", "VIDEO", "SVG", "svg"].includes(el.tagName)],
];

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

/**
 * Parse the linear-gradients the app actually paints with. Same scope as
 * KnobGlass's parser and for the same reason: this is a backdrop reproduction,
 * not a CSS engine. Anything exotic returns null and the caller counts it as
 * skipped rather than guessing.
 */
function linearGradient(
  ctx: CanvasRenderingContext2D,
  bgImage: string, r: DOMRect, ox: number, oy: number,
): CanvasGradient | null {
  if (!bgImage.startsWith("linear-gradient")) return null;
  const body = bgImage.slice(bgImage.indexOf("(") + 1, bgImage.lastIndexOf(")"));
  const parts: string[] = [];
  let depth = 0, cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  if (parts.length < 2) return null;

  // ★ THE ANGLE, DONE PROPERLY — because guessing an axis is what broke this.
  //
  // The first version read the leading token and, finding none, defaulted to a
  // HORIZONTAL gradient. Chromium's computed value omits the direction whenever
  // it is the default, so `linear-gradient(180deg, …)`, `to bottom` and the
  // bare form all arrive here as `linear-gradient(rgb(…), rgb(…))` — and every
  // one of them got painted sideways. Measured on a surface sitting entirely on
  // one: MAE 7.97/255 against 0.29 over prose, a 27x difference, and clearly
  // wrong once looked at.
  //
  // So use the spec's construction instead of an axis guess. For angle A
  // (0 = to top, clockwise) over a W×H box the gradient line runs along
  // (sin A, −cos A) through the centre, with length |W·sin A| + |H·cos A|.
  // That is exact for every angle, not just the four axis-aligned ones.
  const W = r.width, H = r.height;
  let deg = 180;                        // CSS default: to bottom
  let first = 0;
  const head = parts[0].toLowerCase().trim();
  if (/^to\s/.test(head)) {
    first = 1;
    const up = head.includes("top"), down = head.includes("bottom");
    const left = head.includes("left"), right = head.includes("right");
    if ((up || down) && (left || right)) {
      // A corner: the gradient line is perpendicular to the diagonal joining
      // the two neighbouring corners, which is atan2(W, H) from vertical.
      const base = (Math.atan2(W, H) * 180) / Math.PI;
      deg = right ? (up ? base : 180 - base) : (up ? -base : 180 + base);
    } else if (up) deg = 0;
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
  if (stopParts.length < 2) return null;

  const a = ((deg % 360) + 360) % 360;
  const rad = (a * Math.PI) / 180;
  const dx = Math.sin(rad), dy = -Math.cos(rad);
  const len = Math.abs(W * dx) + Math.abs(H * dy);
  const cx = r.left - ox + W / 2, cy = r.top - oy + H / 2;
  const g = ctx.createLinearGradient(
    cx - (dx * len) / 2, cy - (dy * len) / 2,
    cx + (dx * len) / 2, cy + (dy * len) / 2);
  // ★ ZERO-ALPHA STOPS MUST BORROW THEIR NEIGHBOUR'S COLOUR, or the ramp runs
  //   through grey.
  //
  //   CSS interpolates gradients in PREMULTIPLIED alpha; canvas
  //   `createLinearGradient` interpolates NON-premultiplied. CSS's
  //   `#eef0f3 → transparent` therefore fades out staying light, while the
  //   identical stops on a canvas run toward `rgba(0,0,0,0)` and pass through
  //   rgba(119,120,121,0.5) on the way.
  //
  //   Measured on the running app: `.scroll-edge-top-overlay` is exactly this
  //   gradient, it covers the whole toolbar, and it alone put that surface's
  //   reconstruction at MAE 46.65/255 with 98% of pixels off by more than 32.
  //   The "cannot express" counters said nothing, because the painter did not
  //   skip it — it drew it wrong, which is the failure mode a skip-counter is
  //   blind to.
  //
  //   `transparent` is `rgba(0, 0, 0, 0)` and only its ALPHA carries meaning.
  //   Rewriting each zero-alpha stop to the nearest visible neighbour's RGB
  //   makes the non-premultiplied ramp trace the premultiplied one's path.
  const parsed: Array<{ at: number; rgb: string; a: number }> = [];
  stopParts.forEach((sp, i) => {
    const pos = sp.match(/([\d.]+)%\s*$/);
    const at = pos ? Number(pos[1]) / 100 : i / (stopParts.length - 1);
    const colour = (pos ? sp.slice(0, pos.index) : sp).trim();
    if (!colour) return;
    const m = colour.match(/[\d.]+/g);
    const isRgb = /^rgba?\(/.test(colour) && !!m && m.length >= 3;
    parsed.push({
      at: Math.min(1, Math.max(0, at)),
      rgb: isRgb ? `${m![0]}, ${m![1]}, ${m![2]}` : colour,
      a: colour === "transparent" ? 0 : isRgb && m!.length > 3 ? Number(m![3]) : 1,
    });
  });
  if (parsed.length < 2) return null;
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].a > 0.0001) continue;
    let src = -1;
    for (let d = 1; d < parsed.length && src < 0; d++) {
      if (parsed[i - d] && parsed[i - d].a > 0.0001) src = i - d;
      else if (parsed[i + d] && parsed[i + d].a > 0.0001) src = i + d;
    }
    if (src >= 0) parsed[i].rgb = parsed[src].rgb;
  }

  let ok = 0;
  for (const s of parsed) {
    const css = /^[\d.]+\s*,/.test(s.rgb) ? `rgba(${s.rgb}, ${s.a})` : s.rgb;
    try { g.addColorStop(s.at, css); ok++; } catch { /* unparseable stop */ }
  }
  return ok >= 2 ? g : null;
}

/**
 * ★ WHERE THE BASELINE ACTUALLY IS, MEASURED — not derived from font metrics.
 *
 * The first version put the baseline at `lineBox.top + halfLeading +
 * fontBoundingBoxAscent`, which is the textbook construction and is wrong by
 * one device pixel on every surface. The registration test caught it: the
 * reconstruction's best alignment against the real page was (0, 1), not (0, 0),
 * on all five sizes. Canvas's `fontBoundingBoxAscent` and the ascent the layout
 * engine uses to position a line box are not obliged to agree, and here they
 * differ by half a CSS pixel.
 *
 * So ask the browser instead. An empty inline-block with `vertical-align:
 * baseline` has zero height, so its box top IS the baseline of the line it sits
 * on. Measure that once per (font, line-height) and cache the offset from the
 * line box's top; every later line of the same font reuses the number without
 * touching the DOM.
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

  // The marker sits on the FIRST line, so the offset is relative to that line's
  // top — which is what the caller passes in.
  const off = top - lineTop;
  // A nonsense reading (the element had no line box, or the marker wrapped)
  // must not be cached; fall back to the metric construction for this call.
  if (!Number.isFinite(off) || off < 0 || off > parseFloat(cs.fontSize) * 3) return NaN;
  baselineCache.set(key, off);
  return off;
}

/**
 * ★ SPLIT A TEXT NODE INTO ITS LINE BOXES.
 *
 * `Range.getClientRects()` gives one rect per line box but not the text in it,
 * and the whole point of a text backdrop is that the glyphs land where the
 * browser put them. So find the offsets where the rect count increments, by
 * BINARY SEARCH rather than by walking every character: a paragraph is a few
 * hundred chars across a handful of lines, which is log(n) measurements per
 * break instead of n.
 *
 * Returns [text, rect] pairs and the number of Range measurements it cost —
 * the harness reports that, because it is the text path's whole expense.
 */
function lineBoxes(node: Text, range: Range): { boxes: Array<[string, DOMRect]>; ops: number } {
  const s = node.data;
  const n = s.length;
  range.selectNodeContents(node);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0.01 && r.height > 0.01);
  let ops = 1;
  if (rects.length === 0) return { boxes: [], ops };
  if (rects.length === 1) return { boxes: [[s, rects[0]]], ops };

  const countUpTo = (i: number): number => {
    range.setStart(node, 0);
    range.setEnd(node, i);
    ops++;
    return [...range.getClientRects()].filter((r) => r.width > 0.01 && r.height > 0.01).length;
  };

  const breaks: number[] = [0];
  for (let line = 1; line < rects.length; line++) {
    // First offset whose prefix already spans `line + 1` boxes.
    let lo = breaks[breaks.length - 1], hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (countUpTo(mid) > line) hi = mid; else lo = mid + 1;
    }
    breaks.push(lo - 1 < breaks[breaks.length - 1] ? breaks[breaks.length - 1] : lo - 1);
  }
  breaks.push(n);

  const boxes: Array<[string, DOMRect]> = [];
  for (let i = 0; i < rects.length; i++) {
    const t = s.slice(breaks[i], breaks[i + 1]);
    if (t.trim()) boxes.push([t, rects[i]]);
  }
  return { boxes, ops };
}

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
 * Paint everything under `rect` into `canvas`, and report what it cost and what
 * it could not express.
 */
export function reconstructBackdrop(
  canvas: HTMLCanvasElement,
  opts: ReconstructOptions,
): ReconstructStats {
  const t0 = performance.now();
  const { rect, dpr } = opts;
  const exclude = opts.exclude ?? (() => false);
  const root = opts.root ?? document.body;

  const W = Math.max(1, Math.round(rect.w * dpr));
  const H = Math.max(1, Math.round(rect.h * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.w, rect.h);

  const stats: ReconstructStats = {
    ms: 0, rects: 0, gradients: 0, borders: 0, lines: 0, glyphs: 0, skipped: {}, rangeOps: 0,
  };
  const skip = (why: string) => { stats.skipped[why] = (stats.skipped[why] || 0) + 1; };
  if (opts.debug) stats.ops = [];
  const note = (el: Element, r: DOMRect, kind: string, paint: string) => {
    if (!stats.ops) return;
    stats.ops.push({
      el: el.tagName.toLowerCase() + "." +
        (el.className || "").toString().split(/\s+/).filter(Boolean).slice(0, 2).join("."),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      kind, paint: paint.slice(0, 60), area: Math.round(r.width * r.height),
    });
  };

  // The page's own base tone, so the region starts from what the document
  // paints rather than from transparent.
  const rootBg = getComputedStyle(document.documentElement).backgroundColor;
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  ctx.fillStyle = /rgba\(0, 0, 0, 0\)|transparent/.test(bodyBg) ? rootBg : bodyBg;
  ctx.fillRect(0, 0, rect.w, rect.h);

  const ox = rect.x, oy = rect.y;
  const hit = (r: DOMRect) =>
    r.right > ox && r.left < ox + rect.w && r.bottom > oy && r.top < oy + rect.h;

  const range = document.createRange();

  // ★ DOM ORDER, NOT PAINT ORDER. A faithful painter would resolve stacking
  // contexts and z-index; this walks the tree and paints as it goes, which is
  // correct only while the backdrop does not overlap itself out of order. The
  // harness reports how often that assumption is violated rather than this
  // comment claiming it holds.
  const walk = (el: Element): void => {
    if (exclude(el)) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const alpha = Number(cs.opacity);
    if (!(alpha > 0.004)) return;
    const r = el.getBoundingClientRect();
    // An element whose whole subtree is outside the region cannot contribute —
    // except when it does not bound its children (rare), so only prune when the
    // element has a layout box at all.
    if ((r.width > 0 || r.height > 0) && !hit(r) && cs.overflow !== "visible") return;

    if (hit(r) && r.width > 0.01 && r.height > 0.01) {
      for (const [why, test] of UNSUPPORTED) if (test(cs, el)) skip(why);

      const radius = parseFloat(cs.borderTopLeftRadius) || 0;
      const grad = cs.backgroundImage.includes("gradient")
        ? linearGradient(ctx, cs.backgroundImage, r, ox, oy) : null;
      if (grad) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = grad;
        roundRect(ctx, r.left - ox, r.top - oy, r.width, r.height, radius);
        ctx.fill();
        ctx.restore();
        stats.gradients++;
        note(el, r, "gradient", cs.backgroundImage);
      } else {
        const m = (cs.backgroundColor || "").match(/[\d.]+/g);
        const bgA = m && m.length > 3 ? Number(m[3]) : m ? 1 : 0;
        if (m && bgA > 0.004) {
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.fillStyle = `rgba(${m[0]}, ${m[1]}, ${m[2]}, ${bgA})`;
          roundRect(ctx, r.left - ox, r.top - oy, r.width, r.height, radius);
          ctx.fill();
          ctx.restore();
          stats.rects++;
          note(el, r, "fill", `${cs.backgroundColor} @${alpha}`);
        }
      }

      // ★ BORDERS, WHICH THE FIRST VERSION SIMPLY DID NOT PAINT. The residual
      //   error on the panel surface was a max of 123/255 on flat pixels, and
      //   it was the prose's 1.5px `border-bottom` underline — an analysis mark
      //   the app paints under real text. Per-EDGE, because the app's marks are
      //   one-sided; a uniform stroke would have drawn three edges that are not
      //   there. Only solid borders: dashed/dotted are counted as unsupported
      //   rather than approximated.
      const edges: Array<[string, string, string, number, number, number, number]> = [
        ["Top", cs.borderTopWidth, cs.borderTopColor, r.left, r.top, r.right, r.top],
        ["Bottom", cs.borderBottomWidth, cs.borderBottomColor, r.left, r.bottom, r.right, r.bottom],
        ["Left", cs.borderLeftWidth, cs.borderLeftColor, r.left, r.top, r.left, r.bottom],
        ["Right", cs.borderRightWidth, cs.borderRightColor, r.right, r.top, r.right, r.bottom],
      ];
      for (const [side, wRaw, colour, x1, y1, x2, y2] of edges) {
        const bw = parseFloat(wRaw);
        if (!(bw > 0)) continue;
        const style = cs.getPropertyValue(`border-${side.toLowerCase()}-style`);
        if (style !== "solid") { skip(`border-${style}`); continue; }
        const cm = (colour || "").match(/[\d.]+/g);
        if (!cm || (cm.length > 3 && Number(cm[3]) <= 0.004)) continue;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = colour;
        ctx.lineWidth = bw;
        // The border box sits INSIDE the element's rect, so each edge's centre
        // line is half a border-width in from the boundary.
        const ix = side === "Left" ? bw / 2 : side === "Right" ? -bw / 2 : 0;
        const iy = side === "Top" ? bw / 2 : side === "Bottom" ? -bw / 2 : 0;
        ctx.beginPath();
        ctx.moveTo(x1 - ox + ix, y1 - oy + iy);
        ctx.lineTo(x2 - ox + ix, y2 - oy + iy);
        ctx.stroke();
        ctx.restore();
        stats.borders++;
      }
    }

    // Text this element owns, drawn where the browser laid it out.
    for (const n of el.childNodes) {
      if (n.nodeType !== 3) continue;
      const text = n as Text;
      if (!text.data.trim()) continue;
      range.selectNodeContents(text);
      stats.rangeOps++;
      const bb = range.getBoundingClientRect();
      if (!hit(bb)) continue;
      const { boxes, ops } = lineBoxes(text, range);
      stats.rangeOps += ops;
      if (!boxes.length) continue;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = cs.color;
      ctx.font = cs.font || `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`;
      const ls = parseFloat(cs.letterSpacing);
      if (Number.isFinite(ls) && ls !== 0) ctx.letterSpacing = `${ls}px`;
      // ★ THE BASELINE IS MEASURED FROM THE PAGE, with the font-metric
      //   construction only as a fallback — see baselineOffset above for why
      //   the derived one is off by a device pixel.
      ctx.textBaseline = "alphabetic";
      let off = baselineOffset(el, cs, boxes[0][1].top);
      if (!Number.isFinite(off)) {
        const m = ctx.measureText("M");
        off = Math.max(0, (boxes[0][1].height - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2)
          + m.fontBoundingBoxAscent;
      }
      for (const [t, br] of boxes) {
        if (!hit(br)) continue;
        ctx.fillText(t, br.left - ox, br.top - oy + off);
        stats.lines++;
        stats.glyphs += t.length;
      }
      ctx.restore();
    }

    for (const child of el.children) walk(child);
  };

  walk(root);
  range.detach();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  stats.ms = performance.now() - t0;
  return stats;
}
