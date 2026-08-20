/* curves — the easing family the liquid state indicator is authored against.
 *
 * PORTED, NOT INVENTED. These are @stephantechlab/ui's `liquid/springs.ts` and the
 * cubic-bezier solver from `liquid/motion.ts`, carried into this app the same way the
 * kit itself carried the liquid family in from its reference implementation: copied
 * in, not depended on. The app ships no motion library and should not gain one for a
 * 18px indicator, but the CURVES have to be the kit's, or this thing is made of a
 * different material than everything else with the brand on it.
 *
 * ★★ THE RULE THAT MATTERS MORE THAN ANY CONSTANT HERE, and it is the whole reason a
 *    morph reads as liquid rather than as a shape being resized:
 *
 *      POSITION AND SHAPE GET DIFFERENT CURVES.
 *
 *    A body's POSITION goes where it is going and does not overshoot — a droplet that
 *    lands past its target reads as a mistake. Its SHAPE rings: it squashes into the
 *    move, lags behind the position by 30-60ms, and comes back on an elastic. The kit
 *    learned this after four rounds of "too bouncy / not liquid enough" that were all
 *    the same mistake, tuning ONE curve. Every transition in `choreography.ts` obeys
 *    it, and any new one must.
 */

export type Ease = (p: number) => number;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const linear: Ease = (p) => p;

/** GSAP's power naming: power1 = quad … power4 = quint. */
function power(exp: number, kind: "in" | "out" | "inOut"): Ease {
  if (kind === "in") return (p) => p ** exp;
  if (kind === "out") return (p) => 1 - (1 - p) ** exp;
  return (p) => (p < 0.5 ? (2 * p) ** exp / 2 : 1 - (2 - 2 * p) ** exp / 2);
}

/** Accelerating. The curve of a thing being pulled apart, or falling. */
export const IN_2: Ease = power(3, "in");
export const IN_1: Ease = power(2, "in");
/** Decelerating. */
export const OUT_2: Ease = power(3, "out");
export const IN_OUT_3: Ease = power(4, "inOut");

/** A CSS cubic-bezier as an ease. Newton–Raphson on x, with a bisection tail for the
 *  pathological curves (a control point past 1 — which the anticipate curve uses). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Ease {
  const A = (a: number, b: number) => 1 - 3 * b + 3 * a;
  const B = (a: number, b: number) => 3 * b - 6 * a;
  const C = (a: number) => 3 * a;
  const calc = (t: number, a: number, b: number) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
  const slope = (t: number, a: number, b: number) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);

  return (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let t = p;
    for (let i = 0; i < 6; i++) {
      const d = slope(t, x1, x2);
      if (d === 0) break;
      const err = calc(t, x1, x2) - p;
      if (Math.abs(err) < 1e-6) return calc(t, y1, y2);
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = p;
    for (let i = 0; i < 20; i++) {
      const err = calc(t, x1, x2) - p;
      if (Math.abs(err) < 1e-6) break;
      if (err > 0) hi = t;
      else lo = t;
      t = (lo + hi) / 2;
    }
    return calc(t, y1, y2);
  };
}

/** An ease sampled as a polyline — how the springs arrive. Linear between samples:
 *  36 points over 16 frames, so the error is far below a pixel and the alternative
 *  (a spline) would smooth away the ringing that is the entire point. */
export function polylineEase(points: readonly (readonly [number, number])[]): Ease {
  return (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let i = 0;
    while (i < points.length && points[i][0] < p) i++;
    const [x1, y1] = i === 0 ? [0, 0] : points[i - 1];
    const [x2, y2] = i >= points.length ? [1, 1] : points[i];
    const span = x2 - x1;
    return span <= 0 ? y2 : y1 + ((p - x1) / span) * (y2 - y1);
  };
}

/** House spring: ζ=0.434, ω=22.46 — 22% overshoot, ring, settle. Measured off the
 *  reference implementation; treat the numbers as data, not as a formula to re-derive. */
const HOUSE_SPRING_POINTS: readonly (readonly [number, number])[] = [
  [0.028, 0.0289], [0.056, 0.1062], [0.083, 0.2182], [0.111, 0.3519],
  [0.139, 0.4957], [0.167, 0.6396], [0.194, 0.7755], [0.222, 0.8974],
  [0.25, 1.0013], [0.278, 1.0849], [0.306, 1.1474], [0.333, 1.1896],
  [0.361, 1.213], [0.389, 1.22], [0.417, 1.2134], [0.444, 1.1961],
  [0.472, 1.1714], [0.5, 1.1419], [0.528, 1.1102], [0.556, 1.0786],
  [0.583, 1.0487], [0.611, 1.022], [0.639, 0.9992], [0.667, 0.981],
  [0.694, 0.9673], [0.722, 0.9581], [0.75, 0.9531], [0.778, 0.9516],
  [0.806, 0.9531], [0.833, 0.957], [0.861, 0.9624], [0.889, 0.969],
  [0.917, 0.9759], [0.944, 0.9829], [0.972, 0.9894], [1, 1],
];

/** Pop spring: ζ=0.479, ω=18.09 — 18% overshoot. The louder curve, for a body
 *  leaving its origin entirely. */
const POP_SPRING_POINTS: readonly (readonly [number, number])[] = [
  [0.028, 0.0237], [0.056, 0.0875], [0.083, 0.1806], [0.111, 0.2931],
  [0.139, 0.416], [0.167, 0.5418], [0.194, 0.664], [0.222, 0.7777],
  [0.25, 0.8795], [0.278, 0.967], [0.306, 1.0389], [0.333, 1.0951],
  [0.361, 1.1359], [0.389, 1.1626], [0.417, 1.1767], [0.444, 1.1799],
  [0.472, 1.1742], [0.5, 1.1617], [0.528, 1.1442], [0.556, 1.1235],
  [0.583, 1.1012], [0.611, 1.0786], [0.639, 1.0569], [0.667, 1.0367],
  [0.694, 1.0188], [0.722, 1.0035], [0.75, 0.9911], [0.778, 0.9814],
  [0.806, 0.9745], [0.833, 0.9701], [0.861, 0.968], [0.889, 0.9677],
  [0.917, 0.9689], [0.944, 0.9714], [0.972, 0.9746], [1, 1],
];

export const SPRING: Ease = polylineEase(HOUSE_SPRING_POINTS);
export const POP: Ease = polylineEase(POP_SPRING_POINTS);

/** GSAP's `elastic.out(amplitude, period)`, to the same formula.
 *
 *  ★ It rings, and that is the point — but it rings on the SHAPE, never on the
 *    position. See the rule at the top of this file. */
export function elasticOut(amplitude = 1, period = 0.3): Ease {
  const p = period;
  const a = Math.max(amplitude, 1);
  const s = (p / (2 * Math.PI)) * Math.asin(1 / a);
  return (t) => (t === 0 || t === 1 ? t : a * 2 ** (-10 * t) * Math.sin(((t - s) * (2 * Math.PI)) / p) + 1);
}

/** The curve a squashed body comes back to round on. */
export const ELASTIC: Ease = elasticOut(1, 0.32);
/** A shorter, tighter ring — for the small deformations inside a loop, where a long
 *  tail would still be moving when the next beat starts. */
export const ELASTIC_TIGHT: Ease = elasticOut(1, 0.24);

/** The kit's `--ease-out` twin, for beats that must NOT ring: a colour, a hand-off,
 *  a gather. Overshoot on those reads as a bug. */
export const OUT_STRONG: Ease = cubicBezier(0.23, 1, 0.32, 1);

/** Exits are authored, never reversed. A body winds up ~10% the wrong way before it
 *  collapses; the anticipation is what makes the collapse read as intent, not a cut. */
export const ANTICIPATE: Ease = cubicBezier(0.36, 0, 0.66, -0.56);

/** ~5% overshoot. For a thing ARRIVING where you just put it — the house spring's 22%
 *  is right for a body leaving its origin and wrong here, where it reads as the
 *  indicator disagreeing with you. */
export const SETTLE: Ease = cubicBezier(0.22, 1.2, 0.36, 1);

/** Sample `ease` over the window [a, b] of a 0..1 clock, clamped outside it.
 *  Every beat in a transition is authored as one of these, which is what lets shape
 *  lag position by a fixed number of milliseconds instead of by a fudged curve. */
export function window_(t: number, a: number, b: number, ease: Ease): number {
  if (b <= a) return t >= b ? 1 : 0;
  return ease(clamp01((t - a) / (b - a)));
}

/** Linear interpolate. */
export const mix = (a: number, b: number, p: number): number => a + (b - a) * p;
