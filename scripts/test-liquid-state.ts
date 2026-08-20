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
  DURATION, GEOMETRY, fieldOf, kindFor, loopPose, poseAt, staticPose,
  type LiquidStateName, type Motion, type Pose, type TransitionKind,
} from "../src/components/liquid-state/choreography";
import { rasterise, sdField } from "../src/components/liquid-state/field";

const STATES: LiquidStateName[] = ["reading", "thinking", "writing"];
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
      const clock = frac * (from === "thinking" ? GEOMETRY.P_THINK : from === "writing" ? GEOMETRY.P_WRITE : GEOMETRY.P_READ);
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

/* ── 2. continuity ──────────────────────────────────────────────────────────────── */
console.log("\ncontinuity — no pose parameter jumps between adjacent frames");
const STEP = 4;
/* Per-frame limits, in pose units per 4ms. Generous enough for an impact (76ms to
 * flatten a dot) and tight enough to catch a beat boundary that does not meet. */
const LIMIT: Record<string, number> = {
  cx: 0.02, half: 0.02, r0: 0.02, r1: 0.02, lift0: 0.02, lift1: 0.02,
  sx0: 0.06, sy0: 0.06, sx1: 0.06, sy1: 0.06, bx: 0.02, by: 0.03, br: 0.02, k: 0.02, alpha: 0.10,
};
for (const s of STATES) {
  const period = s === "thinking" ? GEOMETRY.P_THINK : s === "writing" ? GEOMETRY.P_WRITE : GEOMETRY.P_READ;
  let worst = { key: "", d: 0, at: 0 };
  /* Two full cycles, so the wrap is sampled too. */
  for (let t = 0; t < period * 2; t += STEP) {
    const d = maxDelta(loopPose(s, t), loopPose(s, t + STEP));
    if (d.d / LIMIT[d.key] > worst.d / (LIMIT[worst.key] || 1)) worst = { ...d, at: t };
  }
  check(`${s} loop`, worst.d <= LIMIT[worst.key], `worst ${worst.key} Δ${worst.d.toFixed(4)} at ${worst.at}ms (limit ${LIMIT[worst.key]})`);
}
for (const from of STATES) {
  for (const to of STATES) {
    if (from === to) continue;
    const kind = kindFor(from, to);
    let worst = { key: "", d: 0, at: 0 };
    const m = motionFor(from, to, 0);
    for (let e = 0; e < DURATION[kind]; e += STEP) {
      const a = { ...m, elapsed: e };
      const b = { ...m, elapsed: e + STEP };
      const pa = poseAt(to, 0, a);
      /* Past the end the loop owns the picture — which is exactly the handover this
       * has to prove is seamless. */
      const pb = e + STEP >= DURATION[kind] ? loopPose(to, e + STEP - DURATION[kind]) : poseAt(to, 0, b);
      const d = maxDelta(pa, pb);
      if (d.d / LIMIT[d.key] > worst.d / (LIMIT[worst.key] || 1)) worst = { ...d, at: e };
    }
    check(`${from} → ${to} and into the loop`, worst.d <= LIMIT[worst.key],
      `worst ${worst.key} Δ${worst.d.toFixed(4)} at ${worst.at}ms (limit ${LIMIT[worst.key]})`);
  }
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
  const period = s === "thinking" ? GEOMETRY.P_THINK : s === "writing" ? GEOMETRY.P_WRITE : GEOMETRY.P_READ;
  let worst = 0;
  let at = 0;
  for (let t = 0; t < period * 2; t += 8) {
    const ink = borderInk(loopPose(s, t));
    if (ink > worst) { worst = ink; at = t; }
  }
  check(`${s} loop stays inside`, worst === 0, `max border alpha ${worst} at ${at}ms`);
}
for (const from of STATES) {
  for (const to of STATES) {
    if (from === to) continue;
    const kind = kindFor(from, to);
    let worst = 0;
    let at = 0;
    for (const frac of [0, 0.25, 0.5, 0.75]) {
      const period = from === "thinking" ? GEOMETRY.P_THINK : from === "writing" ? GEOMETRY.P_WRITE : GEOMETRY.P_READ;
      const m = motionFor(from, to, frac * period);
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
    const f = fieldOf(pose);
    if (f.bodies.length < 2) continue;
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
    const f = fieldOf(pose);
    if (f.bodies.length < 2) continue;
    const [a, b] = f.bodies;
    const gap = Math.abs(b.x - a.x) - (a.rx + b.rx);
    if (gap <= 0) continue;
    const mid = sdField(f, (a.x + b.x) / 2, (a.y + b.y) / 2);
    if (mid < 0 && gap > best.gap) best = { gap, at: e };
  }
  check("split holds a neck after the halves part", best.gap > 0.004,
    `widest held gap ${(best.gap * 18).toFixed(2)}px of 18 at ${best.at}ms`);
}
/* Negative control: with no surface tension there is no neck at any frame. */
{
  const m = motionFor("thinking", "writing", 0);
  let bridged = false;
  for (let e = 0; e <= DURATION.merge; e += 2) {
    const pose = { ...poseAt("writing", 0, { ...m, elapsed: e }), k: 0 };
    if (pose.half <= 1e-4) continue;
    const f = fieldOf(pose);
    if (f.bodies.length < 2) continue;
    const [a, b] = f.bodies;
    if (Math.abs(b.x - a.x) - (a.rx + b.rx) <= 0) continue;
    if (sdField(f, (a.x + b.x) / 2, (a.y + b.y) / 2) < 0) bridged = true;
  }
  check("negative control — k=0 bridges nothing", !bridged);
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
  check("never bridges while thinking", worst > 0,
    `closest the midpoint gets to inside: ${(worst * 18).toFixed(2)}px at ${at}ms`);
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
  /* Measure the merged body off the rendered alpha and compare with the number
   * choreography.ts thinks it authored. This is the one place the two halves of the
   * component — geometry and raster — are forced to share a zero. */
  const pose = loopPose("writing", 0);
  buf.fill(0);
  rasterise(buf, PX, fieldOf(pose), [0, 0, 0], 1);
  const row = Math.round((GEOMETRY.GROUND - GEOMETRY.R_ONE) * PX);
  let lo = -1;
  let hi = -1;
  for (let x = 0; x < PX; x++) {
    const a = buf[(row * PX + x) * 4 + 3];
    if (a > 127) { if (lo < 0) lo = x; hi = x; }
  }
  const measured = (hi - lo + 1) / PX;
  const authored = 2 * GEOMETRY.R_ONE;
  check("writing body's painted width matches its radius", Math.abs(measured - authored) * PX < 1.2,
    `painted ${(measured * PX).toFixed(2)}px vs authored ${(authored * PX).toFixed(2)}px of ${PX}`);
}

/* ── 8. reduced motion still says something ─────────────────────────────────────── */
console.log("\nreduced motion keeps the meaning");
{
  const t = fieldOf(staticPose("thinking"));
  const w = fieldOf(staticPose("writing"));
  check("thinking is two bodies at rest", t.bodies.length === 2 && t.bodies.every((b) => b.rx === b.ry));
  check("writing is one body at rest", w.bodies.length === 1);
  check("the two are visibly different", Math.abs(t.bodies[0].rx - w.bodies[0].rx) > 0.02);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log(`failed: ${failures.join(", ")}`); process.exit(1); }
