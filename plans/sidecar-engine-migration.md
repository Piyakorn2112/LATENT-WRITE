# Sidecar engine migration — absorption notes + design

_Read-through of the full assistant stack (2026-08-07), then the plan. GO
probe: scripts/probe-llama-server.ts — llama-server -np 4 -fa on delivered
1.75x true batching, schema 4/4, per-call ~2.9s vs ~7s standalone binding._

## 1 · What exists (absorbed, nothing skipped)

### electron/assistant.cjs (1032 lines, main process) — KEEP ALMOST ALL
- **Registry**: `small` (1.7B, ctx 4096, noThink true, kv 103KB/tok) and `max`
  (4B-Thinking, ctx 8192/min 4096, noThink false, flashAttention, kvCacheType
  Q8_0, kv 70KB/tok, idleTtlMs 90s). Pinned repo+revision+sha256.
- **Custom-model escape hatch**: `setCustomModel` / `activeEntry` (custom
  REPLACES the registry entry, tier 'custom'), MODEL_PRESETS, customFileName.
  → custom models NEVER route to the sidecar (unknown template); in-process.
- **Download**: resumable `.part`, redirects ≤5, sha256 sidecar + `.verified`
  stamp (size+mtime), GGUF magic check, `deleteModel` kills host FIRST
  (mmap), env override `ASSISTANT_MODEL_PATH` skips all of it.
- **Memory guard**: darwin `vm_stat` free+inactive+speculative+purgeable;
  `loadCostBytes = weights + kvBytesPerToken×ctx + headroom(384MB, env
  overridable)`; `fittingContext` halving ladder to minContextSize;
  `residentCreditBytes` credits the SAME model's resident copy; `_lowMemory`
  latch + `_degraded` note surfaced in status.
- **Host lifecycle**: `ensureHost` = utilityProcess.fork(assistant-host.cjs),
  boot timeout 60s, `allowLoadingUnsignedLibraries`, **NO cwd** (asar is a
  file — chdir kills the fork silently; verified on a packed build).
  `killHost` resolves inflight with `host-exited:<reason>`. Idle TTL per tier
  (`_idleTtlMs`), armed on load AND on result/timeout. `before-quit`/
  `will-quit` → killHost.
- **run()**: queue depth ONE (`_inflight` + `_claiming` spanning the
  ensureLoaded await), `schema-required` check, timeout (default 120s) that
  posts cancel + resolves `timeout`, postMessage `{type:'run', id, task,
  systemPrompt, userText, schema, maxTokens(128), temperature(0),
  noThink(!==false), jsonStyle('compact'|null)}`.
- **onHostMessage**: `loaded` copies fields EXPLICITLY (lesson: a new host
  field is invisible until named), `run-text` forwarded to renderers as
  `assistant:progress {phase:'run-text', requestId, task, text}` gated on
  `_inflight.requestId === msg.id`, `result` resolves + re-arms idle timer.
- **IPC**: status/ensure-model/run/cancel/delete-model/set-source/presets/
  unload. **Exports drive every harness** (verify-assistant-runtime,
  bench-assistant, probe-chip-max, probe-max-ask*, probe-writing-tool…):
  registerAssistant, ensureLoaded, run, cancel, unload, assistantStatus,
  MODEL_REGISTRY, modelPathFor, availableMemoryBytes, __hostPid.
- **status shape**: `{state, degraded, model{id,tier,label,bytes,path,
  present,source}, progress?, host{alive,pid,loaded{modelPath,contextSize,
  gpu,gpuLayers,loadMs,marks,kvCacheTypeRequested,kvCacheTypeApplied,
  flashAttention}}, lowMemory?, error?}`. States: no-model|downloading|ready
  |loading|busy|low-memory|error.

### electron/assistant-host.cjs (478 lines, utilityProcess) — STAYS, gains a sibling
- Protocol: load/run/cancel/unload/ping → ready/loaded/load-error/result/
  run-text/unloaded/status/pong. Queue depth ONE, `busy` refusal.
- `handleLoad`: same-{path,ctx} reload is a no-op; different model unloads
  first; Q8_0 KV experimental with plain-context retry reporting
  `kvCacheTypeApplied: null`; explicit loaded fields incl. flashAttention.
- `handleRun`: fresh LlamaChatSession per run, **NO clearHistory** (prefix
  cache: 8x prefill, chips 1176→69ms measured); `noThink` appends
  `/no_think`; grammar cache keyed `(style|schema)` → {gen, parse} pair —
  compact via file-URL import of `getGbnfGrammarForGbnfJsonSchema`
  (allowNewLines:false), parse = JSON.parse; pretty via
  createGrammarForJsonSchema, parse = grammar.parse (validates);
  `onTextChunk` accumulates + throttles 120ms → run-text; timings
  {prefillMs, genMs, totalMs, tokens, tokensPerSec}; session.dispose keeps
  the sequence; errors: busy|not-loaded|cancelled|schema|parse|free-form.

### Renderer contracts that MUST NOT drift
- `AssistantJSONResult` reasons feed the chip tick's failure classifier:
  CONTENT_FAILURES = {parse, no-json, schema}; everything else transient
  (bounded retries). A sidecar failure must map into this vocabulary.
- `run-text` carries ACCUMULATED text (writing tool + chip streaming parse
  depend on accumulation, not deltas).
- Client single-flight queue: one request leaves the renderer at a time;
  cancelWhere by {task, tag}; watchdog cancels late requests, never
  resolves early.
- Consumers: chips (compact+partial+tier max), summary (compact in max),
  max-ask chain (ctx 8192, needs a BIG slot), adjudicator, entity-review,
  scene/chekhov sweep, alias-referent (max), writing tool (compact+partial+
  cancel-by-task), CastConfirmOverlay, WorldDataView alias scan.

## 2 · Design (v1 scope: the background batch engine)

**The sidecar serves BATCH work (chips + summaries); the in-process host
keeps interactive work (max-ask, writing tool) and all custom models.**
Rationale: llama-server slots are fixed at c/np each — `-c 8192 -np 4` gives
2048-token slots, which fits every chip/summary prompt (measured) but not
max-ask's 8k pack. Splitting by workload keeps the golden-tested interactive
paths byte-identical and still wins the 1.75x where the book-scale cost is.
KV cost: sidecar 8192 total ≈ today's single context; when both engines are
warm the overlap is bounded by the in-process 90s TTL.

- **electron/assistant-sidecar.cjs** (new): supervises a `llama-server`
  child (`child_process.spawn` — native binary, not utilityProcess).
  - Binary discovery: `ASSISTANT_LLAMA_SERVER` env → `/opt/homebrew/bin/
    llama-server` → `llama-server` on PATH. Absent → `available:false`,
    everything falls back in-process (zero regression).
  - Start args: `-m <modelPath> -c <slots×slotCtx> -np <slots> -fa on
    --port <random 49xxx> --host 127.0.0.1`. Registry gains per-tier
    `sidecar: { slots: 4, slotContext: 2048 }` (max tier only, v1).
  - Memory guard reuses `loadCostBytes` with ctx = slots×slotContext
    (identical arithmetic; same degrade: halve slots before refusing).
  - Health: poll `/health` until ok (boot timeout 60s); on child exit →
    mark dead, reject inflight with `host-exited:sidecar`, next run
    falls back in-process.
  - Run: native `/completion`, hand-built ChatML template with **closed
    think prefill** (`<think>\n\n</think>`) + `/no_think` line — the chat
    endpoint's auto-template opened <think> and burned the budget (0/4).
    Template keyed by registry `template:'qwen3'`; only qwen3 in v1.
    Body: `{prompt, json_schema: schema, temperature, n_predict:
    maxTokens, cache_prompt: true, stream: true}`. SSE accumulation →
    same throttled `run-text`; final content → JSON.parse; parse failure
    → error 'parse' (keeps the tick's content/transient split).
  - Timings mapped from the server's `timings` into our shape.
  - Cancel: AbortController on the fetch (server frees the slot).
  - Idle TTL: same per-tier policy; kill the child, weights stay in page
    cache (warm restart ~2s, measured class).
  - Concurrency: inflight MAP capped at `slots`; over-cap → 'busy'.
- **assistant.cjs routing**: `run(opts)` — when `opts.lane === 'batch'` AND
  tier max AND no custom model AND sidecar available → sidecar.run();
  else existing path untouched. Status gains `sidecar: {alive, slots,
  port}`. Quit hooks kill the sidecar too.
- **assistant-client.ts**: `lane?: 'batch'` on the request; the queue pumps
  batch-lane jobs up to 3 concurrently (interactive lane stays single-
  flight; cancelWhere covers both).
- **App tick**: chips drain fires up to 3 chapters concurrently in max mode
  (Promise pool inside the existing self-arming worker; per-chapter stamps
  and skip/strike bookkeeping unchanged — they are already per-key).

## 3 · Invariant checklist (gates before default-on)
- [ ] result shape + error vocabulary identical (tick classifier unaffected)
- [ ] run-text accumulated + throttled (chip streaming parses mid-JSON)
- [ ] chip suite, summary path, golden probes vs sidecar: content quality
      hand-checked (temp-0 outputs may differ from in-process — judged, not
      byte-compared)
- [ ] fallback: sidecar absent/dead → in-process, no failed chapters
- [ ] memory guard fires (env headroom override test)
- [ ] app-quit kills the child (no orphan llama-server)
- [ ] probe-sidecar throughput ≥1.5x on 4-chapter batch vs in-process
