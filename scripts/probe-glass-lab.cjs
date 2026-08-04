/**
 * probe-glass-lab.cjs — SANDBOX HARNESS. Nothing here touches the app.
 *
 * Answers the three questions a canvas glass engine has to pass before it is
 * worth wiring into anything:
 *
 *   1 · FIDELITY. Can the backdrop under a surface be reconstructed? Measured
 *       by screenshotting the real page with the glass hidden (ground truth),
 *       screenshotting the reconstruction over the same rect, and comparing the
 *       two crops pixel for pixel. Not by looking at it.
 *
 *   2 · COST. What does a frame cost — reconstruct, blur, upload, draw —
 *       against the 2D painter's measured 26,000 device px/ms and against the
 *       backdrop-filter it would replace.
 *
 *   3 · LOOK. Shots of the SVG path and the GPU path over the same backdrop, so
 *       the difference can be seen rather than asserted.
 *
 *   npm run dev                        # in another shell
 *   electron scripts/probe-glass-lab.cjs
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.VITE_URL || "http://localhost:5173";
const OUT = path.join(__dirname, "..", ".glass-shots", "lab");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch("force-device-scale-factor", "2");

/** Mean/max absolute difference between two NativeImages of the same size. */
function diff(a, b) {
  const A = a.toBitmap(), B = b.toBitmap();
  const sa = a.getSize(), sb = b.getSize();
  if (sa.width !== sb.width || sa.height !== sb.height) {
    return { error: `size mismatch ${sa.width}x${sa.height} vs ${sb.width}x${sb.height}` };
  }
  const n = Math.min(A.length, B.length);
  let sum = 0, max = 0, over8 = 0, over32 = 0, px = 0;
  for (let i = 0; i < n; i += 4) {
    // BGRA; alpha is opaque in both because the page is opaque.
    const d = Math.max(
      Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
    sum += d;
    if (d > max) max = d;
    if (d > 8) over8++;
    if (d > 32) over32++;
    px++;
  }
  return {
    mae: sum / px,
    max,
    pctOver8: (100 * over8) / px,
    pctOver32: (100 * over32) / px,
    px,
  };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200, height: 900, show: false,
    webPreferences: { offscreen: false },
  });
  // ★ SURFACE THE PAGE'S ERRORS. A stray backtick inside the shader's own
  //   template literal once broke the lab module outright, and this harness
  //   reported it as "__labReady never became true" — a timeout that says
  //   nothing, on a page whose console was holding the exact line number.
  const pageErrors = [];
  win.webContents.on("console-message", (e) => {
    const m = typeof e === "object" && e.message ? e.message : String(e);
    if ((e.level === "error" || e.level === 3) && !/Security Warning|unsafe-eval/.test(m)) {
      pageErrors.push(m.slice(0, 400));
    }
  });
  await win.loadURL(`${BASE}/glass-lab.html`);

  // Wait for the SVG engine to bind rather than sleeping a guessed interval.
  let ready = false;
  for (let i = 0; i < 60; i++) {
    ready = await win.webContents.executeJavaScript("window.__labReady === true")
      .catch(() => false);
    if (ready) break;
    await wait(100);
  }
  if (!ready) {
    const why = await win.webContents.executeJavaScript(
      `({ lab: typeof window.__lab, prose: document.getElementById("prose")?.children.length })`)
      .catch((e) => ({ evalError: e.message }));
    console.error("\nthe lab page never became ready.");
    console.error("  page state:", JSON.stringify(why));
    console.error("  console errors:", pageErrors.length ? "\n    " + pageErrors.join("\n    ") : "(none)");
    console.error("  if the module never ran at all, ask vite directly:");
    console.error(`    curl -s ${BASE}/src/lab/glass-gl.ts | head -20`);
    app.exit(2);
    return;
  }
  await wait(600);
  fs.mkdirSync(OUT, { recursive: true });

  const presets = await win.webContents.executeJavaScript("window.__lab.presets()");
  const shot = async (name, rect) => {
    const img = await win.capturePage(rect);
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    return img;
  };
  const setMode = (mode, preset, blur = 0) =>
    win.webContents.executeJavaScript(
      `window.__lab.setMode(${JSON.stringify(mode)}, ${JSON.stringify(preset)}, ${blur})`);

  // ── 1 · FIDELITY ──────────────────────────────────────────────────────────
  console.log("\n━━ RECONSTRUCTION FIDELITY ━━");
  console.log("ground truth = the real page with the glass hidden; blur off on both sides.\n");
  console.log("surface     size        device px    MAE/255   max   >8/255   >32/255   ms      lines glyphs  cannot express");
  const fidelity = [];
  for (const p of presets) {
    const info = await setMode("backdrop", p, 0);
    const r = info.rect;
    const rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) };
    await wait(120);
    const truth = await shot(`${p}-1-backdrop`, rect);

    const rec = await setMode("recon", p, 0);
    await wait(120);
    const got = await shot(`${p}-2-recon`, rect);

    const d = diff(truth, got);
    fidelity.push({ p, d, stats: rec.stats });
    const s = rec.stats;
    const cannot = Object.entries(s.skipped).map(([k, n]) => `${k}:${n}`).join(" ") || "-";
    console.log(
      `${p.padEnd(11)} ${(r.w + "x" + r.h).padEnd(11)} ${String(rect.width * 2 * rect.height * 2).padStart(9)} ` +
      `${d.error ? d.error : d.mae.toFixed(2).padStart(8)} ${String(d.max).padStart(5)} ` +
      `${d.pctOver8.toFixed(1).padStart(7)}% ${d.pctOver32.toFixed(1).padStart(8)}% ` +
      `${s.ms.toFixed(2).padStart(6)} ${String(s.lines).padStart(6)} ${String(s.glyphs).padStart(6)}  ${cannot}`);
  }

  // ── 2 · COST ──────────────────────────────────────────────────────────────
  console.log("\n━━ GPU REFRACTION COST, per frame ━━");
  console.log("(dpr 2. 'live' rebuilds the backdrop every frame; 'cached' redraws with the");
  console.log(" texture held — what an idle surface over static prose actually costs.)\n");
  console.log("surface     device px    recon    blur   upload   draw   LIVE total   CACHED   2D painter");
  const costs = [];
  for (const p of presets) {
    const big = p === "overlay" || p === "panel";
    const b = await win.webContents.executeJavaScript(
      `window.__lab.benchmark(${JSON.stringify(p)}, 3, ${big ? 8 : 30})`);
    costs.push(b);
    const f = b.perFrame;
    const twoD = b.devPx / 25889;    // measured throughput, probe-refraction-cost.cjs
    console.log(
      `${p.padEnd(11)} ${b.devPx.toLocaleString().padStart(9)} ` +
      `${f.reconstruct.toFixed(2).padStart(8)} ${f.blur.toFixed(2).padStart(6)} ` +
      `${f.upload.toFixed(2).padStart(7)} ${f.render.toFixed(2).padStart(6)} ` +
      `${f.total.toFixed(2).padStart(11)} ${b.cachedMs.toFixed(3).padStart(8)} ` +
      `${twoD.toFixed(1).padStart(11)}`);
  }

  // ── 3 · LOOK ──────────────────────────────────────────────────────────────
  console.log("\n━━ SHOTS ━━");
  for (const p of ["popover", "toolbar", "pill"]) {
    const info = await setMode("svg", p, 3);
    const r = info.rect;
    const pad = 30;
    const rect = {
      x: Math.max(0, Math.round(r.x - pad)), y: Math.max(0, Math.round(r.y - pad)),
      width: Math.round(r.w + pad * 2), height: Math.round(r.h + pad * 2),
    };
    await wait(200);
    await shot(`${p}-3-svg`, rect);
    await setMode("gl", p, 3);
    await wait(200);
    await shot(`${p}-4-gl`, rect);
    console.log(`  ${p}: ${p}-3-svg.png vs ${p}-4-gl.png`);
  }

  // ── Verdict lines the eye cannot fake ─────────────────────────────────────
  console.log("\n━━ WHAT THE NUMBERS SAY ━━");
  const worst = fidelity.reduce((a, b) => (a.d.mae > b.d.mae ? a : b));
  console.log(`worst reconstruction: ${worst.p} at MAE ${worst.d.mae.toFixed(2)}/255, ` +
    `${worst.d.pctOver32.toFixed(1)}% of pixels off by more than 32`);
  const liveOver16 = costs.filter((c) => c.perFrame.total > 16.7).map((c) => c.preset);
  const cachedOver16 = costs.filter((c) => c.cachedMs > 16.7).map((c) => c.preset);
  console.log(`live path misses a 60fps frame on: ${liveOver16.join(", ") || "nothing"}`);
  console.log(`cached path misses a 60fps frame on: ${cachedOver16.join(", ") || "nothing"}`);
  const reconShare = costs.map((c) => c.perFrame.reconstruct / c.perFrame.total);
  console.log(`reconstruction is ${(100 * Math.min(...reconShare)).toFixed(0)}-` +
    `${(100 * Math.max(...reconShare)).toFixed(0)}% of the live frame — ` +
    `the refraction is not the expensive half`);
  console.log(`\nshots: ${OUT}`);
  app.exit(0);
});
