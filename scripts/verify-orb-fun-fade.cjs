/**
 * verify-orb-fun-fade.cjs — prove the fun-mode centre fade actually lands on
 * the ORB and not on the eyes, and that it is visible.
 *
 * The previous attempt at this shipped a rule that was never seen, so this
 * measures rather than assumes. It rebuilds the real DOM shape — the orb host
 * (`span.orb-engine`, which is what OrbEngine renders and appends its canvas
 * into) and the eyes SVG as its SIBLING — fills the orb with a flat bright
 * colour, and compares the rendered alpha at the CENTRE against the RIM.
 *
 *   fade working → centre noticeably more transparent than the rim
 *   fade missing → centre and rim identical
 *
 * It also checks the eyes are untouched, which is the whole reason the rule is
 * scoped with :not(.intel-eyes).
 *
 *   node scripts/verify-orb-fun-fade.cjs
 */

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const CSS = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");
const OUT = path.join(__dirname, "..", ".glass-shots");

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("force-color-profile", "srgb");

// Black page: whatever survives is the orb's own coverage, so a pixel's
// brightness IS its alpha.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
${CSS}
html,body{margin:0;padding:0;background:#000;}
#stage{position:absolute;left:100px;top:100px;}
/* Stand in for the WebGL canvas with a flat fill, so any variation across the
   orb comes from the mask under test and nothing else. */
.orb-engine{display:block;width:120px;height:120px;background:#ffffff;border-radius:50%;}
.intel-eyes{width:120px;height:120px;}
</style></head><body>
<div id="stage">
  <span class="intel-orb-live intel-orb-live--engine intel-orb-live--fun" id="orb">
    <span class="orb-engine"></span>
    <svg class="intel-eyes" viewBox="-12 -12 24 24"><g><path class="intel-eye intel-eye-pill" d="M -4,0.2 C -4,-1.83 -3.55,-2.7 -2.5,-2.7 C -1.45,-2.7 -1,-1.83 -1,0.2 C -1,2.23 -1.45,3.1 -2.5,3.1 C -3.55,3.1 -4,2.23 -4,0.2 Z"/></g></svg>
  </span>
</div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 400, height: 400, show: false });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(PAGE));
  await new Promise((r) => setTimeout(r, 500));

  const probe = await win.webContents.executeJavaScript(`(() => {
    const host = document.querySelector('.orb-engine');
    const eyes = document.querySelector('.intel-eyes');
    const hs = getComputedStyle(host);
    const es = getComputedStyle(eyes);
    const r = host.getBoundingClientRect();
    return {
      orbMask: hs.maskImage || hs.webkitMaskImage,
      eyesMask: es.maskImage || es.webkitMaskImage,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      dpr: window.devicePixelRatio,
    };
  })()`);

  const img = await win.capturePage();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "orb-fun-fade.png"), img.toPNG());
  const { width: W } = img.getSize();
  const bmp = img.getBitmap();
  const s = probe.dpr || 1;

  const lum = (px, py) => {
    const i = ((Math.round(py) * W) + Math.round(px)) * 4;
    return (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3;
  };
  const cx = (probe.rect.x + probe.rect.w / 2) * s;
  const cy = (probe.rect.y + probe.rect.h / 2) * s;
  const rad = (probe.rect.w / 2) * s;

  // Sample the centre well away from the eye glyph, and the rim just inside
  // the circle. Average a few offsets so one stray pixel cannot decide it.
  const centre = [[-6, -14], [6, -14], [0, 14], [-10, 10], [10, 10]]
    .map(([dx, dy]) => lum(cx + dx * s, cy + dy * s))
    .reduce((a, b) => a + b, 0) / 5;
  const rim = [[0, -1], [0, 1], [-1, 0], [1, 0]]
    .map(([ux, uy]) => lum(cx + ux * rad * 0.86, cy + uy * rad * 0.86))
    .reduce((a, b) => a + b, 0) / 4;

  const results = [];
  const ok = (label, cond, detail) => results.push({ label, cond, detail });

  ok("orb host carries the centre-fade mask", /radial-gradient/.test(probe.orbMask || ""), probe.orbMask);
  ok("eyes are NOT masked", !/radial-gradient/.test(probe.eyesMask || ""), probe.eyesMask);
  ok("centre is visibly faded vs the rim",
    rim > 40 && centre < rim * 0.8,
    `centre ${centre.toFixed(0)} vs rim ${rim.toFixed(0)} (need < ${(rim * 0.8).toFixed(0)})`);
  ok("but the orb is still clearly there (not punched through)",
    centre > rim * 0.35,
    `centre ${centre.toFixed(0)} vs rim ${rim.toFixed(0)}`);

  console.log("\nfun-mode orb centre fade:");
  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.cond ? "✓" : "✗"} ${r.label}${r.cond ? "" : ` — ${r.detail}`}`);
    if (!r.cond) failed++;
  }
  console.log(`\ncentre ${centre.toFixed(0)} / rim ${rim.toFixed(0)}  (${((1 - centre / rim) * 100).toFixed(0)}% faded at centre)`);
  console.log(failed ? `FAILED ${failed}/${results.length}` : `PASS ${results.length}/${results.length}`);
  app.exit(failed ? 1 : 0);
});
