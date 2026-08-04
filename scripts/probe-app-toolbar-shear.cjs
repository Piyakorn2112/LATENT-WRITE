/**
 * probe-app-toolbar-shear.cjs — dx(y) on the REAL app toolbar.
 *
 * The synthetic harness (glass-shear.html) reports the toolbar's horizontal
 * displacement as 0.00 on every row. The app disagrees visibly: each reflected
 * fold band is sheared, leaning one way at the top rim and the other at the
 * bottom, growing toward the edge. A displacement map cannot shear content
 * unless dx is non-zero, so either dx IS non-zero in the app, or the harness is
 * not reproducing whatever the app does.
 *
 * This settles it by measuring the app itself: a vertical grating is injected
 * directly behind the real toolbar, and the phase of its first harmonic is read
 * per row. Phase IS horizontal position, recoverable far below a pixel and
 * immune to blur, saturation and brightness — which matters here because the
 * toolbar's backdrop is blurred and saturated before anyone sees it.
 *
 *   npm run dev
 *   electron scripts/probe-app-toolbar-shear.cjs
 */
const { app, BrowserWindow } = require("electron");

const BASE = process.env.GLASS_PROBE_URL || "http://localhost:5173/";
const PERIOD_CSS = 16;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("force-color-profile", "srgb");
app.commandLine.appendSwitch("disable-lcd-text");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

/**
 * Put a hard vertical grating behind the toolbar and nothing else. Everything
 * that would otherwise blur or tint that region is switched off, so the only
 * thing between the grating and the camera is the glass itself.
 */
const INJECT = `(() => {
  const bar = document.querySelector(".toolbar.liquid-glass");
  if (!bar) return { ok: false, why: "no toolbar" };
  const r = bar.getBoundingClientRect();

  const kill = document.createElement("style");
  kill.textContent = [
    // The scroll-edge strips stack their own backdrop-filters over exactly this
    // band; they would blur the grating before the toolbar ever sees it.
    ".scroll-edge-top,.scroll-edge-top-strip,.scroll-edge-top-overlay{display:none!important}",
    ".lqg-edge-color,.lqg-edge-rim{display:none!important}",
    // The toolbar's own children would occlude the middle of the crop.
    ".toolbar.liquid-glass > *{visibility:hidden!important}",
    "*,*::before,*::after{animation:none!important;transition:none!important}",
  ].join("");
  document.head.appendChild(kill);

  const g = document.createElement("div");
  g.id = "__grating";
  g.style.cssText = [
    "position:fixed",
    "left:" + (r.left - 60) + "px",
    "top:" + (r.top - 60) + "px",
    "width:" + (r.width + 120) + "px",
    "height:" + (r.height + 120) + "px",
    "z-index:1",
    "pointer-events:none",
    "background:repeating-linear-gradient(90deg,#000 0 ${PERIOD_CSS / 2}px,#fff ${PERIOD_CSS / 2}px ${PERIOD_CSS}px)",
  ].join(";");
  // Directly before the toolbar in its own parent, so it is behind the glass
  // and in front of everything else.
  bar.parentNode.insertBefore(g, bar);
  return { ok: true, bar: { x: r.left, y: r.top, w: r.width, h: r.height } };
})()`;

function rowPhase(bmp, width, y, x0, x1, period) {
  let re = 0, im = 0;
  for (let x = x0; x < x1; x++) {
    const i = (y * width + x) * 4;
    const v = (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3;
    const a = (2 * Math.PI * x) / period;
    re += v * Math.cos(a);
    im += v * Math.sin(a);
  }
  return { phase: Math.atan2(im, re), power: Math.hypot(re, im) / (x1 - x0) };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1512, height: 950, show: true,
    webPreferences: { backgroundThrottling: false },
  });
  await win.loadURL(BASE);
  win.focus();
  await wait(9000);

  const inj = await win.webContents.executeJavaScript(INJECT);
  if (!inj.ok) { console.error("✗", inj.why); app.exit(2); return; }
  await wait(1200);

  // Confirm the glass is running the real filter, not the CSS fallback.
  const state = await win.webContents.executeJavaScript(`(() => {
    const cs = getComputedStyle(document.querySelector(".toolbar.liquid-glass"));
    return { usingSvgFilter: (cs.backdropFilter || "").includes("url("),
             backdrop: (cs.backdropFilter || "none").slice(0, 46) };
  })()`);
  if (!state.usingSvgFilter) {
    console.error(`✗ the toolbar is on the CSS fallback, not the SVG filter: ${state.backdrop}`);
    console.error("  Measuring here would describe a plain blur, not the refraction.");
    app.exit(2);
    return;
  }

  const img = await win.capturePage();
  const size = img.getSize();
  const bmp = img.toBitmap();
  const SCALE = size.width / 1512;
  const PERIOD = PERIOD_CSS * SCALE;
  const b = inj.bar;

  // Middle 50% of the bar's width, a whole number of periods.
  const sx = b.x * SCALE, sw = b.w * SCALE, sy = b.y * SCALE, sh = b.h * SCALE;
  const x0 = Math.round(sx + sw * 0.25);
  const x1 = x0 + Math.floor((Math.round(sx + sw * 0.75) - x0) / PERIOD) * PERIOD;
  // ★ REFERENCE BELOW THE BAR, NOT ABOVE. The toolbar sits 16px from the top of
  //   the window, so "30px above it" is a NEGATIVE row — the first version read
  //   off the end of the bitmap and reported NaN for every row, which printed as
  //   a clean "no shear". Untouched grating exists below the bar; use that.
  const refY = Math.round(sy + sh + 20 * SCALE);
  if (refY >= size.height) { console.error("✗ no reference row available"); app.exit(2); return; }
  const refRow = rowPhase(bmp, size.width, refY, x0, x1, PERIOD);
  if (!Number.isFinite(refRow.phase) || refRow.power < 1) {
    console.error(`✗ reference row ${refY} carries no grating (power ${refRow.power.toFixed(2)}) —`);
    console.error("  the injected pattern is not where this thinks it is.");
    app.exit(2); return;
  }
  const ref = refRow.phase;

  const wrap = (d) => {
    while (d > PERIOD / 2) d -= PERIOD;
    while (d < -PERIOD / 2) d += PERIOD;
    return d;
  };

  console.log(`\ntoolbar ${Math.round(b.w)}x${Math.round(b.h)} at (${Math.round(b.x)}, ${Math.round(b.y)})`);
  console.log(`captured ${size.width}x${size.height}, device scale ${SCALE}`);
  console.log(`filter: ${state.backdrop}\n`);
  console.log(" row   dx (CSS px)");

  const prof = [];
  for (let d = 0; d < sh; d++) {
    const y = Math.round(sy) + d;
    const p = rowPhase(bmp, size.width, y, x0, x1, PERIOD);
    const dx = wrap(((p.phase - ref) * PERIOD) / (2 * Math.PI)) / SCALE;
    prof.push({ y: d / SCALE, dx, power: p.power });
  }
  const step = Math.max(1, Math.round(prof.length / 23));
  for (let i = 0; i < prof.length; i += step) {
    const q = prof[i];
    const bar = "█".repeat(Math.min(30, Math.round(Math.abs(q.dx) * 12)));
    console.log(`${q.y.toFixed(0).padStart(4)}  ${(q.dx >= 0 ? "+" : "") + q.dx.toFixed(3)}`.padEnd(16) + bar);
  }

  // The shear is the ODD part of dx about the bar's vertical centre.
  let maxOdd = 0, atY = 0, peak = 0;
  for (let i = 0; i < prof.length; i++) {
    const j = prof.length - 1 - i;
    if (j <= i) break;
    const odd = (prof[i].dx - prof[j].dx) / 2;
    if (Math.abs(odd) > Math.abs(maxOdd)) { maxOdd = odd; atY = prof[i].y; }
    peak = Math.max(peak, Math.abs(prof[i].dx));
  }
  console.log(`\npeak |dx| ${peak.toFixed(3)} px`);
  console.log(`★ SHEAR (odd part of dx about the centre) ${maxOdd >= 0 ? "+" : ""}${maxOdd.toFixed(3)} px at y=${atY.toFixed(0)}`);
  console.log(maxOdd > 0.05 || maxOdd < -0.05
    ? "→ the app's toolbar DOES shear. The synthetic harness does not reproduce it."
    : "→ no shear here either; whatever produces it is not in this configuration.");
  app.exit(0);
});
