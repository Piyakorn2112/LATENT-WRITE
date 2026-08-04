/**
 * probe-draw-element-clone.cjs — SANDBOX. The one route left for the
 * HTML-in-Canvas API.
 *
 * `drawElementImage` refuses any element that is not an immediate child of the
 * canvas ("Only immediate children of the <canvas> element can be passed to
 * DrawElementImage"), so it cannot photograph an app that already exists. The
 * remaining idea is to give it something that IS its child: a CLONE of the
 * backdrop subtree, parented into a hidden `<canvas layoutsubtree>` and laid
 * out by the same stylesheets.
 *
 * If that works it is strictly better than the hand painter, because the
 * rasteriser is Chromium's own — masks, filters, transforms, shadows, blend
 * modes and every font feature come for free rather than being reimplemented.
 * The question is what a clone costs, and whether the clone lays out where the
 * original did.
 *
 *   electron scripts/probe-draw-element-clone.cjs
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const URL_ = process.env.GLASS_PROBE_URL || "http://localhost:5173/";
const OUT = path.join(__dirname, "..", ".glass-shots", "lab");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch("force-device-scale-factor", "2");
app.commandLine.appendSwitch("enable-blink-features", "CanvasDrawElement");

const SETUP = `(() => {
  const root = document.querySelector(".app") || document.body;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("layoutsubtree", "");
  // Off-screen but LAID OUT — display:none would give the clone no boxes at
  // all, and a clone with no layout is a clone of nothing.
  canvas.style.cssText =
    "position:fixed;left:0;top:0;opacity:0;pointer-events:none;z-index:-1";
  document.body.appendChild(canvas);
  window.__dc = { root, canvas };
  return { rootW: root.getBoundingClientRect().width, rootH: root.getBoundingClientRect().height };
})()`;

const RUN = `(() => {
  const { root, canvas } = window.__dc;
  const rr = root.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);

  const out = { steps: {} };
  const t = (k, fn) => { const a = performance.now(); const v = fn(); out.steps[k] = performance.now() - a; return v; };

  // 1 · Clone the backdrop subtree.
  const clone = t("clone", () => root.cloneNode(true));

  // 2 · Parent it into the canvas and let it lay out at the same size.
  t("attach", () => {
    canvas.replaceChildren();
    canvas.style.width = rr.width + "px";
    canvas.style.height = rr.height + "px";
    canvas.width = Math.round(rr.width * dpr);
    canvas.height = Math.round(rr.height * dpr);
    clone.style.width = rr.width + "px";
    clone.style.height = rr.height + "px";
    canvas.appendChild(clone);
  });

  // 3 · Force layout so the clone has boxes before we ask for its pixels.
  const laid = t("layout", () => clone.getBoundingClientRect());

  // 4 · Draw.
  const ctx = canvas.getContext("2d");
  let err = null;
  t("draw", () => {
    try {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rr.width, rr.height);
      ctx.drawElementImage(clone, 0, 0);
    } catch (e) { err = String(e && e.message || e); }
  });

  let nonBlank = 0;
  if (!err) {
    const d = ctx.getImageData(0, 0, Math.min(canvas.width, 300), Math.min(canvas.height, 300)).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 2) nonBlank++;
  }
  return {
    err, steps: out.steps,
    cloneRect: [laid.left, laid.top, laid.width, laid.height],
    rootRect: [rr.left, rr.top, rr.width, rr.height],
    nonBlankPct: 100 * nonBlank / (300 * 300),
    nodes: root.querySelectorAll("*").length,
  };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1512, height: 950, show: false });
  await win.loadURL(URL_);
  await wait(7000);
  await win.webContents.executeJavaScript(
    `(() => { const s=document.createElement("style");
      s.textContent="*,*::before,*::after{animation:none!important;transition:none!important}";
      document.head.appendChild(s); return true; })()`);
  await wait(400);

  const info = await win.webContents.executeJavaScript(SETUP);
  console.log(`\napp root: ${Math.round(info.rootW)}x${Math.round(info.rootH)}`);

  const res = await win.webContents.executeJavaScript(RUN);
  console.log(`DOM nodes in the backdrop subtree: ${res.nodes}`);
  if (res.err) {
    console.log(`\n★ drawElementImage(clone) THREW: ${res.err}`);
  } else {
    console.log(`\nstep costs, ms:`);
    for (const [k, v] of Object.entries(res.steps)) console.log(`  ${k.padEnd(8)} ${v.toFixed(2)}`);
    const total = Object.values(res.steps).reduce((a, b) => a + b, 0);
    console.log(`  ${"TOTAL".padEnd(8)} ${total.toFixed(2)}  (a 60fps frame is 16.67)`);
    console.log(`\nclone laid out at [${res.cloneRect.map(Math.round).join(",")}]`);
    console.log(`original         [${res.rootRect.map(Math.round).join(",")}]`);
    console.log(`canvas is ${res.nonBlankPct.toFixed(1)}% non-transparent in its top-left 300x300`);
    fs.mkdirSync(OUT, { recursive: true });
    const url = await win.webContents.executeJavaScript(`window.__dc.canvas.toDataURL()`);
    fs.writeFileSync(path.join(OUT, "de-clone.png"), Buffer.from(url.split(",")[1], "base64"));
    console.log(`shot: ${OUT}/de-clone.png`);
  }
  app.exit(0);
});
