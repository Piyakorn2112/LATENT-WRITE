/**
 * verify-assistant-runtime.cjs — the local assistant runtime, end to end.
 *
 * Drives the REAL path: registerAssistant() in the main process → preload
 * bridge → ipcMain.handle → utilityProcess host → node-llama-cpp → Metal.
 * Every call below goes through `window.electronAPI.assistant*` in a real
 * (sandboxed, contextIsolated) renderer, so a broken preload fails the gate.
 *
 * Gates:
 *   1. three grammar-constrained completions parse AND validate
 *   2. a fourth run cancelled mid-generation returns a clean cancellation,
 *      and the runtime still answers correctly afterwards
 *   3. unload exits the utilityProcess and gives the memory back (measured)
 *
 * Run:
 *   npx electron scripts/verify-assistant-runtime.cjs
 *   ASSISTANT_MODEL_PATH=/path/to/model.gguf npx electron scripts/verify-assistant-runtime.cjs
 *
 * Exit 0 = pass (or SKIP when there is no model and no network), 1 = fail.
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

// Match the shipping app so userData (and therefore the models dir) resolves to
// the same place the real app uses. Electron would otherwise call this "Electron".
app.setName('Latent Write');

const assistant = require(path.join(__dirname, '..', 'electron', 'assistant.cjs'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function gate(label, cond, detail) {
  results.push({ label, cond: !!cond, detail });
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : `  — ${detail ?? ''}`}`);
}

function rssKb(pid) {
  if (!pid) return 0;
  try {
    return Number(execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) || 0;
  } catch { return 0; }
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

// ── the payloads ────────────────────────────────────────────────────────────
// Deliberately generic: the runtime must have zero knowledge of the app domain.

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    label: { enum: ['positive', 'negative', 'neutral'] },
    confidence: { type: 'number' },
  },
  required: ['label', 'confidence'],
};

const CLASSIFY_SYSTEM =
  'You classify the sentiment of a short text snippet.\n' +
  'Answer as JSON: {"label","confidence"}.\n' +
  'label is one of "positive", "negative", "neutral".\n' +
  'confidence is a number between 0 and 1.';

const SNIPPETS = [
  { text: 'The soup was cold and the waiter never came back.', expect: 'negative' },
  { text: 'I have never felt lighter; the whole street seemed to shine.', expect: 'positive' },
  { text: 'The train departs at 6:14 from platform two.', expect: 'neutral' },
];

// A long free-text field so generation lasts long enough to be interrupted.
const LONG_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, notes: { type: 'string' } },
  required: ['summary', 'notes'],
};

// ── renderer bridge ─────────────────────────────────────────────────────────

let win = null;

async function callBridge(method, arg) {
  const payload = JSON.stringify(arg === undefined ? null : arg);
  return win.webContents.executeJavaScript(
    `window.electronAPI.${method}(${payload === 'null' ? '' : payload})`,
    true,
  );
}

async function main() {
  console.log('\n── assistant runtime verification ─────────────────────────────');
  console.log(`electron ${process.versions.electron} · node ${process.versions.node} · ${process.platform}/${process.arch}`);
  console.log(`node-llama-cpp ${require(path.join(__dirname, '..', 'node_modules', 'node-llama-cpp', 'package.json')).version}`);
  console.log(`userData      : ${app.getPath('userData')}`);
  console.log(`models dir    : ${assistant.modelsDir()}`);
  console.log(`available mem : ${mb(assistant.availableMemoryBytes())}`);

  assistant.registerAssistant();

  win = new BrowserWindow({
    show: false,
    width: 480,
    height: 320,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
    },
  });
  await win.loadURL('about:blank');

  const hasBridge = await win.webContents.executeJavaScript(
    'typeof window.electronAPI?.assistantRun === "function"', true,
  );
  gate('preload exposes the assistant bridge', hasBridge, 'window.electronAPI.assistantRun missing');
  if (!hasBridge) return finish();

  // Progress events must reach a renderer.
  await win.webContents.executeJavaScript(
    'window.__progress = []; window.electronAPI.onAssistantProgress((d) => window.__progress.push(d)); true', true,
  );

  // ── model resolution ──────────────────────────────────────────────────────
  let status = await callBridge('assistantStatus');
  console.log(`\nmodel         : ${status.model.label}  (${status.model.id})`);
  console.log(`model path    : ${status.model.path}`);
  console.log(`initial state : ${status.state}`);

  if (!status.model.present) {
    console.log('model absent — attempting download…');
    const ensured = await callBridge('assistantEnsureModel', { tier: 'small' });
    if (!ensured.ok) {
      console.log(`\nSKIP — no model on disk and the download failed: ${ensured.error}`);
      console.log('(set ASSISTANT_MODEL_PATH to a local .gguf to run this offline)');
      app.exit(0);
      return;
    }
    console.log(`downloaded    : ${ensured.path} (${ensured.source})`);
  } else {
    // Still exercise ensure-model: it must be a cheap no-op / sidecar writer.
    const ensured = await callBridge('assistantEnsureModel', { tier: 'small' });
    gate('ensure-model resolves an existing file without re-downloading',
      ensured.ok && ensured.source !== 'download', JSON.stringify(ensured));
  }

  const modelPath = (await callBridge('assistantStatus')).model.path;
  const modelBytes = fs.statSync(modelPath).size;
  console.log(`model bytes   : ${modelBytes} (${mb(modelBytes)})`);
  const sidecar = `${modelPath}.sha256`;
  if (fs.existsSync(sidecar)) console.log(`sha256        : ${fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0]}`);

  const mainRssBefore = process.memoryUsage().rss;

  // ── gate 1 — three grammar-constrained completions ────────────────────────
  console.log('\n[1] three grammar-constrained completions');
  const runStats = [];
  let allValid = true;
  let agreed = 0;

  for (let i = 0; i < SNIPPETS.length; i++) {
    const s = SNIPPETS[i];
    const res = await callBridge('assistantRun', {
      requestId: `classify-${i}`,
      task: 'sentiment',
      systemPrompt: CLASSIFY_SYSTEM,
      userText: `TEXT: ${s.text}`,
      schema: CLASSIFY_SCHEMA,
      maxTokens: 128,
    });

    const j = res.json;
    const valid =
      res.ok &&
      j && typeof j === 'object' &&
      ['positive', 'negative', 'neutral'].includes(j.label) &&
      typeof j.confidence === 'number' && Number.isFinite(j.confidence);

    if (!valid) allValid = false;
    if (valid && j.label === s.expect) agreed++;
    if (res.timings) runStats.push(res.timings);

    const t = res.timings || {};
    console.log(
      `    #${i + 1} ${valid ? 'ok ' : 'BAD'}  ${JSON.stringify(res.json ?? res.error)}` +
      `  expect=${s.expect}  prefill=${t.prefillMs}ms gen=${t.genMs}ms tok=${t.tokens} ${t.tokensPerSec} tok/s`,
    );
    if (!res.ok) console.log(`        raw: ${JSON.stringify(res.raw)} detail: ${res.detail ?? ''}`);
  }

  gate('all 3 completions parse and validate against the schema', allValid,
    'at least one completion failed grammar parse or schema validation');
  gate('labels are semantically sane (>=2 of 3 match the obvious answer)', agreed >= 2,
    `only ${agreed}/3 matched`);

  const totTok = runStats.reduce((a, t) => a + t.tokens, 0);
  const totGen = runStats.reduce((a, t) => a + t.genMs, 0);
  const tps = totGen > 0 ? (totTok / (totGen / 1000)) : 0;
  console.log(`    aggregate: ${totTok} tokens in ${totGen}ms generation → ${tps.toFixed(1)} tok/s`);

  const loadedStatus = await callBridge('assistantStatus');
  const hostPid = loadedStatus.host.pid;
  const loaded = loadedStatus.host.loaded || {};
  console.log(`    host pid ${hostPid} · gpu=${loaded.gpu} · gpuLayers=${loaded.gpuLayers} · ctx=${loaded.contextSize} · loadMs=${loaded.loadMs}`);
  gate('host runs in a separate utilityProcess', !!hostPid && hostPid !== process.pid, `pid=${hostPid}`);
  gate('model is offloaded to the GPU (Metal)', loaded.gpu === 'metal' && loaded.gpuLayers > 0,
    `gpu=${loaded.gpu} layers=${loaded.gpuLayers}`);

  const hostRssLoaded = rssKb(hostPid) * 1024;
  console.log(`    host RSS while loaded: ${mb(hostRssLoaded)}`);

  // ── gate 2 — cancellation mid-generation ──────────────────────────────────
  console.log('\n[2] cancellation mid-generation');
  const cancelId = 'cancel-me';
  const pending = callBridge('assistantRun', {
    requestId: cancelId,
    task: 'long-form',
    systemPrompt: 'You write long, detailed prose. Answer as JSON: {"summary","notes"}. ' +
      'Both fields must be several hundred words of continuous prose.',
    userText: 'Describe the history of the printing press in exhaustive detail.',
    schema: LONG_SCHEMA,
    maxTokens: 900,
    timeoutMs: 120000,
  });

  // Wait until the host is actually generating, then interrupt.
  let becameBusy = false;
  for (let i = 0; i < 60; i++) {
    await wait(50);
    const st = await callBridge('assistantStatus');
    if (st.state === 'busy') { becameBusy = true; break; }
  }
  await wait(700);
  const cancelAck = await callBridge('assistantCancel', { requestId: cancelId });
  const tCancel = Date.now();
  const cancelled = await pending;
  const cancelLatency = Date.now() - tCancel;

  gate('status reports busy during a run', becameBusy, 'never observed state="busy"');
  gate('cancel is acknowledged', cancelAck.ok, JSON.stringify(cancelAck));
  gate('cancelled run returns cancelled:true, not an exception', cancelled.cancelled === true,
    JSON.stringify({ ok: cancelled.ok, error: cancelled.error, stopReason: cancelled.stopReason }));
  gate('cancelled run reports stopReason "abort"', cancelled.stopReason === 'abort' || cancelled.error === 'cancelled',
    `stopReason=${cancelled.stopReason} error=${cancelled.error}`);
  console.log(`    aborted after ${cancelled.timings?.tokens ?? 0} tokens` +
    ` (gen ${cancelled.timings?.genMs ?? 0}ms, ${cancelled.timings?.tokensPerSec ?? 0} tok/s);` +
    ` cancel→return ${cancelLatency}ms`);

  // The real proof of a CLEAN cancellation: the next request still works.
  const after = await callBridge('assistantRun', {
    requestId: 'after-cancel',
    task: 'sentiment',
    systemPrompt: CLASSIFY_SYSTEM,
    userText: `TEXT: ${SNIPPETS[0].text}`,
    schema: CLASSIFY_SCHEMA,
    maxTokens: 128,
  });
  gate('runtime is usable immediately after a cancellation',
    after.ok && ['positive', 'negative', 'neutral'].includes(after.json?.label),
    JSON.stringify(after.json ?? after.error));
  console.log(`    post-cancel run: ${JSON.stringify(after.json)}  ${after.timings?.tokensPerSec} tok/s`);

  // ── gate 3 — unload frees the process and the memory ──────────────────────
  console.log('\n[3] unload');
  const hostRssBeforeUnload = rssKb(hostPid) * 1024;
  const unloadRes = await callBridge('assistantUnload');
  await wait(1500);

  const stillAlive = pidAlive(hostPid);
  const hostRssAfter = rssKb(hostPid) * 1024;
  const mainRssAfter = process.memoryUsage().rss;
  const statusAfter = await callBridge('assistantStatus');

  console.log(`    host RSS before unload : ${mb(hostRssBeforeUnload)}  (pid ${hostPid})`);
  console.log(`    host RSS after unload  : ${mb(hostRssAfter)}  (process ${stillAlive ? 'ALIVE' : 'gone'})`);
  console.log(`    main RSS before/after  : ${mb(mainRssBefore)} → ${mb(mainRssAfter)}`);
  console.log(`    reclaimed              : ${mb(hostRssBeforeUnload - hostRssAfter)}`);

  gate('unload reports the pid it killed', unloadRes.ok && unloadRes.pid === hostPid, JSON.stringify(unloadRes));
  gate('utilityProcess actually exited', !stillAlive, `pid ${hostPid} still alive`);
  gate('host RSS while loaded exceeded the weights', hostRssBeforeUnload > modelBytes * 0.5,
    `${mb(hostRssBeforeUnload)} vs weights ${mb(modelBytes)}`);
  gate('unload reclaimed the host RSS', hostRssAfter === 0 && hostRssBeforeUnload > 0,
    `after=${mb(hostRssAfter)}`);
  gate('status returns to "ready" (model on disk, nothing resident)',
    statusAfter.state === 'ready' && statusAfter.host.alive === false, JSON.stringify(statusAfter.state));

  // A run after unload must transparently re-fork.
  const revived = await callBridge('assistantRun', {
    requestId: 'revive',
    task: 'sentiment',
    systemPrompt: CLASSIFY_SYSTEM,
    userText: `TEXT: ${SNIPPETS[1].text}`,
    schema: CLASSIFY_SCHEMA,
    maxTokens: 128,
  });
  const revivedPid = (await callBridge('assistantStatus')).host.pid;
  gate('a run after unload transparently re-forks the host', revived.ok && revivedPid && revivedPid !== hostPid,
    `ok=${revived.ok} pid=${revivedPid} (was ${hostPid})`);
  await callBridge('assistantUnload');

  // ── gate 4 — the free-memory guard can actually refuse ────────────────────
  // Prove the test can fail (colour-wheel discipline): with an absurd headroom
  // the guard must refuse to load, and must recover once it is removed.
  console.log('\n[4] free-memory guard');
  process.env.ASSISTANT_MEMORY_HEADROOM_MB = '9999999';
  const refused = await callBridge('assistantRun', {
    requestId: 'guard', task: 'sentiment', systemPrompt: CLASSIFY_SYSTEM,
    userText: `TEXT: ${SNIPPETS[0].text}`, schema: CLASSIFY_SCHEMA,
  });
  const guardStatus = await callBridge('assistantStatus');
  gate('guard refuses to load when memory is short', refused.ok === false && refused.error === 'low-memory',
    JSON.stringify({ ok: refused.ok, error: refused.error }));
  gate('status reports "low-memory"', guardStatus.state === 'low-memory', guardStatus.state);
  gate('nothing was loaded while refusing', guardStatus.host.loaded === null,
    JSON.stringify(guardStatus.host.loaded));
  console.log(`    needed ${mb(refused.detail?.needBytes ?? 0)}, available ${mb(refused.detail?.availableBytes ?? 0)}`);

  delete process.env.ASSISTANT_MEMORY_HEADROOM_MB;
  const recovered = await callBridge('assistantRun', {
    requestId: 'guard-recovered', task: 'sentiment', systemPrompt: CLASSIFY_SYSTEM,
    userText: `TEXT: ${SNIPPETS[0].text}`, schema: CLASSIFY_SCHEMA,
  });
  gate('guard clears once memory is available again', recovered.ok === true,
    JSON.stringify(recovered.error));
  await callBridge('assistantUnload');

  // ── optional gate 5 — Range-resume of an interrupted download ─────────────
  // Opt-in (`--resume`): it moves the real model aside, truncates a .part, and
  // makes the runtime finish the download. Restores the original either way.
  if (process.argv.includes('--resume')) {
    console.log('\n[5] interrupted download resumes from a Range offset');
    const backup = `${modelPath}.verify-backup`;
    const partPath = `${modelPath}.part`;
    const TAIL = 8 * 1024 * 1024;
    try {
      fs.renameSync(modelPath, backup);
      const fd = fs.openSync(partPath, 'w');
      const src = fs.openSync(backup, 'r');
      const buf = Buffer.alloc(1024 * 1024);
      let copied = 0;
      while (copied < modelBytes - TAIL) {
        const want = Math.min(buf.length, modelBytes - TAIL - copied);
        const read = fs.readSync(src, buf, 0, want, copied);
        if (!read) break;
        fs.writeSync(fd, buf, 0, read);
        copied += read;
      }
      fs.closeSync(fd); fs.closeSync(src);
      console.log(`    seeded ${mb(copied)} of ${mb(modelBytes)} as .part (${mb(modelBytes - copied)} missing)`);

      const t0 = Date.now();
      const ensured = await callBridge('assistantEnsureModel', { tier: 'small' });
      const ms = Date.now() - t0;
      const progress = await win.webContents.executeJavaScript('window.__progress.length', true);
      const finalSize = fs.existsSync(modelPath) ? fs.statSync(modelPath).size : 0;

      gate('resumed download completes and verifies', ensured.ok === true && ensured.source === 'download',
        JSON.stringify(ensured));
      gate('resumed file is byte-complete and sha256 matches',
        finalSize === modelBytes && ensured.sha256 === '' + (fs.readFileSync(`${modelPath}.sha256`, 'utf8').trim().split(/\s+/)[0]),
        `size=${finalSize} sha=${ensured.sha256}`);
      gate('progress events reached the renderer', progress > 0, `${progress} events`);
      console.log(`    fetched the missing tail in ${ms}ms · ${progress} throttled progress events`);
    } catch (err) {
      gate('resume test ran without throwing', false, String(err && err.message || err));
    } finally {
      if (!fs.existsSync(modelPath) && fs.existsSync(backup)) fs.renameSync(backup, modelPath);
      else fs.rmSync(backup, { force: true });
      fs.rmSync(partPath, { force: true });
    }
  } else {
    console.log('\n[5] download-resume gate skipped (pass --resume to run it; it re-fetches ~8 MB)');
  }

  console.log(`\ntokens/sec (steady state, ${SNIPPETS.length} short JSON completions): ${tps.toFixed(1)}`);
  finish();
}

function finish() {
  const failed = results.filter((r) => !r.cond).length;
  console.log(`\n${failed ? `FAILED ${failed}/${results.length}` : `PASS ${results.length}/${results.length}`}`);
  app.exit(failed ? 1 : 0);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('\nharness error:', err && err.stack || err);
    app.exit(1);
  }),
);
