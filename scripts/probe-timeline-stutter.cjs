/**
 * probe-timeline-stutter.cjs — the stutter the writer actually reports, on
 * the surface they report it on.
 *
 * The owner's description: open the story timeline sidebar, then the
 * full-screen timeline, while chapter summaries and chips are being written,
 * and the lag is obvious. That surface matters for a reason the editor scene
 * cannot show — the timeline is what DISPLAYS the chips, so every provisional
 * pick the model streams re-renders it, and the frame cost may be main-thread
 * there where it was purely GPU in the editor.
 *
 * ★★ BRACKETED A/B/A, BECAUSE THE UNBRACKETED NUMBERS WERE NOT REPRODUCIBLE.
 *    The same "background work running" window measured 38.3, 75.0 and 118.4
 *    fps across three runs of the earlier harnesses. What moved was WHEN the
 *    window opened relative to a model load and to the tick's own cadence, so
 *    a single before/after pair proves nothing here. Every configuration is
 *    measured between two baselines and reported against their mean.
 *
 * ★ A THROTTLED WINDOW IS NOT A SLOW ONE. Chromium parks rAF on a window it
 *   believes is not being seen, and one earlier row read 1.0 fps with the GPU
 *   at 27% — that is the compositor asleep, not contention. Any window whose
 *   frame rate collapses while the GPU is idle is reported as INVALID rather
 *   than as data.
 *
 * ★ THE TRACE IS BUCKETED. A mean over 60 seconds hides whether the cost is a
 *   two-second stall at a model load or a sustained halving of the frame rate,
 *   and those are different bugs.
 *
 *   ./node_modules/.bin/electron scripts/probe-timeline-stutter.cjs
 *   SCENE=timelineFull SECONDS=45 ./node_modules/.bin/electron scripts/probe-timeline-stutter.cjs
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'bench-results');
const DATA = '/tmp/lw-stutter-data';
const PROJECT = '/tmp/lw-stutter-project';
const BOOK = process.env.BOOK
  || '/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels/hollow-iris.txt';
const CHAPTERS = Number(process.env.CHAPTERS || 12);
const SECONDS = Number(process.env.SECONDS || 30);
const SCENE = process.env.SCENE || 'timelineFull'; // editor | timeline | timelineFull
const REAL_USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'Latent Write');
const RENDERER_DIR = path.join(PROJECT, '.renderer');
const SNAPSHOT = '/tmp/lw-stutter-snapshot';
const GRAPH_FILE = path.join(RENDERER_DIR, 'story-graph.json');

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
const marksOf = (t) => [...t.matchAll(/^===CHAPTER \d+:.*===$/gm)];
const bookText = fs.readFileSync(BOOK, 'utf8');
const marks = marksOf(bookText);
fs.writeFileSync(path.join(PROJECT, 'novel.txt'),
  marks.length <= CHAPTERS ? bookText : bookText.slice(0, marks[CHAPTERS].index));
fs.writeFileSync(path.join(RENDERER_DIR, 'project.json'),
  JSON.stringify({ name: 'Stutter Book', created: Date.now(), lastOpened: Date.now() }));
fs.writeFileSync(path.join(DATA, 'last-project.json'),
  JSON.stringify({ path: PROJECT, updated: Date.now() }));
process.env.LW_USER_DATA = DATA;

const { app, BrowserWindow } = require('electron');
app.setName('Latent Write');
require(path.join(ROOT, 'electron', 'main.cjs'));
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (w, src) => w.webContents.executeJavaScript(src, true);

function gpuBusy() {
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'AGXAccelerator'], { encoding: 'utf8' });
    const m = out.match(/"Device Utilization %"=(\d+)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}
function graphState() {
  try {
    const g = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
    const es = Object.values((g.data || g).entries || {});
    const we = es.filter((e) => (e.majorEvents || []).length > 0);
    return { withEvents: we.length, chipsStale: we.filter((e) => !e.lmChipsKey).length, sumStale: we.filter((e) => !e.lmSummaryKey).length };
  } catch { return null; }
}
function snapshotState() {
  fs.rmSync(SNAPSHOT, { recursive: true, force: true });
  fs.cpSync(RENDERER_DIR, SNAPSHOT, { recursive: true });
}
function restoreState() {
  fs.rmSync(RENDERER_DIR, { recursive: true, force: true });
  fs.cpSync(SNAPSHOT, RENDERER_DIR, { recursive: true });
}

// ── the trace ───────────────────────────────────────────────────────────────
//
// The timeline is not a scroller, so the scene is driven by POINTER motion
// across it instead: the same thing the writer's hand is doing while they read
// it, and enough to keep the glass and the hover layers repainting.
const TRACE = (seconds, scene) => `(() => new Promise((resolve) => {
  const longtasks = [];
  let po = null;
  try {
    po = new PerformanceObserver((list) => { for (const e of list.getEntries()) longtasks.push({ start: e.startTime, dur: e.duration }); });
    po.observe({ type: 'longtask', buffered: false });
  } catch {}
  const loaf = [];
  try {
    const p2 = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < 30) continue;
        loaf.push({ dur: Math.round(e.duration), blocking: Math.round(e.blockingDuration || 0),
          scripts: (e.scripts || []).slice(0, 2).map((x) => ({ d: Math.round(x.duration), fn: x.sourceFunctionName || '', src: String(x.sourceURL || '').split('/').pop() })) });
      }
    });
    p2.observe({ type: 'long-animation-frame', buffered: false });
  } catch {}

  const scroller = [...document.querySelectorAll('*')]
    .map((el) => ({ el, over: (el.scrollHeight || 0) - (el.clientHeight || 0), area: el.clientWidth * el.clientHeight }))
    .filter((x) => x.over > 200 && x.area > 80000)
    .sort((a, b) => b.area - a.area)[0]?.el || null;
  const maxScroll = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;

  const gaps = []; const t0 = performance.now(); let last = t0;
  const step = (t) => {
    gaps.push(t - last); last = t;
    const phase = ((t - t0) % 4000) / 4000;
    const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
    if (maxScroll > 0) scroller.scrollTop = maxScroll * tri;
    // Pointer sweep: hover state on a timeline is real repaint work.
    const x = Math.round(80 + tri * (window.innerWidth - 160));
    const y = Math.round(window.innerHeight * (0.35 + 0.3 * tri));
    document.elementFromPoint(x, y)?.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: x, clientY: y, pointerType: 'mouse',
    }));
    if (t - t0 < ${seconds} * 1000) requestAnimationFrame(step); else finish();
  };
  const finish = () => {
    try { po && po.disconnect(); } catch {}
    const g = gaps.slice(1);
    const sorted = [...g].sort((a, b) => a - b);
    const q = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
    const elapsed = performance.now() - t0;
    let acc = t0, badMain = 0, badGpu = 0;
    const buckets = [];
    let bStart = t0, bFrames = 0, bBad = 0;
    for (const gap of g) {
      const start = acc; acc += gap;
      bFrames++;
      if (gap > 25) {
        bBad++;
        if (longtasks.some((L) => L.start < acc && L.start + L.dur > start)) badMain++; else badGpu++;
      }
      if (acc - bStart >= 10000) { buckets.push({ fps: +(bFrames / ((acc - bStart) / 1000)).toFixed(1), bad: bBad }); bStart = acc; bFrames = 0; bBad = 0; }
    }
    if (bFrames > 0) buckets.push({ fps: +(bFrames / ((acc - bStart) / 1000)).toFixed(1), bad: bBad });
    resolve({
      frames: g.length, fps: g.length / (elapsed / 1000), median: q(0.5), p95: q(0.95), p99: q(0.99),
      worst: sorted.length ? sorted[sorted.length - 1] : 0,
      over25: g.filter((x) => x > 25).length, over50: g.filter((x) => x > 50).length,
      badMain, badGpu, longtasks: longtasks.length,
      longtaskMs: Math.round(longtasks.reduce((s, L) => s + L.dur, 0)),
      buckets, loaf: loaf.sort((a, b) => b.dur - a.dur).slice(0, 5),
      scene: ${JSON.stringify(scene)}, scrollable: maxScroll,
    });
  };
  requestAnimationFrame(step);
}))()`;

/** Put the app on the surface under test and confirm it is really there. */
async function openScene(w, scene) {
  if (scene === 'editor') return { ok: true, what: 'editor' };
  const opened = await js(w, `(() => {
    const btn = document.querySelector('[aria-label="Story graph"]');
    if (!btn) return { ok: false, why: 'no story-graph tab' };
    if (!document.querySelector('.sg-expand-btn')) btn.click();
    return { ok: true };
  })()`);
  if (!opened.ok) return opened;
  await sleep(1500);
  if (scene === 'timelineFull') {
    const full = await js(w, `(() => {
      const b = document.querySelector('.sg-expand-btn');
      if (!b) return { ok: false, why: 'no expand button' };
      b.click();
      return { ok: true };
    })()`);
    if (!full.ok) return full;
    await sleep(2000);
  }
  // ★ The scene has to be VISIBLE, not merely requested. A panel that failed
  //   to mount renders nothing, and nothing is very fast.
  const seen = await js(w, `(() => ({
    sidebar: !!document.querySelector('.sg-expand-btn'),
    full: !!document.querySelector('[class*="tlf-"], .timeline-full, [class*="timeline-full"]'),
    svgNodes: document.querySelectorAll('svg *').length,
    chips: document.querySelectorAll('[class*="chip"]').length,
  }))()`);
  return { ok: true, ...seen };
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

async function measure(w, label) {
  const gpu = [], inflight = [];
  let hostSeen = false, sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const g = gpuBusy(); if (g !== null) gpu.push(g);
      if (assistant.__hostPid()) hostSeen = true;
      inflight.push(assistant.sidecar.status().inflight || 0);
      await sleep(500);
    }
  })();
  const r = await js(w, TRACE(SECONDS, SCENE));
  sampling = false;
  await sampler;
  const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const row = {
    label, ...r,
    gpuAvg: mean(gpu), hostAlive: hostSeen,
    inflightAvg: inflight.length ? +(inflight.reduce((a, b) => a + b, 0) / inflight.length).toFixed(2) : 0,
    dutyPct: inflight.length ? Math.round((100 * inflight.filter((x) => x > 0).length) / inflight.length) : 0,
    graph: graphState(),
  };
  // A collapsed frame rate with an idle GPU is a parked compositor, not load.
  row.invalid = row.fps < 20 && (row.gpuAvg ?? 0) < 50;
  console.log(
    `  ${label.padEnd(12)}│ ${row.fps.toFixed(1).padStart(5)} fps  median ${row.median.toFixed(1).padStart(5)}ms  p95 ${row.p95.toFixed(1).padStart(6)}ms  worst ${String(Math.round(row.worst)).padStart(4)}ms  ` +
    `>25 ${String(row.over25).padStart(4)} (gpu ${row.badGpu}/main ${row.badMain})  ltask ${String(row.longtasks).padStart(3)}/${row.longtaskMs}ms │ ` +
    `duty ${String(row.dutyPct).padStart(3)}%  host ${row.hostAlive ? 'Y' : 'n'}  gpu ${String(row.gpuAvg ?? '-').padStart(3)}%  ` +
    `stale ${row.graph ? `${row.graph.chipsStale}c/${row.graph.sumStale}s` : '?'}${row.invalid ? '   ‼ INVALID (parked compositor)' : ''}`,
  );
  console.log(`               buckets ${row.buckets.map((b) => `${b.fps}fps/${b.bad}bad`).join('  ')}`);
  return row;
}

/** Reload into a configuration, restoring the post-warm-up state first. */
async function reset(assistantPrefs) {
  await assistant.unload().catch(() => {});
  await sleep(2000);
  let w = await win();
  await setPrefs(w, { enabled: false, mode: 'off' });
  w.reload();
  await sleep(3500);
  w = await win();
  restoreState();
  await setPrefs(w, assistantPrefs);
  w.reload();
  await sleep(3000);
  w = await win(); prep(w);
  const scene = await openScene(w, SCENE);
  console.log(`               scene: ${JSON.stringify(scene)}`);
  return w;
}

app.whenReady().then(async () => {
  let w = await win(); prep(w);

  console.log(`\n${'═'.repeat(160)}`);
  console.log(`TIMELINE STUTTER — scene "${SCENE}", ${CHAPTERS} chapters, ${SECONDS}s windows, bracketed baseline/load/baseline`);
  console.log(`${'═'.repeat(160)}\n`);

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
  for (const [label, prefs] of [
    ['base-1', { enabled: false, mode: 'off' }],
    ['load', { enabled: true, mode: 'max', tier: 'max' }],
    ['base-2', { enabled: false, mode: 'off' }],
  ]) {
    w = await reset(prefs);
    if (prefs.enabled) {
      // Do not open the window on a machine that has not started working yet.
      for (let i = 0; i < 60; i++) {
        await sleep(1000);
        if (assistant.sidecar.status().inflight > 0) break;
      }
    }
    rows.push(await measure(w, label));
  }

  const base = rows.filter((r) => r.label.startsWith('base') && !r.invalid);
  const load = rows.find((r) => r.label === 'load');
  const baseFps = base.length ? base.reduce((s, r) => s + r.fps, 0) / base.length : null;
  console.log('');
  if (baseFps && load && !load.invalid) {
    console.log(`  baseline ${baseFps.toFixed(1)} fps  →  under background work ${load.fps.toFixed(1)} fps   ` +
      `(${(100 * (load.fps - baseFps) / baseFps).toFixed(1)}%)   drift between the two baselines ` +
      `${base.length === 2 ? `${(100 * Math.abs(base[0].fps - base[1].fps) / baseFps).toFixed(1)}%` : 'n/a'}`);
    console.log(`  bad frames attributed: ${load.badGpu} GPU · ${load.badMain} main thread  (${load.longtaskMs}ms of longtask)`);
    if (load.loaf.length) {
      console.log('  worst long animation frames under load:');
      for (const L of load.loaf) console.log(`    ${L.dur}ms (blocking ${L.blocking}ms) ${L.scripts.map((x) => `${x.fn || '?'}@${x.src}:${x.d}ms`).join(' ')}`);
    }
  } else {
    console.log('  ‼ no valid comparison — see the INVALID rows above');
  }
  const file = path.join(OUT, `stutter-${SCENE}.json`);
  fs.writeFileSync(file, JSON.stringify({ scene: SCENE, chapters: CHAPTERS, seconds: SECONDS, rows }, null, 2));
  console.log(`\nwrote ${file}\n`);
  await assistant.unload().catch(() => {});
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
