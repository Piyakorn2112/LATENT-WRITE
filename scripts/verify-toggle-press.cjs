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

  await win.webContents.executeJavaScript("window.__press(false)");
  await wait(120);
  await shot("4-release-120ms");
  await wait(300);
  await shot("5-released");
  const after = await probe();

  const show = (label, p) => {
    console.log(`\n  ${label}`);
    console.log(`    transform      ${p.transform}`);
    console.log(`    background     ${p.background}`);
    console.log(`    backdrop-filter ${p.backdropFilter || "(none)"}`);
    console.log(`    layout box     ${p.layoutW}x${p.layoutH}   painted box ${p.paintedW}x${p.paintedH}`);
  };

  console.log("toggle press, real glass engine:");
  show("REST", rest);
  show("PRESS 60ms", mid);
  show("PRESS settled", held);
  show("RELEASED", after);

  // ★ THE QUESTION THIS LOOP EXISTS TO ANSWER — and it used to answer it with
  // the wrong number. Comparing the PAINTED box to the LAYOUT box only
  // restates the CSS transform (it is 2x by design, always), so it reported
  // "STRETCHED" forever and could never report anything else. What actually
  // matters is the map's TEXEL DENSITY over the knob as displayed: the engine
  // authored the map from the layout box, so under the swell a 32x24-authored
  // map was magnified across a 64x48 knob. knob-glass now authors at press
  // density, and this measures that directly by reading the real <feImage>.
  // The knob only wears its glass WHILE PRESSED, so press again to measure —
  // the first version of this block ran after the release and could only ever
  // report "no backdrop-filter on the knob".
  await win.webContents.executeJavaScript("window.__press(true)");
  await wait(360);
  const density = await win.webContents.executeJavaScript(`(async () => {
    const knob = document.querySelector('.glass-toggle-knob');
    const cs = getComputedStyle(knob);
    const m = /url\\("?#([^")]+)"?\\)/.exec(cs.backdropFilter || "");
    if (!m) return { error: "no backdrop-filter url on the knob" };
    const filter = document.getElementById(m[1]);
    if (!filter) return { error: "filter " + m[1] + " not in the DOM" };
    const fe = filter.querySelector('feImage');
    const href = fe && (fe.getAttribute('href') || fe.getAttribute('xlink:href'));
    if (!href) return { error: "no feImage href" };
    const img = new Image();
    img.src = href;
    await img.decode();
    const rect = knob.getBoundingClientRect();
    // The map spans the element plus the baked margin, in ELEMENT units.
    const feW = parseFloat(fe.getAttribute('width'));
    return {
      id: m[1],
      mapW: img.naturalWidth,
      mapH: img.naturalHeight,
      feW,
      layoutW: knob.offsetWidth,
      paintedW: Math.round(rect.width),
      dpr: window.devicePixelRatio,
    };
  })()`);

  console.log("");
  if (density.error) {
    console.log(`  density: could not measure — ${density.error}`);
    app.exit(2);
    return;
  }
  // Texels per element pixel, then per pixel as actually displayed.
  const texelsPerElemPx = density.mapW / density.feW;
  const perDisplayedCssPx = (texelsPerElemPx * density.layoutW) / density.paintedW;
  const perDevicePx = perDisplayedCssPx / density.dpr;
  console.log(`  map ${density.mapW}x${density.mapH} over ${density.feW} element px`
    + ` = ${texelsPerElemPx.toFixed(2)} texels/element px`);
  console.log(`  knob displayed at ${density.paintedW}px (layout ${density.layoutW}px, dpr ${density.dpr})`);
  console.log(`  => ${perDisplayedCssPx.toFixed(2)} texels per displayed CSS px`
    + ` (${perDevicePx.toFixed(2)} per device px)`);

  // ★ THIS GATE USED TO DEMAND 3 TEXELS PER DISPLAYED PIXEL, and that was the
  // wrong invariant — it is not reachable and chasing it caused the banding.
  // The displacement channel is 8-bit: one byte moves the sample by
  // dispPx/255 element px, so once a texel advances less than about two bytes
  // the sampling alternates between stalling and jumping, which is a comb of
  // stripes. The ceiling is 255/(2·dispPx) = 3.19 texels per ELEMENT px, and
  // the knobs sit at 3. Density is therefore checked against the ceiling, not
  // against the display size; sharpness past it has to come from a finer
  // encoding, not more texels. See src/lib/knob-glass.ts (maxUsefulDensity).
  const CEILING = 255 / (2 * 40);
  const ok = texelsPerElemPx <= CEILING + 1e-9 && texelsPerElemPx >= CEILING - 1.2;
  console.log(`  quantisation ceiling ..... ${CEILING.toFixed(2)} texels/element px`);
  console.log(`  => density is ${ok ? "WITHIN the 8-bit ceiling" : "PAST the ceiling — expect stripes"}`);
  await win.webContents.executeJavaScript("window.__press(false)");
  console.log(`\nshots: ${OUT}/toggle-press-*.png`);
  app.exit(ok ? 0 : 1);
});
