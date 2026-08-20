/* field — the metaball, solved analytically per pixel.
 *
 * ★★ WHY NOT THE USUAL GOO (blur → alpha threshold). That trick is how nearly every
 *    gooey control on the web is built, and it is wrong at this size for reasons that
 *    are not matters of taste:
 *
 *    · A blur wide enough to bridge two bodies is wider than the bodies. The kit
 *      measured this on a 26×16 knob: at the σ needed to merge, the blur rounds a pill
 *      with 10px of straight middle into an oval no matter how exactly the geometry is
 *      animated. This indicator is 18px. Every shape in it would be soft.
 *    · The rim of a thresholded blur is the sliver between two iso-alpha contours, so
 *      its WIDTH IN PIXELS is a function of σ. Change σ mid-animation and the outline
 *      visibly fattens — the "gooey button inflates when it moves" artifact.
 *    · It is a filter on a rasterised layer, so it is authored at the layout size and
 *      magnified by any transform, and it quantises to 8 bits.
 *
 *    The app already learned the general form of this on its glass engine: when a small
 *    element's effect keeps producing new artifacts, stop tuning the map and PAINT IT —
 *    evaluate the same maths analytically, per pixel, in float, at real display
 *    density. 18px at 3× is 54×54; every edge is exact at every DPR and nothing is
 *    blurred except one deliberate moment (see `soft`).
 *
 * ★★ ONE SHAPE, AND ONLY ONE. Every body is a ROUNDED CONE — two circles and their
 *    common tangents — evaluated in a space that is then scaled, sheared and rotated.
 *    That single primitive is a dot (length 0, equal radii), a line (length, equal
 *    radii), a squashed dot (scale), a leaning one (skew) and a pen nib (unequal
 *    radii), and having only one means there is no branch anywhere that can flip
 *    between two of them mid-animation.
 *
 *    That branch is not hypothetical: an earlier version had a separate ellipse case
 *    for zero-length bodies, and a line shrinking to a dot changed width the frame it
 *    crossed the threshold, because the two cases applied the squash differently. The
 *    picture stepped by tens of square pixels on every transition between reading and
 *    anything else, and every pose parameter was smooth throughout.
 *
 * ★ THE CONTOUR IS EXACT UNDER SCALING; the gradient is not. Distance in a space scaled
 *   by (sx, sy) is not distance, so the returned value is multiplied by the smaller
 *   scale — conservative, never over-reporting. d = 0 is unaffected, which is the only
 *   place the silhouette lives; what changes slightly is the width of the antialias
 *   ramp and of the blend band on a heavily squashed body, by at most the aspect ratio.
 *
 * ★★ THE BLEND IS iq's CIRCULAR SMOOTH-MINIMUM, and the variant is a real choice. Its
 *    blend profile is a true circular arc — what surface tension actually draws where
 *    two droplets meet — and it is RIGID: outside the band it is exactly min(), so two
 *    dots 3px apart are two perfect circles until they are within `k`. A blur deforms
 *    them the whole time. Its known cost is that it is not associative; with a handful
 *    of bodies, at most two of which are ever close, that is invisible, and the fold
 *    order is fixed so it is at least deterministic.
 *
 * ★ SIGN AND UNITS. Distances are in DEVICE PIXELS inside the rasteriser, which is what
 *   makes the antialias ramp exactly one device pixel wide with no magic numbers:
 *   coverage = clamp(0.5 − d, 0, 1). Authoring happens in a unit box (0..1 across the
 *   component) and is scaled on the way in, so the same choreography is correct at 18px
 *   in a popover and at 160px in a specimen sheet.
 */

/** One body of the mass.
 *
 *  It is a rounded cone from (x, y) running `len` along its own +x axis, with radius
 *  `r` at the near end and `tip` at the far one, then sheared by `skew`, scaled by
 *  (`sx`, `sy`) and rotated by `rot`. Every shape in the component is one of these. */
export interface Body {
  /** the near end of the axis, unit box */
  x: number;
  y: number;
  /** radius at the near end */
  r: number;
  /** length of the axis. 0 makes it a dot. */
  len: number;
  /** radius at the far end. Defaults to `r`, which is a capsule. */
  tip?: number;
  /** scale of the body's own space. Defaults to 1. */
  sx?: number;
  sy?: number;
  /** rotation of the body's own axes, radians. */
  rot?: number;
  /** ★★ HORIZONTAL SHEAR — the lean into a direction of travel.
   *
   *  The kit's travelling marker is TWO animations: the geometry goes straight to its
   *  target on an in-out curve and never overshoots, while the shape squashes long and
   *  low, LEANS with a skew, and rings back on an elastic. Its own notes say every
   *  earlier attempt read as either dead or bouncy because the engine "had neither
   *  skewX nor an elastic" and the two were being fought over one curve. This engine
   *  had the elastic and not the skew, which is half of the same mistake. */
  skew?: number;
  /** blend radius used when folding this body into the ones before it. Unit box.
   *  0 = hard union. */
  k: number;
}

/** A frame of the mass.
 *
 *  `soft` widens the coverage ramp beyond the one-device-pixel default. Zero is the
 *  crisp edge everything rests at; a couple of pixels of softness is used only where it
 *  earns its place — through the hand-over between the WebGL orb and this canvas, where
 *  both pictures are a small blurred blob at the same instant and the swap therefore has
 *  nothing to give it away. A tool for one moment, not a look. */
export interface Field {
  bodies: Body[];
  soft?: number;
}

/** iq's circular smooth-minimum, normalised so `k` IS the blend band's half-width in
 *  the same units as `a` and `b`. The normalisation is not decoration: without it the
 *  same k draws a different neck for every variant and the constant in the
 *  choreography stops meaning anything. */
export function sminCircular(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const kk = k * (1 / (1 - Math.SQRT1_2));
  const h = Math.max(kk - Math.abs(a - b), 0) / kk;
  return Math.min(a, b) - kk * 0.5 * (1 + h - Math.sqrt(1 - h * (h - 2)));
}

/**
 * iq's rounded cone: the exact distance to the convex hull of two circles, radius `r1`
 * at the origin and `r2` at (`h`, 0). Three regions — the near cap, the far cap, and
 * the straight flank between their common tangents.
 *
 * ★ THIS IS WHAT DRAWS THE NIB. A pen tapers to a point, and a point is precisely what
 *   a union of round shapes cannot produce: every blend rounds it off, and a smaller
 *   and smaller circle is just a smaller and smaller blob. A cone with `r2` near zero
 *   has a real corner at its tip, and because the function is an exact distance it
 *   still blends with the rest of the mass through the same smooth-minimum.
 */
export function sdRoundCone(px: number, py: number, r1: number, r2: number, h: number): number {
  if (h <= 0) return Math.sqrt(px * px + py * py) - r1;
  const qx = Math.abs(py);
  const qy = px;
  const b = (r1 - r2) / h;
  const a = Math.sqrt(Math.max(1 - b * b, 0));
  const k = qx * -b + qy * a;
  if (k < 0) return Math.sqrt(qx * qx + qy * qy) - r1;
  if (k > a * h) { const dy = qy - h; return Math.sqrt(qx * qx + dy * dy) - r2; }
  return qx * a + qy * b - r1;
}

/** Distance to one body, in its own frame.
 *
 *  ★★ A BODY WITH NO RADIUS IS ABSENT, NOT A POINT. Returning the distance to a point
 *     instead makes an "empty" body report ~0 AT ITS OWN CENTRE, which paints a
 *     half-lit pixel wherever that centre happens to sit — for the indicator's parked
 *     bodies, in the gap between two dots. Infinity is inert under min(), which is what
 *     "not there" actually means. */
export function sdBody(b: Body, x: number, y: number): number {
  if (b.r <= 0) return Infinity;
  let dx = x - b.x;
  let dy = y - b.y;
  if (b.rot) {
    const c = Math.cos(-b.rot);
    const s = Math.sin(-b.rot);
    const rx = dx * c - dy * s;
    dy = dx * s + dy * c;
    dx = rx;
  }
  const sx = b.sx ?? 1;
  const sy = b.sy ?? 1;
  if (b.skew) dx -= b.skew * dy;
  return sdRoundCone(dx / sx, dy / sy, b.r, b.tip ?? b.r, b.len) * Math.min(sx, sy);
}

/**
 * ★★ EVERY BODY FOLDS WITH ITS OWN BLEND, INCLUDING THE FIRST. The obvious way to write
 *    this is to seed `d` with body zero and smooth-min the rest onto it — and that
 *    makes the FIRST SURVIVING BODY special, which is a discrete choice inside a
 *    continuous animation. When a radius crosses zero the base identity moves to the
 *    next body and the blend that was being ignored suddenly starts applying.
 *
 *    Seeding with Infinity removes the special case: `smin(∞, x, k)` is exactly `x` for
 *    any k (the blend band is finite, so the two are never within it), so the first
 *    body folds by the same rule as every other one.
 */
export function sdField(field: Field, x: number, y: number): number {
  let d = Infinity;
  for (const b of field.bodies) {
    /* ★★ ABSENT BODIES ARE SKIPPED, NOT FOLDED. `smin(∞, ∞, k)` computes
     *    `|∞ − ∞|`, which is NaN, and NaN propagates through every comparison as
     *    false — so a probe measuring "the closest this ever gets to inside" silently
     *    reports that it never gets close at all. Three gates returned a confident
     *    0.00px because of it. The rasteriser has always skipped them; this is the
     *    other half of the same guard, in the other half that reads the geometry. */
    if (b.r <= 0) continue;
    d = sminCircular(d, sdBody(b, x, y), b.k);
  }
  return d;
}

/**
 * Rasterise the mass into an RGBA buffer.
 *
 * `rgb` is written flat across the whole shape and only the ALPHA varies, which is what
 * keeps an antialiased edge from darkening into a fake outline: a constant colour under
 * a coverage ramp premultiplies correctly, a colour that also ramps does not.
 *
 * ★★ IT IS CULLED TWICE, AND IT HAS TO BE. The naive loop is (pixels × bodies), which
 *    at 18px is nothing and at a 150px specimen is over a million distance evaluations
 *    a frame, in JavaScript, several of those on one page. Two cheap cuts fix it: the
 *    whole mass gets one bounding box, and each ROW gets its own list of bodies whose
 *    boxes reach it.
 *
 * ★ THE BOXES BOUND THE PAINTED EDGE, NOT THE GEOMETRY. A box drawn to the shape clips
 *   the ramp and the blend band, and the clip line snaps by whole pixels as the bounds
 *   round — about nine square pixels of jitter a frame, which reads as a shimmer. The
 *   margin is deliberately loose; tightening it saves nothing measurable and costs
 *   exactly the artifact the box exists to avoid.
 */
export function rasterise(
  out: Uint8ClampedArray,
  size: number,
  field: Field,
  rgb: readonly [number, number, number],
  alpha: number,
): void {
  const r = rgb[0];
  const g = rgb[1];
  const b = rgb[2];
  const soft = 1 + Math.max(field.soft ?? 0, 0);
  const bodies = field.bodies;
  const n = bodies.length;

  const px0 = new Float64Array(n);
  const py0 = new Float64Array(n);
  const pr = new Float64Array(n);
  const ptip = new Float64Array(n);
  const plen = new Float64Array(n);
  const psx = new Float64Array(n);
  const psy = new Float64Array(n);
  const pc = new Float64Array(n);
  const ps = new Float64Array(n);
  const pk = new Float64Array(n);
  const pskew = new Float64Array(n);
  const x0 = new Float64Array(n);
  const x1 = new Float64Array(n);
  const y0 = new Float64Array(n);
  const y1 = new Float64Array(n);

  let m = 0;
  let ux0 = Infinity;
  let ux1 = -Infinity;
  let uy0 = Infinity;
  let uy1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const bd = bodies[i];
    if (bd.r <= 0) continue;
    const sx = bd.sx ?? 1;
    const sy = bd.sy ?? 1;
    px0[m] = bd.x * size;
    py0[m] = bd.y * size;
    pr[m] = bd.r * size;
    ptip[m] = (bd.tip ?? bd.r) * size;
    plen[m] = bd.len * size;
    psx[m] = sx;
    psy[m] = sy;
    pc[m] = bd.rot ? Math.cos(-bd.rot) : 1;
    ps[m] = bd.rot ? Math.sin(-bd.rot) : 0;
    pskew[m] = bd.skew ?? 0;
    pk[m] = bd.k * size;

    const big = Math.max(pr[m], ptip[m]);
    const reach = (plen[m] + big) * Math.max(sx, sy)
      + pk[m] * 3.42 + soft + big * 2.5 + 6
      + Math.abs(pskew[m]) * big * Math.max(sx, sy);
    x0[m] = px0[m] - reach;
    x1[m] = px0[m] + reach;
    y0[m] = py0[m] - reach;
    y1[m] = py0[m] + reach;
    if (x0[m] < ux0) ux0 = x0[m];
    if (x1[m] > ux1) ux1 = x1[m];
    if (y0[m] < uy0) uy0 = y0[m];
    if (y1[m] > uy1) uy1 = y1[m];
    m++;
  }

  const rowLo = m === 0 ? 1 : Math.max(0, Math.floor(uy0));
  const rowHi = m === 0 ? 0 : Math.min(size - 1, Math.ceil(uy1));
  const colLo = m === 0 ? 1 : Math.max(0, Math.floor(ux0));
  const colHi = m === 0 ? 0 : Math.min(size - 1, Math.ceil(ux1));

  for (let y = 0; y < size; y++) {
    const inRows = y >= rowLo && y <= rowHi;
    for (let x = 0; x < size; x++) {
      if (inRows && x >= colLo && x <= colHi) continue;
      out[(y * size + x) * 4 + 3] = 0;
    }
  }

  const row = new Int32Array(n);
  for (let y = rowLo; y <= rowHi; y++) {
    const sy = y + 0.5;
    let rn = 0;
    for (let i = 0; i < m; i++) if (sy >= y0[i] && sy <= y1[i]) row[rn++] = i;
    if (rn === 0) {
      for (let x = colLo; x <= colHi; x++) out[(y * size + x) * 4 + 3] = 0;
      continue;
    }
    for (let x = colLo; x <= colHi; x++) {
      const sx = x + 0.5;
      let d = Infinity;
      for (let j = 0; j < rn; j++) {
        const i = row[j];
        if (sx < x0[i] || sx > x1[i]) continue;
        const ux = sx - px0[i];
        const uy = sy - py0[i];
        const ly = ux * ps[i] + uy * pc[i];
        const lx = ux * pc[i] - uy * ps[i] - pskew[i] * ly;
        const di = sdRoundCone(lx / psx[i], ly / psy[i], pr[i], ptip[i], plen[i])
          * (psx[i] < psy[i] ? psx[i] : psy[i]);
        d = sminCircular(d, di, pk[i]);
      }
      let cov = 0.5 - d / soft;
      const o = (y * size + x) * 4;
      if (cov > 0) {
        if (cov > 1) cov = 1;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = cov * alpha * 255;
      } else {
        out[o + 3] = 0;
      }
    }
  }
}
