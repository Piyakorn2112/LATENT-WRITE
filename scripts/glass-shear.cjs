/**
 * Measures the HORIZONTAL displacement field dx(y) of the liquid-glass
 * refraction, sub-pixel, in real Chromium.
 *
 *   npm run dev                 # in another shell
 *   node scripts/glass-shear.cjs
 *
 * /glass-shear.html puts a 16px-period vertical grating behind each specimen.
 * A pure horizontal grating carries all its energy in the first harmonic, so
 * for any row of pixels the phase of that harmonic IS the horizontal position
 * of the pattern:
 *
 *   phase(y) = atan2( Σ I(x)·sin(2πx/P), Σ I(x)·cos(2πx/P) )
 *   dx(y)    = (phase(y) − phase_ref) · P / 2π      (wrapped to ±P/2)
 *
 * The reference is a row of untouched grating outside the glass. This recovers
 * displacements far below one pixel and is immune to blur, saturation and
 * brightness changes, which alter amplitude but not phase.
 *
 * WHAT TO LOOK FOR. On a correct rounded-rect refraction the surface normal on
 * the top and bottom edges is purely vertical, so dx must be ~0 there. If dx
 * is systematically negative near the top edge and positive near the bottom
 * (or vice versa) the field has a SHEAR / rotational component — "the content
 * leans left at the top and right at the bottom".
 *
 * Only the middle of each specimen is sampled (the end caps are excluded), so
 * the genuine diagonal refraction at the corners does not pollute the reading.
 */

const { app, BrowserWindow, nativeImage } = require("electron");

const URL_ = process.env.SHEAR_URL || "http://localhost:5173/glass-shear.html";
const PAGE_W = 1200;
const PERIOD_CSS = 16;
// ⚠ capturePage() returns DEVICE pixels. `force-device-scale-factor` is not
// honoured by the offscreen path here, so the bitmap comes back 2x on a retina
// machine. Every coordinate below — the specimen rects AND the grating period —
// must be scaled by the measured factor, or the analyser reads a region that
// is not the glass at all and happily reports zeros.
let SCALE = 1;
let PERIOD = PERIOD_CSS;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("force-color-profile", "srgb");
app.commandLine.appendSwitch("disable-lcd-text");

/**
 * Phase of the first harmonic along one scanline, in radians.
 * `dir` "v" (vertical grating) scans a ROW at fixed `fixed`, varying x → dx.
 * `dir` "h" (horizontal grating) scans a COLUMN at fixed `fixed`, varying y → dy.
 */
function scanPhase(bitmap, width, dir, fixed, a0, a1) {
  let re = 0;
  let im = 0;
  for (let s = a0; s < a1; s++) {
    const i = (dir === "v" ? fixed * width + s : s * width + fixed) * 4;
    // luminance is enough; the grating is pure black/white
    const v = (bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3;
    const ang = (2 * Math.PI * s) / PERIOD;
    re += v * Math.cos(ang);
    im += v * Math.sin(ang);
  }
  return { phase: Math.atan2(im, re), power: Math.hypot(re, im) / (a1 - a0) };
}

function wrap(dx) {
  while (dx > PERIOD / 2) dx -= PERIOD;
  while (dx < -PERIOD / 2) dx += PERIOD;
  return dx;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200, height: 900, show: false, useContentSize: true,
    backgroundColor: "#ffffff",
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });

  let failed = false;
  try {
    await win.loadURL(URL_);
    const ready = await win.webContents.executeJavaScript(`
      new Promise((res) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (window.__glassReady || Date.now() - t0 > 30000) {
            clearInterval(iv);
            res({ ready: !!window.__glassReady, bound: window.__glassBound, total: window.__glassTotal, specs: window.__specs, dir: window.__dir });
          }
        }, 100);
      })
    `);
    if (!ready.ready) {
      console.error("✗ page not ready — is the dev server up?");
      win.destroy();
      app.exit(2);
      return;
    }

    const img = await win.webContents.capturePage();
    const size = img.getSize();
    const bmp = img.getBitmap();

    SCALE = size.width / PAGE_W;
    PERIOD = PERIOD_CSS * SCALE;
    console.log(`captured ${size.width}x${size.height} (device scale ${SCALE}), ` +
                `${ready.bound}/${ready.total} specimens bound; dx reported in CSS px\n`);

    // "v" grating measures dx as a function of y (rows). "h" measures dy as a
    // function of x (columns). Naming below is in terms of the MEASURED
    // component (`comp`) against the SWEPT axis (`axis`).
    const dir = ready.dir === "h" ? "h" : "v";
    const comp = dir === "v" ? "dx" : "dy";
    const axis = dir === "v" ? "y" : "x";
    console.log(`grating ${dir === "v" ? "VERTICAL lines → measuring dx(y)" : "HORIZONTAL lines → measuring dy(x)"}\n`);

    for (const s of ready.specs) {
      const sx = s.x * SCALE, sy = s.y * SCALE;
      const sw = s.w * SCALE, sh = s.h * SCALE;
      // The scan runs ALONG the grating's varying axis; sweep runs across it.
      const scanLen = dir === "v" ? sw : sh;
      const scanOrigin = dir === "v" ? sx : sy;
      const sweepLen = dir === "v" ? sh : sw;
      const sweepOrigin = dir === "v" ? sy : sx;

      // sample the middle 60% of the scan axis: no end caps, and a whole number
      // of periods so the harmonic is clean
      const inset = Math.round(scanLen * 0.2);
      let a0 = Math.round(scanOrigin + inset);
      let a1 = Math.round(scanOrigin + scanLen - inset);
      a1 = a0 + Math.floor((a1 - a0) / PERIOD) * PERIOD;

      // reference: untouched grating well before the specimen on the sweep axis
      const refFixed = Math.max(2, Math.round(sweepOrigin - 40 * SCALE));
      const ref = scanPhase(bmp, size.width, dir, refFixed, a0, a1);

      console.log(`── ${s.label}   (scan ${a0}..${a1} device px)`);
      const rows = [];
      for (let d = 0; d < sweepLen; d++) {
        const fixed = Math.round(sweepOrigin) + d;
        if (fixed < 0 || fixed >= (dir === "v" ? size.height : size.width)) continue;
        const r = scanPhase(bmp, size.width, dir, fixed, a0, a1);
        rows.push({
          at: d / SCALE,
          v: wrap(((r.phase - ref.phase) * PERIOD) / (2 * Math.PI)) / SCALE,
        });
      }
      const fmt = (v) => (v >= 0 ? "+" : "") + v.toFixed(3);
      const show = (label, list) =>
        console.log(`   ${label.padEnd(12)} ${list.map((r) => `${axis}+${r.at.toFixed(0).padStart(3)}:${fmt(r.v)}`).join("  ")}`);
      show(dir === "v" ? "top" : "left", rows.slice(0, 6));
      show(dir === "v" ? "bottom" : "right", rows.slice(-6).reverse());

      // the shear signature: mean over the leading eighth vs the trailing eighth
      const band = Math.max(2, Math.round(rows.length / 8));
      const mean = (a) => a.reduce((t, r) => t + r.v, 0) / a.length;
      const lead = mean(rows.slice(0, band));
      const trail = mean(rows.slice(-band));
      // A correct rounded-rect field is ANTI-symmetric on the axis it displaces
      // (top pulls down, bottom pulls up) and ZERO on the other one.
      const antisym = dir === "h";
      const verdict = antisym
        ? (lead * trail < 0 && Math.abs(lead + trail) < 0.15 * Math.abs(lead - trail)
            ? "✓ anti-symmetric (correct inward pull)"
            : `✗ ASYMMETRIC  lead+trail = ${fmt(lead + trail)} px (should cancel)`)
        : (Math.abs(lead - trail) < 0.05
            ? "✓ symmetric (no shear)"
            : `✗ SHEAR  swing ${fmt(trail - lead)} px`);
      console.log(`   mean ${comp}  ${dir === "v" ? "top" : "left"} ${fmt(lead)} px   ` +
                  `${dir === "v" ? "bottom" : "right"} ${fmt(trail)} px   ${verdict}\n`);
    }
  } catch (err) {
    console.error("✗ harness error:", err);
    failed = true;
  }
  win.destroy();
  app.exit(failed ? 1 : 0);
});
