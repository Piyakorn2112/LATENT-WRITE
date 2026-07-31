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

const REALISTIC = process.env.REALISTIC === "1";
// Stand-in for the timeline SVG: coloured nodes + hairlines, the kind of
// content that actually sits behind the inspector in the product.
const CANVAS_SIM = Array.from({ length: 26 }, (_, i) => {
  const x = 40 + i * 70, y = 120 + ((i * 37) % 160);
  const c = ["#f43f5e", "#10b981", "#f59e0b", "#a855f7", "#60a5fa"][i % 5];
  return `<div style="position:absolute;left:${x}px;top:${y}px;width:22px;height:22px;border-radius:50%;background:${c}"></div>` +
         `<div style="position:absolute;left:${x}px;top:${y + 30}px;width:150px;height:16px;border-radius:8px;border:1px solid ${c};color:${c};font:9px system-ui;padding:2px 6px">event label ${i}</div>` +
         `<div style="position:absolute;left:0;top:${y + 70}px;width:1900px;height:1px;background:rgba(120,120,120,.35)"></div>`;
}).join("");

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
${CSS}
html,body{margin:0;padding:0;background:#f5f6f8;}
/* Maximum high-frequency backdrop: 1px hard checkerboard. Anything that
   survives this at full contrast is definitively not blurred. */
#bg{position:absolute;inset:0;z-index:0;background-image:
  linear-gradient(45deg,#000 25%,transparent 25%,transparent 75%,#000 75%),
  linear-gradient(45deg,#000 25%,transparent 25%,transparent 75%,#000 75%);
  background-size:4px 4px;background-position:0 0,2px 2px;background-color:#fff;}
/* ★ The overlay scrim is itself a full-viewport backdrop-filter, so with it on
   the checkerboard is already destroyed everywhere and the control region is
   as flat as the panel — the first run of this harness "failed" for exactly
   that reason. Neutralise the scrim so the ONLY blur under test is the
   inspector's own. REALISTIC=1 keeps the real scrim and panel fill instead, to
   look at what the writer actually sees rather than to assert on it. */
.timeline-full-overlay{background:transparent !important;
  backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}
</style></head><body>
<div class="timeline-full-overlay" style="animation:none">
  <div class="timeline-full-panel" style="${REALISTIC ? '' : 'background:transparent;box-shadow:none'}">
    <!-- ★ The checkerboard lives INSIDE the panel, and that placement is the
         whole point. .timeline-full-panel carries transform: translateZ(0) and
         contain: layout paint, each of which makes it a BACKDROP ROOT: a
         descendant's backdrop-filter can only see content painted inside it.
         With the checkerboard outside (where this harness first put it) no blur
         is possible even when backdrop-filter is working perfectly, and the
         test then measures nothing but the tint's opacity - which is exactly
         how it reported a confident 6/6 pass on a surface that was not blurring
         anything. In the product the backdrop root is the right one: what sits
         behind the rail IS the timeline canvas, inside the panel. -->
    <div id="bg"></div>
    <div class="timeline-full-body">
      <div class="timeline-full-scroll"><div style="width:2000px;height:600px;position:relative">${REALISTIC ? CANVAS_SIM : ''}</div></div>
      <!-- ★ CONTROL: identical geometry and identical tint, backdrop-filter OFF.
           Comparing the panel against the RAW backdrop conflates two things -
           an opaque tint hides the checkerboard just as well as a blur does,
           which is how the first version of this harness reported a confident
           pass without ever proving the blur ran. Against this control the tint
           cancels and only the blur can explain a difference. -->
      <aside class="timeline-inspector" id="ctrl" style="animation:none;right:auto;left:14px;backdrop-filter:none;-webkit-backdrop-filter:none">
        <div class="timeline-inspector-head"><span class="timeline-inspector-eyebrow">control</span></div>
      </aside>
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
      ctrlRect: (() => { const c = document.getElementById('ctrl').getBoundingClientRect();
        return { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) }; })(),
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
  const c = {
    x: Math.round(probe.ctrlRect.x * s), y: Math.round(probe.ctrlRect.y * s),
    w: Math.round(probe.ctrlRect.w * s), h: Math.round(probe.ctrlRect.h * s),
  };
  // Same tint, no blur — the honest control.
  const control = highFreq(bmp, W, { x: c.x + pad, y: c.y + Math.round(140 * s), w: c.w - pad * 2, h: Math.round(120 * s) });
  const outside = highFreq(bmp, W, { x: Math.round(8 * s), y: r.y + Math.round(140 * s), w: Math.round(30 * s), h: Math.round(120 * s) });

  const results = [];
  const ok = (label, cond, detail) => { results.push({ label, cond, detail }); };

  ok("backdrop-filter is declared", /blur/.test(probe.backdrop || ""), probe.backdrop);
  ok("blur actually FIRES (vs SAME-TINT control, so the tint cancels)",
    control > 4 && inside < control * 0.4,
    `blurred ${inside.toFixed(1)} vs same-tint unblurred ${control.toFixed(1)} (need < ${(control * 0.4).toFixed(1)}), raw backdrop ${outside.toFixed(1)}`);
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
