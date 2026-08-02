/**
 * assistant-host.cjs — the local-inference child process.
 *
 * Runs as an Electron `utilityProcess` forked by `electron/assistant.cjs`.
 * It is a GENERIC grammar-constrained JSON completion service: it knows about
 * models, grammars, tokens and timings, and nothing about novels, continuity,
 * chapters or any other app feature. Every request carries its own system
 * prompt and JSON schema.
 *
 * Why a child process:
 *   • llama.cpp weights are the single largest allocation in the app; when the
 *     host exits the OS reclaims all of it, with no reliance on the addon's
 *     own free paths.
 *   • A wedged or crashed inference never takes the writer's window with it.
 *
 * ── Message protocol ──────────────────────────────────────────────────────
 * All messages are plain JSON objects with a `type` field, exchanged over
 * `process.parentPort` (`postMessage` / `'message'`).
 *
 * PARENT → HOST
 *   { type: 'load', modelPath, contextSize?, gpuLayers?, kvCacheType? }
 *       Load exactly one model. `contextSize` defaults to 4096 (Metal tier);
 *       pass 2048 for the CPU tier. `gpuLayers` defaults to 'max' (the binding
 *       clamps to what the model has; 0 forces CPU-only).
 *       `kvCacheType` ('f16' | 'q8_0') is ACCEPTED AND RECORDED but node-llama-cpp
 *       3.19.x exposes no KV-cache quantisation knob — the reply reports
 *       `kvCacheTypeApplied: null` rather than silently pretending.
 *       Loading while a different model is resident unloads that one first.
 *       Loading the same {modelPath, contextSize} again is a no-op.
 *   { type: 'run', id, systemPrompt, userText, schema,
 *     maxTokens?, temperature?, noThink?, task? }
 *       One grammar-constrained completion. `schema` is a JSON Schema object
 *       compiled to a GBNF grammar (cached per schema shape).
 *       `noThink` defaults TRUE and appends '/no_think' to the system prompt —
 *       the Qwen3 thinking-mode toggle. Set false for model families that do
 *       not use it (Gemma, Granite, …).
 *       `temperature` defaults to 0, `maxTokens` to 128.
 *       `task` is an opaque label echoed back for the caller's own logging.
 *   { type: 'cancel', id }      Abort the in-flight run with that id.
 *   { type: 'unload' }          Free model + context, stay alive.
 *   { type: 'ping', t? }        Liveness probe.
 *
 * HOST → PARENT
 *   { type: 'ready', pid }                              once, on boot
 *   { type: 'loaded', modelPath, contextSize, gpuLayers, gpu,
 *     loadMs, kvCacheTypeRequested, kvCacheTypeApplied }
 *   { type: 'load-error', error }
 *   { type: 'result', id, task, ok, cancelled?, json?, raw?, error?,
 *     stopReason?, timings: { prefillMs, genMs, totalMs, tokens, tokensPerSec } }
 *       ok:true  → `json` is the grammar-parsed object, `raw` the exact text.
 *       ok:false → `error` is a short machine-readable reason
 *                  ('busy' | 'not-loaded' | 'cancelled' | 'schema' | 'parse'
 *                   | free-form message). `cancelled:true` marks a clean abort.
 *   { type: 'unloaded' }
 *   { type: 'status', state, modelPath, contextSize, busyId }
 *       Emitted on every state transition and in reply to 'ping'.
 *       state: 'booting' | 'idle' | 'loading' | 'ready' | 'busy' | 'error'
 *   { type: 'pong', t, state }
 *
 * Concurrency: queue depth ONE. A 'run' that arrives while another is in
 * flight is rejected immediately with error 'busy' — the caller owns the
 * queue, the host owns the refusal (defense in both layers).
 */
'use strict';

const HOST_VERSION = 1;

/** @type {any} */ let nlc = null;      // node-llama-cpp module namespace (ESM)
/** @type {any} */ let llama = null;    // the Llama binding
/** @type {any} */ let model = null;
/** @type {any} */ let context = null;
/** @type {any} */ let sequence = null;

/** @type {{modelPath:string, contextSize:number, gpuLayers:any, gpu:string, loadMs:number}|null} */
let loaded = null;
let state = 'booting';
let busyId = null;
/** @type {AbortController|null} */ let currentAbort = null;
/** @type {Promise<any>|null} */ let loadingPromise = null;

const grammarCache = new Map(); // schemaKey → grammar

function send(msg) {
  try { process.parentPort.postMessage(msg); } catch { /* parent gone */ }
}

function setState(next) {
  if (state === next) return;
  state = next;
  send(statusMessage());
}

function statusMessage() {
  return {
    type: 'status',
    state,
    hostVersion: HOST_VERSION,
    modelPath: loaded ? loaded.modelPath : null,
    contextSize: loaded ? loaded.contextSize : null,
    gpu: loaded ? loaded.gpu : null,
    busyId,
  };
}

// ── model lifecycle ─────────────────────────────────────────────────────────

async function ensureBinding() {
  if (llama) return llama;
  // node-llama-cpp v3 is ESM-only; this file is CommonJS by repo convention
  // (.cjs, because package.json is "type":"module"), so it must be imported
  // dynamically. `build:'never'` guarantees we never shell out to cmake on a
  // writer's machine — prebuilt binaries or nothing.
  nlc = await import('node-llama-cpp');
  llama = await nlc.getLlama({ build: 'never', logLevel: 'warn' });
  return llama;
}

async function handleLoad(msg) {
  const modelPath = String(msg.modelPath || '');
  const contextSize = Number(msg.contextSize) || 4096;
  const gpuLayers = msg.gpuLayers === undefined ? 'max' : msg.gpuLayers;
  const kvCacheTypeRequested = msg.kvCacheType || null;

  if (loaded && loaded.modelPath === modelPath && loaded.contextSize === contextSize) {
    send({ type: 'loaded', ...loaded, kvCacheTypeRequested, kvCacheTypeApplied: null, reused: true });
    return;
  }
  if (loadingPromise) { await loadingPromise.catch(() => {}); }
  if (loaded) await handleUnload({ silent: true });

  setState('loading');
  const t0 = Date.now();
  const marks = {};
  loadingPromise = (async () => {
    const m0 = Date.now();
    await ensureBinding();
    marks.bindingMs = Date.now() - m0;
    const m1 = Date.now();
    model = await llama.loadModel({ modelPath, gpuLayers, useMmap: true });
    marks.modelMs = Date.now() - m1;
    const m2 = Date.now();
    // ★ MEASURED AND REJECTED: batchSize. The default is 512 and our prompts run
    //   to ~1300 tokens, so a COLD prefill splits across passes. batchSize 2048
    //   cut the longest cold prefill (timeline-chips, 911-token system prompt)
    //   3027ms → 1196ms, but made the three SHORTER tasks worse (adjudication
    //   653 → 945ms), each figure a single noisy sample. It also enlarges the
    //   compute buffer, which is real memory on the 8 GB floor machine. The
    //   warm path — the one that actually dominates, since the scheduler works
    //   a burst of one task type at a time — is ~70ms either way. Not worth it.
    //   Re-measure with scripts/bench-assistant.cjs before revisiting.
    context = await model.createContext({ contextSize, sequences: 1 });
    sequence = context.getSequence();
    marks.contextMs = Date.now() - m2;
    loaded = {
      modelPath,
      contextSize: context.contextSize,
      gpuLayers: model.gpuLayers,
      gpu: llama.gpu,
      loadMs: Date.now() - t0,
      marks,
    };
  })();

  try {
    await loadingPromise;
    loadingPromise = null;
    setState('ready');
    send({
      type: 'loaded',
      ...loaded,
      kvCacheTypeRequested,
      // node-llama-cpp 3.19.x exposes no KV-cache type option. Reported honestly.
      kvCacheTypeApplied: null,
      reused: false,
    });
  } catch (err) {
    loadingPromise = null;
    await safeTeardown();
    setState('error');
    send({ type: 'load-error', error: String((err && err.message) || err) });
  }
}

async function safeTeardown() {
  try { if (sequence && !sequence.disposed) sequence.dispose(); } catch { /* noop */ }
  try { if (context && !context.disposed) await context.dispose(); } catch { /* noop */ }
  try { if (model && !model.disposed) await model.dispose(); } catch { /* noop */ }
  sequence = null; context = null; model = null; loaded = null;
  grammarCache.clear();
}

async function handleUnload({ silent = false } = {}) {
  if (currentAbort) { try { currentAbort.abort(new Error('unload')); } catch { /* noop */ } }
  await safeTeardown();
  busyId = null;
  currentAbort = null;
  if (!silent) {
    setState('idle');
    send({ type: 'unloaded' });
  }
}

// ── inference ───────────────────────────────────────────────────────────────

async function getGrammar(schema) {
  const key = JSON.stringify(schema);
  const hit = grammarCache.get(key);
  if (hit) return hit;
  const grammar = await llama.createGrammarForJsonSchema(schema);
  grammarCache.set(key, grammar);
  return grammar;
}

async function handleRun(msg) {
  const id = msg.id;
  const task = msg.task || null;

  if (busyId !== null) {
    send({ type: 'result', id, task, ok: false, error: 'busy', timings: emptyTimings() });
    return;
  }
  if (!loaded) {
    send({ type: 'result', id, task, ok: false, error: 'not-loaded', timings: emptyTimings() });
    return;
  }

  busyId = id;
  setState('busy');

  const abort = new AbortController();
  currentAbort = abort;

  const maxTokens = Number.isFinite(msg.maxTokens) ? msg.maxTokens : 128;
  const temperature = Number.isFinite(msg.temperature) ? msg.temperature : 0;
  const noThink = msg.noThink !== false;
  const systemPrompt = String(msg.systemPrompt || '') + (noThink ? '\n/no_think' : '');

  let session = null;
  let tokens = 0;
  let firstTokenAt = 0;
  const t0 = Date.now();

  try {
    let grammar;
    try {
      grammar = await getGrammar(msg.schema);
    } catch (err) {
      throw Object.assign(new Error(String((err && err.message) || err)), { kind: 'schema' });
    }

    // A fresh session per run: every request carries its own system prompt, so
    // requests must not inherit each other's chat history. The context SEQUENCE
    // is reused, and — the load-bearing part — its KV cache is NOT cleared.
    //
    // ★★ DO NOT ADD `await sequence.clearHistory()` HERE. It was here, and it
    //    cost 8x on prefill. Every request of a task type carries a
    //    BYTE-IDENTICAL system prompt (400–900 tokens), and LlamaChat already
    //    calls `sequence.compareContextTokens(tokens)` to find
    //    `firstDifferentIndex` and evaluate only from there. Clearing the
    //    history threw that cache away and re-read the system prompt every
    //    single time.
    //
    //    MEASURED, Qwen3-1.7B on Metal, 4 task types × 5 runs
    //    (scripts/bench-assistant.cjs):
    //      prefill  583ms → 70ms   (timeline-chips, 911 tokens: 1176ms → 69ms)
    //      total   1184ms → 673ms  · prefill fell from 51% of the work to 11%
    //      generation unchanged (554ms → 571ms, noise)
    //
    //    It is LOSSLESS because the reused tokens are the same tokens: same
    //    prefix, same weights, same KV, same logits, and nothing about
    //    sampling changed. The chip quality probe returned chip-for-chip
    //    identical output. A prompt that DIFFERS diverges at its first
    //    different token and the tail is evicted — the "cached prefix does not
    //    leak between different prompts" gate in verify-assistant-tasks.cjs
    //    runs A, then B, then A again, and fails if A's two answers differ.
    session = new nlc.LlamaChatSession({
      contextSequence: sequence,
      systemPrompt,
      autoDisposeSequence: false,
    });

    const meta = await session.promptWithMeta(String(msg.userText || ''), {
      grammar,
      signal: abort.signal,
      stopOnAbortSignal: true,
      maxTokens,
      temperature,
      onToken: (t) => {
        if (!firstTokenAt) firstTokenAt = Date.now();
        tokens += Array.isArray(t) ? t.length : 1;
      },
    });

    const done = Date.now();
    const prefillMs = (firstTokenAt || done) - t0;
    const genMs = firstTokenAt ? done - firstTokenAt : 0;
    const timings = {
      prefillMs,
      genMs,
      totalMs: done - t0,
      tokens,
      tokensPerSec: genMs > 0 ? +(tokens / (genMs / 1000)).toFixed(2) : 0,
    };

    if (meta.stopReason === 'abort' || abort.signal.aborted) {
      send({
        type: 'result', id, task, ok: false, cancelled: true, error: 'cancelled',
        raw: meta.responseText, stopReason: meta.stopReason, timings,
      });
      return;
    }

    let json;
    try {
      json = grammar.parse(meta.responseText);
    } catch (err) {
      send({
        type: 'result', id, task, ok: false, error: 'parse',
        raw: meta.responseText, stopReason: meta.stopReason,
        detail: String((err && err.message) || err), timings,
      });
      return;
    }

    send({
      type: 'result', id, task, ok: true, json,
      raw: meta.responseText, stopReason: meta.stopReason, timings,
    });
  } catch (err) {
    const done = Date.now();
    const prefillMs = (firstTokenAt || done) - t0;
    const genMs = firstTokenAt ? done - firstTokenAt : 0;
    const timings = {
      prefillMs, genMs, totalMs: done - t0, tokens,
      tokensPerSec: genMs > 0 ? +(tokens / (genMs / 1000)).toFixed(2) : 0,
    };
    // Aborting before the first token is generated rejects rather than
    // returning a partial response — both paths are a clean cancellation.
    if (abort.signal.aborted) {
      send({ type: 'result', id, task, ok: false, cancelled: true, error: 'cancelled', timings });
    } else {
      send({
        type: 'result', id, task, ok: false,
        error: err && err.kind === 'schema' ? 'schema' : String((err && err.message) || err),
        timings,
      });
    }
  } finally {
    try { if (session && !session.disposed) session.dispose({ disposeSequence: false }); } catch { /* noop */ }
    busyId = null;
    currentAbort = null;
    if (loaded) setState('ready'); else setState('idle');
  }
}

function emptyTimings() {
  return { prefillMs: 0, genMs: 0, totalMs: 0, tokens: 0, tokensPerSec: 0 };
}

// ── message pump ────────────────────────────────────────────────────────────

process.parentPort.on('message', (e) => {
  const msg = e && e.data;
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'load':
      handleLoad(msg).catch((err) => send({ type: 'load-error', error: String(err) }));
      break;
    case 'run':
      handleRun(msg).catch((err) => send({
        type: 'result', id: msg.id, ok: false,
        error: String((err && err.message) || err), timings: emptyTimings(),
      }));
      break;
    case 'cancel':
      if (busyId !== null && (msg.id === undefined || msg.id === busyId) && currentAbort) {
        try { currentAbort.abort(new Error('cancelled')); } catch { /* noop */ }
      }
      break;
    case 'unload':
      handleUnload().catch(() => {});
      break;
    case 'ping':
      send({ type: 'pong', t: msg.t, state });
      break;
    default:
      break;
  }
});

setState('idle');
send({ type: 'ready', pid: process.pid, hostVersion: HOST_VERSION });
