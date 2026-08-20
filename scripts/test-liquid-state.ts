/* test-liquid-state — the contract the liquid indicator's motion has to keep.
 *
 * It samples the SAME functions the component paints (choreography.poseAt, field
 * .rasterise), so a green run here is a statement about the picture and not about a
 * parallel copy of the maths. Headless: no browser, no canvas, no DOM.
 *
 * What it is actually for. Almost everything in choreography.ts is a piecewise
 * function of a clock, authored beat by beat. That style is how you get a landing
 * that snaps and a ring that lags — and it is also how you get a one-frame jump at a
 * beat boundary that nobody sees on a 60Hz screen at 18 pixels, and a transition that
 * quietly stops landing on its target loop's first pose after someone retimes a
 * window by 0.02. Both of those are silent. So:
 *
 *   · the HANDSHAKE (a transition ends exactly where its loop begins) is checked for
 *     every reachable pair, from several points in the source loop
 *   · CONTINUITY is checked at 4ms across every loop, every transition, and across the
 *     handover into the loop
 *   · CONTAINMENT is checked on the rendered alpha, not on the poses: the border ring
 *     of pixels must be empty at every sampled frame in every state
 *   · the METABALL IS CHECKED TO ACTUALLY FIRE — a frame must exist during the merge
 *     where the two bodies are still geometrically APART and the point between them is
 *     nonetheless inside the mass. That is a neck, and it cannot happen by overlap
 *   · the two dots are checked to stay TWO for the whole thinking loop
 *   · position is checked NOT to overshoot and shape is checked TO ring, which are a
 *     pair: either alone is passable by a component that does nothing
 *
 * ★ Two of the gates carry a negative control that runs a deliberately broken input
 *   through the same assertion and requires it to fail. A gate that has never been
 *   seen to fail is not known to be a gate.
 */
import {
  DURATION, GEOMETRY, fieldOf, kindFor, loopPose, periodOf, poseAt, staticPose,
  type LiquidStateName, type Motion, type Pose, type TransitionKind,
} from "../src/components/liquid-state/choreography";
import { rasterise, sdField } from "../src/components/liquid-state/field";

const STATES: LiquidStateName[] = ["idle", "reading", "thinking", "writing"];

/** How long to sample a loop for. The three working loops get a full cycle and a
 *  little over; `idle` turns once every nine seconds, and sampling nine seconds at
 *  half-millisecond steps is 18,000 frames of six rotated bodies for no new
 *  information — the spin is linear, so anything it can hide it hides in the first
 *  second too. Capped, and SAID, rather than quietly shortened. */
const SAMPLE_MS = (s: LiquidStateName) => Math.min(periodOf(s) * 1.02, 2600);
const PX = 54; /* 18 CSS px at 3× — the densest the component ever runs */

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ok   ${name}${detail ? `  (${detail})` : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

const KEYS = [
  "cx", "half", "r0", "r1", "lift0", "lift1",
  "sx0", "sy0", "sx1", "sy1", "bx", "by", "br", "k", "alpha",
] as const;

const maxDelta = (a: Pose, b: Pose): { key: string; d: number } => {
  let worst = { key: "", d: 0 };
  for (const k of KEYS) {
    const d = Math.abs(a[k] - b[k]);
    if (d > worst.d) worst = { key: k, d };
  }
  return worst;
};

function motionFor(from: LiquidStateName, to: LiquidStateName, atClock: number): Motion {
  return {
    from, to, kind: kindFor(from, to),
    fromPose: loopPose(from, atClock),
    elapsed: 0,
  };
}

/* ── 1. the handshake ───────────────────────────────────────────────────────────── */
console.log("\nhandshake — every transition ends on its target loop's clock-zero pose");
for (const from of STATES) {
  for (const to of STATES) {
    if (from === to) continue;
    let worstKey = "";
    let worst = 0;
    /* From several points in the source loop, because the transition starts from the
     * pose that was on screen and must land regardless of which one that was. */
    for (const frac of [0, 0.17, 0.33, 0.5, 0.66, 0.83]) {
      const clock = frac * periodOf(from);
      const m = motionFor(from, to, clock);
      m.elapsed = DURATION[m.kind];
      const got = poseAt(to, 0, m);
      const want = loopPose(to, 0);
      const d = maxDelta(got, want);
      if (d.d > worst) { worst = d.d; worstKey = d.key; }
    }
    check(`${from} → ${to} (${kindFor(from, to)})`, worst < 1e-9, `max Δ ${worst.toExponential(2)} on ${worstKey || "-"}`);
  }
}
/* Negative control: a transition that stops one frame early must NOT land. */
{
  const m = motionFor("thinking", "writing", 0);
  m.elapsed = DURATION.merge - 16;
  const d = maxDelta(poseAt("writing", 0, m), loopPose("writing", 0));
  check("negative control — a merge cut 16ms short does not land", d.d > 1e-6, `Δ ${d.d.toFixed(5)} on ${d.key}`);
}

/* ── 2. continuity, measured on the picture ─────────────────────────────────────── */
console.log("\ncontinuity — halve the timestep and the frame-to-frame change must halve");
/*
 * ★ THE OBSERVABLE IS THE RENDERED ALPHA, NOT THE POSE. The first version of this gate
 *   compared pose parameters against hand-picked per-frame limits, and it was wrong in
 *   both directions at once:
 *
 *   · it FAILED on something that is not a bug. `bx` — where the travelling swell sits
 *     inside the writing body — snaps back to zero at the end of each cycle, at a
 *     moment when the swell's radius is zero and it is not drawn at all. A parameter of
 *     a body that does not exist may do whatever it likes. The picture is what has to
 *     be continuous.
 *   · it PASSED nothing in particular, because the limits were guesses. A 61ms impact
 *     legitimately moves `sx` by 0.11 between two frames, so the limit had to be loose
 *     enough to allow that — at which point it could no longer catch a step of 0.10.
 *
 * ★ SO THE TEST IS A SCALING TEST, AND IT NEEDS NO CONSTANT AT ALL. For any continuous
 *   piecewise-smooth motion the largest change between adjacent frames is bounded by
 *   h·max|f′|, so halving h halves it. Across a genuine STEP the change IS the step and
 *   does not shrink. Sampled at 4ms and at 0.5ms, continuous motion gives a ratio near
 *   8; a discontinuity gives a ratio near 1. Coverage is linear in sub-pixel offset, so
 *   the rendered alpha inherits the same scaling — an antialiased edge is not a step.
 */
const CPX = 32;
const inkA = new Uint8ClampedArray(CPX * CPX * 4);
const inkB = new Uint8ClampedArray(CPX * CPX * 4);
const BLACK: [number, number, number] = [0, 0, 0];

function inkOf(target: Uint8ClampedArray, pose: Pose) {
  /* ★ THE POSE'S OWN OPACITY IS PART OF THE PICTURE. Rasterising at a flat alpha of 1
   *   measures a canvas nobody is looking at — while the orb owns the mark the canvas
   *   is fully transparent, and a gate that ignores that is asserting continuity of an
   *   invisible layer. */
  rasterise(target, CPX, fieldOf(pose), BLACK, pose.alpha);
}
function alphaDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 3; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]);
  return sum / 255;
}
/** Largest ink change between adjacent frames, sampling `frame` over [t0, t1) at h. */
function worstStep(frame: (t: number) => Pose, t0: number, t1: number, h: number): { d: number; at: number } {
  let prev = inkA;
  let next = inkB;
  inkOf(prev, frame(t0));
  let worst = { d: 0, at: t0 };
  for (let t = t0 + h; t <= t1; t += h) {
    inkOf(next, frame(t));
    const d = alphaDiff(prev, next);
    if (d > worst.d) worst = { d, at: t - h };
    const swap = prev; prev = next; next = swap;
  }
  return worst;
}
function continuityRatio(name: string, frame: (t: number) => Pose, t0: number, t1: number) {
  const coarse = worstStep(frame, t0, t1, 4);
  const fine = worstStep(frame, t0, t1, 0.5);
  const ratio = fine.d < 1e-9 ? Infinity : coarse.d / fine.d;
  check(name, ratio >= 4,
    `ratio ${ratio.toFixed(2)} (ideal 8) — worst 4ms step ${coarse.d.toFixed(2)}px² at ${coarse.at.toFixed(0)}ms, 0.5ms step ${fine.d.toFixed(2)}px²`);
}

for (const s of STATES) {
  continuityRatio(`${s} loop`, (t) => loopPose(s, t), 0, SAMPLE_MS(s));
}
for (const from of STATES) {
  for (const to of STATES) {
    if (from === to) continue;
    const kind = kindFor(from, to);
    const m = motionFor(from, to, 0);
    /* Past DURATION the loop owns the picture — which is exactly the handover this has
     * to prove is seamless, so the window runs past the end of the transition. */
    const frame = (t: number) => (t < DURATION[kind]
      ? poseAt(to, 0, { ...m, elapsed: t })
      : loopPose(to, t - DURATION[kind]));
    continuityRatio(`${from} → ${to} and into the loop`, frame, 0, DURATION[kind] + 240);
  }
}
{
  const m: Motion = { from: null, to: "thinking", kind: "enter", fromPose: loopPose("thinking", 0), elapsed: 0 };
  const frame = (t: number) => (t < DURATION.enter
    ? poseAt("thinking", 0, { ...m, elapsed: t })
    : loopPose("thinking", t - DURATION.enter));
  continuityRatio("the entrance and into the loop", frame, 0, DURATION.enter + 240);
}
/* Negative control: a 0.04-unit step planted mid-cycle must collapse the ratio. If this
 * one ever passes, the gate above has stopped being able to fail. */
{
  const period = GEOMETRY.P_THINK;
  const broken = (t: number): Pose => {
    const pose = loopPose("thinking", t);
    return t > period / 2 ? { ...pose, cx: pose.cx + 0.04 } : pose;
  };
  const coarse = worstStep(broken, 0, period, 4).d;
  const fine = worstStep(broken, 0, period, 0.5).d;
  const ratio = fine < 1e-9 ? Infinity : coarse / fine;
  check("negative control — a planted 0.04 step is caught", ratio < 4, `ratio ${ratio.toFixed(2)}`);
}

/* ── 3. containment, measured on the rendered alpha ─────────────────────────────── */
console.log("\ncontainment — nothing touches the edge of the canvas, in any state");
const buf = new Uint8ClampedArray(PX * PX * 4);
function borderInk(pose: Pose): number {
  buf.fill(0);
  rasterise(buf, PX, fieldOf(pose), [0, 0, 0], 1);
  let worst = 0;
  for (let i = 0; i < PX; i++) {
    for (const o of [i * 4 + 3, ((PX - 1) * PX + i) * 4 + 3, (i * PX) * 4 + 3, (i * PX + PX - 1) * 4 + 3]) {
      if (buf[o] > worst) worst = buf[o];
    }
  }
  return worst;
}
for (const s of STATES) {
  /* Containment gets the WHOLE cycle including idle's nine-second turn — a rotating
   * body's widest reach depends on its angle, so a capped window here really could
   * miss something. Coarser steps, full coverage. */
  const period = periodOf(s);
  const step = period > 4000 ? 20 : 8;
  let worst = 0;
  let at = 0;
  for (let t = 0; t < period * 2; t += step) {
    const ink = borderInk(loopPose(s, t));
    if (ink > worst) { worst = ink; at = t; }
  }
  check(`${s} loop stays inside`, worst === 0, `max border alpha ${worst} at ${at}ms, sampled every ${step}ms over ${period * 2}ms`);
}
for (const from of STATES) {
  for (const to of STATES) {
    if (from === to) continue;
    const kind = kindFor(from, to);
    let worst = 0;
    let at = 0;
    for (const frac of [0, 0.25, 0.5, 0.75]) {
      const m = motionFor(from, to, frac * periodOf(from));
      for (let e = 0; e <= DURATION[kind]; e += 8) {
        const ink = borderInk(poseAt(to, 0, { ...m, elapsed: e }));
        if (ink > worst) { worst = ink; at = e; }
      }
    }
    check(`${from} → ${to} stays inside`, worst === 0, `max border alpha ${worst} at ${at}ms`);
  }
}
/* And the entrance, which throws a body in from above. */
{
  let worst = 0;
  for (const s of STATES) {
    const m: Motion = { from: null, to: s, kind: "enter" as TransitionKind, fromPose: loopPose(s, 0), elapsed: 0 };
    for (let e = 0; e <= DURATION.enter; e += 8) {
      const ink = borderInk(poseAt(s, 0, { ...m, elapsed: e }));
      if (ink > worst) worst = ink;
    }
  }
  check("the entrance stays inside", worst === 0, `max border alpha ${worst}`);
}

/* ── 4. the metaball actually fires ─────────────────────────────────────────────── */
console.log("\nthe neck — a bridge across a gap, which overlap cannot fake");
{
  /* A frame during the merge where the two bodies are geometrically SEPARATE (the gap
   * between their surfaces along the axis joining them is positive) and yet the point
   * midway between their centres is INSIDE the mass. Only the blend can do that. */
  const m = motionFor("thinking", "writing", 0);
  let best = { gap: 0, at: 0 };
  for (let e = 0; e <= DURATION.merge; e += 2) {
    const pose = poseAt("writing", 0, { ...m, elapsed: e });
    if (pose.half <= 1e-4) continue;
    /* The two dots ALONE. A pen or a line of ink lying across the gap would be a
     * bridge by overlap, and this gate exists to prove the BLEND makes one. */
    const f = { bodies: fieldOf(pose).bodies.slice(0, 2) };
    const [a, b] = f.bodies;
    const gap = Math.abs(b.x - a.x) - (a.rx + b.rx);
    if (gap <= 0) continue;
    const mid = sdField(f, (a.x + b.x) / 2, (a.y + b.y) / 2);
    if (mid < 0 && gap > best.gap) best = { gap, at: e };
  }
  check("merge bridges a real gap before contact", best.gap > 0.004,
    `widest bridged gap ${(best.gap * 18).toFixed(2)}px of 18 at ${best.at}ms`);
}
{
  /* The same for the split, from the other side: a frame where the halves have already
   * separated and the neck is still holding. */
  const m = motionFor("writing", "thinking", 0);
  let best = { gap: 0, at: 0 };
  for (let e = 0; e <= DURATION.split; e += 2) {
    const pose = poseAt("thinking", 0, { ...m, elapsed: e });
    if (pose.half <= 1e-4) continue;
    /* The two dots ALONE. A pen or a line of ink lying across the gap would be a
     * bridge by overlap, and this gate exists to prove the BLEND makes one. */
    const f = { bodies: fieldOf(pose).bodies.slice(0, 2) };
    const [a, b] = f.bodies;
    const gap = Math.abs(b.x - a.x) - (a.rx + b.rx);
    if (gap <= 0) continue;
    const mid = sdField(f, (a.x + b.x) / 2, (a.y + b.y) / 2);
    if (mid < 0 && gap > best.gap) best = { gap, at: e };
  }
  check("split holds a neck after the halves part", best.gap > 0.004,
    `widest held gap ${(best.gap * 18).toFixed(2)}px of 18 at ${best.at}ms`);
}
/* Negative control: with no surface tension anywhere there is no neck at any frame.
 * Every body's blend is zeroed, not just the pair's — the pen and the ink carry their
 * own now, and a control that leaves one of them on is testing the wrong thing. */
{
  const m = motionFor("thinking", "writing", 0);
  let bridged = false;
  for (let e = 0; e <= DURATION.merge; e += 2) {
    const pose = poseAt("writing", 0, { ...m, elapsed: e });
    if (pose.half <= 1e-4) continue;
    const f = { bodies: fieldOf(pose).bodies.slice(0, 2).map((b) => ({ ...b, k: 0 })) };
    const [a, b] = f.bodies;
    if (Math.abs(b.x - a.x) - (a.rx + b.rx) <= 0) continue;
    if (sdField(f, (a.x + b.x) / 2, (a.y + b.y) / 2) < 0) bridged = true;
  }
  check("negative control — no blend anywhere bridges nothing", !bridged);
}

/* ── 5. two dots stay two ───────────────────────────────────────────────────────── */
console.log("\nthinking reads as TWO dots for its whole cycle");
{
  let worst = Infinity;
  let at = 0;
  for (let t = 0; t < GEOMETRY.P_THINK * 2; t += 2) {
    const f = fieldOf(loopPose("thinking", t));
    const [a, b] = f.bodies;
    const d = sdField(f, (a.x + b.x) / 2, (a.y + b.y) / 2);
    if (d < worst) { worst = d; at = t; }
  }
  /* Strictly outside, for the whole cycle. How much daylight there actually is between
   * the facing surfaces is a separate question, and it is answered in pixels below —
   * this distance is measured at the midpoint of the two centres, which is off both
   * ellipses' axes and so reads lower than the gap. Two gates, two observables. */
  check("never bridges while thinking", worst > 0,
    `field at the midpoint stays outside by ${(worst * 18).toFixed(2)}px of 18, closest at ${at}ms`);
}
{
  /* And the same thing said in pixels: no ink at all in the corridor between the dots,
   * at any point in the cycle. This is the gate that would have caught the stray speck
   * the empty third body used to paint there — the distance probe above reported it as
   * "0.00px of clearance" and passed, because zero is still not negative. */
  let worstInk = 0;
  let at = 0;
  let narrowest = Infinity;
  for (let t = 0; t < GEOMETRY.P_THINK * 2; t += 4) {
    const f = fieldOf(loopPose("thinking", t));
    /* The corridor is the space between the FACING EDGES at this instant, inset a
     * pixel on each side so the dots' own antialias ramps are not counted. It moves
     * as they squash, which is the point: a fixed window would be inside a dot for
     * part of the cycle and would not be a test of anything. */
    const lo = (f.bodies[0].x + f.bodies[0].rx) * PX + 1;
    const hi = (f.bodies[1].x - f.bodies[1].rx) * PX - 1;
    if (hi - lo < narrowest) narrowest = hi - lo;
    if (hi <= lo) continue;
    buf.fill(0);
    rasterise(buf, PX, fieldOf(loopPose("thinking", t)), [0, 0, 0], 1);
    for (let py = 0; py < PX; py++) {
      for (let px = Math.ceil(lo); px <= Math.floor(hi); px++) {
        const a = buf[(py * PX + px) * 4 + 3];
        if (a > worstInk) { worstInk = a; at = t; }
      }
    }
  }
  /* ★ AND THE CORRIDOR MUST NEVER CLOSE, or the emptiness above is emptiness in a
   *   window of zero width and the gate has quietly stopped testing anything. */
  check("the corridor between the dots stays empty", worstInk === 0,
    `max alpha ${worstInk} at ${at}ms`);
  check("the corridor never closes", narrowest >= 1,
    `narrowest ${narrowest.toFixed(2)} device px of ${PX} (≈${(narrowest / PX * 18 + 2 / PX * 18).toFixed(2)}px of daylight at 18px)`);
}

/* ── 5b. the hand-over between the orb and the canvas ──────────────────────────── */
console.log("\nidle is the app's orb, and the hand-over does not dip");
{
  const idle = staticPose("idle");
  check("at rest the canvas is empty and the orb has the picture",
    idle.alpha === 0 && idle.orbAlpha === 1 && idle.orbScale === 1 && idle.orbBlur === 0);

  /* ★★ THE ANTI-DIP GATE. Two stacked layers cross-faded at 50% cover 1 − 0.25 = 75%
   *    of the pixel, so a symmetric dissolve makes the mark visibly translucent for a
   *    moment every single time the model starts or stops work. The composite coverage
   *    of the two layers must never fall below what either alone would give. */
  const composite = (p: Pose) => 1 - (1 - p.alpha) * (1 - p.orbAlpha);
  for (const [from, to, kind] of [["idle", "thinking", "gather"], ["writing", "idle", "bloom"]] as const) {
    const m = motionFor(from as LiquidStateName, to as LiquidStateName, 0);
    let worst = { c: 1, at: 0 };
    for (let e = 0; e <= DURATION[kind]; e += 1) {
      const c = composite(poseAt(to as LiquidStateName, 0, { ...m, elapsed: e }));
      if (c < worst.c) worst = { c, at: e };
    }
    check(`${from} → ${to} never goes translucent`, worst.c > 0.999,
      `lowest composite coverage ${worst.c.toFixed(4)} at ${worst.at}ms`);
  }
  /* And the control: a symmetric cross-fade, which is what this is not. */
  let dip = 1;
  for (let i = 0; i <= 100; i++) {
    const a = i / 100;
    dip = Math.min(dip, 1 - (1 - a) * (1 - (1 - a)));
  }
  check("negative control — a symmetric cross-fade does dip", dip < 0.999,
    `symmetric dissolve bottoms out at ${dip.toFixed(3)}`);
}

/* ── 5c. writing is a pen ───────────────────────────────────────────────────────── */
console.log("\nwriting is a pen with a real nib, drawing a real line");
{
  const pose = loopPose("writing", GEOMETRY.P_WRITE * 0.4);
  /* The ink is a capsule and the pen is a cone — both have a length, and only one of
   * them tapers. Picking "the body with a length" finds whichever comes first, which
   * is the ink, and the gate then cheerfully reports that a stroke of ink is not
   * pointy. Name the shape by the property that distinguishes it. */
  const pen = fieldOf(pose).bodies.find((b) => b.len !== undefined && b.len > 0.1 && (b.tip ?? b.rx) < b.rx * 0.5);
  check("the pen is a cone, not a stack of blobs", !!pen && pen.len! > 0.2, `len ${pen?.len?.toFixed(3)}`);
  check("and it tapers to a point", !!pen && pen.tip! < pen.rx * 0.25,
    `tip ${pen?.tip?.toFixed(4)} against a barrel of ${pen?.rx.toFixed(4)}`);

  /* ★ MEASURED OFF THE FIELD, not off the parameters. A cone can be authored with a
   *   tiny tip and still be painted blunt — the blend with the ink it is touching can
   *   fill the nib in completely, which is exactly the artifact the fold order is
   *   arranged to avoid. So: walk the pen's axis and bisect for the half-width. */
  const f = fieldOf(pose);
  const ax = Math.cos(pose.penRot);
  const ay = Math.sin(pose.penRot);
  const nx = -ay;
  const ny = ax;
  const barrelX = pose.cx + pose.penX - ax * pose.penLen;
  const barrelY = pose.penY - ay * pose.penLen;
  const halfWidth = (u: number) => {
    const px = barrelX + ax * pose.penLen * u;
    const py = barrelY + ay * pose.penLen * u;
    if (sdField(f, px, py) > 0) return 0;
    let lo = 0;
    let hi = 0.2;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (sdField(f, px + nx * mid, py + ny * mid) < 0) lo = mid; else hi = mid;
    }
    return lo;
  };
  const w = [0.15, 0.35, 0.55, 0.75, 0.95].map(halfWidth);
  let falls = true;
  for (let i = 1; i < w.length; i++) if (w[i] > w[i - 1] + 1e-4) falls = false;
  check("the painted silhouette narrows all the way to the nib", falls,
    w.map((v) => (v * 18).toFixed(2)).join("px → ") + "px at 18");
  check("and the nib is a point, not a blob", w[w.length - 1] * 18 < 0.4,
    `${(w[w.length - 1] * 18).toFixed(3)}px of half-width at 18`);

  /* The line it leaves has to actually grow while the pen is on the paper. */
  const widths = [0.1, 0.25, 0.4, 0.55, 0.68].map((g) => loopPose("writing", GEOMETRY.P_WRITE * g).inkW);
  let grows = true;
  for (let i = 1; i < widths.length; i++) if (widths[i] <= widths[i - 1]) grows = false;
  check("the ink grows behind the nib through the stroke", grows,
    widths.map((v) => (v * 2 * 18).toFixed(1)).join("px → ") + "px long at 18");
  check("and is gone by the end of the cycle", loopPose("writing", GEOMETRY.P_WRITE * 0.995).inkA < 0.02);
}

/* ── 5d. nothing is drawn past what the distance function can do ────────────────── */
console.log("\nno body is more eccentric than the ellipse approximation holds for");
{
  /* iq's ellipse approximation under-reports distance badly past roughly 10:1. At
   * 217:1 — a zero-length ink stroke drawn as an ellipse — it reported near-zero the
   * length of the canvas and painted a line from top to bottom. Nothing about that
   * failure looks like a bad distance function, so it is gated by construction. */
  let worst = { r: 1, where: "" };
  const consider = (pose: Pose, where: string) => {
    for (const b of fieldOf(pose).bodies) {
      if (b.len !== undefined && b.len > 0) continue; /* capsules and cones are exact */
      if (b.rx <= 0 || b.ry <= 0) continue;
      const r = Math.max(b.rx / b.ry, b.ry / b.rx);
      if (r > worst.r) worst = { r, where };
    }
  };
  for (const st of STATES) {
    for (let t = 0; t < periodOf(st); t += 8) consider(loopPose(st, t), `${st} loop @${t}ms`);
  }
  for (const from of STATES) {
    for (const to of STATES) {
      if (from === to) continue;
      const kind = kindFor(from, to);
      for (const frac of [0, 0.33, 0.66]) {
        const m = motionFor(from, to, frac * periodOf(from));
        for (let e = 0; e <= DURATION[kind]; e += 4) {
          consider(poseAt(to, 0, { ...m, elapsed: e }), `${from}→${to} @${e}ms`);
        }
      }
    }
  }
  check("every ellipse stays under 10:1", worst.r < 10, `worst ${worst.r.toFixed(2)}:1 at ${worst.where}`);
}

/* ── 6. position does not overshoot, shape does ring ────────────────────────────── */
console.log("\nposition and shape are on different curves");
{
  const m = motionFor("writing", "thinking", 0);
  const halves: number[] = [];
  for (let e = 0; e <= DURATION.split; e += 4) halves.push(poseAt("thinking", 0, { ...m, elapsed: e }).half);
  const end = halves[halves.length - 1];
  const over = Math.max(...halves) - end;
  check("split: separation never overshoots its landing", over <= 1e-9, `peak over target ${over.toExponential(2)}`);
}
{
  const m = motionFor("thinking", "writing", 0);
  const sy: number[] = [];
  for (let e = 0; e <= DURATION.merge; e += 4) sy.push(poseAt("writing", 0, { ...m, elapsed: e }).sy0);
  const end = sy[sy.length - 1];
  const peak = Math.max(...sy);
  const after = sy.slice(Math.floor(sy.length * 0.72));
  const rings = Math.min(...after) < end - 0.004;
  check("merge: shape overshoots on the way in", peak > end + 0.10, `peak ${peak.toFixed(3)} vs landing ${end.toFixed(3)}`);
  check("merge: shape rings back through its landing", rings, `min after impact ${Math.min(...after).toFixed(4)} vs landing ${end.toFixed(4)}`);
}

/* ── 7. the painted size is the authored size ───────────────────────────────────── */
console.log("\nthe painter and the author agree");
{
  /* Measure a thinking dot off the rendered alpha and compare with the number
   * choreography.ts thinks it authored. This is the one place the two halves of the
   * component — geometry and raster — are forced to share a zero. */
  const pose = loopPose("thinking", 0);
  buf.fill(0);
  rasterise(buf, PX, fieldOf(pose), [0, 0, 0], 1);
  const row = Math.round((GEOMETRY.GROUND - GEOMETRY.R_DOT) * PX);
  let lo = -1;
  let hi = -1;
  for (let x = 0; x < PX / 2; x++) {
    const a = buf[(row * PX + x) * 4 + 3];
    if (a > 127) { if (lo < 0) lo = x; hi = x; }
  }
  const measured = (hi - lo + 1) / PX;
  const authored = 2 * GEOMETRY.R_DOT;
  check("a resting dot's painted width matches its radius", Math.abs(measured - authored) * PX < 1.2,
    `painted ${(measured * PX).toFixed(2)}px vs authored ${(authored * PX).toFixed(2)}px of ${PX}`);
}

/* ── 8. reduced motion still says something ─────────────────────────────────────── */
console.log("\nreduced motion keeps the meaning");
{
  const drawn = (pose: Pose) => fieldOf(pose).bodies.filter((b) => b.rx > 1e-3);
  const t = drawn(staticPose("thinking"));
  const w = drawn(staticPose("writing"));
  const tp = staticPose("thinking");
  check("thinking is two separated bodies at rest", t.length === 2 && tp.half > 0.1 && t.every((b) => Math.abs(b.rx - b.ry) < 1e-9));
  check("writing rests as a pen", w.length >= 1 && staticPose("writing").half === 0);
  check("the states are visibly different", w.some((b) => b.len !== undefined && b.len > 0.1));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(`failed: ${failures.join(", ")}`); process.exit(1); }
