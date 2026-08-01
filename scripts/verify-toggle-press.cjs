/**
 * verify-toggle-press.cjs — watch the toggle press WITH THE REAL GLASS ENGINE.
 *
 * Phase-1 feedback loop for the "liquid glass button expansion looks wrong"
 * bug. The earlier motion harness loaded only the stylesheet, so it could
 * confirm the transform curve and was structurally blind to the material.
 * This drives /toggle-verify.html through the vite dev server, which runs the
 * real initLiquidGlassFilter(), and captures the knob mid-press.
 *
 *   VITE_URL=http://localhost:5178 node scripts/verify-toggle-press.cjs
 *
 * Emits .glass-shots/toggle-press-*.png plus the engine's applied
 * backdrop-filter and the layout-vs-painted box at each stage.
 */

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.VITE_URL || "http://localhost:5178";
const OUT = path.join(__dirname, "..", ".glass-shots");

app.commandLine.appendSwitch("force-color-profile", "srgb");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 700, show: false });
  try {
    await win.loadURL(`${BASE}/toggle-verify.html`);
  } catch (e) {
    console.error(`could not load ${BASE}/toggle-verify.html — is the dev server up?`);
    console.error(String(e));
    app.exit(2);
    return;
  }
  // Give the engine time to build its displacement map and attach filters.
  await wait(1500);

  fs.mkdirSync(OUT, { recursive: true });
  const shot = async (name) => {
    const img = await win.capturePage();
    fs.writeFileSync(path.join(OUT, `toggle-press-${name}.png`), img.toPNG());
  };
  const probe = () => win.webContents.executeJavaScript("window.__probe && window.__probe()");

  // ─── FILMSTRIP of a full click, cropped to the toggle ───────────────────
  // The restored component releases after max(MIN_GLASS_ACTIVE_MS, PRESS_ANIMATION_MS).
  const TSX = fs.readFileSync(path.join(__dirname, "..", "src", "components", "GlassToggle.tsx"), "utf8");
  const HOLD = Math.max(
    Number((TSX.match(/const\s+MIN_GLASS_ACTIVE_MS\s*=\s*(\d+)/) || [])[1] || 0),
    Number((TSX.match(/const\s+PRESS_ANIMATION_MS\s*=\s*(\d+)/) || [])[1] || 300),
  );
  await win.webContents.executeJavaScript("window.__reset()");
  await wait(400);
  // The page mounts the REAL <GlassToggle/>, so there is no #tg id — find the
  // control by its class. capturePage wants {x, y, width, height} in DIP.
  const box = await win.webContents.executeJavaScript(
    "(() => { const r = document.querySelector('.glass-toggle').getBoundingClientRect();" +
    "  return { x: Math.round(r.x) - 40, y: Math.round(r.y) - 40," +
    "    width: Math.round(r.width) + 80, height: Math.round(r.height) + 80 }; })()",
  );
  const strip = [0, 80, 160, 240, 320, 400, 480, 560, 660];
  await win.webContents.executeJavaScript(`window.__click(${HOLD})`);
  const t0 = Date.now();
  for (const at of strip) {
    const due = at - (Date.now() - t0);
    if (due > 0) await wait(due);
    const img = await win.capturePage(box);
    fs.writeFileSync(path.join(OUT, `toggle-click-${String(at).padStart(3, "0")}ms.png`), img.toPNG());
  }
  console.log(`filmstrip (hold ${HOLD}ms): ${strip.map((s) => s + "ms").join(", ")}`);
  await win.webContents.executeJavaScript("window.__reset()");
  await wait(500);

  const rest = await probe();
  if (!rest) { console.error("harness hooks missing — did the module fail to load?"); app.exit(2); return; }
  await shot("1-rest");

  await win.webContents.executeJavaScript("window.__press(true)");
  await wait(60);
  await shot("2-press-60ms");
  const mid = await probe();
  await wait(300);
  await shot("3-press-settled");
  const held = await probe();

  const show = (label, p) => {
    console.log(`\n  ${label}`);
    console.log(`    transform      ${p.transform}`);
    console.log(`    background     ${p.background}`);
    console.log(`    layout box     ${p.layoutW}x${p.layoutH}   painted box ${p.paintedW}x${p.paintedH}`);
  };
  console.log("toggle press, real glass engine:");
  show("REST", rest);
  show("PRESS 60ms", mid);
  show("PRESS settled", held);

  // ── THE KNOB IS PAINTED NOW, NOT FILTERED ────────────────────────────────
  //
  // The material is a canvas drawn per pixel in float (knob-glass-paint.ts),
  // so there is no <feImage> to inspect and no texel density to police. The
  // two things that CAN regress are the two that were actually reported:
  //   · SHARPNESS — the canvas backing store must carry the press scale, or
  //     the knob is a magnified bitmap again;
  //   · BANDING — a comb shows as repeated large jumps between ADJACENT
  //     pixels along a scanline inside the knob. Smooth refraction crosses
  //     the track edge once or twice per line; a comb crosses it over and over.
  const painted = await win.webContents.executeJavaScript(`(() => {
    const knob = document.querySelector('.glass-toggle-knob');
    const canvas = knob && knob.querySelector('canvas.knob-glass-canvas');
    if (!canvas) return { error: "the knob has no painted canvas" };
    const r = knob.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const W = canvas.width, H = canvas.height;
    const px = ctx.getImageData(0, 0, W, H).data;
    let jumps = 0, worst = 0, samples = 0;
    for (const frac of [0.3, 0.5, 0.7]) {
      const y = Math.round(H * frac);
      let prev = null;
      for (let x = 4; x < W - 4; x++) {
        const i = (y * W + x) * 4;
        if (px[i + 3] < 250) { prev = null; continue; }
        const v = 0.213 * px[i] + 0.715 * px[i + 1] + 0.072 * px[i + 2];
        if (prev !== null) {
          const dv = Math.abs(v - prev);
          if (dv > 40) jumps++;
          if (dv > worst) worst = dv;
          samples++;
        }
        prev = v;
      }
    }
    return {
      cssW: Math.round(r.width), dpr, backingW: W, backingH: H,
      expectedW: Math.round(r.width * dpr),
      jumps, worst: Math.round(worst), samples,
      filter: getComputedStyle(knob).backdropFilter,
    };
  })()`);

  console.log("");
  if (painted.error) { console.log(`  painted knob: ${painted.error}`); app.exit(2); return; }
  console.log(`  knob displayed ${painted.cssW}px css @dpr ${painted.dpr}`);
  console.log(`  canvas backing ${painted.backingW}x${painted.backingH} (expected ${painted.expectedW} wide)`);
  console.log(`  backdrop-filter on the knob: ${painted.filter}`);
  console.log(`  adjacent-pixel jumps > 40 ... ${painted.jumps} of ${painted.samples} steps (worst ${painted.worst})`);

  const fails = [];
  if (Math.abs(painted.backingW - painted.expectedW) > 2) {
    fails.push(`canvas is not at display resolution (${painted.backingW} vs ${painted.expectedW})`);
  }
  if (painted.filter && painted.filter !== "none") {
    fails.push(`the knob still carries a backdrop-filter (${painted.filter})`);
  }
  if (painted.jumps > 8) {
    fails.push(`${painted.jumps} large adjacent-pixel jumps — that is a comb, the banding is back`);
  }

  await win.webContents.executeJavaScript("window.__press(false)");
  console.log("");
  if (!fails.length) console.log("PASS — painted at display resolution, no banding comb, no filter.");
  else for (const f of fails) console.log(`FAIL — ${f}`);
  console.log(`\nshots: ${OUT}/toggle-press-*.png`);
  app.exit(fails.length ? 1 : 0);
});
