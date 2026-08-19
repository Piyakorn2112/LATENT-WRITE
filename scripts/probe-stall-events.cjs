/**
 * probe-stall-events.cjs — pair every long frame with what the engines were
 * doing at that instant.
 *
 * ★★ THE COST IS AN EVENT, NOT A LOAD. Bracketed on the full-screen timeline
 *    (probe-timeline-stutter.cjs), background work costs 29% of the frame rate
 *    on average — but bucketed by ten seconds it is 16.4 fps, then 119.7, then
 *    120.7, with five 379-540ms freezes all inside the first bucket and zero
 *    milliseconds of blocking script on any of them. Meanwhile the sidecar
 *    decodes at 94% GPU for the remaining twenty seconds and costs nothing.
 *
 *    So the question is no longer "how much work is the GPU doing" but "WHAT
 *    HAPPENS AT THE MOMENT THE SCREEN FREEZES". This harness runs one long
 *    window and writes two timestamped streams against a shared clock: every
 *    frame gap over the threshold, and every engine state transition (host
 *    process up/down, host model + context, sidecar up/down, sidecar boot).
 *    Then it prints, for each freeze, what changed within a second of it.
 *
 * ★ THE CLOCKS ARE ALIGNED EXPLICITLY. The renderer measures in
 *   performance.now() and the main process in Date.now(); the offset is read
 *   from the renderer once, at the start of the window, rather than assumed.
 *
 * ★ TRANSITIONS ARE OBSERVED, NOT INSTRUMENTED INTO THE APP. sidecar.stop and
 *   sidecar.ensureStarted are wrapped on the module object (assistant.cjs
 *   looks them up per call, so the wrap is seen), and the host is polled
 *   through the app's own assistantStatus.
 *
 *   ./node_modules/.bin/electron scripts/probe-stall-events.cjs
 *   SECONDS=240 STALL_MS=60 ./node_modules/.bin/electron scripts/probe-stall-events.cjs
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'bench-results');
const DATA = '/tmp/lw-stall-data';
const PROJECT = '/tmp/lw-stall-project';
const BOOK = process.env.BOOK
  || '/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels/hollow-iris.txt';
const CHAPTERS = Number(process.env.CHAPTERS || 14);
const SECONDS = Number(process.env.SECONDS || 240);
const STALL_MS = Number(process.env.STALL_MS || 50);
const SCENE = process.env.SCENE || 'timelineFull';
const REAL_USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'Latent Write');
const RENDERER_DIR = path.join(PROJECT, '.renderer');
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
const bookText = fs.readFileSync(BOOK, 'utf8');
const marks = [...bookText.matchAll(/^===CHAPTER \d+:.*===$/gm)];
fs.writeFileSync(path.join(PROJECT, 'novel.txt'),
  marks.length <= CHAPTERS ? bookText : bookText.slice(0, marks[CHAPTERS].index));
fs.writeFileSync(path.join(RENDERER_DIR, 'project.json'),
  JSON.stringify({ name: 'Stall Book', created: Date.now(), lastOpened: Date.now() }));
fs.writeFileSync(path.join(DATA, 'last-project.json'),
  JSON.stringify({ path: PROJECT, updated: Date.now() }));
process.env.LW_USER_DATA = DATA;

const { app, BrowserWindow } = require('electron');
app.setName('Latent Write');
require(path.join(ROOT, 'electron', 'main.cjs'));
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (w, src) => w.webContents.executeJavaScript(src, true);

// ── the engine event stream ─────────────────────────────────────────────────
const EVENTS = [];
let T0 = 0;
const at = () => +((Date.now() - T0) / 1000).toFixed(2);
const ev = (kind, detail) => { if (T0) EVENTS.push({ t: at(), kind, detail }); };

const realStop = assistant.sidecar.stop;
assistant.sidecar.stop = function wrappedStop(reason) {
  ev('sidecar.stop', String(reason || ''));
  return realStop.apply(this, arguments);
};
const realEnsure = assistant.sidecar.ensureStarted;
assistant.sidecar.ensureStarted = async function wrappedEnsure(opts) {
  const before = assistant.sidecar.status().alive;
  const t = Date.now();
  const res = await realEnsure.apply(this, arguments);
  if (!before && res && res.ok && !res.reused) ev('sidecar.boot', `${Date.now() - t}ms slots=${opts && opts.slots}`);
  return res;
};

function graphState() {
  try {
    const g = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
    const es = Object.values((g.data || g).entries || {});
    const we = es.filter((e) => (e.majorEvents || []).length > 0);
    return { withEvents: we.length, chipsStale: we.filter((e) => !e.lmChipsKey).length, sumStale: we.filter((e) => !e.lmSummaryKey).length };
  } catch { return null; }
}

const TRACE = (seconds, stallMs) => `(() => new Promise((resolve) => {
  const stalls = [];
  const longtasks = [];
  try {
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longtasks.push({ t: e.startTime, d: e.duration }); });
    po.observe({ type: 'longtask', buffered: false });
  } catch {}
  const scroller = [...document.querySelectorAll('*')]
    .map((el) => ({ el, over: (el.scrollHeight || 0) - (el.clientHeight || 0), area: el.clientWidth * el.clientHeight }))
    .filter((x) => x.over > 200 && x.area > 80000)
    .sort((a, b) => b.area - a.area)[0]?.el || null;
  const maxScroll = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
  const t0 = performance.now();
  const wall0 = Date.now();
  let last = t0, frames = 0;
  const step = (t) => {
    const gap = t - last; last = t; frames++;
    if (gap > ${stallMs}) stalls.push({ t: +((t - t0) / 1000).toFixed(2), ms: Math.round(gap) });
    const phase = ((t - t0) % 4000) / 4000;
    const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
    if (maxScroll > 0) scroller.scrollTop = maxScroll * tri;
    const x = Math.round(80 + tri * (window.innerWidth - 160));
    const y = Math.round(window.innerHeight * (0.35 + 0.3 * tri));
    document.elementFromPoint(x, y)?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, pointerType: 'mouse' }));
    if (t - t0 < ${seconds} * 1000) requestAnimationFrame(step);
    else resolve({
      wall0, frames, fps: frames / ${seconds}, stalls,
      longtaskMs: Math.round(longtasks.reduce((s, L) => s + L.d, 0)),
      longtaskOver: longtasks.filter((L) => L.d > ${stallMs}).length,
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
async function openScene(w) {
  if (SCENE === 'editor') return { editor: true };
  await js(w, `(() => { const b = document.querySelector('[aria-label="Story graph"]'); if (b && !document.querySelector('.sg-expand-btn')) b.click(); return true; })()`);
  await sleep(1500);
  if (SCENE === 'timelineFull') {
    await js(w, `(() => { const b = document.querySelector('.sg-expand-btn'); if (b) b.click(); return true; })()`);
    await sleep(2000);
  }
  return js(w, `(() => ({ sidebar: !!document.querySelector('.sg-expand-btn'), svgNodes: document.querySelectorAll('svg *').length }))()`);
}

app.whenReady().then(async () => {
  let w = await win(); prep(w);
  console.log(`\n${'═'.repeat(120)}`);
  console.log(`STALL EVENTS — scene "${SCENE}", ${CHAPTERS} chapters, one ${SECONDS}s window, frames over ${STALL_MS}ms paired with engine transitions`);
  console.log(`${'═'.repeat(120)}\n`);

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
  console.log(`  warm: ${JSON.stringify(graphState())}\n`);

  await setPrefs(w, { enabled: true, mode: 'max', tier: 'max' });
  w.reload();
  await sleep(2500);
  w = await win(); prep(w);
  console.log(`  scene: ${JSON.stringify(await openScene(w))}`);

  // ── the window ────────────────────────────────────────────────────────────
  T0 = Date.now();
  let sampling = true;
  let lastHost = '';
  let lastSidecar = '';
  const sampler = (async () => {
    while (sampling) {
      try {
        const st = await assistant.assistantStatus({ tier: 'max' });
        const hostKey = `${assistant.__hostPid() || '-'}|${st.state}|${(st.loaded && st.loaded.modelPath) || (st.model && st.model.id) || '-'}|${(st.loaded && st.loaded.contextSize) || '-'}`;
        if (hostKey !== lastHost) { ev('host', hostKey); lastHost = hostKey; }
        const sc = assistant.sidecar.status();
        const scKey = `${sc.alive ? 'alive' : 'down'}|inflight=${sc.inflight}`;
        if (scKey.split('|')[0] !== lastSidecar.split('|')[0]) { ev('sidecar', scKey); }
        lastSidecar = scKey;
      } catch { /* status can throw while reloading */ }
      await sleep(200);
    }
  })();

  const r = await js(w, TRACE(SECONDS, STALL_MS));
  sampling = false;
  await sampler;

  // Renderer clock → shared clock.
  const offset = (r.wall0 - T0) / 1000;
  const stalls = r.stalls.map((s) => ({ t: +(s.t + offset).toFixed(2), ms: s.ms }));

  console.log(`\n  ${r.fps.toFixed(1)} fps over ${SECONDS}s · ${stalls.length} frames over ${STALL_MS}ms · ${r.longtaskMs}ms of longtask total (${r.longtaskOver} over ${STALL_MS}ms)`);
  console.log(`  final: ${JSON.stringify(graphState())}\n`);

  console.log('  engine transitions:');
  for (const e of EVENTS) console.log(`    t+${String(e.t).padStart(7)}s  ${e.kind.padEnd(13)} ${e.detail}`);

  console.log('\n  freezes, and what changed within 2s either side:');
  for (const s of stalls) {
    const near = EVENTS.filter((e) => Math.abs(e.t - s.t) <= 2);
    console.log(`    t+${String(s.t).padStart(7)}s  ${String(s.ms).padStart(4)}ms   ${near.length ? near.map((e) => `${e.kind}(${e.detail})`).join(' · ') : '—'}`);
  }

  // Freezes per 10s, so a burst is visible as a burst.
  const bins = new Map();
  for (const s of stalls) {
    const b = Math.floor(s.t / 10) * 10;
    bins.set(b, (bins.get(b) || 0) + 1);
  }
  console.log('\n  freezes per 10s bin:');
  console.log('    ' + [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([b, n]) => `${b}s:${n}`).join('  '));

  const file = path.join(OUT, 'stall-events.json');
  fs.writeFileSync(file, JSON.stringify({ scene: SCENE, seconds: SECONDS, stallMs: STALL_MS, fps: r.fps, stalls, events: EVENTS, graph: graphState() }, null, 2));
  console.log(`\nwrote ${file}\n`);
  await assistant.unload().catch(() => {});
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
