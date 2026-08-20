/* test-liquid-state — the contract the liquid indicator's motion has to keep.
 *
 * It samples the SAME functions the component paints (choreography.poseAt, field
 * .rasterise), so a green run is a statement about the picture and not about a parallel
 * copy of the maths. Headless: no browser, no canvas, no DOM.
 *
 * The gates worth knowing about before reading the code:
 *
 *   HANDSHAKE      every transition ends exactly on its target loop's clock-zero pose
 *   CONTINUITY     the picture does not step — a SCALING test, needing no constant
 *   SMOOTHNESS     the picture does not JERK — a second-difference scaling test, which
 *                  is a different question and the one that matters for "does it feel
 *                  smooth". A body that stops dead moves no pixel discontinuously and
 *                  still reads as a jolt.
 *   CONTAINMENT    nothing is ever clipped by the edge of the canvas
 *   THE NECK       the blend actually bridges a gap, which overlap cannot fake
 *   SHAPE          three dots stay three; three lines stay three lines; the pen has a
 *                  head and a barrel and a nib that is a point
 *   THE HAND-OVER  the orb and the canvas never both go faint at once
 *
 * ★ Several gates carry a negative control that runs a deliberately broken input
 *   through the same assertion and requires it to fail. A gate that has never been seen
 *   to fail is not known to be a gate.
 */
import {
  ALL_POSE_KEYS, DURATION, GEOMETRY, POSITION_KEYS, fieldOf, kindFor, loopPose, periodOf,
  poseAt, staticPose, tailClock,
  type LiquidStateName, type Motion, type Pose, type PoseKey,
} from "../src/components/liquid-state/choreography";
import { rasterise, sdField } from "../src/components/liquid-state/field";

const STATES: LiquidStateName[] = ["idle", "reading", "thinking", "writing"];
const WORKING: LiquidStateName[] = ["reading", "thinking", "writing"];
const PX = 54; /* 18 CSS px at 3× — the densest the component ever runs */

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ok   ${name}${detail ? `  (${detail})` : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

const at = (p: Pose, k: PoseKey): number => (p as unknown as Record<string, number>)[k];

const maxDelta = (a: Pose, b: Pose): { key: string; d: number } => {
  let worst = { key: "", d: 0 };
  for (const k of ALL_POSE_KEYS) {
    const d = Math.abs(at(a, k) - at(b, k));
    if (d > worst.d) worst = { key: k, d };
  }
  return worst;
};

function motionFor(from: LiquidStateName, to: LiquidStateName, clock: number): Motion {
  return { from, to, kind: kindFor(from, to), fromPose: loopPose(from, clock), elapsed: 0 };
}

/** The frame function for a transition, running past its end into the loop it hands to
 *  — the handover is the frame most likely to be wrong and least likely to be looked at. */
function frameFn(from: LiquidStateName, to: LiquidStateName, clock = 0) {
  const kind = kindFor(from, to);
  const m = motionFor(from, to, clock);
  /* Past the end, the loop continues from the clock the transition handed over on —
   * exactly as the component does it. Resuming from zero here would test a handover
   * the component never performs. */
  return (t: number): Pose => (t < DURATION[kind]
    ? poseAt(to, 0, { ...m, elapsed: t })
    : loopPose(to, tailClock(kind) + t - DURATION[kind]));
}

/* ── 1. the handshake ───────────────────────────────────────────────────────────── */
console.log("\nhandshake — every transition ends on the target loop, at the clock it hands over on");
for (const from of STATES) {
  for (const to of STATES) {
    if (from === to) continue;
    let worst = 0;
    let worstKey = "";
    for (const frac of [0, 0.17, 0.33, 0.5, 0.66, 0.83]) {
      const m = motionFor(from, to, frac * periodOf(from));
      m.elapsed = DURATION[m.kind];
      /* Not clock ZERO: the loop has been running for the last third of the
       * transition, so the pose it lands on is the loop at `tailClock`. That is what
       * makes the hand-over match in VELOCITY as well as in position. */
      const d = maxDelta(poseAt(to, 0, m), loopPose(to, tailClock(m.kind)));
      if (d.d > worst) { worst = d.d; worstKey = d.key; }
    }
    check(`${from} → ${to} (${kindFor(from, to)})`, worst < 1e-9,
      `max Δ ${worst.toExponential(2)} on ${worstKey || "-"}`);
  }
}
{
  const m = motionFor("thinking", "writing", 0);
  m.elapsed = DURATION.morph - 16;
  const d = maxDelta(poseAt("writing", 0, m), loopPose("writing", tailClock("morph")));
  check("negative control — a morph cut 16ms short does not land", d.d > 1e-6,
    `Δ ${d.d.toFixed(5)} on ${d.key}`);
}

/* ── 2. continuity of the picture ───────────────────────────────────────────────── */
console.log("\ncontinuity — halve the timestep and the frame-to-frame change must halve");
/*
 * ★ THE OBSERVABLE IS THE RENDERED ALPHA, NOT THE POSE, and the test is a SCALING test
 *   so it needs no constant at all. For any continuous piecewise-smooth motion the
 *   largest change between adjacent frames is bounded by h·max|f′|, so halving h halves
 *   it; across a genuine STEP the change IS the step and does not shrink. Sampled at
 *   4ms and 0.5ms, continuous motion reads near 8 and a discontinuity reads near 1.
 */
const CPX = 32;
const inkA = new Uint8ClampedArray(CPX * CPX * 4);
const inkB = new Uint8ClampedArray(CPX * CPX * 4);
const BLACK: [number, number, number] = [0, 0, 0];

function inkOf(target: Uint8ClampedArray, pose: Pose) {
  /* The pose's own opacity is part of the picture: while the orb owns the mark the
   * canvas is fully transparent, and a gate that ignores that asserts continuity of an
   * invisible layer. */
  rasterise(target, CPX, fieldOf(pose), BLACK, pose.alpha);
}
function alphaDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 3; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]);
  return sum / 255;
}
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
    `ratio ${ratio.toFixed(2)} (ideal 8) — worst 4ms step ${coarse.d.toFixed(2)}px² at ${coarse.at.toFixed(0)}ms`);
}
/** Idle turns nothing; a cap keeps the sampling honest and is said out loud. */
const SAMPLE_MS = (s: LiquidStateName) => Math.min(periodOf(s) * 1.02, 2600);

for (const s of STATES) continuityRatio(`${s} loop`, (t) => loopPose(s, t), 0, SAMPLE_MS(s));
for (const from of STATES) {
  for (const to of STATES) {
    if (from === to) continue;
    continuityRatio(`${from} → ${to} and into the loop`, frameFn(from, to), 0, DURATION[kindFor(from, to)] + 240);
  }
}
{
  const period = GEOMETRY.P_THINK;
  const broken = (t: number): Pose => {
    const pose = loopPose("thinking", t);
    return t > period / 2 ? { ...pose, ax: pose.ax + 0.04 } : pose;
  };
  const ratio = worstStep(broken, 0, period, 4).d / worstStep(broken, 0, period, 0.5).d;
  check("negative control — a planted 0.04 step is caught", ratio < 4, `ratio ${ratio.toFixed(2)}`);
}

/* ── 3. smoothness: no jerks ────────────────────────────────────────────────────── */
console.log("\nsmoothness — position must be continuous in VELOCITY, not merely in value");
/*
 * ★★ A DIFFERENT QUESTION FROM THE ONE ABOVE, AND THE ONE THAT ACTUALLY MATTERS FOR
 *    HOW IT FEELS. A body that travels and then stops dead moves no pixel
 *    discontinuously — the continuity gate is perfectly happy — and reads as a jolt.
 *    That is what "far from smooth" was: a dozen parameters each on its own window,
 *    every boundary a change of velocity, several landing at different times.
 *
 *    Second differences scale as h² for a function with a continuous first derivative
 *    and as h for one with a kink in it. So halve the step twice and a smooth channel's
 *    second difference falls by 16 while a kinked one falls by 4. The threshold sits
 *    between them.
 *
 *  ★ SHAPE CHANNELS ARE EXEMPT ON PURPOSE. A deform is an impulse; a squash that eases
 *    in reads as a resize and one that arrives reads as an impact. The exemption is
 *    named in POSITION_KEYS rather than decided here, so it is a property of the
 *    choreography and not of its test.
 */
function jerkRatio(frame: (t: number) => Pose, t0: number, t1: number): { ratio: number; key: string; at: number } {
  const d2 = (h: number) => {
    let worst = { d: 0, key: "", at: 0 };
    for (let t = t0 + h; t + h <= t1; t += h) {
      const a = frame(t - h);
      const b = frame(t);
      const c = frame(t + h);
      for (const k of POSITION_KEYS) {
        const v = Math.abs(at(a, k) - 2 * at(b, k) + at(c, k));
        if (v > worst.d) worst = { d: v, key: k, at: t };
      }
    }
    return worst;
  };
  const coarse = d2(4);
  const fine = d2(1);
  return {
    ratio: fine.d < 1e-12 ? Infinity : coarse.d / fine.d,
    key: coarse.key,
    at: coarse.at,
  };
}
/* ★ LOOPS ARE EXEMPT, AND THAT IS A DESIGN STATEMENT RATHER THAN AN EXCUSE. A jumping
 *   dot leaves the ground with a velocity: the launch and the landing are IMPULSES, and
 *   a bounce without them is a float. The same goes for a pen touching down. What must
 *   never jerk is a TRANSITION, where nothing is being struck and every jolt is the
 *   choreography contradicting itself. */
for (const from of STATES) {
  for (const to of STATES) {
    if (from === to) continue;
    /* ★ THE TAIL IS EXCLUDED, because the tail IS the loop — it has been running under
     *   the cross-fade for the last third, and a loop is allowed its impulses. What is
     *   being tested is the AUTHORED part of the transition. */
    const dur = DURATION[kindFor(from, to)];
    const r = jerkRatio(frameFn(from, to), 0, dur * 0.68);
    check(`${from} → ${to} has no velocity jump`, r.ratio >= 8,
      `ratio ${r.ratio.toFixed(1)}, worst on ${r.key} at ${r.at.toFixed(0)}ms`);
  }
}
{
  /* Negative control: a channel that ramps linearly and then stops is continuous in
   * value and kinked in velocity — exactly the failure this gate exists for. */
  const broken = (t: number): Pose => ({ ...loopPose("thinking", 0), ax: 0.5 + Math.min(t, 200) * 0.0005 });
  const r = jerkRatio(broken, 0, 400);
  check("negative control — a ramp that stops dead is caught", r.ratio < 8, `ratio ${r.ratio.toFixed(1)}`);
}

/* ── 4. containment ─────────────────────────────────────────────────────────────── */
console.log("\ncontainment — nothing touches the edge of the canvas, in any state");
const buf = new Uint8ClampedArray(PX * PX * 4);
function borderInk(pose: Pose): number {
  buf.fill(0);
  rasterise(buf, PX, fieldOf(pose), BLACK, 1);
  let worst = 0;
  for (let i = 0; i < PX; i++) {
    for (const o of [i * 4 + 3, ((PX - 1) * PX + i) * 4 + 3, (i * PX) * 4 + 3, (i * PX + PX - 1) * 4 + 3]) {
      if (buf[o] > worst) worst = buf[o];
    }
  }
  return worst;
}
for (const s of STATES) {
  let worst = 0;
  let when = 0;
  for (let t = 0; t < periodOf(s) * 2; t += 8) {
    const ink = borderInk(loopPose(s, t));
    if (ink > worst) { worst = ink; when = t; }
  }
  check(`${s} loop stays inside`, worst === 0, `max border alpha ${worst} at ${when}ms`);
}
for (const from of STATES) {
  for (const to of STATES) {
    if (from === to) continue;
    let worst = 0;
    for (const frac of [0, 0.25, 0.5, 0.75]) {
      const frame = frameFn(from, to, frac * periodOf(from));
      for (let t = 0; t <= DURATION[kindFor(from, to)]; t += 8) {
        const ink = borderInk(frame(t));
        if (ink > worst) worst = ink;
      }
    }
    check(`${from} → ${to} stays inside`, worst === 0, `max border alpha ${worst}`);
  }
}
{
  let worst = 0;
  for (const s of STATES) {
    const m: Motion = { from: null, to: s, kind: "enter", fromPose: loopPose(s, 0), elapsed: 0 };
    for (let t = 0; t <= DURATION.enter; t += 8) {
      const ink = borderInk(poseAt(s, 0, { ...m, elapsed: t }));
      if (ink > worst) worst = ink;
    }
  }
  check("the entrance stays inside", worst === 0, `max border alpha ${worst}`);
}

/* ── 5. the neck ────────────────────────────────────────────────────────────────── */
console.log("\nthe neck — a bridge across a gap, which overlap cannot fake");
function widestBridge(from: LiquidStateName, to: LiquidStateName, zeroBlend = false) {
  const kind = kindFor(from, to);
  const m = motionFor(from, to, 0);
  let best = { gap: 0, at: 0 };
  for (let e = 0; e <= DURATION[kind]; e += 2) {
    const pose = poseAt(to, 0, { ...m, elapsed: e });
    /* The two outer bodies ALONE — a pen or a line lying across the gap would be a
     * bridge by overlap, and this gate exists to prove the BLEND makes one. */
    const present = fieldOf(pose).bodies.slice(0, 3).filter((b) => b.r > 1e-4);
    if (present.length < 2) continue;
    /* ★ THE OUTER PAIR ONLY. With three bodies converging, the middle one sits on the
     * midpoint and covers it — so a control asserting "with no blend, nothing bridges"
     * was measuring a body standing in the gap rather than a neck across it. */
    const bodies = [present[0], present[present.length - 1]];
    const f = { bodies: zeroBlend ? bodies.map((b) => ({ ...b, k: 0 })) : bodies };
    /* A body's x is its NEAR END, so the centre is half a scaled length along. Using
     * the stored x as a centre understates the gap and the gate quietly stops testing
     * the thing it names. */
    const mid = (bd: typeof f.bodies[number]) => ({ x: bd.x + (bd.len * (bd.sx ?? 1)) / 2, y: bd.y });
    const [a, b] = [f.bodies[0], f.bodies[f.bodies.length - 1]];
    const ma = mid(a);
    const mb = mid(b);
    const gap = Math.hypot(mb.x - ma.x, mb.y - ma.y)
      - (a.r * (a.sx ?? 1) + b.r * (b.sx ?? 1) + (a.len * (a.sx ?? 1)) / 2 + (b.len * (b.sx ?? 1)) / 2);
    if (gap <= 0) continue;
    if (sdField(f, (ma.x + mb.x) / 2, (ma.y + mb.y) / 2) < 0 && gap > best.gap) best = { gap, at: e };
  }
  return best;
}
{
  const merge = widestBridge("thinking", "writing");
  check("a mass coalescing bridges a real gap", merge.gap > 0.004,
    `widest bridged gap ${(merge.gap * 18).toFixed(2)}px of 18 at ${merge.at}ms`);
  const tear = widestBridge("writing", "thinking");
  check("a mass tearing holds a neck after the halves part", tear.gap > 0.004,
    `widest held gap ${(tear.gap * 18).toFixed(2)}px of 18 at ${tear.at}ms`);
  check("negative control — no blend anywhere bridges nothing",
    widestBridge("thinking", "writing", true).gap === 0);
}

/* ── 6. the shapes read as what they are ────────────────────────────────────────── */
console.log("\nthinking reads as THREE dots for its whole cycle");
{
  const dots = (pose: Pose) => fieldOf(pose).bodies.slice(0, 3);
  let worst = Infinity;
  let when = 0;
  let narrowest = Infinity;
  let ink = 0;
  for (let t = 0; t < GEOMETRY.P_THINK * 2; t += 4) {
    const pose = loopPose("thinking", t);
    const f = { bodies: dots(pose) };
    for (const [a, b] of [[f.bodies[0], f.bodies[1]], [f.bodies[1], f.bodies[2]]]) {
      const d = sdField(f, (a.x + b.x) / 2, (a.y + b.y) / 2);
      if (d < worst) { worst = d; when = t; }
      /* Inset by a pixel and a half, not one: two facing antialias ramps legitimately
       * reach half a pixel each, and counting them is counting the edges rather than
       * the space between them. */
      const lo = (a.x + a.r * (a.sx ?? 1)) * PX + 1.5;
      const hi = (b.x - b.r * (b.sx ?? 1)) * PX - 1.5;
      if (hi - lo < narrowest) narrowest = hi - lo;
      if (hi > lo) {
        buf.fill(0);
        rasterise(buf, PX, fieldOf(pose), BLACK, 1);
        for (let py = 0; py < PX; py++) {
          for (let px = Math.ceil(lo); px <= Math.floor(hi); px++) ink = Math.max(ink, buf[(py * PX + px) * 4 + 3]);
        }
      }
    }
  }
  check("adjacent dots never bridge", worst > 0,
    `field between them stays outside by ${(worst * 18).toFixed(2)}px of 18, closest at ${when}ms`);
  check("the corridors between them stay empty", ink === 0, `max alpha ${ink}`);
  /* The corridor is measured with a pixel and a half of inset on each side, so the
   * real daylight between the dots is three device pixels more than this. */
  check("and never close", narrowest + 3 >= 2.5,
    `narrowest daylight ${(narrowest + 3).toFixed(2)} device px of ${PX} (${((narrowest + 3) / PX * 18).toFixed(2)}px at 18)`);
}

console.log("\nreading reads as three lines of a paragraph");
{
  const pose = staticPose("reading");
  const lines = fieldOf(pose).bodies.slice(0, 3);
  check("three separate lines", lines.every((b) => b.len > 0.2),
    lines.map((b) => (b.len * 18).toFixed(1)).join("px, ") + "px long at 18");
  check("stacked, not overlapping", lines.every((b, i) =>
    i === 0 || b.y - lines[i - 1].y > (b.r + lines[i - 1].r) * 1.4),
    lines.map((b) => b.y.toFixed(2)).join(" / "));
  check("left-aligned like a paragraph", lines.every((b) => Math.abs(b.x - lines[0].x) < 1e-6),
    `left edges at ${lines.map((b) => b.x.toFixed(3)).join(", ")}`);
  check("ragged on the right", new Set(lines.map((b) => Math.round(b.len * 100))).size === 3,
    lines.map((b) => b.len.toFixed(2)).join(", "));
  /* The wave has to actually run DOWN the page, not pulse in unison. */
  /* ★ THE RISE, NOT THE PEAK. Each line holds at full length for nearly half a cycle,
   *   so "when is it longest" is a plateau and argmax picks whichever sample came
   *   first — which reported the third line peaking at 0ms and the wave running
   *   backwards. When it CROSSES half, going up, is a single well-defined moment. */
  const rise = (i: number) => {
    for (let t = 0; t < GEOMETRY.P_READ; t += 5) {
      const w = fieldOf(loopPose("reading", t)).bodies[i].len / GEOMETRY.LINE_LEN[i];
      const prev = fieldOf(loopPose("reading", t - 5)).bodies[i].len / GEOMETRY.LINE_LEN[i];
      if (w >= 0.5 && prev < 0.5) return t;
    }
    return -1;
  };
  const rises = [0, 1, 2].map(rise);
  const step = GEOMETRY.P_READ * 0.26;
  const spacing = [rises[1] - rises[0], rises[2] - rises[1]].map((d) => (d + GEOMETRY.P_READ) % GEOMETRY.P_READ);
  check("and the wave runs down the page", spacing.every((d) => Math.abs(d - step) < 30),
    `lines cross half at ${rises.join("ms, ")}ms — spacing ${spacing.map((d) => d.toFixed(0)).join(", ")}ms against ${step.toFixed(0)}ms`);
}

console.log("\nwriting is a pen with a real nib, drawing a real line");
{
  const pose = loopPose("writing", GEOMETRY.P_WRITE * 0.4);
  const bodies = fieldOf(pose).bodies;
  const head = bodies.find((b) => b.len > 0.02 && (b.tip ?? b.r) < b.r * 0.5);
  const barrel = bodies.find((b) => b.len > 0.02 && b.tip === undefined && b.r > GEOMETRY.INK_R * 1.5);
  check("the pen has a head and a barrel", !!head && !!barrel,
    `head len ${head?.len?.toFixed(3)}, barrel len ${barrel?.len?.toFixed(3)}`);
  check("the head tapers to a point", !!head && head.tip! < head.r * 0.25,
    `tip ${head?.tip?.toFixed(4)} against a neck of ${head?.r.toFixed(4)}`);
  check("and the barrel steps out at the shoulder", !!head && !!barrel && barrel.r > head.r * 1.3,
    `barrel ${barrel?.r.toFixed(4)} against neck ${head?.r.toFixed(4)}`);

  /* ★ MEASURED OFF THE FIELD, not off the parameters. A cone can be authored with a
   *   tiny tip and painted blunt — the blend with the line it is touching can fill the
   *   nib in completely. So: walk the pen's axis and bisect for the half-width. */
  const f = fieldOf(pose);
  const ax = Math.cos(pose.prot);
  const ay = Math.sin(pose.prot);
  const barrelX = pose.px - ax * pose.plen;
  const barrelY = pose.py - ay * pose.plen;
  const halfWidth = (u: number) => {
    const qx = barrelX + ax * pose.plen * u;
    const qy = barrelY + ay * pose.plen * u;
    if (sdField(f, qx, qy) > 0) return 0;
    let lo = 0;
    let hi = 0.2;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (sdField(f, qx - ay * mid, qy + ax * mid) < 0) lo = mid; else hi = mid;
    }
    return lo;
  };
  const w = [0.15, 0.35, 0.55, 0.75, 0.95].map(halfWidth);
  check("the painted silhouette narrows to the nib", w.every((v, i) => i === 0 || v <= w[i - 1] + 1e-4),
    w.map((v) => (v * 18).toFixed(2)).join("px → ") + "px at 18");
  check("and the nib is a point, not a blob", w[w.length - 1] * 18 < 0.45,
    `${(w[w.length - 1] * 18).toFixed(3)}px of half-width at 18`);
  const lens = [0.1, 0.25, 0.4, 0.55, 0.68].map((g) => loopPose("writing", GEOMETRY.P_WRITE * g).al);
  check("the line grows behind the nib through the stroke", lens.every((v, i) => i === 0 || v > lens[i - 1]),
    lens.map((v) => (v * 18).toFixed(1)).join("px → ") + "px long at 18");
  check("and is gone by the end of the cycle", loopPose("writing", GEOMETRY.P_WRITE * 0.995).ar < 0.002);
}

/* ── 7. the hand-over ───────────────────────────────────────────────────────────── */
console.log("\nidle is the app's orb, and the hand-over does not dip");
{
  const idle = staticPose("idle");
  check("at rest the canvas is empty and the orb has the picture",
    idle.alpha === 0 && idle.oa === 1 && idle.os === 1 && idle.ob === 0);
  /* ★★ Two stacked layers cross-faded at 50% cover 1 − 0.25 = 75% of the pixel, so a
   *    symmetric dissolve makes the mark visibly translucent for a moment every single
   *    time work starts or stops. */
  const composite = (p: Pose) => 1 - (1 - p.alpha) * (1 - p.oa);
  for (const [from, to] of [["idle", "thinking"], ["writing", "idle"]] as const) {
    const m = motionFor(from, to, 0);
    let worst = { c: 1, at: 0 };
    for (let e = 0; e <= DURATION.handoff; e += 1) {
      const c = composite(poseAt(to, 0, { ...m, elapsed: e }));
      if (c < worst.c) worst = { c, at: e };
    }
    check(`${from} → ${to} never goes translucent`, worst.c > 0.999,
      `lowest composite coverage ${worst.c.toFixed(4)} at ${worst.at}ms`);
  }
  let dip = 1;
  for (let i = 0; i <= 100; i++) { const a = i / 100; dip = Math.min(dip, 1 - (1 - a) * a); }
  check("negative control — a symmetric cross-fade does dip", dip < 0.999,
    `symmetric dissolve bottoms out at ${dip.toFixed(3)}`);
}

/* ── 8. nothing past what the distance function can do ──────────────────────────── */
console.log("\nno ellipse is more eccentric than the approximation holds for");
{
  /* iq's ellipse approximation under-reports distance badly past roughly 10:1. At 217:1
   * — a zero-length ink stroke drawn as an ellipse — it reported near-zero the length
   * of the canvas and painted a line from top to bottom. Nothing about that failure
   * looks like a bad distance function, so it is gated by construction. */
  let worst = { r: 1, where: "" };
  const consider = (pose: Pose, where: string) => {
    for (const b of fieldOf(pose).bodies) {
      if (b.len > 0) continue; /* capsules and cones are exact */
      if (b.r <= 0) continue;
      const r = Math.max((b.sx ?? 1) / (b.sy ?? 1), (b.sy ?? 1) / (b.sx ?? 1));
      if (r > worst.r) worst = { r, where };
    }
  };
  for (const st of STATES) for (let t = 0; t < periodOf(st); t += 8) consider(loopPose(st, t), `${st} @${t}ms`);
  for (const from of STATES) {
    for (const to of STATES) {
      if (from === to) continue;
      const frame = frameFn(from, to);
      for (let t = 0; t <= DURATION[kindFor(from, to)]; t += 4) consider(frame(t), `${from}→${to} @${t}ms`);
    }
  }
  check("every ellipse stays under 10:1", worst.r < 10, `worst ${worst.r.toFixed(2)}:1 at ${worst.where}`);
}

/* ── 9. the painter and the author agree ────────────────────────────────────────── */
console.log("\nthe painter and the author agree");
{
  const pose = loopPose("thinking", 0);
  buf.fill(0);
  rasterise(buf, PX, fieldOf(pose), BLACK, 1);
  const row = Math.round((GEOMETRY.GROUND - GEOMETRY.R_DOT) * PX);
  let lo = -1;
  let hi = -1;
  for (let x = 0; x < PX / 3; x++) {
    if (buf[(row * PX + x) * 4 + 3] > 127) { if (lo < 0) lo = x; hi = x; }
  }
  const measured = (hi - lo + 1) / PX;
  check("a resting dot's painted width matches its radius",
    Math.abs(measured - 2 * GEOMETRY.R_DOT) * PX < 1.2,
    `painted ${(measured * PX).toFixed(2)}px vs authored ${(2 * GEOMETRY.R_DOT * PX).toFixed(2)}px of ${PX}`);
}

/* ── 10. reduced motion still says something ────────────────────────────────────── */
console.log("\nreduced motion keeps the meaning");
{
  const drawn = (s: LiquidStateName) => fieldOf(staticPose(s)).bodies.filter((b) => b.r > 1e-3);
  check("thinking rests as three separated dots",
    drawn("thinking").length === 3 && drawn("thinking").every((b) => b.len === 0));
  check("reading rests as three lines", drawn("reading").filter((b) => b.len > 0.2).length === 3);
  check("writing rests as a pen mid-stroke",
    drawn("writing").some((b) => (b.tip ?? b.r) < b.r * 0.5) && staticPose("writing").ar > 0.01);
  check("idle rests as the orb alone", drawn("idle").length === 1 && staticPose("idle").alpha === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(`failed: ${failures.join(", ")}`); process.exit(1); }
