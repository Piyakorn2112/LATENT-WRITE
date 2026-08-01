/**
 * test-color-wheel.cjs — does the colour picker hand back the hue it PAINTS?
 *
 * The wheel is two independent halves that must share a zero angle:
 *
 *   painter — `conic-gradient(from 0deg, …)` in `.gcp-area-cloud`. CSS conic
 *             gradients start at TWELVE O'CLOCK and run clockwise.
 *   reader  — `pointToHue()` in GlassColorPicker.tsx, built on `Math.atan2`,
 *             which is zero at THREE O'CLOCK and (because screen y grows
 *             downward) also runs clockwise.
 *
 * Same direction, zero angles 90° apart. The reader used to return the raw
 * atan2 degrees, so clicking the red at the top of the wheel handed back hue
 * 270 — violet. Neither half is wrong on its own, which is why this has to be
 * measured across the two: render the real CSS, read the painted pixels, and
 * run the app's own mapping over the same coordinates.
 *
 * ★ NOTHING HERE IS COPIED. The stylesheet rules and the offset constant are
 *   both read out of src/ at run time. A harness holding its own copy of the
 *   thing under test keeps passing after the app changes.
 *
 * ★ TWO NUMBERS, NOT ONE. `median delta` is the rotation; `slope` is whether
 *   the two even sweep the same way (+1 yes, −1 mirrored). Spread alone cannot
 *   separate them — an sRGB conic gradient interpolates non-linearly between
 *   its 60°-spaced stops, so a PERFECT wheel still wobbles ~30° through the
 *   orange/yellow arc, and judging on spread reports that as a direction bug.
 *
 *   npx electron scripts/test-color-wheel.cjs
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const STYLES = path.join(ROOT, "src/styles.css");
const PICKER = path.join(ROOT, "src/components/GlassColorPicker.tsx");

const R_FRAC = 0.78;   // far enough out that the white centre has faded
const N = 24;
/** A pure rotation bigger than this is the bug; below it is gradient wobble. */
const MAX_ROTATION_DEG = 8;

/** Pull a rule body out of the real stylesheet. */
function rule(css, selector) {
  const i = css.indexOf(selector + " {");
  if (i < 0) throw new Error(`rule not found in styles.css: ${selector}`);
  const open = css.indexOf("{", i);
  return css.slice(open + 1, css.indexOf("}", open));
}

/**
 * The app's zero-angle offset, read from the component. Only this ONE number
 * is lifted out — the arithmetic around it is trivial and documented in both
 * places. If someone rewrites pointToHue's body rather than its constant, the
 * pixel comparison below still catches it; that is the real backstop.
 */
function readOffset() {
  const src = fs.readFileSync(PICKER, "utf8");
  const m = src.match(/WHEEL_ZERO_OFFSET_DEG\s*=\s*(-?[\d.]+)/);
  if (!m) throw new Error("WHEEL_ZERO_OFFSET_DEG not found in GlassColorPicker.tsx");
  return Number(m[1]);
}

function rgbHue(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 1e-6) return null;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}
const satOf = (r, g, b) => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
};
const angDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

app.whenReady().then(async () => {
  const css = fs.readFileSync(STYLES, "utf8");
  const OFFSET = readOffset();
  const pointToHue = (dx, dy) =>
    (((Math.atan2(dy, dx) * 180) / Math.PI + OFFSET) % 360 + 360) % 360;

  const html = `<!doctype html><meta charset="utf-8">
  <style>
    html,body{margin:0;background:#fff}
    #shell{position:relative;width:300px;height:300px}
    .gcp-area{${rule(css, ".gcp-area")}}
    .gcp-area-cloud{${rule(css, ".gcp-area-cloud")}}
  </style>
  <div id="shell"><div class="gcp-area"><div class="gcp-area-cloud"></div></div></div>`;

  const tmp = path.join(app.getPath("temp"), `wheel-${process.pid}.html`);
  fs.writeFileSync(tmp, html);

  const win = new BrowserWindow({ width: 400, height: 400, show: false });
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 700));

  const box = await win.webContents.executeJavaScript(`(() => {
    const r = document.querySelector(".gcp-area").getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);

  const img = await win.webContents.capturePage();
  const size = img.getSize();
  const bmp = img.toBitmap();               // BGRA, DEVICE pixels
  const scale = size.width / 400;           // window CSS width
  const rowBytes = size.width * 4;
  const pixAt = (x, y) => {
    const i = Math.round(y * scale) * rowBytes + Math.round(x * scale) * 4;
    return { b: bmp[i], g: bmp[i + 1], r: bmp[i + 2] };
  };

  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const radius = Math.min(box.w, box.h) / 2;

  console.log(`\ncolour wheel — live src/styles.css, WHEEL_ZERO_OFFSET_DEG=${OFFSET}\n`);
  console.log(`  ${"point".padEnd(9)} ${"reads".padStart(7)} ${"paints".padStart(8)} ${"delta".padStart(7)}   clock`);
  const CLOCK = { 0: "3 o'clock (E)", 6: "6 o'clock (S)", 12: "9 o'clock (W)", 18: "12 o'clock (N)" };

  const rows = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * 2 * Math.PI;
    const dx = Math.cos(t) * radius * R_FRAC;
    const dy = Math.sin(t) * radius * R_FRAC;
    const reads = pointToHue(dx, dy);
    const p = pixAt(cx + dx, cy + dy);
    const paints = rgbHue(p.r, p.g, p.b);
    if (paints === null || satOf(p.r, p.g, p.b) < 0.25) continue;
    const delta = angDiff(paints, reads);
    rows.push({ reads, paints, delta });
    console.log(`  ${`+${Math.round((t * 180) / Math.PI)}°`.padEnd(9)} ${reads.toFixed(0).padStart(7)} ` +
      `${paints.toFixed(0).padStart(8)} ${((delta >= 0 ? "+" : "") + delta.toFixed(0)).padStart(7)}   ${CLOCK[i] ?? ""}`);
  }
  if (rows.length < 8) { console.log("\n✗ too few usable samples"); app.exit(2); return; }

  // ★ SLOPE FROM CONSECUTIVE DIFFERENCES, NOT A REGRESSION ON RAW ANGLES.
  //   Both sequences are circular and BOTH wrap. A least-squares fit over raw
  //   values was fine while `reads` happened to run 0→345 monotonically, then
  //   reported slope −0.12 on a correctly-fixed wheel the moment the fix made
  //   `reads` wrap at 12 o'clock — the discontinuity, not the data. Differences
  //   taken through angDiff are wrap-proof on both sides.
  const steps = [];
  for (let i = 1; i < rows.length; i++) {
    const dRead = angDiff(rows[i].reads, rows[i - 1].reads);
    const dPaint = angDiff(rows[i].paints, rows[i - 1].paints);
    if (Math.abs(dRead) > 1e-6) steps.push(dPaint / dRead);
  }
  const slope = median(steps);
  const med = median(rows.map((r) => r.delta));

  console.log(`\n  median delta  ${med.toFixed(1)}°   ← rotation between the halves`);
  console.log(`  slope         ${slope.toFixed(2)}    ← painted hue per read degree (+1 = same sweep)`);

  if (Math.abs(slope - 1) >= 0.25) {
    console.log(`\n✗ FAIL — the wheel sweeps the WRONG WAY (slope ${slope.toFixed(2)}, want +1).`);
    app.exit(1);
  } else if (Math.abs(med) > MAX_ROTATION_DEG) {
    console.log(`\n✗ FAIL — the wheel is ROTATED by ${med.toFixed(0)}°.`);
    console.log(`  Clicking where it paints hue H hands back H ${med >= 0 ? "−" : "+"} ${Math.abs(med).toFixed(0)}.`);
    app.exit(1);
  } else {
    console.log(`\n✓ PASS — the picker returns the hue it paints (within ${Math.abs(med).toFixed(1)}°).`);
    app.exit(0);
  }
});
