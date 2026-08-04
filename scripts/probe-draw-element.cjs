/**
 * probe-draw-element.cjs — SANDBOX. Does Chromium hand us the backdrop directly?
 *
 * Everything else in this investigation assumes the backdrop has to be
 * RECONSTRUCTED by hand — walk the DOM, repaint the rects, re-lay the glyphs —
 * and the measured cost of that assumption is a painter that cannot express
 * transforms, masks or filters, of which the running app has 34, 33 and 9
 * underneath its glass.
 *
 * Chromium 148 ships the HTML-in-Canvas API behind a flag: `drawElementImage`
 * on a 2D context and `texElementImage2D` on WebGL, which rasterise a live DOM
 * element with the browser's own painter. Electron 42 IS Chromium 148, and an
 * Electron app can set its own Blink flags, so the origin trial that gates this
 * on the open web does not apply here.
 *
 * This asks the only questions that matter:
 *   · does it work on an element that is NOT nested inside the canvas?
 *   · is it pixel-exact against the real page, including the constructs the
 *     hand painter cannot express?
 *   · what does a call cost, at real surface sizes?
 *   · does it need the flag, or is it on by default?
 *
 *   electron scripts/probe-draw-element.cjs
 *   DRAW_ELEMENT_FLAG=0 electron scripts/probe-draw-element.cjs   # without it
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const URL_ = process.env.GLASS_PROBE_URL || "http://localhost:5173/";
const OUT = path.join(__dirname, "..", ".glass-shots", "lab");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const USE_FLAG = process.env.DRAW_ELEMENT_FLAG !== "0";

app.commandLine.appendSwitch("force-device-scale-factor", "2");
if (USE_FLAG) app.commandLine.appendSwitch("enable-blink-features", "CanvasDrawElement");

const SEL = ".liquid-glass, .analysis-tab, .analysis-action-group, .liquid-glass-lens";

const FREEZE = `(() => {
  const s = document.createElement("style");
  s.textContent = "*,*::before,*::after{animation:none!important;transition:none!important}";
  document.head.appendChild(s);
  return true;
})()`;

/** Draw the app's own root into a canvas and crop to a glass surface's rect. */
const DRAW = (i) => `(() => {
  const glass = window.__de.glass;
  const el = glass[${i}];
  const r = el.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);

  const c = window.__de.canvas;
  c.width = W; c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);

  // ★ THE ELEMENT IS THE APP ROOT, WHICH IS NOWHERE NEAR THIS CANVAS. If the
  //   API only rasterises its own subtree this throws or draws nothing, and
  //   that is the answer.
  const root = window.__de.root;
  let err = null, ms = 0, calls = 0;
  try {
    const t0 = performance.now();
    const N = 20;
    for (let k = 0; k < N; k++) {
      ctx.save();
      ctx.translate(-r.left, -r.top);
      ctx.drawElementImage(root, 0, 0);
      ctx.restore();
      calls++;
    }
    ms = (performance.now() - t0) / N;
  } catch (e) {
    err = String(e && e.message || e);
  }
  return { err, ms, calls, w: r.width, h: r.height, devPx: W * H,
           blank: (() => {
             const d = ctx.getImageData(0, 0, Math.min(W, 40), Math.min(H, 40)).data;
             let nz = 0; for (let j = 3; j < d.length; j += 4) if (d[j] > 2) nz++;
             return nz === 0;
           })() };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1512, height: 950, show: false });
  await win.loadURL(URL_);
  await wait(7000);
  await win.webContents.executeJavaScript(FREEZE);
  await wait(400);

  const support = await win.webContents.executeJavaScript(`(() => {
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d");
    const gl = document.createElement("canvas").getContext("webgl2");
    return {
      chrome: navigator.userAgent.match(/Chrome\\/([\\d.]+)/)?.[1],
      drawElementImage: typeof ctx.drawElementImage,
      texElementImage2D: gl ? typeof gl.texElementImage2D : "no-webgl2",
    };
  })()`);
  console.log(`\nChromium ${support.chrome}  ·  flag ${USE_FLAG ? "ON" : "OFF"}`);
  console.log(`  ctx.drawElementImage    ${support.drawElementImage}`);
  console.log(`  gl.texElementImage2D    ${support.texElementImage2D}`);
  if (support.drawElementImage !== "function") {
    console.log("\nAPI absent — nothing further to measure.");
    app.exit(0);
    return;
  }

  const surfaces = await win.webContents.executeJavaScript(`(() => {
    const glass = [...document.querySelectorAll(${JSON.stringify(SEL)})].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4 && getComputedStyle(el).display !== "none";
    });
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;display:none";
    document.body.appendChild(canvas);
    window.__de = { glass, canvas, root: document.querySelector(".app") || document.body };
    return glass.map((el, i) => {
      const r = el.getBoundingClientRect();
      return { i, name: (el.className||"").toString().split(/\\s+/).filter(Boolean).slice(0,2).join("."),
               x: r.left, y: r.top, w: r.width, h: r.height };
    });
  })()`);

  fs.mkdirSync(OUT, { recursive: true });
  console.log(`\n━━ drawElementImage ON THE APP ROOT, cropped to each glass surface ━━`);
  console.log("surface                          size       device px   ms/call    MAE   max    >8      >32");

  for (const s of surfaces) {
    const rect = { x: Math.round(s.x), y: Math.round(s.y), width: Math.round(s.w), height: Math.round(s.h) };
    // Ground truth with every glass surface hidden.
    await win.webContents.executeJavaScript(
      `(() => { for (const e of window.__de.glass) e.style.visibility = "hidden";
                window.__de.canvas.style.display = "none"; return true; })()`);
    await wait(140);
    const truth = await win.capturePage(rect);

    const drew = await win.webContents.executeJavaScript(DRAW(s.i));
    if (drew.err) {
      console.log(`${s.name.slice(0,32).padEnd(32)} ${(rect.width+"x"+rect.height).padEnd(10)} ` +
        `${String(drew.devPx).padStart(10)}  THREW: ${drew.err}`);
      continue;
    }

    const cmp = await win.webContents.executeJavaScript(`(async () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const W = ${rect.width} * dpr | 0, H = ${rect.height} * dpr | 0;
      const img = new Image();
      img.src = ${JSON.stringify(truth.toDataURL())};
      await img.decode();
      const a = (() => { const c = document.createElement("canvas"); c.width=W; c.height=H;
        const x = c.getContext("2d", {willReadFrequently:true}); x.drawImage(img,0,0,W,H);
        return x.getImageData(0,0,W,H).data; })();
      const b = window.__de.canvas.getContext("2d", {willReadFrequently:true}).getImageData(0,0,W,H).data;
      let sum=0,max=0,n=0,o8=0,o32=0;
      for (let y=1;y<H-1;y++) for (let x=1;x<W-1;x++) {
        const i=(y*W+x)*4;
        const d=Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]));
        sum+=d;n++;if(d>max)max=d;if(d>8)o8++;if(d>32)o32++;
      }
      return { mae:sum/n, max, pctOver8:100*o8/n, pctOver32:100*o32/n };
    })()`);

    console.log(
      `${s.name.slice(0,32).padEnd(32)} ${(rect.width+"x"+rect.height).padEnd(10)} ` +
      `${String(drew.devPx).padStart(10)} ${drew.ms.toFixed(2).padStart(8)} ` +
      `${cmp.mae.toFixed(2).padStart(6)} ${String(cmp.max).padStart(4)} ` +
      `${cmp.pctOver8.toFixed(1).padStart(5)}% ${cmp.pctOver32.toFixed(1).padStart(6)}%` +
      `${drew.blank ? "   ★ DREW NOTHING" : ""}`);

    if (s.i === 0) {
      fs.writeFileSync(path.join(OUT, "de-0-truth.png"), truth.toPNG());
      const url = await win.webContents.executeJavaScript(`window.__de.canvas.toDataURL()`);
      fs.writeFileSync(path.join(OUT, "de-0-drawn.png"),
        Buffer.from(url.split(",")[1], "base64"));
    }
  }

  await win.webContents.executeJavaScript(
    `(() => { for (const e of window.__de.glass) e.style.visibility = ""; return true; })()`);
  console.log(`\nshots: ${OUT}/de-0-*.png`);
  app.exit(0);
});
