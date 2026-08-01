/**
 * verify-toggle-motion.cjs — sample the toggle knob's ACTUAL motion curve.
 *
 * ★ THE SHIPPED CHOREOGRAPHY IS THE b3788cf ORIGINAL, RESTORED VERBATIM. The
 * owner confirmed the keyframe version ("expand, slide, shrink — like an iOS
 * toggle") was the working one, and a commit-by-commit hash of the CSS block
 * proved it was byte-identical from b3788cf through 21d6410 — the only thing
 * that ever changed it was my transition rewrite, which is therefore the
 * regression this harness must never let back in. So the drivers here are the
 * REAL classes the component applies:
 *
 *   pointerdown  → --glass-active + --press-a   (press keyframe, 0.3s, to scale 2)
 *   pointerup    → --on                          (left slides on its own transition)
 *   after max(MIN_GLASS_ACTIVE_MS, PRESS_ANIMATION_MS)
 *                → drop press classes, add --release-a  (release keyframe, 0.24s, to 1)
 *
 * Both constants are read from GlassToggle.tsx so the harness tests what ships.
 *
 *   node scripts/verify-toggle-motion.cjs
 */

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const CSS = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");
const TSX = fs.readFileSync(path.join(__dirname, "..", "src", "components", "GlassToggle.tsx"), "utf8");

const MIN_ACTIVE = Number((TSX.match(/const\s+MIN_GLASS_ACTIVE_MS\s*=\s*(\d+)/) || [])[1] || 0);
const PRESS_MS = Number((TSX.match(/const\s+PRESS_ANIMATION_MS\s*=\s*(\d+)/) || [])[1] || 0);
// The component starts the release after max(MIN_GLASS_ACTIVE_MS - elapsed,
// PRESS_ANIMATION_MS - elapsed) — i.e. never before the press keyframe lands.
const HOLD_MS = Math.max(MIN_ACTIVE, PRESS_MS);
// The press keyframe's CSS duration, to cross-check against the component.
const CSS_PRESS_MS = Math.round(
  parseFloat((CSS.match(/--press-a \.glass-toggle-knob \{\s*animation:[^;]*?([\d.]+)s/) || [])[1] || "0") * 1000,
);

app.commandLine.appendSwitch("force-device-scale-factor", "1");

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
${CSS}
html,body{margin:0;padding:40px;background:#f5f6f8;}
</style></head><body>
<button id="tg" class="glass-toggle" role="switch"><span id="kn" class="glass-toggle-knob liquid-glass-control-knob"></span></button>
</body></html>`;

// Record scaleX from the computed transform matrix, plus `left`, each frame.
const RECORDER = (HOLD) => `(async () => {
  const HOLD = ${HOLD};
  const tg = document.getElementById('tg');
  const kn = document.getElementById('kn');
  const press = () => tg.classList.add('glass-toggle--glass-active','glass-toggle--press-a');
  const release = () => { tg.classList.remove('glass-toggle--glass-active','glass-toggle--press-a');
    tg.classList.add('glass-toggle--release-a'); };
  const clearAll = () => tg.classList.remove('glass-toggle--glass-active',
    'glass-toggle--press-a','glass-toggle--press-b',
    'glass-toggle--release-a','glass-toggle--release-b','glass-toggle--on');
  const readScale = () => {
    const t = getComputedStyle(kn).transform;
    if (!t || t === 'none') return 1;
    const m = t.match(/matrix\\(([^)]+)\\)/);
    return m ? parseFloat(m[1].split(',')[0]) : 1;
  };
  const readLeft = () => parseFloat(getComputedStyle(kn).left) || 0;

  const sample = (ms) => new Promise((res) => {
    const out = [];
    const t0 = performance.now();
    const tick = () => {
      out.push({ t: performance.now() - t0, s: readScale(), l: readLeft() });
      if (performance.now() - t0 < ms) requestAnimationFrame(tick); else res(out);
    };
    requestAnimationFrame(tick);
  });

  // Settle first so we start from a known resting state.
  await new Promise((r) => setTimeout(r, 300));
  const rest = { s: readScale(), l: readLeft() };

  press();
  const pressed = await sample(500);

  release();
  const released = await sample(500);
  tg.classList.remove('glass-toggle--release-a');

  // The on/off slide, which is a transition on left (not part of any keyframe).
  tg.classList.add('glass-toggle--on');
  const slide = await sample(600);
  clearAll();
  await new Promise((r) => setTimeout(r, 500));

  // ★ A REAL CLICK, sequenced exactly as GlassToggle sequences it: pointerdown
  // presses, pointerup at ~50ms flips --on, and the release begins only once
  // the press keyframe has landed (the component's HOLD).
  const clickOut = [];
  const t0 = performance.now();
  press();                                        // pointerdown: EXPAND
  let slid = false, releasedAt = null;
  await new Promise((res) => {
    const tick = () => {
      const t = performance.now() - t0;
      clickOut.push({ t, s: readScale(), l: readLeft() });
      if (!slid && t >= 50) { tg.classList.add('glass-toggle--on'); slid = true; }  // pointerup: SLIDE
      if (releasedAt === null && t >= HOLD) { release(); releasedAt = t; }          // SHRINK
      if (t < 900) requestAnimationFrame(tick); else res();
    };
    requestAnimationFrame(tick);
  });

  return { rest, press: pressed, release: released, slide, click: clickOut, releasedAt };
})()`;

function analyse(name, samples, key, label) {
  const vals = samples.map((s) => s[key]);
  const first = vals[0];
  const last = vals[vals.length - 1];
  const deltas = [];
  for (let i = 1; i < vals.length; i++) deltas.push(Math.abs(vals[i] - vals[i - 1]));
  const maxD = Math.max(...deltas);

  // Measure only while it is moving — a 500ms window around a 300ms move drags
  // the median to zero and makes correct easing look like a snap (see the
  // metric post-mortem in git history; the ratio is reported, never gated).
  const moving = deltas.filter((d) => d > maxD * 0.02);
  const median = [...moving].sort((a, b) => a - b)[Math.floor(moving.length / 2)] || 0;
  const snapRatio = median > 1e-9 ? maxD / median : (maxD > 0.02 ? Infinity : 0);
  const peak = Math.max(...vals);
  const trough = Math.min(...vals);
  console.log(`\n  ${name} — ${label}`);
  console.log(`    start ${first.toFixed(3)}  end ${last.toFixed(3)}  peak ${peak.toFixed(3)}  trough ${trough.toFixed(3)}`);
  console.log(`    animating frames ${moving.length}/${vals.length}  max step ${maxD.toFixed(4)}  median step (moving) ${median.toFixed(4)}  ratio ${snapRatio === Infinity ? "inf" : snapRatio.toFixed(1)}x`);
  return { first, last, peak, trough, maxD, median, snapRatio, vals, moving: moving.length };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 700, height: 400, show: false });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(PAGE));
  await new Promise((r) => setTimeout(r, 500));
  const d = await win.webContents.executeJavaScript(RECORDER(HOLD_MS));

  console.log(`\ntoggle knob motion  (resting scale ${d.rest.s.toFixed(3)}, left ${d.rest.l.toFixed(1)}px)`);
  const press = analyse("PRESS", d.press, "s", "keyframe should ramp 1 -> 2 and hold (forwards)");
  const release = analyse("RELEASE", d.release, "s", "keyframe should ramp 2 -> 1");
  const slide = analyse("SLIDE (on)", d.slide, "l", "left should travel to the far end");
  const click = analyse("REAL CLICK", d.click, "s", `press, slide at 50ms, release at the component's ${HOLD_MS}ms hold`);
  console.log(`    press keyframe in CSS ${CSS_PRESS_MS}ms, component PRESS_ANIMATION_MS ${PRESS_MS}ms, released at ${Math.round(d.releasedAt)}ms`);

  const fails = [];
  if (Math.abs(press.last - 2) > 0.02) fails.push(`press never reaches 2 (ended ${press.last.toFixed(3)})`);
  if (Math.abs(release.last - 1) > 0.02) fails.push(`release never settles at 1 (ended ${release.last.toFixed(3)})`);
  // The keyframe easing, cubic-bezier(0.22, 0.61, 0.36, 1), is a decelerate: it
  // must arrive and stop, both directions.
  if (press.peak > 2.03) fails.push(`press OVERSHOOTS (${press.peak.toFixed(3)}) — wrong easing`);
  if (release.trough < 0.97) fails.push(`release UNDERSHOOTS (${release.trough.toFixed(3)}) — wrong easing`);
  if (press.moving < 8) fails.push(`press animated over only ${press.moving} frames`);
  // ★ The constant the regression lived in: the component must never start the
  // release before the press keyframe has landed.
  if (HOLD_MS < CSS_PRESS_MS) {
    fails.push(`component hold ${HOLD_MS}ms is SHORTER than the ${CSS_PRESS_MS}ms press keyframe — the swell reverses mid-flight`);
  }
  if (PRESS_MS !== CSS_PRESS_MS) {
    fails.push(`PRESS_ANIMATION_MS (${PRESS_MS}) no longer matches the CSS keyframe (${CSS_PRESS_MS}ms) — the release timer and the animation have drifted apart`);
  }
  if (click.peak < 1.98) {
    fails.push(`REAL CLICK never reaches full size (peak ${click.peak.toFixed(3)} of 2.000) — stunted swell`);
  }

  // ★ THE SEQUENCE, which is the actual specification: EXPAND, SLIDE WHILE
  // EXPANDED, THEN SHRINK. The gate number comes from the known-good version
  // measured by scripts/diff-toggle-sequence.cjs (scale 1.93 when the slide
  // completes), not from intuition.
  const cs = d.click;
  const lFrom = cs[0].l, lTo = cs[cs.length - 1].l;
  const dist = Math.abs(lTo - lFrom) || 1;
  const atFrac = (f) => cs.find((p) => Math.abs(p.l - lFrom) >= dist * f);
  const half = atFrac(0.5), done = atFrac(0.98);
  console.log(`\n  SEQUENCE — slide ${lFrom.toFixed(0)} -> ${lTo.toFixed(0)}px;` +
    ` 50% at ${half ? Math.round(half.t) : "-"}ms (scale ${half ? half.s.toFixed(3) : "-"}),` +
    ` complete at ${done ? Math.round(done.t) : "-"}ms (scale ${done ? done.s.toFixed(3) : "-"})`);

  const scaleAtSlideEnd = done ? done.s : 0;
  if (scaleAtSlideEnd < 1.85) {
    fails.push(`knob has already SHRUNK by the time the slide finishes ` +
      `(scale ${scaleAtSlideEnd.toFixed(3)}, known-good is 1.93) — the iOS order is ` +
      `expand, slide while expanded, THEN shrink`);
  }
  if (release.moving < 8) fails.push(`release animated over only ${release.moving} frames`);
  if (slide.moving < 8) fails.push(`slide animated over only ${slide.moving} frames`);

  console.log("");
  if (fails.length === 0) console.log("PASS — every move lands on its target and the click keeps the iOS order.");
  else for (const f of fails) console.log(`FAIL — ${f}`);
  app.exit(fails.length ? 1 : 0);
});
