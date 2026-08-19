/**
 * probe-engine-collision.cjs — is the freeze a model LOAD landing on top of a
 * DECODING engine?
 *
 * ★★ WHAT THE EARLIER RUNS ADD UP TO. Steady decoding costs nothing: the real
 *    chip and summary bytes at the shipped concurrency of 3 hold the GPU at
 *    94-98% for twenty seconds and drop not one frame (probe-gpu-yield.cjs,
 *    and buckets 2-3 of probe-timeline-stutter.cjs). A four-minute run whose
 *    two engine loads happened to fall in a gap between the sidecar booting
 *    and its first work saw 2 frames over 50ms in 240 seconds
 *    (probe-stall-events.cjs). The one window that DID stutter — five freezes
 *    of 379-540ms, none of them with a millisecond of blocking script — is the
 *    one where the in-process host loaded a model while the sidecar was
 *    already running three requests.
 *
 *    That is a hypothesis, and n=1 on each side. This measures it directly:
 *    the same host load/unload cycle with the sidecar idle, and again with the
 *    sidecar decoding, against a common baseline.
 *
 * ★ EACH PHASE IS DRIVEN, NOT WAITED FOR. Nothing here depends on the app's
 *   tick reaching a particular state — the harness owns the load and owns the
 *   reloads, so the two arms differ in exactly one thing.
 *
 * ★ THE RELOAD IS FORCED BY ALTERNATING TIERS, because that is the one thing
 *   ensureLoaded will not optimise away: a different modelPath is a full
 *   reload, and interleaved small-tier and max-tier surfaces are how the real
 *   app gets there.
 *
 *   ./node_modules/.bin/electron scripts/probe-engine-collision.cjs
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'bench-results');
const DATA = '/tmp/lw-collide-data';
const PROJECT = '/tmp/lw-collide-project';
const BOOK = process.env.BOOK
  || '/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels/hollow-iris.txt';
const CHAPTERS = Number(process.env.CHAPTERS || 6);
const PHASE_S = Number(process.env.PHASE_S || 25);
const STALL_MS = Number(process.env.STALL_MS || 40);
/** ★ CONCURRENCY IS A KNOB HERE FOR A MEMORY REASON, not a throughput one.
 *   Flipping the in-process host between the 1.7B and the 4B while the
 *   sidecar holds its own 4B puts ~5GB of weights in flight, and the first
 *   attempt at the conjunction phase took the whole app down. Two engines
 *   coexisting IS the shipped max-mode arrangement, so the phase stays — it
 *   just gets to choose how hard it leans on the machine. */
const DECODE = Number(process.env.DECODE || 2);
const REQS = JSON.parse(fs.readFileSync(process.env.REQS || '/tmp/bg-reqs.json', 'utf8'));
const REAL_USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'Latent Write');

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
fs.writeFileSync(path.join(PROJECT, '.renderer', 'project.json'),
  JSON.stringify({ name: 'Collide Book', created: Date.now(), lastOpened: Date.now() }));
fs.writeFileSync(path.join(DATA, 'last-project.json'),
  JSON.stringify({ path: PROJECT, updated: Date.now() }));
process.env.LW_USER_DATA = DATA;

const { app, BrowserWindow } = require('electron');
app.setName('Latent Write');
require(path.join(ROOT, 'electron', 'main.cjs'));
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (w, src) => w.webContents.executeJavaScript(src, true);

/** ★ THE GUARD MUST DECLARE ITSELF. ensureLoaded stops the sidecar outright
 *   when an in-process load will not fit ('yield-to-interactive'). If that
 *   fires during the conjunction phase then the two engines were never
 *   actually coexisting and the row means something else. */
const SIDECAR_STOPS = [];
const _realStop = assistant.sidecar.stop;
assistant.sidecar.stop = function wrappedStop(reason) {
  SIDECAR_STOPS.push(String(reason || ''));
  return _realStop.apply(this, arguments);
};

const STOPS = [];
const realSidecarStop = assistant.sidecar.stop;
assistant.sidecar.stop = function wrappedStop(reason) {
  STOPS.push(String(reason || ''));
  return realSidecarStop.apply(this, arguments);
};

let _seq = 0;
async function sidecarCall(i, lane = 'batch') {
  const req = REQS[i % REQS.length];
  return assistant.run({
    requestId: `col-${++_seq}`, task: 'timeline-chips', tier: 'max', lane,
    jsonStyle: 'compact', systemPrompt: req.systemPrompt, userText: req.userText,
    schema: req.schema, gbnf: req.gbnf, maxTokens: req.maxTokens, timeoutMs: 120_000,
  }).catch(() => null);
}
/**
 * ★★ A DRIVER THAT DOES NOT PAUSE ON FAILURE IS A BUSY LOOP IN THE MAIN
 *    PROCESS. In the BOTH phase the host's memory guard stops the sidecar
 *    ('yield-to-interactive'), so every call fell through to a host that was
 *    mid-load and answered 'busy' in microseconds — and this loop re-asked at
 *    full speed. Electron's main process pegged a core, executeJavaScript
 *    could not resolve, and a 25-second phase ran for six minutes without
 *    printing. The backoff below is the fix; the failure reasons are recorded
 *    because the eviction it exposed is part of the finding, not noise.
 */
function startDecoding(conc, stopFlag, meter, lane = 'batch') {
  const one = async (k) => {
    let i = k;
    while (!stopFlag.done) {
      const r = await sidecarCall(i, lane);
      i += conc;
      if (r && r.ok) meter.done++;
      else {
        meter.failed++;
        const why = (r && r.error) || 'null';
        meter.reasons[why] = (meter.reasons[why] || 0) + 1;
        await sleep(250);
      }
    }
  };
  return Promise.all(Array.from({ length: conc }, (_, k) => one(k)));
}

/** Alternate tiers in the in-process host: a different modelPath is the one
 *  thing ensureLoaded cannot reuse, so each call is a real load. */
async function hostReloadLoop(stopFlag, marksOut, T0) {
  let tier = 'small';
  while (!stopFlag.done) {
    const t = Date.now();
    const res = await assistant.ensureLoaded({ tier }).catch((e) => ({ ok: false, error: String(e) }));
    marksOut.push({
      t: +((t - T0) / 1000).toFixed(2),
      end: +((Date.now() - T0) / 1000).toFixed(2),
      tier, ok: !!(res && res.ok), reused: !!(res && res.reused), error: res && res.error,
    });
    tier = tier === 'small' ? 'max' : 'small';
    if (!stopFlag.done) await sleep(2000);
  }
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
  const t0 = performance.now(); const wall0 = Date.now();
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
    else resolve({ wall0, frames, fps: frames / ${seconds}, stalls,
      stallMsTotal: stalls.reduce((s, x) => s + x.ms, 0),
      longtaskMs: Math.round(longtasks.reduce((s, L) => s + L.d, 0)) });
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

async function phase(w, name, { decode, reload, lane = 'batch' }) {
  const T0 = Date.now();
  const stop = { done: false };
  const meter = { done: 0, failed: 0, reasons: {} };
  const loads = [];
  const decoding = decode ? startDecoding(decode, stop, meter, lane) : Promise.resolve();
  const reloading = reload ? hostReloadLoop(stop, loads, T0) : Promise.resolve();
  if (decode) await sleep(1500); // let the engine be genuinely mid-flight
  const r = await js(w, TRACE(PHASE_S, STALL_MS));
  stop.done = true;
  await Promise.race([Promise.all([decoding, reloading]), sleep(60_000)]);
  const realLoads = loads.filter((L) => !L.reused);
  const evicted = SIDECAR_STOPS.splice(0);
  console.log(
    `  ${name.padEnd(28)}│ ${r.fps.toFixed(1).padStart(5)} fps  ${String(r.stalls.length).padStart(3)} frames >${STALL_MS}ms  ` +
    `${String(r.stallMsTotal).padStart(5)}ms lost  worst ${String(r.stalls.length ? Math.max(...r.stalls.map((x) => x.ms)) : 0).padStart(4)}ms  ` +
    `longtask ${r.longtaskMs}ms │ ${String(meter.done).padStart(2)} decodes  ${String(realLoads.length).padStart(2)} loads`,
  );
  if (r.stalls.length) console.log(`                         stalls: ${r.stalls.slice(0, 12).map((x) => `${x.t}s/${x.ms}ms`).join(' ')}`);
  if (realLoads.length) console.log(`                         loads:  ${realLoads.map((L) => `${L.tier}@${L.t}-${L.end}s${L.ok ? '' : `!${L.error}`}`).join(' ')}`);
  if (evicted.length) console.log(`                         ‼ sidecar stopped during the phase: ${evicted.join(', ')}`);
  if (STOPS.length) console.log(`                         sidecar stopped ${STOPS.length}x: ${[...new Set(STOPS)].join(', ')}`);
  return { name, lane, decode: decode || 0, reload: !!reload, ...r, decodes: meter.done, failed: meter.failed, reasons: meter.reasons, loads: realLoads, sidecarStops: STOPS.splice(0) };
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
  w = await win(); prep(w);
  await js(w, `(() => { const b = document.querySelector('[aria-label="Story graph"]'); if (b) b.click(); return true; })()`);
  await sleep(1200);
  await js(w, `(() => { const b = document.querySelector('.sg-expand-btn'); if (b) b.click(); return true; })()`);
  await sleep(2000);
  console.log(`\n${'═'.repeat(132)}`);
  console.log(`ENGINE COLLISION — full-screen timeline, ${PHASE_S}s phases, frames over ${STALL_MS}ms`);
  console.log(`${'═'.repeat(132)}\n`);
  console.log(`  scene: ${JSON.stringify(await js(w, `(() => ({ svgNodes: document.querySelectorAll('svg *').length }))()`))}\n`);

  // Warm the sidecar OUTSIDE any measured phase, so a boot never lands inside one.
  await sidecarCall(0);
  await sleep(1500);

  const rows = [];
  rows.push(await phase(w, 'quiet', {}));
  rows.push(await phase(w, 'host reloads alone', { reload: true }));
  rows.push(await phase(w, 'sidecar decoding', { decode: 2 }));
  rows.push(await phase(w, 'BOTH', { decode: 2, reload: true }));
  // ★★ THERE WAS A SECOND 'BOTH' ROW HERE THAT PROVED NOTHING, and it is worth
  //    a line so it is not re-added. It passed lane:'background' expecting to
  //    measure the renderer's new priority split — but 'background' is a
  //    RENDERER-side concept: main routes on lane === 'batch' and nothing
  //    else, so the phase skipped the sidecar altogether and ran every request
  //    on the in-process host. It reported a clean 120.2 fps, which read like
  //    the fix working and was actually the fix not being under test.
  rows.push(await phase(w, 'quiet (again)', {}));

  const file = path.join(OUT, 'engine-collision.json');
  fs.writeFileSync(file, JSON.stringify({ phaseS: PHASE_S, stallMs: STALL_MS, rows }, null, 2));
  console.log(`\nwrote ${file}\n`);
  await assistant.unload().catch(() => {});
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
