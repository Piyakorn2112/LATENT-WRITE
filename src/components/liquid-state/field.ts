/* field — the metaball, solved analytically per pixel.
 *
 * ★★ WHY NOT THE USUAL GOO (blur → alpha threshold). That trick is how nearly every
 *    gooey control on the web is built, and it is wrong at this size for reasons that
 *    are not matters of taste:
 *
 *    · A blur that is wide enough to bridge two bodies is wider than the bodies. The
 *      kit measured this on a 26×16 knob: at the σ needed to merge, the blur rounds a
 *      pill with 10px of straight middle into an oval no matter how exactly the
 *      geometry is animated. This indicator is 18px. Every shape in it would be soft.
 *    · The rim of a thresholded blur is the sliver between two iso-alpha contours, so
 *      its WIDTH IN PIXELS is a function of σ. Change σ mid-animation and the outline
 *      visibly fattens — which is exactly the "gooey button inflates when it moves"
 *      artifact.
 *    · It is a filter on a rasterised layer, so it is authored at the layout size and
 *      magnified by any transform, and it quantises to 8 bits.
 *
 *    The app already learned the general form of this the hard way on its glass
 *    engine: when a small element's effect keeps producing new artifacts, stop tuning
 *    the map and PAINT IT — evaluate the same maths analytically, per pixel, in float,
 *    at real display density. That is what this file does. 18px at 3× is 54×54 = 2916
 *    pixels; a metaball field over three bodies costs about six thousand square roots
 *    a frame, which is nothing, and in exchange every edge is exact at every DPR and
 *    nothing anywhere is blurred.
 *
 * ★ THE BLEND IS iq's CIRCULAR SMOOTH-MINIMUM, and the variant is a real choice.
 *   The circular smin is the one whose blend profile is a true circular arc — which is
 *   what surface tension actually draws where two droplets meet, and the reason the
 *   neck here reads as liquid rather than as two shapes fading into each other. It is
 *   also RIGID: outside the blend band it is exactly min(), so two dots 3px apart are
 *   two perfect circles, undeformed, until they are within `k` of each other. A blur
 *   deforms them the whole time.
 *
 *   Its known cost is that it is not associative — smin(a, smin(b, c)) differs from
 *   smin(smin(a, b), c). With at most three bodies, at most two of which are ever
 *   close, that is invisible; the fold order is fixed here so it is at least
 *   deterministic, and the number of bodies is capped where it stays true.
 *
 * ★ SIGN AND UNITS. Distances are in DEVICE PIXELS throughout the rasteriser, which is
 *   what makes the antialias ramp exactly one device pixel wide with no magic numbers:
 *   coverage = clamp(0.5 - d, 0, 1). Authoring happens in a unit box (0..1 across the
 *   component) and is scaled on the way in — so the same choreography is correct at
 *   18px in a popover and at 140px in the dev harness.
 */

/** One body of the mass: an axis-aligned ellipse, because a squash is a scale and a
 *  scaled circle is an ellipse. Radii, not scales, so the field never has to know what
 *  a body's rest size was.
 *
 *  ★★ EVERY BODY CARRIES ITS OWN BLEND RADIUS, and that is the fix for an entire class
 *     of bug rather than a feature. With ONE blend radius for the whole field, a frame
 *     that wants two dots necking at k=0.1 and a swell riding inside the mass at k=0.05
 *     cannot have both — and worse, a mass that has finished merging has two coincident
 *     bodies blended at k, which is a circle INFLATED BY EXACTLY k. The only way out
 *     was to stop drawing the second body once it had arrived, which is a discrete
 *     branch in the middle of a continuous animation: the picture stepped by 160 square
 *     pixels in one frame at the end of every merge and every split. Per-body k lets
 *     the merged pair sit at k=0, where the blend is exactly min() and two coincident
 *     circles are one circle, so nothing ever has to be dropped.
 *
 *  ★ THE INVARIANT THAT KEEPS IT SAFE: a body's k must reach zero no later than its
 *    radius does. A zero-radius body with k=0 contributes nothing at all (min() with a
 *    point that lies inside the mass is a no-op); a zero-radius body with k>0 is a
 *    dimple in the surface. `choreography.fieldOf` ties the two together. */
export interface Body {
  /** centre, unit box. For a cone this is the wide end. */
  x: number;
  y: number;
  /** radii, unit box. For a cone, `rx` is the wide-end radius. */
  rx: number;
  ry: number;
  /** A ROUNDED CONE instead of an ellipse: a body that tapers from `rx` at its centre
   *  to `tip` at distance `len` along its own +x axis. Exact SDF, so it blends with
   *  everything else — and it is the one shape a pen needs, because a nib is a point
   *  and no arrangement of ellipses ever makes one. */
  tip?: number;
  len?: number;
  /** blend radius used when folding THIS body into the ones before it. Unit box.
   *  0 = hard union, and for the first body it is unused. */
  k: number;
  /** rotation of the body's own axes, radians. Only the resting mark's petals use it —
   *  they point outward from a ring, and a radially elongated oval is the difference
   *  between the app's rosette and a ring of dots. Omitted means zero. */
  rot?: number;
}

/** A frame of the mass.
 *
 *  `soft` widens the coverage ramp beyond the one-device-pixel default. Zero is the
 *  crisp edge everything rests at; a couple of pixels of softness is used only where
 *  it earns its place — through the hand-off between the WebGL orb and this canvas,
 *  where both pictures are a small blurred blob at the same instant and the swap
 *  therefore has nothing to give it away. It is a tool for one moment, not a look. */
export interface Field {
  bodies: Body[];
  soft?: number;
}

/** iq's circular smooth-minimum, normalised so `k` IS the blend band's half-width in
 *  the same units as `a` and `b`. The normalisation is not decoration: without it the
 *  same k draws a different neck for every variant, and the constant in the
 *  choreography stops meaning anything. */
export function sminCircular(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const kk = k * (1 / (1 - Math.SQRT1_2));
  const h = Math.max(kk - Math.abs(a - b), 0) / kk;
  return Math.min(a, b) - kk * 0.5 * (1 + h - Math.sqrt(1 - h * (h - 2)));
}

/** iq's ellipse distance approximation. Exact for a circle (rx === ry), and within a
 *  fraction of a pixel of true distance at the eccentricities a squash produces —
 *  which is what lets a squashed body take part in the blend without the neck changing
 *  width as it deforms.
 *
 *  ★★ IT HOLDS ONLY FOR MODERATE ECCENTRICITY. It is an approximation, and past
 *     roughly 10:1 it under-reports distance badly — at 217:1 (a zero-length ink
 *     stroke drawn as an ellipse) it returned near-zero the whole length of the
 *     column and painted a line from the top of the canvas to the bottom. Anything
 *     that needs to be very long and thin is a CAPSULE, which is a cone with equal
 *     radii and exact at any length. A gate walks every pose of every state and
 *     refuses a body past the limit, because nothing about the failure looks like a
 *     bad distance function.
 *
 *  ★★ THE ZERO-RADIUS GUARD LIVES HERE, IN THE ONE FUNCTION BOTH HALVES CALL. It was
 *     originally a clamp inside the rasteriser's setup loop, so the painter was safe
 *     and `sdField` — which is what every probe and every test measures the geometry
 *     with — divided by zero and returned NaN. Nothing threw. The rendered picture was
 *     perfect and three separate gates silently reported that a gap of 0.00px was the
 *     widest one they could find, because `NaN < worst` is false forever. A guard that
 *     only one of two halves applies is not a guard. */
export function sdEllipse(px: number, py: number, rx: number, ry: number): number {
  /* ★★ A BODY WITH NO RADIUS IS ABSENT, NOT A POINT. Clamping the radius to something
   *    tiny instead makes the function return the distance to that point — which is
   *    ~0 AT THE POINT ITSELF, so folding an "empty" body into the mass punches a
   *    half-lit pixel wherever its centre happens to sit. While thinking, that centre
   *    sits in the gap between the two dots: a faint speck, one pixel, flickering as
   *    the pixel grid moves under it. Infinity is inert under min() at every k, which
   *    is what "not there" actually means. */
  if (rx <= 0 || ry <= 0) return Infinity;
  const k1 = Math.hypot(px / rx, py / ry);
  if (k1 === 0) return -Math.min(rx, ry);
  const k2 = Math.hypot(px / (rx * rx), py / (ry * ry));
  return (k1 * (k1 - 1)) / k2;
}

/** Signed distance to the whole mass, at a point in unit-box coordinates. Negative
 *  inside. Exported so a probe can read exactly the geometry the painter paints —
 *  the picture and any measurement of it must come from one function, or they will
 *  eventually disagree and nothing will say so. */
/**
 * iq's rounded cone: the exact distance to the convex hull of two circles, radius `r1`
 * at the origin and `r2` at (`h`, 0). Three regions — the near cap, the far cap, and
 * the straight flank between their common tangents.
 *
 * ★ THIS IS WHAT DRAWS THE NIB. A pen tapers to a point, and a point is precisely what
 *   a union of ellipses cannot produce: every blend rounds it off, and a smaller and
 *   smaller ellipse just becomes a smaller and smaller blob. A cone with `r2` near
 *   zero has a real corner at its tip, and because the function is an exact distance
 *   it still blends with the rest of the mass through the same smooth-minimum.
 */
export function sdRoundCone(px: number, py: number, r1: number, r2: number, h: number): number {
  const qx = Math.abs(py);
  const qy = px;
  const b = (r1 - r2) / h;
  const a = Math.sqrt(Math.max(1 - b * b, 0));
  const k = qx * -b + qy * a;
  if (k < 0) return Math.hypot(qx, qy) - r1;
  if (k > a * h) return Math.hypot(qx, qy - h) - r2;
  return qx * a + qy * b - r1;
}

/** Distance to one body, in its own frame. */
function sdBody(b: Body, x: number, y: number): number {
  let dx = x - b.x;
  let dy = y - b.y;
  if (b.rot) {
    const c = Math.cos(-b.rot);
    const s = Math.sin(-b.rot);
    const rx = dx * c - dy * s;
    dy = dx * s + dy * c;
    dx = rx;
  }
  if (b.len !== undefined && b.len > 0) return sdRoundCone(dx, dy, b.rx, b.tip ?? 0, b.len);
  return sdEllipse(dx, dy, b.rx, b.ry);
}

/**
 * ★★ EVERY BODY FOLDS WITH ITS OWN BLEND, INCLUDING THE FIRST. The obvious way to
 *    write this is to seed `d` with body zero and smooth-min the rest onto it — and
 *    that makes the FIRST SURVIVING BODY special, which is a discrete choice inside a
 *    continuous animation. When a radius crosses zero the base identity moves to the
 *    next body, and the blend that was being ignored suddenly starts applying: the
 *    picture stepped by ~35 square pixels in one frame on four transitions, with every
 *    pose parameter demonstrably smooth to five decimal places. That is the tell —
 *    smooth inputs, stepping output, means the bug is in how they are combined.
 *
 *    Seeding with Infinity removes the special case: `smin(∞, x, k)` is exactly `x`
 *    for any k (the blend band is finite, so the two are never within it), so the
 *    first body folds by the same rule as every other one and no body's blend ever
 *    switches on.
 */
export function sdField(field: Field, x: number, y: number): number {
  let d = Infinity;
  for (const b of field.bodies) {
    if (b.rx <= 0 || (b.len === undefined && b.ry <= 0)) continue;
    d = sminCircular(d, sdBody(b, x, y), b.k);
  }
  return d;
}

/**
 * Rasterise the mass into an RGBA buffer.
 *
 * `rgb` is written flat across the whole shape and only the ALPHA varies, which is
 * what keeps an antialiased edge from darkening into a fake outline: a constant colour
 * under a coverage ramp premultiplies correctly, a colour that also ramps does not.
 * (The app's orb engine composites premultiplied for the same reason.)
 *
 * The ramp itself is `0.5 - d` with d in device pixels — the exact coverage of a
 * straight edge crossing a pixel, to first order. Inside the blend band the smin's
 * gradient dips a little below 1, so the neck's ramp is up to ~1.4px rather than 1px;
 * that is a hair softer exactly where the surface is genuinely curving fastest, and it
 * is the only softness anywhere in this file.
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
  const { bodies } = field;
  const soft = 1 + Math.max(field.soft ?? 0, 0);
  const n = bodies.length;
  // Unit box → device pixels, once.
  const bx = new Float64Array(n);
  const by = new Float64Array(n);
  const brx = new Float64Array(n);
  const bry = new Float64Array(n);
  const bk = new Float64Array(n);
  const bc = new Float64Array(n);
  const bs = new Float64Array(n);
  /* ★ BODIES WITH NO RADIUS ARE DROPPED HERE, ONCE, rather than evaluated and
   *   discarded per pixel. They are already inert (sdEllipse returns Infinity), so
   *   this changes no pixel — it just stops the resting mark's six petals costing
   *   anything in the three states that do not have a ring. Verified by the gates,
   *   which compare rendered alpha and would show any difference immediately. */
  let n2 = 0;
  const blen = new Float64Array(n);
  const btip = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = bodies[i];
    if (b.rx <= 0 || (b.len === undefined && b.ry <= 0)) continue;
    blen[n2] = (b.len ?? 0) * size;
    btip[n2] = (b.tip ?? 0) * size;
    bx[n2] = b.x * size;
    by[n2] = b.y * size;
    brx[n2] = b.rx * size;
    bry[n2] = b.ry * size;
    bk[n2] = b.k * size;
    bc[n2] = b.rot ? Math.cos(-b.rot) : 1;
    bs[n2] = b.rot ? Math.sin(-b.rot) : 0;
    n2++;
  }

  for (let py = 0; py < size; py++) {
    const sy = py + 0.5;
    for (let px = 0; px < size; px++) {
      const sx = px + 0.5;
      let d = Infinity;
      for (let i = 0; i < n2; i++) {
        const ux = sx - bx[i];
        const uy = sy - by[i];
        const c = bc[i];
        const sn = bs[i];
        const lx = ux * c - uy * sn;
        const ly = ux * sn + uy * c;
        const di = blen[i] > 0
          ? sdRoundCone(lx, ly, brx[i], btip[i], blen[i])
          : sdEllipse(lx, ly, brx[i], bry[i]);
        /* No special case for the first body — see sdField. */
        d = sminCircular(d, di, bk[i]);
      }
      /* The ramp is one device pixel wide by default — the exact coverage of a
       * straight edge crossing a pixel, to first order — and `soft` widens it. */
      let cov = 0.5 - d / soft;
      if (cov > 0) {
        if (cov > 1) cov = 1;
        const o = (py * size + px) * 4;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = cov * alpha * 255;
      } else {
        out[(py * size + px) * 4 + 3] = 0;
      }
    }
  }
}
