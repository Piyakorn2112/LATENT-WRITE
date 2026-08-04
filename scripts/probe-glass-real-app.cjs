/**
 * probe-glass-real-app.cjs — SANDBOX. The reconstruction, against the REAL APP.
 *
 * glass-lab.html is a backdrop I chose, and a reconstruction scoring MAE 0.2/255
 * against a backdrop its own author built is worth very little. This points the
 * same painter at the running editor, where the CSS is whatever the app already
 * does — shadows, transforms, SVG charts, the analysis panel's cards, the orb —
 * and reports both the error and, separately, every construct the painter cannot
 * express.
 *
 * ★ THE "CANNOT EXPRESS" COLUMN IS THE POINT. An error number alone would hide
 *   the real risk: a painter that silently omits a box-shadow scores well on a
 *   surface that has none and fails the first time one appears underneath.
 *
 *   npm run dev                          # in another shell
 *   electron scripts/probe-glass-real-app.cjs
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const URL_ = process.env.GLASS_PROBE_URL || "http://localhost:5173/";
const OUT = path.join(__dirname, "..", ".glass-shots", "lab");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch("force-device-scale-factor", "2");

const SEL = ".liquid-glass, .analysis-tab, .analysis-action-group, .liquid-glass-lens";

/** Freeze everything that moves, so a diff measures the painter and not the orb. */
const FREEZE = `(() => {
  const s = document.createElement("style");
  s.id = "__freeze";
  s.textContent = \`*, *::before, *::after {
    animation-play-state: paused !important;
    animation: none !important;
    transition: none !important;
  }\`;
  document.head.appendChild(s);
  return true;
})()`;

const SETUP = `(async () => {
  const mod = await import("/src/lib/glass-canvas/backdrop.ts");
  const holder = document.createElement("canvas");
  holder.id = "__recon";
  holder.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;display:none";
  document.body.appendChild(holder);
  const glass = [...document.querySelectorAll(${JSON.stringify(SEL)})].filter((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && cs.display !== "none" && Number(cs.opacity) > 0.02;
  });
  window.__rc = { mod, holder, glass };
  return glass.map((el, i) => {
    const r = el.getBoundingClientRect();
    return {
      i,
      name: (el.className || "").toString().split(/\\s+/).filter(Boolean).slice(0, 2).join("."),
      x: r.left, y: r.top, w: r.width, h: r.height,
    };
  });
})()`;

/** Hide every glass surface (and the recon canvas) — the ground-truth state. */
const HIDE_ALL = `(() => {
  for (const el of window.__rc.glass) el.style.visibility = "hidden";
  window.__rc.holder.style.display = "none";
  return true;
})()`;

const RECON = (i) => `(() => {
  const { mod, holder, glass } = window.__rc;
  const el = glass[${i}];
  const r = el.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const skipSet = new Set([...glass, holder]);
  const stats = mod.reconstructBackdrop(holder, {
    rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    dpr,
    exclude: (e) => skipSet.has(e),
  });
  holder.style.left = r.left + "px";
  holder.style.top = r.top + "px";
  holder.style.width = r.width + "px";
  holder.style.height = r.height + "px";
  holder.style.display = "block";
  return stats;
})()`;

function diff(a, b) {
  const A = a.toBitmap(), B = b.toBitmap();
  const sa = a.getSize(), sb = b.getSize();
  if (sa.width !== sb.width || sa.height !== sb.height) return { error: "size mismatch" };
  let sum = 0, max = 0, over8 = 0, over32 = 0, px = 0;
  for (let i = 0; i < Math.min(A.length, B.length); i += 4) {
    const d = Math.max(
      Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
    sum += d; if (d > max) max = d;
    if (d > 8) over8++; if (d > 32) over32++; px++;
  }
  return { mae: sum / px, max, pctOver8: (100 * over8) / px, pctOver32: (100 * over32) / px };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1512, height: 950, show: false });
  await win.loadURL(URL_);
  await wait(7000);
  await win.webContents.executeJavaScript(FREEZE);
  await wait(500);

  // Open whatever panels the app offers, so the census is not just the toolbar.
  await win.webContents.executeJavaScript(`(() => {
    const t = document.querySelector(".analysis-tab--settings");
    if (t) t.click();
    return true;
  })()`).catch(() => {});
  await wait(2000);

  const surfaces = await win.webContents.executeJavaScript(SETUP);
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`\n${surfaces.length} live glass surfaces in the running app\n`);
  console.log("                                            ── raw ──────────────────────   ── through the 3px blur ──");
  console.log("surface                          size       MAE   max    >8      >32    ms      MAE/max   what it cannot express");

  const rows = [];
  for (const s of surfaces) {
    const rect = {
      x: Math.round(s.x), y: Math.round(s.y),
      width: Math.round(s.w), height: Math.round(s.h),
    };
    if (rect.width < 4 || rect.height < 4) continue;
    await win.webContents.executeJavaScript(HIDE_ALL);
    await wait(150);
    const truth = await win.capturePage(rect);

    const stats = await win.webContents.executeJavaScript(RECON(s.i));
    await wait(150);
    const got = await win.capturePage(rect);

    const d = diff(truth, got);

    // ★ AND THROUGH THE BLUR THE SURFACE ACTUALLY APPLIES. The raw number
    //   counts glyph-edge pixels where DOM text and canvas `fillText`
    //   legitimately disagree — a stage of the pipeline nobody ever sees,
    //   because .liquid-glass blurs its backdrop by 3px first. Feed the
    //   ground-truth screenshot back into the page, blur both sides equally,
    //   and compare what is actually displayed.
    const blurred = await win.webContents.executeJavaScript(`(async () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const W = ${rect.width} * dpr | 0, H = ${rect.height} * dpr | 0;
      const img = new Image();
      img.src = ${JSON.stringify(truth.toDataURL())};
      await img.decode();
      const shot = (src) => {
        const c = document.createElement("canvas"); c.width = W; c.height = H;
        const x = c.getContext("2d", { willReadFrequently: true });
        x.filter = "blur(" + (3 * dpr) + "px)";
        x.drawImage(src, 0, 0, W, H);
        return x.getImageData(0, 0, W, H).data;
      };
      const a = shot(img), b = shot(window.__rc.holder);
      let sum = 0, max = 0, n = 0, over8 = 0;
      for (let y = 3; y < H - 3; y++) for (let x = 3; x < W - 3; x++) {
        const i = (y * W + x) * 4;
        const dd = Math.max(Math.abs(a[i]-b[i]), Math.abs(a[i+1]-b[i+1]), Math.abs(a[i+2]-b[i+2]));
        sum += dd; n++; if (dd > max) max = dd; if (dd > 8) over8++;
      }
      return { mae: n ? sum / n : 0, max, pctOver8: n ? 100 * over8 / n : 0 };
    })()`);
    d.blurred = blurred;
    rows.push({ s, d, stats });
    const cannot = Object.entries(stats.skipped)
      .sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(" ") || "-";
    console.log(
      `${s.name.slice(0, 32).padEnd(32)} ${(Math.round(s.w) + "x" + Math.round(s.h)).padEnd(10)} ` +
      `${d.error ? d.error : d.mae.toFixed(2).padStart(5)} ${String(d.max).padStart(4)} ` +
      `${d.pctOver8.toFixed(1).padStart(5)}% ${d.pctOver32.toFixed(1).padStart(6)}% ` +
      `${stats.ms.toFixed(2).padStart(6)}  ` +
      `${d.blurred.mae.toFixed(2).padStart(5)}/${String(d.blurred.max).padStart(3)}  ${cannot}`);

    fs.writeFileSync(path.join(OUT, `app-${s.i}-truth.png`), truth.toPNG());
    fs.writeFileSync(path.join(OUT, `app-${s.i}-recon.png`), got.toPNG());
  }

  // Restore, so the last shot shows the app as it really is.
  await win.webContents.executeJavaScript(`(() => {
    for (const el of window.__rc.glass) el.style.visibility = "";
    window.__rc.holder.style.display = "none";
    return true;
  })()`);

  const all = {};
  for (const r of rows) for (const [k, n] of Object.entries(r.stats.skipped)) all[k] = (all[k] || 0) + n;
  console.log("\n━━ WHAT THE PAINTER CANNOT EXPRESS, across every live surface ━━");
  const entries = Object.entries(all).sort((a, b) => b[1] - a[1]);
  if (!entries.length) console.log("  nothing — but that is a statement about THIS app state, not about CSS");
  for (const [k, n] of entries) console.log(`  ${k.padEnd(14)} ${n} element(s) under glass`);

  const worst = rows.reduce((a, b) => ((a.d.mae ?? 0) > (b.d.mae ?? 0) ? a : b), rows[0]);
  console.log(`\nworst surface: ${worst.s.name} — MAE ${worst.d.mae.toFixed(2)}/255, ` +
    `max ${worst.d.max}, ${worst.d.pctOver32.toFixed(1)}% of pixels off by >32`);
  console.log(`shots: ${OUT}/app-*.png`);
  app.exit(0);
});
