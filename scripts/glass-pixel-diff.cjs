/**
 * Zero-visual-change proof for the liquid-glass engine, at the integration
 * level: drives real Chromium (Electron) against /glass-verify.html, captures
 * the composited page, and byte-compares it against a stored reference.
 *
 * The unit-level proof (scratchpad byte-diff of the displacement map) covers
 * the worker math. This covers everything the map can't: the SVG filter graph,
 * the blob encode/decode, and Skia's actual rasterisation of the result.
 *
 *   # 1. with the OLD code checked out:
 *   node scripts/glass-pixel-diff.cjs --save ref
 *   # 2. with the NEW code:
 *   node scripts/glass-pixel-diff.cjs --diff ref
 *
 * Requires the Vite dev server on :5173 (npm run dev).
 */

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("path");

const URL_ = process.env.GLASS_VERIFY_URL || "http://localhost:5173/glass-verify.html";
const OUT_DIR = process.env.GLASS_SHOT_DIR || path.join(__dirname, "..", ".glass-shots");

const args = process.argv.slice(2);
const modeIdx = args.findIndex((a) => a === "--save" || a === "--diff");
if (modeIdx < 0) {
  console.error("usage: glass-pixel-diff.cjs (--save|--diff) <name>");
  process.exit(2);
}
const mode = args[modeIdx].slice(2);
const name = args[modeIdx + 1] || "ref";

// Deterministic raster: no GPU, fixed scale factor.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("force-color-profile", "srgb");
app.commandLine.appendSwitch("disable-lcd-text");

function comparePng(aPath, bBuf) {
  // Compare the decoded pixels, not the PNG containers: re-encoding can differ
  // byte-wise while the image is identical.
  const { nativeImage } = require("electron");
  const a = nativeImage.createFromPath(aPath);
  const b = nativeImage.createFromBuffer(bBuf);
  const as = a.getSize();
  const bs = b.getSize();
  if (as.width !== bs.width || as.height !== bs.height) {
    return { ok: false, why: `size ${as.width}x${as.height} vs ${bs.width}x${bs.height}` };
  }
  const ab = a.getBitmap();
  const bb = b.getBitmap();
  let differing = 0;
  let maxDelta = 0;
  let firstAt = null;
  for (let i = 0; i < ab.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(ab[i + c] - bb[i + c]));
    if (d !== 0) {
      differing++;
      if (d > maxDelta) maxDelta = d;
      if (!firstAt) {
        const px = i / 4;
        firstAt = `(${px % as.width},${Math.floor(px / as.width)})`;
      }
    }
  }
  return {
    ok: differing === 0,
    why: differing === 0
      ? `${as.width}x${as.height}, every pixel identical`
      : `${differing} px differ (max channel delta ${maxDelta}), first at ${firstAt}`,
  };
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    useContentSize: true,
    backgroundColor: "#101014",
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });

  let failed = false;
  try {
    await win.loadURL(URL_);
    const ready = await win.webContents.executeJavaScript(`
      new Promise((res) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (window.__glassReady || Date.now() - t0 > 30000) {
            clearInterval(iv);
            res({ ready: !!window.__glassReady, bound: window.__glassBound, total: window.__glassTotal });
          }
        }, 100);
      })
    `);
    if (!ready.ready || ready.bound !== ready.total) {
      console.error(`✗ page not ready (bound ${ready.bound}/${ready.total}) — is the dev server up?`);
      failed = true;
    } else {
      const img = await win.webContents.capturePage();
      const buf = img.toPNG();
      const refPath = path.join(OUT_DIR, `${name}.png`);
      if (mode === "save") {
        fs.writeFileSync(refPath, buf);
        console.log(`✓ saved reference ${refPath} (${ready.bound} glass specimens, ${buf.length} bytes)`);
      } else {
        if (!fs.existsSync(refPath)) {
          console.error(`✗ no reference at ${refPath} — run --save first`);
          failed = true;
        } else {
          const res = comparePng(refPath, buf);
          if (!res.ok) fs.writeFileSync(path.join(OUT_DIR, `${name}.actual.png`), buf);
          console.log(res.ok ? `✓ PIXEL-IDENTICAL — ${res.why}` : `✗ VISUAL CHANGE — ${res.why}`);
          failed = !res.ok;
        }
      }
    }
  } catch (err) {
    console.error("✗ harness error:", err);
    failed = true;
  }
  win.destroy();
  app.exit(failed ? 1 : 0);
});
