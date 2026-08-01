/**
 * verify-toggle-tap.cjs — does a REAL TAP still play the full expand + shrink?
 *
 * The spec, in the owner's words: "the knob should still play the expand and
 * shrink back even when the user just taps". A tap is pointerdown then
 * pointerup ~50ms later, far shorter than the 300ms swell, so the component
 * must hold the pressed look regardless of how briefly the finger was down.
 *
 * This drives the SHIPPING component with genuine PointerEvents through
 * /toggle-verify.html, rather than simulating its class lifecycle — which is
 * what every earlier harness did, and is where the bugs kept hiding.
 *
 *   VITE_URL=http://localhost:5178 node scripts/verify-toggle-tap.cjs
 */
const { app, BrowserWindow } = require("electron");
const BASE = process.env.VITE_URL || "http://localhost:5178";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 700, height: 500, show: false });
  await win.loadURL(`${BASE}/toggle-verify.html`);
  await wait(1800);

  const run = async (downMs) => win.webContents.executeJavaScript(`(async () => {
    const out = []; const t0 = performance.now();
    window.__tap(${downMs});
    await new Promise(res => { const tick = () => {
      const p = window.__probe(); const t = performance.now() - t0;
      if (p) out.push({ t, ...p });
      if (t < 1000) requestAnimationFrame(tick); else res();
    }; requestAnimationFrame(tick); });
    return out;
  })()`);

  const report = (label, s) => {
    const peak = Math.max(...s.map((p) => p.scale));
    const end = s[s.length - 1];
    const glassFrames = s.filter((p) => p.glass).length;
    const peakAt = Math.round(s.find((p) => p.scale >= peak - 0.01).t);
    const backAt = (() => { const f = s.find((p) => p.t > peakAt && p.scale <= 1.01); return f ? Math.round(f.t) : null; })();
    console.log(`\n  ${label}`);
    console.log(`    peak scale ${peak.toFixed(3)} at ${peakAt}ms, back to rest at ${backAt ?? "-"}ms`);
    console.log(`    toggled on: ${end.on}   glass present for ${glassFrames} frames`);
    return { peak, end, backAt };
  };

  console.log("real component, real pointer events:");
  const quick = report("TAP (50ms down) — the normal click", await run(50));
  await wait(900);
  const instant = report("TAP (10ms down) — the fastest possible", await run(10));

  const fails = [];
  for (const [name, r] of [["50ms", quick], ["10ms", instant]]) {
    if (r.peak < 1.98) fails.push(`${name} tap only reached ${r.peak.toFixed(3)} — expand did not complete`);
    if (Math.abs(r.end.scale - 1) > 0.02) fails.push(`${name} tap never shrank back (ended ${r.end.scale.toFixed(3)})`);
    if (!r.backAt) fails.push(`${name} tap never returned to rest within 1s`);
  }
  console.log("");
  if (!fails.length) console.log("PASS — a tap plays the full expand and shrink.");
  else for (const f of fails) console.log(`FAIL — ${f}`);
  app.exit(fails.length ? 1 : 0);
});
