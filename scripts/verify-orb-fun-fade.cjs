/**
 * verify-orb-fun-fade.cjs — prove the fun-mode centre fade lands on the ORB,
 * spares the eyes, and — the part two earlier versions got wrong — does NOT
 * clip what the orb paints beyond its nominal slot.
 *
 * The real DOM shape matters here: OrbEngine renders a 26px host span and a
 * CANVAS 1.5x that size, absolutely centred, because petals and the analysing
 * animation deliberately reach past the slot. A mask on the HOST is clipped to
 * the host's border box (mask-clip default) no matter what mask-size says, so
 * both previous rules amputated that overflow. The shipped rule masks the
 * CANVAS instead, which cannot clip anything by construction. This harness
 * rebuilds host + oversized canvas + eyes at 120/180px, fills the canvas with
 * a flat bright colour, and reads the rendered alpha at the CENTRE, the RIM,
 * and — the regression gate — in the OVERFLOW BAND outside the host box.
 *
 *   node scripts/verify-orb-fun-fade.cjs      (via `npm run verify:orb-fun-fade`)
 */

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const CSS = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");
const OUT = path.join(__dirname, "..", ".glass-shots");

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("force-color-profile", "srgb");

// Black page: whatever survives is the orb's own coverage, so a pixel's
// brightness IS its alpha. Host 120px, canvas 180px (the real 1.5x ratio),
// positioned exactly as orb-engine.css positions it.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
${CSS}
html,body{margin:0;padding:0;background:#000;}
#stage{position:absolute;left:150px;top:150px;}
.orb-engine{display:block;width:120px;height:120px;position:relative;}
.orb-engine-canvas{position:absolute;left:50%;top:50%;width:180px;height:180px;
  transform:translate(-50%,-50%);background:#ffffff;}
.intel-eyes{width:120px;height:120px;}
</style></head><body>
<div id="stage">
  <span class="intel-orb-live intel-orb-live--engine intel-orb-live--fun" id="orb">
    <span class="orb-engine"><canvas class="orb-engine-canvas" width="10" height="10"></canvas></span>
    <svg class="intel-eyes" viewBox="-12 -12 24 24"><g><path class="intel-eye intel-eye-pill" d="M -4,0.2 C -4,-1.83 -3.55,-2.7 -2.5,-2.7 C -1.45,-2.7 -1,-1.83 -1,0.2 C -1,2.23 -1.45,3.1 -2.5,3.1 C -3.55,3.1 -4,2.23 -4,0.2 Z"/></g></svg>
  </span>
</div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 500, height: 500, show: false });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(PAGE));
  await new Promise((r) => setTimeout(r, 500));

  const probe = await win.webContents.executeJavaScript(`(() => {
    const host = document.querySelector('.orb-engine');
    const canvas = document.querySelector('.orb-engine-canvas');
    const eyes = document.querySelector('.intel-eyes');
    const hs = getComputedStyle(host);
    const cs = getComputedStyle(canvas);
    const es = getComputedStyle(eyes);
    const r = host.getBoundingClientRect();
    return {
      hostMask: hs.maskImage || hs.webkitMaskImage,
      canvasMask: cs.maskImage || cs.webkitMaskImage,
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
  const rad = (probe.rect.w / 2) * s; // the ORB radius R (host half-width)

  // Sample the centre well away from the eye glyph, and the rim just inside
  // the orb circle. Average a few offsets so one stray pixel cannot decide it.
  const centre = [[-6, -14], [6, -14], [0, 14], [-10, 10], [10, 10]]
    .map(([dx, dy]) => lum(cx + dx * s, cy + dy * s))
    .reduce((a, b) => a + b, 0) / 5;
  const rim = [[0, -1], [0, 1], [-1, 0], [1, 0]]
    .map(([ux, uy]) => lum(cx + ux * rad * 0.86, cy + uy * rad * 0.86))
    .reduce((a, b) => a + b, 0) / 4;
  // ★ The overflow band: 1.35 R from centre along the axes — OUTSIDE the host
  // box (which ends at 1.0 R on-axis), inside the 1.5x canvas. This is where
  // the analysing/loading animation draws, and where both broken rules cut to
  // pure black.
  const overflow = [[0, -1], [0, 1], [-1, 0], [1, 0]]
    .map(([ux, uy]) => lum(cx + ux * rad * 1.35, cy + uy * rad * 1.35))
    .reduce((a, b) => a + b, 0) / 4;

  const results = [];
  const ok = (label, cond, detail) => results.push({ label, cond, detail });

  ok("the CANVAS carries the centre-fade mask", /radial-gradient/.test(probe.canvasMask || ""), probe.canvasMask);
  // ★ The host must NOT be masked: a host-box mask is what clipped the orb.
  ok("the HOST is not masked (host-box masks clip the canvas overflow)",
    !/radial-gradient/.test(probe.hostMask || "") || probe.hostMask === "none", probe.hostMask);
  ok("eyes are NOT masked", !/radial-gradient/.test(probe.eyesMask || ""), probe.eyesMask);
  ok("centre is visibly faded vs the rim",
    rim > 40 && centre < rim * 0.8,
    `centre ${centre.toFixed(0)} vs rim ${rim.toFixed(0)} (need < ${(rim * 0.8).toFixed(0)})`);
  ok("but the orb is still clearly there (not punched through)",
    centre > rim * 0.35,
    `centre ${centre.toFixed(0)} vs rim ${rim.toFixed(0)}`);
  // ★ THE REGRESSION GATE for "the mask clips the orb": paint past the host
  // box must survive at (nearly) full strength.
  ok("the overflow band OUTSIDE the host box survives (loading-animation room)",
    overflow > 220,
    `overflow ${overflow.toFixed(0)} at 1.35R (was 0 when the mask clipped at the host box)`);

  console.log("\nfun-mode orb centre fade:");
  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.cond ? "✓" : "✗"} ${r.label}${r.cond ? "" : ` — ${r.detail}`}`);
    if (!r.cond) failed++;
  }
  console.log(`\ncentre ${centre.toFixed(0)} / rim ${rim.toFixed(0)} / overflow ${overflow.toFixed(0)}` +
    `  (${((1 - centre / rim) * 100).toFixed(0)}% faded at centre)`);
  console.log(failed ? `FAILED ${failed}/${results.length}` : `PASS ${results.length}/${results.length}`);
  app.exit(failed ? 1 : 0);
});
