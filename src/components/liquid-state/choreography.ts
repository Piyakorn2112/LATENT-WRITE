/* choreography — what the mass is doing, as a pure function of a clock.
 *
 * Nothing here touches the DOM, a canvas, or React. `poseAt()` takes a state, a
 * transition and a time in milliseconds and returns a Pose; `fieldOf()` turns a Pose
 * into the bodies `field.ts` paints.
 *
 *   ★★ THE PAINTER AND ANY MEASUREMENT OF IT MUST COME FROM ONE FUNCTION. A harness
 *      that re-derives "where the dots are" from its own copy of the maths will agree
 *      with the picture right up until it doesn't, and then it will report a green
 *      number about a frame nobody is looking at.
 *
 * ── THE STATES ─────────────────────────────────────────────────────────────────────
 *
 *   idle      the app's own blue orb, on its own layer. The canvas has nothing.
 *   thinking  three dots as a travelling wave
 *   writing   a pen — nib, collar, tapered barrel — drawing a line
 *
 * ★★ THERE IS NO `reading` SHAPE, AND THAT IS A DECISION RATHER THAN AN OMISSION. It
 *    had one — three lines of a paragraph — and it was the best-drawn of the three. But
 *    gathering evidence is the phase where the app has not started thinking yet, and
 *    the honest thing to show while nothing is happening is the mark itself. Spending a
 *    distinct shape on it also spent the size budget every other shape shares, and made
 *    the indicator say three things where the writer only needs to know two: it is
 *    working, and then what it is doing.
 *
 * ── THE TRANSITIONS, REBUILT ───────────────────────────────────────────────────────
 *
 * ★★ THREE BODIES, AND EVERY STATE IS THOSE SAME THREE. They are dots while thinking,
 *    lines while reading, and while writing one of them is the ink and the other two
 *    are parked at the nib. So a transition is not a set of shapes being swapped: it
 *    is three bodies each travelling from where they were to where they are going.
 *    Reading becoming thinking is literally three lines shortening into three dots.
 *
 * ★★ AND EACH BODY MOVES THE WAY THE KIT'S TRAVELLING MARKER MOVES, which is what the
 *    previous version got wrong. It had a dozen parameters each on its own window with
 *    its own ease, which is not choreography, it is a spreadsheet — every window
 *    boundary is a change of velocity, and a dozen of them landing at different times
 *    is exactly what "far from smooth" feels like. `@stephantechlab/ui`'s
 *    `flowIndicator` is three tweens and no more:
 *
 *      geometry   0 → 300ms    power3.inOut, straight to the target, NO overshoot.
 *                              A marker that lands past where you clicked and comes
 *                              back reads as the control disagreeing with you.
 *      deform     0 → 110ms    power2.out: squash long and low, and LEAN into the
 *                              direction of travel with a skew
 *      ring     120 → 620ms    elastic.out(1, 0.32) back to rest
 *
 *    Position and shape are two different animations, the shape outlasts the position
 *    by more than double, and the lean is a SKEW. The kit's own notes say every earlier
 *    attempt read as dead or bouncy because its engine "had neither skewX nor an
 *    elastic" and the two were being fought over one curve. This engine had the elastic
 *    and no skew, which is half of the same mistake, and it showed.
 *
 * ★ HOW HARD A BODY DEFORMS FOLLOWS HOW FAR IT TRAVELS. A body that stays put must not
 *   squash; one crossing the whole box should. One rule, no per-transition tuning.
 *
 * ★ AND THE HANDSHAKE IS FREE NOW. The deform envelope is `out(p) · (1 − back(p))`,
 *   which is zero at p=1 by construction, and the geometry ease reaches 1 — so every
 *   transition lands exactly on its target loop's clock-zero pose without anything
 *   being lined up by hand. The gate still checks it, because "by construction" is a
 *   claim about code somebody will edit.
 */

import {
  ELASTIC, IN_1, IN_2, IN_OUT_3, OUT_2, OUT_STRONG, POP,
  mix, window_, type Ease,
} from "./curves";
import type { Field } from "./field";

export type LiquidStateName = "idle" | "thinking" | "writing";

/* ── geometry, in a unit box where 1 = the component's size ─────────────────────── */

/** The floor the dots rest on. A squash pins the CONTACT POINT, not the centre, which
 *  is the whole difference between a landing and a shrink. */
const GROUND = 0.72;

/* ★★ THE THREE WORKING MARKS ARE SIZED AGAINST THE ORB, not against the box. The orb
 *    fills its slot almost entirely — its own layout reaches 0.93 of the canvas — and
 *    beside it the working shapes read as lighter and smaller, which makes the
 *    hand-over look like a shrink rather than a change of state. Everything below grew
 *    by roughly a tenth.
 *
 *    ★ AND THE CEILING IS NOT THE CANVAS, IT IS THE NECK. While a transition's tension
 *      is up, `smin(a, a, k)` inflates the whole mass by k in every direction, so the
 *      real budget is (shape + squash + k) < half the box. Growing the shapes meant
 *      spending some of that back: K_NECK came down with them, and the containment gate
 *      is what decides whether the sums are right. */
/** Rest radius of one thinking dot, and the spacing between adjacent dots. */
const R_DOT = 0.118;
const DOT_GAP = 0.302;
/** The radius at which a body counts as fully present, for the blend. Small — it only
 *  has to be past "a speck". */
const PRESENCE_R = 0.05;
/** How high a dot jumps, and how much it stretches at full speed. */
const JUMP = 0.235;
/** How far apart in the cycle adjacent dots are. See thinkingPose. */
const DOT_WAVE = 0.17;
const STRETCH = 0.17;
/** How flat a dot goes on impact. */
/** ★ A GENTLER SPLAT NOW THE DOTS ARE BIGGER. The squash is authored as a fraction, so
 *  the same 0.84 that flattened a small dot by half a pixel flattens a large one into
 *  its neighbour: the corridor between adjacent dots is what a splat spends, and there
 *  is less of it to spend once the dots have grown into it. */
const SPLAT = 0.92;

/** The pen. A barrel of constant width, a shoulder where it steps in, and a short cone
 *  to the nib — a nib is a POINT, and no union of ellipses makes one. */
/* ★ THE PEN IS BIGGER THAN THE OTHER TWO ON PURPOSE. It is one thin diagonal stroke,
 *  so it carries far less ink than three fat dots across the same box and reads
 *  smaller at a glance even when its bounding box says otherwise. Visual weight is what
 *  balances, not extent. */
const PEN_LEN = 0.55;
const PEN_R = 0.09;
const PEN_TIP = 0.006;
const PEN_HEAD = 0.34;
const PEN_NECK = 0.6;
/** ★ A PEN HAS MORE THAN TWO PARTS. Barrel and head alone is a shape that tapers once;
 *  what makes a pen legible in silhouette is the FERRULE — the collar where the head
 *  meets the barrel, wider than either — and a barrel that narrows toward its end
 *  rather than running parallel. The metaball joins the three into one body with a
 *  waist at the collar, which is the detail that reads. */
const PEN_FERRULE = 1.16;
const PEN_FERRULE_LEN = 0.1;
const PEN_BUTT = 0.78;
/** ★ HELD AT 120°, NOT 135°, AND THE REASON IS SIZE RATHER THAN STYLE. A pen is one
 *  long diagonal, so at 45° it spends as much of the box on horizontal reach as on
 *  length — and horizontal reach is the axis that runs out first, because the nib also
 *  travels along the line. Standing it up buys a third more pen for the same box, and
 *  a steeper grip is the more natural one anyway. */
const PEN_ROT = 2.09;
const PEN_TRAVEL = 0.07;
/** ★ AND IT SITS LEFT OF CENTRE. The pen runs up and to the RIGHT from its nib, so
 *  centring the nib puts the whole barrel in the right half and the composition off the
 *  edge. Centring the SHAPE means starting the nib left of the middle. */
const PEN_CX = 0.4;
/** The line the pen leaves. */
const INK_R = 0.052;
const INK_Y = GROUND - INK_R;

/** What the orb shrinks to before the canvas takes over, and how soft both go. */
const ORB_SMALL = 0.46;
const ORB_BLUR = 2.7;
/** The blob the canvas picks up — sized to read as the shrunken, blurred orb. */
const HANDOFF_R = 0.108;

/** Surface tension at rest: none. A blend band is 3.4×k wide, which at any useful k is
 *  wider than the gap between two dots — tension exists for the moment a mass is
 *  tearing or coalescing, where there is a gap worth bridging. */
const K_REST = 0;
const K_NECK = 0.07;
/** Inside one mass: exactly zero. `smin(a, a, k)` is `a − k`, so two coincident bodies
 *  blended at k are one body INFLATED by k. */
const K_ONE = 0;
/** The pen's two halves, and the pen against its own line. Small: the step at the
 *  shoulder is what makes the silhouette read as a pen. */
const K_PEN = 0.005;

/** How far a body has to travel to earn a full deformation. */
const DEFORM_REF = 0.34;

/* ── the pose ───────────────────────────────────────────────────────────────────── */

/** Three bodies, then the pen, then the orb's layer. A body's `x`/`y` is the centre of
 *  its axis, so a capsule of zero length is a dot at the same place — which is what
 *  lets a line and a dot tween into one another with no special case. */
export interface Pose {
  ax: number; ay: number; ar: number; al: number; asx: number; asy: number; ask: number;
  bx: number; by: number; br: number; bl: number; bsx: number; bsy: number; bsk: number;
  cx: number; cy: number; cr: number; cl: number; csx: number; csy: number; csk: number;
  /** the pen: nib position, angle, barrel radius, length. `pr` = 0 means no pen. */
  px: number; py: number; prot: number; pr: number; plen: number;
  /** the orb's own layer, driven from the same clock as the canvas so the hand-over
   *  never has two timelines to keep in step */
  os: number; ob: number; oa: number;
  /** surface tension */
  k: number;
  /** how far past one device pixel the edge ramp runs. Non-zero only across the
   *  hand-over, where it is what makes the two pictures the same picture. */
  soft: number;
  /** whole-canvas opacity */
  alpha: number;
}

const POSE_KEYS = [
  "ax", "ay", "ar", "al", "asx", "asy", "ask",
  "bx", "by", "br", "bl", "bsx", "bsy", "bsk",
  "cx", "cy", "cr", "cl", "csx", "csy", "csk",
  "px", "py", "prot", "pr", "plen",
  "os", "ob", "oa", "k", "soft", "alpha",
] as const;

export type PoseKey = (typeof POSE_KEYS)[number];
export const ALL_POSE_KEYS: readonly PoseKey[] = POSE_KEYS;

/** ★ THE CHANNELS THAT DESCRIBE WHERE THINGS ARE, and they must be smooth in VELOCITY
 *  rather than merely continuous — a body that stops dead is a jerk even though no
 *  pixel jumps, and that is most of what "not smooth" means. The shape channels are
 *  deliberately not on this list: a deform is an impulse, and the impulse is what makes
 *  a squash read as an impact rather than as a resize. */
export const POSITION_KEYS: readonly PoseKey[] = [
  "ax", "ay", "ar", "al", "bx", "by", "br", "bl", "cx", "cy", "cr", "cl",
  "px", "py", "pr", "plen",
];

const BODIES = ["a", "b", "c"] as const;
type BodyKey = (typeof BODIES)[number];

const num = (p: Pose, key: string): number => (p as unknown as Record<string, number>)[key];
const put = (p: Pose, key: string, v: number) => { (p as unknown as Record<string, number>)[key] = v; };

function emptyPose(): Pose {
  return {
    ax: 0.5, ay: 0.5, ar: 0, al: 0, asx: 1, asy: 1, ask: 0,
    bx: 0.5, by: 0.5, br: 0, bl: 0, bsx: 1, bsy: 1, bsk: 0,
    cx: 0.5, cy: 0.5, cr: 0, cl: 0, csx: 1, csy: 1, csk: 0,
    px: PEN_CX - PEN_TRAVEL, py: INK_Y - INK_R * 0.25, prot: PEN_ROT, pr: 0, plen: PEN_LEN,
    os: ORB_SMALL, ob: ORB_BLUR, oa: 0,
    k: K_ONE, soft: 0, alpha: 1,
  };
}

/**
 * Bodies, in the order `field.ts` folds them.
 *
 * ★★ THE THREE ARE ALWAYS BODIES 0, 1 AND 2, in that order and before anything else.
 *    Which index a body lands on stops being an implementation detail the moment a
 *    probe has to name one: the middle dot was once emitted last, so adding a second
 *    body to the pen silently moved it and the gate checking "the row reads as separate
 *    dots" started measuring the pen's barrel.
 *
 * ★★ AND NOTHING IS EVER CONDITIONALLY OMITTED. A body that should not be seen gets
 *    zero radius AND zero blend, which is inert under min(). Dropping it instead is a
 *    discrete branch in the middle of a continuous animation, and the picture steps.
 */
export function fieldOf(pose: Pose): Field {
  const penScale = Math.min(pose.pr / PEN_R, 1);
  const penPresence = smooth(penScale);
  const penLen = pose.plen * penScale;
  const headLen = penLen * PEN_HEAD;
  const dirX = Math.cos(pose.prot);
  const dirY = Math.sin(pose.prot);
  const bodies: Field["bodies"] = [];

  /* ★★ A BLEND NEEDS TWO PRESENT BODIES, and the fold is sequential, so each body's
   *    blend is scaled by its own presence AND by the most present thing folded before
   *    it. Both halves matter and each was learned separately:
   *
   *    · a body with almost no radius and a full band pulls the surface toward a point
   *      you cannot see, then loses it the instant its radius reaches zero;
   *    · and worse in the other direction — a FULL body folded onto a nearly-absent one
   *      treats that speck as an attractor and grows a blob out of nothing. Measured:
   *      24 square pixels of ink appearing beside a line whose own body had a radius of
   *      2.4 × 10⁻¹², while the largest pose parameter moved by 0.0003.
   *
   *    Presence is smoothstepped so it has no corner where it saturates. */
  let seen = 0;
  for (const key of BODIES) {
    const sx = num(pose, key + "sx");
    /* ★ A SQUASH SCALES A RADIUS; IT SHOULD BARELY SCALE A LENGTH. The deform is
     *   authored as a fraction — the kit's 22% — and 22% of a dot's radius is a pixel
     *   while 22% of a line spanning most of the box is a sixth of the box, which took
     *   the longest line clean off the canvas. The length takes a third of the share,
     *   so a stretch still reads on a line and stays inside it. */
    const len = num(pose, key + "l") * (1 + (sx - 1) * 0.35);
    const presence = smooth(Math.min(num(pose, key + "r") / PRESENCE_R, 1));
    bodies.push({
      /* A cone runs from its near end along +x, so a body stored by its CENTRE starts
       * half a (scaled) length back. At len = 0 that is the centre — which is why a dot
       * and a line are the same parameterisation and tween into one another with no
       * special case anywhere. */
      x: num(pose, key + "x") - len / 2,
      y: num(pose, key + "y"),
      r: num(pose, key + "r"),
      /* The body's own space is already scaled by sx, so the length passed in is
       * pre-divided — the scale must not apply to it twice. */
      len: len / sx,
      sx,
      sy: num(pose, key + "sy"),
      skew: num(pose, key + "sk"),
      /* ★★ A BODY'S BLEND VANISHES WITH ITS RADIUS, and this is the invariant, not a
       *    refinement. A body with almost no radius and a full blend band still pulls
       *    the surface toward itself across 3.4×k — it INFLATES the mass around a
       *    point you cannot see — and then the moment its radius reaches zero it is
       *    dropped and the inflation goes with it. Measured: the picture stepped by up
       *    to 78 square pixels in one frame while the largest pose parameter moved by
       *    0.003. Tying the two together is what makes "not there" actually mean
       *    nothing, and it has to be enforced HERE, where bodies are built, because no
       *    author can be expected to remember it at every site. */
      k: pose.k * presence * seen,
    });
    if (presence > seen) seen = presence;
  }

  bodies.push(
    /* THE PEN, IN TWO PARTS. The head is a short cone from the shoulder to the nib; the
     * barrel is a capsule of constant width running back from the same shoulder. They
     * meet at a step, and the step is the whole point — it is what makes the silhouette
     * read as a pen rather than as a sharpened stick.
     *
     * ★ The pen's length is tied to its radius, and both the body's `len` and the
     *   shoulder offset use the SAME derived value, so a pen that shrinks retracts into
     *   its own nib instead of switching off between two frames. */
    {
      x: pose.px - dirX * headLen,
      y: pose.py - dirY * headLen,
      r: pose.pr * PEN_NECK,
      tip: PEN_TIP * penScale,
      len: headLen,
      rot: pose.prot,
      /* The same rule as the bodies: a blend needs two present things. */
      k: K_PEN * penPresence * seen,
    },
    {
      /* The collar: short, a shade wider than the barrel, sitting on the joint. It is
       * what turns a taper into a pen. */
      x: pose.px - dirX * headLen,
      y: pose.py - dirY * headLen,
      r: pose.pr * PEN_FERRULE,
      len: penLen * PEN_FERRULE_LEN,
      rot: pose.prot + Math.PI,
      k: K_PEN * 0.5 * penPresence,
    },
    {
      /* The barrel, narrowing toward the butt. Folds onto the collar, which shares its
       * presence. */
      x: pose.px - dirX * headLen,
      y: pose.py - dirY * headLen,
      r: pose.pr,
      tip: pose.pr * PEN_BUTT,
      len: penLen - headLen,
      rot: pose.prot + Math.PI,
      k: K_PEN * 0.5 * penPresence,
    },
  );

  return { bodies, soft: pose.soft };
}

/* ── deterministic jitter ───────────────────────────────────────────────────────────
 * ★ A loop that repeats to the millisecond stops reading as something alive and starts
 *   reading as a CSS animation. Each cycle gets a small, DETERMINISTIC variation —
 *   deterministic so a probe sampling the same clock gets the same frame, and applied
 *   only to amplitudes that are zero at the cycle boundary, so the loop's clock-zero
 *   pose (the handshake every transition lands on) is untouched. */
function jitter(cycle: number, salt: number): number {
  const x = Math.sin(cycle * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** Smootherstep: zero slope at BOTH ends, so a beat that starts and ends at rest has no
 *  kink at either boundary. The workhorse of everything that must not jerk. */
function smooth(t: number): number {
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return u * u * u * (u * (u * 6 - 15) + 10);
}

/* ── the loops ──────────────────────────────────────────────────────────────────── */

const P_THINK = 820;
const P_WRITE = 1150;
/** Idle has no loop of its own — the orb animates itself. The number is only what a
 *  harness sweeps when it wants "a cycle of idle". */
const P_IDLE = 1000;

/** One dot's own beat. φ = 0 is REST ON THE FLOOR, which is what every transition into
 *  `thinking` hands over to.
 *
 *      rest      0.00 – 0.12   nothing; the beat needs a floor or it reads as a jitter
 *      crouch    0.12 – 0.26   gathering, on a curve that does NOT ring
 *      push-off  0.26 – 0.32   accelerating out of the crouch — a launch reads as
 *                              effort because it is
 *      flight    0.26 – 0.68   lift on a parabola; the stretch is DERIVED from the
 *                              arc's own velocity, so the dot is longest where it is
 *                              fastest and perfectly round at the apex
 *      impact    0.68 – 0.755  61ms. An impact you can watch is not an impact
 *      ring      0.755 – 1.00  back to round on the elastic
 */
function dotBeat(phase: number, jumpScale: number): { lift: number; sx: number; sy: number } {
  const f = phase - Math.floor(phase);
  const AIR_A = 0.26;
  const AIR_B = 0.68;
  const u = (f - AIR_A) / (AIR_B - AIR_A);
  const airborne = f >= AIR_A && f < AIR_B;
  const lift = airborne ? JUMP * jumpScale * 4 * u * (1 - u) : 0;

  const flightSy = (uu: number) => 1 + STRETCH * Math.abs(1 - 2 * uu);

  let sy: number;
  if (f < 0.12) sy = 1;
  else if (f < 0.26) sy = mix(1, 0.93, window_(f, 0.12, 0.26, OUT_STRONG));
  else if (f < 0.32) sy = mix(0.93, flightSy(u), window_(f, 0.26, 0.32, IN_2));
  else if (f < AIR_B) sy = flightSy(u);
  else if (f < 0.755) sy = mix(flightSy(1), SPLAT, window_(f, AIR_B, 0.755, IN_2));
  else sy = mix(SPLAT, 1, window_(f, 0.755, 1, ELASTIC));

  /* Area conservation: a droplet that squashes gets wider by exactly as much as it gets
   * shorter. One authored number instead of two that can drift apart. */
  return { lift, sx: 1 / sy, sy };
}

function thinkingPose(clock: number): Pose {
  const t = clock / P_THINK;
  /* ★ THREE DOTS, A THIRD OF A CYCLE APART. Two alternating reads as a see-saw; three
   *   in sequence reads as a run, which is what a row of thinking dots is for. Left,
   *   middle, right, so the wave travels rather than bounces. */
  const pose = emptyPose();
  BODIES.forEach((key, i) => {
    /* ★ A WAVE, NOT A RELAY. At a third of a cycle apart each dot lands as the next one
     *   launches, which reads as three separate hops taking turns. Closer together they
     *   overlap in the air and the row moves as ONE thing with a crest travelling along
     *   it — which is what makes three dots a single gesture rather than three
     *   animations sharing a row. */
    const off = i * DOT_WAVE;
    const beat = dotBeat(t + off, 0.94 + 0.12 * jitter(Math.floor(t + off), i + 1));
    put(pose, key + "r", R_DOT);
    put(pose, key + "l", 0);
    put(pose, key + "x", 0.5 + (i - 1) * DOT_GAP);
    put(pose, key + "y", GROUND - R_DOT * beat.sy - beat.lift);
    put(pose, key + "sx", beat.sx);
    put(pose, key + "sy", beat.sy);
  });
  pose.k = K_REST;
  return pose;
}

/**
 * READING — a paragraph, drawn line by line, over and over.
 *
 * ★★ REDESIGNED TWICE, AND THIS IS WHY. It was a lozenge sliding left and right, which
 *    at 18px is a blob moving two pixels and shares a silhouette with everything else
 *    round. Then it was one bar scanning one line, which is better but is still one
 *    blob in motion. What reading looks like is a PARAGRAPH: several lines, ragged on
 *    the right, taken in one after another. Three lines is the fewest that reads as a
 *    block of text rather than as a list, and it costs nothing — they are the same
 *    three bodies that are the dots.
 *
 *    Each line's length follows a wave running down the page, so at any moment one is
 *    being drawn, one is holding and one is clearing. There is no reset frame: the
 *    cascade is continuous, which is what stops it reading as a repeating cartoon.
 *
 *  ★ A line grows from its LEFT end, because that is where reading starts, and its
 *    thickness comes up three times faster than its length, so it is a line from the
 *    first frame rather than a dot that stretches.
 */
/**
 * WRITING — a pen, drawing.
 *
 *   stroke   0.00 – 0.70   the nib travels left to right along the line, bobbing twice
 *                          the way a hand does, and the ink grows behind it
 *   lift     0.70 – 0.86   the nib comes off the paper and the pen tips back
 *   return   0.86 – 1.00   back to the left, above the line, faster than it wrote
 *
 * The pen is held at a constant angle with a small wobble; a nib whose angle chases its
 * own travel reads as a compass needle, not a hand.
 */
function writingPose(clock: number): Pose {
  const f = clock / P_WRITE;
  const g = f - Math.floor(f);
  const amp = 0.92 + 0.16 * jitter(Math.floor(f), 3);

  const END = 0.7;
  const LIFT = 0.86;

  let nib: number;
  let lift = 0;
  if (g < END) {
    nib = mix(-PEN_TRAVEL, PEN_TRAVEL * amp, IN_OUT_3(g / END));
  } else if (g < LIFT) {
    nib = PEN_TRAVEL * amp;
    lift = window_(g, END, LIFT, OUT_2);
  } else {
    /* The window starts where the branch does. One that opens earlier means the first
     * frame of the return is already a third of the way along its own curve. */
    nib = mix(PEN_TRAVEL * amp, -PEN_TRAVEL, window_(g, LIFT, 1, IN_OUT_3));
    lift = 1 - window_(g, 0.9, 1, IN_1);
  }

  /* Two humps across the stroke, the size of a letter's ascender. */
  const bob = g < END ? Math.sin(2 * Math.PI * 2 * (g / END)) * 0.014 : 0;

  const pose = emptyPose();
  pose.pr = PEN_R;
  pose.plen = PEN_LEN;
  pose.px = PEN_CX + nib;
  pose.py = INK_Y - INK_R * 0.25 - bob - lift * 0.05;
  pose.prot = PEN_ROT + Math.sin(2 * Math.PI * (g * 2 + 0.2)) * 0.045;

  /* The line runs from where the stroke started to wherever the nib got to, and thins
   * away once the pen has left it. Its LENGTH is held after the stroke ends and only
   * its thickness goes — a line does not un-draw itself from both ends. And it is
   * touched down rather than switched on: without the ramp the first frame of every
   * cycle is a full-thickness dot. */
  const drawnTo = g < END ? nib : PEN_TRAVEL * amp;
  const half = (drawnTo + PEN_TRAVEL) / 2;
  const touch = Math.min(g / 0.05, 1);
  const fade = touch * (g < END ? 1 : 1 - window_(g, END, 0.98, IN_1));
  pose.ax = PEN_CX - PEN_TRAVEL + half;
  pose.ay = INK_Y;
  pose.al = Math.max(half * 2, 0);
  pose.ar = INK_R * Math.max(fade, 0);
  /* ★ THE OTHER TWO PARK AT THE NIB. They are what a mass shrinks INTO on the way in
   *   and grows OUT of on the way out, and where they converge decides whether the pen
   *   grows out of that mass or beside it. Parked at the centre, the merge showed a
   *   round blob with a stub of pen sprouting off to one side. */
  for (const key of ["b", "c"] as const) {
    put(pose, key + "x", pose.px);
    put(pose, key + "y", pose.py);
  }
  pose.k = K_ONE;
  return pose;
}

/** IDLE — the orb has the picture and the canvas has nothing. The blob the canvas parks
 *  at is the shape it will pick the hand-over up from, so it is defined here even though
 *  it is invisible: a transition blends from a pose, not from nothing. */
function idlePose(): Pose {
  const pose = emptyPose();
  for (const key of BODIES) {
    put(pose, key + "x", 0.5);
    put(pose, key + "y", GROUND - HANDOFF_R);
    put(pose, key + "r", key === "a" ? HANDOFF_R : 0);
  }
  pose.os = 1;
  pose.ob = 0;
  pose.oa = 1;
  pose.soft = ORB_BLUR;
  pose.alpha = 0;
  pose.k = K_ONE;
  return pose;
}

export function loopPose(state: LiquidStateName, clock: number): Pose {
  if (state === "idle") return idlePose();
  if (state === "thinking") return thinkingPose(clock);
  return writingPose(clock);
}

/** The period of a state's loop — one place knows, so a harness sampling a full cycle
 *  cannot drift from the animation it is sampling. */
export function periodOf(state: LiquidStateName): number {
  if (state === "thinking") return P_THINK;
  if (state === "writing") return P_WRITE;
  return P_IDLE;
}

/* ── transitions ────────────────────────────────────────────────────────────────── */

export type TransitionKind = "morph" | "handoff" | "enter" | "exit";

export const DURATION: Record<TransitionKind, number> = {
  /* The geometry lands at 300ms; the rest is the shape ringing home. Quoting the
   * duration as the shape's is deliberate — a transition is over when it stops moving,
   * not when it stops travelling. */
  morph: 560,
  /* Longer, because the orb has to shrink into a droplet before the canvas can take it,
   * and only then can the mass become anything. */
  handoff: 700,
  enter: 400,
  exit: 260,
};

export function kindFor(from: LiquidStateName | null, to: LiquidStateName | null): TransitionKind {
  if (from === null) return "enter";
  if (to === null) return "exit";
  if (from === "idle" || to === "idle") return "handoff";
  return "morph";
}

/** The geometry curve: straight there, no overshoot, at rest at both ends. */
const POS_EASE: Ease = IN_OUT_3;

/**
 * ★★ THE LAST THIRD OF EVERY TRANSITION IS THE TARGET LOOP, ALREADY RUNNING.
 *
 *    Landing exactly on `loopPose(to, 0)` is a clean handshake and it is still a JERK,
 *    because a transition arrives at rest and a loop's clock-zero pose is usually
 *    moving — two of `thinking`'s three dots are mid-flight at clock 0. Position was
 *    continuous and velocity was not, and that is most of what "far from smooth" is.
 *
 *    So the loop's clock starts running a third of the way from the end and the
 *    authored transition cross-fades into it on a smootherstep. At p = 1 the pose IS
 *    the loop at `TAIL × duration`, and because the blend's own slope is zero there,
 *    the VELOCITY is the loop's too. The component picks the loop up at that clock
 *    rather than at zero — which is the whole contract, and the gate checks it.
 */
const TAIL = 0.32;
export const tailClock = (kind: TransitionKind): number => DURATION[kind] * TAIL;

/** Remap into 0..1, snapping exactly to the ends. `(p − a) / (b − a)` at p = b lands on
 *  0.9999999999999998 in binary, and an elastic evaluated a hair short of 1 is 7×10⁻⁴
 *  away from home — small, and enough to fail an exact handshake. */
function remap(p: number, a: number, b: number): number {
  if (p >= b) return 1;
  if (p <= a) return 0;
  return (p - a) / (b - a);
}

function blendPose(a: Pose, b: Pose, t: number): Pose {
  const out = {} as Pose;
  for (const key of POSE_KEYS) put(out, key, mix(num(a, key), num(b, key), t));
  return out;
}
const GEO_AT = 0;
const GEO_TO = 0.54;

/** ★★ THE THREE BODIES DO NOT LEAVE TOGETHER. A stagger is the difference between a row
 *  of things moving and a row of things being moved, and the kit is specific about how
 *  to spend it: the value sets the TOTAL SPREAD across the group, not the gap between
 *  neighbours — otherwise a group of three and a group of six travel at different
 *  speeds for the same setting. The spread is fixed here and each body's window shifts
 *  by its share, so the last one still arrives inside the geometry window and the
 *  handshake is untouched. */
const STAGGER_SPREAD = 0.14;

/** ★ AND EACH ONE GATHERS BEFORE IT GOES. A body that simply starts moving has no
 *  weight; one that leans back first has mass. The wind-up is a smootherstep bump —
 *  zero at both ends and zero SLOPE at both ends — so it adds a beat without adding a
 *  kink. That is the whole trick: anticipation usually costs smoothness because it is
 *  authored as an extra keyframe, and a bump is not a keyframe. */
/* Trimmed from 0.055: a lean is a lean, and on the OUTERMOST body it leans away from
 * the centre — straight at the edge of the canvas, which is the one direction there is
 * no room in. */
const ANTICIPATE_BY = 0.03;

/**
 * The deform envelope — the shape half of the choreography, and all of it.
 *
 *   out    0 → 0.20   power2.out. An impulse, deliberately: a squash that eases IN
 *                     reads as a resize, and one that arrives reads as an impact
 *   back   0.22 → 1   the elastic, ringing home over more than twice the distance the
 *                     geometry took
 *
 * Zero at p = 1 by construction, which is what makes every transition land exactly on
 * its target pose without anything being lined up by hand.
 */
function deformAt(p: number): number {
  if (p <= 0) return 0;
  return window_(p, 0, 0.2, OUT_2) * (1 - window_(p, 0.22, 1, ELASTIC));
}

/** A smootherstep bump: 0 → 1 → 0 across [a, b], with zero slope at both ends and at
 *  the peak. The shape anticipation is drawn with, because it has to add a beat without
 *  adding a corner. */
function bump(p: number, a: number, b: number): number {
  if (p <= a || p >= b) return 0;
  const t = (p - a) / (b - a);
  return smooth(t < 0.5 ? t * 2 : (1 - t) * 2);
}

/**
 * One body, from where it was to where it is going.
 *
 * ★ HOW HARD IT DEFORMS FOLLOWS HOW FAR IT TRAVELS, so a body that stays put does not
 *   squash and one crossing the box does. And the lean is a SKEW into the direction of
 *   travel — the ingredient this engine was missing. Without it the only way to make a
 *   move look alive is to bounce it, and bouncing reads as a performance rather than as
 *   a material.
 */
function travelBody(out: Pose, from: Pose, to: Pose, key: BodyKey, p: number, index = 0) {
  const shift = (index / (BODIES.length - 1)) * STAGGER_SPREAD;
  const g = window_(p, GEO_AT + shift, GEO_TO + shift, POS_EASE);
  const x0 = num(from, key + "x");
  const y0 = num(from, key + "y");
  const x1 = num(to, key + "x");
  const y1 = num(to, key + "y");

  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  /* The wind-up: a lean back along the travel, biggest just before the body sets off
   * and gone by the time it is a third of the way there. */
  /* Scaled down for a long body, for the same reason the squash is: a lean is a small
   * absolute move, and a fraction of a line spanning half the box is not small. */
  const bulk = 1 / (1 + Math.max(num(from, key + "l"), num(to, key + "l")) * 3);
  const wind = dist > 1e-6
    ? (ANTICIPATE_BY * bulk * Math.min(dist / DEFORM_REF, 1) * bump(p, shift, shift + 0.34)) / dist
    : 0;
  put(out, key + "x", mix(x0, x1, g) - dx * wind);
  put(out, key + "y", mix(y0, y1, g) - dy * wind);
  put(out, key + "r", mix(num(from, key + "r"), num(to, key + "r"), g));
  put(out, key + "l", mix(num(from, key + "l"), num(to, key + "l"), g));

  const amount = Math.min(dist / DEFORM_REF, 1) * deformAt(p - shift * 0.5);
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const dir = Math.sign(horizontal ? dx : dy) || 1;

  const sx = mix(num(from, key + "sx"), num(to, key + "sx"), g);
  const sy = mix(num(from, key + "sy"), num(to, key + "sy"), g);
  if (horizontal) {
    put(out, key + "sx", sx * (1 + 0.22 * amount));
    put(out, key + "sy", sy * (1 - 0.2 * amount));
  } else {
    put(out, key + "sx", sx * (1 - 0.18 * amount));
    put(out, key + "sy", sy * (1 + 0.2 * amount));
  }
  /* −8° at full deformation, the kit's number, in radians, leaning INTO the travel. */
  const lean = 0.14 * amount * dir * (horizontal ? 1 : 0.6);
  put(out, key + "sk", mix(num(from, key + "sk"), num(to, key + "sk"), g) - lean);
}

/** Everything that is not one of the three bodies: the pen, the orb, the tension. */
function travelRest(
  out: Pose,
  from: Pose,
  to: Pose,
  p: number,
  spec: Partial<Record<PoseKey, [number, number, Ease]>>,
) {
  for (const key of POSE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, key)) continue;
    const [a, b, ease] = spec[key] ?? [GEO_AT, GEO_TO, POS_EASE];
    put(out, key, mix(num(from, key), num(to, key), window_(p, a, b, ease)));
  }
}

/** Between two working states: three bodies travelling, and a neck while they do. */
function morphPose(from: Pose, to: Pose, p: number): Pose {
  const out = {} as Pose;
  BODIES.forEach((key, i) => travelBody(out, from, to, key, p, i));
  travelRest(out, from, to, p, {
    /* The pen grows and shrinks a beat behind the bodies, so the mass has arrived at
     * the nib before the pen extends out of it. */
    pr: [0.3, 0.92, POS_EASE],
    plen: [0.3, 0.92, POS_EASE],
  });

  /* ★ THE NECK. Tension climbs while the bodies are moving and is gone once they have
   *   arrived, so a mass that tears has something to tear and one that merges has
   *   something to reach across. It is the only piece of drama left in a transition,
   *   and it is the one the metaball is for. */
  out.k = mix(from.k, K_NECK, window_(p, 0.02, 0.3, OUT_STRONG));
  out.k = mix(out.k, to.k, window_(p, 0.42, 0.86, IN_OUT_3));
  return out;
}

/**
 * To or from the resting mark.
 *
 * ★★ THE ORB SHRINKS AND BLURS INTO A DROPLET FIRST. Only once it is a small soft blob
 *    — a shape the metaball can match exactly — does the canvas take it. Two pictures
 *    that are the same soft blob at the same instant swap without a seam, and a couple
 *    of pixels of blur is what makes them the same. That is the one place blur is used
 *    here, and it is used because it is the only thing that works.
 *
 * ★★ THE CANVAS IS REVEALED UNDER THE ORB AND ONLY THE ORB FADES. Two layers
 *    cross-fading at 50% cover 1 − 0.25 = 75% of the pixel, so a symmetric dissolve
 *    makes the mark visibly translucent for a moment every single time work starts or
 *    stops. Reveal below, fade above.
 *
 * ★ AND THE BODIES WAIT FOR THE LAYER THEY ARE ON. Travelling while the orb still has
 *   the picture spends half the journey underneath it; the mass moves inside the window
 *   where the canvas is what you can see.
 */
function handoffPose(from: Pose, to: Pose, p: number): Pose {
  const leaving = from.oa > to.oa;
  const out = {} as Pose;
  const bodyP = leaving ? remap(p, 0.34, 1) : remap(p, 0, 0.72);
  BODIES.forEach((key, i) => travelBody(out, from, to, key, bodyP, i));

  travelRest(out, from, to, p, leaving
    ? {
      os: [0, 0.4, IN_OUT_3],
      ob: [0, 0.4, IN_OUT_3],
      alpha: [0.3, 0.36, OUT_STRONG],
      oa: [0.36, 0.46, OUT_STRONG],
      soft: [0.4, 0.68, IN_OUT_3],
      pr: [0.5, 0.96, POS_EASE],
      plen: [0.5, 0.96, POS_EASE],
    }
    : {
      /* Coming home the order reverses: the orb arrives over the droplet on the pop
       * spring — the loudest curve in the family, for the one beat that is a surface
       * arriving from nowhere — and the canvas underneath goes only once covered. */
      pr: [0, 0.36, POS_EASE],
      plen: [0, 0.36, POS_EASE],
      soft: [0.26, 0.54, IN_OUT_3],
      oa: [0.52, 0.6, OUT_STRONG],
      os: [0.52, 1, POP],
      ob: [0.52, 0.86, IN_OUT_3],
      alpha: [0.62, 0.7, OUT_STRONG],
    });

  out.k = mix(from.k, K_NECK, window_(p, 0.3, 0.52, OUT_STRONG));
  out.k = mix(out.k, to.k, window_(p, 0.6, 0.92, IN_OUT_3));
  return out;
}

/**
 * THE ARRIVAL — a droplet falls in from above and splats. It never fades in: a liquid
 * indicator that dissolves into existence has already told you it is a picture.
 */
function enterPose(to: Pose, p: number): Pose {
  const drop = window_(p, 0, 0.42, IN_1);
  const out: Pose = { ...to };
  const fall = drop * (1 - window_(p, 0.36, 0.42, IN_1));
  const splat = window_(p, 0.42, 0.5, IN_2) * (1 - window_(p, 0.5, 1, POP));
  const sy = mix(1, 1.46, fall) * mix(1, 0.71, splat);

  for (const key of BODIES) {
    /* Small and long on the way down: at full size and 1.46 stretch there is no
     * headroom above its own landing spot, and the first frames were clipped flat
     * against the top of the canvas. It grows as it lands. */
    /* On POS_EASE, not OUT_STRONG. These are POSITION channels, and OUT_STRONG's start
     * is close to vertical — a velocity that goes from nothing to enormous in one frame
     * is a jerk even though no pixel jumps, which is most of what "not smooth" means. */
    put(out, key + "r", num(to, key + "r") * mix(0.62, 1, window_(p, 0.2, 0.86, POS_EASE)));
    put(out, key + "x", mix(0.5, num(to, key + "x"), window_(p, 0.46, 1, POS_EASE)));
    /* ★ IT FALLS FROM WHATEVER HEADROOM THERE IS. A fixed 0.24 is fine above a dot
     *   resting near the floor and clips the moment the target is `reading`, whose top
     *   line sits at 0.29. The drop is bounded by the room above the body itself. */
    const room = Math.min(0.24, Math.max(num(to, key + "y") - num(to, key + "r") * 1.6, 0.02));
    put(out, key + "y", mix(num(to, key + "y") - room, num(to, key + "y"), drop));
    put(out, key + "sy", num(to, key + "sy") * sy);
    put(out, key + "sx", num(to, key + "sx") / sy);
  }
  out.pr = to.pr * window_(p, 0.6, 1, POS_EASE);
  out.k = mix(K_NECK, to.k, window_(p, 0.5, 0.92, IN_2));
  out.alpha = 1;
  out.oa = 0;
  return out;
}

/** The departure: everything shrinks away as one. Exits are authored, never reversed. */
function exitPose(from: Pose, p: number): Pose {
  const out: Pose = { ...from };
  const shrink = window_(p, 0, 1, IN_2);
  for (const key of BODIES) put(out, key + "r", num(from, key + "r") * (1 - shrink));
  out.pr = from.pr * (1 - shrink);
  out.os = from.os * (1 - shrink * 0.4);
  out.oa = from.oa * (1 - window_(p, 0.2, 1, IN_1));
  out.alpha = from.alpha * (1 - window_(p, 0.4, 1, IN_1));
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
  const to = loopPose(state, 0);
  if (motion.kind === "enter") return enterPose(to, p);
  if (motion.kind === "exit") return exitPose(motion.fromPose, p);
  const authored = motion.kind === "handoff"
    ? handoffPose(motion.fromPose, to, p)
    : morphPose(motion.fromPose, to, p);
  /* The target loop is already running for the last third — see TAIL. */
  const t = smooth(remap(p, 1 - TAIL, 1));
  if (t <= 0) return authored;
  return blendPose(authored, loopPose(state, (p - (1 - TAIL)) * DURATION[motion.kind]), t);
}

/** The one pose a reduced-motion viewer sees: the state's shape, at rest, no beat.
 *
 *  ★ A STILL FRAME STILL HAS TO SAY WHICH STATE IT IS. Writing rests MID-STROKE with
 *    its line part-drawn — a pen at the start of its travel with no ink is just a
 *    diagonal shape. Reading rests where all three lines are drawn. */
export function staticPose(state: LiquidStateName): Pose {
  if (state === "idle") return idlePose();
  if (state === "thinking") return thinkingPose(0);
  return writingPose(P_WRITE * 0.45);
}

export const GEOMETRY = {
  GROUND, R_DOT, DOT_GAP, JUMP,
  PEN_LEN, PEN_R, PEN_TIP, PEN_ROT, PEN_TRAVEL, PEN_HEAD, PEN_NECK, PEN_CX,
  INK_R, INK_Y, K_REST, K_NECK, K_ONE, K_PEN, DEFORM_REF,
  ORB_SMALL, ORB_BLUR, HANDOFF_R,
  P_THINK, P_WRITE, P_IDLE,
};
