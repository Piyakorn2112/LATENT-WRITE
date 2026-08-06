/**
 * verify-wave-stack.mjs — does the rewrite pulse actually PAINT above the
 * highlight layer, with the shipped CSS?
 *
 * The z-index sandwich (overlay 2 under layer 10) passed every suite and
 * build because no gate ever looked at pixels. This one does: it builds the
 * REAL editor DOM shape (editor-wrap > editor-highlight[z10] + textarea +
 * writing-wave-text) with the REAL dist stylesheet, then reads the painted
 * pixel at a pulsing word. Red layer text showing through = the sandwich is
 * back; accent-leaning pixel = the overlay is on top and covering.
 *
 * Run: /opt/homebrew/bin/node scripts/verify-wave-stack.mjs
 */
import { chromium } from "playwright-core";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const assets = path.join(ROOT, "dist", "assets");
const cssFile = readdirSync(assets).find((f) => f.endsWith(".css"));
if (!cssFile) { console.error("no dist css — run the build first"); process.exit(1); }
const css = readFileSync(path.join(assets, cssFile), "utf8");

const page = `<!doctype html><html><head><style>${css}</style><style>
  :root { --control-value-fill: rgb(20, 90, 220); }
  body { margin: 0; background: rgb(250, 250, 248); }
</style></head><body>
<div class="editor-wrap" style="width: 600px">
  <div class="editor-highlight" style="font: 16px monospace; line-height: 24px">
    <span style="color: rgb(200, 0, 0)">Mara walked to the boathouse and found the door unlocked today.</span>
  </div>
  <textarea class="document-editor document-editor--highlight" style="font: 16px monospace; line-height: 24px; width: 600px; height: 60px">Mara walked to the boathouse and found the door unlocked today.</textarea>
  <div class="writing-wave-text" style="font: 16px monospace; line-height: 24px; top: 0; left: 0; width: 600px; --wave-cover: rgb(250, 250, 248)">Mara <span class="writing-wave-word" style="animation: none; color: var(--control-value-fill)">walked</span> to the boathouse</div>
</div>
</body></html>`;

// playwright-core ships no browsers; the installed real Chrome is the runner
// (same choice as the real-GPU probes).
const browser = await chromium.launch({ channel: "chrome" });

async function inkPixel(extraCss) {
  const pg = await browser.newPage({ viewport: { width: 700, height: 200 } });
  await pg.setContent(page.replace("</head>", `<style>${extraCss}</style></head>`));
  await pg.waitForTimeout(120);
  // Sample inside the word "walked" (starts ~5 chars in at ~9.6px/char mono).
  const shot = await pg.screenshot({ clip: { x: 0, y: 0, width: 300, height: 30 } });
  const px = await pg.evaluate(async (buf) => {
    const blob = new Blob([new Uint8Array(buf)], { type: "image/png" });
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    // Scan the word region for the darkest pixel (the glyph ink).
    const data = ctx.getImageData(50, 2, 60, 22).data;
    let best = { r: 255, g: 255, b: 255, lum: 999 };
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum < best.lum) best = { r: data[i], g: data[i + 1], b: data[i + 2], lum };
    }
    return best;
  }, Array.from(shot));
  await pg.close();
  return px;
}

const real = await inkPixel("");
// ★ NEGATIVE CONTROL — pair every negative gate with a positive: force the
//   old sandwich (overlay back to z-index 2) and the RED layer ink must
//   reappear, proving this harness actually sees the stacking.
const sandwich = await inkPixel(".writing-wave-text { z-index: 2 !important; }");
await browser.close();

console.log(`shipped css ink: rgb(${real.r}, ${real.g}, ${real.b}) · forced-sandwich ink: rgb(${sandwich.r}, ${sandwich.g}, ${sandwich.b})`);
const accentLike = (p) => p.b > p.r + 40 && p.b > 100;
const layerRed = (p) => p.r > p.b + 40;
if (!layerRed(sandwich)) { console.log("✗ VACUOUS: the forced sandwich did not leak red — harness is blind"); process.exit(1); }
if (layerRed(real)) { console.log("✗ the highlight layer paints ABOVE the pulse — sandwich is back"); process.exit(1); }
if (!accentLike(real)) { console.log("✗ no accent ink found — overlay not rendering/covering"); process.exit(1); }
console.log("✓ the pulse paints above the layer and covers the original glyphs (and the control catches the sandwich)");
