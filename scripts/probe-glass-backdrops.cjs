/**
 * probe-glass-backdrops.cjs — WHAT IS ACTUALLY BEHIND THE GLASS.
 *
 * Before asking whether a canvas engine can reconstruct the backdrop under each
 * liquid-glass surface, measure what that backdrop IS. The knob painter
 * (knob-glass-paint.ts) reconstructs its backdrop by RE-PAINTING it — a base
 * fill plus a handful of rounded rects read from the live DOM — which works
 * because the only thing under a knob is a track on a panel. Whether that
 * method generalises is a question about the app's real surfaces, not about the
 * optics, so it gets measured first.
 *
 * For every glass surface this reports:
 *   · its DISPLAYED size in device px — the per-pixel budget a canvas path pays
 *   · every element that paints underneath it, classified as
 *       fill      a flat background-color        → a rect, trivially repaintable
 *       gradient  a background-image gradient    → repaintable if it is linear
 *       text      a node with its own text       → needs a text renderer
 *       image     img/canvas/svg/video           → needs the source bitmap
 *       glass     another glass surface          → needs ordering, or recursion
 *
 * Run with the dev server up:
 *   electron scripts/probe-glass-backdrops.cjs
 *   GLASS_PROBE_URL=http://localhost:5173/ electron scripts/probe-glass-backdrops.cjs
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const URL_ = process.env.GLASS_PROBE_URL || "http://localhost:5173/";
const OUT = path.join(__dirname, "..", ".glass-shots");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch("force-device-scale-factor", "2");

const PROBE = `(() => {
  const SEL = ".liquid-glass, .analysis-tab, .analysis-action-group, .liquid-glass-control-knob, .liquid-glass-lens";
  const dpr = window.devicePixelRatio || 1;
  const isGlass = (el) => el.matches && el.matches(SEL);

  /** Does this element paint its OWN text (not a descendant's)? */
  const ownsText = (el) => [...el.childNodes].some(
    (n) => n.nodeType === 3 && n.textContent.trim().length > 0);

  const classify = (el) => {
    if (isGlass(el)) return "glass";
    const tag = el.tagName.toLowerCase();
    if (["img", "canvas", "svg", "video", "picture"].includes(tag)) return "image";
    if (el.closest("svg")) return "image";
    const cs = getComputedStyle(el);
    if (Number(cs.opacity) < 0.02) return null;
    if (ownsText(el)) return "text";
    const bgi = cs.backgroundImage;
    if (bgi && bgi !== "none") return bgi.includes("gradient") ? "gradient" : "image";
    const m = (cs.backgroundColor || "").match(/[\\d.]+/g);
    if (m && (m.length < 4 || Number(m[3]) > 0.004)) return "fill";
    return null;
  };

  const out = [];
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || Number(cs.opacity) < 0.02) continue;

    // Sample a grid across the surface and collect everything painting BELOW
    // it. elementsFromPoint returns front-to-back, so anything after the glass
    // element itself is its backdrop.
    const kinds = {};
    const seen = new Map();
    const NX = 9, NY = 9;
    for (let iy = 0; iy < NY; iy++) {
      for (let ix = 0; ix < NX; ix++) {
        const x = r.left + ((ix + 0.5) / NX) * r.width;
        const y = r.top + ((iy + 0.5) / NY) * r.height;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const stack = document.elementsFromPoint(x, y);
        const at = stack.indexOf(el);
        if (at < 0) continue;
        for (const under of stack.slice(at + 1)) {
          if (under === document.body || under === document.documentElement) continue;
          if (seen.has(under)) continue;
          const k = classify(under);
          if (!k) { seen.set(under, null); continue; }
          seen.set(under, k);
          kinds[k] = (kinds[k] || 0) + 1;
        }
      }
    }
    // Text nodes are the expensive class — count the actual characters, since
    // "1 text element" and "a full chapter of prose" are not the same problem.
    let chars = 0;
    for (const [under, k] of seen) if (k === "text") chars += (under.textContent || "").length;

    out.push({
      name: (el.className || "").toString().split(/\\s+/).filter(Boolean).slice(0, 3).join("."),
      tag: el.tagName.toLowerCase(),
      w: Math.round(r.width), h: Math.round(r.height),
      devPx: Math.round(r.width * dpr * r.height * dpr),
      radius: cs.borderRadius,
      filter: (cs.backdropFilter || cs.webkitBackdropFilter || "none").slice(0, 28),
      kinds,
      underCount: [...seen.values()].filter(Boolean).length,
      chars,
    });
  }
  return { dpr, w: innerWidth, h: innerHeight, surfaces: out };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1512, height: 950, show: false });
  await win.loadURL(URL_);
  await wait(6000);

  // Open the analysis panel and the timeline if the app offers them, so the
  // census covers the BIG surfaces and not just the toolbar.
  await win.webContents.executeJavaScript(`(() => {
    const click = (sel) => { const e = document.querySelector(sel); if (e) { e.click(); return true; } return false; };
    const opened = [];
    for (const sel of [".analysis-tab", "[data-testid='analysis-toggle']", ".toolbar-analysis"]) {
      if (click(sel)) { opened.push(sel); break; }
    }
    return opened;
  })()`).catch(() => {});
  await wait(2500);

  const res = await win.webContents.executeJavaScript(PROBE);
  fs.mkdirSync(OUT, { recursive: true });
  const img = await win.capturePage();
  fs.writeFileSync(path.join(OUT, "glass-backdrop-census.png"), img.toPNG());

  console.log(`\nviewport ${res.w}x${res.h} @ dpr ${res.dpr}\n`);
  const total = { fill: 0, gradient: 0, text: 0, image: 0, glass: 0 };
  res.surfaces.sort((a, b) => b.devPx - a.devPx);
  console.log("surface                                    size      device px   under  backdrop kinds");
  for (const s of res.surfaces) {
    for (const k of Object.keys(total)) total[k] += s.kinds[k] || 0;
    const kinds = Object.entries(s.kinds).map(([k, n]) => `${k}:${n}`).join(" ") || "(nothing)";
    console.log(
      `${(s.tag + "." + s.name).slice(0, 42).padEnd(42)} ${String(s.w + "x" + s.h).padEnd(9)} ` +
      `${String(s.devPx.toLocaleString()).padStart(10)} ${String(s.underCount).padStart(6)}  ${kinds}` +
      (s.chars ? `  [${s.chars.toLocaleString()} chars]` : ""));
  }
  console.log(`\n${res.surfaces.length} glass surfaces`);
  console.log(`total device px under glass: ${res.surfaces.reduce((a, s) => a + s.devPx, 0).toLocaleString()}`);
  console.log(`backdrop elements by kind:`, total);
  console.log(`\nshot: ${OUT}/glass-backdrop-census.png`);
  app.exit(0);
});
