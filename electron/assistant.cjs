/**
 * assistant.cjs — the local-LLM assistant runtime (main process).
 *
 * A GENERIC inference service. Any feature in the app submits
 * `{ task, systemPrompt, userText, schema }` and gets back grammar-constrained
 * JSON. It knows nothing about novels, continuity, chapters or entities — the
 * caller owns all of that and ships it in the system prompt.
 *
 * Responsibilities:
 *   • model manager — registry, resumable download, sha256 verification
 *   • process manager — lazy `utilityProcess` fork, 5-minute idle TTL, kill on
 *     unload / app quit, crash recovery
 *   • memory guard — refuse to load when the machine cannot afford it
 *   • IPC surface for the renderer (below)
 *
 * ── IPC surface ───────────────────────────────────────────────────────────
 *   invoke `assistant:status`        → { state, model?, progress?, host? }
 *          state: 'no-model' | 'downloading' | 'ready' | 'loading' | 'busy'
 *                 | 'low-memory' | 'error'
 *   invoke `assistant:ensure-model`  { tier? }  → { ok, path?, bytes?, sha256?, error? }
 *          Downloads (resumable) and verifies; resolves when the file is usable.
 *   invoke `assistant:run`           { requestId, task, systemPrompt, userText,
 *                                      schema, maxTokens?, temperature?,
 *                                      noThink?, tier?, timeoutMs? }
 *                                   → { ok, json?, raw?, error?, cancelled?, timings }
 *          Lazily forks the host and loads the model. Does NOT download —
 *          a 1.1 GB fetch is never an implicit side effect of a run.
 *   invoke `assistant:cancel`        { requestId } → { ok }
 *   invoke `assistant:unload`        → { ok }   frees the model AND exits the host
 *   event  `assistant:progress`      { phase, tier, modelId, received, total,
 *                                      fraction, state }  (throttled to 500 ms)
 *
 * The same functions the IPC handlers call are exported for harnesses, so
 * `scripts/verify-assistant-runtime.cjs` drives the real code path.
 */
'use strict';

const { app, ipcMain, BrowserWindow, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ── model registry ──────────────────────────────────────────────────────────
// Pinned to a specific Hugging Face revision so a repo re-upload can never
// change the bytes under us. `sha256` is the LFS oid published by the HF API.
const MODEL_REGISTRY = {
  small: {
    id: 'qwen3-1.7b-q4_k_m',
    tier: 'small',
    label: 'Qwen3 1.7B (Q4_K_M)',
    license: 'Apache-2.0',
    repo: 'unsloth/Qwen3-1.7B-GGUF',
    revision: 'd7f544eead698dbd1f15126ef60b45a1e1933222',
    file: 'Qwen3-1.7B-Q4_K_M.gguf',
    bytes: 1107409472,
    sha256: 'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897',
    contextSize: 4096,   // Metal tier; pass 2048 for the CPU tier
    noThink: true,       // Qwen3 thinking-mode toggle applies
  },
};

const DEFAULT_TIER = 'small';
const DEFAULT_MEMORY_HEADROOM_MB = 512;
const IDLE_TTL_MS = 5 * 60 * 1000;
const PROGRESS_THROTTLE_MS = 500;
const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const HOST_BOOT_TIMEOUT_MS = 60_000;   // first import compiles/caches a binary test
const LOAD_TIMEOUT_MS = 120_000;

// ── module state ────────────────────────────────────────────────────────────
let _host = null;              // utilityProcess handle
let _hostReady = null;         // Promise<void> resolved on the host's 'ready'
let _hostAlive = false;
let _hostLoaded = null;        // { modelPath, contextSize, gpu, gpuLayers, loadMs }
let _hostLoading = false;
let _loadPromise = null;
let _inflight = null;          // { requestId, resolve, timer }
let _claiming = false;         // a run has claimed the slot but is still loading
let _download = null;          // { tier, promise, received, total }
let _lowMemory = null;         // { needBytes, availableBytes } while latched
let _fatal = null;             // string
let _idleTimer = null;
let _lastProgressAt = 0;
const _verifiedPaths = new Map(); // modelPath → `${size}:${mtimeMs}` known-good

// ── small helpers ───────────────────────────────────────────────────────────

function modelsDir() {
  return path.join(app.getPath('userData'), 'models');
}

/**
 * Headroom the machine must keep after the weights. Read per call (not frozen
 * at module load) so a harness can prove the guard actually fires:
 * `ASSISTANT_MEMORY_HEADROOM_MB=999999` must produce state 'low-memory'.
 */
function memoryHeadroomBytes() {
  const mbOverride = Number(process.env.ASSISTANT_MEMORY_HEADROOM_MB);
  const megabytes = Number.isFinite(mbOverride) && mbOverride > 0 ? mbOverride : DEFAULT_MEMORY_HEADROOM_MB;
  return megabytes * 1024 * 1024;
}

/** Mirror / offline-install override; also how the no-network SKIP path is tested. */
function modelBaseUrl() {
  return process.env.ASSISTANT_MODEL_BASE_URL || 'https://huggingface.co';
}

/**
 * A source the writer supplied themselves, replacing the registry's URL.
 *
 * ★★ THE ESCAPE HATCH FOR A DEAD SOURCE. The registry pins one repo at one
 *    revision, which is right until that repo moves, rate-limits, or is blocked
 *    on someone's network — and then a feature that works entirely offline is
 *    bricked by a URL. A direct link to the same GGUF (a mirror, a LAN host, a
 *    file:// path) is enough to recover, so it lives in settings rather than in
 *    a support email.
 *
 * ★ THE CHECKSUM IS NOT WAIVED BY DEFAULT. A custom URL still has to deliver a
 *   file matching the registry's sha256 unless the caller passes an explicit
 *   `expectSha`, so a typo'd host cannot quietly install something else.
 */
let _customSource = null;   // { url, expectSha? }

function setCustomSource(next) {
  _customSource = next && next.url ? { url: String(next.url), expectSha: next.expectSha || null } : null;
  return _customSource;
}

function resolvedModelUrl(entry) {
  if (_customSource) return _customSource.url;
  return `${modelBaseUrl()}/${entry.repo}/resolve/${entry.revision}/${entry.file}`;
}

function registryEntry(tier) {
  return MODEL_REGISTRY[tier || DEFAULT_TIER] || MODEL_REGISTRY[DEFAULT_TIER];
}

/**
 * Env override short-circuits everything (harnesses, CI, bake-offs).
 * When set, no download is ever attempted and no sha256 is required.
 */
function envModelPath() {
  const p = process.env.ASSISTANT_MODEL_PATH;
  return p && fs.existsSync(p) ? p : null;
}

function modelPathFor(tier) {
  return envModelPath() || path.join(modelsDir(), registryEntry(tier).file);
}

function modelFilePresent(tier) {
  const p = modelPathFor(tier);
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    // A file that exists but is short is a torn download, not a model.
    if (!envModelPath() && st.size !== registryEntry(tier).bytes) return false;
    return true;
  } catch { return false; }
}

/**
 * Bytes the machine can hand out without swapping.
 *
 * `os.freemem()` on macOS counts ONLY genuinely free pages — it reported 77 MB
 * on this 16 GB machine with 2.7 GB reclaimable, which would reject every load
 * forever. On darwin we read vm_stat and count free + inactive + speculative +
 * purgeable, which is what "Memory Available" actually means there.
 */
function availableMemoryBytes() {
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 2000 });
      const pageSize = Number((/page size of (\d+) bytes/.exec(out) || [])[1] || 4096);
      const pages = (label) => {
        const m = new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(out);
        return m ? Number(m[1]) : 0;
      };
      const total = pages('free') + pages('inactive') + pages('speculative') + pages('purgeable');
      if (total > 0) return total * pageSize;
    } catch { /* fall through */ }
  }
  return os.freemem();
}

function sendToRenderers(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function emitProgress(payload, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - _lastProgressAt < PROGRESS_THROTTLE_MS) return;
  _lastProgressAt = now;
  sendToRenderers('assistant:progress', payload);
}

// ── status ──────────────────────────────────────────────────────────────────

function currentState(tier) {
  if (_fatal) return 'error';
  if (_download) return 'downloading';
  if (_lowMemory) return 'low-memory';
  if (_inflight) return 'busy';
  if (_hostLoading || _claiming || _loadPromise) return 'loading';
  if (modelFilePresent(tier)) return 'ready';
  return 'no-model';
}

function assistantStatus({ tier } = {}) {
  const entry = registryEntry(tier);
  const p = modelPathFor(tier);
  return {
    state: currentState(tier),
    model: {
      id: entry.id,
      tier: entry.tier,
      label: entry.label,
      bytes: entry.bytes,
      path: p,
      present: modelFilePresent(tier),
      source: envModelPath() ? 'env' : 'userData',
    },
    progress: _download
      ? { received: _download.received, total: _download.total,
          fraction: _download.total ? _download.received / _download.total : 0 }
      : undefined,
    host: {
      alive: _hostAlive,
      pid: _host && _hostAlive ? _host.pid : null,
      loaded: _hostLoaded ? { ..._hostLoaded } : null,
    },
    lowMemory: _lowMemory || undefined,
    error: _fatal || undefined,
  };
}

// ── model download (resumable, verified) ────────────────────────────────────

function httpsGetFollowing(url, headers, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(httpsGetFollowing(next, headers, depth + 1));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('download timeout')));
  });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Ensure the tier's model file exists on disk, verified.
 * Resumes a partial `.part` with a Range request; renames on completion;
 * writes `<file>.sha256` beside it.
 */
async function ensureModel({ tier = DEFAULT_TIER } = {}) {
  const entry = registryEntry(tier);
  const envPath = envModelPath();
  if (envPath) {
    return { ok: true, path: envPath, bytes: fs.statSync(envPath).size, source: 'env' };
  }

  const dir = modelsDir();
  const dest = path.join(dir, entry.file);
  const sidecar = `${dest}.sha256`;

  if (modelFilePresent(tier)) {
    if (!fs.existsSync(sidecar)) {
      const digest = await sha256File(dest);
      fs.writeFileSync(sidecar, `${digest}  ${entry.file}\n`, 'utf8');
    }
    return { ok: true, path: dest, bytes: entry.bytes, source: 'cache' };
  }

  if (_download && _download.tier === tier) return _download.promise;

  const partPath = `${dest}.part`;
  fs.mkdirSync(dir, { recursive: true });

  const record = { tier, received: 0, total: entry.bytes, promise: null };
  _download = record;

  record.promise = (async () => {
    let existing = 0;
    try { existing = fs.statSync(partPath).size; } catch { /* none */ }
    if (existing > entry.bytes) { fs.rmSync(partPath, { force: true }); existing = 0; }
    record.received = existing;

    const url = resolvedModelUrl(entry);
    const headers = { 'user-agent': 'latent-write-assistant/1' };
    if (existing > 0) headers.Range = `bytes=${existing}-`;

    emitProgress({ phase: 'download', tier, modelId: entry.id, received: existing,
                   total: entry.bytes, fraction: existing / entry.bytes, state: 'downloading' },
                 { force: true });

    const res = await httpsGetFollowing(url, headers);
    const code = res.statusCode || 0;
    if (existing > 0 && code === 200) {
      // Server ignored the Range header — start over rather than corrupt.
      existing = 0;
      record.received = 0;
    } else if (code !== 200 && code !== 206) {
      res.resume();
      throw new Error(`download failed: HTTP ${code}`);
    }

    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(partPath, { flags: existing > 0 ? 'a' : 'w' });
      res.on('data', (chunk) => {
        record.received += chunk.length;
        emitProgress({ phase: 'download', tier, modelId: entry.id,
                       received: record.received, total: entry.bytes,
                       fraction: record.received / entry.bytes, state: 'downloading' });
      });
      res.on('error', reject);
      out.on('error', reject);
      res.pipe(out);
      out.on('finish', resolve);
    });

    const got = fs.statSync(partPath).size;
    if (got !== entry.bytes) throw new Error(`size mismatch: ${got} != ${entry.bytes}`);

    const digest = await sha256File(partPath);
    if (entry.sha256 && digest !== entry.sha256) {
      fs.rmSync(partPath, { force: true });
      throw new Error(`sha256 mismatch: ${digest}`);
    }

    fs.renameSync(partPath, dest);
    fs.writeFileSync(sidecar, `${digest}  ${entry.file}\n`, 'utf8');
    _verifiedPaths.set(dest, fileStamp(dest));

    emitProgress({ phase: 'download', tier, modelId: entry.id, received: entry.bytes,
                   total: entry.bytes, fraction: 1, state: 'ready' }, { force: true });

    return { ok: true, path: dest, bytes: entry.bytes, sha256: digest, source: 'download' };
  })()
    .catch((err) => {
      emitProgress({ phase: 'download', tier, modelId: entry.id,
                     received: record.received, total: entry.bytes,
                     fraction: record.received / entry.bytes, state: 'error',
                     error: String(err.message || err) }, { force: true });
      return { ok: false, error: String(err.message || err) };
    })
    .finally(() => { if (_download === record) _download = null; });

  return record.promise;
}

function fileStamp(p) {
  const st = fs.statSync(p);
  return `${st.size}:${Math.round(st.mtimeMs)}`;
}

/**
 * Verify the on-disk model against its `.sha256` sidecar. Runs at most once per
 * (path, size, mtime) per app session — hashing 1.1 GB costs ~1 s and belongs
 * on the load path, not the run path.
 */
/**
 * ★★ VERIFY ONCE PER FILE, NOT ONCE PER LAUNCH.
 *
 *    Hashing 1.1 GB costs ~2.4s and it was paid on the first load of EVERY app
 *    session — the writer's first continuity check of the day waited on it,
 *    behind nothing else. `_verifiedPaths` dies with the process, so a relaunch
 *    re-hashed a file that had not moved.
 *
 *    The stamp (size + mtime) is persisted beside the sha256 once the hash has
 *    passed. Same size and mtime means the same file: a torn download is caught
 *    by the hash at download time, and rot that preserved both fields would
 *    still fail GGUF parsing at load. What this deliberately does NOT defend
 *    against is a swap that forges both fields, which is not the threat a
 *    download checksum exists for.
 */
function verifiedStampPath(modelPath) {
  return `${modelPath}.verified`;
}

async function verifyModelFile(modelPath) {
  let stamp;
  try { stamp = fileStamp(modelPath); } catch { return { ok: false, error: 'missing' }; }
  if (_verifiedPaths.get(modelPath) === stamp) return { ok: true, cached: true, ms: 0 };

  try {
    if (fs.readFileSync(verifiedStampPath(modelPath), 'utf8').trim() === stamp) {
      _verifiedPaths.set(modelPath, stamp);
      return { ok: true, cached: 'persisted', ms: 0 };
    }
  } catch { /* no stamp yet, or unreadable — fall through and hash */ }

  const sidecar = `${modelPath}.sha256`;
  let expected = null;
  try { expected = fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0]; } catch { /* none */ }

  const t0 = Date.now();
  const digest = await sha256File(modelPath);
  const ms = Date.now() - t0;

  if (!expected) {
    fs.writeFileSync(sidecar, `${digest}  ${path.basename(modelPath)}\n`, 'utf8');
    _verifiedPaths.set(modelPath, stamp);
  try { fs.writeFileSync(verifiedStampPath(modelPath), stamp, "utf8"); } catch { /* best effort */ }
    return { ok: true, wrote: true, sha256: digest, ms };
  }
  if (digest !== expected) return { ok: false, error: 'sha256-mismatch', sha256: digest, expected, ms };
  _verifiedPaths.set(modelPath, stamp);
  try { fs.writeFileSync(verifiedStampPath(modelPath), stamp, "utf8"); } catch { /* best effort */ }
  return { ok: true, sha256: digest, ms };
}

/**
 * Remove the downloaded weights and every file derived from them.
 *
 * ★ THE HOST DIES FIRST. Deleting a file the utility process still has mmap'd
 *   leaves it resident until that process exits, so the writer would free 1.1GB
 *   of disk and none of the memory. Unload, then unlink.
 *
 * The sidecars go too: a .sha256 or .verified stamp outliving its model would
 * validate the NEXT download by accident.
 */
async function deleteModel({ tier = DEFAULT_TIER } = {}) {
  if (envModelPath()) return { ok: false, error: 'env-pinned' };
  killHost('delete-model');
  const modelPath = modelPathFor(tier);
  const targets = [modelPath, `${modelPath}.sha256`, `${modelPath}.verified`, `${modelPath}.part`];
  let freedBytes = 0;
  const removed = [];
  for (const target of targets) {
    try {
      const st = fs.statSync(target);
      fs.unlinkSync(target);
      freedBytes += st.size;
      removed.push(path.basename(target));
    } catch { /* absent is the desired end state */ }
  }
  _verifiedPaths.delete(modelPath);
  _fatal = null;
  _lowMemory = null;
  return { ok: true, freedBytes, removed };
}

// ── host process lifecycle ──────────────────────────────────────────────────

function killHost(reason = 'unload') {
  clearIdleTimer();
  const h = _host;
  _host = null;
  _hostReady = null;
  _hostAlive = false;
  _hostLoaded = null;
  _hostLoading = false;
  _loadPromise = null;
  if (_inflight) {
    const { resolve, timer } = _inflight;
    clearTimeout(timer);
    _inflight = null;
    resolve({ ok: false, error: `host-exited:${reason}`, timings: null });
  }
  if (h) { try { h.kill(); } catch { /* noop */ } }
}

function clearIdleTimer() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
}

function armIdleTimer() {
  clearIdleTimer();
  _idleTimer = setTimeout(() => {
    if (!_inflight) killHost('idle-ttl');
  }, IDLE_TTL_MS);
  if (_idleTimer.unref) _idleTimer.unref();
}

function onHostMessage(msg) {
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'loaded':
      _hostLoading = false;
      _hostLoaded = {
        modelPath: msg.modelPath, contextSize: msg.contextSize,
        gpu: msg.gpu, gpuLayers: msg.gpuLayers, loadMs: msg.loadMs,
        marks: { ...(msg.marks || {}), bootMs: _lastBootMs },
        kvCacheTypeRequested: msg.kvCacheTypeRequested,
        kvCacheTypeApplied: msg.kvCacheTypeApplied,
      };
      break;
    case 'unloaded':
      _hostLoaded = null;
      break;
    case 'result': {
      if (!_inflight || _inflight.requestId !== msg.id) return;
      const { resolve, timer } = _inflight;
      clearTimeout(timer);
      _inflight = null;
      armIdleTimer();
      resolve({
        ok: !!msg.ok, cancelled: !!msg.cancelled, json: msg.json, raw: msg.raw,
        error: msg.error, detail: msg.detail, stopReason: msg.stopReason,
        timings: msg.timings, task: msg.task,
      });
      break;
    }
    default:
      break;
  }
}

let _lastBootMs = null;
async function ensureHost() {
  if (_hostAlive && _host) return _host;
  const bootStart = Date.now();
  if (_hostReady) { await _hostReady; return _host; }

  const child = utilityProcess.fork(path.join(__dirname, 'assistant-host.cjs'), [], {
    serviceName: 'latent-write-assistant',
    stdio: 'inherit',
    // macOS hardened-runtime builds refuse unsigned dylibs in the utility
    // process; llama.cpp's Metal backend is one. Harmless in dev.
    allowLoadingUnsignedLibraries: true,
    // Deliberately NO `cwd`. In a packaged app `app.getAppPath()` is
    // `…/Resources/app.asar` — a FILE, not a directory — and chdir'ing into it
    // makes the fork fail silently (no 'spawn', no 'exit', no error: the host
    // just never appears). Verified against a real packed build. Module
    // resolution does not need it: assistant-host.cjs resolves
    // `node-llama-cpp` from its own location inside the asar.
  });
  _host = child;

  _hostReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('host boot timeout')), HOST_BOOT_TIMEOUT_MS);
    child.on('message', (msg) => {
      if (msg && msg.type === 'ready') {
        clearTimeout(timer);
        _hostAlive = true;
        resolve();
      }
      onHostMessage(msg);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (_host === child) killHost(`exit:${code}`);
    });
  });

  await _hostReady;
  _lastBootMs = Date.now() - bootStart;
  return child;
}

/** Fork (if needed), guard memory, then load the model in the host. */
async function ensureLoaded({ tier = DEFAULT_TIER, contextSize } = {}) {
  const entry = registryEntry(tier);
  const modelPath = modelPathFor(tier);
  const wantContext = Number(contextSize) || entry.contextSize;

  if (!fs.existsSync(modelPath)) return { ok: false, error: 'no-model' };

  if (_hostLoaded && _hostLoaded.modelPath === modelPath && _hostLoaded.contextSize >= wantContext) {
    return { ok: true, ..._hostLoaded, reused: true };
  }
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    const verified = await verifyModelFile(modelPath);
    if (!verified.ok) {
      _fatal = `model verification failed: ${verified.error}`;
      return { ok: false, error: _fatal };
    }

    const needBytes = fs.statSync(modelPath).size + memoryHeadroomBytes();
    const availableBytes = availableMemoryBytes();
    if (availableBytes < needBytes) {
      _lowMemory = { needBytes, availableBytes };
      return { ok: false, error: 'low-memory', needBytes, availableBytes };
    }
    _lowMemory = null;

    await ensureHost();
    _hostLoading = true;

    const loaded = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: 'load timeout' }), LOAD_TIMEOUT_MS);
      const onMsg = (msg) => {
        if (!msg) return;
        if (msg.type === 'loaded') {
          clearTimeout(timer);
          _host.removeListener('message', onMsg);
          resolve({ ok: true });
        } else if (msg.type === 'load-error') {
          clearTimeout(timer);
          _host.removeListener('message', onMsg);
          resolve({ ok: false, error: msg.error });
        }
      };
      _host.on('message', onMsg);
      _host.postMessage({
        type: 'load', modelPath, contextSize: wantContext,
        gpuLayers: process.env.ASSISTANT_GPU_LAYERS ? Number(process.env.ASSISTANT_GPU_LAYERS) : 'max',
        kvCacheType: entry.kvCacheType || null,
      });
    });

    _hostLoading = false;
    if (!loaded.ok) { _fatal = loaded.error; return loaded; }
    armIdleTimer();
    return { ok: true, ..._hostLoaded, verifyMs: verified.ms };
  })().finally(() => { _loadPromise = null; });

  return _loadPromise;
}

// ── run / cancel / unload ───────────────────────────────────────────────────

async function run(opts = {}) {
  const requestId = opts.requestId || crypto.randomUUID();
  // Queue depth 1. `_claiming` closes the window between this check and
  // `_inflight` being set, which spans an await on ensureLoaded().
  if (_inflight || _claiming) return { ok: false, error: 'busy', requestId };
  if (!opts.schema || typeof opts.schema !== 'object') {
    return { ok: false, error: 'schema-required', requestId };
  }

  _claiming = true;
  let loaded;
  try {
    const tier = opts.tier || DEFAULT_TIER;
    loaded = await ensureLoaded({ tier, contextSize: opts.contextSize });
  } finally {
    _claiming = false;
  }
  if (!loaded.ok) return { ok: false, error: loaded.error, requestId, detail: loaded };
  if (!_host || !_hostAlive) return { ok: false, error: 'no-host', requestId };

  clearIdleTimer();
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_RUN_TIMEOUT_MS;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (_inflight && _inflight.requestId === requestId) {
        _inflight = null;
        try { _host.postMessage({ type: 'cancel', id: requestId }); } catch { /* noop */ }
        armIdleTimer();
        resolve({ ok: false, error: 'timeout', requestId });
      }
    }, timeoutMs);

    _inflight = {
      requestId,
      timer,
      resolve: (r) => resolve({ ...r, requestId }),
    };

    try {
      _host.postMessage({
        type: 'run',
        id: requestId,
        task: opts.task || null,
        systemPrompt: String(opts.systemPrompt || ''),
        userText: String(opts.userText || ''),
        schema: opts.schema,
        maxTokens: Number.isFinite(opts.maxTokens) ? opts.maxTokens : 128,
        temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0,
        noThink: opts.noThink !== false,
      });
    } catch (err) {
      clearTimeout(timer);
      _inflight = null;
      resolve({ ok: false, error: `post-failed:${String(err && err.message || err)}`, requestId });
    }
  });
}

function cancel({ requestId } = {}) {
  if (!_host || !_hostAlive) return { ok: false, error: 'no-host' };
  if (!_inflight) return { ok: false, error: 'idle' };
  if (requestId && _inflight.requestId !== requestId) return { ok: false, error: 'not-inflight' };
  try { _host.postMessage({ type: 'cancel', id: _inflight.requestId }); } catch { /* noop */ }
  return { ok: true, requestId: _inflight.requestId };
}

async function unload() {
  const pid = _host && _hostAlive ? _host.pid : null;
  if (_host && _hostAlive) {
    try { _host.postMessage({ type: 'unload' }); } catch { /* noop */ }
  }
  killHost('unload');
  _lowMemory = null;
  _fatal = null;
  return { ok: true, pid };
}

// ── registration ────────────────────────────────────────────────────────────

let _registered = false;

function registerAssistant() {
  if (_registered) return;
  _registered = true;

  ipcMain.handle('assistant:status', (_e, opts) => assistantStatus(opts || {}));
  ipcMain.handle('assistant:ensure-model', (_e, opts) => ensureModel(opts || {}));
  ipcMain.handle('assistant:run', (_e, opts) => run(opts || {}));
  ipcMain.handle('assistant:cancel', (_e, opts) => cancel(opts || {}));
  ipcMain.handle('assistant:delete-model', async (_e, opts) => deleteModel(opts || {}));
  ipcMain.handle('assistant:set-source', async (_e, opts) => {
    const next = setCustomSource(opts || null);
    return { ok: true, source: next };
  });
  ipcMain.handle('assistant:unload', () => unload());

  app.on('before-quit', () => killHost('app-quit'));
  app.on('will-quit', () => killHost('app-quit'));
}

module.exports = {
  registerAssistant,
  deleteModel,
  setCustomSource,
  resolvedModelUrl,
  // Exported so harnesses drive the same code the IPC handlers call.
  assistantStatus,
  ensureModel,
  ensureLoaded,
  run,
  cancel,
  unload,
  modelsDir,
  modelPathFor,
  availableMemoryBytes,
  MODEL_REGISTRY,
  __hostPid: () => (_host && _hostAlive ? _host.pid : null),
};
