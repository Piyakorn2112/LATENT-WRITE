/**
 * assistant-client.ts — the renderer's single door to the local model.
 *
 * A thin, typed wrapper over `window.electronAPI.assistant*`. It owns exactly
 * three things the runtime cannot own for us:
 *
 *   1. SINGLE FLIGHT, ACK-BASED. One request leaves the renderer at a time and
 *      the next is dispatched only after the previous one has SETTLED (result,
 *      cancellation ack, or main's own timeout). Main enforces queue depth 1
 *      too and answers a second run with `busy`; defence in both layers is the
 *      point. Without the renderer-side queue, two independent features would
 *      race and one would randomly lose its work to a `busy` error.
 *   2. CANCELLATION BY INTENT. `cancelAll()` / `cancelWhere(pred)` reach both
 *      the queue and the in-flight request, keyed on `task` and the caller's
 *      own `tag` — so "drop everything for the chapter the writer just left"
 *      is one call, not bookkeeping in every feature.
 *   3. GRACEFUL UNAVAILABILITY. In the browser build (or before the preload
 *      bridge exists) every call resolves `{ok:false, reason:"unavailable"}`.
 *      Never throws, never rejects — a caller must be able to `await` this on
 *      any platform without a try/catch.
 *
 * ★ THE CLIENT WATCHDOG CANCELS BUT NEVER RESOLVES EARLY. Resolving locally on
 *   a late request would let the next job dispatch while main still holds the
 *   old one in flight — precisely the double-run the queue exists to prevent.
 *   A wedged runtime therefore stalls this queue visibly rather than silently
 *   flooding a slow consumer (the worker-composite backpressure lesson).
 *
 * The runtime is generic: it knows nothing about novels. Everything domain-
 * specific lives in the task modules (adjudicator.ts, entity-review.ts).
 */
import type { AssistantRunResult } from "./project-manager";

/** Per-request cap. Main's own cap is 120s; 30s is the product-level patience. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** How long after main's own timeout we still bother sending an abort. */
const CANCEL_GRACE_MS = 2_000;

export interface AssistantJSONRequest {
  /** Coarse label, echoed by the runtime; the first key `cancelWhere` sees. */
  task: string;
  /** Caller-owned fine label (a candidate key, a chapter id) for targeted cancels. */
  tag?: string;
  systemPrompt: string;
  userText: string;
  /** JSON Schema compiled to a GBNF grammar by the host; guarantees the shape. */
  schema: object;
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * Which registry model runs this. Omitted = the runtime default (the 1.7B
   * every existing task was measured against). "max" is the 4B thinking tier.
   */
  tier?: "small" | "max";
  /**
   * ★ Pass FALSE for the thinking tier and nothing otherwise. The runtime
   *   appends "/no_think" by default, which is right for the 1.7B and wrong
   *   for a thinking model; and a duplicate "/no_think" in a prompt is a
   *   Qwen3 footgun, so this must stay a tri-state passthrough rather than a
   *   boolean the client invents a value for.
   */
  noThink?: boolean;
  /**
   * Context length to load the model at. A caller that KNOWS its prompt is
   * small should say so: the max tier defaults to 8192, and on a tight machine
   * the difference between asking for 8k and 4k of KV cache is the difference
   * between the guard refusing and the answer arriving (~132 KB per token).
   */
  contextSize?: number;
  /**
   * "compact" builds the JSON grammar without pretty-printing, so the model
   * cannot spend tokens on indentation (measured 14–17% of a chip answer).
   * Only worth setting alongside a wire designed for it — see CHIP_SCHEMA_RICH.
   */
  jsonStyle?: "compact";
}

export type AssistantJSONResult<T> =
  | { ok: true; json: T; modelId: string; timings: unknown }
  | { ok: false; reason: string };

/** The injectable shape task modules depend on, so they test without Electron. */
export type AssistantJSONRunner = <T>(
  req: AssistantJSONRequest,
) => Promise<AssistantJSONResult<T>>;

// ── bridge access ───────────────────────────────────────────────────────────

function api() {
  return typeof window !== "undefined" && window.electronAPI?.isElectron
    ? window.electronAPI
    : null;
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

let _seq = 0;
const nextRequestId = (task: string) =>
  `${task}-${(++_seq).toString(36)}-${Date.now().toString(36)}`;

/**
 * The model id is part of every verdict cache key, so callers need it BEFORE a
 * run. Memoised: the registry has one tier in v1 and the id can only change
 * with a model swap, which is a restart-shaped event.
 */
let _modelId: string | null = null;
export async function assistantModelId(): Promise<string | null> {
  if (_modelId) return _modelId;
  const a = api();
  if (!a) return null;
  try {
    const status = await a.assistantStatus();
    _modelId = status?.model?.id ?? null;
    return _modelId;
  } catch {
    return null;
  }
}

/**
 * Can a run succeed right now? `no-model` is deliberately NOT available: a
 * 1.1 GB download is never an implicit side effect of asking a question.
 *
 * ★ TIER-AWARE: a caller about to run on the max tier must ask about the MAX
 *   model. The parameterless form checks the default (small) tier, which in
 *   max mode answers the wrong question in both directions — max-present/
 *   small-absent blocked work that would succeed, and small-present/max-absent
 *   green-lit runs that each failed and burned a skip key.
 */
export async function assistantAvailable(tier?: "small" | "max"): Promise<boolean> {
  const a = api();
  if (!a) return false;
  try {
    const status = await a.assistantStatus(tier ? { tier } : undefined);
    if (!status?.model?.present) return false;
    return (
      status.state !== "error" &&
      status.state !== "low-memory" &&
      status.state !== "downloading" &&
      status.state !== "no-model"
    );
  } catch {
    return false;
  }
}

// ── single-flight queue ─────────────────────────────────────────────────────

interface Job {
  requestId: string;
  task: string;
  tag?: string;
  req: AssistantJSONRequest;
  settle: (result: AssistantJSONResult<unknown>) => void;
  cancelled: boolean;
}

const queue: Job[] = [];
let inflight: Job | null = null;
let pumping = false;

function requestCancel(requestId: string): void {
  const a = api();
  if (!a) return;
  void a.assistantCancel({ requestId }).catch(() => { /* already gone */ });
}

async function execute(job: Job): Promise<AssistantJSONResult<unknown>> {
  const a = api();
  if (!a) return { ok: false, reason: "unavailable" };

  const modelId = (await assistantModelId()) ?? "unknown";
  const timeoutMs = job.req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Fires only if main's own timer did not — see the header note on why this
  // aborts rather than resolves.
  const watchdog = setTimeout(() => requestCancel(job.requestId), timeoutMs + CANCEL_GRACE_MS);

  let res: AssistantRunResult<unknown>;
  try {
    res = await a.assistantRun<unknown>({
      requestId: job.requestId,
      task: job.task,
      systemPrompt: job.req.systemPrompt,
      userText: job.req.userText,
      schema: job.req.schema as Record<string, unknown>,
      maxTokens: job.req.maxTokens,
      timeoutMs,
      // temperature 0 stays the runtime's default. noThink/tier travel only
      // when the caller set them — the max tier passes noThink:false so the
      // thinking model is allowed to think; everyone else inherits the
      // runtime's "/no_think" default. See the request type's note.
      ...(job.req.tier ? { tier: job.req.tier } : {}),
      ...(job.req.noThink === false ? { noThink: false } : {}),
      ...(job.req.contextSize ? { contextSize: job.req.contextSize } : {}),
      ...(job.req.jsonStyle ? { jsonStyle: job.req.jsonStyle } : {}),
    });
  } catch (err) {
    return { ok: false, reason: `ipc-failed:${message(err)}` };
  } finally {
    clearTimeout(watchdog);
  }

  if (res.cancelled) return { ok: false, reason: "cancelled" };
  if (!res.ok) return { ok: false, reason: res.error || "run-failed" };
  if (!res.json || typeof res.json !== "object") return { ok: false, reason: "no-json" };
  return { ok: true, json: res.json, modelId, timings: res.timings ?? null };
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const job = queue.shift();
      if (!job) break;
      if (job.cancelled) {
        job.settle({ ok: false, reason: "cancelled" });
        continue;
      }
      inflight = job;
      const result = await execute(job).catch(
        (err): AssistantJSONResult<unknown> => ({ ok: false, reason: `client-failed:${message(err)}` }),
      );
      inflight = null;
      job.settle(result);
    }
  } finally {
    pumping = false;
  }
}

/**
 * Run one grammar-constrained JSON completion. Resolves — never rejects.
 * Queued behind any request already in flight from this renderer.
 */
export function assistantRunJSON<T>(req: AssistantJSONRequest): Promise<AssistantJSONResult<T>> {
  if (!api()) return Promise.resolve({ ok: false, reason: "unavailable" });
  return new Promise<AssistantJSONResult<T>>((resolve) => {
    queue.push({
      requestId: nextRequestId(req.task || "assistant"),
      task: req.task,
      tag: req.tag,
      req,
      cancelled: false,
      settle: resolve as unknown as (result: AssistantJSONResult<unknown>) => void,
    });
    void pump();
  });
}

/**
 * Cancel every queued and in-flight request whose `{task, tag}` matches.
 * Queued jobs settle immediately (they never reached the runtime); the
 * in-flight job settles when the host acks the abort, which keeps single
 * flight intact. Returns how many requests were affected.
 */
export function cancelWhere(
  predicate: (info: { task: string; tag?: string }) => boolean,
  reason = "cancelled",
): number {
  let count = 0;
  for (let i = queue.length - 1; i >= 0; i--) {
    const job = queue[i];
    if (!predicate({ task: job.task, tag: job.tag })) continue;
    queue.splice(i, 1);
    job.cancelled = true;
    job.settle({ ok: false, reason });
    count++;
  }
  if (inflight && predicate({ task: inflight.task, tag: inflight.tag })) {
    requestCancel(inflight.requestId);
    count++;
  }
  return count;
}

export function cancelAll(reason = "cancelled"): number {
  return cancelWhere(() => true, reason);
}

/** Debug/status read-out — the queue is otherwise invisible to the UI. */
export function assistantPending(): { queued: number; inFlight: string | null } {
  return { queued: queue.length, inFlight: inflight ? inflight.requestId : null };
}

/**
 * Repair a string the GRAMMAR cut off, for fields shown to the writer.
 *
 * ★ A `maxLength` in the JSON schema is a hard guillotine, not a hint: the
 *   grammar stops the string mid-word the instant the cap is reached. MEASURED
 *   on Qwen3-1.7B: reasons that hit the cap also code-switch in the last token
 *   or two ("…implying a共享"), because the model is being cut off mid-thought.
 *   Every observed non-Latin fragment was on a string sitting exactly at the
 *   cap; none appeared on a string that finished on its own.
 *
 * ★ THE FIX BELONGS HERE, NOT IN THE PROMPT. Asking for a shorter reason does
 *   shorten it — and also flipped a correct `break` verdict to `unsure` when
 *   measured. Never pay for cosmetics with judgment.
 *
 * Cuts back to the last completed sentence, or failing that drops the trailing
 * partial word and marks the cut. Strings that ended on their own are returned
 * untouched.
 */
export function tidyTruncatedText(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length < maxLength) return trimmed;      // finished on its own

  // ★ A trailing "." on a string sitting exactly at the cap proves nothing —
  //   observed: "…the reference is hearsay/second-hand, but the pl." So at the
  //   cap we always cut back to a sentence that demonstrably completed.
  const lastSentence = Math.max(
    trimmed.lastIndexOf(". "), trimmed.lastIndexOf("! "), trimmed.lastIndexOf("? "),
  );
  // Only honour a sentence break that leaves most of the answer standing.
  if (lastSentence > maxLength * 0.4) return trimmed.slice(0, lastSentence + 1);

  const dropped = trimmed.replace(/\s*\S+$/, "").replace(/[,;:\s]+$/, "");
  return dropped ? `${dropped}…` : trimmed;
}
