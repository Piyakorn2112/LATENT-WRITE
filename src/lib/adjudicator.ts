/**
 * adjudicator.ts — the continuity judgment task (L4's renderer half).
 *
 * The question is always the same one: could SPEAKER plausibly know about
 * ENTITY at this point in the story? The evidence is whatever
 * `buildEvidencePack` selected — the model never searches and never sees the
 * manuscript. Contract: plans/knowledge-ledger-and-local-adjudicator.md §7–§8.
 *
 * ★ ABSTENTION IS LOAD-BEARING, AND SO IS FAILURE. A run that times out, comes
 *   back malformed, or returns a blank reason leaves the candidate exactly as
 *   it was: `pending`, no verdict, no fact. There is no default verdict and no
 *   repaired one — a fabricated judgment is worse than a missing one, because
 *   the writer cannot tell them apart.
 *
 * ★ THE CACHE KEY CARRIES EVERY OUTPUT-AFFECTING INPUT.
 *   `verdictKey = fnv1a(candidateKey | packHash | modelId | promptVersion)`,
 *   and `packHash` already folds in PACK_VERSION and the pack bytes. Change
 *   the evidence, the model, or this prompt and exactly the affected verdicts
 *   recompute — nothing else does.
 *
 * ★ A `plausible_offscreen` VERDICT AUTO-WRITES A `reference-implied` FACT
 *   (§13, decided). The pair is then supported for every LATER chapter, so the
 *   question is never asked twice. It is reversible precisely because the
 *   verdictKey records how it arose: the fact came from this model, this
 *   prompt, this pack.
 */
import { buildEvidencePack, fnv1a } from "./evidence-pack";
import type { EvidencePack, EvidencePackInput } from "./evidence-pack";
import type {
  AdjudicationVerdict,
  KnowledgeCandidate,
  KnowledgeFact,
  KnowledgeLedgerStore,
} from "./knowledge-store";
import { tidyTruncatedText } from "./assistant-client";
import type { AssistantJSONRunner } from "./assistant-client";

/** Bump on ANY change to the prompt text or the schema. Invalidates verdicts. */
export const ADJUDICATOR_PROMPT_VERSION = 1;

/**
 * ★★ THE ENUM VALUE `"break"` IS UNREACHABLE FOR A SMALL MODEL. MEASURED, on
 *    Qwen3-1.7B Q4_K_M with the spec's §7 prompt: it answered
 *    `plausible_offscreen` or `unsure` to EVERY pack, including one where the
 *    entity does not exist in the story before the claim, and including a
 *    two-label grammar with `unsure` deleted. Five prompt rewrites, both rule
 *    orderings, and thinking mode on all failed the same way. Changing ONE
 *    WORD — the enum value `"break"` → `"no_way_to_know"`, prompt otherwise
 *    byte-identical — made it correct on all three cases immediately.
 *
 *    The judgment was never the problem. In a JSON verdict field the token
 *    "break" reads as pause/fracture/break-out, so the model's distribution
 *    never routes there; a self-describing value does. Generalisation: a
 *    grammar-constrained enum is PROMPT SURFACE, not an internal identifier —
 *    the model reads the value, so it must say what it means.
 *
 *    The stored contract does NOT change: `AdjudicationVerdict.verdict` stays
 *    `"break"` (knowledge-store.ts owns that type, the UI reads it). Only the
 *    wire label the model sees is renamed, and `normalizeVerdict` maps it back.
 */
const VERDICT_TO_WIRE: Record<AdjudicationVerdict["verdict"], string> = {
  break: "no_way_to_know",
  plausible_offscreen: "plausible_offscreen",
  unsure: "unsure",
};
const WIRE_TO_VERDICT: Record<string, AdjudicationVerdict["verdict"]> = {
  no_way_to_know: "break",
  plausible_offscreen: "plausible_offscreen",
  unsure: "unsure",
  // A model that emits the stored word anyway is still understood.
  break: "break",
};

/** The label the model is asked to emit for a stored verdict. Single-sourced
 *  so a harness never hand-writes a wire label the module might change. */
export const wireVerdictFor = (verdict: AdjudicationVerdict["verdict"]): string =>
  VERDICT_TO_WIRE[verdict];

export const ADJUDICATOR_TASK = "continuity-adjudication";

/** §7 default. `reason` is grammar-capped at 160 chars, so 96 is comfortable. */
const DEFAULT_MAX_TOKENS = 96;
const DEFAULT_TIMEOUT_MS = 30_000;
/** §8 pace: one request at a time, ≥1s apart, so a backfill stays invisible. */
const DEFAULT_GAP_MS = 1_000;
const DEFAULT_LIMIT = 10;
const REASON_MAX = 160;

/**
 * Frozen v1 system prompt: the spec §7 text, with exactly two deviations.
 *   1. The trailing `/no_think` is NOT here — the runtime appends it from its
 *      `noThink` flag, and a duplicate toggle confuses Qwen3.
 *   2. `"break"` is written `"no_way_to_know"`, for the measured reason above.
 *      Nothing else moved: no rule was added, reordered, reworded or weighted.
 */
export const ADJUDICATOR_SYSTEM = `You judge continuity of knowledge in a novel. The question is always:
could SPEAKER plausibly know about ENTITY at this point in the story?

Rules:
- "no_way_to_know": the story so far gives SPEAKER no way to know ENTITY exists,
  and the reference reads as familiarity, not hearsay.
- "plausible_offscreen": the story implies a channel — shared background,
  reputation, an offscreen report, membership in the same world — or the
  reference itself is hearsay/second-hand. When the entity is famous or
  the speaker's role implies acquaintance, choose this.
- "unsure": evidence is thin either way. PREFER unsure over a guess.
  A wrong "no_way_to_know" wastes the writer's trust; "unsure" costs nothing.
- Judge only from the evidence given. Do not invent story events.
Answer as JSON: {"verdict","confidence","reason","citedChapter"}.
reason: one plain sentence a writer can act on, ≤160 characters.`;

/**
 * The grammar guarantees the shape; the prompt states it anyway (node-llama-cpp
 * documents that the model is not aware of the grammar).
 *
 * ★ DELIBERATELY NO `minLength` ON `reason`. A grammar could force a non-empty
 *   string, which would make "the model always explains itself" true by
 *   construction and untestable. It stays a measured behaviour: a blank reason
 *   is rejected here, and the live harness gates on it.
 */
export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { enum: ["no_way_to_know", "plausible_offscreen", "unsure"] },
    confidence: { type: "number" },
    reason: { type: "string", maxLength: REASON_MAX },
    citedChapter: { type: ["integer", "null"] },
  },
} as const;

/** Cache key. `fnv1a` is shared with evidence-pack so the recipe lives once. */
export function verdictKeyFor(candidateKey: string, packHash: string, modelId: string): string {
  return fnv1a(`${candidateKey}|${packHash}|${modelId}|p${ADJUDICATOR_PROMPT_VERSION}`);
}

// ── request assembly ──────────────────────────────────────────────────────

export interface AdjudicationRequest {
  pack: EvidencePack;
  verdictKey: string;
  systemPrompt: string;
  userText: string;
  schema: typeof VERDICT_SCHEMA;
  maxTokens: number;
}

/**
 * Everything that goes to the model for one candidate, assembled once.
 * Exported so a harness can emit the EXACT bytes the app sends instead of
 * hand-copying a prompt that then drifts (the restore-verbatim lesson).
 */
export function buildAdjudicationRequest(
  candidate: KnowledgeCandidate,
  packInput: EvidencePackInput,
  modelId: string,
  maxTokens = DEFAULT_MAX_TOKENS,
): AdjudicationRequest {
  const pack = buildEvidencePack({ ...packInput, candidate });
  return {
    pack,
    verdictKey: verdictKeyFor(candidate.key, pack.packHash, modelId),
    systemPrompt: ADJUDICATOR_SYSTEM,
    userText: pack.text,
    schema: VERDICT_SCHEMA,
    maxTokens,
  };
}

// ── verdict validation ────────────────────────────────────────────────────

/**
 * Range- and sanity-check the model's JSON, and map the wire label back to the
 * stored one. Returns null when the answer is not usable, which keeps the
 * candidate pending rather than inventing a shape.
 *
 * `citedChapter` is a navigation aid, not a claim: a number the story does not
 * contain is dropped to null rather than failing the whole verdict.
 */
export function normalizeVerdict(
  raw: unknown,
  knownChapterNumbers?: readonly number[],
): AdjudicationVerdict | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  const wire = value.verdict;
  const verdict = typeof wire === "string" ? WIRE_TO_VERDICT[wire] : undefined;
  if (!verdict) return null;

  const confidenceRaw = value.confidence;
  if (typeof confidenceRaw !== "number" || !Number.isFinite(confidenceRaw)) return null;
  const confidence = Math.min(1, Math.max(0, confidenceRaw));

  const reasonRaw = value.reason;
  if (typeof reasonRaw !== "string") return null;
  const reason = tidyTruncatedText(reasonRaw.slice(0, REASON_MAX), REASON_MAX);
  if (!reason) return null; // a verdict the popover cannot show is not a verdict

  let citedChapter: number | null = null;
  const citedRaw = value.citedChapter;
  if (typeof citedRaw === "number" && Number.isFinite(citedRaw)) {
    const n = Math.trunc(citedRaw);
    citedChapter = !knownChapterNumbers || knownChapterNumbers.includes(n) ? n : null;
  }

  return { verdict, confidence, reason, citedChapter };
}

/**
 * The fact a `plausible_offscreen` ruling writes.
 * Anchored at the REFERENCE chapter, never at `citedChapter`: we ruled that
 * the speaker plausibly knows BY NOW, which is all the evidence supports, and
 * a fact anchored earlier would silently excuse earlier references too.
 */
export function impliedFactFor(candidate: KnowledgeCandidate): KnowledgeFact {
  return {
    subject: candidate.speaker,
    entity: candidate.entity,
    chapterId: candidate.chapterId,
    chapterNumber: candidate.chapterNumber,
    how: "reference-implied",
    sentence: candidate.sentence,
  };
}

// ── one candidate ─────────────────────────────────────────────────────────

export interface AdjudicateOptions {
  run: AssistantJSONRunner;
  /** From `assistantStatus().model.id`; part of the cache key. */
  modelId: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface AdjudicationOutcome {
  /** The updated candidate, or the ORIGINAL object when nothing was decided. */
  candidate: KnowledgeCandidate;
  /** Only on `plausible_offscreen`. The caller merges it into the store. */
  impliedFact?: KnowledgeFact;
  pack: EvidencePack;
  /** True when the stored verdict already matched the current key. */
  cached: boolean;
  /** Set when the run or its answer was unusable; candidate is unchanged. */
  failure?: string;
  timings?: unknown;
}

/**
 * Adjudicate one candidate. Short-circuits on a cache hit; on any failure
 * returns the candidate untouched with `failure` set (status stays pending).
 */
export async function adjudicateCandidate(
  candidate: KnowledgeCandidate,
  packInput: EvidencePackInput,
  opts: AdjudicateOptions,
): Promise<AdjudicationOutcome> {
  const request = buildAdjudicationRequest(
    candidate,
    packInput,
    opts.modelId,
    opts.maxTokens ?? DEFAULT_MAX_TOKENS,
  );

  if (candidate.verdict && candidate.verdictKey === request.verdictKey) {
    return { candidate, pack: request.pack, cached: true };
  }

  const result = await opts.run<unknown>({
    task: ADJUDICATOR_TASK,
    tag: candidate.key,
    systemPrompt: request.systemPrompt,
    userText: request.userText,
    schema: request.schema,
    maxTokens: request.maxTokens,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  if (!result.ok) {
    return { candidate, pack: request.pack, cached: false, failure: result.reason };
  }

  const verdict = normalizeVerdict(
    result.json,
    packInput.chapters.map((c) => c.chapterNumber),
  );
  if (!verdict) {
    return { candidate, pack: request.pack, cached: false, failure: "invalid-verdict", timings: result.timings };
  }

  const updated: KnowledgeCandidate = {
    ...candidate,
    status: "adjudicated",
    verdict,
    verdictKey: request.verdictKey,
  };

  return {
    candidate: updated,
    impliedFact: verdict.verdict === "plausible_offscreen" ? impliedFactFor(candidate) : undefined,
    pack: request.pack,
    cached: false,
    timings: result.timings,
  };
}

// ── the pending sweep ─────────────────────────────────────────────────────

export interface RunPendingDeps {
  run: AssistantJSONRunner;
  modelId: string;
  /**
   * The caller owns the novel, the story graph and retrieval, so it builds the
   * pack input per candidate. Returning null skips the candidate (its chapter
   * is not loaded, retrieval is still running, …) without marking it failed.
   */
  packInputFor: (candidate: KnowledgeCandidate) => EvidencePackInput | null;
}

export interface RunPendingOptions {
  /** Caps MODEL RUNS, not candidates seen — a cache hit costs nothing. */
  limit?: number;
  /** Minimum spacing between model runs. Cache hits are free and not spaced. */
  gapMs?: number;
  /** Checked between items — the writer typed, the chapter changed, app hid. */
  isCancelled?: () => boolean;
  maxTokens?: number;
  timeoutMs?: number;
  /** Injectable so tests do not actually wait a second per candidate. */
  sleep?: (ms: number) => Promise<void>;
  onOutcome?: (outcome: AdjudicationOutcome) => void;
}

export interface RunPendingResult {
  /** Only the candidates that changed. The caller merges and persists. */
  candidates: KnowledgeCandidate[];
  impliedFacts: KnowledgeFact[];
  attempted: number;
  adjudicated: number;
  cached: number;
  failed: number;
  skippedLowBand: number;
  skippedDecided: number;
  skippedNoPack: number;
  stopped: "done" | "limit" | "cancelled";
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Sweep the store's pending candidates, sequentially, paced.
 *
 * Does NOT persist: the caller owns the store, so a sweep interrupted by a
 * reload or a writer decision cannot half-write it.
 *
 * Queue ORDER is the caller's (§8 wants the current chapter first, then
 * outward by chapter distance); this runs `store.candidates` as given.
 *
 * ★ LOW-BAND CANDIDATES ARE NEVER ADJUDICATED IN v1. A bare mention claims
 *   almost nothing, and the surfacing rule the band was designed for — show it
 *   only once a SECOND reference to the same pair appears — needs
 *   second-reference tracking the ledger does not record yet. Spending a real
 *   inference on a candidate that cannot be surfaced is strictly worse than
 *   not spending it. Lift this only together with that tracking.
 */
export async function runPendingAdjudications(
  store: KnowledgeLedgerStore,
  deps: RunPendingDeps,
  opts: RunPendingOptions = {},
): Promise<RunPendingResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS;
  const sleep = opts.sleep ?? defaultSleep;

  const out: RunPendingResult = {
    candidates: [], impliedFacts: [],
    attempted: 0, adjudicated: 0, cached: 0, failed: 0,
    skippedLowBand: 0, skippedDecided: 0, skippedNoPack: 0,
    stopped: "done",
  };

  let ranModel = false;
  for (const candidate of store.candidates) {
    if (candidate.status !== "pending") continue;
    if (candidate.band !== "normal") { out.skippedLowBand++; continue; }

    // Decisions beat verdicts (§8): the writer already ruled on this exact
    // sentence. A materially different sentence is a NEW question, and the
    // ledger gives it a new candidate.
    const decision = store.decisions[candidate.key];
    if (decision && decision.sentence === candidate.sentence) { out.skippedDecided++; continue; }

    if (out.adjudicated + out.failed >= limit) { out.stopped = "limit"; break; }
    if (opts.isCancelled?.()) { out.stopped = "cancelled"; break; }

    const packInput = deps.packInputFor(candidate);
    if (!packInput) { out.skippedNoPack++; continue; }

    if (ranModel && gapMs > 0) await sleep(gapMs);
    if (opts.isCancelled?.()) { out.stopped = "cancelled"; break; }

    out.attempted++;
    const outcome = await adjudicateCandidate(candidate, packInput, {
      run: deps.run,
      modelId: deps.modelId,
      maxTokens: opts.maxTokens,
      timeoutMs: opts.timeoutMs,
    });
    opts.onOutcome?.(outcome);

    if (outcome.cached) {
      out.cached++;
      continue;
    }
    ranModel = true;
    if (outcome.failure) {
      out.failed++;
      continue;
    }
    out.adjudicated++;
    out.candidates.push(outcome.candidate);
    if (outcome.impliedFact) out.impliedFacts.push(outcome.impliedFact);
  }

  return out;
}
