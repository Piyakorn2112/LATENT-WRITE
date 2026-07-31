/**
 * verify-timeline-panel.cjs — proves the timeline inspector is a FLAT BLUR
 * panel, in real Chromium, rather than trusting that the CSS says so.
 *
 * Why this exists: `backdrop-filter` is silently killed by an ancestor with a
 * transform / filter / opacity, and .timeline-full-panel carries
 * `transform: translateZ(0)` + `contain: layout paint`. A blur that does not
 * blur looks fine in the stylesheet and wrong on screen, so the check has to
 * be a pixel measurement, not a read.
 *
 * Method: rebuild the real ancestor chain, put a 1px HARD CHECKERBOARD behind
 * it (maximum high-frequency energy), then compare mean |neighbour delta|
 * inside the panel against the bare checkerboard.
 *
 *   blur working  → high-frequency detail destroyed → delta collapses
 *   blur killed   → checkerboard still sharp under a flat tint → delta stays
 *
 * It also asserts the panel is NOT liquid glass: no --shadow-glass, and no
 * ::before rim gradient (the two tells of the glass treatment, which must not
 * stack on the glass card this panel sits inside).
 *
 *   node scripts/verify-timeline-panel.cjs
 */

const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const CSS = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");
const OUT = path.join(__dirname, "..", ".glass-shots");

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("force-color-profile", "srgb");

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
${CSS}
html,body{margin:0;padding:0;background:#f5f6f8;}
/* Maximum high-frequency backdrop: 1px hard checkerboard. Anything that
   survives this at full contrast is definitively not blurred. */
#bg{position:fixed;inset:0;background-image:
  linear-gradient(45deg,#000 25%,transparent 25%,transparent 75%,#000 75%),
  linear-gradient(45deg,#000 25%,transparent 25%,transparent 75%,#000 75%);
  background-size:4px 4px;background-position:0 0,2px 2px;background-color:#fff;}
/* ★ The overlay scrim is itself a full-viewport backdrop-filter, so with it on
   the checkerboard is already destroyed everywhere and the control region is
   as flat as the panel — the first run of this harness "failed" for exactly
   that reason. Neutralise the scrim so the ONLY blur under test is the
   inspector's own. */
.timeline-full-overlay{background:transparent !important;
  backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}
</style></head><body>
<div id="bg"></div>
<div class="timeline-full-overlay" style="animation:none">
  <div class="timeline-full-panel" style="background:transparent;box-shadow:none">
    <div class="timeline-full-body">
      <div class="timeline-full-scroll"><div style="width:2000px;height:600px"></div></div>
      <aside class="timeline-inspector" id="insp" style="animation:none">
        <div class="timeline-inspector-head"><span class="timeline-inspector-eyebrow">Chapter 4</span></div>
        <h3 class="timeline-inspector-title">The Quiet Ward</h3>
        <div class="timeline-inspector-scroll">
          <p class="timeline-inspector-quiet">Body copy must stay legible over the backdrop.</p>
        </div>
      </aside>
    </div>
  </div>
</div>
</body></html>`;

// Mean absolute horizontal neighbour delta over a rect — a direct read of how
// much high-frequency energy survives.
function highFreq(bitmap, W, rect) {
  let sum = 0, n = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w - 1; x++) {
      const i = (y * W + x) * 4;
      const j = i + 4;
      for (let c = 0; c < 3; c++) sum += Math.abs(bitmap[i + c] - bitmap[j + c]);
      n += 3;
    }
  }
  return n ? sum / n : 0;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200, height: 760, show: false,
    webPreferences: { offscreen: false, backgroundThrottling: false },
  });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(PAGE));
  await new Promise((r) => setTimeout(r, 700));

  // Geometry + the "is it glass?" checks, from the live computed styles.
  const probe = await win.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('insp');
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const before = getComputedStyle(el, '::before');
    return {
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      // ★ capturePage returns DEVICE pixels; getBoundingClientRect returns CSS
      // pixels. Without this the sample rect lands somewhere else entirely on
      // any HiDPI screen, and reads the raw backdrop as if it were the panel.
      dpr: window.devicePixelRatio,
      backdrop: cs.backdropFilter || cs.webkitBackdropFilter,
      shadow: cs.boxShadow,
      border: cs.border,
      background: cs.backgroundColor,
      rimContent: before.content,
      rimBg: before.backgroundImage,
    };
  })()`);

  const img = await win.capturePage();
  fs.mkdirSync(OUT, { recursive: true });
  const shot = path.join(OUT, "timeline-inspector.png");
  fs.writeFileSync(shot, img.toPNG());
  const { width: W } = img.getSize();
  const bmp = img.getBitmap();

  const s = probe.dpr || 1;
  const r = {
    x: Math.round(probe.rect.x * s), y: Math.round(probe.rect.y * s),
    w: Math.round(probe.rect.w * s), h: Math.round(probe.rect.h * s),
  };
  const pad = Math.round(24 * s);
  const inside = highFreq(bmp, W, { x: r.x + pad, y: r.y + Math.round(140 * s), w: r.w - pad * 2, h: Math.round(120 * s) });
  const outside = highFreq(bmp, W, { x: Math.round(60 * s), y: r.y + Math.round(140 * s), w: Math.round(200 * s), h: Math.round(120 * s) });

  const results = [];
  const ok = (label, cond, detail) => { results.push({ label, cond, detail }); };

  ok("backdrop-filter is declared", /blur/.test(probe.backdrop || ""), probe.backdrop);
  ok("blur actually FIRES (high-frequency energy collapses)",
    outside > 20 && inside < outside * 0.25,
    `inside ${inside.toFixed(1)} vs backdrop ${outside.toFixed(1)} (need < ${(outside * 0.25).toFixed(1)})`);
  ok("NOT liquid glass: no glass shadow", probe.shadow === "none", probe.shadow);
  ok("NOT liquid glass: no ::before rim gradient",
    probe.rimContent === "none" || probe.rimBg === "none",
    `content ${probe.rimContent}, bg ${probe.rimBg}`);
  ok("has a plain outline", /1px solid/.test(probe.border), probe.border);
  ok("tint is translucent (backdrop shows through)",
    /rgba\(/.test(probe.background) && !/, 1\)$/.test(probe.background), probe.background);

  console.log("\ntimeline inspector — flat blur panel:");
  let failed = 0;
  for (const rres of results) {
    console.log(`  ${rres.cond ? "✓" : "✗"} ${rres.label}${rres.cond ? "" : ` — ${rres.detail}`}`);
    if (!rres.cond) failed++;
  }
  console.log(`\nshot: ${shot}`);
  console.log(failed ? `FAILED ${failed}/${results.length}` : `PASS ${results.length}/${results.length}`);
  app.exit(failed ? 1 : 0);
});
