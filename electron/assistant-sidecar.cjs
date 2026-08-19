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
 *   custom model stay on the in-process host: the context pool is sized
 *   here for batch prompts (-kvu shares it across slots, so one prompt may
 *   exceed contextTotal/slots when neighbours are idle), and the
 *   golden-tested interactive behaviour is not re-judged in v1.
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
const HEALTH_POLL_MS = 100; // 250 → 100: worth ~150ms of cold TTFT, free
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

// ── binary discovery + provisioning ─────────────────────────────────────────
//
// ★ SELF-CONTAINED AFTER BUILD (owner requirement). The engine follows the
//   MODEL pattern: a pinned, sha256-verified download into userData on first
//   need — the app already fetches 1–2.5GB of weights on demand, and the
//   11MB engine rides the same philosophy. The official release tarball is
//   verified standalone: llama-server + @rpath dylibs in one folder, no
//   Homebrew anywhere. Discovery also honours a bundled copy under
//   process.resourcesPath so a distribution build may pre-bundle the same
//   folder with zero code change.
const ENGINE = {
  tag: 'b10298',
  file: 'llama-b10298-bin-macos-arm64.tar.gz',
  url: 'https://github.com/ggml-org/llama.cpp/releases/download/b10298/llama-b10298-bin-macos-arm64.tar.gz',
  sha256: '45397a751a6931a65d600fadbeaddd103edef77d0b2e8465933fc6497aeb70ef',
  dir: 'llama-b10298',
  supported: process.platform === 'darwin' && process.arch === 'arm64',
};

function engineRoot() {
  const { app } = require('electron');
  return require('path').join(app.getPath('userData'), 'engine');
}

let _binaryPath; // undefined = not probed, null = unavailable
function binaryPath() {
  if (_binaryPath !== undefined) return _binaryPath;
  const path = require('path');
  const candidates = [
    process.env.ASSISTANT_LLAMA_SERVER,
    // Provisioned (downloaded on demand, pinned + verified).
    (() => { try { return path.join(engineRoot(), ENGINE.dir, 'llama-server'); } catch { return null; } })(),
    // Bundled with a packaged build (electron-builder extraResources).
    process.resourcesPath ? path.join(process.resourcesPath, 'llama-server', 'llama-server') : null,
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

let _provisioning = null; // Promise while a download runs; resolves ok:boolean
/**
 * Download + verify + extract the pinned engine. Idempotent and background-
 * safe: callers fire it and keep falling back in-process until it lands;
 * the next tick simply finds the binary. Any failure leaves the machine
 * exactly where it was (in-process only) — provisioning is never fatal.
 */
function ensureBinary() {
  if (available()) return Promise.resolve(true);
  if (!ENGINE.supported) return Promise.resolve(false);
  if (_provisioning) return _provisioning;
  const path = require('path');
  _provisioning = (async () => {
    const root = engineRoot();
    const tarPath = path.join(root, `${ENGINE.file}.part`);
    fs.mkdirSync(root, { recursive: true });
    // Download (follow redirects — GitHub releases always redirect to a CDN).
    await new Promise((resolve, reject) => {
      const https = require('https');
      const follow = (url, depth) => {
        if (depth > 5) return reject(new Error('too many redirects'));
        https.get(url, { headers: { 'user-agent': 'latent-write' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return follow(new URL(res.headers.location, url).toString(), depth + 1);
          }
          if (res.statusCode !== 200) { res.resume(); return reject(new Error(`http ${res.statusCode}`)); }
          const out = fs.createWriteStream(tarPath);
          res.pipe(out);
          out.on('finish', () => out.close(resolve));
          out.on('error', reject);
          res.on('error', reject);
        }).on('error', reject);
      };
      follow(ENGINE.url, 0);
    });
    // Verify BEFORE extracting — same discipline as the model download.
    const digest = await new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(tarPath).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
    if (digest !== ENGINE.sha256) {
      fs.unlinkSync(tarPath);
      throw new Error(`engine sha256 mismatch: ${digest}`);
    }
    execFileSync('/usr/bin/tar', ['xzf', tarPath, '-C', root], { timeout: 60_000 });
    fs.unlinkSync(tarPath);
    _binaryPath = undefined; // re-probe: the provisioned path now exists
    return available();
  })().catch(() => { _binaryPath = undefined; return false; })
    .finally(() => { _provisioning = null; });
  return _provisioning;
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

/**
 * ★ THE OPEN-THINK TEMPLATES: the assistant turn opens <think> and leaves it
 *   open, so the model reasons and the caller stops at </think> — the
 *   sidecar's serving of runThinkPass. This is the whole-flow rule from the
 *   ask/rewrite round: lane-batching a flow's constrained calls while its
 *   think pass stays on the in-process host forces a host reload per
 *   attempt and makes the flow SLOWER; a flow migrates whole or not at all.
 */
const THINK_TEMPLATES = {
  qwen3: (systemPrompt, userText) =>
    `<|im_start|>system\n${systemPrompt}<|im_end|>\n` +
    `<|im_start|>user\n${userText}<|im_end|>\n` +
    `<|im_start|>assistant\n<think>\n`,
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
    // ★ Q8_0 KV, same policy as the in-process host: 8192 tokens of f16 KV
    //   is ~1.1GB the machine pays TWICE when both engines are warm — this
    //   halves the sidecar's share. -ctv quantisation requires flash
    //   attention, which is on above.
    '-ctk', 'q8_0',
    '-ctv', 'q8_0',
    // ★ ONE SHARED KV POOL instead of hard per-slot walls. Without -kvu a
    //   prompt longer than contextTotal/slots is a flat 400 even when the
    //   other slots sit empty (measured: 2228 tokens → 400; with -kvu it
    //   just runs, 4-way concurrency intact). Capacity is unchanged, so the
    //   memory guard's math still holds; this only removes the artificial
    //   wall and the slot-halving reboot it used to force.
    '-kvu',
    // ★★ SMALL MICRO-BATCH IS THE UI-SMOOTHNESS LEVER, deliberately below
    //   the throughput optimum. Each ubatch is one Metal dispatch; at the
    //   default 512 a saturated sidecar drops ~12% of the app's 120Hz
    //   frames (fullscreen glass probe: p95 17ms, worst 75ms). At 128 the
    //   dispatches are short enough for the compositor to interleave: 95%
    //   of frames delivered, p95 12ms, zero frames >25ms — for 4% prefill
    //   and ~3% concurrent throughput (389 vs 405 tok/s; decode unchanged).
    //   Process-priority knobs were measured and REJECTED: --prio -1 moved
    //   nothing and taskpolicy -b starved GPU feeding (177ms stalls).
    '-ub', String(Number(process.env.ASSISTANT_SIDECAR_UB) || 128),
    ...(Number(process.env.ASSISTANT_SIDECAR_BATCH) ? ['-b', String(Number(process.env.ASSISTANT_SIDECAR_BATCH))] : []),
    // ★★ THE COPY STEP: 2.41x DECODE FOR NOTHING, AND THE ANSWER IS THE SAME.
    //
    //    Roughly 80% of a chip answer already exists in its own prompt. The
    //    picker is handed candidate sentences and told to choose and label
    //    them, so the labels and details it returns are quoted out of what it
    //    was shown, and the JSON scaffolding repeats once per pick. ngram-mod
    //    matches the tail just written against everything already in the
    //    context, copies forward whatever followed last time, and hands the
    //    whole span to the model as ONE forward pass instead of one pass per
    //    token. Measured on a real chip request: 72 tokens came out of 17
    //    model runs instead of 72, and 2108ms became 665ms.
    //
    // ★  THE OUTPUT CANNOT DRIFT, BY CONSTRUCTION. The model computes its own
    //    token at every drafted position and a copy survives only where the
    //    two agree; the first disagreement discards the rest. At temperature 0
    //    there is no randomness, so what the model would have said is a fixed
    //    answer. Verified rather than assumed: every answer byte-identical
    //    across every configuration in scripts/probe-spec-decode.ts, gated by
    //    npm run verify:spec-decode.
    //
    // ★★ 48 IS THE PLATEAU, AND THE FASTEST SETTING IS NOT THE ONE THAT SHIPS.
    //    Match-length sweep, paired against a fresh baseline each round
    //    (noise floor 2.5%): 12 gave +24%, 24 gave +48%, 32 gave +112%, 48
    //    gave +141%, 64 gave +141%. Two points agreeing to 0.1% is a real
    //    ceiling, so 48 it is. Separately --spec-ngram-mod-n-min 24 with
    //    --spec-ngram-mod-n-max 32 measured 70.7 tok/s against match32's
    //    70.0, a rounding error apart, AND REWROTE A CHAPTER SUMMARY into
    //    different events. The theory says that is impossible, so the
    //    guarantee leaks somewhere in that path. Do not chase the last
    //    percent through those two knobs.
    //
    //    Costs no memory: there is no draft model, only a lookup over context
    //    the engine already holds. It helps the saturated 4-slot case too
    //    (+33% wave), so it is not borrowing compute the batch needed.
    ...(process.env.ASSISTANT_SIDECAR_SPEC === 'none' ? [] : [
      '--spec-type', process.env.ASSISTANT_SIDECAR_SPEC || 'ngram-mod',
      '--spec-ngram-mod-n-match', String(Number(process.env.ASSISTANT_SIDECAR_SPEC_MATCH) || 48),
    ]),
    // ★★ THE HOST-RAM PROMPT CACHE DEFAULTS TO 8192 MiB, ON. b10298 keeps
    //   evicted slot KV states in host memory (PR #16391) and re-matches
    //   them by prefix — a real win for our byte-identical per-task system
    //   prompts when task types interleave across slots, but the DEFAULT is
    //   an 8GB tenant the memory guard knows nothing about. Cap it: 1GB
    //   holds ~7 slot states at this config, enough to keep every task
    //   type's prefix warm. --cache-idle-slots (default on) rides this.
    // ★ 512, HALVED FROM 1024 (memory round, 2026-08-13): the cap is a
    //   session-growth ceiling, not a boot cost — it fills as slot prefixes
    //   are evicted and re-cached. ~512MB still holds 3-4 full 2048-token
    //   Q8 slot states, which covers the task types that actually
    //   interleave; the trade is a re-prefill on a cold task switch, never
    //   an output change. Env override kept for probes.
    '--cache-ram', String(Number(process.env.ASSISTANT_SIDECAR_CACHE_RAM) || 512),
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
  // ★ A freeText run is a THINK pass: open-think template, no grammar, the
  //   caller's stop texts (runThinkPass sends ['</think>']). Everything
  //   else keeps the closed-think template and requires a schema.
  const freeText = opts.freeText === true;
  const template = freeText
    ? THINK_TEMPLATES[entry && entry.template]
    : TEMPLATES[entry && entry.template];
  if (!template) return { ok: false, error: 'no-template', requestId, timings: emptyTimings() };
  if (!freeText && (!opts.schema || typeof opts.schema !== 'object')) {
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
        // A precompiled compact grammar beats json_schema: the server's own
        // schema conversion allows pretty-printing and the model takes it
        // (measured 111 vs ~70 tokens on a chip answer).
        // ★★ AND A GRAMMAR NEEDS THE HOST'S OWN STOP TRIGGER. The generated
        //    no-new-lines grammars still permit trailing newlines AFTER the
        //    closing brace, and the server happily samples them to the
        //    n_predict cap — measured: a 36-token answer became 512 tokens,
        //    "}\n\n\n\n…" padded 13.5s. The in-process host guards exactly
        //    this with stopGenerationTriggers ['\n\n\n\n']; the sidecar now
        //    mirrors it. A compact no-newline JSON body can never contain
        //    the sequence, so the stop is unreachable inside a real answer.
        ...(freeText
          ? {
              stop: Array.isArray(opts.stopTexts) && opts.stopTexts.length
                ? opts.stopTexts.filter((s) => typeof s === 'string' && s !== '').slice(0, 4)
                : ['</think>'],
            }
          : typeof opts.gbnf === 'string' && opts.gbnf !== ''
            ? { grammar: opts.gbnf, stop: ['\n\n\n\n'] }
            : { json_schema: opts.schema }),
        temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0,
        ...(Number.isFinite(opts.minP) && opts.minP > 0 ? { min_p: opts.minP } : {}),
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

    if (freeText) {
      // The host's freeText contract: the raw text rides json.text, and the
      // caller (runThinkPass) strips the think markers itself. The template
      // already OPENED <think>, so the text is the reasoning body.
      return finish({ ok: true, json: { text }, raw: text, stopReason, requestId, task, timings: timings() });
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
  available, ensureBinary, ensureStarted, run, cancel, stop, status, setEmitter,
  binaryPath,
};
