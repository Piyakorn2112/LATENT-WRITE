/**
 * probe-glass-realtime.cjs — does the glass keep up?
 *
 * "Laggy" is a claim about LATENCY, not about average frame time: a surface
 * that refreshes every fourth frame can still profile at 60fps while visibly
 * trailing the page it sits over. So this measures the thing that was actually
 * wrong — how many surfaces get a fresh backdrop per frame during a continuous
 * scroll, and what the shared DOM walk costs.
 *
 *   npm run dev                       # in another shell
 *   electron scripts/probe-glass-realtime.cjs
 */
const { app, BrowserWindow } = require("electron");
const BASE = process.env.GLASS_PROBE_URL || "http://localhost:5173/";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch("force-device-scale-factor", "2");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const NOVEL = {
  meta: { title: "Verification", author: "harness", description: "" },
  chapters: [{
    id: "v1", number: 1, title: "The Brother Marries",
    content: Array.from({ length: 40 }, (_, i) =>
      `Paragraph ${i + 1}. She had been thinking about it for a long time, and she wondered whether he had understood what he was saying. He came upon the house at dusk and the light fell across the cold stone of the hall.`).join("\n\n"),
  }],
};
const PREFS = {
  hasSeenOnboarding: true,
  typography: { fontFamily: "georgia", fontSize: 18, lineHeight: 1.7, measure: 70 },
  goals: { dailyWords: 0 }, funMode: false, debugPanel: false,
  storyNlpEnabled: true, splitView: false, intelMode: "auto",
};

/** Scroll for N frames, sampling the engine's counters each frame. */
const RUN = `(async () => {
  const t = window.__lqgCanvasTotals;
  if (!t) return { error: "engine not present (kill switch on?)" };
  const sc = [...document.querySelectorAll("*")].find((e) =>
    e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY))
    || document.scrollingElement;

  const frames = [];
  let prev = t();
  let last = performance.now();
  const N = 180;
  await new Promise((done) => {
    let i = 0;
    const step = () => {
      const now = performance.now();
      sc.scrollTop = (sc.scrollTop + 6) % Math.max(1, sc.scrollHeight - sc.clientHeight);
      const cur = t();
      frames.push({
        dt: now - last,
        paints: cur.paints - prev.paints,
        lists: cur.lists - prev.lists,
        listMs: cur.lastListMs,
        surfaces: cur.surfaces,
      });
      prev = cur; last = now;
      if (++i < N) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
  });

  const f = frames.slice(10);
  const dts = f.map((x) => x.dt).sort((a, b) => a - b);
  const at = (p) => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))] ?? 0;
  const surfaces = f[f.length - 1].surfaces;
  const painted = f.reduce((a, x) => a + x.paints, 0);
  const lists = f.reduce((a, x) => a + x.lists, 0);
  const listMs = f.map((x) => x.listMs).sort((a, b) => a - b);
  return {
    frames: f.length, surfaces,
    medianDt: at(0.5), p95Dt: at(0.95), worstDt: dts[dts.length - 1],
    paintsPerFrame: painted / f.length,
    listsPerFrame: lists / f.length,
    medianListMs: listMs[Math.floor(listMs.length / 2)] ?? 0,
    worstListMs: listMs[listMs.length - 1] ?? 0,
    framesWithNoPaint: f.filter((x) => x.paints === 0).length,
  };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1512, height: 950, show: true,
    webPreferences: { backgroundThrottling: false },
  });
  await win.loadURL(BASE);
  await wait(2500);
  await win.webContents.executeJavaScript(`(() => {
    localStorage.setItem("glass-editor:novel-v1", ${JSON.stringify(JSON.stringify(NOVEL))});
    localStorage.setItem("glass-editor:current-chapter-v1", "v1");
    localStorage.setItem("latentwrite:prefs-v1", ${JSON.stringify(JSON.stringify(PREFS))});
    return true;
  })()`);
  await win.loadURL(BASE);
  win.focus();
  await wait(9000);

  const r = await win.webContents.executeJavaScript(RUN);
  if (r.error) { console.error(r.error); app.exit(2); return; }

  console.log(`\n━━ CONTINUOUS SCROLL, ${r.frames} frames, ${r.surfaces} glass surfaces ━━\n`);
  console.log(`frame time        median ${r.medianDt.toFixed(1)}ms · p95 ${r.p95Dt.toFixed(1)}ms · worst ${r.worstDt.toFixed(1)}ms`);
  console.log(`display list      ${r.listsPerFrame.toFixed(2)} per frame · ${r.medianListMs.toFixed(2)}ms median · ${r.worstListMs.toFixed(2)}ms worst`);
  console.log(`surface repaints  ${r.paintsPerFrame.toFixed(2)} per frame ` +
    `(all ${r.surfaces} fresh every frame would be ${r.surfaces.toFixed(2)})`);
  console.log(`frames where NO surface refreshed: ${r.framesWithNoPaint}`);

  const ratio = r.paintsPerFrame / Math.max(1, r.surfaces);
  console.log(`\n→ ${(100 * ratio).toFixed(0)}% of surfaces refresh per frame.`);
  console.log(`  Below ~90% the glass visibly trails the page it sits over;`);
  console.log(`  ONE display list per frame is what makes 100% affordable.`);
  app.exit(0);
});
