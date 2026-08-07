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
<!-- padding:0 pinned on layer AND overlay: in the app both mirror the
     textarea's padding (the layer via CSS vars, the overlay via computed
     copy), so they align; the harness aligns them explicitly — a first
     version left the layer's app padding in place, the two texts never
     overlapped, and the control went blind. -->
<div class="editor-wrap" style="width: 600px">
  <!-- span flush against the div: the layer is pre-wrap, so pretty-printed
       newlines inside it RENDER and shove the text a line down — that
       misalignment blinded two earlier versions of this control. -->
  <div class="editor-highlight" style="font: 16px monospace; line-height: 24px; padding: 0"><span id="layer-range" style="visibility: hidden"><span style="color: rgb(200, 0, 0)">Mara walked to the boathouse and found the door unlocked today.</span></span></div>
  <textarea class="document-editor document-editor--highlight" style="font: 16px monospace; line-height: 24px; width: 600px; height: 60px; padding: 0">Mara walked to the boathouse and found the door unlocked today.</textarea>
  <div class="writing-wave-text" style="font: 16px monospace; line-height: 24px; top: 0; left: 0; width: 600px; padding: 0; color: transparent"><span class="writing-wave-plain" style="color: rgb(20,20,24)">Mara </span><span class="writing-wave-range"><span class="writing-wave-ink" style="color: rgb(20,20,24)">walked to the boathouse</span><span class="writing-wave-sweep" style="animation: none"></span></span></div>
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
    // Scan ONLY the covered word's region for the darkest pixel. The wrap
    // centres at x=50 (700px viewport, 600px wrap); "Mara " spans x50–98 and
    // is OUTSIDE the rewritten range — legitimately red — so sampling it
    // false-flagged the sandwich. "walked" spans x≈98–155.
    const data = ctx.getImageData(105, 2, 40, 22).data;
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

const shipped = await inkPixel('');
const layerShows = await inkPixel('#layer-range { visibility: visible !important; } .writing-wave-text { display: none !important; }');
const bothHidden = await inkPixel('.writing-wave-text { display: none !important; }');
await browser.close();

console.log(`shipped ink: rgb(${shipped.r}, ${shipped.g}, ${shipped.b}) · layer-visible control: rgb(${layerShows.r}, ${layerShows.g}, ${layerShows.b}) · all-hidden control: rgb(${bothHidden.r}, ${bothHidden.g}, ${bothHidden.b})`);
const red = (p) => p.r > p.b + 40 && p.r > 120;
const darkInk = (p) => p.lum < 90;
const blank = (p) => p.lum > 200;
if (!red(layerShows)) { console.log('✗ VACUOUS: un-hiding the layer did not show red — sampler blind'); process.exit(1); }
if (!blank(bothHidden)) { console.log('✗ hiding is not hiding: something still paints with the overlay off'); process.exit(1); }
if (red(shipped)) { console.log('✗ the layer range still paints under the overlay'); process.exit(1); }
if (!darkInk(shipped)) { console.log('✗ overlay ink absent — the range would read blank'); process.exit(1); }
console.log('✓ clean-text model verified: layer range hidden, overlay ink is the only paint (both controls bite)');
