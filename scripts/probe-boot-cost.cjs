/**
 * probe-boot-cost.cjs — what the ENGINE BOOT costs the screen, isolated.
 *
 * ★★ THE SUSPECT, ARRIVED AT BY ELIMINATION. Six harnesses now agree that
 *    steady background decoding is free: 120 fps at 94-98% GPU, panel opens
 *    unchanged, model loads into the in-process host unchanged, both engines
 *    running together unchanged. The windows that DID stutter — 537ms and
 *    1308ms worst frames, dozens of dropped frames, every one of them GPU-side
 *    with zero milliseconds of blocking script — are exactly the windows that
 *    contained a cold `llama-server` boot.
 *
 *    That matters more than a cold start usually would, because the sidecar's
 *    idle TTL is 90 SECONDS. A writer who edits a chapter, waits two minutes,
 *    and edits another pays the boot again. Cold is the normal case, not the
 *    first-launch case.
 *
 * ★ THE BOOT IS THE ONLY THING IN THE WINDOW. No decoding follows it inside
 *   the measurement, so a stall cannot be blamed on inference; and the arms
 *   either side are the same scene with the same engine already warm.
 *
 * ★ TWO KINDS OF BOOT, because they are different costs and only one is
 *   avoidable by scheduling: a PROCESS boot (spawn, 2.5GB of weights, the
 *   server's own warm-up pass) and the FIRST INFERENCE after it (Metal
 *   pipeline compilation for kernels never yet used).
 *
 *   ./node_modules/.bin/electron scripts/probe-boot-cost.cjs
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'bench-results');
const DATA = '/tmp/lw-boot-data';
const PROJECT = '/tmp/lw-boot-project';
const BOOK = process.env.BOOK
  || '/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels/hollow-iris.txt';
const TEMPLATE = process.env.TEMPLATE || '/tmp/lw-entry-template.json';
const CHAPTERS = Number(process.env.CHAPTERS || 60);
const SECONDS = Number(process.env.SECONDS || 30);
const REPS = Number(process.env.REPS || 2);
const REQS = JSON.parse(fs.readFileSync(process.env.REQS || '/tmp/bg-reqs.json', 'utf8'));
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
  JSON.stringify({ name: 'Boot Cost', created: Date.now(), lastOpened: Date.now() }));
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

let _seq = 0;
function call(i) {
  const req = REQS[i % REQS.length];
  return assistant.run({
    requestId: `boot-${++_seq}`, task: 'timeline-chips', tier: 'max', lane: 'batch',
    jsonStyle: 'compact', systemPrompt: req.systemPrompt, userText: req.userText,
    schema: req.schema, gbnf: req.gbnf, maxTokens: req.maxTokens, timeoutMs: 180_000,
  }).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
}

function seedGraph(n) {
  const template = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  const idMap = JSON.parse(fs.readFileSync(IDMAP_FILE, 'utf8'));
  const entries = {};
  for (const ch of idMap.slice(0, n)) {
    const e = JSON.parse(JSON.stringify(template));
    e.chapterId = ch.id; e.chapterNumber = ch.number; e.chapterTitle = ch.title;
    e.contentHash = `boot-${ch.id}`;
    delete e.lmChips; delete e.lmChipsKey;
    delete e.lmSummary; delete e.lmThroughline; delete e.lmSummaryKey;
    entries[ch.id] = e;
  }
  fs.writeFileSync(GRAPH_FILE, JSON.stringify({ version: 1, entries }));
}

const TRACE = (seconds) => `(() => new Promise((resolve) => {
  const longtasks = [];
  try {
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longtasks.push({ t: e.startTime, d: e.duration }); });
    po.observe({ type: 'longtask', buffered: false });
  } catch {}
  const gaps = []; const t0 = performance.now(); const wall0 = Date.now(); let last = t0;
  const step = (t) => {
    gaps.push({ t: +((t - t0) / 1000).toFixed(2), ms: t - last }); last = t;
    const phase = ((t - t0) % 4000) / 4000;
    const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
    const x = Math.round(80 + tri * (window.innerWidth - 160));
    const y = Math.round(window.innerHeight * (0.35 + 0.3 * tri));
    document.elementFromPoint(x, y)?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, pointerType: 'mouse' }));
    if (t - t0 < ${seconds} * 1000) requestAnimationFrame(step); else finish();
  };
  const finish = () => {
    const g = gaps.slice(1);
    const ms = g.map((x) => x.ms).sort((a, b) => a - b);
    const q = (p) => ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] : 0;
    let acc = t0, badMain = 0, badGpu = 0;
    for (const x of g) {
      const start = acc; acc += x.ms;
      if (x.ms <= 25) continue;
      if (longtasks.some((L) => L.t < acc && L.t + L.d > start)) badMain++; else badGpu++;
    }
    resolve({
      wall0, frames: g.length, fps: g.length / (performance.now() - t0) * 1000,
      median: q(0.5), p95: q(0.95), worst: ms.length ? ms[ms.length - 1] : 0,
      over25: g.filter((x) => x.ms > 25).length, over100: g.filter((x) => x.ms > 100).length,
      badMain, badGpu,
      longtaskMs: Math.round(longtasks.reduce((s, L) => s + L.d, 0)),
      stalls: g.filter((x) => x.ms > 60).map((x) => ({ t: x.t, ms: Math.round(x.ms) })).slice(0, 20),
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

async function measure(w, label, action) {
  const gpu = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) { const g = gpuBusy(); if (g !== null) gpu.push(g); await sleep(300); }
  })();
  const T0 = Date.now();
  const events = [];
  const running = action ? action(T0, events) : Promise.resolve();
  const r = await js(w, TRACE(SECONDS));
  sampling = false;
  await sampler;
  await Promise.race([running, sleep(120_000)]);
  const row = {
    label, ...r, events,
    gpuAvg: gpu.length ? Math.round(gpu.reduce((a, b) => a + b, 0) / gpu.length) : null,
  };
  console.log(
    `  ${label.padEnd(26)}│ ${r.fps.toFixed(1).padStart(5)} fps  worst ${String(Math.round(r.worst)).padStart(4)}ms  ` +
    `>25ms ${String(r.over25).padStart(3)}  >100ms ${String(r.over100).padStart(3)}  (gpu ${r.badGpu}/main ${r.badMain})  ` +
    `ltask ${r.longtaskMs}ms │ gpu ${String(row.gpuAvg ?? '-').padStart(3)}%`,
  );
  if (r.stalls.length) console.log(`                             stalls: ${r.stalls.map((s) => `${s.t}s/${s.ms}ms`).join(' ')}`);
  if (events.length) console.log(`                             engine: ${events.join(' · ')}`);
  return row;
}

app.whenReady().then(async () => {
  let w = await win(); prep(w);
  await js(w, `(() => {
    const K = "latentwrite:prefs-v1";
    const p = JSON.parse(localStorage.getItem(K) || "{}");
    p.hasSeenOnboarding = true; p.onbChecklistHidden = true;
    p.assistant = { enabled: false, mode: "off" };
    localStorage.setItem(K, JSON.stringify(p));
    return true;
  })()`);
  w.reload();
  await sleep(6000);
  w = await win();
  for (let i = 0; i < 60 && !fs.existsSync(IDMAP_FILE); i++) await sleep(1000);
  seedGraph(CHAPTERS);
  w.reload();
  await sleep(4000);
  w = await win(); prep(w);
  await js(w, `(() => { const b = document.querySelector('[aria-label="Story graph"]'); if (b && !document.querySelector('.sg-expand-btn')) b.click(); return true; })()`);
  await sleep(1200);
  await js(w, `(() => { const b = document.querySelector('.sg-expand-btn'); if (b) b.click(); return true; })()`);
  await sleep(2500);
  const scene = await js(w, `(() => ({ overlay: !!document.querySelector('.timeline-full-overlay'), svg: document.querySelectorAll('.timeline-full-overlay svg *').length }))()`);

  console.log(`\n${'═'.repeat(140)}`);
  console.log(`BOOT COST — full-screen timeline (${CHAPTERS} chapters, ${scene.svg} svg nodes), ${SECONDS}s windows`);
  console.log(`${'═'.repeat(140)}\n`);
  if (!scene.overlay) { console.log('  the timeline never opened'); app.exit(1); return; }

  const rows = [];
  for (let rep = 0; rep < REPS; rep++) {
    // Warm: engine already up, one request inside the window.
    if (!assistant.sidecar.status().alive) { await call(0); await sleep(1000); }
    rows.push(await measure(w, `warm decode (rep ${rep + 1})`, async (T0, events) => {
      const r = await call(1);
      events.push(`decode ${Date.now() - T0}ms ok=${!!(r && r.ok)}`);
    }));

    // Cold: the engine is stopped, and the SAME request boots it inside the window.
    assistant.sidecar.stop('probe-cold');
    await sleep(2500);
    rows.push(await measure(w, `COLD boot + decode (rep ${rep + 1})`, async (T0, events) => {
      const t = Date.now();
      const r = await call(1);
      events.push(`boot+decode ${Date.now() - t}ms ok=${!!(r && r.ok)}`);
    }));
  }

  const warm = rows.filter((r) => r.label.startsWith('warm'));
  const cold = rows.filter((r) => r.label.startsWith('COLD'));
  const mean = (xs, k) => (xs.length ? xs.reduce((s, r) => s + r[k], 0) / xs.length : 0);
  console.log('');
  console.log(`  warm  ${mean(warm, 'fps').toFixed(1)} fps · ${mean(warm, 'over25').toFixed(1)} frames >25ms · worst ${Math.round(Math.max(0, ...warm.map((r) => r.worst)))}ms`);
  console.log(`  cold  ${mean(cold, 'fps').toFixed(1)} fps · ${mean(cold, 'over25').toFixed(1)} frames >25ms · worst ${Math.round(Math.max(0, ...cold.map((r) => r.worst)))}ms`);

  const file = path.join(OUT, 'boot-cost.json');
  fs.writeFileSync(file, JSON.stringify({ chapters: CHAPTERS, seconds: SECONDS, svg: scene.svg, rows }, null, 2));
  console.log(`\nwrote ${file}\n`);
  await assistant.unload().catch(() => {});
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
