/**
 * chekhov-review.ts — is this thing a promise, or is it furniture?
 *
 * `findChekhovCandidates` in continuity.ts is a regex over definite-article
 * noun phrases that never recur. It cannot tell a loaded gun from a curtain,
 * and it surfaces both: 4.88 candidates per chapter measured over 73 DEV
 * chapters (scripts/probe-assist-funnels.ts). That is a list a writer stops
 * opening, not a finding.
 *
 * ★★ THE HONEST MAJORITY ANSWER IS "FURNITURE", AND THE PROMPT SAYS SO. Most
 *    specific nouns in good prose are scenery: a room is described with real
 *    things and they are never mentioned again because they were never
 *    promises. A task that makes "promise" the easy answer would relabel the
 *    curtain and hand the writer a list of chores. This is the opposite of a
 *    catch-all problem — the majority class is the one the model must find
 *    cheap to say, and it is stated as the expected answer, not as a last
 *    resort.
 *
 * ★ ONLY `promise` AT ≥ THE FLOOR IS A FINDING. Everything else renders
 *   nothing at all, and the deterministic list stays exactly as it is today for
 *   anyone who opens it. `isSurfacedChekhov` is that rule, in code.
 *
 * ★ A "furniture" VERDICT IS AN ANSWER AND IS WORTH STORING. `normalizeChekhov`
 *   keeps it rather than returning null, so the caller caches it under the key
 *   and the question is asked once per phrase, not once per render. The
 *   confidence floor belongs to SURFACING, not to validity.
 */
import { fnv1a } from "./evidence-pack";
import { tidyTruncatedText } from "./assistant-client";
import type { AssistantJSONRunner } from "./assistant-client";

export const CHEKHOV_TASK = "chekhov-review";
/** Bump on ANY change to the prompt text or the schema. Invalidates stored verdicts. */
export const CHEKHOV_PROMPT_VERSION = 1;

/** Per-chapter budget. Two questions, ranked; the rest of the list is silent. */
export const CHEKHOV_CAP = 2;
/** A promise below this surfaces nothing. */
export const CHEKHOV_MIN_CONFIDENCE = 0.7;

export type ChekhovVerdict = "promise" | "furniture" | "unsure";

/** Wire order is the schema's declaration order; see the ★ on the enum. */
export const CHEKHOV_VERDICTS: readonly ChekhovVerdict[] = ["promise", "furniture", "unsure"];

const SENTENCE_MAX = 320;
const REASON_MAX = 120;

const DEFAULT_MAX_TOKENS = 128;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * ★★ REASON FIRST. A grammar emits properties in declaration order; with the
 *    verdict first the model commits before it has written a word of evidence,
 *    which is how entity-review got labels contradicting their own reasons.
 *    Do not reorder these.
 *
 * ★ "unsure" IS LAST IN THE ENUM. It is the abstention, not a third reading,
 *   and a small model reaches for whatever sits first when the discriminators
 *   get crowded.
 */
export const CHEKHOV_SCHEMA = {
  type: "object",
  properties: {
    reason: { type: "string", maxLength: REASON_MAX },
    verdict: { enum: ["promise", "furniture", "unsure"] },
    confidence: { type: "number" },
  },
} as const;

export const CHEKHOV_SYSTEM = `A tool has flagged a thing that a novel names once and never mentions again.
You say whether the story PROMISED anything with it.

You are given the phrase, the sentence that introduces it, the chapter it
appeared in, and how many chapters have passed since.

Most of these are furniture, and furniture is the answer you should expect to
give. A novel describes a room with real things in it — a chipped bowl, a
folded coat, a lamp with a cracked shade — and never mentions them again
because they were never promises. They were the room. Saying "furniture" is
doing the job, not giving up on it.

A thing is a "promise" only when the sentence makes the story owe the reader
something about it. That means one of:
- someone hides it, locks it away, is warned about it, or is told not to touch it
- it is loaded, sharpened, poisoned, sealed, addressed to someone, or otherwise
  made ready for a use that has not happened yet
- the prose stops to tell you it matters — someone stares at it, keeps it,
  cannot stop thinking about it, or is changed by seeing it

Being vivid is not a promise. Being specific is not a promise. Being described
at length is not a promise. If the sentence only puts the thing in the world,
it is furniture.

Answer "unsure" when the sentence genuinely could be read either way. It costs
nothing and it is better than a guess.

Answer as JSON: {"reason","verdict","confidence"} in that order.
reason: FIRST, one clause of at most 15 words quoting what the sentence does.
verdict: promise, furniture, or unsure.
confidence: a number from 0 to 1, how much the sentence shows. Never above 1.`;

// ── input & selection ─────────────────────────────────────────────────────

export interface ChekhovReviewCandidate {
  /** The noun phrase, e.g. "rusted pistol". */
  phrase: string;
  /** Mentions in the chapter that introduced it. */
  mentions: number;
  /** The sentence that introduces it, verbatim. The whole evidence budget. */
  sentence: string;
  /** The chapter number it was introduced in. */
  chapterNumber: number;
  /** Chapters between its introduction and where the writer is now. */
  chaptersSince: number;
}

/**
 * Rank the chapter's candidates and take the budget.
 *
 * ★ MENTIONS FIRST, THEN EARLIEST INTRODUCTION. A phrase the chapter returns to
 *   twice is a thing the prose is already weighting; among equals, the one
 *   introduced earliest has had the longest to pay off and never did, which is
 *   what makes an unpaid promise worth naming at all.
 *
 * A candidate with no introducing sentence is dropped rather than asked about:
 * the whole answer is grounded in that sentence, and without one the question
 * is an invitation to invent.
 */
export function selectChekhovCandidates(
  candidates: readonly ChekhovReviewCandidate[],
  cap = CHEKHOV_CAP,
): ChekhovReviewCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(
      ({ candidate }) =>
        candidate.phrase.trim() !== "" && candidate.sentence.trim() !== "",
    )
    .sort(
      (a, b) =>
        b.candidate.mentions - a.candidate.mentions ||
        a.candidate.chapterNumber - b.candidate.chapterNumber ||
        a.index - b.index,
    )
    .slice(0, Math.max(0, cap))
    .map((entry) => entry.candidate);
}

// ── request assembly ──────────────────────────────────────────────────────

export interface ChekhovRequest {
  systemPrompt: string;
  userText: string;
  schema: typeof CHEKHOV_SCHEMA;
  maxTokens: number;
  /** The verdicts this answer is validated against. */
  offered: readonly ChekhovVerdict[];
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

function cutHead(text: string, max: number): string {
  const body = collapse(text);
  if (body.length <= max) return body;
  const cut = body.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The exact bytes one phrase sends; the live harness drives this, not a copy. */
export function buildChekhovRequest(
  candidate: ChekhovReviewCandidate,
  maxTokens = DEFAULT_MAX_TOKENS,
): ChekhovRequest {
  const since = Math.max(0, Math.round(candidate.chaptersSince));
  const userText = [
    `THE THING: ${collapse(candidate.phrase)}`,
    `INTRODUCED IN: chapter ${candidate.chapterNumber}`,
    `MENTIONED: ${candidate.mentions} time${candidate.mentions === 1 ? "" : "s"} in that chapter, never again`,
    `CHAPTERS SINCE: ${since}`,
    "",
    "THE SENTENCE THAT INTRODUCES IT",
    `  ${cutHead(candidate.sentence, SENTENCE_MAX)}`,
    "",
    "Does that sentence promise the reader something about this thing?",
  ].join("\n");

  return {
    systemPrompt: CHEKHOV_SYSTEM,
    userText,
    schema: CHEKHOV_SCHEMA,
    maxTokens,
    offered: CHEKHOV_VERDICTS,
  };
}

// ── validation ────────────────────────────────────────────────────────────

export interface ChekhovAnswer {
  verdict: ChekhovVerdict;
  confidence: number;
  reason: string;
}

/**
 * Mechanical checks only. Null when the answer is not usable at all — a shape
 * that is not an object, a verdict outside the three, a missing confidence, an
 * empty reason. A verdict of "furniture" or "unsure" is a USABLE answer and
 * comes back intact; see the header ★ on why it is worth storing.
 */
export function normalizeChekhov(raw: unknown): ChekhovAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  const verdictRaw = value.verdict;
  if (typeof verdictRaw !== "string") return null;
  const wire = collapse(verdictRaw).toLowerCase();
  const verdict = CHEKHOV_VERDICTS.find((v) => v === wire);
  if (!verdict) return null;

  const confidenceRaw = value.confidence;
  if (typeof confidenceRaw !== "number" || !Number.isFinite(confidenceRaw)) return null;

  const reasonRaw = value.reason;
  if (typeof reasonRaw !== "string") return null;
  const reason = tidyTruncatedText(collapse(reasonRaw).slice(0, REASON_MAX), REASON_MAX);
  if (!reason) return null;

  return {
    verdict,
    confidence: Math.min(1, Math.max(0, confidenceRaw)),
    reason,
  };
}

/**
 * Does this answer render anything at all?
 *
 * ★ THE FLOOR IS RE-CHECKED HERE RATHER THAN TRUSTED FROM UPSTREAM. This is the
 *   single predicate every consumer must go through, so it states the whole
 *   rule by itself: promise, and confident. Nothing else surfaces.
 */
export function isSurfacedChekhov(result: ChekhovAnswer | null | undefined): boolean {
  return (
    !!result && result.verdict === "promise" && result.confidence >= CHEKHOV_MIN_CONFIDENCE
  );
}

// ── cache key ─────────────────────────────────────────────────────────────

/**
 * Cache key. `fnv1a` is shared with evidence-pack so the recipe lives once.
 *
 * ★ `chaptersSince` IS DELIBERATELY NOT IN THE KEY. It changes every time the
 *   writer opens a different chapter, and whether a sentence promised something
 *   does not. Folding it in would re-ask the same question of the same sentence
 *   for the whole length of the book.
 */
export function chekhovKeyFor(
  chapterContentHash: string,
  phrase: string,
  modelId: string,
): string {
  return fnv1a(
    `${chapterContentHash}|${collapse(phrase).toLowerCase()}|${modelId}|v${CHEKHOV_PROMPT_VERSION}`,
  );
}

// ── one phrase ────────────────────────────────────────────────────────────

export interface ChekhovReviewOptions {
  run: AssistantJSONRunner;
  /** From `assistantStatus().model.id`; part of the cache key. */
  modelId: string;
  /** The chapter the phrase was introduced in; part of the cache key. */
  chapterContentHash: string;
  chapterId?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ChekhovReviewResult extends ChekhovAnswer {
  phrase: string;
  /** True only for a confident `promise` — the one case that renders. */
  surfaced: boolean;
  key: string;
}

/**
 * Ask about one phrase. Null only when there is no usable answer; a
 * "furniture" verdict comes back with `surfaced: false` so the caller can
 * store it and never ask again.
 */
export async function runChekhovReview(
  candidate: ChekhovReviewCandidate,
  opts: ChekhovReviewOptions,
): Promise<ChekhovReviewResult | null> {
  if (candidate.sentence.trim() === "" || candidate.phrase.trim() === "") return null;
  const request = buildChekhovRequest(candidate, opts.maxTokens ?? DEFAULT_MAX_TOKENS);

  const result = await opts.run<unknown>({
    task: CHEKHOV_TASK,
    tag: `${opts.chapterId ?? `ch-${candidate.chapterNumber}`}:${candidate.phrase}`,
    systemPrompt: request.systemPrompt,
    userText: request.userText,
    schema: request.schema,
    maxTokens: request.maxTokens,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!result.ok) return null;

  const answer = normalizeChekhov(result.json);
  if (!answer) return null;

  return {
    phrase: candidate.phrase,
    ...answer,
    surfaced: isSurfacedChekhov(answer),
    key: chekhovKeyFor(opts.chapterContentHash, candidate.phrase, opts.modelId),
  };
}
