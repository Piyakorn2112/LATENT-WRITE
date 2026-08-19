/**
 * probe-bg-bisect.cjs — WHICH background work costs the frames.
 *
 * ★★ THE OBVIOUS ANSWER IS WRONG, WHICH IS WHY THIS EXISTS. The app scrolling
 *    while its chip + summary tick runs delivers 38 fps against 120 idle
 *    (probe-bg-schedule.cjs), and every bad frame is GPU-side. But driving the
 *    SAME request bytes at the SAME concurrency straight at the sidecar, with
 *    the same app scrolling beside it, costs nothing at all: 120.5 fps, zero
 *    frames over 25ms, GPU pegged at 98% throughout (probe-gpu-yield.cjs).
 *
 *    A pegged GPU is not the same thing as a starved compositor. So the tick
 *    is not obviously the tenant to blame, and the run log names a second one:
 *    node-llama-cpp printed a model LOAD in the middle of the measurement
 *    window. In max mode the sidecar holds the 4B for chips and summaries
 *    while the review sweep — which passes no tier and no lane — loads the
 *    1.7B into the in-process host and runs beside it.
 *
 *    This harness turns each class of work off in turn and re-measures.
 *
 * ★ EVERY WINDOW STARTS FROM THE SAME COLD STATE. Both engines are unloaded
 *   and the renderer reloaded before each one, because a model load is itself
 *   a candidate cause and a window that inherits a warm engine cannot see it.
 *
 * ★ THE DROP IS AT THE IPC BOUNDARY, not in the app. ipcMain's 'assistant:run'
 *   handler calls a module-local binding, so patching the export does nothing;
 *   the handler is replaced instead. Dropped tasks answer 'busy', which is the
 *   app's own vocabulary for "the runtime is occupied" and keeps the callers
 *   on their normal retry paths.
 *
 *   ./node_modules/.bin/electron scripts/probe-bg-bisect.cjs
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'bench-results');
const DATA = '/tmp/lw-bisect-data';
const PROJECT = '/tmp/lw-bisect-project';
const BOOK = process.env.BOOK
  || '/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels/hollow-iris.txt';
const CHAPTERS = Number(process.env.CHAPTERS || 10);
const SECONDS = Number(process.env.SECONDS || 20);
const REAL_USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'Latent Write');

const BG_TASKS = ['timeline-chips', 'chapter-summary'];
const REVIEW_TASKS = ['scene-review', 'chekhov-review', 'presence-review', 'continuity-adjudication', 'entity-review', 'alias-referent', 'attribution-review'];

/** name → tasks refused for that window, and how long to let things run first. */
const WINDOWS = {
  all:        { drop: [], settleMs: 0 },
  noBg:       { drop: BG_TASKS, settleMs: 0 },
  noReview:   { drop: REVIEW_TASKS, settleMs: 0 },
  none:       { drop: [...BG_TASKS, ...REVIEW_TASKS], settleMs: 0 },
  allSettled: { drop: [], settleMs: 90_000 },
};
const ORDER = (process.env.WINDOWS || 'all,noBg,noReview,none,allSettled')
  .split(',').map((s) => s.trim()).filter((s) => WINDOWS[s]);

// ── seed ────────────────────────────────────────────────────────────────────
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(PROJECT, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
for (const dir of ['models', 'engine']) {
  const real = path.join(REAL_USER_DATA, dir);
  if (fs.existsSync(real)) fs.symlinkSync(real, path.join(DATA, dir));
}
for (const d of ['.renderer', 'anchors', 'drafts', 'canon', 'scene_bank', 'review_logs', 'temp', 'tools']) {
  fs.mkdirSync(path.join(PROJECT, d), { recursive: true });
}
function truncateBook(text, n) {
  const marks = [...text.matchAll(/^===CHAPTER \d+:.*===$/gm)];
  return marks.length <= n ? text : text.slice(0, marks[n].index);
}
fs.writeFileSync(path.join(PROJECT, 'novel.txt'), truncateBook(fs.readFileSync(BOOK, 'utf8'), CHAPTERS));
fs.writeFileSync(path.join(PROJECT, '.renderer', 'project.json'),
  JSON.stringify({ name: 'Bisect Book', created: Date.now(), lastOpened: Date.now() }));
fs.writeFileSync(path.join(DATA, 'last-project.json'),
  JSON.stringify({ path: PROJECT, updated: Date.now() }));
process.env.LW_USER_DATA = DATA;

const { app, BrowserWindow, ipcMain } = require('electron');
app.setName('Latent Write');
require(path.join(ROOT, 'electron', 'main.cjs'));
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (w, src) => w.webContents.executeJavaScript(src, true);
const GRAPH_FILE = path.join(PROJECT, '.renderer', 'story-graph.json');
const RENDERER_DIR = path.join(PROJECT, '.renderer');
const SNAPSHOT = '/tmp/lw-bisect-snapshot';

/**
 * ★★ EVERY WINDOW MUST BE OFFERED THE SAME WORK, and the first draft of this
 *    harness was not. The app CACHES its answers on disk — assist-reviews.json
 *    keys review verdicts by chapter+hash+model, and a converged chapter's
 *    lmChipsKey lives in story-graph.json — so window 1 answered the review
 *    questions and windows 2..n found them already asked and ran nothing at
 *    all. That reads as "dropping chips fixed the frames" when what actually
 *    happened is that there was no work left to do. Restoring the post-warm-up
 *    snapshot before each window is the fix.
 */
function snapshotState() {
  fs.rmSync(SNAPSHOT, { recursive: true, force: true });
  fs.cpSync(RENDERER_DIR, SNAPSHOT, { recursive: true });
}
function restoreState() {
  fs.rmSync(RENDERER_DIR, { recursive: true, force: true });
  fs.cpSync(SNAPSHOT, RENDERER_DIR, { recursive: true });
}

// ── the drop, installed over the real IPC handler ───────────────────────────
let DROPPED = new Set();
const RAN = new Map(); // task → { started, ok, failed }
function note(task, field) {
  const r = RAN.get(task) || { started: 0, ok: 0, failed: 0 };
  r[field]++;
  RAN.set(task, r);
}
/**
 * ★ INSTALLED AFTER registerAssistant, NOT AT REQUIRE TIME. main.cjs registers
 *   its handlers on app-ready; claiming the channel first makes ITS handle()
 *   throw "second handler added for 'assistant:run'" and the whole run dies
 *   before the first window.
 */
function installDropHandler() {
  ipcMain.removeHandler('assistant:run');
  ipcMain.handle('assistant:run', runWithDrop);
}
async function runWithDrop(_e, opts) {
  const o = opts || {};
  const task = o.task || 'unknown';
  if (DROPPED.has(task)) {
    note(task, 'failed');
    return { ok: false, error: 'busy', requestId: o.requestId || 'dropped' };
  }
  note(task, 'started');
  const res = await assistant.run(o);
  note(task, res && res.ok ? 'ok' : 'failed');
  return res;
}

function gpuBusy() {
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'AGXAccelerator'], { encoding: 'utf8' });
    const m = out.match(/"Device Utilization %"=(\d+)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}
function cpuOf(pid) {
  if (!pid) return null;
  try {
    const out = execFileSync('/bin/ps', ['-o', '%cpu=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return out ? Number(out) : null;
  } catch { return null; }
}
function serverPid() {
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-f', 'llama-server'], { encoding: 'utf8' }).trim();
    return out ? Number(out.split('\n')[0]) : null;
  } catch { return null; }
}

const TRACE = (seconds) => `(() => new Promise((resolve) => {
  const longtasks = [];
  let po = null;
  try {
    po = new PerformanceObserver((list) => { for (const e of list.getEntries()) longtasks.push({ start: e.startTime, dur: e.duration }); });
    po.observe({ type: 'longtask', buffered: false });
  } catch {}
  const scroller = [...document.querySelectorAll('*')]
    .map((el) => ({ el, over: (el.scrollHeight || 0) - (el.clientHeight || 0), area: el.clientWidth * el.clientHeight }))
    .filter((x) => x.over > 200 && x.area > 100000)
    .sort((a, b) => b.area - a.area)[0]?.el || document.scrollingElement || document.body;
  const maxScroll = Math.max(0, (scroller.scrollHeight || 0) - (scroller.clientHeight || 0));
  const gaps = []; const t0 = performance.now(); let last = t0;
  const step = (t) => {
    gaps.push(t - last); last = t;
    if (maxScroll > 0) { const p = ((t - t0) % 4000) / 4000; scroller.scrollTop = maxScroll * (p < 0.5 ? p * 2 : 2 - p * 2); }
    if (t - t0 < ${seconds} * 1000) requestAnimationFrame(step); else finish();
  };
  const finish = () => {
    try { po && po.disconnect(); } catch {}
    const g = gaps.slice(1);
    const sorted = [...g].sort((a, b) => a - b);
    const q = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
    const elapsed = performance.now() - t0;
    let acc = t0, badMain = 0, badGpu = 0;
    for (const gap of g) {
      const start = acc; acc += gap;
      if (gap <= 25) continue;
      if (longtasks.some((L) => L.start < acc && L.start + L.dur > start)) badMain++; else badGpu++;
    }
    resolve({
      frames: g.length, fps: g.length / (elapsed / 1000), median: q(0.5), p95: q(0.95),
      worst: sorted.length ? sorted[sorted.length - 1] : 0,
      over25: g.filter((x) => x > 25).length, over50: g.filter((x) => x > 50).length,
      badMain, badGpu, longtaskMs: Math.round(longtasks.reduce((s, L) => s + L.dur, 0)), maxScroll,
    });
  };
  requestAnimationFrame(step);
}))()`;

function graphState() {
  try {
    const g = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
    const es = Object.values((g.data || g).entries || {});
    const we = es.filter((e) => (e.majorEvents || []).length > 0);
    return { withEvents: we.length, chipsStale: we.filter((e) => !e.lmChipsKey).length, sumStale: we.filter((e) => !e.lmSummaryKey).length };
  } catch { return null; }
}

async function win() {
  for (let i = 0; i < 240; i++) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.webContents.isLoading()) return w;
    await sleep(250);
  }
  throw new Error('no window');
}
function prep(x) {
  x.webContents.setBackgroundThrottling(false);
  x.setSize(1600, 1000); x.center();
  app.focus({ steal: true }); x.show(); x.focus(); x.moveTop();
}
async function setPrefs(w, a) {
  await js(w, `(() => {
    const K = "latentwrite:prefs-v1";
    const p = JSON.parse(localStorage.getItem(K) || "{}");
    p.hasSeenOnboarding = true; p.onbChecklistHidden = true;
    p.assistant = ${JSON.stringify(a)};
    localStorage.setItem(K, JSON.stringify(p));
    return true;
  })()`);
}

async function runWindow(name) {
  const cfg = WINDOWS[name];
  DROPPED = new Set(cfg.drop);
  RAN.clear();

  // Cold both engines: a model load is one of the suspects.
  await assistant.unload().catch(() => {});
  await sleep(2500);

  // ★ QUIESCE BEFORE RESTORING. The renderer still running from the previous
  //   window keeps its state in memory and flushes on a debounce; restoring
  //   the files under a live writer just gets them overwritten. Turn the
  //   assistant off, reload, let it settle, THEN restore, THEN reload into
  //   the window's configuration.
  let w = await win();
  await setPrefs(w, { enabled: false, mode: 'off' });
  w.reload();
  await sleep(4000);
  w = await win();
  restoreState();
  await setPrefs(w, { enabled: true, mode: 'max', tier: 'max' });
  w.reload();
  await sleep(2500);
  w = await win(); prep(w);

  // Wait until SOMETHING assistant-shaped is actually happening, so a window
  // is never a measurement of a machine that had not started yet.
  let started = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const s = assistant.sidecar.status();
    if (s.inflight > 0 || assistant.__hostPid()) { started = true; break; }
    if (cfg.drop.length && [...RAN.values()].some((r) => r.failed > 0)) { started = true; break; }
  }
  if (cfg.settleMs) await sleep(cfg.settleMs);

  const gpu = [], hostCpu = [], srvCpu = [], inflight = [];
  let hostSeen = false;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const g = gpuBusy(); if (g !== null) gpu.push(g);
      const hp = assistant.__hostPid();
      if (hp) hostSeen = true;
      const hc = cpuOf(hp); if (hc !== null) hostCpu.push(hc);
      const sc = cpuOf(serverPid()); if (sc !== null) srvCpu.push(sc);
      inflight.push(assistant.sidecar.status().inflight || 0);
      await sleep(500);
    }
  })();
  const r = await js(w, TRACE(SECONDS));
  sampling = false;
  await sampler;

  const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const row = {
    name, drop: cfg.drop, settleMs: cfg.settleMs, started, ...r,
    gpuAvg: mean(gpu), hostAlive: hostSeen, hostCpuAvg: mean(hostCpu), serverCpuAvg: mean(srvCpu),
    inflightAvg: inflight.length ? +(inflight.reduce((a, b) => a + b, 0) / inflight.length).toFixed(2) : 0,
    ran: Object.fromEntries(RAN), graph: graphState(),
  };
  console.log(
    `  ${name.padEnd(11)}│ ${row.fps.toFixed(1).padStart(5)} fps  p95 ${row.p95.toFixed(1).padStart(6)}ms  worst ${String(Math.round(row.worst)).padStart(4)}ms  ` +
    `>25 ${String(row.over25).padStart(3)} (gpu ${row.badGpu}/main ${row.badMain}) │ ` +
    `host ${row.hostAlive ? 'YES' : 'no '} cpu ${String(row.hostCpuAvg ?? '-').padStart(4)}%  ` +
    `srv cpu ${String(row.serverCpuAvg ?? '-').padStart(4)}%  inflight ${String(row.inflightAvg).padStart(4)}  gpu ${String(row.gpuAvg ?? '-').padStart(3)}%`,
  );
  console.log(`              ran: ${JSON.stringify(row.ran)}`);
  return row;
}

app.whenReady().then(async () => {
  installDropHandler();
  let w = await win(); prep(w);

  console.log(`\n${'═'.repeat(150)}`);
  console.log(`BACKGROUND BISECT — ${CHAPTERS} chapters, ${SECONDS}s windows, scrolling throughout, both engines cold before each`);
  console.log(`${'═'.repeat(150)}\n`);

  // Warm-up: build a story graph entry per chapter with the assistant OFF, so
  // every window opens on a book whose chapters are all stale.
  await setPrefs(w, { enabled: false, mode: 'off' });
  w.reload();
  await sleep(3000);
  w = await win(); prep(w);
  console.log('  paging through the book with the assistant off …');
  for (let c = 1; c < CHAPTERS; c++) {
    w.webContents.send('menu-command', 'next-chapter');
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const g = graphState();
      if (g && g.withEvents >= c + 1) break;
    }
  }
  snapshotState();
  console.log(`  warm: ${JSON.stringify(graphState())}  (snapshotted)\n`);

  const rows = [];
  for (const name of ORDER) rows.push(await runWindow(name));

  const file = path.join(OUT, 'bg-bisect.json');
  fs.writeFileSync(file, JSON.stringify({ chapters: CHAPTERS, seconds: SECONDS, rows }, null, 2));
  console.log(`\nwrote ${file}\n`);
  await assistant.unload().catch(() => {});
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
