/* choreography — what the mass is doing, as a pure function of a clock.
 *
 * Nothing here touches the DOM, a canvas, or React. `poseAt()` takes a state, a
 * transition and a time in milliseconds and returns a Pose; `fieldOf()` turns a Pose
 * into the bodies `field.ts` paints. That is deliberate and it is not tidiness:
 *
 *   ★★ THE PAINTER AND ANY MEASUREMENT OF IT MUST COME FROM ONE FUNCTION. A harness
 *      that re-derives "where the dots are" from its own copy of the maths will agree
 *      with the picture right up until it doesn't, and then it will report a green
 *      number about a frame nobody is looking at. `scripts/test-liquid-state.ts`
 *      samples THESE functions, and the component paints THESE functions.
 *
 * THE THREE STATES map to what the model is actually doing, which the app already
 * knows and previously threw away:
 *
 *   reading   evidence is being gathered — "Reading chapter 3 of 12…"
 *             ONE body sweeping the box, leading edge pulled ahead of the tail.
 *   thinking  the reasoning pass — the rotating ThinkingLabel
 *             TWO bodies taking turns jumping.
 *   writing   tokens are being produced — "Writing the card…"
 *             ONE body with a swell travelling through it, left to right.
 *
 * ★★ THE TRANSITIONS ARE THE POINT, and they are authored, never crossfaded. Going
 *    from one to two bodies is a TEAR: the mass gathers, necks, and the halves
 *    ACCELERATE apart (`IN_2`) as the neck snaps — because a thing pulled apart moves
 *    fastest at the moment it lets go, and a linear separation reads as two shapes
 *    sliding. Going from two to one is a COLLISION: the dots fall to the floor, rush
 *    together accelerating, squash on the axis they met along, throw a droplet
 *    upward, and ring back to round while the droplet falls in after them.
 *
 * ★★ AND THE RULE THAT MAKES ALL OF IT READ AS GEL RATHER THAN AS TWEENING: position
 *    and shape are never on the same curve. `half` (separation) and `cx` (travel)
 *    land on decelerating or accelerating curves with NO overshoot. `sx`/`sy` ring on
 *    `ELASTIC`, and their windows START EARLIER and END LATER than the position's, so
 *    the shape is still catching up after the body has arrived. That lag is the
 *    entire effect. See curves.ts.
 *
 * ★ EVERY TRANSITION ENDS EXACTLY ON ITS TARGET LOOP'S CLOCK-ZERO POSE. There is no
 *   crossfade and no settling period: at p=1 the pose IS `loopPose(to, 0)`, the clock
 *   resets, and the loop takes over mid-gesture. The split therefore ends with one
 *   half thrown up to the apex of its first jump — the tear's own energy becomes the
 *   loop's first beat, which is why it reads as causal instead of as two animations
 *   played back to back. This handshake is gated (test-liquid-state.ts), because it
 *   is exactly the kind of thing that drifts silently the moment a constant changes.
 */

import {
  ANTICIPATE, ELASTIC, ELASTIC_TIGHT, IN_1, IN_2, IN_OUT_3, OUT_2, OUT_STRONG, POP, SETTLE,
  mix, window_, type Ease,
} from "./curves";
import type { Field } from "./field";

export type LiquidStateName = "reading" | "thinking" | "writing";

/* ── geometry, in a unit box where 1 = the component's size ─────────────────────── */

/** The floor every body rests on. Shared by all three states on purpose: one material,
 *  one surface. A squash pins the CONTACT POINT, not the centre — which is the whole
 *  difference between a landing and a shrink. */
const GROUND = 0.72;
/** Rest radius of one thinking dot. */
const R_DOT = 0.175;
/** Rest radius of the single body. Two dots of R_DOT have area 2πR², so one body of
 *  the same volume is R√2 = 0.247; a touch under that reads better at 18px, and the
 *  merge is a droplet coalescing, not a conservation law. */
const R_ONE = 0.234;
/** Half the centre-to-centre separation while thinking. */
const HALF = 0.203;
/** How high a dot jumps. */
const JUMP = 0.152;
/** Flight stretch at maximum vertical speed. Round at the apex, longest at launch and
 *  landing — and it is derived from the arc's own velocity, not authored per beat. */
const STRETCH = 0.17;
/** How flat a dot goes on impact. */
const SPLAT = 0.76;
/** How far the single body sweeps while reading. */
const SWEEP = 0.108;

/** Surface tension at rest between two separate dots. Small: the two dots must read as
 *  TWO DOTS, undeformed, and the circular smin is rigid outside its band — so a small
 *  k means the neck only exists when they are genuinely close. */
const K_APART = 0.022;
/** Surface tension while a mass is tearing or coalescing: the band has to be wide
 *  enough to bridge the gap before contact, which is what draws the neck. */
const K_NECK = 0.105;
/** Surface tension inside a single body. Near zero: two coincident bodies blended at k
 *  read as ONE body inflated by k, so anything else quietly changes the blob's size. */
const K_ONE = 0.008;

/* ── the pose ───────────────────────────────────────────────────────────────────── */

export interface Pose {
  /** centre of the whole mass along x */
  cx: number;
  /** half the centre-to-centre separation. 0 = one body. */
  half: number;
  /** rest radius of each body */
  r0: number;
  r1: number;
  /** height above the floor */
  lift0: number;
  lift1: number;
  /** squash. sx is authored independently of sy because a collision squashes on one
   *  axis and a flight stretch conserves area; they are not the same gesture. */
  sx0: number;
  sy0: number;
  sx1: number;
  sy1: number;
  /** the third body — a swell travelling inside the mass while writing, or the droplet
   *  thrown out of a collision. Offsets are relative to the mass's resting centre.
   *  br = 0 means there is no third body at all. */
  bx: number;
  by: number;
  br: number;
  /** surface tension */
  k: number;
  /** whole-mass opacity, for the entrance and exit only */
  alpha: number;
}

const POSE_KEYS = [
  "cx", "half", "r0", "r1", "lift0", "lift1",
  "sx0", "sy0", "sx1", "sy1", "bx", "by", "br", "k", "alpha",
] as const;

function onePose(r: number, cx = 0.5): Pose {
  return {
    cx, half: 0, r0: r, r1: r, lift0: 0, lift1: 0,
    sx0: 1, sy0: 1, sx1: 1, sy1: 1, bx: 0, by: 0, br: 0, k: K_ONE, alpha: 1,
  };
}

/** Bodies, in the order `field.ts` folds them. The two dots first (so the neck between
 *  them is always the same blend), then the swell. */
export function fieldOf(pose: Pose): Field {
  const bodies: Field["bodies"] = [];
  const ry0 = pose.r0 * pose.sy0;
  const ry1 = pose.r1 * pose.sy1;
  bodies.push({
    x: pose.cx - pose.half,
    y: GROUND - ry0 - pose.lift0,
    rx: pose.r0 * pose.sx0,
    ry: ry0,
  });
  if (pose.half > 1e-4 || pose.r1 !== pose.r0 || pose.lift1 !== pose.lift0) {
    bodies.push({
      x: pose.cx + pose.half,
      y: GROUND - ry1 - pose.lift1,
      rx: pose.r1 * pose.sx1,
      ry: ry1,
    });
  }
  if (pose.br > 1e-4) {
    bodies.push({
      x: pose.cx + pose.bx,
      y: GROUND - pose.r0 + pose.by,
      rx: pose.br,
      ry: pose.br,
    });
  }
  return { bodies, k: pose.k };
}

/* ── deterministic jitter ───────────────────────────────────────────────────────────
 * ★ A loop that repeats to the millisecond stops reading as something alive and starts
 *   reading as a CSS animation. Each cycle gets a small, DETERMINISTIC variation —
 *   deterministic so a probe sampling the same clock gets the same frame, and applied
 *   only to amplitudes that are zero at the cycle boundary, so the loop's clock-zero
 *   pose (the handshake every transition lands on) is untouched. */
function jitter(cycle: number, salt: number): number {
  const x = Math.sin(cycle * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x); /* 0..1 */
}

/* ── the loops ──────────────────────────────────────────────────────────────────── */

const P_THINK = 820;
const P_WRITE = 1150;
const P_READ = 1560;

/** One dot's own beat. φ = 0 is REST ON THE FLOOR, which is what every transition into
 *  `thinking` hands over to.
 *
 *      rest      0.00 – 0.12   nothing; the beat needs a floor or it reads as a jitter
 *      crouch    0.12 – 0.26   sy 1 → 0.88, gathering. Anticipation, on a curve that
 *                              does NOT ring — a crouch that wobbles reads as a fault
 *      push-off  0.26 – 0.32   sy 0.88 → flight, on IN_2. Accelerating out of the
 *                              crouch is what makes the launch read as effort
 *      flight    0.26 – 0.68   lift on a parabola; the stretch is DERIVED from the
 *                              arc's own velocity, so the dot is longest where it is
 *                              fastest and perfectly round at the apex
 *      impact    0.68 – 0.755  sy 1.17 → 0.76 on IN_2. 61ms, and it has to be that
 *                              fast: an impact you can watch is not an impact
 *      ring      0.755 – 1.00  back to round on ELASTIC, 201ms of settling
 */
function dotBeat(phase: number, jumpScale: number): { lift: number; sx: number; sy: number } {
  const f = phase - Math.floor(phase);

  const AIR_A = 0.26;
  const AIR_B = 0.68;
  const u = (f - AIR_A) / (AIR_B - AIR_A);
  const airborne = f >= AIR_A && f < AIR_B;
  const lift = airborne ? JUMP * jumpScale * 4 * u * (1 - u) : 0;

  /* The flight stretch, wherever it is asked for: |dlift/du| normalised to 0..1. */
  const flightSy = (uu: number) => 1 + STRETCH * Math.abs(1 - 2 * uu);

  let sy: number;
  if (f < 0.12) sy = 1;
  else if (f < 0.26) sy = mix(1, 0.88, window_(f, 0.12, 0.26, OUT_STRONG));
  else if (f < 0.32) sy = mix(0.88, flightSy(u), window_(f, 0.26, 0.32, IN_2));
  else if (f < AIR_B) sy = flightSy(u);
  else if (f < 0.755) sy = mix(flightSy(1), SPLAT, window_(f, AIR_B, 0.755, IN_2));
  else sy = mix(SPLAT, 1, window_(f, 0.755, 1, ELASTIC));

  /* Area conservation: a droplet that squashes gets wider by exactly as much as it
   * gets shorter. One authored number instead of two that can drift apart. */
  return { lift, sx: 1 / sy, sy };
}

function thinkingPose(clock: number): Pose {
  const t = clock / P_THINK;
  /* Each dot's jump varies a few percent per cycle — enough that the eye stops
   * predicting it, not enough to look unsteady. */
  const j0 = 0.94 + 0.12 * jitter(Math.floor(t), 1);
  const j1 = 0.94 + 0.12 * jitter(Math.floor(t + 0.5), 2);
  const a = dotBeat(t, j0);
  const b = dotBeat(t + 0.5, j1);
  return {
    cx: 0.5, half: HALF, r0: R_DOT, r1: R_DOT,
    lift0: a.lift, lift1: b.lift,
    sx0: a.sx, sy0: a.sy, sx1: b.sx, sy1: b.sy,
    bx: 0, by: 0, br: 0,
    k: K_APART, alpha: 1,
  };
}

/** Where the reading body is along its sweep, 0..1 → cx. Right on the first half, back
 *  on the second, with a beat of dwell at each end where it slams into the turn. */
function sweepAt(f: number): number {
  const g = f - Math.floor(f);
  if (g < 0.42) return mix(0.5 - SWEEP, 0.5 + SWEEP, IN_OUT_3(g / 0.42));
  if (g < 0.5) return 0.5 + SWEEP;
  if (g < 0.92) return mix(0.5 + SWEEP, 0.5 - SWEEP, IN_OUT_3((g - 0.5) / 0.42));
  return 0.5 - SWEEP;
}

function readingPose(clock: number): Pose {
  const f = clock / P_READ;
  const cx = sweepAt(f);

  /* ★ THE STRETCH IS DERIVED FROM THE TRAVEL, not authored beside it. A central
   *   difference on the sweep gives the velocity; the body leans into it. Authoring
   *   the two separately is how a lean ends up pointing the wrong way for one frame
   *   after someone retimes the sweep — and nothing would report that. */
  const eps = 0.004;
  const v = (sweepAt(f + eps) - sweepAt(f - eps)) / (2 * eps);
  const vmax = SWEEP * 2 * 2.2; /* the inOut curve's peak slope, in units per cycle */
  const lean = Math.min(Math.abs(v) / vmax, 1);

  /* And at each turn it sloshes against the end of its run: squashed on the axis it
   * was travelling along, ringing back. */
  const g = f - Math.floor(f);
  const turn = g >= 0.42 && g < 0.62
    ? mix(0.88, 1, window_(g, 0.44, 0.62, ELASTIC_TIGHT))
    : g >= 0.92 || g < 0.12
      ? mix(0.88, 1, window_(g >= 0.92 ? g - 0.92 : g + 0.08, 0.02, 0.20, ELASTIC_TIGHT))
      : 1;

  const sx = (1 + 0.20 * lean) * turn;
  return { ...onePose(R_ONE, cx), sx0: sx, sy0: 1 / sx, sx1: sx, sy1: 1 / sx };
}

/** Writing: one body, and a swell travelling through it left to right — the shape of
 *  something being extruded. The swell is a real third body just under the surface, so
 *  the silhouette bulges where it passes and the bulge is a metaball neck, not a
 *  scale. It accelerates through the middle and the surface snaps back behind it. */
function writingPose(clock: number): Pose {
  const f = clock / P_WRITE;
  const g = f - Math.floor(f);
  const amp = 0.88 + 0.24 * jitter(Math.floor(f), 3);

  const A = 0.08;
  const B = 0.70;
  let bx = 0;
  let br = 0;
  if (g >= A && g < B) {
    const t = (g - A) / (B - A);
    bx = mix(-0.58 * R_ONE, 0.78 * R_ONE, IN_OUT_3(t));
    /* Born small at the left, biggest as it reaches the rim, then pulled back in fast:
     * the swell has to DIE on an accelerating curve or the body deflates. */
    br = 0.56 * R_ONE * amp * (t < 0.82 ? Math.sin(Math.PI * (t / 0.82) * 0.5) ** 0.7 : 1 - IN_2((t - 0.82) / 0.18));
  }

  /* One breath after each swell leaves — the body gathering itself for the next. */
  const sy = g >= 0.70
    ? mix(1, 1.055, window_(g, 0.70, 0.79, OUT_STRONG)) * (g >= 0.79 ? mix(1.055, 1, window_(g, 0.79, 0.98, ELASTIC_TIGHT)) / 1.055 : 1)
    : 1;

  return {
    ...onePose(R_ONE),
    sx0: 1 / sy, sy0: sy, sx1: 1 / sy, sy1: sy,
    bx, by: 0, br,
  };
}

export function loopPose(state: LiquidStateName, clock: number): Pose {
  if (state === "thinking") return thinkingPose(clock);
  if (state === "writing") return writingPose(clock);
  return readingPose(clock);
}

/** How many bodies a state rests on. The transition to play is decided by this and
 *  nothing else, so a new state gets the right choreography for free. */
export function bodyCount(state: LiquidStateName): 1 | 2 {
  return state === "thinking" ? 2 : 1;
}

/* ── transitions ────────────────────────────────────────────────────────────────── */

export type TransitionKind = "split" | "merge" | "reform" | "enter" | "exit";

export const DURATION: Record<TransitionKind, number> = {
  split: 460,
  merge: 620,
  reform: 320,
  enter: 400,
  exit: 260,
};

export function kindFor(from: LiquidStateName | null, to: LiquidStateName | null): TransitionKind {
  if (from === null) return "enter";
  if (to === null) return "exit";
  const a = bodyCount(from);
  const b = bodyCount(to);
  if (a === 1 && b === 2) return "split";
  if (a === 2 && b === 1) return "merge";
  return "reform";
}

/** Per-parameter [start, end, ease] within the transition's own 0..1 clock. Anything
 *  not listed uses the default window. */
type Spec = Partial<Record<(typeof POSE_KEYS)[number], [number, number, Ease]>>;

function blend(from: Pose, to: Pose, p: number, spec: Spec, fallback: [number, number, Ease]): Pose {
  const out = {} as Pose;
  for (const key of POSE_KEYS) {
    const [a, b, ease] = spec[key] ?? fallback;
    out[key] = mix(from[key], to[key], window_(p, a, b, ease));
  }
  return out;
}

/**
 * ONE BODY BECOMES TWO — a tear.
 *
 *   gather   0.00 – 0.22   the mass squeezes inward (sx 0.80) and stands up. Surface
 *                          tension climbs to K_NECK. Nothing has moved yet; this is
 *                          the wind-up, and without it the split reads as a cut.
 *   tear     0.22 – 0.65   `half` opens on IN_2 — ACCELERATING, because a neck under
 *                          tension gives way faster the thinner it gets. k collapses
 *                          across the same window, so the bridge thins and snaps
 *                          rather than fading.
 *   throw    0.39 – 1.00   the right half keeps going: it arrives at the apex of the
 *                          loop's first jump with no vertical speed left (OUT_2), so
 *                          the loop takes over without a seam.
 *   ring     0.30 – 1.00   both halves come back to round on ELASTIC — starting while
 *                          they are still separating and finishing well after. That
 *                          overlap is the shape lagging the position, and it is the
 *                          only reason this reads as gel.
 */
function splitPose(from: Pose, to: Pose, p: number): Pose {
  const out = blend(from, to, p, {
    half: [0.22, 0.65, IN_2],
    r0: [0.18, 0.70, OUT_STRONG],
    r1: [0.18, 0.70, OUT_STRONG],
    lift1: [0.39, 1.0, OUT_2],
    lift0: [0.30, 0.72, OUT_2],
    cx: [0.0, 0.55, OUT_STRONG],
    sx0: [0.30, 1.0, ELASTIC],
    sy0: [0.30, 1.0, ELASTIC],
    sx1: [0.34, 1.0, ELASTIC],
    sy1: [0.34, 1.0, ELASTIC],
    br: [0.0, 0.22, IN_2],
    bx: [0.0, 0.22, IN_2],
    by: [0.0, 0.22, IN_2],
    alpha: [0, 0.2, OUT_STRONG],
  }, [0.1, 0.8, OUT_STRONG]);

  /* The gather, as a multiplier on top of the ring. It has to be multiplicative: the
   * ring is travelling from wherever the previous state left the shape, and an
   * additive wind-up would fight it. */
  const gather = window_(p, 0.0, 0.22, OUT_STRONG) * (1 - window_(p, 0.22, 0.52, IN_1));
  out.sx0 *= mix(1, 0.80, gather);
  out.sy0 *= mix(1, 1.16, gather);
  out.sx1 *= mix(1, 0.80, gather);
  out.sy1 *= mix(1, 1.16, gather);

  /* Surface tension: up while the neck is being drawn, gone the moment it parts. */
  out.k = mix(from.k, K_NECK, window_(p, 0, 0.30, OUT_STRONG));
  out.k = mix(out.k, to.k, window_(p, 0.34, 0.62, IN_2));
  return out;
}

/**
 * TWO BODIES BECOME ONE — a collision.
 *
 *   fall     0.00 – 0.26   both dots come off their beat and drop to the floor on
 *                          IN_2. Gravity, not a tween: they are ending a jump.
 *   rush     0.20 – 0.52   `half` closes on IN_2, fastest at contact. Surface tension
 *                          swells to K_NECK BEFORE they touch, so the neck reaches
 *                          across the gap first — that reach is the single most
 *                          metaball thing this component does.
 *   squash   0.44 – 0.56   they meet: sx 0.86 / sy 1.22, on the axis they collided
 *                          along, in 74ms.
 *   squirt   0.46 – 0.90   a droplet is thrown straight up out of the impact and
 *                          falls back in on a parabola, reabsorbed as it lands.
 *   ring     0.56 – 1.00   round again on ELASTIC, still ringing as the writing loop
 *                          takes over.
 */
function mergePose(from: Pose, to: Pose, p: number): Pose {
  const out = blend(from, to, p, {
    lift0: [0.0, 0.26, IN_2],
    lift1: [0.0, 0.26, IN_2],
    half: [0.20, 0.52, IN_2],
    cx: [0.10, 0.62, OUT_STRONG],
    r0: [0.30, 0.80, OUT_STRONG],
    r1: [0.30, 0.80, OUT_STRONG],
    sx0: [0.20, 0.44, OUT_STRONG],
    sy0: [0.20, 0.44, OUT_STRONG],
    sx1: [0.20, 0.44, OUT_STRONG],
    sy1: [0.20, 0.44, OUT_STRONG],
    br: [0.90, 1.0, OUT_STRONG],
    bx: [0.90, 1.0, OUT_STRONG],
    by: [0.90, 1.0, OUT_STRONG],
    alpha: [0, 0.2, OUT_STRONG],
  }, [0.15, 0.8, OUT_STRONG]);

  const hit = window_(p, 0.44, 0.56, IN_2) * (1 - window_(p, 0.56, 1.0, ELASTIC));
  out.sx0 *= mix(1, 0.86, hit);
  out.sy0 *= mix(1, 1.22, hit);
  out.sx1 *= mix(1, 0.86, hit);
  out.sy1 *= mix(1, 1.22, hit);

  /* The droplet. Up hard, over, and down under the same parabola a dot jumps on, so
   * the whole component obeys one gravity. */
  const s = (p - 0.46) / (0.90 - 0.46);
  if (s > 0 && s < 1) {
    const fly = 4 * s * (1 - s);
    out.br = 0.44 * R_DOT * Math.sin(Math.PI * Math.min(s * 1.35, 1));
    out.by = -0.33 * fly;
    out.bx = mix(0, 0.02, s);
  }

  out.k = mix(from.k, K_NECK, window_(p, 0.06, 0.40, OUT_STRONG));
  out.k = mix(out.k, to.k, window_(p, 0.52, 0.86, OUT_STRONG));
  return out;
}

/** ONE BODY STAYS ONE — reading becoming writing, or the reverse. No drama is
 *  available and none should be invented: the mass simply travels to where the next
 *  loop starts, decelerating, and gives one breath as it arrives. */
function reformPose(from: Pose, to: Pose, p: number): Pose {
  const out = blend(from, to, p, {
    cx: [0.0, 0.72, OUT_STRONG],
    sx0: [0.10, 1.0, SETTLE],
    sy0: [0.10, 1.0, SETTLE],
    sx1: [0.10, 1.0, SETTLE],
    sy1: [0.10, 1.0, SETTLE],
    br: [0.0, 0.34, IN_1],
  }, [0.0, 0.8, OUT_STRONG]);
  const breath = window_(p, 0.30, 0.52, OUT_STRONG) * (1 - window_(p, 0.52, 1.0, ELASTIC_TIGHT));
  out.sy0 *= mix(1, 1.07, breath);
  out.sx0 *= mix(1, 1 / 1.07, breath);
  return out;
}

/** The arrival: a droplet falls in from above and splats. It never fades in — a liquid
 *  indicator that dissolves into existence has already told you it is a picture. */
function enterPose(to: Pose, p: number): Pose {
  const drop = window_(p, 0.0, 0.46, IN_2);
  const out: Pose = { ...to };
  out.lift0 = mix(0.30, 0, drop);
  out.lift1 = out.lift0;
  out.r0 = mix(to.r0 * 0.86, to.r0, window_(p, 0.1, 0.7, OUT_STRONG));
  out.r1 = out.r0;
  out.half = to.half * window_(p, 0.46, 1.0, OUT_STRONG);

  /* Stretched by the fall, flattened by the floor, and back on the pop spring — the
   * loudest curve in the family, because this body has just arrived from nowhere. */
  const fall = drop * (1 - window_(p, 0.40, 0.46, IN_1));
  const splat = window_(p, 0.46, 0.52, IN_2) * (1 - window_(p, 0.52, 1.0, POP));
  const sy = mix(1, 1.34, fall) * mix(1, 0.66, splat);
  out.sy0 = sy;
  out.sy1 = sy;
  out.sx0 = 1 / sy;
  out.sx1 = 1 / sy;
  out.br = 0;
  out.alpha = window_(p, 0, 0.12, OUT_STRONG);
  out.k = to.k;
  return out;
}

/** The departure: wind up the wrong way, then collapse. Exits are authored, never
 *  reversed — the anticipation is what makes the collapse read as intent. */
function exitPose(from: Pose, p: number): Pose {
  const out: Pose = { ...from };
  const shrink = window_(p, 0.0, 1.0, ANTICIPATE);
  out.r0 = from.r0 * (1 - shrink);
  out.r1 = from.r1 * (1 - shrink);
  out.br = from.br * (1 - shrink);
  out.half = from.half * (1 - window_(p, 0.2, 1.0, IN_2));
  const sy = mix(1, 1.3, window_(p, 0.3, 1.0, IN_2));
  out.sy0 = from.sy0 * sy;
  out.sy1 = from.sy1 * sy;
  out.sx0 = from.sx0 / sy;
  out.sx1 = from.sx1 / sy;
  out.alpha = 1 - window_(p, 0.55, 1.0, IN_1);
  return out;
}

/* ── the machine ────────────────────────────────────────────────────────────────── */

export interface Motion {
  /** null while entering */
  from: LiquidStateName | null;
  /** null while leaving */
  to: LiquidStateName | null;
  kind: TransitionKind;
  /** the pose the mass was in at the instant the state changed. Captured, not
   *  reconstructed — that is what makes an interrupted transition resume from where it
   *  actually is instead of snapping to a canonical start. */
  fromPose: Pose;
  /** ms elapsed in the transition */
  elapsed: number;
}

/** The pose at a moment. `motion` null means the state's loop owns the picture. */
export function poseAt(state: LiquidStateName, clock: number, motion: Motion | null): Pose {
  if (!motion) return loopPose(state, clock);
  const p = Math.min(motion.elapsed / DURATION[motion.kind], 1);
  if (motion.kind === "enter") return enterPose(loopPose(state, 0), p);
  if (motion.kind === "exit") return exitPose(motion.fromPose, p);
  const to = loopPose(state, 0);
  if (motion.kind === "split") return splitPose(motion.fromPose, to, p);
  if (motion.kind === "merge") return mergePose(motion.fromPose, to, p);
  return reformPose(motion.fromPose, to, p);
}

/** The one pose a reduced-motion viewer sees: the state's shape, at rest, no beat.
 *  Two dots still mean thinking and one body still means writing, so the indicator
 *  keeps SAYING something — it just stops performing. */
export function staticPose(state: LiquidStateName): Pose {
  if (state === "thinking") {
    return { ...onePose(R_DOT), half: HALF, k: K_APART };
  }
  return onePose(R_ONE);
}

export const GEOMETRY = { GROUND, R_DOT, R_ONE, HALF, JUMP, SWEEP, K_APART, K_NECK, K_ONE, P_THINK, P_WRITE, P_READ };
