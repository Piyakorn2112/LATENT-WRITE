/**
 * probe-bg-schedule.cjs — what the background chip/summary loop costs the
 * writer's frame rate, measured in the real app on a real book.
 *
 * ★★ THE PREVIOUS SMOOTHNESS HARNESS WAS BLIND, and this one is built around
 *    the reason why. probe-ub-smoothness.cjs drove a SYNTHETIC llama-server
 *    beside a mostly-static app window and reported every configuration at an
 *    identical 120.0 fps — including `-ub 2048`, the positive control it was
 *    supposed to reject. Two things were missing: the load was not the app's
 *    own (so the renderer did none of the React work the real loop causes),
 *    and the scene demanded almost nothing of the compositor.
 *
 *    So: the real main process, the real chip + summary tick against the real
 *    sidecar, a real manuscript, and a scene that is CONTINUOUSLY SCROLLING
 *    while the measurement runs. The lag being chased is the writer scrolling
 *    or typing while chapters converge behind them; anything less is a
 *    different experiment.
 *
 * ★★ EVERY BAD FRAME IS ATTRIBUTED, because "the GPU is saturated" and "the
 *    renderer is busy" are different bugs with different fixes and they
 *    produce the same symptom. A frame gap that OVERLAPS a longtask is the
 *    main thread; a gap with no longtask under it is the GPU or the
 *    compositor. The split is the finding, not the fps.
 *
 * ★ THE LOAD MUST PROVE ITSELF. `sidecar.status().inflight` is sampled from
 *   the main process throughout each window; a window whose duty cycle is
 *   zero measured an idle machine and is discarded, not reported as smooth.
 *
 * Windows:
 *   loaded  — assistant on max, chapters still stale, the tick churning
 *   idle    — same scene, same scroll, assistant off
 *
 *   ./node_modules/.bin/electron scripts/probe-bg-schedule.cjs
 *   CHAPTERS=10 SECONDS=20 ./node_modules/.bin/electron scripts/probe-bg-schedule.cjs
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'bench-results');
const DATA = '/tmp/lw-bgsched-data';
const PROJECT = '/tmp/lw-bgsched-project';
const BOOK = process.env.BOOK
  || '/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels/hollow-iris.txt';
const CHAPTERS = Number(process.env.CHAPTERS || 10);
const SECONDS = Number(process.env.SECONDS || 20);
const REAL_USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'Latent Write');

// ── seed, before the app module loads ───────────────────────────────────────
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(PROJECT, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// ★ The 2.5GB of weights and the engine are SHARED WITH THE REAL INSTALL by
//   symlink. A fresh userData is what makes this run reproducible; making it
//   re-download the model would make it impossible.
for (const dir of ['models', 'engine']) {
  const real = path.join(REAL_USER_DATA, dir);
  if (fs.existsSync(real)) fs.symlinkSync(real, path.join(DATA, dir));
  else console.log(`  !! ${dir} missing from the real userData — the run will stall`);
}

for (const d of ['.renderer', 'anchors', 'drafts', 'canon', 'scene_bank', 'review_logs', 'temp', 'tools']) {
  fs.mkdirSync(path.join(PROJECT, d), { recursive: true });
}
/** The first CHAPTERS chapters, cut at a real chapter boundary. A whole
 *  174-chapter book spends the probe's budget on deterministic analysis. */
function truncateBook(text, n) {
  const marks = [...text.matchAll(/^===CHAPTER \d+:.*===$/gm)];
  if (marks.length <= n) return text;
  return text.slice(0, marks[n].index);
}
const book = truncateBook(fs.readFileSync(BOOK, 'utf8'), CHAPTERS);
fs.writeFileSync(path.join(PROJECT, 'novel.txt'), book);
fs.writeFileSync(path.join(PROJECT, '.renderer', 'project.json'),
  JSON.stringify({ name: 'Probe Book', created: Date.now(), lastOpened: Date.now() }));
fs.writeFileSync(path.join(DATA, 'last-project.json'),
  JSON.stringify({ path: PROJECT, updated: Date.now() }));
process.env.LW_USER_DATA = DATA;

const { app, BrowserWindow } = require('electron');
app.setName('Latent Write');
require(path.join(ROOT, 'electron', 'main.cjs'));
// Same module instance main.cjs holds — the sidecar's own inflight counter.
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (w, src) => w.webContents.executeJavaScript(src, true);

// ── the GPU witness ─────────────────────────────────────────────────────────
function gpuBusy() {
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'AGXAccelerator'], { encoding: 'utf8' });
    const m = out.match(/"Device Utilization %"=(\d+)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

// ── the frame + longtask trace, run inside the renderer ─────────────────────
//
// ★ SCROLLING IS PART OF THE MEASUREMENT, not setup. The editor is scrolled
//   every frame for the whole window so the compositor is doing the work a
//   writer's is doing when they notice the lag.
const TRACE = (seconds) => `(() => new Promise((resolve) => {
  const longtasks = [];
  let po = null;
  try {
    po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longtasks.push({ start: e.startTime, dur: e.duration, name: e.name });
    });
    po.observe({ type: 'longtask', buffered: false });
  } catch { /* older engine */ }
  let loaf = [];
  let po2 = null;
  try {
    po2 = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < 25) continue;
        const s = (e.scripts || []).map((x) => ({ dur: Math.round(x.duration), src: x.sourceURL || x.name || '', fn: x.sourceFunctionName || '' }));
        loaf.push({ start: Math.round(e.startTime), dur: Math.round(e.duration), blocking: Math.round(e.blockingDuration || 0), scripts: s.slice(0, 3) });
      }
    });
    po2.observe({ type: 'long-animation-frame', buffered: false });
  } catch { /* not supported */ }

  // ★ THE SCROLLER IS FOUND, NOT NAMED. A class guess that misses leaves the
  //   scene static and the probe measures nothing — the exact failure mode of
  //   the harness this one replaces. Pick the biggest actually-scrollable box.
  const scroller = [...document.querySelectorAll('*')]
    .map((el) => ({ el, over: (el.scrollHeight || 0) - (el.clientHeight || 0), area: el.clientWidth * el.clientHeight }))
    .filter((x) => x.over > 200 && x.area > 100000)
    .sort((a, b) => b.area - a.area)[0]?.el || document.scrollingElement || document.body;
  const maxScroll = Math.max(0, (scroller.scrollHeight || 0) - (scroller.clientHeight || 0));

  const gaps = [];
  const t0 = performance.now();
  let last = t0;
  let n = 0;
  const step = (t) => {
    gaps.push(t - last);
    last = t;
    // A triangle wave down the chapter and back: real content moving under
    // the glass, never parked at an edge where nothing repaints.
    if (maxScroll > 0) {
      const period = 4000;
      const phase = ((t - t0) % period) / period;
      scroller.scrollTop = maxScroll * (phase < 0.5 ? phase * 2 : 2 - phase * 2);
    }
    n++;
    if (t - t0 < ${seconds} * 1000) requestAnimationFrame(step);
    else finish();
  };
  const finish = () => {
    try { po && po.disconnect(); } catch {}
    try { po2 && po2.disconnect(); } catch {}
    const g = gaps.slice(1);
    const sorted = [...g].sort((a, b) => a - b);
    const q = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
    const elapsed = performance.now() - t0;
    // ★ THE ATTRIBUTION. A gap is walked back to its own start time and asked
    //   whether a longtask was running underneath it.
    let acc = t0;
    let badMain = 0, badGpu = 0;
    for (const gap of g) {
      const start = acc; acc += gap;
      if (gap <= 25) continue;
      const overlapped = longtasks.some((L) => L.start < acc && L.start + L.dur > start);
      if (overlapped) badMain++; else badGpu++;
    }
    resolve({
      frames: g.length,
      fps: g.length / (elapsed / 1000),
      median: q(0.5), p95: q(0.95), worst: sorted.length ? sorted[sorted.length - 1] : 0,
      over25: g.filter((x) => x > 25).length,
      over50: g.filter((x) => x > 50).length,
      badMain, badGpu,
      longtasks: longtasks.length,
      longtaskMs: Math.round(longtasks.reduce((s, L) => s + L.dur, 0)),
      loaf: loaf.sort((a, b) => b.dur - a.dur).slice(0, 6),
      maxScroll,
      scrollerTag: scroller.className || scroller.tagName,
    });
  };
  requestAnimationFrame(step);
}))()`;

// ── one window ──────────────────────────────────────────────────────────────
async function measure(w, label, seconds) {
  const gpu = [];
  const duty = [];
  let stop = false;
  const sampler = (async () => {
    while (!stop) {
      const s = assistant.sidecar.status();
      duty.push(s.inflight || 0);
      const g = gpuBusy();
      if (g !== null) gpu.push(g);
      await sleep(250);
    }
  })();
  const r = await js(w, TRACE(seconds));
  stop = true;
  await sampler;
  const busy = duty.filter((d) => d > 0).length;
  const row = {
    label,
    ...r,
    dutyPct: duty.length ? (100 * busy) / duty.length : 0,
    maxInflight: duty.length ? Math.max(...duty) : 0,
    gpuAvg: gpu.length ? gpu.reduce((a, b) => a + b, 0) / gpu.length : null,
    gpuMax: gpu.length ? Math.max(...gpu) : null,
  };
  console.log(
    `  ${label.padEnd(10)}… ${row.fps.toFixed(1)} fps   median ${row.median.toFixed(1)}ms   ` +
    `p95 ${row.p95.toFixed(1)}ms   worst ${Math.round(row.worst)}ms   ` +
    `>25ms ${row.over25} (main ${row.badMain} / gpu ${row.badGpu})   ` +
    `longtask ${row.longtasks}/${row.longtaskMs}ms   duty ${row.dutyPct.toFixed(0)}%  ` +
    `inflight≤${row.maxInflight}  gpu ${row.gpuAvg === null ? '-' : Math.round(row.gpuAvg)}%`,
  );
  return row;
}

async function win() {
  for (let i = 0; i < 240; i++) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.webContents.isLoading()) return w;
    await sleep(250);
  }
  throw new Error('no window');
}

async function setPrefs(w, assistantPrefs) {
  await js(w, `(() => {
    const KEY = "latentwrite:prefs-v1";
    const raw = localStorage.getItem(KEY);
    const p = raw ? JSON.parse(raw) : {};
    p.hasSeenOnboarding = true;
    p.onbChecklistHidden = true;
    p.assistant = ${JSON.stringify(assistantPrefs)};
    localStorage.setItem(KEY, JSON.stringify(p));
    return true;
  })()`);
}

const GRAPH_FILE = path.join(PROJECT, '.renderer', 'story-graph.json');
/**
 * What the tick still has to do, read from the app's OWN persisted graph.
 *
 * ★ THE GRAPH IS NOT IN localStorage WHEN A PROJECT IS OPEN. story-graph.ts
 *   writes through saveProjectState and only falls back to localStorage when
 *   that fails, so the first version of this probe polled an empty key for
 *   ten minutes and reported "graph n/a" while the app was working fine.
 */
function graphState() {
  try {
    const g = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
    const es = Object.values((g.data || g).entries || {});
    const withEvents = es.filter((e) => (e.majorEvents || []).length > 0);
    return {
      entries: es.length,
      withEvents: withEvents.length,
      chipsStale: withEvents.filter((e) => !e.lmChipsKey).length,
      sumStale: withEvents.filter((e) => !e.lmSummaryKey).length,
    };
  } catch { return null; }
}

/**
 * Next chapter.
 *
 * ★ NOT THE KEYBOARD. App.tsx's shortcut handler returns immediately under
 *   Electron — "the application menu owns every accelerator" — so Alt+Right
 *   from sendInputEvent is swallowed and the probe pages nowhere. The menu
 *   forwards on the 'menu-command' channel, which is the surface to drive.
 */
function nextChapter(w) {
  w.webContents.send('menu-command', 'next-chapter');
}

app.whenReady().then(async () => {
  let w = await win();
  const prep = (win_) => {
    win_.webContents.setBackgroundThrottling(false);
    win_.setSize(1600, 1000);
    win_.center();
    app.focus({ steal: true });
    win_.show(); win_.focus(); win_.moveTop();
  };
  prep(w);

  console.log(`\n${'═'.repeat(104)}`);
  console.log(`BACKGROUND SCHEDULE — ${CHAPTERS} chapters, ${SECONDS}s windows, scrolling throughout`);
  console.log(`${'═'.repeat(104)}\n`);

  // ── warm-up: give the tick something to do ────────────────────────────────
  //
  // ★★ A STORY GRAPH ENTRY IS BUILT ONLY FOR THE CHAPTER THE WRITER IS ON.
  //    Booting the app and waiting produced ONE entry, already converged, and
  //    a probe that then measured an idle machine. The load this is chasing is
  //    a book whose chapters are all stale at once — which is what happens
  //    after the writer pages through them, and what happens to every chapter
  //    at once when the assistant mode is switched (the key carries the model
  //    id). So: page through the book with the assistant OFF, then turn it on.
  await setPrefs(w, { enabled: false, mode: 'off' });
  w.reload();
  await sleep(3000);
  w = await win(); prep(w);
  console.log('  paging through the book with the assistant off …');
  for (let c = 1; c < CHAPTERS; c++) {
    nextChapter(w);
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const g = graphState();
      if (g && g.entries >= c + 1) break;
    }
    const g = graphState();
    process.stdout.write(`\r    chapter ${c + 1}/${CHAPTERS} — ${g ? g.entries : 0} entries, ${g ? g.withEvents : 0} with events   `);
  }
  console.log('');
  const warm = graphState();
  console.log(`  warm: ${JSON.stringify(warm)}\n`);

  // ── the loaded window ─────────────────────────────────────────────────────
  await setPrefs(w, { enabled: true, mode: 'max', tier: 'max' });
  w.reload();
  await sleep(2000);
  w = await win(); prep(w);
  console.log('  waiting for the sidecar to take the first units …');
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const st = assistant.sidecar.status();
    if (i % 5 === 0) console.log(`    t+${(i + 1) * 2}s  ${JSON.stringify(graphState())}  sidecar alive=${st.alive} inflight=${st.inflight}`);
    if (st.alive && st.inflight > 0) break;
  }
  console.log(`  loaded: ${JSON.stringify(graphState())}  sidecar=${JSON.stringify(assistant.sidecar.status())}\n`);

  const rows = [];
  rows.push(await measure(w, 'loaded', SECONDS));
  const afterLoaded = graphState();

  // ── the idle window: same scene, same scroll, no background work ─────────
  await setPrefs(w, { enabled: false, mode: 'off' });
  w.reload();
  await sleep(4000);
  w = await win(); prep(w);
  assistant.sidecar.stop('probe-idle-window');
  await sleep(3000);
  rows.push(await measure(w, 'idle', SECONDS));

  console.log('');
  const file = path.join(OUT, 'bg-schedule.json');
  fs.writeFileSync(file, JSON.stringify({ chapters: CHAPTERS, seconds: SECONDS, warm, afterLoaded, rows }, null, 2));
  console.log(`  converged during the loaded window: ${JSON.stringify(afterLoaded)}`);
  console.log(`\nwrote ${file}\n`);
  for (const r of rows) {
    if (r.loaf && r.loaf.length) {
      console.log(`  ${r.label} worst long animation frames:`);
      for (const L of r.loaf) console.log(`    ${L.dur}ms (blocking ${L.blocking}ms) ${L.scripts.map((x) => `${x.fn || '?'}@${String(x.src).split('/').pop()}:${x.dur}ms`).join(' ')}`);
    }
  }
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
