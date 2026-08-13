/**
 * probe-ttft.cjs — cold time-to-first-token, decomposed per engine.
 *
 * TTFT here is the writer's own definition: everything from the trigger on
 * a cold app to the first generated token — process boot + binding/engine
 * load + model load + context + prompt prefill.
 *
 * Decomposition per call (no engine changes needed):
 *   boot+load  = wall clock − the engine's own run time (timings.totalMs)
 *   prefill    = timings.prefillMs  (ends at the first token)
 *   TTFT       = wall − genMs
 * Three calls per engine: COLD (everything paid), WARM-SAME (engine +
 * prefix cached), WARM-OTHER (engine warm, new task prefix) — the third
 * number is what boot-time prefix warming would remove.
 *
 *   CONFIG=host-small|host-max|sidecar ./node_modules/.bin/electron scripts/probe-ttft.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

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

// Two distinct task-shaped prompts (different system prompts = different
// prefix-cache entries), each ~450 tokens of system to make prefill visible.
const FILLER = Array.from({ length: 26 }, (_, i) =>
  `Rule ${i + 1}: when the field cannot be answered from the passage alone, prefer the empty string over a guess, and never invent a name, a place, a number, or a motive that the passage does not state.`,
).join(' ');
const TASK_A = {
  systemPrompt: `You extract one fact from a passage. ${FILLER}\nAnswer as JSON: {"fact"}.`,
  userText: 'PASSAGE: The ferry left at noon with eleven passengers and returned by four.\n\nWhat time did the ferry leave?',
  schema: { type: 'object', properties: { fact: { type: 'string', maxLength: 60 } } },
  maxTokens: 32,
};
const TASK_B = {
  systemPrompt: `You judge one passage for tone. ${FILLER}\nAnswer as JSON: {"tone"}.`,
  userText: 'PASSAGE: The ferry left at noon with eleven passengers and returned by four.\n\nName the tone in one word.',
  schema: { type: 'object', properties: { tone: { type: 'string', maxLength: 30 } } },
  maxTokens: 24,
};

async function timed(label, req, tier, extra) {
  const t0 = Date.now();
  const res = await callBridge('assistantRun', {
    requestId: `ttft-${label}`, task: `probe-ttft-${label}`, tier,
    systemPrompt: req.systemPrompt, userText: req.userText,
    schema: req.schema, maxTokens: req.maxTokens,
    timeoutMs: 180000, contextSize: tier === 'small' ? 4096 : 8192,
    ...(tier === 'max' ? { noThink: false } : {}),
    ...extra,
  });
  const wall = Date.now() - t0;
  const t = (res && res.timings) || {};
  const bootLoad = Math.max(0, wall - (t.totalMs || 0));
  const ttft = wall - (t.genMs || 0);
  console.log(`[${label}] wall ${wall}ms = boot+load ${bootLoad}ms + prefill ${t.prefillMs ?? '?'}ms + gen ${t.genMs ?? '?'}ms · TTFT ${ttft}ms · ok=${!!(res && res.ok)}`);
  return { wall, bootLoad, prefill: t.prefillMs, ttft };
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
  const tier = CONFIG === 'host-small' ? 'small' : 'max';
  const extra = CONFIG === 'sidecar' ? { lane: 'batch', jsonStyle: 'compact' } : {};
  console.log(`CONFIG=${CONFIG}`);

  await timed('cold', TASK_A, tier, extra);
  await timed('warm-same', TASK_A, tier, extra);
  await timed('warm-other', TASK_B, tier, extra);
  // ── discriminators for the new-prefix cost ──
  // same prefix again → pure cache confirmation
  await timed('other-again', TASK_B, tier, extra);
  // same system prompt (cached prefix), NEW user text → marginal prompt compute
  await timed('same-sys-new-user', {
    ...TASK_A,
    userText: 'PASSAGE: The mill closed on Sundays and the miller slept until the bells.\n\nWhat closed on Sundays?',
  }, tier, extra);
  // NEW ~500-token prefix with NO grammar (freeText) → prompt compute without
  // any constraint setup; separates grammar cost from prefill compute.
  const FREE_SYS = `You reflect on one passage in plain prose. ${FILLER}\nWrite two sentences, nothing else.`;
  await timed('new-prefix-nogrammar', {
    systemPrompt: FREE_SYS,
    userText: 'PASSAGE: The ferry left at noon with eleven passengers and returned by four.\n\nReflect briefly.',
    schema: { type: 'object', properties: { text: { type: 'string' } } },
    maxTokens: 48,
  }, tier, { ...extra, freeText: true, stopTexts: ['\n\n\n'] });
  app.exit(0);
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
