/**
 * probe-render-attribution.cjs — where the long frames actually go.
 *
 * ★★ THE HOLE IN EVERY EARLIER ATTRIBUTION. Six harnesses reported the same
 *    thing about the stuttering windows: hundreds of milliseconds lost, and
 *    "0ms of blocking script", which I read as "the renderer was not asked to
 *    do anything, so this is GPU contention". That inference is wrong.
 *    `longtask` and `blockingDuration` cover SCRIPT ONLY. Style, layout and
 *    paint are not tasks — a frame that spends 400ms recalculating and
 *    repainting a two-thousand-node SVG reports zero blocking script and looks
 *    exactly like a starved compositor.
 *
 *    The one thing present in every window that stuttered and absent from
 *    every window that did not is the app's OWN tick: harness-driven decoding
 *    never calls setStoryGraph, and the tick streams provisional chip picks
 *    into it roughly eight times a second per in-flight request, each one
 *    invalidating the memo the whole timeline is derived from.
 *
 *    Long Animation Frame timing separates these properly. This reads
 *    startTime / renderStart / styleAndLayoutStart / duration and splits each
 *    long frame into script, style+layout, and the remainder.
 *
 * ★ THE RENDER COUNT IS MEASURED, NOT ASSUMED. A MutationObserver on the
 *   timeline's SVG counts how often the tree is actually rewritten, so
 *   "the stream re-renders it constantly" is a number rather than a story.
 *
 *   ./node_modules/.bin/electron scripts/probe-render-attribution.cjs
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'bench-results');
const DATA = '/tmp/lw-renderattr-data';
const PROJECT = '/tmp/lw-renderattr-project';
const BOOK = process.env.BOOK
  || '/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels/hollow-iris.txt';
const TEMPLATE = process.env.TEMPLATE || '/tmp/lw-entry-template.json';
const CHAPTERS = Number(process.env.CHAPTERS || 60);
const SECONDS = Number(process.env.SECONDS || 40);
const QUIET_SECONDS = Number(process.env.QUIET_SECONDS || 90);
const REAL_USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'Latent Write');
const RENDERER_DIR = path.join(PROJECT, '.renderer');
const IDMAP_FILE = path.join(RENDERER_DIR, 'chapter-id-map.json');
const GRAPH_FILE = path.join(RENDERER_DIR, 'story-graph.json');

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
fs.writeFileSync(path.join(PROJECT, 'novel.txt'), fs.readFileSync(BOOK, 'utf8'));
fs.writeFileSync(path.join(RENDERER_DIR, 'project.json'),
  JSON.stringify({ name: 'Render Attribution', created: Date.now(), lastOpened: Date.now() }));
fs.writeFileSync(path.join(DATA, 'last-project.json'),
  JSON.stringify({ path: PROJECT, updated: Date.now() }));
process.env.LW_USER_DATA = DATA;

const { app, BrowserWindow } = require('electron');
app.setName('Latent Write');
require(path.join(ROOT, 'electron', 'main.cjs'));
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (w, src) => w.webContents.executeJavaScript(src, true);

/**
 * ★★ THE LONG FRAMES LAND AT THE SAME TIMESTAMPS ACROSS RUNS (~8.3s, ~12.0s
 *    into the window, in both the 512 and 128 micro-batch arms). Identical
 *    timings are a discrete EVENT, not contention — contention smears. So the
 *    engines are watched on the same clock as the frames, and each long frame
 *    is printed with whatever changed near it. Guessing which subsystem it is
 *    has now cost three refuted hypotheses; this asks instead.
 */
/**
 * ★ THE ABLATION. The engine timeline pairs the residual long frames with the
 *   IN-PROCESS HOST being busy (loading at 0.15s, busy 2.1s → 9.2s, frames at
 *   8.3-12.2s) while the sidecar sat idle because the chip tick was gated. So
 *   the remaining cost is the OTHER background consumers — the review sweeps,
 *   adjudication, the referent pass — none of which pass a tier, all of which
 *   therefore land on the in-process host. Refusing them at the IPC boundary
 *   tests that directly; `busy` is the app's own word for "the runtime is
 *   occupied", so callers stay on their normal retry paths.
 */
const HOST_TASKS = ['scene-review', 'chekhov-review', 'presence-review',
  'continuity-adjudication', 'entity-review', 'alias-referent', 'attribution-review'];
let DROPPED = new Set();
const RAN = new Map();
function installDrop() {
  const { ipcMain } = require('electron');
  ipcMain.removeHandler('assistant:run');
  ipcMain.handle('assistant:run', async (_e, opts) => {
    const o = opts || {};
    const task = o.task || 'unknown';
    RAN.set(task, (RAN.get(task) || 0) + 1);
    if (DROPPED.has(task)) return { ok: false, error: 'busy', requestId: o.requestId || 'dropped' };
    return assistant.run(o);
  });
}

const EVENTS = [];
let CLOCK0 = 0;
const evAt = () => +((Date.now() - CLOCK0) / 1000).toFixed(2);
function watchEngines(stopFlag) {
  let lastHost = '';
  let lastSidecar = '';
  return (async () => {
    while (!stopFlag.done) {
      try {
        const hostPid = assistant.__hostPid() || null;
        const st = await assistant.assistantStatus({ tier: 'max' });
        const hostKey = `${hostPid || '-'}|${st.state}`;
        if (hostKey !== lastHost) { EVENTS.push({ t: evAt(), what: `host ${hostKey}` }); lastHost = hostKey; }
        const sc = assistant.sidecar.status();
        const scKey = `${sc.alive ? 'alive' : 'down'}|inflight=${sc.inflight}`;
        if (scKey !== lastSidecar) { EVENTS.push({ t: evAt(), what: `sidecar ${scKey}` }); lastSidecar = scKey; }
      } catch { /* status can throw during a reload */ }
      await sleep(150);
    }
  })();
}

/**
 * ★★ THE GATE MUST NOT PASS BY DOING NOTHING. Deferring background work while
 *    the screen is in use trivially restores the frame rate — a tick that
 *    never runs costs nothing — so every arm reports how many chapters it
 *    actually converged, and the run ends with a QUIET phase that proves the
 *    deferred work still lands once the writer stops.
 */
function stale() {
  try {
    const g = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
    const es = Object.values((g.data || g).entries || {});
    const we = es.filter((e) => (e.majorEvents || []).length > 0);
    return { chips: we.filter((e) => !e.lmChipsKey).length, sums: we.filter((e) => !e.lmSummaryKey).length, total: we.length };
  } catch { return null; }
}

function seedGraph(n) {
  const template = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  const idMap = JSON.parse(fs.readFileSync(IDMAP_FILE, 'utf8'));
  const entries = {};
  for (const ch of idMap.slice(0, n)) {
    const e = JSON.parse(JSON.stringify(template));
    e.chapterId = ch.id; e.chapterNumber = ch.number; e.chapterTitle = ch.title;
    e.contentHash = `attr-${ch.id}`;
    delete e.lmChips; delete e.lmChipsKey;
    delete e.lmSummary; delete e.lmThroughline; delete e.lmSummaryKey;
    entries[ch.id] = e;
  }
  fs.writeFileSync(GRAPH_FILE, JSON.stringify({ version: 1, entries }));
}

const TRACE = (seconds) => `(() => new Promise((resolve) => {
  const loaf = [];
  let loafOk = false;
  try {
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.duration < 25) continue;
        // ★ THE SPLIT THAT MATTERS. startTime → renderStart is script and other
        //   tasks; renderStart → styleAndLayoutStart is rendering callbacks
        //   (rAF, ResizeObserver); styleAndLayoutStart → end is style, layout
        //   and paint. Only the FIRST of those three is a "longtask".
        const script = (e.scripts || []).reduce((s, x) => s + x.duration, 0);
        loaf.push({
          t: Math.round(e.startTime),
          dur: Math.round(e.duration),
          blocking: Math.round(e.blockingDuration || 0),
          scriptMs: Math.round(script),
          preRenderMs: e.renderStart ? Math.round(e.renderStart - e.startTime) : null,
          renderCbMs: (e.renderStart && e.styleAndLayoutStart) ? Math.round(e.styleAndLayoutStart - e.renderStart) : null,
          styleLayoutMs: e.styleAndLayoutStart ? Math.round(e.startTime + e.duration - e.styleAndLayoutStart) : null,
          top: (e.scripts || []).sort((a, b) => b.duration - a.duration).slice(0, 2)
            .map((x) => \`\${x.sourceFunctionName || x.invoker || '?'}:\${Math.round(x.duration)}ms\`),
        });
      }
    });
    po.observe({ type: 'long-animation-frame', buffered: false });
    loafOk = true;
  } catch { /* not supported */ }

  // How often is the timeline's tree actually rewritten?
  let mutations = 0;
  let mutatedNodes = 0;
  const svgRoot = document.querySelector('.timeline-full-overlay svg');
  let mo = null;
  if (svgRoot) {
    mo = new MutationObserver((recs) => {
      mutations++;
      for (const r of recs) mutatedNodes += r.addedNodes.length + r.removedNodes.length + (r.type === 'attributes' ? 1 : 0);
    });
    mo.observe(svgRoot, { subtree: true, childList: true, attributes: true });
  }

  const gaps = []; const t0 = performance.now(); let last = t0;
  const step = (t) => {
    gaps.push(t - last); last = t;
    const phase = ((t - t0) % 4000) / 4000;
    const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
    const x = Math.round(80 + tri * (window.innerWidth - 160));
    const y = Math.round(window.innerHeight * (0.35 + 0.3 * tri));
    document.elementFromPoint(x, y)?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, pointerType: 'mouse' }));
    if (t - t0 < ${seconds} * 1000) requestAnimationFrame(step); else finish();
  };
  const finish = () => {
    try { mo && mo.disconnect(); } catch {}
    const g = gaps.slice(1);
    const sorted = [...g].sort((a, b) => a - b);
    const elapsed = performance.now() - t0;
    const long = loaf.sort((a, b) => b.dur - a.dur);
    const sum = (k) => long.reduce((s, x) => s + (x[k] || 0), 0);
    resolve({
      loafSupported: loafOk,
      fps: g.length / (elapsed / 1000),
      p95: sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0,
      worst: sorted.length ? sorted[sorted.length - 1] : 0,
      over25: g.filter((x) => x > 25).length,
      over100: g.filter((x) => x > 100).length,
      longFrames: long.length,
      totals: {
        durMs: sum('dur'), scriptMs: sum('scriptMs'), blockingMs: sum('blocking'),
        preRenderMs: sum('preRenderMs'), renderCbMs: sum('renderCbMs'), styleLayoutMs: sum('styleLayoutMs'),
      },
      worstFrames: long.slice(0, 8),
      svgMutationBatches: mutations,
      svgMutatedNodes: mutatedNodes,
      svgNodes: document.querySelectorAll('.timeline-full-overlay svg *').length,
    });
  };
  requestAnimationFrame(step);
}))()`;

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

async function arm(label, prefs, drop = []) {
  DROPPED = new Set(drop);
  RAN.clear();
  await assistant.unload().catch(() => {});
  await sleep(1500);
  let w = await win();
  await setPrefs(w, { enabled: false, mode: 'off' });
  w.reload();
  await sleep(3500);
  w = await win();
  seedGraph(CHAPTERS);
  await setPrefs(w, prefs);
  w.reload();
  await sleep(3500);
  w = await win(); prep(w);
  await js(w, `(() => { const b = document.querySelector('[aria-label="Story graph"]'); if (b && !document.querySelector('.sg-expand-btn')) b.click(); return true; })()`);
  await sleep(1200);
  await js(w, `(() => { const b = document.querySelector('.sg-expand-btn'); if (b) b.click(); return true; })()`);
  await sleep(2500);
  if (prefs.enabled) {
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      if (assistant.sidecar.status().inflight > 0) break;
    }
  }
  const before = stale();
  EVENTS.length = 0;
  CLOCK0 = Date.now();
  const watchStop = { done: false };
  const watching = watchEngines(watchStop);
  const r = await js(w, TRACE(SECONDS));
  watchStop.done = true;
  await watching;
  const after = stale();
  r.events = EVENTS.slice();
  r.ran = Object.fromEntries(RAN);
  r.dropped = drop;
  const converged = before && after ? (before.chips - after.chips) + (before.sums - after.sums) : null;
  r.converged = converged;
  r.before = before;
  r.after = after;
  const t = r.totals;
  console.log(
    `  ${label.padEnd(10)}│ ${r.fps.toFixed(1).padStart(5)} fps  p95 ${r.p95.toFixed(1).padStart(6)}ms  worst ${String(Math.round(r.worst)).padStart(4)}ms  ` +
    `>25 ${String(r.over25).padStart(4)}  >100 ${String(r.over100).padStart(3)} │ ` +
    `long frames ${String(r.longFrames).padStart(4)} totalling ${String(t.durMs).padStart(6)}ms — ` +
    `script ${String(t.scriptMs).padStart(5)}ms · rAF ${String(t.renderCbMs).padStart(5)}ms · style+layout+paint ${String(t.styleLayoutMs).padStart(6)}ms │ ` +
    `svg ${r.svgNodes} nodes, ${r.svgMutationBatches} rewrites │ converged ${r.converged === null ? '?' : r.converged} units`,
  );
  for (const f of r.worstFrames.slice(0, 5)) {
    // The frame's own clock starts with the trace; EVENTS share it closely
    // enough (both stamped in the same second) to pair within a window.
    const near = EVENTS.filter((e) => Math.abs(e.t - f.t / 1000) <= 1.5).map((e) => e.what);
    console.log(`             ${String(f.dur).padStart(4)}ms @${(f.t / 1000).toFixed(1)}s  script ${String(f.scriptMs).padStart(4)}ms  rAF ${String(f.renderCbMs ?? '-').padStart(4)}ms  style+layout ${String(f.styleLayoutMs ?? '-').padStart(4)}ms   ${near.length ? '← ' + near.join(' · ') : '(nothing near)'}`);
  }
  console.log(`             tasks asked: ${JSON.stringify(r.ran)}${drop.length ? `   (refused: ${drop.join(', ')})` : ''}`);
  if (EVENTS.length) console.log(`             engine timeline: ${EVENTS.map((e) => `${e.t}s ${e.what}`).join('  ')}`);
  return { label, ...r };
}

app.whenReady().then(async () => {
  let w = await win(); prep(w);
  await setPrefs(w, { enabled: false, mode: 'off' });
  w.reload();
  await sleep(5000);
  for (let i = 0; i < 60 && !fs.existsSync(IDMAP_FILE); i++) await sleep(1000);
  if (!fs.existsSync(IDMAP_FILE)) { console.log('  no chapter id map'); app.exit(1); return; }

  console.log(`\n${'═'.repeat(190)}`);
  console.log(`RENDER ATTRIBUTION — full-screen timeline, ${CHAPTERS} chapters, ${SECONDS}s windows, long frames split into script / rAF / style+layout+paint`);
  console.log(`${'═'.repeat(190)}\n`);

  const rows = [];
  installDrop();
  rows.push(await arm('idle', { enabled: false, mode: 'off' }));
  rows.push(await arm('tick on', { enabled: true, mode: 'max', tier: 'max' }));
  rows.push(await arm('no host LM', { enabled: true, mode: 'max', tier: 'max' }, HOST_TASKS));
  rows.push(await arm('idle again', { enabled: false, mode: 'off' }));

  // ── the quiet phase ───────────────────────────────────────────────────────
  //
  // Same tick, same book, but nothing touching the screen. If the gate is
  // working this is where every unit it declined to run during the busy arm
  // comes back.
  {
    await assistant.unload().catch(() => {});
    await sleep(1500);
    let w2 = await win();
    await setPrefs(w2, { enabled: false, mode: 'off' });
    w2.reload();
    await sleep(3500);
    w2 = await win();
    seedGraph(CHAPTERS);
    await setPrefs(w2, { enabled: true, mode: 'max', tier: 'max' });
    w2.reload();
    await sleep(3500);
    w2 = await win(); prep(w2);
    await js(w2, `(() => { const b = document.querySelector('[aria-label="Story graph"]'); if (b && !document.querySelector('.sg-expand-btn')) b.click(); return true; })()`);
    await sleep(1500);
    const before = stale();
    const t0 = Date.now();
    for (let i = 0; i < Math.ceil(QUIET_SECONDS / 2); i++) {
      await sleep(2000);
      const now = stale();
      if (now && now.chips === 0 && now.sums === 0) break;
    }
    const after = stale();
    const done = before && after ? (before.chips - after.chips) + (before.sums - after.sums) : null;
    console.log(`  ${'quiet'.padEnd(10)}│ no pointer, no scroll, ${Math.round((Date.now() - t0) / 1000)}s — converged ${done} units (${before ? before.chips + before.sums : '?'} were stale)`);
    rows.push({ label: 'quiet', converged: done, before, after, seconds: Math.round((Date.now() - t0) / 1000) });
  }

  const file = path.join(OUT, 'render-attribution.json');
  fs.writeFileSync(file, JSON.stringify({ chapters: CHAPTERS, seconds: SECONDS, rows }, null, 2));
  console.log(`\nwrote ${file}\n`);
  await assistant.unload().catch(() => {});
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
