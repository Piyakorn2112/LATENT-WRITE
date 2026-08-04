/**
 * probe-glass-lean-profile.cjs — the WHOLE dx(y) profile, row by row.
 *
 * glass-shear.cjs reports a mean over the top rows and a mean over the bottom
 * rows. On a rounded-rect refraction dx is genuinely ZERO at the very top and
 * bottom edges — the normal there is vertical — so those are the two places the
 * lean cannot show, and the harness reported 0.000 while the render was
 * visibly bent. This prints every row instead.
 *
 * Method is the same phase-of-the-first-harmonic trick: a 16px vertical
 * grating carries all its energy in one harmonic, so the phase along a row IS
 * the horizontal position of the pattern, recoverable far below a pixel and
 * immune to blur and brightness.
 *
 *   npm run dev
 *   electron scripts/probe-glass-lean-profile.cjs
 */
const { app, BrowserWindow } = require("electron");

const URL_ = process.env.SHEAR_URL || "http://localhost:5173/glass-shear.html";
const PAGE_W = 1200;
const PERIOD_CSS = 16;
let SCALE = 1;
let PERIOD = PERIOD_CSS;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("force-color-profile", "srgb");
app.commandLine.appendSwitch("disable-lcd-text");

function rowPhase(bmp, width, y, x0, x1) {
  let re = 0, im = 0;
  for (let x = x0; x < x1; x++) {
    const i = (y * width + x) * 4;
    const v = (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3;
    const a = (2 * Math.PI * x) / PERIOD;
    re += v * Math.cos(a);
    im += v * Math.sin(a);
  }
  return Math.atan2(im, re);
}

function wrap(d) {
  while (d > PERIOD / 2) d -= PERIOD;
  while (d < -PERIOD / 2) d += PERIOD;
  return d;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200, height: 900, show: false, useContentSize: true,
    backgroundColor: "#ffffff",
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  await win.loadURL(URL_);
  const info = await win.webContents.executeJavaScript(`
    new Promise((res) => { const t0 = Date.now(); const iv = setInterval(() => {
      if (window.__glassReady || Date.now() - t0 > 30000) { clearInterval(iv);
        res({ specs: window.__specs }); } }, 100); })`);

  const img = await win.webContents.capturePage();
  const size = img.getSize();
  const bmp = img.toBitmap();
  SCALE = size.width / PAGE_W;
  PERIOD = PERIOD_CSS * SCALE;

  for (const s of info.specs) {
    const sx = s.x * SCALE, sy = s.y * SCALE, sw = s.w * SCALE, sh = s.h * SCALE;
    const inset = Math.round(sw * 0.2);
    const x0 = Math.round(sx + inset);
    const x1 = x0 + Math.floor((Math.round(sx + sw - inset) - x0) / PERIOD) * PERIOD;
    const ref = rowPhase(bmp, size.width, Math.max(2, Math.round(sy - 40 * SCALE)), x0, x1);

    console.log(`\n── ${s.label}`);
    const prof = [];
    for (let d = 0; d < sh; d++) {
      const y = Math.round(sy) + d;
      if (y < 0 || y >= size.height) continue;
      const dx = wrap((rowPhase(bmp, size.width, y, x0, x1) - ref) * PERIOD / (2 * Math.PI)) / SCALE;
      prof.push({ yCss: d / SCALE, dx });
    }
    const step = Math.max(1, Math.round(prof.length / 24));
    let line = "";
    let printed = 0;
    for (let i = 0; i < prof.length; i += step) {
      line += `${prof[i].yCss.toFixed(0).padStart(4)}:${prof[i].dx >= 0 ? "+" : ""}${prof[i].dx.toFixed(2)}  `;
      if (++printed % 6 === 0) { console.log("   " + line); line = ""; }
    }
    if (line) console.log("   " + line);

    // ★ THE NUMBER THAT MATTERS: the ODD part of dx about the vertical centre.
    //   A correct field is EVEN in y, so the odd part IS the lean.
    let maxOdd = 0, atY = 0, maxAbs = 0;
    for (let i = 0; i < prof.length; i++) {
      const j = prof.length - 1 - i;
      if (j <= i) break;
      const odd = (prof[i].dx - prof[j].dx) / 2;
      if (Math.abs(odd) > Math.abs(maxOdd)) { maxOdd = odd; atY = prof[i].yCss; }
      maxAbs = Math.max(maxAbs, Math.abs(prof[i].dx), Math.abs(prof[j].dx));
    }
    console.log(`   peak |dx| ${maxAbs.toFixed(3)} px   ★ LEAN (odd part) ` +
      `${maxOdd >= 0 ? "+" : ""}${maxOdd.toFixed(3)} px at y=${atY.toFixed(0)}`);
  }
  win.destroy();
  app.exit(0);
});
