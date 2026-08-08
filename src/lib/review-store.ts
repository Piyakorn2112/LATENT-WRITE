/**
 * review-store.ts — persistence for the wave-2 review answers (attribution
 * tie-breaks, scene near-misses, Chekhov promises), plus the selectors every
 * display consumer must read them through.
 *
 * Shapes and contract come from plans/assistant-adjudication-wave-2.md.
 * Storage mirrors knowledge-store.ts exactly: desktop → one JSON file via
 * project state; browser → localStorage.
 *
 * ★★ THERE IS NO ATTRIBUTION HERE, AND ITS ABSENCE IS THE MEASUREMENT. The
 *    spec's third task wrote a speaker back into the app. Two objections
 *    settled it, in order. The design one: the path it was to write through
 *    feeds the writer's EXPORTED annotation corpus and runs
 *    `applyOnlineAdaptiveUpdate`, so an auto-applied verdict is a self-training
 *    loop with no human in it, gated on a model's self-reported confidence.
 *    That was answerable — offer it in the popover, let the writer confirm. The
 *    measurement was not: scripts/probe-attribution-anchor.cjs scored the real
 *    model 3-of-5 WRONG AND CONFIDENT on prose that answers unambiguously. A
 *    suggestion wrong three times in five, carrying a fluent reason, costs the
 *    writer more attention than it saves. See assist-sweep.ts.
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
import { saveProjectState, loadProjectState, stateTarget } from "./project-manager";
import { CHEKHOV_MIN_CONFIDENCE } from "./chekhov-review";
import type { ChekhovVerdict } from "./chekhov-review";
import type { PresenceVerdict } from "./presence-review";

const KEY = "glass-editor:assist-reviews-v1";

// ── Answers ───────────────────────────────────────────────────────────────

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

export interface PresenceVerdictRecord {
  name: string;
  verdict: PresenceVerdict;
  confidence: number;
  reason: string;
  /** The class this imposes, or null when the engine's own call stands. */
  applied: "present" | "mentioned" | null;
}

export interface ChapterReviews {
  chapterId: string;
  /** `knowledgeContentHash(content)` when these answers were reached. */
  contentHash: string;
  /** The model that answered. A swap invalidates the lot. */
  modelId: string;
  updated: number;
  scenes: Record<string, SceneLabelSuggestion>;
  chekhov: Record<string, ChekhovVerdictRecord>;
  /** Optional: entries written before the presence task existed have none, and
   *  every reader must treat that as "nothing was asked", not as "nothing is
   *  present". */
  presence?: Record<string, PresenceVerdictRecord>;
  /**
   * Every cache key asked, answered or not. Capped by construction: three
   * scene + two Chekhov + three presence questions per chapter per hash.
   */
  asked: string[];
}

export interface AssistReviewStore {
  version: 1;
  chapters: Record<string, ChapterReviews>;
}

export type ReviewKind = "scene" | "chekhov" | "presence";

// ── Storage (annotation-store contract) ───────────────────────────────────

export function emptyReviewStore(): AssistReviewStore {
  return { version: 1, chapters: {} };
}

function valid(store: AssistReviewStore | null | undefined): store is AssistReviewStore {
  return !!store && store.version === 1 && !!store.chapters;
}

export function loadReviewStore(): AssistReviewStore {
  if (stateTarget() === "project") return emptyReviewStore();
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
  if (stateTarget() === "project") { void saveProjectState("assist-reviews", store); return; }
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
    scenes: {}, chekhov: {}, asked: [],
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
  | { kind: "scene"; value: SceneLabelSuggestion }
  | { kind: "chekhov"; value: ChekhovVerdictRecord }
  | { kind: "presence"; value: PresenceVerdictRecord };

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
  if (answer?.kind === "scene") entry.scenes = { ...entry.scenes, [key]: answer.value };
  if (answer?.kind === "chekhov") entry.chekhov = { ...entry.chekhov, [key]: answer.value };
  if (answer?.kind === "presence") entry.presence = { ...(entry.presence ?? {}), [key]: answer.value };
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
/**
 * Presence classes the model settled, keyed by canonical character name.
 *
 * ★ ONLY THE MARKS THE ENGINE DEFERRED CAN BE HERE AT ALL — assist-sweep only
 *   asks about `uncertain` ones — so this can never overturn a call the engine
 *   made confidently. `applied` is null for every below-floor answer, which is
 *   most of them: the measurement showed the model's confidence does not
 *   separate right from wrong, so the floor is a conservative gate and what it
 *   costs is declined answers. Declining is free here and only here, because
 *   the engine already holds a call for every one of them.
 */
export function presenceOverrides(entry: ChapterReviews): Map<string, "present" | "mentioned"> {
  const out = new Map<string, "present" | "mentioned">();
  for (const value of Object.values(entry.presence ?? {})) {
    if (!value.applied) continue;
    out.set(value.name.trim().toLowerCase(), value.applied);
  }
  return out;
}

export function confirmedPromises(entry: ChapterReviews): Set<string> {
  const out = new Set<string>();
  for (const value of Object.values(entry.chekhov)) {
    if (value.verdict === "promise" && value.confidence >= CHEKHOV_MIN_CONFIDENCE) {
      out.add(value.phrase.trim().toLowerCase());
    }
  }
  return out;
}
