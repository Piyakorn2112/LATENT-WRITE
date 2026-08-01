/**
 * probe-eyes-follow.ts — the fun-mode eyes follower, measured numerically.
 *
 * The eyes ride the petal cluster's area-weighted centroid (OrbEngine writes
 * it out as --orb-eyes-dx/dy; .intel-eyes carries it as `translate`). This
 * runs the REAL rig at each energy target and reports the follower's offset
 * and speed, so "the eyes follow the orb centre" is a number, not a feeling:
 * a real lean while analysing, near-still at idle, and no snapping anywhere.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/probe-eyes-follow.ts
 */
import { OrbWorld, PETAL_COUNT } from "../src/components/orb/orbPhysics";

const world = new OrbWorld(12345);
world.warm();
// The shader maps p = (frag/res*2-1)/0.72, so one petal unit is
// 0.72 x half the canvas; toolbar orb: size 26, canvas 1.5x.
const pxPerUnit = 0.72 * (26 * 1.5) / 2;

const centroid = () => {
  let cx = 0, cy = 0, w = 0;
  for (let i = 0; i < PETAL_COUNT; i++) {
    const t = world.petals[i];
    const a = t.a * t.b;
    cx += t.x * a; cy += t.y * a; w += a;
  }
  return { x: (cx / w) * pxPerUnit, y: (cy / w) * pxPerUnit };
};

let failed = 0;
const run = (label: string, target: number, gate: (mean: number, vmax: number) => string | null) => {
  world.target = target;
  let eyeX = 0, eyeY = 0, px = 0, py = 0;
  const mags: number[] = [];
  const speeds: number[] = [];
  const dt = 1 / 60;
  for (let f = 0; f < 6 * 60; f++) {
    world.step(dt);
    const c = centroid();
    const k = Math.min(1, dt * 14); // the follower in OrbEngine.drawFrame
    eyeX += (c.x - eyeX) * k;
    eyeY += (c.y - eyeY) * k;
    if (f > 60) {
      mags.push(Math.hypot(eyeX, eyeY));
      speeds.push(Math.hypot(eyeX - px, eyeY - py) / dt);
    }
    px = eyeX; py = eyeY;
  }
  const mean = mags.reduce((a, b) => a + b, 0) / mags.length;
  const vmax = Math.max(...speeds);
  const err = gate(mean, vmax);
  console.log(`  ${err ? "✗" : "✓"} ${label}: mean offset ${mean.toFixed(2)}px, peak speed ${vmax.toFixed(1)}px/s${err ? ` — ${err}` : ""}`);
  if (err) failed++;
};

console.log("fun-mode eyes follower (toolbar orb, 26px):");
run("IDLE       (0.55)", 0.55, (m) => (m > 1.5 ? `eyes wander at rest (${m.toFixed(2)}px)` : null));
run("ANALYZING  (1.00)", 1.0, (m, v) => {
  if (m < 2) return `lean too small to read (${m.toFixed(2)}px)`;
  if (m > 9) return `lean leaves the orb (${m.toFixed(2)}px)`;
  if (v > 120) return `snapping (${v.toFixed(0)}px/s)`;
  return null;
});
run("OFF        (0.08)", 0.08, (m) => (m > 1 ? `eyes wander when off (${m.toFixed(2)}px)` : null));
console.log(failed ? `FAILED ${failed}/3` : "PASS 3/3");
process.exit(failed ? 1 : 0);
