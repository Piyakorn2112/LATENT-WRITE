/**
 * probe-panel-open.cjs — how long the story timeline takes to APPEAR while
 * chapter summaries and chips are being written.
 *
 * ★★ EVERY EARLIER PROBE OPENED THE PANEL AND THEN STARTED MEASURING, which
 *    means none of them measured the thing the owner actually described:
 *    "open the story timeline sidebar and the timeline full screen while the
 *    summarization and chip creation is running and you will clearly see lag."
 *    The steady state after the panel is up is now well measured and it is
 *    clean — 120 fps at 94% GPU, zero frames over 25ms. The OPEN is a
 *    different event: a thousand-node SVG mounts, a full-screen overlay with
 *    its own backdrop layer is composited for the first time, and both want
 *    the GPU at the same instant the engine has it.
 *
 * ★ TIME TO PIXELS, NOT TIME TO STATE. The panel is timed from the click to
 *   the first animation frame on which its content is actually in the DOM,
 *   and the row count is checked — a panel that renders nothing opens
 *   instantly, and this repo has certified a feature on exactly that shape.
 *
 * ★ BRACKETED, because a single before/after does not survive this machine.
 *   Arms run idle → loaded → idle and the two idle arms bound the drift.
 *
 * ★ THE ENGINE IS WARMED OUTSIDE EVERY MEASURED ARM. A first sidecar boot is
 *   13.4 seconds and a first inference compiles Metal pipelines; both are
 *   real costs but they are not what "while summarization is running" means.
 *
 *   ./node_modules/.bin/electron scripts/probe-panel-open.cjs
 *   CYCLES=6 ./node_modules/.bin/electron scripts/probe-panel-open.cjs
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'bench-results');
const DATA = '/tmp/lw-panelopen-data';
const PROJECT = '/tmp/lw-panelopen-project';
const BOOK = process.env.BOOK
  || '/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels/hollow-iris.txt';
const CHAPTERS = Number(process.env.CHAPTERS || 12);
const CYCLES = Number(process.env.CYCLES || 5);
const DECODE = Number(process.env.DECODE || 3);
const REQS = JSON.parse(fs.readFileSync(process.env.REQS || '/tmp/bg-reqs.json', 'utf8'));
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
  JSON.stringify({ name: 'Panel Open', created: Date.now(), lastOpened: Date.now() }));
fs.writeFileSync(path.join(DATA, 'last-project.json'),
  JSON.stringify({ path: PROJECT, updated: Date.now() }));
process.env.LW_USER_DATA = DATA;

const { app, BrowserWindow } = require('electron');
app.setName('Latent Write');
require(path.join(ROOT, 'electron', 'main.cjs'));
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (w, src) => w.webContents.executeJavaScript(src, true);

// ── the load ────────────────────────────────────────────────────────────────
let _seq = 0;
async function sidecarCall(i) {
  const req = REQS[i % REQS.length];
  return assistant.run({
    requestId: `po-${++_seq}`, task: 'timeline-chips', tier: 'max', lane: 'batch',
    jsonStyle: 'compact', systemPrompt: req.systemPrompt, userText: req.userText,
    schema: req.schema, gbnf: req.gbnf, maxTokens: req.maxTokens, timeoutMs: 120_000,
  }).catch(() => null);
}
/** Backs off on failure: a driver that re-asks a busy engine at full speed
 *  pegs the main process and stops executeJavaScript from resolving. */
function startDecoding(conc, stopFlag, meter) {
  const one = async (k) => {
    let i = k;
    while (!stopFlag.done) {
      const r = await sidecarCall(i);
      i += conc;
      if (r && r.ok) meter.done++;
      else { meter.failed++; await sleep(250); }
    }
  };
  return Promise.all(Array.from({ length: conc }, (_, k) => one(k)));
}

/**
 * Click something, then wait for the first frame on which the panel is really
 * there, counting every long frame along the way.
 *
 * `ready` is evaluated per frame and must assert CONTENT, not existence.
 */
const OPEN = (clickSel, readyExpr, budgetMs) => `(() => new Promise((resolve) => {
  const count = () => { try { return ${readyExpr}; } catch { return 0; } };
  // ★★ THE PANEL MUST BE SHUT BEFORE IT CAN BE OPENED, and the first version
  //    of this probe did not check. Its close step silently failed, so every
  //    "open" clicked an already-open panel: the ready count was 463 on frame
  //    one, the elapsed time came out NEGATIVE, and the table read as though
  //    the timeline appeared instantly under every condition. An assertion is
  //    cheaper than a plausible zero.
  if (count() > 0) return resolve({ ok: false, why: 'already open', rows: count() });
  const btn = document.querySelector(${JSON.stringify(clickSel)});
  if (!btn) return resolve({ ok: false, why: 'no trigger ' + ${JSON.stringify(clickSel)} });
  const gaps = [];
  const t0 = performance.now();
  let last = t0;
  let settledAt = null;
  btn.click();
  const step = () => {
    const now = performance.now();
    gaps.push(now - last); last = now;
    if (settledAt === null && count() > 0) settledAt = now - t0;
    // Keep watching past first paint: a panel that appears and then janks is
    // still lag, and the jank is the half a writer complains about.
    if (now - t0 < ${budgetMs}) requestAnimationFrame(step);
    else {
      const g = gaps.slice(1);
      resolve({
        ok: settledAt !== null,
        appearedMs: settledAt,
        rows: count(),
        frames: g.length,
        over25: g.filter((x) => x > 25).length,
        over50: g.filter((x) => x > 50).length,
        worst: g.length ? Math.round(Math.max(...g)) : 0,
      });
    }
  };
  requestAnimationFrame(step);
}))()`;

const SIDEBAR_READY = `document.querySelectorAll('.sg-expand-btn').length`;
const FULL_READY = `document.querySelectorAll('.timeline-full-overlay svg *').length`;

/**
 * Shut both surfaces and CONFIRM they are shut.
 *
 * ★ THE OVERLAY HAS A CLOSE BUTTON; use it. Dispatching a click on the
 *   backdrop depends on React seeing target === currentTarget through a
 *   synthetic event, which is a coin flip from executeJavaScript. Escape
 *   works too (the component listens for it) and is the fallback.
 */
async function closeAll(w) {
  for (let i = 0; i < 20; i++) {
    const state = await js(w, `(() => {
      const closeBtn = document.querySelector('.timeline-full-close');
      if (closeBtn) { closeBtn.click(); return { stage: 'full' }; }
      if (document.querySelector('.timeline-full-overlay')) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { stage: 'full-esc' };
      }
      if (document.querySelector('.sg-expand-btn')) {
        const tab = document.querySelector('[aria-label="Story graph"]');
        if (tab) tab.click();
        return { stage: 'sidebar' };
      }
      return { stage: 'closed' };
    })()`);
    if (state.stage === 'closed') return true;
    await sleep(400);
  }
  throw new Error('panels would not close');
}

async function arm(w, name, decode) {
  const stop = { done: false };
  const meter = { done: 0, failed: 0 };
  const decoding = decode ? startDecoding(decode, stop, meter) : Promise.resolve();
  if (decode) await sleep(2000);

  const sidebar = [];
  const full = [];
  for (let c = 0; c < CYCLES; c++) {
    await closeAll(w);
    await sleep(700);
    sidebar.push(await js(w, OPEN('[aria-label="Story graph"]', SIDEBAR_READY, 2000)));
    await sleep(500);
    full.push(await js(w, OPEN('.sg-expand-btn', FULL_READY, 2500)));
    await sleep(500);
  }
  await closeAll(w);
  stop.done = true;
  await Promise.race([decoding, sleep(60_000)]);

  const stat = (rows, key) => {
    const xs = rows.filter((r) => r.ok).map((r) => r[key]).sort((a, b) => a - b);
    if (!xs.length) return { median: null, worst: null };
    return { median: xs[Math.floor(xs.length / 2)], worst: xs[xs.length - 1] };
  };
  const line = (label, rows) => {
    const a = stat(rows, 'appearedMs');
    const bad = rows.reduce((s, r) => s + (r.over25 || 0), 0);
    const bad50 = rows.reduce((s, r) => s + (r.over50 || 0), 0);
    const worst = Math.max(0, ...rows.map((r) => r.worst || 0));
    const failed = rows.filter((r) => !r.ok).length;
    console.log(
      `    ${label.padEnd(9)} appears in ${String(a.median === null ? '-' : Math.round(a.median)).padStart(5)}ms ` +
      `(worst ${String(a.worst === null ? '-' : Math.round(a.worst)).padStart(5)}ms)   ` +
      `long frames ${String(bad).padStart(3)} >25ms · ${String(bad50).padStart(3)} >50ms · worst ${String(worst).padStart(4)}ms   ` +
      `rows ${rows.map((r) => r.rows ?? 0).join('/')}${failed ? `   ‼ ${failed} never appeared` : ''}`,
    );
    return { median: a.median, worst: a.worst, over25: bad, over50: bad50, worstFrame: worst, failed };
  };

  console.log(`  ${name}   (${meter.done} decodes, ${meter.failed} refused)`);
  const s = line('sidebar', sidebar);
  const f = line('fullscreen', full);
  return { name, decode, decodes: meter.done, refused: meter.failed, sidebar: s, full: f, rawSidebar: sidebar, rawFull: full };
}

function graphState() {
  try {
    const g = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
    const es = Object.values((g.data || g).entries || {});
    const we = es.filter((e) => (e.majorEvents || []).length > 0);
    return { withEvents: we.length, chipsStale: we.filter((e) => !e.lmChipsKey).length };
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

app.whenReady().then(async () => {
  let w = await win(); prep(w);
  await setPrefs(w, { enabled: false, mode: 'off' });
  w.reload();
  await sleep(3500);
  w = await win(); prep(w);

  console.log(`\n${'═'.repeat(140)}`);
  console.log(`PANEL OPEN — click to pixels for the story timeline, ${CYCLES} cycles per arm, idle / decoding / idle`);
  console.log(`${'═'.repeat(140)}\n`);

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

  // Boot + first inference outside every arm.
  await sidecarCall(0);
  await sleep(1500);

  const rows = [];
  rows.push(await arm(w, 'idle', 0));
  rows.push(await arm(w, `decoding x${DECODE}`, DECODE));
  rows.push(await arm(w, 'idle (again)', 0));

  const idle = rows.filter((r) => !r.decode);
  const load = rows[1];
  const baseFull = idle.reduce((s, r) => s + (r.full.median || 0), 0) / idle.length;
  const baseSide = idle.reduce((s, r) => s + (r.sidebar.median || 0), 0) / idle.length;
  console.log('');
  console.log(`  sidebar     ${baseSide.toFixed(0)}ms idle  →  ${load.sidebar.median}ms under load   (${(100 * (load.sidebar.median - baseSide) / baseSide).toFixed(0)}%)`);
  console.log(`  fullscreen  ${baseFull.toFixed(0)}ms idle  →  ${load.full.median}ms under load   (${(100 * (load.full.median - baseFull) / baseFull).toFixed(0)}%)`);
  console.log(`  idle-arm drift: sidebar ${Math.abs(idle[0].sidebar.median - idle[1].sidebar.median)}ms · fullscreen ${Math.abs(idle[0].full.median - idle[1].full.median)}ms`);

  const file = path.join(OUT, 'panel-open.json');
  fs.writeFileSync(file, JSON.stringify({ cycles: CYCLES, decode: DECODE, rows }, null, 2));
  console.log(`\nwrote ${file}\n`);
  await assistant.unload().catch(() => {});
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
