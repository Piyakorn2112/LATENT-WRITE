/**
 * probe-ub-smoothness.cjs — does the engine's GPU work still leave the app's
 * frames alone?
 *
 * ★ WHY THIS EXISTS NOW. `-ub 128` is not a throughput choice, it is a
 *   SMOOTHNESS choice, made deliberately below the throughput optimum: at the
 *   default 512 a saturated sidecar dropped ~12% of the app's frames (p95
 *   17ms, worst 75ms), and at 128 the dispatches were short enough for the
 *   compositor to interleave (95% delivered, p95 12ms, nothing over 25ms).
 *   The copy step shipped today changes the shape of that trade WITHOUT
 *   anyone choosing to: a decode pass used to evaluate ONE position and now
 *   evaluates up to 49, so the dispatch pattern the 128 was chosen against no
 *   longer exists. Two questions follow, and the first one is not optional.
 *
 *     1. SAFETY — did shipping the copy step cost frames?
 *     2. HEADROOM — if not, can -ub go up, buying prefill (and therefore
 *        time-to-first-token) back at no smoothness cost?
 *
 * ★ THE LOAD IS REAL AND THE UI IS REAL. The window renders the actual built
 *   app, which never rests (the orb, the toolbar pulse and the mesh dots
 *   animate continuously, so it repaints on its own), and the load is an
 *   actual llama-server saturated with four concurrent chip requests. A
 *   synthetic scene or a synthetic load would measure neither.
 *
 * ★ FRAMES ARE COUNTED WITH VSYNC ON. Every other probe in this repo disables
 *   vsync to measure raw capacity; that is exactly wrong here. The question is
 *   whether the compositor DELIVERS on schedule, so the schedule has to exist.
 *
 * ★★ VERDICT (2026-08-18): THIS PROBE DOES NOT DISCRIMINATE. DO NOT USE IT TO
 *    JUSTIFY RAISING -ub. Five failed attempts and one clean run, and the
 *    clean run is the problem: with both witnesses satisfied (4 requests, 256
 *    tokens, GPU 97-100%) EVERY configuration reported 120 fps, p95 ~9ms and
 *    ZERO frames over 25ms — including on/2048, a positive control at
 *    SIXTEEN TIMES the shipped dispatch size, and including on/512, the
 *    setting already documented as dropping ~12% of frames with a worst case
 *    of 75ms. A harness that cannot separate a known-bad configuration from
 *    the shipped one is not evidence that the configurations are equal; it is
 *    evidence about the harness. "-ub has headroom" and "the copy step costs
 *    no frames" are both UNMEASURED, not confirmed.
 *
 *    The four earlier failures are kept in the comments below because every
 *    one of them printed a tidy, plausible table rather than an error:
 *      1. Chromium parked the unfocused window (a 65-SECOND frame gap).
 *      2. The load never completed a request inside the window, so the
 *         request counter read zero while looking like a clean result.
 *      3. A random ephemeral port collided with VS Code.
 *      4. setAlwaysOnTop(screen-saver), added to fix (1), plausibly handed the
 *         window compositor priority that insulated it from the contention.
 *
 *    What a working version probably needs: the ORIGINAL measurement's exact
 *    conditions (it was a fullscreen glass probe with the app's own sidecar
 *    driving it, not an external server), and a frame source the OS cannot
 *    quietly re-schedule — a CVDisplayLink or the compositor's own frame
 *    callbacks rather than requestAnimationFrame in a renderer.
 *
 *   ./node_modules/.bin/electron scripts/probe-ub-smoothness.cjs
 *   UB_CONFIGS="off/128,on/128,on/256,on/512" ...
 */
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SUPPORT = path.join(os.homedir(), 'Library/Application Support/Latent Write');
const MODEL = path.join(SUPPORT, 'models/Qwen3-4B-Thinking-2507-Q4_K_M.gguf');
const ENGINE = path.join(SUPPORT, 'engine', process.env.UB_BUILD || 'llama-b10298', 'llama-server');
const DATA = '/tmp/lw-ub-data';
const OUT = path.join(ROOT, 'bench-results', 'ub-smoothness.json');
const SECONDS = Number(process.env.UB_SECONDS) || 12;

// "<spec on|off>/<ub>" pairs. The first is the world the 128 was chosen in.
// ★ on/2048 IS A POSITIVE CONTROL, NOT A CANDIDATE. Sixteen times the shipped
//   dispatch size; if the harness cannot see frame cost even there, it cannot
//   speak to 512 either and the honest report is "insufficiently sensitive"
//   rather than "no cost found".
const CONFIGS = (process.env.UB_CONFIGS || 'idle,off/128,on/128,on/512,on/2048').split(',');

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.LW_USER_DATA = DATA;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ★★ THE ACCELERATOR'S OWN OPINION. Counting requests proves the client sent
 *    work; it does not prove the GPU did any. Two runs of this probe reported
 *    perfect frames, the first because Chromium had parked the window and the
 *    second because no request ever completed. A frame result is only worth
 *    reading beside a measurement from OUTSIDE the harness, so this samples
 *    the Metal accelerator's utilisation counter (no sudo) across the same
 *    window. Load proven means both witnesses agree.
 */
function gpuBusy() {
  try {
    const out = require('node:child_process')
      .execFileSync('/usr/sbin/ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'AGXAccelerator'], { encoding: 'utf8' });
    const m = /"Device Utilization %"=(\d+)/.exec(out);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}
function sampleGpu(stopFlag) {
  const xs = [];
  const loop = async () => {
    while (!stopFlag.done) { const v = gpuBusy(); if (v !== null) xs.push(v); await sleep(250); }
  };
  const done = loop();
  return { xs, done };
}

// ── the load ────────────────────────────────────────────────────────────────

let _server = null;
let _port = 0;

function serverArgs(ub, spec, port) {
  return [
    '-m', MODEL, '-c', String(4 * 2048), '-np', '4', '-fa', 'on',
    '-ctk', 'q8_0', '-ctv', 'q8_0', '-kvu',
    '-ub', String(ub),
    ...(spec ? ['--spec-type', 'ngram-mod', '--spec-ngram-mod-n-match', '48'] : []),
    '--cache-ram', '512', '--host', '127.0.0.1', '--port', String(port), '--no-webui',
  ];
}

/** ★ A RANDOM PORT IN THE EPHEMERAL RANGE IS SOMEONE ELSE'S PORT SOONER OR
 *    LATER. This run died on "couldn't bind HTTP server socket" because VS
 *    Code was listening on the number it drew. Ask the OS for a free one and
 *    hand that to the server, rather than guessing and hoping. */
async function freePort() {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startLoad(ub, spec) {
  _port = await freePort();
  const child = spawn(ENGINE, serverArgs(ub, spec, _port), { stdio: ['ignore', 'ignore', 'pipe'] });
  let tail = '';
  child.stderr.on('data', (d) => { tail = (tail + String(d)).slice(-4000); });
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}\n${tail}`);
    try { if ((await fetch(`http://127.0.0.1:${_port}/health`)).ok) { _server = child; return; } } catch { /* booting */ }
    await sleep(250);
  }
  child.kill('SIGKILL');
  throw new Error(`server never healthy\n${tail}`);
}

function stopLoad() {
  if (_server) { try { _server.kill('SIGKILL'); } catch { /* gone */ } _server = null; }
}

/** A chip-shaped request, long enough that the engine is busy for the whole
 *  measurement window rather than idling halfway through it. */
const PROMPT_BODY = Array.from({ length: 40 }, (_, i) =>
  `${i}. Ferren Ash told the room that the count had been short for eleven years, and she had signed every page of it.`).join('\n');

function fireLoad(stopFlag, meter) {
  const body = JSON.stringify({
    prompt: `<|im_start|>system\nYou summarise chapters for a novelist's timeline. Answer in JSON.\n/no_think<|im_end|>\n`
      + `<|im_start|>user\n${PROMPT_BODY}\n\nSummarise every line.<|im_end|>\n`
      + `<|im_start|>assistant\n<think>\n\n</think>\n\n`,
    // ★ SHORT ENOUGH TO COMPLETE INSIDE THE WINDOW. At n_predict 400 with four
    //   concurrent streams nothing finished in 14s, so the request counter read
    //   zero and could not distinguish "no load" from "load still working".
    //   64 keeps the server continuously busy AND continuously reporting.
    temperature: 0, n_predict: 64, cache_prompt: true, stream: false,
  });
  const one = async () => {
    while (!stopFlag.done) {
      try {
        const out = await fetch(`http://127.0.0.1:${_port}/completion`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body,
        }).then((r) => r.json());
        // ★★ THE LOAD MUST PROVE ITSELF. The first version of this probe
        //    reported every configuration at an identical 120.0 fps INCLUDING
        //    -ub 512, which is the setting originally measured dropping 12% of
        //    frames. A harness that cannot tell a known-bad config from a good
        //    one is not measuring; and the likeliest reason for a clean frame
        //    trace is that the GPU was never busy. So the requests count
        //    themselves, and a row with no tokens behind it is discarded.
        meter.requests++;
        meter.tokens += (out && out.timings && out.timings.predicted_n) || 0;
      } catch { /* the run is ending */ }
    }
  };
  return Promise.all([one(), one(), one(), one()]);
}

// ── the frames ──────────────────────────────────────────────────────────────

const FRAME_SCRIPT = (seconds) => `
new Promise((resolve) => {
  const gaps = [];
  let last = performance.now();
  const t0 = last;
  function tick(now) {
    gaps.push(now - last);
    last = now;
    if (now - t0 < ${seconds * 1000}) requestAnimationFrame(tick);
    else {
      gaps.shift(); // the first gap spans the call, not a frame
      const sorted = [...gaps].sort((a, b) => a - b);
      const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
      resolve({
        frames: gaps.length,
        seconds: (now - t0) / 1000,
        fps: gaps.length / ((now - t0) / 1000),
        median: at(0.5), p95: at(0.95), worst: sorted[sorted.length - 1],
        over25: gaps.filter((g) => g > 25).length,
        over50: gaps.filter((g) => g > 50).length,
      });
    }
  }
  requestAnimationFrame(tick);
})`;

async function win() {
  for (let i = 0; i < 160; i++) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.webContents.isLoading()) return w;
    await sleep(250);
  }
  throw new Error('no window');
}

app.setName('Latent Write');
require(path.join(ROOT, 'electron', 'main.cjs'));

app.whenReady().then(async () => {
  const w = await win();
  w.setSize(1440, 900);
  if (process.env.UB_FULLSCREEN !== '0') w.setFullScreen(true);
  w.show();
  // ★★ THE FIRST RUN OF THIS PROBE MEASURED A 65-SECOND FRAME GAP, which is
  //    not a stutter, it is Chromium's background throttling: the terminal has
  //    focus, so the window is not frontmost, so rAF is throttled to a crawl
  //    or paused outright. A frame probe that lets the OS park the window is
  //    measuring the OS, not the engine. Both of these are required — one
  //    keeps it composited, the other stops the throttle.
  // ★★ AND THE FIX FOR THAT CAN ITSELF DISTORT THE ANSWER. The first version
  //    of this used setAlwaysOnTop(screen-saver) to stop the parking, and a
  //    window floated above the screen-saver layer may be scheduled by the
  //    compositor differently from a normal one — which would insulate it from
  //    exactly the contention being measured. So the window is made genuinely
  //    FRONTMOST instead: an ordinary focused window is not throttled and is
  //    scheduled like any other, which is the condition the question is about.
  app.focus({ steal: true });
  w.focus();
  w.moveTop();
  w.webContents.setBackgroundThrottling(false);
  await sleep(4000); // fonts, glass, the orb settling into its loop

  // Past the welcome screen so the measured surface is the real editor.
  await w.webContents.executeJavaScript(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => /start your own book|back to your book/i.test(x.textContent || ''));
    if (b) b.click();
    return !!b;
  })()`, true);
  await sleep(3000);

  const rows = [];
  for (const cfg of CONFIGS) {
    const idle = cfg === 'idle';
    const [specTag, ubTag] = idle ? ['off', '-'] : cfg.split('/');
    process.stdout.write(`  ${cfg.padEnd(9)} … `);
    if (!idle) await startLoad(Number(ubTag), specTag === 'on');
    const stopFlag = { done: false };
    const meter = { requests: 0, tokens: 0 };
    const load = idle ? Promise.resolve() : fireLoad(stopFlag, meter);
    await sleep(2500); // let the load reach steady state before counting
    const gpuFlag = { done: false };
    const gpu = sampleGpu(gpuFlag);
    let r = null;
    try {
      r = await w.webContents.executeJavaScript(FRAME_SCRIPT(SECONDS), true);
    } catch (e) {
      r = null;
      console.log(`measurement failed: ${e.message}`);
    }
    if (!r || typeof r.fps !== 'number') {
      stopFlag.done = true; stopLoad();
      rows.push({ config: cfg, spec: specTag, ub: ubTag, failed: true });
      console.log('  (no frame data)');
      continue;
    }
    gpuFlag.done = true;
    await gpu.done;
    const gpuMean = gpu.xs.length ? gpu.xs.reduce((a, b) => a + b, 0) / gpu.xs.length : -1;
    stopFlag.done = true;
    await Promise.race([load, sleep(3000)]);
    stopLoad();
    await sleep(1500);
    rows.push({ config: cfg, spec: specTag, ub: ubTag, ...r, ...meter, gpuMean,
      loadProven: idle ? gpuMean < 40 : (meter.tokens > 200 && gpuMean > 50) });
    console.log(
      `${r.fps.toFixed(1)} fps   median ${r.median.toFixed(1)}ms   p95 ${r.p95.toFixed(1)}ms   worst ${r.worst.toFixed(0)}ms   >25ms ${r.over25}`
      + `   load ${meter.requests} req / ${meter.tokens} tok / gpu ${gpuMean.toFixed(0)}%`
      + (r.worst > 1000 ? '   ← THROTTLED, not jank: discard this row' : '')
      + (!idle && !(meter.tokens > 200 && gpuMean > 50) ? '   ← LOAD NOT PROVEN: row is meaningless' : ''),
    );
  }

  console.log('');
  const head = ['config', 'fps', 'median', 'p95', 'worst', '>25ms', '>50ms', 'vs idle', 'tokens', 'gpu%'];
  console.log(head.map((h, i) => h.padEnd(i === 0 ? 12 : 10)).join(''));
  const idleRow = rows.find((r) => r.config === 'idle');
  for (const r of rows.filter((x) => !x.failed)) {
    const rel = idleRow ? `${(((r.fps - idleRow.fps) / idleRow.fps) * 100).toFixed(1)}%` : '-';
    console.log([
      r.config, r.fps.toFixed(1), r.median.toFixed(1), r.p95.toFixed(1),
      r.worst.toFixed(0), String(r.over25), String(r.over50), rel,
      r.loadProven ? String(r.tokens) : `${r.tokens} !`,
      r.gpuMean >= 0 ? r.gpuMean.toFixed(0) : '-',
    ].map((v, i) => String(v).padEnd(i === 0 ? 12 : 10)).join(''));
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));
  console.log(`\nwrote ${OUT}\n`);
  app.exit(0);
}).catch((e) => { console.error(e); stopLoad(); app.exit(1); });
