/**
 * probe-refraction-cost.cjs — what per-pixel float refraction COSTS at scale.
 *
 * The knob painter (knob-glass-paint.ts) evaluates the refraction per pixel in
 * JS on a 2D canvas, and it is fast enough because a knob is 32x24. The
 * question this probe answers is whether that method survives being pointed at
 * a real surface: the app's toolbar is 920x46, and a settings panel or the
 * timeline overlay is far bigger again.
 *
 * It times the SHIPPING painter — imported from the dev server, not
 * reimplemented — at the knob's size and at the app's real surface sizes, and
 * reports throughput in device px/ms so the number extrapolates.
 *
 *   npm run dev                            # in another shell
 *   electron scripts/probe-refraction-cost.cjs
 */
const { app, BrowserWindow } = require("electron");
const URL_ = process.env.GLASS_PROBE_URL || "http://localhost:5173/";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch("force-device-scale-factor", "2");

const PROBE = `(async () => {
  const { paintKnobGlass } = await import("/src/lib/knob-glass-paint.ts");
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);

  // The sizes that matter, in CSS px, at dpr 2 (a retina Mac).
  const CASES = [
    ["range knob",        20,  14],
    ["toggle knob",       32,  24],
    ["knob at 2x press",  64,  48],
    ["analysis tab",      26,  73],
    ["status pill",      180,  34],
    ["toolbar",          920,  46],
    ["find/replace",     420, 120],
    ["settings panel",   420, 620],
    ["timeline overlay",1400, 860],
  ];
  const rows = [];
  for (const [label, w, h] of CASES) {
    const scene = {
      w, h, dpr: 2,
      base: "rgb(240,240,242)",
      layers: [{ x: 2, y: 2, w: w - 4, h: h - 4, r: 8, color: "rgba(90,120,250,0.9)" }],
      fill: "rgba(255,255,255,0.18)",
    };
    paintKnobGlass(canvas, scene);              // warm
    paintKnobGlass(canvas, scene);
    const N = w * h > 200000 ? 3 : w * h > 20000 ? 10 : 60;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) paintKnobGlass(canvas, scene);
    const ms = (performance.now() - t0) / N;
    const devPx = w * 2 * h * 2;
    rows.push({ label, w, h, devPx, ms, pxPerMs: devPx / ms });
  }
  return rows;
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false });
  await win.loadURL(URL_);
  await wait(5000);
  let rows;
  try {
    rows = await win.webContents.executeJavaScript(PROBE);
  } catch (e) {
    console.error("probe failed:", e && e.message);
    app.exit(2);
    return;
  }

  console.log("\nPER-PIXEL FLOAT REFRACTION, 2D canvas, the shipping knob painter");
  console.log("(dpr 2; a 60fps frame is 16.7ms and the glass is not the only thing in it)\n");
  console.log("surface              css        device px      ms/frame   px/ms     fps if alone");
  for (const r of rows) {
    const fps = 1000 / r.ms;
    console.log(
      `${r.label.padEnd(20)} ${(r.w + "x" + r.h).padEnd(10)} ${r.devPx.toLocaleString().padStart(10)} ` +
      `${r.ms.toFixed(2).padStart(11)} ${Math.round(r.pxPerMs).toLocaleString().padStart(9)} ` +
      `${(fps > 999 ? ">999" : fps.toFixed(0)).padStart(10)}`);
  }
  const med = rows.map((r) => r.pxPerMs).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  console.log(`\nmedian throughput: ${Math.round(med).toLocaleString()} device px/ms`);
  console.log(`→ a 16.7ms frame buys ${Math.round(med * 16.7).toLocaleString()} device px of glass,`);
  console.log(`  i.e. about ${Math.round(Math.sqrt(med * 16.7))}x${Math.round(Math.sqrt(med * 16.7))} — and that is the WHOLE frame budget.`);
  app.exit(0);
});
