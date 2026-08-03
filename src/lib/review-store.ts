/**
 * review-store.ts — persistence for the wave-2 review answers (attribution
 * tie-breaks, scene near-misses, Chekhov promises), plus the selectors every
 * display consumer must read them through.
 *
 * Shapes and contract come from plans/assistant-adjudication-wave-2.md.
 * Storage mirrors knowledge-store.ts exactly: desktop → one JSON file via
 * project state; browser → localStorage.
 *
 * ★★ THE MODEL'S ATTRIBUTION ANSWER IS A SUGGESTION, NOT A CORRECTION, AND
 *    THAT IS A DELIBERATE DEPARTURE FROM THE SPEC I WROTE. §3.1 said the
 *    verdict lands "AnnotationCorrection-shaped, via the existing adaptive
 *    path". Reading that path settles the question against it: a correction
 *    written there goes into the writer's exported annotation corpus AND runs
 *    `applyOnlineAdaptiveUpdate`, which trains the ranker immediately. Feeding
 *    the ranker its own engine's uncertain spans, relabelled by a model, on a
 *    floor that is the MODEL'S SELF-REPORTED confidence and not a calibrated
 *    one, is a self-training loop with no human in it — and it would quietly
 *    mix model guesses into the corpus the writer exports as ground truth.
 *    So the answer is offered in the annotation popover and reaches
 *    `correctedLabel` only when the writer confirms it. The model pays the
 *    cost of the decision; it does not get to make it.
 *
 * ★ ONE STORE, KEYED BY THE TASKS' OWN CACHE KEYS. `asked` is membership, not
 *   payload: a question whose answer was unusable (abstention, sub-floor,
 *   malformed) is still ASKED, and without recording that a null answer would
 *   be re-asked on every mount for the life of the chapter.
 *
 * ★ STALENESS BY RECONSTRUCTION, WITH ONE EXTRA GUARD. A chapter entry whose
 *   `contentHash` or `modelId` no longer matches is dropped whole, which is the
 *   spec's "any edit to a chapter drops its pending work". But
 *   `knowledgeContentHash` is `length|first-60-chars`: a length-preserving edit
 *   in the middle of a chapter leaves it BYTE-IDENTICAL. Every selector here
 *   therefore re-checks the answer against live text — the same guard the
 *   knowledge sweep uses when it will only land a verdict on a candidate whose
 *   sentence is still the one that was judged.
 */
import { isDesktopApp, saveProjectState, loadProjectState } from "./project-manager";
import { CHEKHOV_MIN_CONFIDENCE } from "./chekhov-review";
import type { ChekhovVerdict } from "./chekhov-review";

const KEY = "glass-editor:assist-reviews-v1";

// ── Answers ───────────────────────────────────────────────────────────────

export interface AttributionSuggestion {
  paragraphIndex: number;
  spanIndex: number;
  /**
   * The span text as judged.
   *
   * ★ THE ONLY THING THAT PINS THIS ANSWER TO A LINE. Index alone does not: a
   *   writer can rewrite one line of dialogue without changing the chapter's
   *   length, which leaves the content hash identical and the paragraph and
   *   span indices valid, and the stale suggestion would then be offered
   *   against prose it never read.
   */
  quote: string;
  /** What the engine had. Lets a consumer tell a confirmation from an overturn. */
  previousSpeaker: string;
  speaker: string;
  confidence: number;
  reason: string;
}

export interface SceneLabelSuggestion {
  /** Index of the scene within the chapter, in reading order. */
  sceneIndex: number;
  label: string;
  confidence: number;
  reason: string;
  /**
   * The shortlist this answer chose from. A re-tuned gate or threshold in
   * scene-function.ts re-points the shortlist while leaving the prose (and so
   * the content hash) byte-identical; an answer naming a reading that is no
   * longer offered is not shown.
   */
  offered: string[];
}

export interface ChekhovVerdictRecord {
  phrase: string;
  verdict: ChekhovVerdict;
  confidence: number;
  reason: string;
}

export interface ChapterReviews {
  chapterId: string;
  /** `knowledgeContentHash(content)` when these answers were reached. */
  contentHash: string;
  /** The model that answered. A swap invalidates the lot. */
  modelId: string;
  updated: number;
  attribution: Record<string, AttributionSuggestion>;
  scenes: Record<string, SceneLabelSuggestion>;
  chekhov: Record<string, ChekhovVerdictRecord>;
  /**
   * Every cache key asked, answered or not. Capped by construction: three
   * attribution + three scene + two Chekhov questions per chapter per hash.
   */
  asked: string[];
}

export interface AssistReviewStore {
  version: 1;
  chapters: Record<string, ChapterReviews>;
}

export type ReviewKind = "attribution" | "scene" | "chekhov";

// ── Storage (annotation-store contract) ───────────────────────────────────

export function emptyReviewStore(): AssistReviewStore {
  return { version: 1, chapters: {} };
}

function valid(store: AssistReviewStore | null | undefined): store is AssistReviewStore {
  return !!store && store.version === 1 && !!store.chapters;
}

export function loadReviewStore(): AssistReviewStore {
  if (isDesktopApp()) return emptyReviewStore();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyReviewStore();
    const parsed = JSON.parse(raw) as AssistReviewStore;
    return valid(parsed) ? parsed : emptyReviewStore();
  } catch {
    return emptyReviewStore();
  }
}

export async function loadReviewStoreFromProject(): Promise<AssistReviewStore | null> {
  const data = await loadProjectState<AssistReviewStore>("assist-reviews");
  return valid(data) ? data : null;
}

export function saveReviewStore(store: AssistReviewStore): void {
  if (isDesktopApp()) { saveProjectState("assist-reviews", store); return; }
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* quota — silently ignore */
  }
}

// ── Reading ───────────────────────────────────────────────────────────────

function emptyChapter(chapterId: string, contentHash: string, modelId: string): ChapterReviews {
  return {
    chapterId, contentHash, modelId,
    updated: 0,
    attribution: {}, scenes: {}, chekhov: {}, asked: [],
  };
}

/**
 * The chapter's answers, or an empty entry when they are stale.
 *
 * ★ NEVER RETURNS NULL. A caller that has to branch on "no entry yet" versus
 *   "entry from a different model" writes the staleness rule a second time, and
 *   the second copy is the one that drifts. Stale reads as empty, which is what
 *   it means: nothing here has been asked about this text with this model.
 */
export function chapterReviews(
  store: AssistReviewStore,
  chapterId: string,
  contentHash: string,
  modelId: string,
): ChapterReviews {
  const entry = store.chapters[chapterId];
  if (!entry || entry.contentHash !== contentHash || entry.modelId !== modelId) {
    return emptyChapter(chapterId, contentHash, modelId);
  }
  return entry;
}

/** Has this exact question already been put to this exact model? */
export function alreadyAsked(entry: ChapterReviews, key: string): boolean {
  return entry.asked.includes(key);
}

// ── Writing ───────────────────────────────────────────────────────────────

type Answer =
  | { kind: "attribution"; value: AttributionSuggestion }
  | { kind: "scene"; value: SceneLabelSuggestion }
  | { kind: "chekhov"; value: ChekhovVerdictRecord };

/**
 * Record one answer, or the fact that a question was asked and produced
 * nothing usable (`answer` = null).
 *
 * Writing against a different `contentHash` or `modelId` REPLACES the chapter's
 * entry rather than merging into it: answers reached against prose that no
 * longer exists are not partially-valid, they are wrong.
 */
export function recordReviewAnswer(
  store: AssistReviewStore,
  chapterId: string,
  contentHash: string,
  modelId: string,
  key: string,
  answer: Answer | null,
  now: number,
): AssistReviewStore {
  const base = chapterReviews(store, chapterId, contentHash, modelId);
  const entry: ChapterReviews = {
    ...base,
    contentHash,
    modelId,
    updated: now,
    asked: base.asked.includes(key) ? base.asked : [...base.asked, key],
  };
  if (answer?.kind === "attribution") entry.attribution = { ...entry.attribution, [key]: answer.value };
  if (answer?.kind === "scene") entry.scenes = { ...entry.scenes, [key]: answer.value };
  if (answer?.kind === "chekhov") entry.chekhov = { ...entry.chekhov, [key]: answer.value };
  return { ...store, chapters: { ...store.chapters, [chapterId]: entry } };
}

/** Drop entries for chapters that no longer exist. Deleting a chapter is not
 *  a reason to keep answering questions about it. */
export function pruneReviewStore(
  store: AssistReviewStore,
  liveChapterIds: readonly string[],
): AssistReviewStore {
  const live = new Set(liveChapterIds);
  const ids = Object.keys(store.chapters);
  if (ids.every((id) => live.has(id))) return store;
  const chapters: Record<string, ChapterReviews> = {};
  for (const id of ids) if (live.has(id)) chapters[id] = store.chapters[id];
  return { ...store, chapters };
}

// ── The display selectors ─────────────────────────────────────────────────
//
// ★ ONE SELECTOR PER SURFACE, AND NO CONSUMER MAY RE-IMPLEMENT ITS CONDITIONS.
//   The same rule the knowledge ledger earned: what the widget shows and what
//   the harness measures have to be the same function, or a gate proves
//   something the writer never sees.

/**
 * ★★ THE SAME LINE HAS TWO SPELLINGS IN THIS CODEBASE, AND COMPARING THEM RAW
 *    MATCHES NEVER. The engine's prediction trace records a quote's CONTENT
 *    (`text.slice(pair.start + 1, pair.end)` in speech-detect) — no quote marks.
 *    The editor's annotation target records the whole SEGMENT
 *    (`para.slice(seg.start, seg.end)` in HighlightLayer) — marks included. A
 *    suggestion is stored under the first spelling and looked up under the
 *    second, so a `===` guard here is not a strict check, it is an off switch:
 *    every suggestion silently resolves to null and the feature renders nothing
 *    with no error anywhere. Both sides go through this.
 */
const QUOTE_EDGES = /^[\s"'“”‘’«»—-]+|[\s"'“”‘’«»]+$/g;
export function normalizeSpanText(text: string): string {
  return text.replace(/\s+/g, " ").replace(QUOTE_EDGES, "").trim();
}

/**
 * The suggestion for one span, or null.
 *
 * Null whenever the live span text is not the text that was judged — see the
 * ★ on `AttributionSuggestion.quote` — and whenever the model merely agreed
 * with the engine, which is not something to show anyone.
 */
export function attributionSuggestionFor(
  entry: ChapterReviews,
  paragraphIndex: number,
  spanIndex: number,
  liveQuote: string,
): AttributionSuggestion | null {
  const live = normalizeSpanText(liveQuote);
  for (const value of Object.values(entry.attribution)) {
    if (value.paragraphIndex !== paragraphIndex || value.spanIndex !== spanIndex) continue;
    if (normalizeSpanText(value.quote) !== live) return null;
    // A confirmation is not a finding. The engine already says this name.
    if (value.speaker.trim().toLowerCase() === value.previousSpeaker.trim().toLowerCase()) return null;
    return value;
  }
  return null;
}

/**
 * Model-sourced scene labels, keyed by the paragraph the scene starts at.
 *
 * `liveOffered` is the shortlist the engine produces for that scene RIGHT NOW;
 * an answer whose shortlist has moved is dropped rather than shown against a
 * question that is no longer the one that was asked.
 */
export function sceneLabelOverlay(
  entry: ChapterReviews,
  sceneStartParagraphs: readonly number[],
  liveOffered: (sceneIndex: number) => readonly string[],
): Map<number, SceneLabelSuggestion> {
  const out = new Map<number, SceneLabelSuggestion>();
  for (const value of Object.values(entry.scenes)) {
    const start = sceneStartParagraphs[value.sceneIndex];
    if (start === undefined) continue;
    const now = liveOffered(value.sceneIndex);
    if (now.length !== value.offered.length) continue;
    if (!value.offered.every((label, i) => label === now[i])) continue;
    out.set(start, value);
  }
  return out;
}

/**
 * The phrases the model confirmed as real promises, lowercased.
 *
 * ★ CONFIRMATION ONLY, NEVER SUPPRESSION. §3.2: "everything else renders
 *   nothing, and the deterministic list stays exactly as it is today". A
 *   "furniture" verdict is worth storing so the question is asked once, but it
 *   must not delete a candidate from the writer's list — the regex found it,
 *   the writer can see it, and a small model is not the authority that removes
 *   something from view.
 */
export function confirmedPromises(entry: ChapterReviews): Set<string> {
  const out = new Set<string>();
  for (const value of Object.values(entry.chekhov)) {
    if (value.verdict === "promise" && value.confidence >= CHEKHOV_MIN_CONFIDENCE) {
      out.add(value.phrase.trim().toLowerCase());
    }
  }
  return out;
}
