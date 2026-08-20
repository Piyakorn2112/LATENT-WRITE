/**
 * probe-ask-latency.cjs — what a writer's request costs while the app is
 * converging chapters behind them.
 *
 * ★ THE ORDERING CLAIM IS ALREADY PROVEN EXACTLY, deterministically, against a
 *   stub bridge (verify:assistant-lanes): an interactive arrival is dispatched
 *   immediately and the background runs hand their slots back. This is the
 *   other half — the WALL CLOCK the writer actually feels, on the real engine,
 *   with the real chip request bytes as the load.
 *
 * Three arms, each an ask-shaped request timed end to end:
 *
 *   idle        nothing else on the engine — the floor
 *   contended   three background requests already in flight and left alone,
 *               which is what the single shared FIFO pool produced
 *   preempted   the same three, cancelled the instant the ask arrives, which
 *               is what the background lane does
 *
 * ★ THE LOAD MUST BE PROVEN IN FLIGHT before the ask is timed, or "contended"
 *   is just another idle arm wearing a label. Each arm asserts the sidecar's
 *   own inflight count at the moment the ask goes out.
 *
 * ★ BRACKETED: idle runs first and last, and the two bound the drift.
 *
 *   ./node_modules/.bin/electron scripts/probe-ask-latency.cjs
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'bench-results');
const DATA = '/tmp/lw-asklat-data';
const REPS = Number(process.env.REPS || 4);
const BG = Number(process.env.BG || 3);
const REQS = JSON.parse(fs.readFileSync(process.env.REQS || '/tmp/bg-reqs.json', 'utf8'));
const REAL_USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'Latent Write');

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
for (const dir of ['models', 'engine']) {
  const real = path.join(REAL_USER_DATA, dir);
  if (fs.existsSync(real)) fs.symlinkSync(real, path.join(DATA, dir));
}
process.env.LW_USER_DATA = DATA;

const { app } = require('electron');
app.setName('Latent Write');
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _seq = 0;
function call(kind, i, requestIds) {
  const req = REQS[i % REQS.length];
  const requestId = `${kind}-${++_seq}`;
  if (requestIds) requestIds.push(requestId);
  return assistant.run({
    requestId,
    task: kind === 'ask' ? 'max-ask' : 'timeline-chips',
    tier: 'max', lane: 'batch', jsonStyle: 'compact',
    systemPrompt: req.systemPrompt, userText: req.userText,
    schema: req.schema, gbnf: req.gbnf, maxTokens: req.maxTokens, timeoutMs: 120_000,
  }).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
}

/** Keep `n` background requests on the engine until told to stop. */
function background(n, stopFlag, live) {
  const one = async (k) => {
    let i = k;
    while (!stopFlag.done) {
      const ids = [];
      const p = call('bg', i, ids);
      live.set(ids[0], true);
      const r = await p;
      live.delete(ids[0]);
      i += n;
      if (!(r && r.ok) && !stopFlag.done) await sleep(200);
    }
  };
  return Promise.all(Array.from({ length: n }, (_, k) => one(k)));
}

async function arm(name, { bg, preempt }) {
  const times = [];
  const inflightAtAsk = [];
  const stop = { done: false };
  const live = new Map();
  const running = bg ? background(bg, stop, live) : Promise.resolve();
  if (bg) {
    // Wait until the engine really is carrying the load.
    for (let i = 0; i < 100; i++) {
      if (assistant.sidecar.status().inflight >= Math.min(bg, 2)) break;
      await sleep(200);
    }
  }
  for (let r = 0; r < REPS; r++) {
    inflightAtAsk.push(assistant.sidecar.status().inflight);
    if (preempt) {
      // What the background lane does the moment an interactive job arrives.
      for (const id of [...live.keys()]) assistant.cancel({ requestId: id });
    }
    const t0 = Date.now();
    const res = await call('ask', r);
    times.push({ ms: Date.now() - t0, ok: !!(res && res.ok), error: res && res.error });
    await sleep(400);
  }
  stop.done = true;
  await Promise.race([running, sleep(60_000)]);

  const ok = times.filter((t) => t.ok).map((t) => t.ms).sort((a, b) => a - b);
  const median = ok.length ? ok[Math.floor(ok.length / 2)] : null;
  const failed = times.filter((t) => !t.ok);
  console.log(
    `  ${name.padEnd(11)}│ median ${String(median ?? '-').padStart(6)}ms   all ${times.map((t) => (t.ok ? t.ms : `!${t.error}`)).join(' ')}   ` +
    `sidecar inflight at ask: ${inflightAtAsk.join('/')}`,
  );
  return { name, median, times, inflightAtAsk, failed: failed.length };
}

app.whenReady().then(async () => {
  console.log(`\n${'═'.repeat(120)}`);
  console.log(`ASK LATENCY — one writer-facing request, ${REPS} reps per arm, against ${BG} background requests`);
  console.log(`${'═'.repeat(120)}\n`);

  // Boot and first inference outside every arm: a 13s sidecar boot inside one
  // would swamp the difference the arms exist to show.
  await call('warm', 0);
  await sleep(1500);

  const rows = [];
  rows.push(await arm('idle', {}));
  rows.push(await arm('contended', { bg: BG }));
  rows.push(await arm('preempted', { bg: BG, preempt: true }));
  rows.push(await arm('idle (again)', {}));

  const idles = rows.filter((r) => r.name.startsWith('idle') && r.median !== null);
  const base = idles.reduce((s, r) => s + r.median, 0) / idles.length;
  const contended = rows[1].median;
  const preempted = rows[2].median;
  console.log('');
  console.log(`  idle floor ${base.toFixed(0)}ms  (drift between the two idle arms ${Math.abs(idles[0].median - idles[1].median)}ms)`);
  if (contended !== null) console.log(`  sharing the pool with ${BG} chapters: ${contended}ms   (${(100 * (contended - base) / base).toFixed(0)}%)`);
  if (preempted !== null) console.log(`  handing the slots back first:      ${preempted}ms   (${(100 * (preempted - base) / base).toFixed(0)}%)`);

  const file = path.join(OUT, 'ask-latency.json');
  fs.writeFileSync(file, JSON.stringify({ reps: REPS, bg: BG, rows }, null, 2));
  console.log(`\nwrote ${file}\n`);
  await assistant.unload().catch(() => {});
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
