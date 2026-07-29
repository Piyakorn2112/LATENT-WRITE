/* Headless feel probe for the orb's motion (scripts/orb-physics-probe.ts).
   The rig is a pure engine, so its behaviour is asserted in node instead of
   eyeballed in a browser: do the petals stay inside the orb's slot, does the
   ring actually turn, is the wave bigger when the orb is working, and does
   the wave ARRIVE LATE around the ring (a travelling wave — the thing that
   makes it read as waving rather than as six shapes moving together).

   Run: node --import tsx scripts/orb-physics-probe.ts
*/
import { OrbWorld, PETAL_COUNT } from "../src/components/orb/orbPhysics";
import { PETAL_HEXES } from "../src/components/orb/orbColors";
import { bendAt, unwarp } from "../src/components/orb/orbLens";

/** the shader's orb slot: |p| ≤ 0.926 is the nominal button-sized disc */
const SLOT = 0.926;
const CANVAS = 1.389;
/** mirrors ASPECT_MIN in the rig */
const ASPECT_FLOOR = 1.04;

interface Stats {
  /** furthest any petal's tip gets from the centre */
  maxReach: number;
  /** the same, in the composed pose the orb rests in */
  restReach: number;
  /** how far the ring turned, in turns */
  turns: number;
  /** peak-to-peak swing of a petal's angular position, in radians */
  swing: number;
  /** frames between the first and last petal reaching their extreme — the
   *  travelling-wave lag */
  lagFrames: number;
  /** total angular travel, the overall "how much is moving" number */
  travel: number;
  /** closest any two petal outlines ever come (negative = overlapping) */
  minGap: number;
  /** how far the rubber ever stretches, as a length:width ratio */
  maxAspect: number;
  /** the ROUNDEST any ball gets during the run — a ball that never
   *  returns to round is a drawn ellipse, not rubber */
  minAspect: number;
  /** the widest the six balls' AREAS ever differ from each other at one
   *  instant (largest / smallest) — how strongly they size individually
   *  rather than the whole graphic scaling together */
  sizeSpread: number;
  /** mean ball area over the run, to prove the ring is not simply
   *  inflating when it works */
  meanArea: number;
  /** how far the six lengths ever differ — the working state lives here
   *  now, so this SHOULD open up with energy */
  majorSpread: number;
  /** furthest the cluster's centre of mass is ever thrown off the orb's
   *  own centre */
  maxOffset: number;
}

/** an ellipse's radius in the direction `dir` (world radians) */
function ellipseRadius(a: number, b: number, rot: number, dir: number): number {
  const t = dir - rot;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return (a * b) / Math.sqrt(b * b * c * c + a * a * s * s);
}

function run(energy: number, seconds: number, seed = 0x51a7): Stats {
  const w = new OrbWorld(seed);
  w.settleAt(energy);
  w.warm();
  const dt = 1 / 60;
  const steps = Math.round(seconds / dt);

  let maxReach = 0;
  let restReach = 0;
  for (const p of w.petals) restReach = Math.max(restReach, Math.hypot(p.x, p.y) + p.a);
  let minAspect = Infinity;
  let sizeSpread = 1;
  let areaSum = 0;
  let majorSpread = 0;
  let maxOffset = 0;
  let minGap = Infinity;
  let maxAspect = 0;
  let travel = 0;
  // the rig's own wave value per petal — measured at the source, so the
  // varying spin rate can never contaminate it
  const wave: number[][] = Array.from({ length: PETAL_COUNT }, () => []);
  const prev = w.petals.map((p) => Math.atan2(p.y, p.x));
  let turnsRad = 0;

  for (let s = 0; s < steps; s++) {
    w.step(dt);
    for (let i = 0; i < PETAL_COUNT; i++) {
      const p = w.petals[i];
      maxReach = Math.max(maxReach, Math.hypot(p.x, p.y) + p.a);
      const ang = Math.atan2(p.y, p.x);
      let da = ang - prev[i];
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      travel += Math.abs(da);
      if (i === 0) turnsRad += da;
      prev[i] = ang;
      wave[i].push(w.waveAt(i));
      maxAspect = Math.max(maxAspect, p.a / p.b);
      minAspect = Math.min(minAspect, p.a / p.b);
    }
    // how differently the six are sizing THIS frame
    let aMin = Infinity;
    let aMax = 0;
    for (const p of w.petals) {
      const area = p.a * p.b;
      areaSum += area;
      if (area < aMin) aMin = area;
      if (area > aMax) aMax = area;
    }
    sizeSpread = Math.max(sizeSpread, aMax / aMin);
    const majors = w.petals.map((p) => p.a);
    majorSpread = Math.max(majorSpread, Math.max(...majors) - Math.min(...majors));
    // the throw: where the group's centre of mass actually sits
    let cx = 0;
    let cy = 0;
    let m = 0;
    for (const p of w.petals) {
      const wgt = p.a * p.b;
      cx += p.x * wgt;
      cy += p.y * wgt;
      m += wgt;
    }
    maxOffset = Math.max(maxOffset, Math.hypot(cx / m, cy / m));
    // closest approach between any two outlines: centre distance minus each
    // ellipse's own radius toward the other
    for (let i = 0; i < PETAL_COUNT; i++) {
      for (let j = i + 1; j < PETAL_COUNT; j++) {
        const A = w.petals[i];
        const B = w.petals[j];
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const dist = Math.hypot(dx, dy);
        const dir = Math.atan2(dy, dx);
        const gap =
          dist -
          ellipseRadius(A.a, A.b, A.rot, dir) -
          ellipseRadius(B.a, B.b, B.rot, dir + Math.PI);
        if (gap < minGap) minGap = gap;
      }
    }
  }

  const swing = Math.max(...wave.map((s2) => Math.max(...s2) - Math.min(...s2)));
  // a travelling wave peaks LATER down the ring: compare each petal's peak
  // time against petal 0's, inside the same wave cycle
  const peakAt = wave.map((series) => {
    let best = -Infinity;
    let at = 0;
    for (let s = 60; s < Math.min(series.length, 360); s++) {
      if (series[s] > best) {
        best = series[s];
        at = s;
      }
    }
    return at;
  });
  const lagFrames = Math.max(...peakAt) - Math.min(...peakAt);

  return { maxReach, restReach, turns: Math.abs(turnsRad) / (Math.PI * 2), swing, lagFrames, travel, minGap, maxAspect, minAspect, sizeSpread, meanArea: areaSum / (steps * PETAL_COUNT), majorSpread, maxOffset };
}

const fmt = (n: number) => n.toFixed(3);
const rows: [string, Stats][] = [
  ["off      (e=0.08)", run(0.08, 20)],
  ["quiet    (e=0.28)", run(0.28, 20)],
  ["RESTING  (e=0.55)", run(0.55, 20)],
  ["working  (e=1.00)", run(1.0, 20)],
];

console.log("20s per condition, 60 fps\n");
console.log("condition           rest   reach  turns  swing  minGap  aspect(min/max)  spread  meanArea");
for (const [name, s] of rows) {
  console.log(
    `${name}  ${fmt(s.restReach)}  ${fmt(s.maxReach)}  ${fmt(s.turns)}  ${fmt(s.swing)}  ${fmt(s.minGap)}   ${fmt(s.minAspect)}/${fmt(s.maxAspect)}   ${fmt(s.sizeSpread)}  ${fmt(s.meanArea)}`,
  );
}

let fail = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`);
  if (!ok) fail++;
};

const dormant = rows[0][1];
const idle = rows[1][1];
/** intelligence simply ON and not analyzing — where the orb lives */
const resting = rows[2][1];
const busy = rows[3][1];

console.log("\nfeel contract");
// A petal reaching PAST the nominal slot mid-pulse is the point of the
// gesture; it must simply never touch the canvas edge, and the resting
// flower must fit its slot so it never crowds the next toolbar button.
check(
  rows.every(([, s]) => s.maxReach < CANVAS * 0.94),
  `a full reach never touches the canvas edge (max ${fmt(Math.max(...rows.map(([, s]) => s.maxReach)))} < ${fmt(CANVAS * 0.94)})`,
);
// measured on the DORMANT rig: that composed pose is what a still orb
// shows (reduced motion, a paused window), so it is the one that must fit
check(
  dormant.restReach < SLOT && dormant.restReach > SLOT * 0.62,
  `the resting flower fills its slot without overflowing (${fmt(dormant.restReach)} in ${fmt(SLOT * 0.62)}..${SLOT})`,
);
check(idle.turns > 0.25, `the ring keeps turning while idle — a quiet loading indicator (${fmt(idle.turns)} turns / 20s)`);
check(busy.turns > idle.turns * 2, `it turns faster when working (${fmt(busy.turns)} vs ${fmt(idle.turns)} turns)`);
// The driver is normalised, so energy no longer shows in its amplitude —
// it shows in how far the WIDTH RUN opens, which is the thing on screen.
check(
  busy.maxAspect > idle.maxAspect * 1.1,
  `the width run still opens some when working (${fmt(busy.maxAspect)}:1 vs ${fmt(idle.maxAspect)}:1)`,
);
check(idle.swing > 0.05, `the wave is a real wave at every energy (${fmt(idle.swing)} rad)`);
check(busy.lagFrames >= 3, `the wave ARRIVES LATE around the ring (${busy.lagFrames} frames between first and last peak)`);
check(dormant.travel < busy.travel, `a dormant orb moves less than a busy one (${fmt(dormant.travel)} vs ${fmt(busy.travel)})`);

check(
  rows.every(([, s]) => s.minGap > 0.01),
  `no two petals ever touch (closest approach ${fmt(Math.min(...rows.map(([, s]) => s.minGap)))})`,
);
// the roundest moment, not a single sampled frame: rubber that never
// returns to round is just an ellipse with extra steps
check(
  dormant.minAspect < ASPECT_FLOOR + 0.06,
  `a shape returns to its roundest at the trough (${fmt(dormant.minAspect)}:1, floor ${ASPECT_FLOOR}) — ` +
    `never a perfect circle: that is the reference's signature, and it is also the widest a shape can get`,
);
check(
  busy.maxAspect > 1.25 && busy.maxAspect > dormant.maxAspect * 1.15,
  `centrifugal load visibly stretches it when spinning (${fmt(busy.maxAspect)}:1 busy vs ${fmt(dormant.maxAspect)}:1 dormant)`,
);

// The active state must read as six balls sizing INDIVIDUALLY at rising
// strength, not as one graphic being scaled up: the spread between the
// largest and smallest ball has to widen much faster than the mean grows.
// Secondary to the width-run check above, which is the direct measure.
// This one reads how far apart the six are AT ONE INSTANT, which rises
// more gently than the run itself because the six sample the wave evenly
// and several always sit near the same part of it. Threshold set from
// that behaviour, not from the older model where size scaled area.
// The resting ring must read as six near-equal ovals: the disagreement is
// the working state's signal, and spending it at idle leaves the orb
// nothing to say when it starts thinking.
// Measured on the RESTING row, not the dormant one: energy sits at 0.55
// whenever intelligence is on, which is the state a writer actually looks
// at all day. A calm dormant orb means nothing if that one is busy.
check(
  resting.sizeSpread < 1.45,
  `the RESTING orb's six stay mostly EQUAL (spread ${fmt(resting.sizeSpread)}x)`,
);
check(
  busy.sizeSpread > resting.sizeSpread * 3,
  `and the disagreement is saved for when it works (${fmt(busy.sizeSpread)}x vs ${fmt(resting.sizeSpread)}x)`,
);
check(
  busy.sizeSpread > idle.sizeSpread * 1.15,
  `the six disagree about their size more when working (spread ${fmt(busy.sizeSpread)}x vs ${fmt(idle.sizeSpread)}x)`,
);
check(
  busy.meanArea < idle.meanArea * 1.25,
  `working does not simply inflate the ring (mean area ${fmt(busy.meanArea)} vs ${fmt(idle.meanArea)})`,
);

// SCALE is the working state now: the six must disagree about their
// LENGTH far more when busy. (The reference's one-shared-length rule was
// dropped deliberately — copied literally it read as the logo.)
check(
  busy.majorSpread > idle.majorSpread * 1.6,
  `the scaling run opens further when working (length spread ${fmt(busy.majorSpread)} vs ${fmt(idle.majorSpread)})`,
);
check(
  busy.maxAspect < 1.75,
  `the ovals stay FAT — well short of the reference's 3.42:1 (${fmt(busy.maxAspect)}:1)`,
);
// the throw: the cluster leans off centre while working, and recentres
// when it is not
check(
  busy.maxOffset > resting.maxOffset * 2,
  `the working orb is thrown off centre (${fmt(busy.maxOffset)} vs ${fmt(resting.maxOffset)})`,
);
// Relative, not absolute: a centre of MASS is pulled off centre by the
// size disagreement too, which exists at every energy. What must be true
// is that the throw is a working-state effect, so a dormant orb sits far
// closer to centred than a busy one.
check(
  resting.maxOffset < busy.maxOffset * 0.4,
  `a resting orb sits far closer to centred (${fmt(resting.maxOffset)} vs ${fmt(busy.maxOffset)})`,
);

// no two NEIGHBOURING ovals may share a colour — including across the
// wrap from the last back to the first, which is the pair an eye check
// of a linear list always misses
const clash = PETAL_HEXES.findIndex(
  (h, i) => h === PETAL_HEXES[(i + 1) % PETAL_HEXES.length],
);
check(clash < 0, `no two neighbouring ovals share a colour${clash < 0 ? "" : ` (slot ${clash})`}`);

const a = run(0.55, 5, 99);
const b = run(0.55, 5, 99);
check(a.travel === b.travel && a.maxReach === b.maxReach, "deterministic for a given seed");

/* ── The TRANSITION between resting and working ──────────────────────────
   The house motion rules reject a "steep launch" — a curve whose velocity
   is maximal on its very first frame. An exponential chase is exactly
   that, which is why the state change did not feel seamless. A spring
   leaves at zero velocity, builds, and settles.

   Measured per EVENT (enter, then exit) rather than as a max over the
   whole run, because a max over everything reports the wrong event. */
function transition(from: number, to: number, seconds = 3) {
  const w = new OrbWorld(0x51a7);
  w.settleAt(from);
  const dt = 1 / 60;
  for (let i = 0; i < 90; i++) w.step(dt);
  w.target = to;

  const series: number[] = [];
  for (let i = 0; i < seconds * 60; i++) {
    w.step(dt);
    series.push(w.energy);
  }
  const span = Math.abs(to - from);
  const vel = series.map((v, i) => Math.abs(v - (i ? series[i - 1] : from)) / dt);
  const peakVel = Math.max(...vel);
  const peakAt = vel.indexOf(peakVel);
  // where it first gets within 2% of the target and stays there
  let settled = series.length;
  for (let i = series.length - 1; i >= 0; i--) {
    if (Math.abs(series[i] - to) > span * 0.02) {
      settled = i + 1;
      break;
    }
  }
  const overshoot = to > from ? Math.max(...series) - to : to - Math.min(...series);
  return {
    firstFrameVel: vel[0],
    peakVel,
    peakAtMs: (peakAt / 60) * 1000,
    settleMs: (settled / 60) * 1000,
    overshootPct: (overshoot / span) * 100,
  };
}

const enter = transition(0.55, 1);
const exit = transition(1, 0.55);
const f2 = (n: number) => n.toFixed(2);

console.log("\ntransition (energy 0.55 <-> 1.00)");
console.log(
  `  enter  first-frame v ${f2(enter.firstFrameVel)}  peak v ${f2(enter.peakVel)} @ ${f2(enter.peakAtMs)}ms  ` +
    `settle ${f2(enter.settleMs)}ms  overshoot ${f2(enter.overshootPct)}%`,
);
console.log(
  `  exit   first-frame v ${f2(exit.firstFrameVel)}  peak v ${f2(exit.peakVel)} @ ${f2(exit.peakAtMs)}ms  ` +
    `settle ${f2(exit.settleMs)}ms  overshoot ${f2(exit.overshootPct)}%`,
);

console.log("\ntransition contract");
// the defining property of a spring vs an exponential chase: it does NOT
// leave at full speed. An exponential chase's first frame IS its fastest.
check(
  enter.firstFrameVel < enter.peakVel * 0.25,
  `entering does NOT launch at full speed (first frame ${f2(enter.firstFrameVel)} vs peak ${f2(enter.peakVel)})`,
);
check(
  exit.firstFrameVel < exit.peakVel * 0.25,
  `leaving does NOT launch at full speed (first frame ${f2(exit.firstFrameVel)} vs peak ${f2(exit.peakVel)})`,
);
check(
  enter.peakAtMs > 30,
  `the enter builds before it peaks (${f2(enter.peakAtMs)}ms in)`,
);
// "energy up front, long gentle decay" — the house rule, as a number
check(
  exit.settleMs > enter.settleMs * 1.5,
  `leaving is a longer, gentler decay than arriving (${f2(exit.settleMs)}ms vs ${f2(enter.settleMs)}ms)`,
);
check(
  enter.overshootPct > 0.5 && enter.overshootPct < 12,
  `arriving lands with life, not a bounce (${f2(enter.overshootPct)}% overshoot)`,
);
check(
  exit.overshootPct < 0.5,
  `leaving settles without rebounding (${f2(exit.overshootPct)}% overshoot)`,
);

// frame-rate independence: sample only at times that land on BOTH grids
const at60 = new OrbWorld(0x51a7);
const at120 = new OrbWorld(0x51a7);
at60.settleAt(0.55);
at120.settleAt(0.55);
at60.target = 1;
at120.target = 1;
let worst = 0;
for (let k = 0; k < 120; k++) {
  at60.step(1 / 60);
  at120.step(1 / 120);
  at120.step(1 / 120);
  worst = Math.max(worst, Math.abs(at60.energy - at120.energy));
}
// allowed: one frame of the SLOWER rate at the peak rate energy ever moves
const bound = (1 / 60) * enter.peakVel;
check(
  worst < bound,
  `the transition is frame-rate independent (60 vs 120Hz drift ${worst.toFixed(4)} < derived bound ${bound.toFixed(4)})`,
);

/* ── The SVG exporter must draw what the app draws ───────────────────────
   The shader reads the shapes through the lens at `p − dir·bend(|p|)`; the
   exporter inverts that to find where a shape-space point is actually
   shown. If the inversion is wrong the exported mark is a different
   picture — plain ellipses where the app shows refracted ones. Round-trip
   every sample: unwarp, then push it back through the shader's own
   forward map, and it must land where it started. */
console.log("\nexport fidelity");
let worstRT = 0;
for (const e of [0.55, 0.8, 1.0]) {
  for (let i = 0; i < 400; i++) {
    const th = (i / 400) * Math.PI * 2;
    const q = 0.02 + (i / 400) * 1.0; // out to past the shapes' reach
    const qx = Math.cos(th) * q;
    const qy = Math.sin(th) * q;
    const [px, py] = unwarp(qx, qy, e);
    const r = Math.hypot(px, py);
    // the shader's forward map, verbatim
    const b = bendAt(r, e);
    const fx = px - (px / r) * b;
    const fy = py - (py / r) * b;
    worstRT = Math.max(worstRT, Math.hypot(fx - qx, fy - qy));
  }
}
check(
  worstRT < 1e-4,
  `the exporter's lens inverts the shader's exactly (worst round-trip ${worstRT.toExponential(1)})`,
);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
