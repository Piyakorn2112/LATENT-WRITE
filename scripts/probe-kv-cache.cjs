/**
 * probe-kv-cache.cjs — what KV-cache quantization costs and saves, per tier.
 *
 * ★ THE 4B ALREADY HAS IT. `kvCacheType: 'Q8_0'` plus flash attention halves
 *   its KV cache and the registry says so. The 1.7B has NEITHER, and nothing
 *   ever measured whether that was a decision or an omission — this answers it
 *   on the real model, on this hardware.
 *
 * ★★ RSS DOES NOT MEASURE THE KV CACHE ON THIS PLATFORM, and the control is
 *    how that was established rather than assumed. Two runs of the IDENTICAL
 *    f16 configuration, each in its own fresh process, read 1930 MB and
 *    2534 MB — 604 MB apart, wider than any gap between the configurations
 *    being compared. The weights are mmapped, so how much of the 2.5 GB file
 *    counts as resident depends on system pressure, and Metal's unified
 *    memory is not attributed to the process at all. The RSS column below is
 *    printed and must not be quoted.
 *
 * ★  WHAT IS TRUSTWORTHY HERE IS GENERATION TIME AND THE ANSWER ITSELF. The
 *    two f16 runs agreed to 3ms, so a timing difference outside that band is
 *    real; and the same prompt run twice either produces the same bytes or it
 *    does not. A compression that changes an answer is not free however much
 *    it saves.
 *
 * ★ AND IT REPORTS WHAT WAS APPLIED, NOT WHAT WAS ASKED FOR. The binding's
 *   KV-type option is experimental and the host falls back to a plain context
 *   when it refuses; a probe that trusted the request would report a saving
 *   that never happened.
 *
 * ★★ ONE CONFIG PER PROCESS, AND THE FIRST DRAFT DID NOT DO THAT. Measuring
 *    three configurations in one long-lived process read 2375 MB for f16 and
 *    2901 MB for THE SAME f16 config four minutes later — a 526 MB spread
 *    between identical settings, larger than any gap between the settings
 *    themselves. Allocator arenas, the OS page cache and Metal driver buffers
 *    all accumulate, and every one of them reads as a difference between
 *    CONFIGURATIONS when it is nothing but a difference between EARLIER and
 *    LATER. A repeat-the-first control is what exposed it; a fresh process per
 *    configuration is what fixes it.
 *
 * Run: CONFIG=f16 TIER=max ./node_modules/.bin/electron scripts/probe-kv-cache.cjs
 *      configs: f16 | q8 | q8k-q4v
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

app.setName('Latent Write');

const ROOT = path.join(__dirname, '..');
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));
const TIER = process.env.TIER || 'small';
const CONFIGS = {
  f16:        { label: 'f16, no flash',   kvCacheType: null, flashAttention: undefined },
  fa:         { label: 'flash only, f16 KV', kvCacheType: null, flashAttention: true },
  q8:         { label: 'Q8_0 + flash',    kvCacheType: 'Q8_0', flashAttention: true },
  'q8k-q4v':  { label: 'Q8_0 K / Q4_0 V', kvCacheType: { k: 'Q8_0', v: 'Q4_0' }, flashAttention: true },
};
const CONFIG = CONFIGS[process.env.CONFIG || 'f16'] || CONFIGS.f16;

// Two short, deterministic asks whose answers must not move.
const CASES = [
  {
    tag: 'entity-review',
    system: 'You classify how a NAME is used in a novel manuscript. Answer as JSON: {"reason","type","confidence"}.\nreason: one clause of at most 15 words naming what the evidence shows.\ntype: one of character, place, faction, object, common-word.\nconfidence: a number from 0 to 1.',
    user: 'NAME: Corin Ashe\n\nSNIPPETS\n1. They took the road to Corin Ashe before the fog closed in.\n2. The streets of Corin Ashe were empty at that hour.\n3. Nothing moved in Corin Ashe, and nothing had for a week.\n\nThe question: how is "Corin Ashe" used here?',
    schema: { type: 'object', properties: { reason: { type: 'string', maxLength: 120 }, type: { enum: ['character', 'place', 'faction', 'object', 'common-word'] }, confidence: { type: 'number' } } },
  },
  {
    tag: 'longer-context',
    system: 'You summarise a paragraph of a novel in one clause. Answer as JSON: {"summary"}.',
    user: `PARAGRAPH\n${'She walked the length of the quarter twice before the bell went, counting the shuttered stalls and finding the number the same as yesterday. '.repeat(24)}\n\nSummarise it.`,
    schema: { type: 'object', properties: { summary: { type: 'string', maxLength: 160 } } },
  },
];

let win = null;
const callBridge = (method, arg) => {
  const payload = JSON.stringify(arg === undefined ? null : arg);
  return win.webContents.executeJavaScript(
    `window.electronAPI.${method}(${payload === 'null' ? '' : payload})`, true,
  );
};

const rssMb = (pid) => {
  if (!pid) return null;
  try {
    const out = execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return Math.round(Number(out) / 1024);
  } catch { return null; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measure(label, override) {
  // The registry is the only switch the loader reads, and it is exported for
  // exactly this: the probe drives the shipped path, not a copy of it.
  const entry = assistant.MODEL_REGISTRY[TIER];
  entry.kvCacheType = override.kvCacheType;
  entry.flashAttention = override.flashAttention;
  await assistant.unload();
  await sleep(1200);

  const t0 = Date.now();
  const first = await callBridge('assistantRun', {
    requestId: `kv-${label}-warm`, task: 'probe', tier: TIER,
    systemPrompt: CASES[0].system, userText: CASES[0].user,
    schema: CASES[0].schema, maxTokens: 128, timeoutMs: 120000,
  });
  const loadMs = Date.now() - t0;
  if (!first || !first.ok) { console.log(`  ${label}: NO ANSWER (${first && first.error})`); return null; }

  await sleep(400);
  const preStatus = await callBridge('assistantStatus', { tier: TIER });
  const rss = rssMb(preStatus.host && preStatus.host.pid);

  const answers = [];
  let genMs = 0;
  for (const c of CASES) {
    const t = Date.now();
    const res = await callBridge('assistantRun', {
      requestId: `kv-${label}-${c.tag}`, task: 'probe', tier: TIER,
      systemPrompt: c.system, userText: c.user,
      schema: c.schema, maxTokens: 160, timeoutMs: 120000,
    });
    genMs += Date.now() - t;
    answers.push(res && res.ok ? JSON.stringify(res.json) : `ERR:${res && res.error}`);
  }

  const status = await callBridge('assistantStatus', { tier: TIER });
  const applied = status.host && status.host.loaded;
  console.log(
    `  ${label.padEnd(18)} rss ${String(rss).padStart(5)} MB  ctx ${applied && applied.contextSize}  load+first ${String(loadMs).padStart(5)}ms  `
    + `2 asks ${String(genMs).padStart(5)}ms  kv=${(applied && applied.kvCacheTypeApplied) || 'f16'} fa=${applied && applied.flashAttention}`,
  );
  return { rss, loadMs, genMs, answers };
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

  const status = await callBridge('assistantStatus', { tier: TIER });
  if (!status.model.present) { console.log(`SKIP — ${TIER} model not on disk.`); win.destroy(); app.quit(); return; }
  console.log(`\n${'═'.repeat(78)}\nTIER ${TIER} — ${status.model.id}\n${'═'.repeat(78)}\n`);

  const r = await measure(CONFIG.label, CONFIG);
  if (r) {
    console.log(`\nRESULT\t${TIER}\t${process.env.CONFIG || 'f16'}\t${r.rss}\t${r.genMs}\t${JSON.stringify(r.answers)}`);
  }
  console.log('');
  win.destroy();
  app.quit();
}

app.whenReady().then(main).catch((err) => { console.error(err); app.exit(1); });
