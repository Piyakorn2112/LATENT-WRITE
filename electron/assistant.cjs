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
const sidecar = require('./assistant-sidecar.cjs');

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
    minContextSize: 2048,
    noThink: true,       // Qwen3 thinking-mode toggle applies
    // ★★ MEASURED, NOT DERIVED. scripts/probe-mem-footprint loaded this model
    //    at 2048 / 4096 / 8192 / 16384 and read the helper's RSS: 1763 / 1940 /
    //    2484 / 3176 MB. That is 103 KB per token of context — over the useful
    //    range, MORE than the entire 1.06 GB weights file. Without it in the
    //    budget below, the guard thinks a long context is free.
    kvBytesPerToken: 103 * 1024,
  },
  /**
   * ★ THE "MAX" TIER — a real reasoning model, chosen against the 8 GB ceiling
   *   rather than for a leaderboard. Qwen3-4B-Thinking-2507 at Q4_K_M is 2.5 GB
   *   of weights and ~132 KB/token of KV (36 layers against the 1.7B's 28,
   *   scaled from the measurement above):
   *
   *        4k context  ~3.7 GB   fits 8 GB
   *        8k context  ~4.3 GB   fits 12 GB, marginal on 8
   *       16k context  ~5.5 GB   12 GB only
   *
   * ★★ AND NO MoE, DELIBERATELY. MoE saves COMPUTE, not memory — every expert
   *    stays resident, so Qwen3-30B-A3B is ~18.6 GB at Q4 despite activating
   *    3B a token. There is no MoE at a size that helps an 8 GB target; the
   *    smallest useful ones land where this dense 4B already sits, with worse
   *    tooling support.
   */
  max: {
    id: 'qwen3-4b-thinking-2507-q4_k_m',
    tier: 'max',
    label: 'Qwen3 4B Thinking (Q4_K_M)',
    license: 'Apache-2.0',
    repo: 'unsloth/Qwen3-4B-Thinking-2507-GGUF',
    revision: 'f40adb104d4d44aee52f398b60597c5866a973a3',
    file: 'Qwen3-4B-Thinking-2507-Q4_K_M.gguf',
    bytes: 2497281152,
    sha256: 'ddd52e18200baab281c5c46f70d544ce4d4fe4846eab1608f2fff48a64554212',
    contextSize: 8192,
    /** What it drops to when the machine cannot hold the preferred size. */
    minContextSize: 4096,
    /** A thinking model must be allowed to think — the toggle stays off. */
    noThink: false,
    /** Flash attention: stable in node-llama-cpp 3.19, faster and leaner. */
    flashAttention: true,
    /** Q8_0 on K and V HALVES the KV cache. Experimental in the binding —
     *  registry-only, verified on this hardware, and the host falls back to a
     *  plain context (reported, not silent) if the option refuses. */
    kvCacheType: 'Q8_0',
    /** Measured f16 was ~132 KB/token (layer-scaled from the 1.7B probe);
     *  Q8_0 halves it. Derived, and deliberately left a little conservative
     *  rather than re-measured to the byte. */
    kvBytesPerToken: 70 * 1024,
    /** 2.4 GB resident is the app's peak-RAM driver, and a warm reload is
     *  ~1.3s (measured — the OS page cache holds the weights). Idle for 90s
     *  and the memory goes back. */
    idleTtlMs: 90_000,
    /** Chat-template family for the SIDECAR path (hand-built prompt; the
     *  server's auto-template opens <think> and burns the budget). Only
     *  families named in assistant-sidecar.cjs's table route there. */
    template: 'qwen3',
    /**
     * ★ THE BATCH ENGINE (llama-server sidecar). 4 slots × 2048 tokens =
     *   the same 8192-token KV budget as the single in-process context,
     *   with TRUE continuous batching across the slots (measured 1.75x on
     *   4 concurrent chip calls — scripts/probe-llama-server.ts). Slot size
     *   fits every chip/summary prompt; interactive work (max-ask, writing
     *   tool) needs one big context and stays on the in-process host.
     */
    sidecar: { slots: 4, slotContext: 2048 },
  },
};

const DEFAULT_TIER = 'small';
// 512 → 384 (owner call, 2026-08-06): the guard was cutting too early. The
// darwin "available" figure already counts inactive+purgeable pages the OS
// reclaims on demand, and weights are mmapped (file-backed, evictable), so a
// thinner explicit margin still leaves real slack. Context sizes unchanged —
// only the refusal line moved.
const DEFAULT_MEMORY_HEADROOM_MB = 384;
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
let _degraded = null;          // { tier, wanted, using } when context was trimmed to fit
let _fatal = null;             // string
let _idleTimer = null;
let _idleTtlMs = IDLE_TTL_MS;   // per-tier: the loaded entry's own TTL
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
let _customModel = null;

/** Alternates worth offering as one click. Only the DEFAULT is hash-pinned. */
const MODEL_PRESETS = [
  {
    id: 'qwen3-1.7b-q4_k_m', label: 'Qwen3 1.7B  ·  recommended',
    note: '1.1 GB · fastest, the tuned default', builtin: true,
    contextSize: 4096, noThink: true,
  },
  {
    id: 'qwen3-4b-2507-q4_k_m', label: 'Qwen3 4B (2507)',
    note: '2.5 GB · better judgement, needs ~12 GB RAM',
    url: 'https://huggingface.co/bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    contextSize: 4096, noThink: true,
  },
  {
    id: 'granite-4.0-micro-q4_k_m', label: 'Granite 4.0 Micro',
    note: '2.1 GB · strong structured output',
    url: 'https://huggingface.co/unsloth/granite-4.0-micro-GGUF/resolve/main/granite-4.0-micro-Q4_K_M.gguf',
    contextSize: 4096, noThink: false,
  },
];

/** A filename that cannot collide with the pinned model or with another custom
 *  one: the URL's own basename when it looks like a GGUF, else a hash of it. */
function customFileName(url) {
  const base = (() => {
    try { return path.basename(new URL(url).pathname); } catch { return ''; }
  })();
  if (/^[\w.\-]+\.gguf$/i.test(base)) return base;
  return `custom-${crypto.createHash('sha1').update(url).digest('hex').slice(0, 12)}.gguf`;
}

/**
 * Point the runtime at a model the writer chose.
 *
 * ★★ A DIFFERENT MODEL IS NOT A DIFFERENT URL. It has its own size, its own
 *    hash, its own context window and its own chat template — so a custom entry
 *    carries all of them, gets its OWN filename (swapping models must not
 *    overwrite the pinned download), and is allowed to have `bytes` and
 *    `sha256` unknown: those come from the server and are checked against what
 *    it actually sent.
 *
 * ★ WHAT REPLACES THE PINNED HASH. The default is verified against a published
 *   sha256. A custom model has none, so it is validated by GGUF magic bytes
 *   plus the fact that llama.cpp can load it — which is the property that
 *   actually matters and which a hash only stands in for.
 */
function setCustomModel(next) {
  if (!next || !next.url) { _customModel = null; return null; }
  const url = String(next.url).trim();
  _customModel = {
    id: next.id || 'custom',
    label: next.label || 'Custom model',
    url,
    file: customFileName(url),
    bytes: Number(next.bytes) > 0 ? Number(next.bytes) : null,
    sha256: next.sha256 || null,
    contextSize: Number(next.contextSize) > 0 ? Number(next.contextSize) : 4096,
    noThink: next.noThink !== false,
  };
  return _customModel;
}

/** The model actually in play: the writer's, or the pinned default. */
function activeEntry(tier) {
  if (_customModel) {
    return { ...MODEL_REGISTRY[DEFAULT_TIER], ..._customModel, tier: 'custom', custom: true };
  }
  return MODEL_REGISTRY[tier || DEFAULT_TIER] || MODEL_REGISTRY[DEFAULT_TIER];
}

function resolvedModelUrl(entry) {
  if (entry && entry.custom) return entry.url;
  const e = entry || MODEL_REGISTRY[DEFAULT_TIER];
  return `${modelBaseUrl()}/${e.repo}/resolve/${e.revision}/${e.file}`;
}

/** Cheap structural check: the first four bytes of every GGUF say so. Catches
 *  an HTML error page or a redirect saved as a model, which is what a wrong
 *  URL actually produces. */
function isGgufFile(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf.toString('ascii') === 'GGUF';
  } catch { return false; }
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
  return envModelPath() || path.join(modelsDir(), activeEntry(tier).file);
}

function modelFilePresent(tier) {
  const p = modelPathFor(tier);
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    // A file that exists but is short is a torn download, not a model.
    const e = activeEntry(tier);
    // A pinned model must match its published size exactly. A custom one has no
    // published size, so "not empty and structurally a GGUF" is the bar.
    if (envModelPath()) return true;
    if (e.bytes && st.size !== e.bytes) return false;
    if (!e.bytes && (st.size < 1024 || !isGgufFile(p))) return false;
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
  const entry = activeEntry(tier);
  const p = modelPathFor(tier);
  return {
    state: currentState(tier),
    /** Set when the last load had to shorten its context to fit this machine.
     *  The UI shows it once, beside the control that made the choice. */
    degraded: _degraded && _degraded.tier === entry.tier ? _degraded : null,
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
    /** The batch engine, when the binary exists on this machine. */
    sidecar: sidecar.status(),
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
  const entry = activeEntry(tier);
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

  const record = { tier, received: 0, total: entry.bytes || 0, promise: null };
  _download = record;

  record.promise = (async () => {
    let existing = 0;
    try { existing = fs.statSync(partPath).size; } catch { /* none */ }
    if (entry.bytes && existing > entry.bytes) { fs.rmSync(partPath, { force: true }); existing = 0; }
    record.received = existing;

    const url = resolvedModelUrl(entry);
    const headers = { 'user-agent': 'latent-write-assistant/1' };
    if (existing > 0) headers.Range = `bytes=${existing}-`;

    emitProgress({ phase: 'download', tier, modelId: entry.id, received: existing,
                   total: record.total, fraction: record.total ? existing / record.total : 0,
                   state: 'downloading' },
                 { force: true });

    const res = await httpsGetFollowing(url, headers);
    // A model whose size we were not told: learn it from the response, so the
    // progress bar is honest instead of pretending to know the denominator.
    if (!record.total) {
      const len = Number(res.headers['content-length']);
      if (Number.isFinite(len) && len > 0) record.total = existing + len;
    }
    const code = res.statusCode || 0;
    if (existing > 0 && code === 200) {
      // Server ignored the Range header — start over rather than corrupt.
      existing = 0;
      record.received = 0;
    } else if (code !== 200 && code !== 206) {
      res.resume();
      throw new Error(`download failed: HTTP ${code}`);
    }

    // ★ HASH WHILE THE BYTES GO PAST. Hashing afterwards re-reads the whole
    //   file — 2.4s for 1.1 GB — for data that was already in hand. Only valid
    //   for a download that started at zero; a RESUMED one never saw the first
    //   half, so it falls back to a full read below.
    const streamHash = existing === 0 ? crypto.createHash('sha256') : null;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(partPath, { flags: existing > 0 ? 'a' : 'w' });
      res.on('data', (chunk) => {
        record.received += chunk.length;
        if (streamHash) streamHash.update(chunk);
        emitProgress({ phase: 'download', tier, modelId: entry.id,
                       received: record.received, total: record.total,
                       fraction: record.total ? record.received / record.total : 0,
                       state: 'downloading' });
      });
      res.on('error', reject);
      out.on('error', reject);
      res.pipe(out);
      out.on('finish', resolve);
    });

    const got = fs.statSync(partPath).size;
    if (entry.bytes && got !== entry.bytes) {
      throw new Error(`size mismatch: ${got} != ${entry.bytes}`);
    }
    if (record.total && got !== record.total) {
      throw new Error(`truncated: ${got} of ${record.total}`);
    }
    // ★ WHAT A WRONG URL ACTUALLY RETURNS is an HTML page, and it would sit in
    //   the models folder looking like a model until llama.cpp failed on it
    //   with something unreadable. Four bytes settle it here instead.
    if (!isGgufFile(partPath)) {
      fs.rmSync(partPath, { force: true });
      throw new Error('not a GGUF file — check the URL points at the model itself');
    }

    const digest = streamHash ? streamHash.digest('hex') : await sha256File(partPath);
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
  }, _idleTtlMs);
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
        // The parent copies fields EXPLICITLY, so a new host field is invisible
        // until named here — flash read as `undefined` for a whole bench round.
        flashAttention: msg.flashAttention,
      };
      break;
    case 'unloaded':
      _hostLoaded = null;
      break;
    case 'run-text': {
      // Partial completion text for the in-flight run, straight to the
      // renderer over the existing progress channel. Display-only: the
      // 'result' message remains the single authoritative answer.
      if (!_inflight || _inflight.requestId !== msg.id) return;
      sendToRenderers('assistant:progress', {
        phase: 'run-text', requestId: msg.id, task: msg.task || null,
        text: String(msg.text || ''),
      });
      return;
    }
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

/**
 * What a load of this model at this context actually costs.
 *
 * ★★ THE KV CACHE WAS MISSING FROM THIS BUDGET, and it is the bigger term over
 *    the useful range. Measured on Qwen3-1.7B: the weights are 1.06 GB, and
 *    going from 2k to 16k context added 1.41 GB — so the guard was approving
 *    loads that then had to swap. On an 8 GB machine, which is the target this
 *    tier exists for, that is the difference between "works" and "beachball".
 */
function loadCostBytes(entry, modelPath, wantContext) {
  const weights = fs.statSync(modelPath).size;
  const perToken = Number(entry.kvBytesPerToken) || 0;
  return weights + perToken * wantContext + memoryHeadroomBytes();
}

/**
 * The largest context this machine can actually hold, at or below the wanted
 * one, or null when even the floor does not fit.
 *
 * ★ DEGRADE, DO NOT REFUSE. A writer who picked "max" on a small machine gets
 *   max at a shorter context and a note saying so, rather than a greyed-out
 *   control and no feature. The note is the price of the degrade — a silently
 *   shortened context is a feature quietly getting worse for reasons nobody
 *   can see.
 */
function fittingContext(entry, modelPath, wantContext, available = availableMemoryBytes()) {
  const floor = Number(entry.minContextSize) || wantContext;
  for (let ctx = wantContext; ctx >= floor; ctx = Math.floor(ctx / 2)) {
    if (available >= loadCostBytes(entry, modelPath, ctx)) return ctx;
    if (ctx === floor) break;
  }
  return available >= loadCostBytes(entry, modelPath, floor) ? floor : null;
}

/**
 * ★★ THE RESIDENT COPY OF THE SAME MODEL IS RECLAIMABLE, NOT SPENT. Measured
 *    (probe-chip-max.cjs): with the 4B loaded at 4096, a request for its own
 *    tier default of 8192 was REFUSED as low-memory in 8ms — the guard read
 *    "available" with the model's own weights and KV counted as consumed, and
 *    asked whether a SECOND copy would fit. A reload frees the old copy first,
 *    so a same-model context change gets those bytes credited back. Cross-model
 *    swaps stay uncredited: the accounting there is murkier (two sets of
 *    weights transiently) and the conservative answer is the safe one.
 */
function residentCreditBytes(modelPath) {
  if (!_hostLoaded || _hostLoaded.modelPath !== modelPath) return 0;
  try {
    const owner = Object.values(MODEL_REGISTRY).find(
      (e) => modelPathFor(e.tier) === modelPath,
    );
    const perToken = owner ? Number(owner.kvBytesPerToken) || 0 : 0;
    return fs.statSync(modelPath).size + perToken * (_hostLoaded.contextSize || 0);
  } catch {
    return 0;
  }
}

/** Fork (if needed), guard memory, then load the model in the host. */
async function ensureLoaded({ tier = DEFAULT_TIER, contextSize } = {}) {
  const entry = activeEntry(tier);
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

    const availableBytes = availableMemoryBytes() + residentCreditBytes(modelPath);
    const fitContext = fittingContext(entry, modelPath, wantContext, availableBytes);

    // ★★ AN UPGRADE ATTEMPT MUST NEVER TEAR DOWN A WORKING LOAD. When the same
    //    model is already resident and what FITS is no bigger than what is
    //    loaded, reuse the loaded context and report the degrade — reloading
    //    here bought nothing and cost a full model load PER REQUEST the moment
    //    two surfaces asked for different context sizes.
    if (_hostLoaded && _hostLoaded.modelPath === modelPath &&
        (fitContext === null || fitContext <= _hostLoaded.contextSize)) {
      _degraded = _hostLoaded.contextSize < wantContext
        ? { tier: entry.tier, wanted: wantContext, using: _hostLoaded.contextSize, availableBytes }
        : null;
      _lowMemory = null;
      return { ok: true, ..._hostLoaded, reused: true, degraded: _degraded };
    }
    if (fitContext === null) {
      // ★ INTERACTIVE WORK PREEMPTS THE BATCH ENGINE. Since the sidecar
      //   shipped, BOTH engines can be warm at once and the in-process host
      //   started losing this guard far more often (owner report: frequent
      //   out-of-memory). The ask popover and writing tool must win: stop
      //   the sidecar, let the OS reclaim, and re-fit once. Batch work
      //   falls back in-process behind the single-flight queue and the
      //   sidecar restarts on a later tick.
      if (sidecar.status().alive) {
        sidecar.stop('yield-to-interactive');
        await new Promise((r) => setTimeout(r, 600));
        const retryAvailable = availableMemoryBytes() + residentCreditBytes(modelPath);
        const retryFit = fittingContext(entry, modelPath, wantContext, retryAvailable);
        if (retryFit !== null) {
          _degraded = retryFit < wantContext
            ? { tier: entry.tier, wanted: wantContext, using: retryFit, availableBytes: retryAvailable }
            : null;
          _lowMemory = null;
          return loadInHost(entry, modelPath, retryFit, verified);
        }
      }
      const needBytes = loadCostBytes(entry, modelPath, Number(entry.minContextSize) || wantContext);
      _lowMemory = { needBytes, availableBytes };
      return { ok: false, error: 'low-memory', needBytes, availableBytes };
    }
    // Reported so the UI can say WHAT was trimmed and why, once.
    _degraded = fitContext < wantContext
      ? { tier: entry.tier, wanted: wantContext, using: fitContext, availableBytes }
      : null;
    _lowMemory = null;
    return loadInHost(entry, modelPath, fitContext, verified);
  })().finally(() => { _loadPromise = null; });

  return _loadPromise;
}

/** The actual host load, shared by the normal path and the yield-retry. */
async function loadInHost(entry, modelPath, fitContext, verified) {
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
      type: 'load', modelPath, contextSize: fitContext,
      gpuLayers: process.env.ASSISTANT_GPU_LAYERS ? Number(process.env.ASSISTANT_GPU_LAYERS) : 'max',
      kvCacheType: entry.kvCacheType || null,
      flashAttention: entry.flashAttention === undefined ? null : entry.flashAttention,
    });
  });

  _hostLoading = false;
  if (!loaded.ok) { _fatal = loaded.error; return loaded; }
  // ★ AGGRESSIVE UNLOAD IS A PER-TIER POLICY. The 4B is 2.4 GB resident and
  //   a warm reload costs ~1.3s (measured: the OS page cache keeps the
  //   weights), so the max tier holds memory for 90s of idle, not five
  //   minutes. The small tier keeps the long TTL — it is 1 GB and serves
  //   background bursts where a reload per burst would thrash.
  _idleTtlMs = Number(entry.idleTtlMs) || IDLE_TTL_MS;
  armIdleTimer();
  return { ok: true, ..._hostLoaded, verifyMs: verified.ms, degraded: _degraded };
}

// ── run / cancel / unload ───────────────────────────────────────────────────

/**
 * ★ BATCH LANE → SIDECAR, WITH TRANSPARENT FALLBACK. Returns null when the
 *   sidecar is not applicable (binary absent, custom model, tier without a
 *   sidecar config, memory refusal, boot failure) — the caller falls through
 *   to the in-process path, so a machine without llama-server behaves
 *   exactly as before this module existed. Slot-degrade mirrors the context
 *   ladder: halve the slots before giving up.
 */
async function trySidecarRun(opts) {
  if (_customModel) return null;
  if (!sidecar.available()) {
    // Kick provisioning in the background (pinned, verified, ~11MB — the
    // model-download philosophy). This request falls back in-process; a
    // later tick finds the engine ready. Never awaited, never fatal.
    void sidecar.ensureBinary();
    return null;
  }
  const tier = opts.tier || DEFAULT_TIER;
  const entry = activeEntry(tier);
  if (!entry.sidecar || !entry.template) return null;
  const modelPath = modelPathFor(tier);
  if (!fs.existsSync(modelPath)) return null;

  // ★ A LIVE ENGINE IS NEVER RE-GUARDED — the running sidecar's own ~3.5GB
  //   counts as "consumed" in availableMemoryBytes, so re-checking on every
  //   request refuses the very engine that is already serving (the same
  //   double-count residentCreditBytes fixes for the in-process host;
  //   measured live by probe-sidecar-e2e). The guard gates STARTS only.
  const live = sidecar.status();
  if (live.alive && live.modelPath === modelPath) {
    return sidecar.run(opts, entry);
  }

  const { slots: wantSlots, slotContext } = entry.sidecar;
  const available = availableMemoryBytes();
  let slots = wantSlots;
  while (slots >= 1 && available < loadCostBytes(entry, modelPath, slots * slotContext)) {
    slots = Math.floor(slots / 2);
  }
  if (slots < 1) return null;

  const started = await sidecar.ensureStarted({
    modelPath, slots, slotContext, tier: entry.tier,
    idleTtlMs: entry.idleTtlMs,
  });
  if (!started.ok) return null;
  return sidecar.run(opts, entry);
}

async function run(opts = {}) {
  if (opts.lane === 'batch') {
    const viaSidecar = await trySidecarRun(opts);
    if (viaSidecar) return viaSidecar;
    // fall through: the in-process path serves the request unchanged
  }
  const requestId = opts.requestId || crypto.randomUUID();
  // Queue depth 1. `_claiming` closes the window between this check and
  // `_inflight` being set, which spans an await on ensureLoaded().
  if (_inflight || _claiming) return { ok: false, error: 'busy', requestId };
  if (opts.freeText !== true && (!opts.schema || typeof opts.schema !== 'object')) {
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
        schema: opts.schema || null,
        freeText: opts.freeText === true,
        stopTexts: Array.isArray(opts.stopTexts) ? opts.stopTexts : undefined,
        maxTokens: Number.isFinite(opts.maxTokens) ? opts.maxTokens : 128,
        temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0,
        minP: Number.isFinite(opts.minP) ? opts.minP : 0,
        noThink: opts.noThink !== false,
        jsonStyle: opts.jsonStyle === 'compact' ? 'compact' : null,
      });
    } catch (err) {
      clearTimeout(timer);
      _inflight = null;
      resolve({ ok: false, error: `post-failed:${String(err && err.message || err)}`, requestId });
    }
  });
}

function cancel({ requestId } = {}) {
  // Sidecar runs first: its inflight map is keyed by requestId, and a batch
  // cancel must not be misread as "idle" by the single-slot host below.
  if (requestId) {
    const viaSidecar = sidecar.cancel(requestId);
    if (viaSidecar.ok) return viaSidecar;
  }
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
  sidecar.stop('unload');
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
    const next = setCustomModel(opts || null);
    return { ok: true, source: next };
  });
  ipcMain.handle('assistant:presets', async () => ({ ok: true, presets: MODEL_PRESETS }));
  ipcMain.handle('assistant:unload', () => unload());

  // The sidecar streams run-text through the same renderer channel the host
  // uses; it gets the fan-out once, here.
  sidecar.setEmitter(sendToRenderers);

  app.on('before-quit', () => { killHost('app-quit'); sidecar.stop('app-quit'); });
  app.on('will-quit', () => { killHost('app-quit'); sidecar.stop('app-quit'); });
}

module.exports = {
  registerAssistant,
  deleteModel,
  setCustomModel,
  activeEntry,
  resolvedModelUrl,
  isGgufFile,
  customFileName,
  MODEL_PRESETS,
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
  sidecar,
  __hostPid: () => (_host && _hostAlive ? _host.pid : null),
};
