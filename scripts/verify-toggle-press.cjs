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

  // ★ The question this loop exists to answer: the engine sizes its
  // displacement map from the LAYOUT box, which transform: scale() does not
  // change. If the painted box grows while the layout box does not, the glass
  // is a small map stretched over a big knob.
  const stretched = held.paintedW > held.layoutW * 1.2;
  console.log(`\n  layout box under press: ${held.layoutW}x${held.layoutH}`);
  console.log(`  painted box under press: ${held.paintedW}x${held.paintedH}`);
  console.log(`  => material is ${stretched ? "STRETCHED over the swell" : "in step with the swell"}`);
  console.log(`\nshots: ${OUT}/toggle-press-*.png`);
  app.exit(0);
});
