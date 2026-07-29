/* Export the intelligence orb as a flat vector SVG — for the app icon.
   (scripts/export-orb-svg.ts)

   The orb is six flat ellipses whose geometry is decided by a pure engine,
   so a frame of it IS a vector drawing: no rasterising, no tracing, no
   screenshotting. This script runs the same rig the app runs, freezes it
   at a chosen instant, and writes the six shapes out as `<ellipse>`
   elements with the same colours the running orb uses.

   Run:
     npm run export:orb -- --out icon.svg
     npm run export:orb -- --energy 1 --time 3.2 --seed 42 --out working.svg

   Options
     --out <path>     where to write            (default orb-icon.svg)
     --size <px>      width/height attributes   (default 1024)
     --seed <int>     which choreography        (default 0x51a7)
     --energy <0..1>  0.08 off · 0.55 resting · 1 working (default 0.8 —
                      full working shrinks some shapes to slivers, which is
                      right on screen and wrong for a mark)
     --time <sec>     freeze here; omit to AUTO-PICK the most dynamic frame
     --fit <0..1>     fraction of the canvas the mark fills (default 0.78)
     --bg <css>       paint a background square (default none/transparent)
     --grey           export the off-state greys instead of the colours
     --vibrance <n>   match the app's converged-idle lift (0..1, default 0)

   POSE. By default it scans the first 12 seconds and keeps the frame that
   reads most like motion — sizes far apart, ring thrown off centre, axes
   leaning into the turn — because frame 0 is composed and even, which
   makes a truthful but inert icon. Pass `--time` to pick a frame by hand.
   Either way the shapes are frozen exactly as drawn, so what you export is
   what the app actually shows at that instant.
*/
import { writeFileSync } from "node:fs";
import { OrbWorld, PETAL_COUNT } from "../src/components/orb/orbPhysics";
import { PETAL_HEXES, OFF_GREY_LIGHT, hexToRgb } from "../src/components/orb/orbColors";
import { unwarp, shadeColor } from "../src/components/orb/orbLens";

/** the drained state, derived from the SAME values the engine uses rather
 *  than a hand-copied set that would quietly drift out of sync */
const OFF_GREYS = OFF_GREY_LIGHT.map((v) => {
  const h = Math.round(v * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${h}${h}${h}`;
});

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const out = arg("out", "orb-icon.svg");
const size = Number(arg("size", "1024"));
const seed = Number(arg("seed", String(0x51a7)));
const energy = Number(arg("energy", "0.8"));
let time = Number(arg("time", "-1"));
const fit = Number(arg("fit", "0.78"));
const bg = arg("bg", "");
const vibrance = Number(arg("vibrance", "0"));
const colours = has("grey") ? OFF_GREYS : PETAL_HEXES;

const dt = 1 / 60;

/* ── POSE. A frozen frame only reads as motion if it CATCHES the orb
   mid-gesture: the sizes far apart, the ring thrown off centre, the
   shapes leaning into the turn. Frame 0 has none of that — the rig is
   composed and even there, which makes a truthful but inert icon.

   So unless a --time is given, scan the first stretch of the animation
   and keep the most dynamic frame: score = how far the sizes disagree,
   how far the group is thrown, and how far the axes have leaned off
   radial. Deterministic, because the rig is. */
/** A frame is only usable as a mark if all six shapes still READ. The
 *  working orb legitimately shrinks some of them to slivers, and the most
 *  "dynamic" frame is often one where half the ring has all but vanished —
 *  dramatic, but not an icon. */
const MIN_READABLE = 0.24;

function poseScore(w: OrbWorld): number {
  let aMin = Infinity;
  let aMax = 0;
  let cx = 0;
  let cy = 0;
  let m = 0;
  let lean = 0;
  for (const p of w.petals) {
    const area = p.a * p.b;
    aMin = Math.min(aMin, area);
    aMax = Math.max(aMax, area);
    cx += p.x * area;
    cy += p.y * area;
    m += area;
    let d = p.rot - Math.atan2(p.y, p.x);
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    lean += Math.abs(d);
  }
  if (aMin / aMax < MIN_READABLE) return -Infinity; // a shape has vanished
  const spread = aMax / aMin;
  const thrown = Math.hypot(cx / m, cy / m);
  return spread * 0.5 + thrown * 6 + (lean / PETAL_COUNT) * 4;
}

if (time < 0) {
  const scan = new OrbWorld(seed);
  scan.settleAt(energy);
  scan.warm();
  let best = -Infinity;
  let bestT = 0;
  let anyReadable = false;
  for (let f = 0; f < 12 * 60; f++) {
    scan.step(dt);
    const sc = poseScore(scan);
    if (sc > -Infinity) anyReadable = true;
    if (sc > best) {
      best = sc;
      bestT = (f + 1) * dt;
    }
  }
  if (!anyReadable) {
    console.warn(
      `no frame kept all six shapes above ${MIN_READABLE} of the largest — ` +
        `falling back to t=0; try a lower --energy`,
    );
    bestT = 0;
  }
  time = bestT;
  console.log(`auto-pose: t=${time.toFixed(3)}s (score ${best.toFixed(2)}) — pass --time to override`);
}

// ── run the real rig to the chosen instant
const world = new OrbWorld(seed);
world.settleAt(energy);
world.warm();
for (let t = 0; t < time - 1e-9; t += dt) world.step(dt);

/* Each shape is an ellipse with semi-axes (a, b) rotated by `rot`. Its
   axis-aligned half-extents are the classic
     hx = √(a²cos²θ + b²sin²θ),  hy = √(a²sin²θ + b²cos²θ)
   which is what lets us fit the mark to the canvas exactly rather than
   guessing a margin. */
let minX = Infinity;
let maxX = -Infinity;
let minY = Infinity;
let maxY = -Infinity;
for (const p of world.petals) {
  const c = Math.cos(p.rot);
  const s = Math.sin(p.rot);
  const hx = Math.sqrt(p.a * p.a * c * c + p.b * p.b * s * s);
  const hy = Math.sqrt(p.a * p.a * s * s + p.b * p.b * c * c);
  minX = Math.min(minX, p.x - hx);
  maxX = Math.max(maxX, p.x + hx);
  minY = Math.min(minY, p.y - hy);
  maxY = Math.max(maxY, p.y + hy);
}
// Fit the mark's own extent, but keep it CENTRED on the orb's centre
// rather than on its bounding box: while the orb is working it is thrown
// off centre on purpose, and re-centring the box would quietly undo that.
const reach = Math.max(-minX, maxX, -minY, maxY);
const scale = (size * fit) / (2 * reach);
const mid = size / 2;

const n = (v: number) => Number(v.toFixed(2));

/* ── Matching the live render, not approximating it ──────────────────────
   The app does not draw plain ellipses. Every shape is read through the
   invisible lens, which bends it as it nears the rim, and the colour is
   scaled by the shader's own brightness/saturation pass. An exporter that
   emits `<ellipse>` with the raw palette hex therefore ships a DIFFERENT
   picture than the one on screen.

   So each outline is sampled in shape-space, every point pushed through
   the same lens (`orbLens.ts`, whose constants the GLSL also interpolates,
   so the two cannot drift), and emitted as a path. A refracted ellipse is
   not an ellipse, so `<ellipse>` cannot express it. */
const OUTLINE_STEPS = 128;

const shapes: string[] = [];
for (let i = 0; i < PETAL_COUNT; i++) {
  const p = world.petals[i];
  const cos = Math.cos(p.rot);
  const sin = Math.sin(p.rot);
  const pts: string[] = [];
  for (let k = 0; k < OUTLINE_STEPS; k++) {
    const th = (k / OUTLINE_STEPS) * Math.PI * 2;
    // the ellipse outline, in the orb's own shape-space
    const ex = Math.cos(th) * p.a;
    const ey = Math.sin(th) * p.b;
    const sx = p.x + ex * cos - ey * sin;
    const sy = p.y + ex * sin + ey * cos;
    // where the lens actually shows that point
    const [wx, wy] = unwarp(sx, sy, energy);
    // p-space is y-UP (it comes from gl_FragCoord); SVG is y-DOWN
    pts.push(`${n(mid + wx * scale)},${n(mid - wy * scale)}`);
  }
  const [r, g, b] = shadeColor(hexToRgb(colours[i]), energy, vibrance);
  const hex =
    "#" +
    [r, g, b]
      .map((v) =>
        Math.round(v * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");
  shapes.push(`  <path d="M${pts.join("L")}Z" fill="${hex}"/>`);
}

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"`,
  `     viewBox="0 0 ${size} ${size}">`,
  `  <title>Latent Write — intelligence orb</title>`,
  bg ? `  <rect width="${size}" height="${size}" fill="${bg}"/>` : "",
  ...shapes,
  `</svg>`,
]
  .filter(Boolean)
  .join("\n");

writeFileSync(out, svg + "\n");
console.log(
  `wrote ${out} — ${size}px, seed ${seed}, energy ${energy}, t=${time}s, ` +
    `mark fills ${(fit * 100).toFixed(0)}%`,
);
for (let i = 0; i < PETAL_COUNT; i++) {
  const p = world.petals[i];
  console.log(
    `  ${i}  ${colours[i]}  ${(p.a / p.b).toFixed(2)}:1  ` +
      `len ${(p.a * 2).toFixed(3)}  @ ${((Math.atan2(p.y, p.x) * 180) / Math.PI).toFixed(0)}°`,
  );
}
