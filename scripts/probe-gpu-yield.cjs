/**
 * probe-gpu-yield.cjs — which knob gives the writer their frames back.
 *
 * probe-bg-schedule.cjs established the fact: with the real chip + summary
 * tick running, the app scrolls at 38 fps instead of 120, and every bad frame
 * is GPU-side (zero longtasks, 0ms blocking script on a 220ms frame). The
 * renderer contributes NOTHING to the stall, and that measurement is what
 * licenses this harness: the load can be driven straight at the sidecar with
 * the real request bytes while the app scrolls beside it, and the frame trace
 * still means what it meant.
 *
 * ★ THE FIRST CONFIGURATION IS A CALIBRATION, NOT A DATA POINT. `shipped`
 *   reproduces what the app's own loop does (3 concurrent, -ub 128, copy step
 *   on). If it does not land near 38 fps the driver is not standing in for the
 *   tick and nothing below it is worth reading.
 *
 * ★ EVERY ROW CARRIES ITS THROUGHPUT. A config that delivers 120 fps by doing
 *   no work is the trivial solution and this table has to be able to show it:
 *   requests completed and tokens generated in the same window as the frames.
 *
 *   ./node_modules/.bin/electron scripts/probe-gpu-yield.cjs
 *   CONFIGS=idle,shipped,c1 SECONDS=20 ./node_modules/.bin/electron scripts/probe-gpu-yield.cjs
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'bench-results');
const DATA = '/tmp/lw-gpuyield-data';
const PROJECT = '/tmp/lw-gpuyield-project';
const BOOK = process.env.BOOK
  || '/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels/hollow-iris.txt';
const CHAPTERS = Number(process.env.CHAPTERS || 6);
const SECONDS = Number(process.env.SECONDS || 20);
const REQS = JSON.parse(fs.readFileSync(process.env.REQS || '/tmp/bg-reqs.json', 'utf8'));
const REAL_USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'Latent Write');

/**
 * concurrency · micro-batch · copy step · gap between a worker's requests.
 *
 * `on2048` is the POSITIVE CONTROL: the micro-batch setting already measured
 * as the worst of the family. A sweep that cannot separate it from `shipped`
 * is not sensitive enough to trust on the settings that differ by less.
 */
const CONFIGS = {
  idle:     { conc: 0, ub: 128, spec: true,  gap: 0 },
  shipped:  { conc: 3, ub: 128, spec: true,  gap: 0 },
  on2048:   { conc: 3, ub: 2048, spec: true, gap: 0 },
  c1:       { conc: 1, ub: 128, spec: true,  gap: 0 },
  c1ub64:   { conc: 1, ub: 64,  spec: true,  gap: 0 },
  c1ub32:   { conc: 1, ub: 32,  spec: true,  gap: 0 },
  c1nospec: { conc: 1, ub: 128, spec: false, gap: 0 },
  c3nospec: { conc: 3, ub: 128, spec: false, gap: 0 },
  c1gap750: { conc: 1, ub: 128, spec: true,  gap: 750 },
};
const ORDER = (process.env.CONFIGS || 'idle,shipped,on2048,c1,c1ub64,c1ub32,c1nospec,c3nospec,c1gap750')
  .split(',').map((s) => s.trim()).filter((s) => CONFIGS[s]);

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
  JSON.stringify({ name: 'Yield Probe', created: Date.now(), lastOpened: Date.now() }));
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

// ── the frame trace (identical to probe-bg-schedule.cjs) ────────────────────
const TRACE = (seconds) => `(() => new Promise((resolve) => {
  const longtasks = [];
  let po = null;
  try {
    po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longtasks.push({ start: e.startTime, dur: e.duration });
    });
    po.observe({ type: 'longtask', buffered: false });
  } catch {}
  const scroller = [...document.querySelectorAll('*')]
    .map((el) => ({ el, over: (el.scrollHeight || 0) - (el.clientHeight || 0), area: el.clientWidth * el.clientHeight }))
    .filter((x) => x.over > 200 && x.area > 100000)
    .sort((a, b) => b.area - a.area)[0]?.el || document.scrollingElement || document.body;
  const maxScroll = Math.max(0, (scroller.scrollHeight || 0) - (scroller.clientHeight || 0));
  const gaps = [];
  const t0 = performance.now();
  let last = t0;
  const step = (t) => {
    gaps.push(t - last); last = t;
    if (maxScroll > 0) {
      const phase = ((t - t0) % 4000) / 4000;
      scroller.scrollTop = maxScroll * (phase < 0.5 ? phase * 2 : 2 - phase * 2);
    }
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
      frames: g.length, fps: g.length / (elapsed / 1000),
      median: q(0.5), p95: q(0.95), worst: sorted.length ? sorted[sorted.length - 1] : 0,
      over25: g.filter((x) => x > 25).length, over50: g.filter((x) => x > 50).length,
      badMain, badGpu, longtaskMs: Math.round(longtasks.reduce((s, L) => s + L.dur, 0)),
      maxScroll,
    });
  };
  requestAnimationFrame(step);
}))()`;

// ── the load: the real request bytes, down the real lane ────────────────────
let _seq = 0;
function driver(cfg, stopFlag, meter) {
  const one = async (worker) => {
    let i = worker;
    while (!stopFlag.done) {
      const req = REQS[i % REQS.length];
      i += cfg.conc || 1;
      const t0 = Date.now();
      const res = await assistant.run({
        requestId: `yield-${++_seq}`,
        task: req.kind === 'chips' ? 'timeline-chips' : 'chapter-summary',
        tier: 'max', lane: 'batch', jsonStyle: 'compact',
        systemPrompt: req.systemPrompt, userText: req.userText,
        schema: req.schema, gbnf: req.gbnf,
        maxTokens: req.maxTokens, timeoutMs: 120_000,
      }).catch((e) => ({ ok: false, error: String(e && e.message) }));
      if (stopFlag.done) break;
      if (res && res.ok) {
        meter.done++;
        meter.tokens += (res.timings && res.timings.tokens) || 0;
        meter.wallMs += Date.now() - t0;
      } else {
        meter.failed++;
        meter.lastError = (res && res.error) || 'unknown';
      }
      if (cfg.gap) await sleep(cfg.gap);
    }
  };
  return Promise.all(Array.from({ length: cfg.conc }, (_, k) => one(k)));
}

async function applyConfig(cfg) {
  assistant.sidecar.stop('probe-reconfigure');
  await sleep(1500);
  process.env.ASSISTANT_SIDECAR_UB = String(cfg.ub);
  if (cfg.spec) delete process.env.ASSISTANT_SIDECAR_SPEC;
  else process.env.ASSISTANT_SIDECAR_SPEC = 'none';
  if (cfg.conc === 0) return;
  // One warm request: boot the server and fill the system-prompt prefix, so
  // the window measures steady state rather than a cold load.
  const req = REQS[0];
  await assistant.run({
    requestId: `warm-${++_seq}`, task: 'timeline-chips', tier: 'max', lane: 'batch',
    jsonStyle: 'compact', systemPrompt: req.systemPrompt, userText: req.userText,
    schema: req.schema, gbnf: req.gbnf, maxTokens: req.maxTokens, timeoutMs: 120_000,
  }).catch(() => {});
}

async function measure(w, name, cfg) {
  await applyConfig(cfg);
  await sleep(1200);
  const gpu = [];
  const meter = { done: 0, failed: 0, tokens: 0, wallMs: 0, lastError: null };
  const stopFlag = { done: false };
  let sampling = true;
  const sampler = (async () => {
    while (sampling) { const g = gpuBusy(); if (g !== null) gpu.push(g); await sleep(250); }
  })();
  const load = cfg.conc > 0 ? driver(cfg, stopFlag, meter) : Promise.resolve();
  const r = await js(w, TRACE(SECONDS));
  stopFlag.done = true;
  sampling = false;
  await sampler;
  await Promise.race([load, sleep(20_000)]);
  const row = {
    name, ...cfg, ...r,
    done: meter.done, failed: meter.failed, tokens: meter.tokens,
    reqPerMin: (60 * meter.done) / SECONDS,
    meanReqMs: meter.done ? Math.round(meter.wallMs / meter.done) : 0,
    lastError: meter.lastError,
    gpuAvg: gpu.length ? Math.round(gpu.reduce((a, b) => a + b, 0) / gpu.length) : null,
  };
  console.log(
    `  ${name.padEnd(9)} c${cfg.conc} ub${String(cfg.ub).padEnd(4)} ${cfg.spec ? 'spec' : 'nspc'} gap${String(cfg.gap).padEnd(4)} │ ` +
    `${row.fps.toFixed(1).padStart(5)} fps  p95 ${row.p95.toFixed(1).padStart(5)}ms  worst ${String(Math.round(row.worst)).padStart(4)}ms  ` +
    `>25ms ${String(row.over25).padStart(3)} (gpu ${row.badGpu}/main ${row.badMain}) │ ` +
    `${String(row.done).padStart(2)} done ${String(row.tokens).padStart(4)} tok  ${String(row.meanReqMs).padStart(5)}ms/req  ` +
    `gpu ${row.gpuAvg === null ? '--' : String(row.gpuAvg).padStart(3)}%${row.failed ? `  FAILED ${row.failed} (${row.lastError})` : ''}`,
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

app.whenReady().then(async () => {
  let w = await win();
  const prep = (x) => {
    x.webContents.setBackgroundThrottling(false);
    x.setSize(1600, 1000); x.center();
    app.focus({ steal: true }); x.show(); x.focus(); x.moveTop();
  };
  prep(w);
  // The app's own tick must stay out of the measurement: this harness IS the
  // load, and a second one running beside it would not be attributable.
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
  w = await win(); prep(w);

  console.log(`\n${'═'.repeat(150)}`);
  console.log(`GPU YIELD — real chip/summary request bytes, ${SECONDS}s windows, the app scrolling a real chapter throughout`);
  console.log(`${'═'.repeat(150)}\n`);

  const rows = [];
  for (const name of ORDER) rows.push(await measure(w, name, CONFIGS[name]));

  const file = path.join(OUT, 'gpu-yield.json');
  fs.writeFileSync(file, JSON.stringify({ seconds: SECONDS, rows }, null, 2));
  console.log(`\nwrote ${file}\n`);
  assistant.sidecar.stop('probe-done');
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
