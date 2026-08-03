/**
 * attribution-review.ts — the tie-break task: who actually says this line?
 *
 * The FIFTH consumer of the assistant runtime, and the first whose answer
 * writes back into something the rest of the app reads. The queue is the
 * ENGINE'S OWN UNCERTAINTY: spans where a speaker was chosen but the posterior
 * landed between PRONOUN_MIN_POSTERIOR (0.25) and ATTESTED_FLOOR (0.78).
 *
 * ★★ RANK AND CAP, DO NOT SWEEP. Measured over 73 DEV chapters
 *    (scripts/probe-assist-funnels.ts): 43.62 such spans PER CHAPTER. At ~600ms
 *    each that is 26 seconds of continuous inference per chapter, for a queue
 *    an edit invalidates before it drains. Three per chapter, chosen by a
 *    ranking, is the feature; the cap is not a limitation of it.
 *
 * ★ THE MODEL CHOOSES BETWEEN NAMES, IT NEVER NAMES SOMEONE NEW. `offered` is
 *   assembled here and every answer outside it is dropped in
 *   `normalizeAttribution` — a grammar cannot enforce it because the offered
 *   set differs per span, so the guard is mechanical and lives in code.
 *
 * ★ A SUB-FLOOR ANSWER IS DISCARDED, NOT APPLIED WEAKLY. This lands on the
 *   adaptive path as an AnnotationCorrection-shaped fact, and a wrong confident
 *   answer teaches the ranker the wrong thing for every widget downstream. The
 *   floor is asymmetric in effect: agreeing with the engine costs nothing,
 *   overturning it needs ATTRIBUTION_MIN_CONFIDENCE.
 */
import { fnv1a } from "./evidence-pack";
import { tidyTruncatedText } from "./assistant-client";
import type { AssistantJSONRunner } from "./assistant-client";

export const ATTRIBUTION_TASK = "attribution-review";
/** Bump on ANY change to the prompt text or the schema. Invalidates stored answers. */
export const ATTRIBUTION_PROMPT_VERSION = 1;

/** Per-chapter budget. See the ★★ above for the measurement behind it. */
export const ATTRIBUTION_CAP = 3;

/**
 * The band the engine itself calls uncertain: above PRONOUN_MIN_POSTERIOR and
 * below ATTESTED_FLOOR. Outside it there is nothing to tie-break — a span at
 * 0.9 is attested and a span at 0 has no candidate to choose between.
 */
export const UNSURE_LO = 0.25;
export const UNSURE_HI = 0.78;

/** Below this the answer is dropped rather than applied. */
export const ATTRIBUTION_MIN_CONFIDENCE = 0.7;

/**
 * How many names the model is shown. A longer list is a guessing list: past
 * three or four names the alternation prior stops discriminating and every
 * extra name costs prefill for someone who cannot win.
 */
export const ATTRIBUTION_OFFERED_CAP = 5;

/** The literal abstention. Never a name, never in `offered`. */
export const ATTRIBUTION_UNSURE = "unsure";

/** Preceding paragraphs shown as evidence, and how much of each. */
const CONTEXT_PARAGRAPHS = 2;
const PARAGRAPH_MAX = 400;
const QUOTE_MAX = 600;
const REASON_MAX = 120;
/** Headroom over any real name: a `maxLength` is a guillotine, not a hint. */
const SPEAKER_MAX = 60;

const DEFAULT_MAX_TOKENS = 128;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * ★★ REASON FIRST, AND THE ORDER IS THE FIX. A grammar emits properties in
 *    declaration order, so with the label first the model must commit before it
 *    has written a word of evidence — measured in entity-review, where that
 *    produced labels contradicting their own reasons. Do not reorder these.
 *
 * ★ `speaker` IS A STRING, NOT AN ENUM, BECAUSE THE OFFERED SET IS PER SPAN.
 *   The schema is one object shared by every request; the names it may contain
 *   change with every line of dialogue. Membership is therefore checked in
 *   `normalizeAttribution` against the `offered` list that request was built
 *   with — the same guarantee, enforced where it can actually be true.
 */
export const ATTRIBUTION_SCHEMA = {
  type: "object",
  properties: {
    reason: { type: "string", maxLength: REASON_MAX },
    speaker: { type: "string", maxLength: SPEAKER_MAX },
    confidence: { type: "number" },
  },
} as const;

/**
 * ★ AN ORDERED TEST, STOPPING AT THE FIRST THAT FITS. Peer-listed options make
 *   a small model retreat to whichever one the task's own framing primes; an
 *   ordered ladder with the weakest evidence last is what separated them in
 *   entity-review, and the alternation prior is exactly a weakest-evidence rule
 *   that must not outrank a named attribution sitting in the prose.
 *
 * ★ ABSTENTION IS CHEAP AND IT IS LAST. "unsure" costs nothing to say, but it
 *   is named after the three real tests so it cannot absorb a line the prose
 *   already answers.
 *
 * The word budget is a budget in WORDS, measured across chip-picker's seven
 * prompt variants: a small model cannot count characters it has not written.
 */
export const ATTRIBUTION_SYSTEM = `You decide who speaks one line of dialogue in a novel chapter.

You are given the line, the paragraphs immediately before it, the names you may
choose between, and who spoke the last attributed lines. That is all the
evidence there is. Your answer must be one of the names you were given. You may
never name anyone else, and you may never invent a name.

Decide in this order and stop at the first that fits:
1. The line, or the prose around it, NAMES the speaker — "said X", "X asked",
   "X set the cup down and said". A named attribution beats everything below it.
2. The line answers something the previous speaker said, or addresses them by
   name. A reply belongs to the person who was spoken TO, not to the asker.
3. DIALOGUE ALTERNATES. With nothing else to go on, a line between two speakers
   belongs to whoever did NOT speak the line before it.
4. Nothing above fits, or two names fit equally well — answer "unsure". That is
   a real answer, it costs you nothing, and it is better than a coin flip.

Judge only from the evidence in front of you. A name being familiar is not
evidence. The current answer shown to you is an earlier guess, not evidence.
PREFER a low confidence over a guess.

Answer as JSON: {"reason","speaker","confidence"} in that order.
reason: FIRST, one clause of at most 15 words naming the evidence you used.
speaker: a name copied EXACTLY from the list, or "unsure".
confidence: a number from 0 to 1, how much the evidence shows. Never above 1.`;

// ── input ─────────────────────────────────────────────────────────────────

/** One span the engine half-answered. `candidates` is its own ranking. */
export interface AttributionSpan {
  paragraphIndex: number;
  /** Index of the speech segment within its paragraph. */
  spanIndex: number;
  /** The quoted line, verbatim. */
  quote: string;
  /** The engine's current answer. Empty means unattributed, which is not a
   *  tie-break: there is no second option to choose against. */
  speaker: string;
  confidence: number;
  /**
   * The engine's other candidate names, BEST FIRST. The order is the score:
   * a rank is what the engine actually committed to, and printing a number
   * beside a name invites the model to re-rank arithmetic instead of reading.
   */
  candidates?: readonly string[];
}

export interface AttributionReviewInput {
  chapterId: string;
  /** Coarse dedup key of the chapter's prose; part of every cache key. */
  chapterContentHash: string;
  /** Every paragraph of the chapter, in order. Evidence windows come from here. */
  paragraphs: readonly string[];
  /** Every speech span of the chapter, in reading order. */
  spans: readonly AttributionSpan[];
}

// ── selection ─────────────────────────────────────────────────────────────

/** Saturating normaliser: 0 at 0, →1 as x grows, no cliff at the threshold. */
const sat = (x: number, k: number) => (x <= 0 ? 0 : x / (x + k));

const UNSURE_MID = (UNSURE_LO + UNSURE_HI) / 2;
const UNSURE_HALF = (UNSURE_HI - UNSURE_LO) / 2;

/** Is this a span the engine half-answered, rather than one it settled? */
export function inUnsureBand(span: AttributionSpan): boolean {
  return (
    span.speaker.trim() !== "" &&
    span.confidence > UNSURE_LO &&
    span.confidence < UNSURE_HI
  );
}

/**
 * 1.0 at the middle of the unsure band, 0 at either edge.
 *
 * ★ THE MIDDLE OF THE BAND IS THE MOST AMBIGUOUS PLACE, NOT THE BOTTOM. A span
 *   at 0.26 is nearly unattributed and one at 0.77 is nearly attested; both are
 *   closer to an answer than one at 0.51, which is the engine saying it does
 *   not know. Ranking by raw confidence would spend the budget on the spans
 *   that need it least.
 */
export function ambiguityOf(confidence: number): number {
  return Math.max(0, 1 - Math.abs(confidence - UNSURE_MID) / UNSURE_HALF);
}

/** Share of the chapter's attributed spans that this speaker holds, 0…1. */
function speakerShare(context: AttributionReviewInput, speaker: string): number {
  const name = speaker.trim().toLowerCase();
  if (!name) return 0;
  let mine = 0;
  let total = 0;
  for (const span of context.spans) {
    const other = span.speaker.trim().toLowerCase();
    if (!other) continue;
    total++;
    if (other === name) mine++;
  }
  return total === 0 ? 0 : mine / total;
}

/**
 * How much this span moves the chapter, 0…1.
 *
 * Two things make a span matter: a long line carries more of the scene than an
 * interjection, and a speaker who holds more of the chapter poisons more of it
 * when the attribution is wrong — every widget downstream reads speaker.
 */
export function materialWeight(span: AttributionSpan, share: number): number {
  const words = span.quote.trim().split(/\s+/).filter(Boolean).length;
  return 0.55 * sat(words, 12) + 0.45 * Math.max(0, Math.min(1, share));
}

/** Higher runs first. "ambiguity × how much the span moves the chapter." */
export function attributionPriority(
  span: AttributionSpan,
  context: AttributionReviewInput,
): number {
  return ambiguityOf(span.confidence) * materialWeight(span, speakerShare(context, span.speaker));
}

const sameName = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Who spoke the last attributed lines before this span, oldest first.
 *
 * Dialogue alternates, so this is most of the signal for an unattributed line —
 * and it is evidence the model cannot derive from two paragraphs of prose,
 * because the attributions it needs are the ENGINE's, not the page's.
 */
export function recentSpeakers(
  span: AttributionSpan,
  context: AttributionReviewInput,
  limit = 2,
): string[] {
  const before = context.spans.filter(
    (s) =>
      s.speaker.trim() !== "" &&
      (s.paragraphIndex < span.paragraphIndex ||
        (s.paragraphIndex === span.paragraphIndex && s.spanIndex < span.spanIndex)),
  );
  return before.slice(-limit).map((s) => s.speaker.trim());
}

/**
 * The names this span may be answered with. ONE SOURCE OF TRUTH: selection,
 * the prompt and the validator all read this, so an answer can never be
 * checked against a different list than the one the model was shown.
 *
 * ★ THE ALTERNATION FALLBACK ONLY FIRES WHEN THE ENGINE RANKED NOTHING. Where
 *   the engine offered candidates, its ranking IS the option set. Where it
 *   offered none, the previous speakers are the only honest alternatives, and
 *   without them the question degenerates to "confirm your own guess".
 */
export function offeredSpeakers(
  span: AttributionSpan,
  context: AttributionReviewInput,
): string[] {
  const out: string[] = [];
  const push = (name: string | undefined) => {
    const value = name?.trim();
    if (!value || out.length >= ATTRIBUTION_OFFERED_CAP) return;
    if (sameName(value, ATTRIBUTION_UNSURE)) return;
    if (out.some((existing) => sameName(existing, value))) return;
    out.push(value);
  };
  push(span.speaker);
  for (const name of span.candidates ?? []) push(name);
  if (out.length < 2) for (const name of recentSpeakers(span, context, 2)) push(name);
  return out;
}

/**
 * Rank the chapter's tie-breaks and take the budget.
 *
 * A span with fewer than two offered names is not selected at all: there is
 * nothing to choose between, and confirming the engine's own guess writes
 * nothing anywhere. A chapter with no real tie spends nothing, which is the
 * behaviour the cap exists to make possible.
 */
export function selectAttributionCandidates(
  input: AttributionReviewInput,
  cap = ATTRIBUTION_CAP,
): AttributionSpan[] {
  return input.spans
    .map((span, index) => ({ span, index }))
    .filter(({ span }) => inUnsureBand(span) && offeredSpeakers(span, input).length >= 2)
    .map((entry) => ({ ...entry, priority: attributionPriority(entry.span, input) }))
    // Stable within a priority so a rerun of the same chapter asks the same
    // questions in the same order.
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .slice(0, Math.max(0, cap))
    .map((entry) => entry.span);
}

// ── request assembly ──────────────────────────────────────────────────────

export interface AttributionRequest {
  systemPrompt: string;
  userText: string;
  schema: typeof ATTRIBUTION_SCHEMA;
  maxTokens: number;
  /** The names this answer is validated against. Never empty in practice. */
  offered: string[];
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** Cut to whole words, keeping the HEAD. */
function cutHead(text: string, max: number): string {
  const body = collapse(text);
  if (body.length <= max) return body;
  const cut = body.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Cut to whole words, keeping the TAIL.
 *
 * ★ THE END OF A PRECEDING PARAGRAPH IS THE EVIDENCE. "…she put the cup down.
 *   'You knew,' said Marda." — the attribution sits against the quote, so a
 *   head-cut window throws away the only sentence that could answer the
 *   question and keeps the scenery.
 */
function cutTail(text: string, max: number): string {
  const body = collapse(text);
  if (body.length <= max) return body;
  const cut = body.slice(body.length - max);
  const space = cut.indexOf(" ");
  return `…${(space >= 0 && space < max * 0.5 ? cut.slice(space + 1) : cut).trimStart()}`;
}

/**
 * The exact bytes one span sends. Exported for the same reason every other task
 * module exports its builder: the live harness must drive the real prompt, not
 * a copy of it that drifts the moment this file is edited.
 */
export function buildAttributionRequest(
  candidate: AttributionSpan,
  context: AttributionReviewInput,
  maxTokens = DEFAULT_MAX_TOKENS,
): AttributionRequest {
  const offered = offeredSpeakers(candidate, context);
  const start = Math.max(0, candidate.paragraphIndex - CONTEXT_PARAGRAPHS);
  const before = context.paragraphs
    .slice(start, candidate.paragraphIndex)
    .map((text, i) => `  ¶${start + i}  ${cutTail(text, PARAGRAPH_MAX)}`);
  const recent = recentSpeakers(candidate, context, 2);
  const recentLines =
    recent.length === 0
      ? ["  (no attributed line before this one)"]
      : recent
          .slice()
          .reverse()
          .map((name, i) => `  ${i === 0 ? "one line back" : "two lines back"}: ${name}`);

  const userText = [
    `PARAGRAPH ${candidate.paragraphIndex}, LINE ${candidate.spanIndex}`,
    "",
    "PROSE IMMEDIATELY BEFORE",
    ...(before.length > 0 ? before : ["  (this is the first paragraph of the chapter)"]),
    "",
    "THE LINE",
    `  ${cutHead(candidate.quote, QUOTE_MAX)}`,
    "",
    // ★ ALTERNATION IS EVIDENCE THE PROSE DOES NOT CARRY. These attributions
    //   are the engine's, resolved over the whole chapter; two paragraphs of
    //   window cannot show them.
    "WHO SPOKE THE LINES BEFORE IT (dialogue alternates)",
    ...recentLines,
    "",
    "THE NAMES YOU MAY CHOOSE BETWEEN",
    ...offered.map(
      (name, i) => `  - ${name}${i === 0 ? "   (the current answer — an earlier guess)" : ""}`,
    ),
    `  - ${ATTRIBUTION_UNSURE}   (say this whenever the evidence does not single out one name)`,
    "",
    "Who speaks the line?",
  ].join("\n");

  return {
    systemPrompt: ATTRIBUTION_SYSTEM,
    userText,
    schema: ATTRIBUTION_SCHEMA,
    maxTokens,
    offered,
  };
}

// ── validation ────────────────────────────────────────────────────────────

export interface AttributionAnswer {
  speaker: string;
  confidence: number;
  reason: string;
}

/**
 * Resolve what the model wrote to a name it was actually offered.
 *
 * Exact match first (case- and whitespace-insensitive). Failing that, ONE
 * unique offered name containing the answer as a whole word — "Marda" for
 * "Marda Kelp" is the model shortening, not inventing. Two offered names
 * sharing that word resolve to nothing rather than to a guess.
 */
export function resolveOfferedSpeaker(
  value: string,
  offered: readonly string[],
): string | null {
  const wanted = collapse(value).toLowerCase();
  if (!wanted) return null;
  const exact = offered.find((name) => collapse(name).toLowerCase() === wanted);
  if (exact) return exact;
  const parts = offered.filter((name) =>
    collapse(name)
      .toLowerCase()
      .split(/\s+/)
      .includes(wanted),
  );
  return parts.length === 1 ? parts[0] : null;
}

/**
 * Mechanical checks only.
 *
 * Returns null — the span keeps the engine's own answer — when the shape is
 * unusable, when the name was not offered, when the model abstained, or when
 * the confidence is below the floor. Every one of those is a correct outcome:
 * the deterministic attribution already stands, and nothing here needs to
 * replace it with a worse guess.
 */
export function normalizeAttribution(
  raw: unknown,
  offered: readonly string[],
): AttributionAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  const speakerRaw = value.speaker;
  if (typeof speakerRaw !== "string") return null;
  // Abstention: a real answer, and the caller stores nothing for it.
  if (collapse(speakerRaw).toLowerCase() === ATTRIBUTION_UNSURE) return null;
  const speaker = resolveOfferedSpeaker(speakerRaw, offered);
  if (!speaker) return null;

  const confidenceRaw = value.confidence;
  if (typeof confidenceRaw !== "number" || !Number.isFinite(confidenceRaw)) return null;
  const confidence = Math.min(1, Math.max(0, confidenceRaw));
  if (confidence < ATTRIBUTION_MIN_CONFIDENCE) return null;

  const reasonRaw = value.reason;
  if (typeof reasonRaw !== "string") return null;
  const reason = tidyTruncatedText(collapse(reasonRaw).slice(0, REASON_MAX), REASON_MAX);
  // A silent answer is an unexplainable correction: the writer would have no
  // way to judge it, so it is not made.
  if (!reason) return null;

  return { speaker, confidence, reason };
}

// ── cache key ─────────────────────────────────────────────────────────────

/**
 * Cache key. `fnv1a` is shared with evidence-pack so the recipe lives once.
 *
 * ★ `offered` IS OPTIONAL AND WORTH PASSING. `chapterContentHash` is a coarse
 *   dedup key over the PROSE, so a change in world data or in the engine's
 *   candidate ranking re-points the question while leaving the hash identical —
 *   the drift chip-picker's event fingerprint exists to catch. Folding the
 *   offered names in invalidates exactly the spans whose options moved.
 */
export function attributionKeyFor(
  chapterContentHash: string,
  paragraphIndex: number,
  spanIndex: number,
  modelId: string,
  offered: readonly string[] = [],
): string {
  return fnv1a(
    `${chapterContentHash}|${paragraphIndex}:${spanIndex}|${offered.join(",")}|${modelId}|v${ATTRIBUTION_PROMPT_VERSION}`,
  );
}

// ── one span ──────────────────────────────────────────────────────────────

export interface AttributionReviewOptions {
  run: AssistantJSONRunner;
  /** From `assistantStatus().model.id`; part of the cache key. */
  modelId: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface AttributionReviewResult {
  paragraphIndex: number;
  spanIndex: number;
  /** What the engine had before this review, so a caller can tell a
   *  confirmation from an overturn without re-deriving it. */
  previousSpeaker: string;
  speaker: string;
  confidence: number;
  reason: string;
  key: string;
}

/**
 * Ask about one span. Null on anything that is not a usable answer above the
 * floor — the span keeps the engine's attribution, which is the whole design:
 * this task can only improve an answer, never remove one.
 */
export async function runAttributionReview(
  candidate: AttributionSpan,
  context: AttributionReviewInput,
  opts: AttributionReviewOptions,
): Promise<AttributionReviewResult | null> {
  const request = buildAttributionRequest(candidate, context, opts.maxTokens ?? DEFAULT_MAX_TOKENS);
  if (request.offered.length < 2) return null;

  const result = await opts.run<unknown>({
    task: ATTRIBUTION_TASK,
    tag: `${context.chapterId}:${candidate.paragraphIndex}:${candidate.spanIndex}`,
    systemPrompt: request.systemPrompt,
    userText: request.userText,
    schema: request.schema,
    maxTokens: request.maxTokens,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!result.ok) return null;

  const answer = normalizeAttribution(result.json, request.offered);
  if (!answer) return null;

  return {
    paragraphIndex: candidate.paragraphIndex,
    spanIndex: candidate.spanIndex,
    previousSpeaker: candidate.speaker,
    ...answer,
    key: attributionKeyFor(
      context.chapterContentHash,
      candidate.paragraphIndex,
      candidate.spanIndex,
      opts.modelId,
      request.offered,
    ),
  };
}
