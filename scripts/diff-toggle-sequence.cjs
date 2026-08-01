/**
 * diff-toggle-sequence.cjs — OLD vs NEW toggle, same click, same measurement.
 *
 * The sequence assertion needs a ground truth, not a threshold I invented. The
 * user says the expand/slide/shrink order "has already been done and working",
 * so the working version is the specification: run a real click against
 * a6d7caf's stylesheet (keyframes, --glass-active/--press-a) and against the
 * current one (transitions, --pressed), and compare the same numbers.
 *
 *   node scripts/diff-toggle-sequence.cjs
 *
 * Reports, for each: peak scale, scale at the slide's halfway point, and when
 * full size is reached relative to the slide.
 */

const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const NEW_CSS = fs.readFileSync(path.join(ROOT, "src", "styles.css"), "utf8");
const OLD_CSS = execFileSync("git", ["show", "a6d7caf:src/styles.css"], { cwd: ROOT, maxBuffer: 64e6 }).toString();

app.commandLine.appendSwitch("force-device-scale-factor", "1");

// Each variant states how its own press/release is driven, because that is
// exactly what changed between them.
const VARIANTS = [
  {
    name: "OLD (a6d7caf: keyframes, hold 300)",
    css: OLD_CSS,
    hold: 300,
    press: "tg.classList.add('glass-toggle--glass-active','glass-toggle--press-a')",
    release: "tg.classList.remove('glass-toggle--glass-active','glass-toggle--press-a');tg.classList.add('glass-toggle--release-a')",
  },
  {
    name: "NEW (transitions, hold from source)",
    css: NEW_CSS,
    hold: Number((fs.readFileSync(path.join(ROOT, "src", "components", "GlassToggle.tsx"), "utf8")
      .match(/const\s+MIN_PRESS_MS\s*=\s*(\d+)/) || [])[1] || 300),
    press: "tg.classList.add('glass-toggle--pressed')",
    release: "tg.classList.remove('glass-toggle--pressed')",
  },
];

const page = (css) => `<!doctype html><html><head><meta charset="utf-8"><style>
${css}
html,body{margin:0;padding:40px;background:#f5f6f8;}
</style></head><body>
<button id="tg" class="glass-toggle" role="switch"><span id="kn" class="glass-toggle-knob"></span></button>
</body></html>`;

const recorder = (v) => `(async () => {
  const tg = document.getElementById('tg'), kn = document.getElementById('kn');
  const scale = () => { const t = getComputedStyle(kn).transform;
    if (!t || t === 'none') return 1; const m = t.match(/matrix\\(([^)]+)\\)/);
    return m ? parseFloat(m[1].split(',')[0]) : 1; };
  const left = () => parseFloat(getComputedStyle(kn).left) || 0;
  await new Promise(r => setTimeout(r, 300));
  const out = []; const t0 = performance.now();
  let slid = false, rel = false;
  ${v.press};                                   // pointerdown: EXPAND
  await new Promise(res => { const tick = () => {
    const t = performance.now() - t0;
    out.push({ t, s: scale(), l: left() });
    if (!slid && t >= 50) { tg.classList.add('glass-toggle--on'); slid = true; }   // pointerup: SLIDE
    if (!rel && t >= ${v.hold}) { ${v.release}; rel = true; }                      // SHRINK
    if (t < 900) requestAnimationFrame(tick); else res();
  }; requestAnimationFrame(tick); });
  return out;
})()`;

app.whenReady().then(async () => {
  console.log("\ntoggle click sequence — expand, slide, shrink\n");
  for (const v of VARIANTS) {
    const win = new BrowserWindow({ width: 600, height: 300, show: false });
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(page(v.css)));
    await new Promise((r) => setTimeout(r, 400));
    const s = await win.webContents.executeJavaScript(recorder(v));
    setTimeout(() => { try { win.destroy(); } catch { /* window already gone */ } }, 0);

    const peak = Math.max(...s.map((p) => p.s));
    const lFrom = s[0].l, lTo = s[s.length - 1].l;
    const dist = Math.abs(lTo - lFrom) || 1;
    const at = (frac) => s.find((p) => Math.abs(p.l - lFrom) >= dist * frac);
    const half = at(0.5), done = at(0.98);
    const fullAt = s.find((p) => p.s >= peak - 0.01);
    console.log(`  ${v.name}`);
    console.log(`    peak scale ................. ${peak.toFixed(3)}`);
    console.log(`    full size reached at ....... ${fullAt ? Math.round(fullAt.t) : "-"}ms`);
    console.log(`    slide 50% done at .......... ${half ? Math.round(half.t) : "-"}ms  (scale then ${half ? half.s.toFixed(3) : "-"})`);
    console.log(`    slide complete at .......... ${done ? Math.round(done.t) : "-"}ms  (scale then ${done ? done.s.toFixed(3) : "-"})`);
    console.log("");
  }
  app.exit(0);
});
