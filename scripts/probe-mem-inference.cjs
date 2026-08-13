/**
 * probe-mem-inference.cjs — the inference memory anatomy, measured per
 * configuration in a fresh process, with the knob overrides riding env vars
 * so a knob's RSS delta and its OUTPUT BYTES can be compared in one place.
 *
 *   CONFIG=host-small   1.7B on the in-process host @4096 (shipped)
 *   CONFIG=host-max     4B on the in-process host @8192 (ask fallback path)
 *   CONFIG=sidecar      4B on llama-server (4x2048, ub128) via lane batch
 *   CONFIG=both         sidecar warm + host-small warm (the worst case)
 *
 * Knobs (each defaults to shipped behaviour when unset):
 *   ASSISTANT_BATCH_SIZE        host createContext batchSize
 *   ASSISTANT_SIDECAR_CACHE_RAM sidecar --cache-ram MiB
 *   ASSISTANT_SIDECAR_BATCH     sidecar -b logical batch
 *
 * Every run prints per-process RSS (main, helpers, llama-server) and the
 * RAW output of two fixed requests, so behaviour equality across knob
 * settings is a diff, not a hope.
 *
 *   CONFIG=sidecar ./node_modules/.bin/electron scripts/probe-mem-inference.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

app.setName('Latent Write');
const ROOT = path.join(__dirname, '..');
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

const CONFIG = process.env.CONFIG || 'sidecar';

let win = null;
const callBridge = (method, arg) => {
  const payload = JSON.stringify(arg === undefined ? null : arg);
  return win.webContents.executeJavaScript(
    `window.electronAPI.${method}(${payload === 'null' ? '' : payload})`, true,
  );
};

/** RSS of this app's process tree, labeled. */
function rssTable() {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid,ppid,rss,command'], { encoding: 'utf8' })
    .split('\n').slice(1).map((l) => l.trim()).filter(Boolean)
    .map((l) => {
      const m = l.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return m ? { pid: +m[1], ppid: +m[2], rssMB: Math.round(+m[3] / 1024), cmd: m[4] } : null;
    }).filter(Boolean);
  const mine = new Set([process.pid]);
  // Walk descendants of the probe's main process.
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (mine.has(r.ppid) && !mine.has(r.pid)) { mine.add(r.pid); grew = true; }
    }
  }
  const label = (cmd) =>
    /llama-server/.test(cmd) ? 'llama-server'
    : /Utility.*node|utility.*Node|--node-integration/.test(cmd) ? 'utility(node)'
    : /Helper \(GPU\)/.test(cmd) ? 'gpu-helper'
    : /Helper \(Renderer\)|--type=renderer/.test(cmd) ? 'renderer'
    : /Helper/.test(cmd) ? 'helper'
    : /electron/i.test(cmd) ? 'main'
    : 'other';
  const out = rows.filter((r) => mine.has(r.pid))
    .map((r) => ({ pid: r.pid, rssMB: r.rssMB, kind: label(r.cmd) }))
    .sort((a, b) => b.rssMB - a.rssMB);
  const total = out.reduce((a, r) => a + r.rssMB, 0);
  return { rows: out, total };
}

function printRss(tag) {
  const { rows, total } = rssTable();
  console.log(`\n[rss] ${tag} — total ${total}MB`);
  for (const r of rows.filter((x) => x.rssMB >= 20)) {
    console.log(`  ${String(r.rssMB).padStart(6)}MB  ${r.kind}  (${r.pid})`);
  }
  return total;
}

const SMALL_REQ = {
  systemPrompt: 'Answer as JSON: {"word"} — the single word asked for. Lower case.',
  userText: 'What is the opposite of "cold"? One word.',
  schema: { type: 'object', properties: { word: { type: 'string', maxLength: 20 } } },
  maxTokens: 24,
};
const MAX_REQ = {
  systemPrompt: 'Answer as JSON: {"summary"} — one plain sentence.',
  userText: 'Summarize in one sentence: The harbor emptied before the storm; only the pilot boat stayed, riding the swell by the light.',
  schema: { type: 'object', properties: { summary: { type: 'string', maxLength: 160 } } },
  maxTokens: 64,
};
// ★ THE LONG PROMPT IS THE REAL EQUALITY TEST for a batch-size knob: a
//   prompt short enough to prefill in one pass proves nothing about how
//   CHUNKED prefill accumulates. ~900 tokens of deterministic text forces
//   several chunks at batch 128 vs one-or-two at 512.
const LONG_PARA = Array.from({ length: 60 }, (_, i) =>
  `Paragraph ${i + 1}: the tide table for the ${i + 1}th day listed high water at ${(i % 12) + 1} o'clock, and the harbourmaster logged ${i + 3} boats out, ${(i * 7) % 13} returned by dusk, wind steady from the ${i % 2 ? 'north' : 'west'}.`,
).join(' ');
const LONG_REQ = {
  systemPrompt: 'Answer as JSON: {"answer"} — one plain sentence, no numbers invented.',
  userText: `${LONG_PARA}\n\nQuestion: on day 12, from which direction was the wind, and how many boats went out?`,
  schema: { type: 'object', properties: { answer: { type: 'string', maxLength: 200 } } },
  maxTokens: 64,
};

async function runFixed(tier, extra, tag) {
  const cases = [
    ['a', tier === 'small' ? SMALL_REQ : MAX_REQ],
    ['b', tier === 'small' ? SMALL_REQ : MAX_REQ],
    ['long', LONG_REQ],
  ];
  for (const [name, req] of cases) {
    const res = await callBridge('assistantRun', {
      requestId: `mem-${tag}-${name}`, task: 'probe-mem', tier,
      systemPrompt: req.systemPrompt, userText: name === 'b' ? `${req.userText} (second)` : req.userText,
      schema: req.schema, maxTokens: req.maxTokens, timeoutMs: 120000, contextSize: tier === 'small' ? 4096 : 8192,
      ...(tier === 'max' ? { noThink: false } : {}),
      ...extra,
    });
    console.log(`[out] ${tag}/${name}: ${res && res.ok ? JSON.stringify(res.raw) : `FAILED ${res && res.error}`}`);
  }
}

async function main() {
  assistant.registerAssistant();
  win = new BrowserWindow({
    show: false, width: 480, height: 320,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
    },
  });
  await win.loadURL('about:blank');
  console.log(`CONFIG=${CONFIG}  knobs: batch=${process.env.ASSISTANT_BATCH_SIZE || '-'} cacheRam=${process.env.ASSISTANT_SIDECAR_CACHE_RAM || '-'} sidecarBatch=${process.env.ASSISTANT_SIDECAR_BATCH || '-'}`);
  printRss('cold (nothing loaded)');

  if (CONFIG === 'host-small' || CONFIG === 'both') {
    await runFixed('small', {}, 'host-small');
    await new Promise((r) => setTimeout(r, 1500));
    printRss('host 1.7B @4096 warm');
    if (CONFIG === 'host-small') {
      await callBridge('assistantUnload');
      await new Promise((r) => setTimeout(r, 2500));
      printRss('host after UNLOAD (utility process lingering)');
    }
  }
  if (CONFIG === 'host-max') {
    await runFixed('max', {}, 'host-max');
    await new Promise((r) => setTimeout(r, 1500));
    printRss('host 4B @8192 warm');
  }
  if (CONFIG === 'sidecar' || CONFIG === 'both') {
    await runFixed('max', { lane: 'batch', jsonStyle: 'compact' }, 'sidecar');
    await new Promise((r) => setTimeout(r, 1500));
    printRss(CONFIG === 'both' ? 'sidecar warm + host-small warm' : 'sidecar 4B warm');
  }

  app.exit(0);
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
