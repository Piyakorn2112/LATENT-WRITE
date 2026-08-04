/**
 * probe-glass-stutter.cjs — frame times WHILE THE GLASS IS MOVING.
 *
 * The analysis panel slides on a 0.90s transform, which moves several glass
 * surfaces for ~54 frames. A steady-state profile says nothing about that: the
 * engine is idle-free when nothing moves, and the question is what it costs
 * when everything does.
 *
 * Measures the frame interval across a full open/close cycle and reports the
 * long frames — the ones a reader sees as judder — with the canvas engine on
 * and off, in the same session, same content.
 *
 *   npm run dev                       # in another shell
 *   electron scripts/probe-glass-stutter.cjs
 */
const { app, BrowserWindow } = require("electron");
const BASE = process.env.GLASS_PROBE_URL || "http://localhost:5173/";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch("force-device-scale-factor", "2");
// ★ WITHOUT THESE THE MEASUREMENT SILENTLY STOPS. requestAnimationFrame is
//   throttled the moment Chromium decides the window is backgrounded or
//   occluded, and the first version of this probe reported 242 frames for run
//   one and ZERO for runs two through four — which reads as "the engine did
//   nothing" rather than "the instrument stopped".
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const NOVEL = {
  meta: { title: "Verification", author: "harness", description: "" },
  chapters: [{
    id: "v1", number: 1, title: "The Brother Marries",
    content: Array.from({ length: 24 }, (_, i) =>
      `Paragraph ${i + 1}. She had been thinking about it for a long time, and she wondered whether he had understood what he was saying. He came upon the house at dusk and the light fell across the cold stone of the hall.`).join("\n\n"),
  }],
};
const PREFS = {
  hasSeenOnboarding: true,
  typography: { fontFamily: "georgia", fontSize: 18, lineHeight: 1.7, measure: 70 },
  goals: { dailyWords: 0 }, funMode: false, debugPanel: false,
  storyNlpEnabled: true, splitView: false, intelMode: "auto",
};

/** Record frame intervals in the page while the panel animates. */
const RUN = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const chevron = [...document.querySelectorAll(".analysis-tab")]
    .find((b) => !b.classList.contains("analysis-tab--settings"));
  if (!chevron) return { error: "no panel toggle found" };

  // Let the first frames settle before recording: a load spike is not judder.
  await sleep(400);
  const frames = [];
  let last = performance.now();
  let recording = true;
  const tick = () => {
    const now = performance.now();
    frames.push(now - last);
    last = now;
    if (recording) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // Three open/close cycles, each animation is 0.90s.
  for (let i = 0; i < 3; i++) {
    chevron.click();
    await sleep(1100);
    chevron.click();
    await sleep(1100);
  }
  recording = false;
  await sleep(80);

  const f = frames.slice(3).sort((a, b) => a - b);
  const at = (p) => f[Math.min(f.length - 1, Math.floor(f.length * p))] ?? 0;
  return {
    frames: f.length,
    median: at(0.5), p90: at(0.9), p99: at(0.99), worst: f[f.length - 1] ?? 0,
    over20: f.filter((v) => v > 20).length,
    over33: f.filter((v) => v > 33).length,
    engine: window.__lqgCanvas ? window.__lqgCanvas().map((s) => ({
      cls: s.cls, paints: s.paints, reflows: s.reflows })) : null,
  };
})()`;

async function measure(win, canvasOn) {
  const url = canvasOn ? BASE : `${BASE}${BASE.includes("?") ? "&" : "?"}lqg-canvas=0`;
  await win.loadURL(url);
  await wait(2500);
  await win.webContents.executeJavaScript(`(() => {
    localStorage.setItem("glass-editor:novel-v1", ${JSON.stringify(JSON.stringify(NOVEL))});
    localStorage.setItem("glass-editor:current-chapter-v1", "v1");
    localStorage.setItem("latentwrite:prefs-v1", ${JSON.stringify(JSON.stringify(PREFS))});
    return true;
  })()`);
  await win.loadURL(url);
  win.show();
  win.focus();
  await wait(9000);
  const r = await win.webContents.executeJavaScript(RUN);
  // A run that recorded no frames measured nothing; say so rather than
  // averaging a zero into the result.
  if (!r.error && r.frames < 60) r.error = `only ${r.frames} frames recorded — rAF was throttled`;
  return r;
}

app.whenReady().then(async () => {
  // ★ A VISIBLE, HARDWARE-ACCELERATED WINDOW. An offscreen or hidden window does
  //   not composite the way the app does, and judder is a compositing story.
  const win = new BrowserWindow({
    width: 1512, height: 950, show: true,
    webPreferences: { backgroundThrottling: false },
  });

  const rows = [];
  for (const on of [true, false, true, false]) {
    const r = await measure(win, on);
    if (r.error) { console.error(`${on ? "canvas" : "svg"} run failed: ${r.error}`); app.exit(2); return; }
    rows.push({ on, ...r });
  }

  console.log("\nFRAME TIMES DURING 3 PANEL OPEN/CLOSE CYCLES (0.90s transform each)\n");
  console.log("engine   frames   median     p90     p99    worst   >20ms   >33ms");
  for (const r of rows) {
    console.log(
      `${(r.on ? "canvas" : "svg").padEnd(8)} ${String(r.frames).padStart(6)} ` +
      `${r.median.toFixed(1).padStart(8)} ${r.p90.toFixed(1).padStart(7)} ` +
      `${r.p99.toFixed(1).padStart(7)} ${r.worst.toFixed(1).padStart(8)} ` +
      `${String(r.over20).padStart(7)} ${String(r.over33).padStart(7)}`);
  }

  const canvas = rows.filter((r) => r.on);
  const svg = rows.filter((r) => !r.on);
  const avg = (xs, k) => xs.reduce((a, b) => a + b[k], 0) / xs.length;
  console.log(`\nmean p99:   canvas ${avg(canvas, "p99").toFixed(1)}ms  ·  svg ${avg(svg, "p99").toFixed(1)}ms`);
  console.log(`mean >20ms: canvas ${avg(canvas, "over20").toFixed(1)}  ·  svg ${avg(svg, "over20").toFixed(1)}`);

  const last = canvas[canvas.length - 1];
  if (last.engine) {
    console.log(`\nwhat the engine did during the animation:`);
    for (const e of last.engine) {
      console.log(`  ${e.cls.slice(0, 38).padEnd(38)} full repaints ${String(e.paints).padStart(4)} ` +
        `· cheap re-renders ${String(e.reflows).padStart(4)}`);
    }
    console.log(`  (re-renders should dominate: a moving surface needs its SHAPE`);
    console.log(`   updated, not its backdrop rebuilt)`);
  }
  app.exit(0);
});
