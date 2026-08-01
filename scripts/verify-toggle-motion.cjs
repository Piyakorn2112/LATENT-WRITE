/**
 * verify-toggle-motion.cjs — sample the toggle knob's ACTUAL motion curve.
 *
 * Screenshots cannot show whether a transition is smooth, and reading the CSS
 * has already misled me twice on this control. So this drives the real
 * stylesheet in real Chromium and records `getComputedStyle(knob).transform`
 * and `.left` every animation frame, then looks for the two things that read as
 * "broken": a DISCONTINUITY (a frame-to-frame jump far larger than its
 * neighbours, i.e. a snap) and a curve that never reaches its target.
 *
 *   node scripts/verify-toggle-motion.cjs
 */

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const CSS = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");

// ★ Read the component's own hold constant so the harness tests what SHIPS and
// cannot drift from it. This is the number the bug lived in: the hold must be
// at least as long as the CSS press duration, or a click reverses the swell
// before it ever arrives.
const TSX = fs.readFileSync(path.join(__dirname, "..", "src", "components", "GlassToggle.tsx"), "utf8");
const HOLD_MS = Number((TSX.match(/const\s+MIN_PRESS_MS\s*=\s*(\d+)/) || [])[1] || 0);
// The press duration is the 2nd entry of the pressed rule's transition-duration.
const PRESSED_RULE = CSS.slice(CSS.indexOf(".glass-toggle--pressed .glass-toggle-knob"));
const PRESS_MS = Math.round(
  parseFloat((PRESSED_RULE.match(/transition-duration:\s*[\d.]+s,\s*([\d.]+)s/) || [])[1] || "0") * 1000,
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

  tg.classList.add('glass-toggle--pressed');
  const press = await sample(500);

  tg.classList.remove('glass-toggle--pressed');
  const release = await sample(500);

  // The on/off slide, which is a different transition (left, not transform).
  tg.classList.add('glass-toggle--on');
  const slide = await sample(600);
  tg.classList.remove('glass-toggle--on');
  await new Promise((r) => setTimeout(r, 500));

  // ★ A REAL CLICK: press, then release after the component's hold, exactly as
  // GlassToggle does. This is the case the user actually performs, and the one
  // the earlier harness never exercised — it drove the classes with 500ms gaps,
  // which quietly guaranteed the swell always had time to finish.
  const clickOut = [];
  const t0 = performance.now();
  tg.classList.add('glass-toggle--pressed');   // pointerdown: EXPAND
  let slid = false, releasedAt = null;
  await new Promise((res) => {
    const tick = () => {
      const t = performance.now() - t0;
      clickOut.push({ t, s: readScale(), l: readLeft() });
      if (!slid && t >= 50) { tg.classList.add('glass-toggle--on'); slid = true; }  // pointerup: SLIDE
      if (releasedAt === null && t >= HOLD) { tg.classList.remove('glass-toggle--pressed'); releasedAt = t; }  // SHRINK
      if (t < 900) requestAnimationFrame(tick); else res();
    };
    requestAnimationFrame(tick);
  });

  return { rest, press, release, slide, click: clickOut, releasedAt };
})()`;

function analyse(name, samples, key, label) {
  const vals = samples.map((s) => s[key]);
  const first = vals[0];
  const last = vals[vals.length - 1];
  const deltas = [];
  for (let i = 1; i < vals.length; i++) deltas.push(Math.abs(vals[i] - vals[i - 1]));
  const maxD = Math.max(...deltas);

  // ★ MEASURE ONLY WHILE IT IS MOVING.
  //
  // The first version of this took max/median over the whole 500ms window and
  // reported a 38x "snap" on all three transitions — on motion that is in fact
  // correct. The window is 500ms and the transition is 280ms, so two thirds of
  // the frames are already settled at delta ~0 and drag the median to nothing.
  // Any eased motion then looks like a discontinuity. A spring
  // (cubic-bezier(.34,1.56,.64,1)) legitimately peaks around 3x its average
  // velocity, so the honest question is whether one frame stands out among the
  // frames that are ACTUALLY ANIMATING.
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
  const press = analyse("PRESS", d.press, "s", "scale should ramp 1 -> 2 and SETTLE, not overshoot");
  const release = analyse("RELEASE", d.release, "s", "scale should settle back to 1");
  const slide = analyse("SLIDE (on)", d.slide, "l", "left should travel to the far end");
  const click = analyse("REAL CLICK", d.click, "s", `press then release after the component's ${HOLD_MS}ms hold`);
  console.log(`    press duration in CSS ${PRESS_MS}ms, component hold ${HOLD_MS}ms, released at ${Math.round(d.releasedAt)}ms`);

  // ★ WHAT THIS CAN AND CANNOT ASSERT.
  //
  // The snap RATIO is reported but NOT gated, and that is a deliberate retreat.
  // A ratio gate was tried at 8x and at 4x and failed all three transitions on
  // motion that is provably correct — because the easing is a spring
  // (cubic-bezier(.34,1.56,.64,1)), whose velocity peaks early and then crawls
  // through a long settle, so peak-over-median is legitimately ~6-12x. Two
  // thresholds in a row that only ever produced false alarms is a metric
  // problem, not a code problem, and gating on it would have sent me hunting a
  // bug that was not there.
  //
  // What IS checkable without a model of the easing: every transition ENDS on
  // its declared target, the spring's overshoot stays within sane bounds, and
  // the motion is spread over real frames rather than jumping in one.
  const fails = [];
  if (Math.abs(press.last - 2) > 0.02) fails.push(`press never reaches 2 (ended ${press.last.toFixed(3)})`);
  if (Math.abs(release.last - 1) > 0.02) fails.push(`release never settles at 1 (ended ${release.last.toFixed(3)})`);
  // ★ The press easing, cubic-bezier(0.22, 0.61, 0.36, 1), is a DECELERATE:
  // it must arrive at 2 and stop. Any overshoot means the knob is being driven
  // by the base spring (0.34, 1.56, 0.64, 1) again, which is the bug that made
  // the swell bounce past its size and snap back. Same for the release.
  if (press.peak > 2.03) fails.push(`press OVERSHOOTS (${press.peak.toFixed(3)}) — wrong easing, should settle on 2`);
  if (release.trough < 0.97) fails.push(`release UNDERSHOOTS (${release.trough.toFixed(3)}) — wrong easing, should settle on 1`);
  if (press.moving < 8) fails.push(`press animated over only ${press.moving} frames`);
  // ★ THE ONE THAT MATTERS. On a real click the swell must actually ARRIVE.
  if (HOLD_MS < PRESS_MS) {
    fails.push(`hold ${HOLD_MS}ms is SHORTER than the ${PRESS_MS}ms press — the swell reverses before it lands`);
  }
  if (click.peak < 1.98) {
    fails.push(`REAL CLICK never reaches full size (peak ${click.peak.toFixed(3)} of 2.000) — stunted swell`);
  }

  // ★ THE SEQUENCE, which is the actual specification: the knob EXPANDS, then
  // SLIDES WHILE EXPANDED, then SHRINKS. Checking the three moves separately
  // (as this harness used to) can never catch the failure where the shrink
  // starts early and the knob slides small — which is precisely what a hold
  // shorter than the press produced.
  const cs = d.click;
  const lFrom = cs[0].l, lTo = cs[cs.length - 1].l;
  const dist = Math.abs(lTo - lFrom) || 1;
  const atFrac = (f) => cs.find((p) => Math.abs(p.l - lFrom) >= dist * f);
  const half = atFrac(0.5), done = atFrac(0.98);
  console.log(`\n  SEQUENCE — slide ${lFrom.toFixed(0)} -> ${lTo.toFixed(0)}px;` +
    ` 50% at ${half ? Math.round(half.t) : "-"}ms (scale ${half ? half.s.toFixed(3) : "-"}),` +
    ` complete at ${done ? Math.round(done.t) : "-"}ms (scale ${done ? done.s.toFixed(3) : "-"})`);

  // ★ THRESHOLD TAKEN FROM THE KNOWN-GOOD VERSION, NOT FROM INTUITION.
  // scripts/diff-toggle-sequence.cjs replays this exact click against
  // a6d7caf's stylesheet — the version the owner confirms was working — and
  // measures: slide completes at 182ms with the knob still at scale 1.932,
  // full size arriving at 257ms. My first attempt at this gate demanded 1.8 at
  // the slide's HALFWAY point, which the working version fails (1.751): I had
  // invented the number. The invariant that actually distinguishes good from
  // broken is that the knob is still near full size WHEN THE SLIDE FINISHES —
  // that is what collapses when the shrink starts too early, which is what a
  // hold shorter than the press caused.
  const scaleAtSlideEnd = done ? done.s : 0;
  if (scaleAtSlideEnd < 1.85) {
    fails.push(`knob has already SHRUNK by the time the slide finishes ` +
      `(scale ${scaleAtSlideEnd.toFixed(3)}, known-good is 1.93) — the iOS order is ` +
      `expand, slide while expanded, THEN shrink`);
  }
  if (release.moving < 8) fails.push(`release animated over only ${release.moving} frames`);
  if (slide.moving < 8) fails.push(`slide animated over only ${slide.moving} frames`);

  console.log("");
  if (fails.length === 0) console.log("PASS — every transition lands on its target, overshoot in range, motion spread over real frames.");
  else for (const f of fails) console.log(`FAIL — ${f}`);
  app.exit(fails.length ? 1 : 0);
});
