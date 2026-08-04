/**
 * probe-glass-fidelity.cjs — SANDBOX. Is the reconstruction WRONG, or merely
 * rasterised differently?
 *
 * probe-glass-lab.cjs reports MAE ~6/255 with a max of 222, which are the two
 * numbers a glyph-edge disagreement produces: tiny on average, enormous on the
 * handful of pixels where one rasteriser puts ink and the other does not. DOM
 * text and canvas `fillText` do not antialias identically, so that difference
 * is expected and says nothing about whether the reconstruction is CORRECT.
 *
 * Three things separate the two explanations, and none of them is looking at it:
 *
 *   1 · REGISTRATION. Shift the reconstruction by ±1px and re-measure. If the
 *       error is lowest at (0,0) the glyphs are where the browser put them; if
 *       some other shift wins, the painter has a systematic offset and the
 *       "looks fine" screenshot was hiding it.
 *
 *   2 · FLAT vs EDGE. Split the error by whether the ground truth has any local
 *       gradient there. Error on flat pixels is a real colour mistake. Error
 *       confined to edges is a rasteriser difference.
 *
 *   3 · AFTER THE BLUR THE GLASS ACTUALLY APPLIES. The surface blurs its
 *       backdrop by 3px before anyone sees it, so a one-pixel glyph-edge
 *       disagreement is not a thing the eye can reach. Measuring before the
 *       blur measures a stage of the pipeline that is never displayed.
 *
 *   electron scripts/probe-glass-fidelity.cjs
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.VITE_URL || "http://localhost:5173";
const OUT = path.join(__dirname, "..", ".glass-shots", "lab");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch("force-device-scale-factor", "2");

/** Runs IN THE PAGE: compare a captured screenshot against the reconstruction. */
const ANALYSE = (dataUrl, preset, blurPx) => `(async () => {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const r = window.__lab.rect();
  const W = Math.round(r.w * dpr), H = Math.round(r.h * dpr);

  // Ground truth: the screenshot of the real page, at device resolution.
  const img = new Image();
  img.src = ${JSON.stringify(dataUrl)};
  await img.decode();

  const mk = () => { const c = document.createElement("canvas"); c.width = W; c.height = H; return c; };
  const blurOf = (draw) => {
    const c = mk(); const x = c.getContext("2d", { willReadFrequently: true });
    if (${blurPx} > 0) x.filter = "blur(" + (${blurPx} * dpr) + "px)";
    draw(x);
    return x.getImageData(0, 0, W, H).data;
  };

  const truth = blurOf((x) => x.drawImage(img, 0, 0, W, H));

  // The reconstruction, through the same blur.
  window.__lab.setMode("recon", ${JSON.stringify(preset)}, 0);
  const recon = document.getElementById("target-recon");
  const got = blurOf((x) => x.drawImage(recon, 0, 0, W, H));

  const stat = (a, b, dx, dy) => {
    let sum = 0, max = 0, n = 0, over8 = 0, over32 = 0;
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        const i = (y * W + x) * 4;
        const j = ((y + dy) * W + (x + dx)) * 4;
        const d = Math.max(Math.abs(a[i] - b[j]), Math.abs(a[i+1] - b[j+1]), Math.abs(a[i+2] - b[j+2]));
        sum += d; n++;
        if (d > max) max = d;
        if (d > 8) over8++;
        if (d > 32) over32++;
      }
    }
    return { mae: sum / n, max, pctOver8: 100 * over8 / n, pctOver32: 100 * over32 / n };
  };

  // 1 · Registration: does any shift beat no shift?
  const shifts = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    shifts.push({ dx, dy, mae: stat(truth, got, dx, dy).mae });
  }

  // 2 · Flat vs edge, judged on the GROUND TRUTH's local gradient.
  let flatSum = 0, flatN = 0, flatMax = 0, edgeSum = 0, edgeN = 0, edgeMax = 0;
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const i = (y * W + x) * 4;
      const gx = Math.abs(truth[i + 4] - truth[i - 4]);
      const gy = Math.abs(truth[i + W * 4] - truth[i - W * 4]);
      const d = Math.max(
        Math.abs(truth[i] - got[i]), Math.abs(truth[i+1] - got[i+1]), Math.abs(truth[i+2] - got[i+2]));
      if (Math.max(gx, gy) < 6) { flatSum += d; flatN++; if (d > flatMax) flatMax = d; }
      else { edgeSum += d; edgeN++; if (d > edgeMax) edgeMax = d; }
    }
  }

  const overall = stat(truth, got, 0, 0);
  return {
    overall, shifts,
    flat: { mae: flatN ? flatSum / flatN : 0, max: flatMax, pct: 100 * flatN / (flatN + edgeN) },
    edge: { mae: edgeN ? edgeSum / edgeN : 0, max: edgeMax, pct: 100 * edgeN / (flatN + edgeN) },
  };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 900, show: false });
  await win.loadURL(`${BASE}/glass-lab.html`);
  for (let i = 0; i < 60; i++) {
    if (await win.webContents.executeJavaScript("window.__labReady === true").catch(() => false)) break;
    await wait(100);
  }
  await wait(500);
  fs.mkdirSync(OUT, { recursive: true });

  const presets = ["tab", "pill", "toolbar", "popover", "panel", "gradonly", "proseonly"];
  for (const blurPx of [0, 3]) {
    console.log(`\n━━ RECONSTRUCTION ERROR ${blurPx === 0 ? "RAW" : "AFTER THE GLASS'S OWN " + blurPx + "px BLUR"} ━━`);
    console.log("surface     MAE   max    >8     >32     FLAT mae/max      EDGE mae/max     best shift");
    for (const p of presets) {
      const info = await win.webContents.executeJavaScript(
        `window.__lab.setMode("backdrop", ${JSON.stringify(p)}, 0)`);
      const r = info.rect;
      await wait(150);
      const img = await win.capturePage({
        x: Math.round(r.x), y: Math.round(r.y),
        width: Math.round(r.w), height: Math.round(r.h),
      });
      const res = await win.webContents.executeJavaScript(ANALYSE(img.toDataURL(), p, blurPx));
      const best = res.shifts.reduce((a, b) => (a.mae < b.mae ? a : b));
      const zero = res.shifts.find((s) => s.dx === 0 && s.dy === 0);
      console.log(
        `${p.padEnd(11)} ${res.overall.mae.toFixed(2).padStart(5)} ${String(res.overall.max).padStart(4)} ` +
        `${res.overall.pctOver8.toFixed(1).padStart(5)}% ${res.overall.pctOver32.toFixed(1).padStart(6)}%  ` +
        `${res.flat.mae.toFixed(2).padStart(6)}/${String(res.flat.max).padStart(3)} (${res.flat.pct.toFixed(0)}% of px)  ` +
        `${res.edge.mae.toFixed(2).padStart(5)}/${String(res.edge.max).padStart(3)}  ` +
        `(${best.dx},${best.dy}) ${best.mae.toFixed(2)} vs ${zero.mae.toFixed(2)} at (0,0)` +
        `${best.mae < zero.mae * 0.98 ? " ★ MISREGISTERED" : ""}`);
    }
  }
  console.log("\nFLAT = pixels where the ground truth has no local gradient — a real colour error.");
  console.log("EDGE = pixels on a glyph or fill boundary — where two rasterisers legitimately differ.");
  app.exit(0);
});
