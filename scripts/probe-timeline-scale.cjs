/**
 * probe-timeline-scale.cjs — does the timeline's cost under background work
 * scale with the size of the book?
 *
 * ★★ WHY THIS EXISTS. Every measurement so far says background inference is
 *    free: 120 fps at 94% GPU with the tick running, panel opens unchanged,
 *    model loads unchanged, both engines together unchanged. All of it on a
 *    TWELVE chapter book, where the full-screen timeline is 463 SVG nodes.
 *    A real manuscript is 174 chapters. Every provisional chip the model
 *    streams calls setStoryGraph, which invalidates the memo the whole
 *    timeline is derived from, so the entire node tree is reconciled again —
 *    roughly eight times a second per in-flight request. At 463 nodes that is
 *    invisible. The question is whether it stays invisible.
 *
 * ★★ THE GRAPH IS SYNTHESISED, AND THAT IS A DELIBERATE LIMIT ON THE CLAIM.
 *    Paging a real book to build 60 real entries took 80 SECONDS PER CHAPTER
 *    by chapter 29 and was still slowing — the deterministic backfill is
 *    O(chapters) per chapter — so an honest render-cost measurement at 174
 *    chapters cannot be reached that way in an afternoon. Instead one real
 *    entry is cloned onto every chapter id. That is valid for what is being
 *    measured (how much there is to draw, and how often it is redrawn) and
 *    invalid for anything about content. It is not evidence about chip
 *    quality, event selection, or the analysis engine.
 *
 * ★ THE LM KEYS ARE STRIPPED so the tick sees every chapter as stale and has
 *   real work for the whole window.
 *
 *   ./node_modules/.bin/electron scripts/probe-timeline-scale.cjs
 *   SIZES=12,60,174 ./node_modules/.bin/electron scripts/probe-timeline-scale.cjs
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'bench-results');
const DATA = '/tmp/lw-tlscale-data';
const PROJECT = '/tmp/lw-tlscale-project';
const BOOK = process.env.BOOK
  || '/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels/hollow-iris.txt';
const TEMPLATE = process.env.TEMPLATE || '/tmp/lw-entry-template.json';
const SIZES = (process.env.SIZES || '12,60,174').split(',').map(Number).filter(Boolean);
const SECONDS = Number(process.env.SECONDS || 25);
const REAL_USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'Latent Write');
const RENDERER_DIR = path.join(PROJECT, '.renderer');
const GRAPH_FILE = path.join(RENDERER_DIR, 'story-graph.json');
const IDMAP_FILE = path.join(RENDERER_DIR, 'chapter-id-map.json');

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
  JSON.stringify({ name: 'Timeline Scale', created: Date.now(), lastOpened: Date.now() }));
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

/** One real entry cloned onto the first `n` chapter ids, every lm key stripped. */
function seedGraph(n) {
  const template = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  const idMap = JSON.parse(fs.readFileSync(IDMAP_FILE, 'utf8'));
  const entries = {};
  for (const ch of idMap.slice(0, n)) {
    const e = JSON.parse(JSON.stringify(template));
    e.chapterId = ch.id;
    e.chapterNumber = ch.number;
    e.chapterTitle = ch.title;
    e.contentHash = `scale-${ch.id}`;
    delete e.lmChips; delete e.lmChipsKey;
    delete e.lmSummary; delete e.lmThroughline; delete e.lmSummaryKey;
    entries[ch.id] = e;
  }
  fs.writeFileSync(GRAPH_FILE, JSON.stringify({ version: 1, entries }));
  return Object.keys(entries).length;
}
function graphState() {
  try {
    const g = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
    const es = Object.values((g.data || g).entries || {});
    const we = es.filter((e) => (e.majorEvents || []).length > 0);
    return { withEvents: we.length, chipsStale: we.filter((e) => !e.lmChipsKey).length };
  } catch { return null; }
}

const TRACE = (seconds) => `(() => new Promise((resolve) => {
  const longtasks = [];
  try {
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longtasks.push({ t: e.startTime, d: e.duration }); });
    po.observe({ type: 'longtask', buffered: false });
  } catch {}
  const loaf = [];
  try {
    const p2 = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.duration < 25) continue;
        loaf.push({ dur: Math.round(e.duration), blocking: Math.round(e.blockingDuration || 0),
          scripts: (e.scripts || []).slice(0, 2).map((x) => ({ d: Math.round(x.duration), fn: x.sourceFunctionName || '' })) });
      }
    });
    p2.observe({ type: 'long-animation-frame', buffered: false });
  } catch {}
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
      badMain, badGpu, longtasks: longtasks.length,
      longtaskMs: Math.round(longtasks.reduce((s, L) => s + L.d, 0)),
      loaf: loaf.sort((a, b) => b.dur - a.dur).slice(0, 4),
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
async function openTimeline(w) {
  await js(w, `(() => { const b = document.querySelector('[aria-label="Story graph"]'); if (b && !document.querySelector('.sg-expand-btn')) b.click(); return true; })()`);
  await sleep(1500);
  await js(w, `(() => { const b = document.querySelector('.sg-expand-btn'); if (b) b.click(); return true; })()`);
  await sleep(2500);
  return js(w, `(() => ({ overlay: !!document.querySelector('.timeline-full-overlay'), svgNodes: document.querySelectorAll('.timeline-full-overlay svg *').length }))()`);
}

async function measure(w, label, n) {
  const gpu = []; const inflight = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const g = gpuBusy(); if (g !== null) gpu.push(g);
      inflight.push(assistant.sidecar.status().inflight || 0);
      await sleep(400);
    }
  })();
  const r = await js(w, TRACE(SECONDS));
  sampling = false;
  await sampler;
  const duty = inflight.length ? Math.round((100 * inflight.filter((x) => x > 0).length) / inflight.length) : 0;
  const row = { label, chapters: n, ...r, duty, gpuAvg: gpu.length ? Math.round(gpu.reduce((a, b) => a + b, 0) / gpu.length) : null };
  console.log(
    `    ${label.padEnd(8)} │ ${row.fps.toFixed(1).padStart(5)} fps  median ${row.median.toFixed(1).padStart(5)}ms  p95 ${row.p95.toFixed(1).padStart(6)}ms  worst ${String(Math.round(row.worst)).padStart(4)}ms  ` +
    `>25 ${String(row.over25).padStart(4)} (gpu ${String(row.badGpu).padStart(4)}/main ${String(row.badMain).padStart(4)})  ` +
    `ltask ${String(row.longtasks).padStart(4)}/${String(row.longtaskMs).padStart(5)}ms │ duty ${String(duty).padStart(3)}%  gpu ${String(row.gpuAvg ?? '-').padStart(3)}%  svg ${row.svgNodes}`,
  );
  return row;
}

app.whenReady().then(async () => {
  let w = await win(); prep(w);
  await setPrefs(w, { enabled: false, mode: 'off' });
  w.reload();
  await sleep(6000);
  w = await win(); prep(w);

  console.log(`\n${'═'.repeat(168)}`);
  console.log(`TIMELINE SCALE — full-screen timeline, synthesised graph, ${SECONDS}s windows, assistant off / max / off at each size`);
  console.log(`${'═'.repeat(168)}\n`);

  for (let i = 0; i < 60 && !fs.existsSync(IDMAP_FILE); i++) await sleep(1000);
  if (!fs.existsSync(IDMAP_FILE)) { console.log('  no chapter id map — the project never opened'); app.exit(1); return; }
  const idMap = JSON.parse(fs.readFileSync(IDMAP_FILE, 'utf8'));
  console.log(`  book: ${idMap.length} chapters on file\n`);

  const rows = [];
  for (const n of SIZES) {
    if (n > idMap.length) { console.log(`  skip ${n}: the book only has ${idMap.length} chapters`); continue; }
    console.log(`  ── ${n} chapters ──`);
    for (const [label, prefs] of [
      ['base', { enabled: false, mode: 'off' }],
      ['load', { enabled: true, mode: 'max', tier: 'max' }],
      ['base2', { enabled: false, mode: 'off' }],
    ]) {
      await assistant.unload().catch(() => {});
      await sleep(1500);
      // Quiesce, reseed under a renderer that is not writing, then reload in.
      await setPrefs(w, { enabled: false, mode: 'off' });
      w.reload();
      await sleep(4000);
      w = await win();
      const seeded = seedGraph(n);
      await setPrefs(w, prefs);
      w.reload();
      await sleep(3500);
      w = await win(); prep(w);
      const scene = await openTimeline(w);
      if (!scene.overlay) { console.log(`    ${label}: the timeline never opened`); continue; }
      if (prefs.enabled) {
        for (let i = 0; i < 60; i++) {
          await sleep(1000);
          if (assistant.sidecar.status().inflight > 0) break;
        }
      }
      const row = await measure(w, label, n);
      row.seeded = seeded;
      row.stale = graphState();
      rows.push(row);
    }
  }

  const file = path.join(OUT, 'timeline-scale.json');
  fs.writeFileSync(file, JSON.stringify({ seconds: SECONDS, sizes: SIZES, rows }, null, 2));
  console.log(`\n  summary`);
  for (const n of SIZES) {
    const at = rows.filter((r) => r.chapters === n);
    const base = at.filter((r) => r.label.startsWith('base'));
    const load = at.find((r) => r.label === 'load');
    if (!base.length || !load) continue;
    const b = base.reduce((s, r) => s + r.fps, 0) / base.length;
    console.log(`    ${String(n).padStart(3)} chapters (${load.svgNodes} svg nodes): ${b.toFixed(1)} fps idle → ${load.fps.toFixed(1)} fps under load ` +
      `(${(100 * (load.fps - b) / b).toFixed(0)}%)   main-thread bad frames ${load.badMain}, longtask ${load.longtaskMs}ms   drift ${base.length === 2 ? `${Math.abs(base[0].fps - base[1].fps).toFixed(1)} fps` : 'n/a'}`);
  }
  console.log(`\nwrote ${file}\n`);
  await assistant.unload().catch(() => {});
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
