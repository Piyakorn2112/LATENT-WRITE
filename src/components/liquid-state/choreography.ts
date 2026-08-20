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

export type LiquidStateName = "idle" | "reading" | "thinking" | "writing";

/* ── geometry, in a unit box where 1 = the component's size ─────────────────────── */

/** The floor every body rests on. Shared by all three states on purpose: one material,
 *  one surface. A squash pins the CONTACT POINT, not the centre — which is the whole
 *  difference between a landing and a shrink. */
const GROUND = 0.72;
/** Rest radius of one thinking dot. */
const R_DOT = 0.098;
/** Rest radius of the single body. Two dots of R_DOT have area 2πR², so one body of
 *  the same volume is R√2 = 0.247; a touch under that reads better at 18px, and the
 *  merge is a droplet coalescing, not a conservation law. */
const R_ONE = 0.229;
/** Half the centre-to-centre separation while thinking. */
/** Spacing between adjacent dots. THREE of them now, so the pair that used to have
 *  the box to itself has a neighbour in the middle and everything shrinks. */
const HALF = 0.285;
/** How high a dot jumps. At 0.152 the filmstrip read as a bob rather than a jump —
 *  about three pixels of travel at the size this ships at. The ceiling is the apex
 *  clearing the top of the canvas: GROUND − 2·R_DOT − JUMP. */
const JUMP = 0.20;
/** Flight stretch at maximum vertical speed. Round at the apex, longest at launch and
 *  landing — and it is derived from the arc's own velocity, not authored per beat. */
const STRETCH = 0.17;
/** How flat a dot goes on impact. */
const SPLAT = 0.84;
/** How far the single body sweeps while reading. 0.108 was under two pixels at 18px
 *  and read as a circle pulsing in place rather than as anything scanning. */
/** How far each scanned line runs, either side of centre. */
const READ_SPAN = 0.30;

/** Surface tension between two separate dots: NONE.
 *
 *  ★ The blend band is `k / (1 − √½)` wide — 3.4× k — so a k of 0.014 draws a band
 *    0.86px across at 18px, and the narrowest the dots ever get is 0.75px apart (a
 *    crouch beside a splat, twice a cycle). A band wider than the gap is a neck, and a
 *    neck at that moment is the two dots reading as one lump exactly when they are
 *    supposed to be most clearly two. Measured: 0.11px of clearance at 210ms.
 *
 *  The dots do not need to be aware of each other while apart — the surface tension
 *  belongs to the tear and the collision, where there is a gap worth bridging. Zero
 *  here, and the gate demands more than half a pixel of daylight for the whole cycle. */
const K_APART = 0;
/** Surface tension while a mass is tearing or coalescing: the band has to be wide
 *  enough to bridge the gap before contact, which is what draws the neck. */
const K_NECK = 0.105;
/** Surface tension inside a single body: ZERO, and it has to be exactly zero. Two
 *  coincident bodies blended at k read as one body inflated by EXACTLY k, so any other
 *  value silently makes the merged blob a different size than the one authored — and
 *  the gate that compares the painted width with `R_ONE` would be measuring the blend
 *  rather than the radius. At k=0 the blend is min() and two coincident circles are one
 *  circle. See field.ts on why every body carries its own k. */
const K_ONE = 0;
/* ── the resting mark ───────────────────────────────────────────────────────────────
 * ★★ IDLE IS THE APP'S ACTUAL ORB — the WebGL `OrbEngine`, not a drawing of it.
 *
 *    An earlier version rebuilt the orb as six metaball petals so the mark could morph
 *    natively. The geometry was right (taken from `orbPhysics.ts`) and it still looked
 *    wrong: the orb is a lens with a per-petal palette and per-channel dispersion, and
 *    six flat blobs of one colour is not that. A component whose whole job is to BE the
 *    app's mark at rest cannot ship an approximation of it.
 *
 *    So the orb renders itself, and the two pictures hand over. The hand-over is the
 *    craft: the orb SHRINKS AND BLURS INTO A DROPLET first, and only once it is a small
 *    soft blob — a shape the metaball can match exactly — does the canvas take it. Two
 *    pictures that are the same soft blob at the same instant swap without a seam, and
 *    a couple of pixels of blur is what makes them the same. That is the one place
 *    blur is used here, and it is used because it is the only thing that works.
 *
 *    The orb's own layer is driven from these pose channels, on the same clock as
 *    everything else, so there is no second timeline to keep in step. */
/** What the orb shrinks to before the canvas takes over, and how soft both go. */
const ORB_SMALL = 0.46;
const ORB_BLUR = 2.7;
/** The blob the canvas picks up — sized to read as the shrunken, blurred orb. */
const HANDOFF_R = 0.108;

/* ── the pen ────────────────────────────────────────────────────────────────────────
 * ★★ WRITING IS A PEN, and it needs a shape the rest of this file cannot make. A nib
 *    is a POINT, and no union of ellipses produces one: every blend rounds it off and
 *    a smaller ellipse is just a smaller blob. `field.ts` grew a rounded cone for it —
 *    an exact SDF, so the nib is a real corner and the barrel still blends with the
 *    ink it is laying down. */
const PEN_LEN = 0.36;
const PEN_R = 0.062;
const PEN_TIP = 0.008;
/** ★ A PEN IS A BARREL AND A HEAD, not a taper. One cone from end to end reads as a
 *  stick sharpened at one end — which is a pencil at best and, at 18px, a random
 *  diagonal shape. A real pen has a barrel of CONSTANT width, a shoulder where it
 *  steps in, and a short cone to the nib. Three numbers, one visible step, and the
 *  silhouette stops being ambiguous. */
const PEN_HEAD = 0.34;
const PEN_NECK = 0.60;
/** Held at 135°: barrel up and to the right, nib down and to the left. */
const PEN_ROT = 2.36;
/** How far the nib travels across the line, each way from centre. */
const PEN_TRAVEL = 0.085;
/** The line it leaves. */
const INK_H = 0.036;
const INK_Y = GROUND - INK_H;
const K_INK = 0.007;
/** The two line heights the reading scan alternates between — one above the other, so
 *  the scan visibly moves down a page rather than re-reading one line forever. */
const READ_LINE_HI = GROUND - 0.30;
const READ_LINE_LO = INK_Y;

/** The blend that joins the reaching lobe/** The blend that joins the reaching lobe to the writing body. Its own, because the
 *  lobe has to stay soft-edged at the same moment the merged pair is at k=0 — and it
 *  has to be SMALL: the band is 3.4×k, and at 0.062 that is 0.21 units, nearly the
 *  width of the body itself, so the blend filled the waist and the reach read as the
 *  body simply inflating. A waist is the whole point. */
const K_SWELL = 0.038;

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
  /** the pen: nib position, angle, barrel radius and length. penR = 0 means no pen. */
  penX: number;
  penY: number;
  penRot: number;
  penR: number;
  penLen: number;
  /** the line: centre offset from cx, half-length, height, and how present it is
   *  (0 = no line at all; it scales the stroke's THICKNESS, so the line thins away
   *  rather than being switched off). Written by the pen, and swept by `reading`. */
  inkX: number;
  inkW: number;
  inkY: number;
  inkA: number;
  /** the middle dot. Zero everywhere except `thinking`. */
  r2: number;
  lift2: number;
  sx2: number;
  sy2: number;
  /** the orb's own layer, driven from the same clock as the canvas so the hand-over
   *  never has two timelines to keep in step */
  orbScale: number;
  orbBlur: number;
  orbAlpha: number;
  /** surface tension */
  k: number;
  /** how far past one device pixel the edge ramp runs. Non-zero only across the
   *  hand-over, where it is what makes the two pictures the same picture. */
  soft: number;
  /** whole-mass opacity */
  alpha: number;
}

const POSE_KEYS = [
  "cx", "half", "r0", "r1", "lift0", "lift1",
  "sx0", "sy0", "sx1", "sy1", "bx", "by", "br",
  "penX", "penY", "penRot", "penR", "penLen", "inkX", "inkW", "inkY", "inkA",
  "r2", "lift2", "sx2", "sy2",
  "orbScale", "orbBlur", "orbAlpha", "soft", "k", "alpha",
] as const;

function onePose(r: number, cx = 0.5): Pose {
  return {
    cx, half: 0, r0: r, r1: r, lift0: 0, lift1: 0,
    sx0: 1, sy0: 1, sx1: 1, sy1: 1, bx: 0, by: 0, br: 0,
    penX: 0, penY: INK_Y - INK_H * 0.25, penRot: PEN_ROT, penR: 0, penLen: PEN_LEN,
    inkX: 0, inkW: 0, inkY: INK_Y, inkA: 0,
    r2: 0, lift2: 0, sx2: 1, sy2: 1,
    orbScale: ORB_SMALL, orbBlur: ORB_BLUR, orbAlpha: 0,
    k: K_ONE, soft: 0, alpha: 1,
  };
}

/**
 * Bodies, in the order `field.ts` folds them: the two dots first (so the neck between
 * them is always the same blend), then the swell.
 *
 * ★★ ALWAYS THREE BODIES, NEVER A CONDITIONAL. An earlier version dropped the second
 *    body once the pair had merged and dropped the swell once its radius reached zero,
 *    which is a discrete branch in the middle of a continuous animation — the picture
 *    stepped by ~160 square pixels in a single frame at the end of every merge, split
 *    and entrance, and only a scaling continuity gate found it. Instead every body is
 *    always present and a body that should not be seen is made to contribute NOTHING:
 *    zero radius AND zero blend. A point with k=0 folded into a mass it lies inside is
 *    exactly min(), which is a no-op. That is why the swell's blend is tied to its own
 *    radius here rather than authored beside it — the invariant is enforced at the one
 *    place it can be, not remembered at every call site.
 */
export function fieldOf(pose: Pose): Field {
  const ry0 = pose.r0 * pose.sy0;
  const ry1 = pose.r1 * pose.sy1;
  /* Ties the swell's blend to its own radius: full blend at its working size, gone by
   * the time it has shrunk away.
   *
   * ★ AND THINS IT AS THE BODY LEAVES THE MASS. The third body does two jobs: it is
   *   the lobe the writing state reaches out with (which never leaves, `by` = 0) and
   *   it is the droplet the collision throws upward (which does). With a fixed blend
   *   the droplet stayed welded to the mass by a band 3.4×k wide and read as a spike
   *   growing out of the top rather than as a splash. Tying the blend to how far it
   *   has risen gives it a neck that stretches, thins, snaps — and reforms on the way
   *   back down. */
  const swell = Math.min(pose.br / (0.34 * R_ONE), 1);
  const penScale = Math.min(pose.penR / PEN_R, 1);
  const penLen = pose.penLen * penScale;
  const headLen = penLen * PEN_HEAD;
  const dirX = Math.cos(pose.penRot);
  const dirY = Math.sin(pose.penRot);
  const flown = 1 - Math.min(Math.abs(pose.by) / 0.30, 1);
  /* ★★ AND TIES THE PAIR'S BLEND TO THEIR SEPARATION, which is the same invariant
   *    pointing the other way. `smin(a, a, k)` is `a − k` exactly: two COINCIDENT
   *    bodies blended at k are one body INFLATED BY k, so authored k must vanish as
   *    the gap does or the merged blob is silently the wrong size (measured before
   *    this existed: 5.7 device pixels too wide, off the left of the canvas).
   *
   *    ★★ AND THE SCALE IT IS MEASURED AGAINST IS A CONSTANT, not the bodies' own
   *       radius. The first version divided the separation by `0.5 · r0` — a ratio of
   *       two quantities that BOTH go to zero at a merge, so its derivative blows up
   *       exactly where it matters: the blend radius moved 34% in half a millisecond
   *       while every pose parameter was smooth to five decimals. Against K_NECK — the
   *       widest band anything here ever asks for — the taper is well behaved
   *       everywhere, and smoothstepped so it has no corner at either end. */
  const gap = Math.min(pose.half / K_NECK, 1);
  const pair = gap * gap * (3 - 2 * gap);
  return {
    bodies: [
      {
        x: pose.cx - pose.half,
        y: GROUND - ry0 - pose.lift0,
        rx: pose.r0 * pose.sx0,
        ry: ry0,
        k: 0,
      },
      {
        x: pose.cx + pose.half,
        y: GROUND - ry1 - pose.lift1,
        rx: pose.r1 * pose.sx1,
        ry: ry1,
        k: pose.k * pair,
      },
      {
        /* ★ THE THREE DOTS ARE BODIES 0, 1 AND 2, in that order and before anything
         * else. Which index a body lands on is not an implementation detail once a
         * probe has to name one: the middle dot used to be emitted last, so adding a
         * second body to the pen silently moved it and the gate that checks the row
         * reads as separate dots started measuring the pen's barrel instead. */
        x: pose.cx,
        y: GROUND - pose.r2 * pose.sy2 - pose.lift2,
        rx: pose.r2 * pose.sx2,
        ry: pose.r2 * pose.sy2,
        k: pose.k * pair,
      },
      {
        x: pose.cx + pose.bx,
        y: GROUND - pose.r0 + pose.by,
        rx: pose.br,
        ry: pose.br,
        k: K_SWELL * swell * swell * flown,
      },
      /* The ink first, so the pen blends INTO the line it is drawing rather than the
       * other way round — the fold order is what decides which shape the neck belongs
       * to, and a nib growing a skirt where it meets its own stroke is the artifact
       * that order prevents. */
      {
        /* ★ A CAPSULE, NOT AN ELLIPSE. A stroke of ink has round ends, and more to the
         *   point an ellipse of half-width 0.0001 and half-height 0.026 is 217:1, far
         *   past where iq's ellipse approximation holds — it reported near-zero
         *   distance the length of the column and painted a line from the top of the
         *   canvas to the bottom. A capsule is a cone with equal radii, its SDF is
         *   exact at every length, and at zero length it is a dot, which is exactly
         *   what a pen that has just touched down should leave. */
        x: pose.cx + pose.inkX - pose.inkW,
        y: pose.inkY,
        rx: INK_H * pose.inkA,
        ry: INK_H * pose.inkA,
        tip: INK_H * pose.inkA,
        len: pose.inkW * 2,
        k: K_INK,
      },
      {
        /* A cone runs from its origin along its own +x, so the body sits at the BARREL
         * and the nib is what the choreography actually positions.
         *
         * ★ THE PEN'S LENGTH IS TIED TO ITS RADIUS, and both the body's `len` and the
         *   barrel offset use the SAME derived value. An earlier version switched the
         *   cone off with `len: penR > 1e-4 ? penLen : 0`, which is a discrete branch
         *   in the middle of a continuous animation: a needle 0.34 long became a
         *   0.0001 dot between two frames every time a transition took the pen away.
         *   A pen that shrinks retracts into its own nib instead. */
      /* THE PEN, IN TWO PARTS. The head is a short cone from the shoulder to the nib;
       * the barrel is a capsule of constant width running back from the same shoulder.
       * They meet at a step, and the step is the whole point — it is what makes the
       * silhouette read as a pen rather than as a sharpened stick. */
        x: pose.cx + pose.penX - dirX * headLen,
        y: pose.penY - dirY * headLen,
        rx: pose.penR * PEN_NECK,
        ry: pose.penR * PEN_NECK,
        tip: PEN_TIP * penScale,
        len: headLen,
        rot: pose.penRot,
        k: K_INK,
      },
      {
        x: pose.cx + pose.penX - dirX * headLen,
        y: pose.penY - dirY * headLen,
        rx: pose.penR,
        ry: pose.penR,
        tip: pose.penR,
        len: penLen - headLen,
        rot: pose.penRot + Math.PI,
        k: K_INK * 0.5,
      },
    ],
    soft: pose.soft,
  };
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
/** Idle has no loop of its own — the orb animates itself. The number is only what a
 *  harness sweeps when it wants "a cycle of idle". */
const P_IDLE = 1000;

/** One dot's own beat. φ = 0 is REST ON THE FLOOR, which is what every transition into
 *  `thinking` hands over to.
 *
 *      rest      0.00 – 0.12   nothing; the beat needs a floor or it reads as a jitter
 *      crouch    0.12 – 0.26   sy 1 → 0.90, gathering. Anticipation, on a curve that
 *                              does NOT ring — a crouch that wobbles reads as a fault
 *      push-off  0.26 – 0.32   sy 0.90 → flight, on IN_2. Accelerating out of the
 *                              crouch is what makes the launch read as effort
 *      flight    0.26 – 0.68   lift on a parabola; the stretch is DERIVED from the
 *                              arc's own velocity, so the dot is longest where it is
 *                              fastest and perfectly round at the apex
 *      impact    0.68 – 0.755  sy 1.17 → 0.80 on IN_2. 61ms, and it has to be that
 *                              fast: an impact you can watch is not an impact
 *      ring      0.755 – 1.00  back to round on ELASTIC, 201ms of settling
 *
 *  ★ THE TWO DOTS MUST STAY TWO. Both are on the floor for two short windows per
 *    cycle, and in them the widest thing one dot does (the splat) meets the widest
 *    thing the other does (the crouch). R_DOT, HALF, SPLAT and the crouch are sized
 *    together so the surfaces still clear each other by more than K_APART; a gate
 *    samples the field between the dots across the whole cycle and requires it to
 *    stay outside. Change any one of those four and that gate is the one that fires.
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
  else if (f < 0.26) sy = mix(1, 0.90, window_(f, 0.12, 0.26, OUT_STRONG));
  else if (f < 0.32) sy = mix(0.90, flightSy(u), window_(f, 0.26, 0.32, IN_2));
  else if (f < AIR_B) sy = flightSy(u);
  else if (f < 0.755) sy = mix(flightSy(1), SPLAT, window_(f, AIR_B, 0.755, IN_2));
  else sy = mix(SPLAT, 1, window_(f, 0.755, 1, ELASTIC));

  /* Area conservation: a droplet that squashes gets wider by exactly as much as it
   * gets shorter. One authored number instead of two that can drift apart. */
  return { lift, sx: 1 / sy, sy };
}

function thinkingPose(clock: number): Pose {
  const t = clock / P_THINK;
  /* ★ THREE DOTS, A THIRD OF A CYCLE APART. Two alternating reads as a see-saw; three
   *   in sequence reads as a run, which is what a row of thinking dots is for. The
   *   phase order is left, middle, right so the wave travels rather than bouncing. */
  const j0 = 0.94 + 0.12 * jitter(Math.floor(t), 1);
  const j2 = 0.94 + 0.12 * jitter(Math.floor(t + 1 / 3), 2);
  const j1 = 0.94 + 0.12 * jitter(Math.floor(t + 2 / 3), 3);
  const a = dotBeat(t, j0);
  const c = dotBeat(t + 1 / 3, j2);
  const b = dotBeat(t + 2 / 3, j1);
  /* Built off onePose rather than as a literal, so a pose parameter added later
   * cannot be silently missing here — an undefined `petal` is not <= 1e-4, so the
   * resting mark's ring would be built from NaN and every gate that reads the field
   * would report NaN, which compares false against everything. */
  return {
    ...onePose(R_DOT),
    half: HALF,
    lift0: a.lift, lift1: b.lift,
    sx0: a.sx, sy0: a.sy, sx1: b.sx, sy1: b.sy,
    r2: R_DOT, lift2: c.lift, sx2: c.sx, sy2: c.sy,
    k: K_APART,
  };
}

/**
 * READING — a line being scanned, then the next one.
 *
 * ★ IT USED TO BE A LOZENGE SLIDING LEFT AND RIGHT, which at 18px is a blob moving a
 *   couple of pixels, and which shares a silhouette with anything else round. What
 *   reading actually looks like is a line of text being taken in and then the eye
 *   dropping to the next one, so that is what it draws — the same capsule the pen
 *   lays down, used as the line rather than as the ink.
 *
 *   grow    0.00 – 0.55   the bar's left end is pinned at the start of the line and
 *                         its right end runs out along it, decelerating
 *   gather  0.55 – 0.84   the left end catches up: the line collapses into a dot at
 *                         the end it finished on. Accelerating, because this is the
 *                         part nobody spends time on
 *   drop    0.84 – 1.00   the dot falls to the start of the next line, and the two
 *                         lines alternate, so the cycle is one line read
 */
function readingPose(clock: number): Pose {
  const f = clock / P_READ;
  const g = f - Math.floor(f);
  /* Two line heights, alternating each cycle, so the scan visibly moves down a page
   * rather than re-reading one line forever. */
  const line = Math.floor(f) % 2 === 0 ? READ_LINE_HI : READ_LINE_LO;
  const next = Math.floor(f + 1) % 2 === 0 ? READ_LINE_HI : READ_LINE_LO;

  const L = -READ_SPAN;
  const R = READ_SPAN;
  let lo = L;
  let hi = L;
  if (g < 0.55) hi = mix(L, R, IN_OUT_3(g / 0.55));
  else if (g < 0.84) { hi = R; lo = mix(L, R, IN_2((g - 0.55) / 0.29)); }
  else { hi = R; lo = R; }

  const drop = window_(g, 0.84, 1.0, IN_OUT_3);
  const cx = mix((lo + hi) / 2, L, drop);
  const y = mix(line, next, drop);

  const pose = onePose(0);
  pose.inkX = cx;
  pose.inkW = mix((hi - lo) / 2, 0, drop);
  pose.inkY = y;
  pose.inkA = 1;
  /* The dead mass rides the bar, so a transition into or out of this state grows and
   * shrinks where the bar actually is. */
  pose.lift0 = GROUND - y;
  pose.lift1 = pose.lift0;
  return pose;
}

/**
 * WRITING — a pen, drawing.
 *
 *   stroke   0.00 – 0.70   the nib travels left to right along the line, bobbing twice
 *                          the way a hand does, and the ink grows behind it. The travel
 *                          is power4.inOut, so the pen is quickest through the middle
 *                          of the stroke and settles at each end — nobody writes at a
 *                          constant speed
 *   lift     0.70 – 0.86   the nib comes off the paper and the pen tips back; the ink
 *                          it has laid stops growing and starts to go
 *   return   0.80 – 1.00   back to the left, above the line, faster than it wrote —
 *                          the carriage return, and the beat that makes the loop read
 *                          as one stroke repeated rather than a shape sliding about
 *
 * The pen is held at a constant 135° with a small wobble; a nib whose angle chases its
 * own travel reads as a compass needle, not a hand.
 */
function writingPose(clock: number): Pose {
  const f = clock / P_WRITE;
  const g = f - Math.floor(f);
  const amp = 0.92 + 0.16 * jitter(Math.floor(f), 3);

  const END = 0.70;
  const LIFT = 0.86;

  let nib: number;
  let lift = 0;
  if (g < END) {
    nib = mix(-PEN_TRAVEL, PEN_TRAVEL * amp, IN_OUT_3(g / END));
  } else if (g < LIFT) {
    nib = PEN_TRAVEL * amp;
    lift = window_(g, END, LIFT, OUT_2);
  } else {
    /* ★ THE RETURN'S WINDOW STARTS WHERE THE BRANCH DOES. It used to open at 0.80
     *   while the branch is only reached at 0.86, so the first frame of the return was
     *   already 30% along the curve and the nib jumped 0.011 — the continuity gate
     *   read 1.16 against an ideal 8. A window that begins before its own branch is
     *   the same bug as a beat that does not meet. */
    nib = mix(PEN_TRAVEL * amp, -PEN_TRAVEL, window_(g, LIFT, 1.0, IN_OUT_3));
    /* ★ THE NIB COMES DOWN ON AN ACCELERATING CURVE, not a decelerating one. Partly
     *   because that is what lowering a hand does, and partly because OUT_STRONG's
     *   start is close to vertical: the descent moved as far in the first four
     *   milliseconds as in the next forty, which the continuity gate reads as a
     *   near-step (ratio 2.35 against an ideal 8). A sub-frame event at 60Hz is detail
     *   nobody can see and everybody pays for. */
    lift = 1 - window_(g, 0.90, 1.0, IN_1);
  }

  /* Two humps across the stroke, the size of a letter's ascender. */
  const bob = g < END ? Math.sin(2 * Math.PI * 2 * (g / END)) * 0.014 : 0;

  const pose = onePose(0);
  pose.penR = PEN_R;
  pose.penLen = PEN_LEN;
  pose.penX = nib;
  pose.penY = INK_Y - INK_H * 0.25 - bob - lift * 0.075;
  /* The wobble is on the ANGLE and it is tiny: a hand rocks, it does not steer. */
  pose.penRot = PEN_ROT + Math.sin(2 * Math.PI * (g * 2 + 0.2)) * 0.045;

  /* The ink runs from where the stroke started to wherever the nib got to, and fades
   * once the pen has left it.
   *
   * ★ ITS LENGTH IS HELD AFTER THE STROKE ENDS AND ONLY ITS OPACITY GOES. Recomputing
   *   the half-length as zero the moment the pen lifted collapsed a line 0.115 wide to
   *   nothing between two frames — the continuity gate read a ratio of 1.39 against an
   *   ideal 8, which is the signature of a step rather than a fast curve. A line does
   *   not un-draw itself from both ends. */
  const drawnTo = g < END ? nib : PEN_TRAVEL * amp;
  const half = (drawnTo + PEN_TRAVEL) / 2;
  /* ★ THE LINE IS TOUCHED DOWN, NOT SWITCHED ON. Without the touch-down ramp `inkA`
   *   went from 0 at the end of one cycle to 1 at the start of the next, and since the
   *   stroke has no length yet at that moment it appeared as a full-thickness DOT in
   *   one frame, every cycle. A nib arrives on the paper; it does not blink on. */
  const touch = Math.min(g / 0.05, 1);
  const fade = touch * (g < END ? 1 : 1 - window_(g, END, 0.98, IN_1));
  pose.inkX = -PEN_TRAVEL + half;
  pose.inkW = Math.max(half, 0);
  pose.inkA = Math.max(fade, 0);

  /* ★ THE DEAD BODY IS PARKED AT THE NIB. Writing has no mass of its own — `r0` is
   *   zero and the main body is not drawn — but every transition INTO this state
   *   shrinks a real mass down to it, and every transition out grows one back. Where
   *   that mass converges decides whether the pen grows out of it or beside it: parked
   *   at the centre, the merge showed a round blob with a stub of pen sprouting off to
   *   one side. Parked at the nib, the pen extends from exactly where the mass went. */
  pose.lift0 = GROUND - pose.penY;
  pose.lift1 = pose.lift0;
  return pose;
}

/** IDLE — the orb has the picture and the canvas has nothing. The blob the canvas
 *  parks at is the shape it will pick the hand-over up from, so it is defined here
 *  even though it is invisible: a transition blends from a pose, not from nothing. */
function idlePose(): Pose {
  const pose = onePose(HANDOFF_R);
  pose.lift0 = R_ONE - HANDOFF_R;
  pose.lift1 = pose.lift0;
  pose.orbScale = 1;
  pose.orbBlur = 0;
  pose.orbAlpha = 1;
  pose.soft = ORB_BLUR;
  pose.alpha = 0;
  pose.k = 0;
  return pose;
}

export function loopPose(state: LiquidStateName, clock: number): Pose {
  if (state === "idle") return idlePose();
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

export type TransitionKind = "split" | "merge" | "reform" | "gather" | "bloom" | "enter" | "exit";

export const DURATION: Record<TransitionKind, number> = {
  split: 460,
  merge: 620,
  reform: 320,
  /* The mark liquefying and reforming are the two longest beats in the component, and
   * they have to be: six bodies must become one before anything else can happen, and a
   * bloom that hurries reads as the petals being switched on rather than growing. */
  gather: 620,
  bloom: 660,
  enter: 400,
  exit: 260,
};

export function kindFor(from: LiquidStateName | null, to: LiquidStateName | null): TransitionKind {
  if (from === null) return "enter";
  if (to === null) return "exit";
  if (from === "idle") return "gather";
  if (to === "idle") return "bloom";
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
    /* The halves get small BECAUSE they separate — front-loading the shrink made the
     * mass look like it deflated and then split, which is two events, not one. */
    r0: [0.30, 0.78, OUT_STRONG],
    r1: [0.30, 0.78, OUT_STRONG],
    /* The middle dot does not have to be torn off anything — it IS what is left of the
     * mass once the outer two have gone, so it simply resolves where the mass was. */
    r2: [0.10, 0.62, OUT_STRONG],
    lift2: [0.34, 0.86, OUT_2],
    sx2: [0.30, 1.0, ELASTIC],
    sy2: [0.30, 1.0, ELASTIC],
    inkY: [0.0, 0.5, OUT_STRONG],
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
    /* A pen retracts into its own nib first, and the mass grows from there. Both
     * happen before the tear, so the shape is one body again by the time it parts. */
    penR: [0.0, 0.30, IN_1],
    penLen: [0.0, 0.30, IN_1],
    inkA: [0.0, 0.20, IN_1],
    inkW: [0.0, 0.26, IN_1],
    penX: [0.06, 0.40, OUT_STRONG],
    penY: [0.06, 0.40, OUT_STRONG],
  }, [0.1, 0.8, OUT_STRONG]);

  /* The gather, as a multiplier on top of the ring. It has to be multiplicative: the
   * ring is travelling from wherever the previous state left the shape, and an
   * additive wind-up would fight it. */
  const gather = window_(p, 0.0, 0.22, OUT_STRONG) * (1 - window_(p, 0.22, 0.52, IN_1));
  out.sx0 *= mix(1, 0.84, gather);
  out.sy0 *= mix(1, 1.14, gather);
  out.sx1 *= mix(1, 0.84, gather);
  out.sy1 *= mix(1, 1.14, gather);

  /* Surface tension: up while the neck is being drawn, gone the moment it parts. */
  /* ★ THE NECK HAS TO OUTLAST THE PARTING. The halves only clear each other's
   *   surfaces about 60% of the way through the tear, so a tension that has already
   *   collapsed by then means there was never a bridge to snap — the shapes simply
   *   separated. Measured with the gate: at a collapse window of [0.34, 0.62] the
   *   widest gap ever bridged was 0.00px. It holds to [0.44, 0.74] now. */
  out.k = mix(from.k, K_NECK, window_(p, 0, 0.30, OUT_STRONG));
  out.k = mix(out.k, to.k, window_(p, 0.44, 0.74, IN_2));
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
    /* ★ THE MASS DOES NOT TRAVEL UNTIL IT IS ONE MASS. Moving `cx` toward the target
     *   while `half` is still open carries the trailing dot off the canvas — measured,
     *   as border ink, on the merge into `reading` whose loop starts at the left end. */
    cx: [0.52, 1.0, OUT_STRONG],
    r0: [0.30, 0.80, OUT_STRONG],
    r1: [0.30, 0.80, OUT_STRONG],
    r2: [0.24, 0.72, OUT_STRONG],
    lift2: [0.0, 0.26, IN_2],
    sx2: [0.20, 0.44, OUT_STRONG],
    sy2: [0.20, 0.44, OUT_STRONG],
    inkY: [0.4, 0.9, OUT_STRONG],
    sx0: [0.20, 0.44, OUT_STRONG],
    sy0: [0.20, 0.44, OUT_STRONG],
    sx1: [0.20, 0.44, OUT_STRONG],
    sy1: [0.20, 0.44, OUT_STRONG],
    br: [0.90, 1.0, OUT_STRONG],
    bx: [0.90, 1.0, OUT_STRONG],
    by: [0.90, 1.0, OUT_STRONG],
    alpha: [0, 0.2, OUT_STRONG],
    /* If the target is a pen, it grows LAST and out of where the mass ended up — the
     * radii above have already carried the mass to the nib by then. */
    penX: [0.52, 0.88, OUT_STRONG],
    penY: [0.52, 0.88, OUT_STRONG],
    penR: [0.62, 1.0, OUT_STRONG],
    penLen: [0.62, 1.0, OUT_STRONG],
    inkA: [0.80, 1.0, OUT_STRONG],
    inkW: [0.80, 1.0, OUT_STRONG],
  }, [0.15, 0.8, OUT_STRONG]);

  const hit = window_(p, 0.44, 0.56, IN_2) * (1 - window_(p, 0.56, 1.0, ELASTIC));
  out.sx0 *= mix(1, 0.86, hit);
  out.sy0 *= mix(1, 1.22, hit);
  out.sx1 *= mix(1, 0.86, hit);
  out.sy1 *= mix(1, 1.22, hit);

  /* The droplet. Up hard, over, and down under the same parabola a dot jumps on, so
   * the whole component obeys one gravity.
   *
   * ★ IT HAS TO SURVIVE THE WHOLE ARC. The first envelope peaked at a third of the
   *   way up and was gone by three quarters — so the droplet evaporated at the top of
   *   its flight and never came home, which on the contact sheet read as a spike
   *   growing out of the mass and then a speck of dust. It now holds its size until it
   *   lands and is absorbed on the way in. */
  const s = (p - 0.46) / (0.92 - 0.46);
  if (s > 0 && s < 1) {
    const fly = 4 * s * (1 - s);
    out.br = 0.46 * R_DOT * (s < 0.16 ? IN_OUT_3(s / 0.16) : s > 0.80 ? 1 - IN_2((s - 0.80) / 0.20) : 1);
    out.by = -0.36 * fly;
    out.bx = mix(0, 0.03, s);
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
  /* ★ A BODY THAT TRAVELS LEANS. The reform is a real journey — a third of the box —
   *   and without the lean the contact sheet showed a circle in one place and the same
   *   circle in another, which is a cut, not a move. The lean peaks mid-flight and is
   *   gone before it arrives, so the landing is round. */
  const lean = window_(p, 0.0, 0.34, OUT_STRONG) * (1 - window_(p, 0.34, 0.80, IN_1));
  out.sx0 *= mix(1, 1.16, lean);
  out.sy0 *= mix(1, 1 / 1.16, lean);
  out.sx1 *= mix(1, 1.16, lean);
  out.sy1 *= mix(1, 1 / 1.16, lean);

  const breath = window_(p, 0.44, 0.62, OUT_STRONG) * (1 - window_(p, 0.62, 1.0, ELASTIC_TIGHT));
  out.sy0 *= mix(1, 1.09, breath);
  out.sx0 *= mix(1, 1 / 1.09, breath);
  out.sy1 *= mix(1, 1.09, breath);
  out.sx1 *= mix(1, 1 / 1.09, breath);
  return out;
}

/**
 * THE ARRIVAL — a droplet falls in from above and splats. It never fades in: a liquid
 * indicator that dissolves into existence has already told you it is a picture.
 *
 * ★ IT LANDS ON THE TARGET LOOP'S CLOCK-ZERO POSE LIKE EVERY OTHER TRANSITION, which
 *   for `thinking` means the splat also has to TEAR — that loop's first frame has one
 *   dot on the floor and the other already at the top of its jump. So the impact is
 *   what throws them apart, and the entrance into thinking reads as one drop landing
 *   and splitting rather than as two dots appearing.
 *
 * ★ A FALLING DROPLET IS SMALL AND LONG. At full size and 1.46 stretch there is no
 *   headroom above its own landing spot (GROUND − 2·ry leaves none), and the first
 *   frames were clipped flat against the top of the canvas. It grows as it lands.
 */
function enterPose(to: Pose, p: number): Pose {
  const two = to.half > 1e-4;
  const drop = window_(p, 0.0, 0.42, IN_1);
  const out: Pose = { ...to };

  out.lift0 = mix(0.20, to.lift0, drop);
  out.half = to.half * window_(p, 0.44, 0.88, IN_2);
  /* The half thrown up out of the splat arrives at the loop's apex with nothing left,
   * on a decelerating curve — same handshake the split makes. */
  out.lift1 = two ? mix(0.20, to.lift1, window_(p, 0.44, 1.0, OUT_2)) : out.lift0;
  out.r0 = mix(to.r0 * 0.76, to.r0, window_(p, 0.20, 0.86, OUT_STRONG));
  out.r1 = out.r0 * (to.r1 / to.r0);

  const fall = drop * (1 - window_(p, 0.36, 0.42, IN_1));
  const splat = window_(p, 0.42, 0.50, IN_2) * (1 - window_(p, 0.50, 1.0, POP));
  const sy = mix(1, 1.46, fall) * mix(1, 0.71, splat);
  out.sy0 = to.sy0 * sy;
  out.sx0 = to.sx0 / sy;
  out.sy1 = to.sy1 * sy;
  out.sx1 = to.sx1 / sy;

  /* ★ IT LANDS IN THE MIDDLE AND FLOWS TO ITS MARK. A splat is the widest the mass
   *   ever gets, and `reading` starts at the LEFT END of its sweep — dropping straight
   *   onto that mark put the splat's left edge off the canvas. Falling at the centre
   *   and travelling once it is one puddle is both the fix and the better read. */
  out.cx = mix(0.5, to.cx, window_(p, 0.50, 1.0, OUT_STRONG));
  out.br = to.br * window_(p, 0.70, 1.0, OUT_STRONG);
  out.bx = to.bx;
  out.by = to.by;
  /* Tension high through the tear, then away — the same beat the split uses. */
  out.k = mix(K_NECK, to.k, window_(p, 0.5, 0.92, IN_2));
  /* ★ NO FADE. The first frame used to be empty and the second a two-pixel speck,
   *   which reads as a flicker rather than as an arrival. The droplet is there, at
   *   full opacity, from frame one — it is just small and high up and moving fast. */
  out.alpha = 1;
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

/**
 * THE MARK LIQUEFIES — idle becoming any working state.
 *
 *   fall in      0.00 – 0.40   the ring closes on IN_2, ACCELERATING inward. Surface
 *                              tension climbs to K_NECK across the same window, so the
 *                              petals merge into one mass as they arrive rather than
 *                              sliding through one another
 *   keep turning 0.00 – 0.52   the spin does not stop the instant the collapse starts;
 *                              it carries a fraction of a turn further and settles. A
 *                              rotation that halts on the first frame reads as a cut
 *   consolidate  0.06 – 0.54   the central body grows as the petals feed it, and gives
 *                              one squash as the last of them lands
 *   become       0.46 – 1.00   only now does the mass do what the target asks — tear in
 *                              two, or reach out. Six bodies have to be one before
 *                              anything else can happen, which is why this is long
 */
function gatherPose(from: Pose, to: Pose, p: number): Pose {
  const out = blend(from, to, p, {
    /* The orb draws its own exit: it falls in on IN_2 and softens as it goes, so by
     * the time it hands over it is a small blurred droplet and nothing else. */
    orbScale: [0.0, 0.34, IN_2],
    orbBlur: [0.0, 0.34, IN_2],
    /* ★ THE CANVAS IS REVEALED INSTANTLY UNDER THE ORB and only the orb fades. Two
     *   layers cross-fading at 50% cover 75% of the pixel, so a symmetric dissolve
     *   DIPS — the mark would go momentarily translucent every time it started work.
     *   Reveal below, fade above. */
    alpha: [0.26, 0.30, OUT_STRONG],
    orbAlpha: [0.30, 0.40, OUT_STRONG],
    soft: [0.36, 0.62, OUT_STRONG],
    r0: [0.30, 0.62, OUT_STRONG],
    r1: [0.30, 0.62, OUT_STRONG],
    penR: [0.52, 0.92, OUT_STRONG],
    penLen: [0.52, 0.92, OUT_STRONG],
    penX: [0.46, 0.90, OUT_STRONG],
    penY: [0.46, 0.90, OUT_STRONG],
    inkW: [0.72, 1.0, OUT_STRONG],
    half: [0.46, 0.88, IN_2],
    lift0: [0.52, 0.92, OUT_2],
    lift1: [0.56, 1.0, OUT_2],
    cx: [0.30, 0.86, OUT_STRONG],
    sx0: [0.44, 1.0, ELASTIC],
    sy0: [0.44, 1.0, ELASTIC],
    sx1: [0.48, 1.0, ELASTIC],
    sy1: [0.48, 1.0, ELASTIC],
    br: [0.72, 1.0, OUT_STRONG],
  }, [0.15, 0.8, OUT_STRONG]);

  /* The droplet landing squashes what it lands on. */
  const land = window_(p, 0.34, 0.50, IN_2) * (1 - window_(p, 0.50, 1.0, ELASTIC));
  out.sx0 *= mix(1, 1.14, land);
  out.sy0 *= mix(1, 0.88, land);
  out.sx1 *= mix(1, 1.14, land);
  out.sy1 *= mix(1, 0.88, land);

  out.k = mix(0, K_NECK, window_(p, 0.30, 0.46, OUT_STRONG));
  out.k = mix(out.k, to.k, window_(p, 0.52, 0.84, IN_2));
  return out;
}

/**
 * THE MARK REFORMS — any working state becoming idle.
 *
 *   settle   0.00 – 0.30   whatever the working shape was becomes one round body: two
 *                          dots fall together, a reach comes home
 *   gather   0.16 – 0.34   it compresses. Exits are authored, and a bloom with no
 *                          wind-up reads as the petals being switched on
 *   bloom    0.28 – 1.00   petals grow out of the mass and the ring opens on the POP
 *                          spring — the loudest curve in the family, for the one beat
 *                          here that is a surface leaving its origin entirely
 *   spin up  0.34 – 1.00   the turn starts before the ring has finished opening, so the
 *                          mark is already alive by the time it is itself again
 */
function bloomPose(from: Pose, to: Pose, p: number): Pose {
  const out = blend(from, to, p, {
    half: [0.0, 0.30, IN_2],
    lift0: [0.0, 0.24, IN_2],
    lift1: [0.0, 0.24, IN_2],
    br: [0.0, 0.26, IN_1],
    bx: [0.0, 0.26, IN_1],
    by: [0.0, 0.26, IN_1],
    cx: [0.0, 0.44, OUT_STRONG],
    /* ★ THE PETALS HAVE TO BE SEEN LEAVING THE MASS. Two failures, opposite ways
     *   round, both visible only on the contact sheet:
     *
     *   · shrinking the body on the same window the petals grow left a frame where
     *     neither was there — a two-pixel speck, mid-gesture;
     *   · then growing them entirely INSIDE a body that had not yet receded hid them
     *     until the ring passed its rim, so the bloom read as a blob, a blob, a blob,
     *     and then suddenly a ring.
     *
     *   The mass recedes while the ring opens through it, so at every frame there is
     *   either a body with petals emerging or a ring — and never a blank. */
    r0: [0.24, 0.62, OUT_STRONG],
    r1: [0.24, 0.62, OUT_STRONG],
    penR: [0.0, 0.34, IN_1],
    penLen: [0.0, 0.34, IN_1],
    penX: [0.0, 0.34, IN_1],
    penY: [0.0, 0.34, IN_1],
    inkW: [0.0, 0.24, IN_1],
    soft: [0.30, 0.58, OUT_STRONG],
    /* The mirror of the gather: the orb comes back over the droplet on the POP spring
     * — the loudest curve in the family, for the one beat that is a surface arriving
     * from nowhere — and the canvas underneath goes only after it is covered. */
    orbAlpha: [0.56, 0.64, OUT_STRONG],
    orbScale: [0.56, 1.0, POP],
    orbBlur: [0.56, 0.88, OUT_STRONG],
    alpha: [0.66, 0.74, OUT_STRONG],
    sx0: [0.34, 1.0, ELASTIC],
    sy0: [0.34, 1.0, ELASTIC],
    sx1: [0.34, 1.0, ELASTIC],
    sy1: [0.34, 1.0, ELASTIC],
  }, [0.2, 0.8, OUT_STRONG]);

  const wind = window_(p, 0.16, 0.34, OUT_STRONG) * (1 - window_(p, 0.34, 0.66, IN_1));
  out.sx0 *= mix(1, 0.86, wind);
  out.sy0 *= mix(1, 1.12, wind);
  out.sx1 *= mix(1, 0.86, wind);
  out.sy1 *= mix(1, 1.12, wind);

  out.k = mix(from.k, K_NECK, window_(p, 0.06, 0.32, OUT_STRONG));
  out.k = mix(out.k, to.k, window_(p, 0.46, 0.9, IN_2));
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
  if (motion.kind === "gather") return gatherPose(motion.fromPose, to, p);
  if (motion.kind === "bloom") return bloomPose(motion.fromPose, to, p);
  if (motion.kind === "split") return splitPose(motion.fromPose, to, p);
  if (motion.kind === "merge") return mergePose(motion.fromPose, to, p);
  return reformPose(motion.fromPose, to, p);
}

/** The one pose a reduced-motion viewer sees: the state's shape, at rest, no beat.
 *  Two dots still mean thinking and one body still means writing, so the indicator
 *  keeps SAYING something — it just stops performing. */
export function staticPose(state: LiquidStateName): Pose {
  if (state === "idle") return idlePose();
  if (state === "thinking") return { ...onePose(R_DOT), half: HALF, k: K_APART };
  /* ★ A STILL FRAME STILL HAS TO SAY WHICH STATE IT IS. Writing's rest pose is the pen
   *   MID-STROKE with its line already part-drawn — a pen at the start of its travel
   *   with no ink is just a diagonal shape, and a reduced-motion viewer would have no
   *   way to tell it from anything else. Reading rests at one end of its sweep, where
   *   the lozenge is at its flattest. */
  if (state === "writing") return writingPose(P_WRITE * 0.45);
  return readingPose(0);
}

export const GEOMETRY = {
  GROUND, R_DOT, R_ONE, HALF, JUMP, READ_SPAN, K_APART, K_NECK, K_ONE, K_SWELL,
  PEN_LEN, PEN_R, PEN_TIP, PEN_ROT, PEN_TRAVEL, INK_H, INK_Y, K_INK,
  ORB_SMALL, ORB_BLUR, HANDOFF_R,
  P_THINK, P_WRITE, P_READ, P_IDLE,
};

/** The period of a state's loop — one place knows, so a harness sampling a full cycle
 *  cannot drift from the animation it is sampling. */
export function periodOf(state: LiquidStateName): number {
  if (state === "thinking") return P_THINK;
  if (state === "writing") return P_WRITE;
  if (state === "reading") return P_READ;
  return P_IDLE;
}
