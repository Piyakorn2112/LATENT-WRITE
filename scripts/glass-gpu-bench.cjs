/**
 * Real-GPU benchmark driver for the liquid-glass engine.
 *
 * Opens /glass-gpu-bench.html in a VISIBLE, hardware-accelerated window with
 * vsync and the frame-rate cap disabled, so achieved frame rate is GPU-bound
 * and therefore prices the filter chain. A headless/SwiftShader run cannot
 * measure this — it would report software raster times instead.
 *
 *   npm run dev                     # in another shell
 *   node scripts/glass-gpu-bench.cjs [scene ...]
 *
 * Each scene is measured twice: with glass, and with the identical DOM but no
 * backdrop-filter. The delta is the glass cost.
 */

const { app, BrowserWindow } = require("electron");

const BASE = process.env.GLASS_BENCH_URL || "http://localhost:5173/glass-gpu-bench.html";
const scenes = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const SCENES = scenes.length ? scenes : ["idle", "working", "settings", "all"];

// Unlock the frame rate so the GPU, not the display, sets the pace.
app.commandLine.appendSwitch("disable-gpu-vsync");
app.commandLine.appendSwitch("disable-frame-rate-limit");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
// Do NOT disable hardware acceleration here — the whole point is the real GPU.

async function measure(win, scene, glassOff) {
  const url = `${BASE}?scene=${encodeURIComponent(scene)}${glassOff ? "&glass=off" : ""}`;
  await win.loadURL(url);
  return await win.webContents.executeJavaScript(`
    new Promise((res) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (window.__benchDone || Date.now() - t0 > 45000) {
          clearInterval(iv);
          res({ fps: window.__benchFps, n: window.__benchCount, ok: !!window.__benchDone });
        }
      }, 200);
    })
  `);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: true,
    useContentSize: true,
    backgroundColor: "#101014",
    webPreferences: { backgroundThrottling: false },
  });

  // Load something first: getGPUFeatureStatus() reports the pre-initialisation
  // software defaults until the GPU process has actually come up, which reads
  // as "software compositing" on a perfectly healthy GPU.
  await win.loadURL("data:text/html,<html><body></body></html>");
  const gpu = app.getGPUFeatureStatus();
  const renderer = await win.webContents.executeJavaScript(`(() => {
    const g = document.createElement("canvas").getContext("webgl");
    if (!g) return "none";
    const d = g.getExtension("WEBGL_debug_renderer_info");
    return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
  })()`);
  console.log(`GPU compositing: ${gpu.gpu_compositing}, canvas: ${gpu["2d_canvas"]}`);
  console.log(`renderer: ${renderer}`);
  if (String(gpu.gpu_compositing).includes("software")) {
    console.log("⚠ software compositing — numbers below do NOT reflect real GPU cost");
    win.destroy();
    app.exit(2);
    return;
  }
  console.log("");
  console.log("scene            surfaces   glass off      glass on     GPU cost of glass");
  console.log("─".repeat(80));

  const rows = [];
  for (const scene of SCENES) {
    const off = await measure(win, scene, true);
    const on = await measure(win, scene, false);
    if (!off.ok || !on.ok) {
      console.log(`${scene.padEnd(16)} ⚠ timed out (dev server running?)`);
      continue;
    }
    // Per-frame cost attributable to the glass, in ms.
    const msOff = 1000 / off.fps;
    const msOn = 1000 / on.fps;
    const cost = msOn - msOff;
    rows.push({ scene, n: on.n, msOff, msOn, cost });
    console.log(
      `${scene.padEnd(16)} ${String(on.n).padStart(5)}   ` +
      `${off.fps.toFixed(0).padStart(6)} fps      ${on.fps.toFixed(0).padStart(6)} fps    ` +
      `${cost.toFixed(2).padStart(7)} ms/frame  (${(msOn / msOff).toFixed(2)}x frame time)`,
    );
  }
  console.log("─".repeat(80));
  console.log("(higher fps = cheaper; 'GPU cost of glass' is the added ms per frame)");
  win.destroy();
  app.exit(0);
});
