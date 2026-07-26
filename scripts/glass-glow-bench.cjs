/**
 * Real-GPU benchmark driver for the edge-colour glow.
 *
 * Opens /glass-glow-bench.html in a visible, hardware-accelerated window with
 * vsync off, so achieved frame rate is GPU-bound. Software compositing is
 * refused — those numbers would describe the CPU rasteriser instead.
 *
 *   npm run dev                       # in another shell
 *   node scripts/glass-glow-bench.cjs                 # default config sweep
 *   node scripts/glass-glow-bench.cjs "softness=14&scale=0.35"   # ad-hoc config
 */

const { app, BrowserWindow } = require("electron");

const BASE = process.env.GLOW_BENCH_URL || "http://localhost:5173/glass-glow-bench.html";

app.commandLine.appendSwitch("disable-gpu-vsync");
app.commandLine.appendSwitch("disable-frame-rate-limit");
app.commandLine.appendSwitch("force-device-scale-factor", "1");

// Each entry: [label, query string]. "glow=off" is the floor — identical DOM
// and motion with no glow at all.
const extra = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const CONFIGS = extra.length
  ? [["floor (no glow)", "glow=off"], ...extra.map((q) => [q, q])]
  : [
      ["floor (no glow)", "glow=off"],
      ["shipped defaults", ""],
    ];

async function measure(win, query) {
  await win.loadURL(`${BASE}?${query}`);
  return await win.webContents.executeJavaScript(`
    new Promise((res) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (window.__benchDone || Date.now() - t0 > 60000) {
          clearInterval(iv);
          res({
            fps: window.__benchFps, ok: !!window.__benchDone,
            surfaces: window.__benchSurfaces,
            overlays: window.__benchOverlays, rims: window.__benchRims,
          });
        }
      }, 200);
    })
  `);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: true, useContentSize: true,
    backgroundColor: "#0e0e10", webPreferences: { backgroundThrottling: false },
  });

  await win.loadURL("data:text/html,<html><body></body></html>");
  const gpu = app.getGPUFeatureStatus();
  const renderer = await win.webContents.executeJavaScript(`(() => {
    const g = document.createElement("canvas").getContext("webgl");
    if (!g) return "none";
    const d = g.getExtension("WEBGL_debug_renderer_info");
    return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
  })()`);
  console.log(`GPU compositing: ${gpu.gpu_compositing}\nrenderer: ${renderer}\n`);
  if (String(gpu.gpu_compositing).includes("software")) {
    console.log("⚠ software compositing — these numbers would not reflect real GPU cost");
    win.destroy(); app.exit(2); return;
  }

  let floorMs = null;
  console.log("config                              overlays    fps     ms/frame   glow cost   vs shipped");
  console.log("─".repeat(96));
  const rows = [];
  for (const [label, query] of CONFIGS) {
    const r = await measure(win, query);
    if (!r.ok) { console.log(`${label.padEnd(34)} ⚠ timed out (dev server running?)`); continue; }
    const ms = 1000 / r.fps;
    if (floorMs === null) floorMs = ms;
    const cost = ms - floorMs;
    rows.push({ label, cost, ms, fps: r.fps });
    const shipped = rows.find((x) => x.label === "shipped defaults");
    const vs = shipped && shipped.cost > 0 && label !== "floor (no glow)"
      ? `${((1 - cost / shipped.cost) * 100).toFixed(0)}% less`
      : "";
    console.log(
      `${label.slice(0, 34).padEnd(34)} ${String(r.overlays ?? 0).padStart(4)}+${String(r.rims ?? 0).padEnd(4)} ` +
      `${r.fps.toFixed(0).padStart(6)} ${ms.toFixed(2).padStart(9)}ms ${cost.toFixed(2).padStart(9)}ms   ${vs}`,
    );
  }
  console.log("─".repeat(96));
  console.log("'glow cost' = ms/frame above the no-glow floor, on identical DOM + motion");
  win.destroy();
  app.exit(0);
});
