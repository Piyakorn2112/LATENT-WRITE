/**
 * diff-toggle-sequence.cjs — OLD vs NEW toggle, same click, same measurement.
 *
 * The owner's spec: the toggle in the gradient-orb era (b3788cf..21d6410, all
 * byte-identical) was "the perfectly working toggle". After restoring that CSS
 * verbatim, this harness is the proof of fidelity: it drives the SAME class
 * choreography against a6d7caf's stylesheet and against HEAD's, and the two
 * curves must MATCH — peak, timing, and scale-at-slide-end. Any daylight
 * between them means the restore drifted.
 *
 *   node scripts/diff-toggle-sequence.cjs
 */

const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const NEW_CSS = fs.readFileSync(path.join(ROOT, "src", "styles.css"), "utf8");
const OLD_CSS = execFileSync("git", ["show", "a6d7caf:src/styles.css"], { cwd: ROOT, maxBuffer: 64e6 }).toString();

app.commandLine.appendSwitch("force-device-scale-factor", "1");

// Both variants drive the classes the component actually applies; the hold is
// max(MIN_GLASS_ACTIVE_MS, PRESS_ANIMATION_MS), read from the shipping source.
const TSX = fs.readFileSync(path.join(ROOT, "src", "components", "GlassToggle.tsx"), "utf8");
const HOLD = Math.max(
  Number((TSX.match(/const\s+MIN_GLASS_ACTIVE_MS\s*=\s*(\d+)/) || [])[1] || 0),
  Number((TSX.match(/const\s+PRESS_ANIMATION_MS\s*=\s*(\d+)/) || [])[1] || 300),
);

const VARIANTS = [
  { name: "OLD (a6d7caf — the working era)", css: OLD_CSS },
  { name: "NEW (HEAD — restored)", css: NEW_CSS },
];

const page = (css) => `<!doctype html><html><head><meta charset="utf-8"><style>
${css}
html,body{margin:0;padding:40px;background:#f5f6f8;}
</style></head><body>
<button id="tg" class="glass-toggle" role="switch"><span id="kn" class="glass-toggle-knob"></span></button>
</body></html>`;

const recorder = () => `(async () => {
  const tg = document.getElementById('tg'), kn = document.getElementById('kn');
  const scale = () => { const t = getComputedStyle(kn).transform;
    if (!t || t === 'none') return 1; const m = t.match(/matrix\\(([^)]+)\\)/);
    return m ? parseFloat(m[1].split(',')[0]) : 1; };
  const left = () => parseFloat(getComputedStyle(kn).left) || 0;
  await new Promise(r => setTimeout(r, 300));
  const out = []; const t0 = performance.now();
  let slid = false, rel = false;
  tg.classList.add('glass-toggle--glass-active','glass-toggle--press-a');   // pointerdown: EXPAND
  await new Promise(res => { const tick = () => {
    const t = performance.now() - t0;
    out.push({ t, s: scale(), l: left() });
    if (!slid && t >= 50) { tg.classList.add('glass-toggle--on'); slid = true; }   // pointerup: SLIDE
    if (!rel && t >= ${HOLD}) {                                                     // SHRINK
      tg.classList.remove('glass-toggle--glass-active','glass-toggle--press-a');
      tg.classList.add('glass-toggle--release-a');
      rel = true;
    }
    if (t < 900) requestAnimationFrame(tick); else res();
  }; requestAnimationFrame(tick); });
  return out;
})()`;

app.whenReady().then(async () => {
  console.log(`\ntoggle click sequence — expand, slide, shrink (hold ${HOLD}ms)\n`);
  const runs = [];
  for (const v of VARIANTS) {
    const win = new BrowserWindow({ width: 600, height: 300, show: false });
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(page(v.css)));
    await new Promise((r) => setTimeout(r, 400));
    const s = await win.webContents.executeJavaScript(recorder());
    setTimeout(() => { try { win.destroy(); } catch { /* window already gone */ } }, 0);

    const peak = Math.max(...s.map((p) => p.s));
    const lFrom = s[0].l, lTo = s[s.length - 1].l;
    const dist = Math.abs(lTo - lFrom) || 1;
    const at = (frac) => s.find((p) => Math.abs(p.l - lFrom) >= dist * frac);
    const half = at(0.5), done = at(0.98);
    const fullAt = s.find((p) => p.s >= peak - 0.01);
    const end = s[s.length - 1];
    const r = {
      name: v.name,
      peak,
      fullAt: fullAt ? fullAt.t : null,
      halfScale: half ? half.s : null,
      doneAt: done ? done.t : null,
      doneScale: done ? done.s : null,
      endScale: end.s,
    };
    runs.push(r);
    console.log(`  ${r.name}`);
    console.log(`    peak scale ................. ${r.peak.toFixed(3)}`);
    console.log(`    full size reached at ....... ${r.fullAt === null ? "-" : Math.round(r.fullAt) + "ms"}`);
    console.log(`    slide 50% done ............. scale then ${r.halfScale === null ? "-" : r.halfScale.toFixed(3)}`);
    console.log(`    slide complete at .......... ${r.doneAt === null ? "-" : Math.round(r.doneAt) + "ms"}  (scale then ${r.doneScale === null ? "-" : r.doneScale.toFixed(3)})`);
    console.log(`    scale at 900ms ............. ${r.endScale.toFixed(3)}`);
    console.log("");
  }

  // ★ The gate: HEAD must match the working era. Scale tolerances cover frame
  // quantisation (one rAF at peak spring velocity moves scale by ~0.05); time
  // tolerance covers scheduling jitter between two separate windows.
  const [o, n] = runs;
  const fails = [];
  const close = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol;
  if (!close(o.peak, n.peak, 0.03)) fails.push(`peak differs: ${o.peak.toFixed(3)} vs ${n.peak.toFixed(3)}`);
  if (!close(o.doneScale, n.doneScale, 0.06)) fails.push(`scale at slide-end differs: ${o.doneScale?.toFixed(3)} vs ${n.doneScale?.toFixed(3)}`);
  if (!close(o.fullAt, n.fullAt, 40)) fails.push(`full-size time differs: ${Math.round(o.fullAt)}ms vs ${Math.round(n.fullAt)}ms`);
  if (!close(o.endScale, n.endScale, 0.03)) fails.push(`settled scale differs: ${o.endScale.toFixed(3)} vs ${n.endScale.toFixed(3)}`);

  if (fails.length === 0) console.log("PASS — HEAD reproduces the working era's click curve.");
  else for (const f of fails) console.log(`FAIL — ${f}`);
  app.exit(fails.length ? 1 : 0);
});
