/**
 * assistant-sidecar.cjs — the llama-server batch engine (main process).
 *
 * Supervises a native `llama-server` child and runs BATCH inference over
 * HTTP with true continuous batching across parallel slots — the throughput
 * node-llama-cpp could not deliver (measured: probe-llama-server.ts, 1.75x
 * on 4 concurrent chip calls, schema 4/4).
 *
 * ★ SCOPE (v1): background batch work only — chips + chapter summaries on
 *   the max tier. Interactive paths (max-ask, writing tool) and every
 *   custom model stay on the in-process host: llama-server slots are fixed
 *   at contextTotal/slots tokens each, sized here for batch prompts, and
 *   the golden-tested interactive behaviour is not re-judged in v1.
 *
 * ★ THE CALLER'S ERROR VOCABULARY IS A CONTRACT. The chip tick classifies
 *   failures into content-shaped ({parse, no-json, schema} → permanent
 *   skip) vs transient (bounded retry). Everything this module returns maps
 *   into that vocabulary; a new failure word would silently change retry
 *   semantics.
 *
 * ★ TEMPLATE, NOT CHAT ENDPOINT. The OpenAI-compat endpoint applies the
 *   model's own template, which auto-opens <think> on Qwen3-Thinking and
 *   burns the whole budget reasoning (measured: 0/4 schema held). The
 *   native /completion endpoint gets a hand-built ChatML prompt with a
 *   CLOSED think block; only model families named in the registry template
 *   table route here at all.
 */
'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const BOOT_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 250;
const RUN_TEXT_THROTTLE_MS = 120;

// ── state ───────────────────────────────────────────────────────────────────
let _child = null;          // spawn() handle
let _port = 0;
let _alive = false;
let _booting = null;        // Promise while starting
let _loadedKey = null;      // `${modelPath}|${slots}|${slotContext}` when up
let _config = null;         // { modelPath, slots, slotContext, tier }
let _fatal = null;
const _inflight = new Map(); // requestId → { controller }
let _idleTimer = null;
let _idleTtlMs = 5 * 60 * 1000;
let _emit = null;           // (channel, payload) => void — progress fan-out

// ★ THE CHILD DIES WITH THIS PROCESS, NO MATTER HOW IT EXITS. Electron's
//   before-quit hooks do not fire on app.exit()/crashes, and an orphaned
//   llama-server holds ~3.5GB — found the hard way when a crashed probe left
//   one resident and every later run hit the memory guard. process 'exit' is
//   the one hook that always runs on a normal teardown; SIGINT/SIGTERM cover
//   the terminal paths.
process.on('exit', () => { try { if (_child) _child.kill(); } catch { /* gone */ } });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { if (_child) _child.kill(); } catch { /* gone */ } process.exit(0); });
}

// ── binary discovery ────────────────────────────────────────────────────────

let _binaryPath; // undefined = not probed, null = unavailable
function binaryPath() {
  if (_binaryPath !== undefined) return _binaryPath;
  const candidates = [
    process.env.ASSISTANT_LLAMA_SERVER,
    '/opt/homebrew/bin/llama-server',
    '/usr/local/bin/llama-server',
  ].filter(Boolean);
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); _binaryPath = p; return p; } catch { /* next */ }
  }
  try {
    const found = execFileSync('/usr/bin/which', ['llama-server'], { encoding: 'utf8' }).trim();
    if (found) { _binaryPath = found; return found; }
  } catch { /* not on PATH */ }
  _binaryPath = null;
  return null;
}

function available() {
  return binaryPath() !== null;
}

// ── chat templates ──────────────────────────────────────────────────────────
//
// ★ THE CLOSED THINK BLOCK IS THE WHOLE TRICK. Qwen3-Thinking's template
//   opens <think> on every assistant turn; prefilling an EMPTY, closed block
//   skips reasoning so the schema-constrained JSON starts at token one —
//   matching the in-process host, where the grammar suppressed thinking
//   from token zero.
const TEMPLATES = {
  qwen3: (systemPrompt, userText) =>
    `<|im_start|>system\n${systemPrompt}\n/no_think<|im_end|>\n` +
    `<|im_start|>user\n${userText}<|im_end|>\n` +
    `<|im_start|>assistant\n<think>\n\n</think>\n\n`,
};

function hasTemplate(name) {
  return typeof TEMPLATES[name] === 'function';
}

// ── lifecycle ───────────────────────────────────────────────────────────────

function clearIdleTimer() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
}

function armIdleTimer() {
  clearIdleTimer();
  _idleTimer = setTimeout(() => {
    if (_inflight.size === 0) stop('idle-ttl');
  }, _idleTtlMs);
  if (_idleTimer.unref) _idleTimer.unref();
}

function stop(reason = 'stop') {
  clearIdleTimer();
  const child = _child;
  _child = null;
  _alive = false;
  _booting = null;
  _loadedKey = null;
  for (const [, entry] of _inflight) {
    try { entry.controller.abort(new Error(`sidecar-stopped:${reason}`)); } catch { /* noop */ }
  }
  _inflight.clear();
  if (child) { try { child.kill(); } catch { /* noop */ } }
}

function httpGetOk(path) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: _port, path, timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Start (or reuse) the server for this config. Loading a DIFFERENT config
 * stops the old child first — one sidecar, one model, like the host.
 */
async function ensureStarted({ modelPath, slots, slotContext, tier, idleTtlMs }) {
  const key = `${modelPath}|${slots}|${slotContext}`;
  if (_alive && _loadedKey === key) return { ok: true, reused: true, port: _port };
  if (_booting) { await _booting.catch(() => {}); if (_alive && _loadedKey === key) return { ok: true, reused: true, port: _port }; }

  const bin = binaryPath();
  if (!bin) return { ok: false, error: 'sidecar-unavailable' };
  if (!fs.existsSync(modelPath)) return { ok: false, error: 'no-model' };

  stop('reconfigure');
  _fatal = null;
  _config = { modelPath, slots, slotContext, tier };
  _idleTtlMs = Number(idleTtlMs) > 0 ? Number(idleTtlMs) : _idleTtlMs;
  _port = 49500 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);

  const args = [
    '-m', modelPath,
    '-c', String(slots * slotContext),
    '-np', String(slots),
    '-fa', 'on',
    '--host', '127.0.0.1',
    '--port', String(_port),
    '--no-webui',
  ];
  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  _child = child;
  let stderrTail = '';
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
  child.on('exit', (code) => {
    if (_child === child) {
      _fatal = `sidecar-exited:${code}`;
      stop(`exit:${code}`);
    }
  });

  _booting = (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < BOOT_TIMEOUT_MS) {
      if (_child !== child) throw new Error(_fatal || 'sidecar-exited');
      if (await httpGetOk('/health')) { _alive = true; _loadedKey = key; return; }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
    throw new Error(`sidecar boot timeout${stderrTail ? ` · ${stderrTail.slice(-200)}` : ''}`);
  })();

  try {
    await _booting;
  } catch (err) {
    stop('boot-failed');
    _fatal = String((err && err.message) || err);
    return { ok: false, error: _fatal };
  } finally {
    _booting = null;
  }
  armIdleTimer();
  return { ok: true, port: _port, bootMs: 0 };
}

// ── run ─────────────────────────────────────────────────────────────────────

/**
 * One schema-constrained completion over a slot. Mirrors the host's result
 * shape byte-for-byte: { ok, cancelled?, json?, raw?, error?, stopReason?,
 * timings, task, requestId }.
 */
async function run(opts, entry) {
  const requestId = opts.requestId || crypto.randomUUID();
  const task = opts.task || null;
  if (!_alive) return { ok: false, error: 'not-loaded', requestId, timings: emptyTimings() };
  if (_inflight.size >= (_config ? _config.slots : 1)) {
    return { ok: false, error: 'busy', requestId, timings: emptyTimings() };
  }
  const template = TEMPLATES[entry && entry.template];
  if (!template) return { ok: false, error: 'no-template', requestId, timings: emptyTimings() };
  if (!opts.schema || typeof opts.schema !== 'object') {
    return { ok: false, error: 'schema-required', requestId, timings: emptyTimings() };
  }

  clearIdleTimer();
  const controller = new AbortController();
  _inflight.set(requestId, { controller });
  const timeoutMs = Number(opts.timeoutMs) || 120_000;
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  const prompt = template(String(opts.systemPrompt || ''), String(opts.userText || ''));
  const t0 = Date.now();
  let firstTokenAt = 0;
  let text = '';
  let lastEmit = 0;
  let serverTimings = null;
  let stopReason = null;

  // Streaming exists for run-text (chip provisional picks); measured A/B via
  // ASSISTANT_SIDECAR_NO_STREAM while diagnosing concurrent throughput.
  const wantStream = !process.env.ASSISTANT_SIDECAR_NO_STREAM;
  try {
    const res = await fetch(`http://127.0.0.1:${_port}/completion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        prompt,
        json_schema: opts.schema,
        temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0,
        n_predict: Number.isFinite(opts.maxTokens) ? opts.maxTokens : 128,
        cache_prompt: true,
        stream: wantStream,
      }),
    });
    if (!res.ok || !res.body) {
      return finish({ ok: false, error: `sidecar-http:${res.status}`, requestId, task, timings: timings() });
    }

    if (!wantStream) {
      const payload = await res.json();
      firstTokenAt = firstTokenAt || Date.now();
      text = typeof payload.content === 'string' ? payload.content : '';
      stopReason = payload.stopped_limit ? 'maxTokens' : 'stop';
      if (payload.timings) serverTimings = payload.timings;
    } else {
    // SSE: `data: {json}\n\n` chunks; final chunk carries stop + timings.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let payload;
        try { payload = JSON.parse(line.slice(6)); } catch { continue; }
        if (typeof payload.content === 'string' && payload.content !== '') {
          if (!firstTokenAt) firstTokenAt = Date.now();
          text += payload.content;
          const now = Date.now();
          if (_emit && now - lastEmit > RUN_TEXT_THROTTLE_MS) {
            lastEmit = now;
            _emit('assistant:progress', { phase: 'run-text', requestId, task, text });
          }
        }
        if (payload.stop) {
          stopReason = payload.stopped_limit ? 'maxTokens' : 'stop';
          if (payload.timings) serverTimings = payload.timings;
        }
      }
    }
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      return finish({
        ok: false, error: 'parse', raw: text, stopReason,
        detail: String((err && err.message) || err), requestId, task, timings: timings(),
      });
    }
    return finish({ ok: true, json, raw: text, stopReason, requestId, task, timings: timings() });
  } catch (err) {
    const aborted = controller.signal.aborted;
    const reasonMsg = String((controller.signal.reason && controller.signal.reason.message) || (err && err.message) || err);
    if (aborted && reasonMsg === 'timeout') {
      return finish({ ok: false, error: 'timeout', requestId, task, timings: timings() });
    }
    if (aborted) {
      return finish({ ok: false, cancelled: true, error: 'cancelled', requestId, task, timings: timings() });
    }
    return finish({ ok: false, error: `sidecar-run:${reasonMsg}`, requestId, task, timings: timings() });
  }

  function timings() {
    const done = Date.now();
    const prefillMs = (firstTokenAt || done) - t0;
    const genMs = firstTokenAt ? done - firstTokenAt : 0;
    const tokens = serverTimings && Number.isFinite(serverTimings.predicted_n) ? serverTimings.predicted_n : 0;
    return {
      prefillMs, genMs, totalMs: done - t0, tokens,
      tokensPerSec: genMs > 0 && tokens ? +(tokens / (genMs / 1000)).toFixed(2) : 0,
    };
  }
  function finish(result) {
    clearTimeout(timer);
    _inflight.delete(requestId);
    if (_inflight.size === 0) armIdleTimer();
    return result;
  }
}

function cancel(requestId) {
  const entry = _inflight.get(requestId);
  if (!entry) return { ok: false, error: 'not-inflight' };
  try { entry.controller.abort(new Error('cancelled')); } catch { /* noop */ }
  return { ok: true, requestId };
}

function emptyTimings() {
  return { prefillMs: 0, genMs: 0, totalMs: 0, tokens: 0, tokensPerSec: 0 };
}

function status() {
  return {
    available: available(),
    alive: _alive,
    modelPath: _alive && _config ? _config.modelPath : null,
    port: _alive ? _port : null,
    slots: _config ? _config.slots : null,
    slotContext: _config ? _config.slotContext : null,
    inflight: _inflight.size,
    error: _fatal || undefined,
  };
}

/** The main process hands us its renderer fan-out once at registration. */
function setEmitter(fn) { _emit = typeof fn === 'function' ? fn : null; }

module.exports = {
  available, ensureStarted, run, cancel, stop, status, setEmitter,
  binaryPath,
};
