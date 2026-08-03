/**
 * assist-sweep.ts — one sweep, three tasks, a fixed order and a hard budget.
 *
 * The wave-2 spec (plans/assistant-adjudication-wave-2.md §4) asks for ONE
 * background pass rather than three competing ones, because three schedulers
 * against a single-slot inference host is three queues fighting for the same
 * lock. This module is that pass, plus the adapters that turn a live chapter
 * analysis into the candidates each task module expects.
 *
 * ★★ THE ORDER IS THE PRIORITY: attribution → scene → Chekhov. Attribution
 *    feeds everything downstream — cast, voice, timeline, character arcs all
 *    read `speaker` — so a wrong speaker poisons widgets that scene labels and
 *    Chekhov verdicts never touch. If the budget runs out, it runs out on the
 *    cheapest question, not the most consequential one.
 *
 * ★★ RANK AND CAP, DO NOT SWEEP. Eight questions per chapter, ~5s of idle
 *    work, bounded whatever the prose does. Measured over 73 DEV chapters, an
 *    uncapped attribution pass alone would be 43.62 questions per chapter —
 *    26 seconds of continuous inference for a queue an edit invalidates before
 *    it drains. See scripts/probe-assist-funnels.ts, which is the measurement
 *    the caps come from and the way to check they still fit.
 *
 * ★ THE SWEEP IS SCOPED TO THE CHAPTER THE WRITER IS IN, WHICH NARROWS THE
 *   SPEC. §4 says it "moves to the next chapter only when the current one is
 *   settled". Two of the three tasks need a full chapter analysis — scene
 *   near-misses come from grouped scenes, attribution ties from the engine's
 *   own posteriors — and that analysis exists for the ACTIVE chapter only.
 *   Sweeping the book would mean re-analysing every chapter in the worker
 *   first, which is what the ledger backfill already does at one chapter per
 *   idle tick for a much cheaper payload. Scoping to the visited chapter puts
 *   the work exactly where the writer can see its result, and costs nothing
 *   for a book they are not reading.
 */
import {
  ATTRIBUTION_CAP,
  attributionKeyFor,
  offeredSpeakers,
  runAttributionReview,
  selectAttributionCandidates,
} from "./attribution-review";
import {
  CHEKHOV_CAP,
  chekhovKeyFor,
  runChekhovReview,
  selectChekhovCandidates,
} from "./chekhov-review";
import {
  SCENE_CAP,
  offeredLabels,
  runSceneReview,
  sceneKeyFor,
  selectSceneCandidates,
} from "./scene-review";
import { sceneCandidateScores } from "./scene-function";
import type { AttributionReviewInput, AttributionSpan } from "./attribution-review";
import type { ChekhovReviewCandidate } from "./chekhov-review";
import type { SceneReviewCandidate } from "./scene-review";
import type { ChekhovCandidate } from "./continuity";
import type { AssistantJSONRunner } from "./assistant-client";
import type { ChapterParaResult } from "./speech-detect";
import type { Tension } from "./scene-function";
import type { AdaptivePredictionTrace } from "../types";
import type {
  AttributionSuggestion,
  ChekhovVerdictRecord,
  SceneLabelSuggestion,
} from "./review-store";

// ── Adapters ──────────────────────────────────────────────────────────────

/**
 * The paragraph index each scene starts at, in reading order.
 *
 * ★ THE ONE PLACE SCENES ARE NUMBERED. The candidate builder and the display
 *   overlay both index scenes by position in this array, so a scene index can
 *   never mean two different things. `groupIntoScenes` marks the first
 *   paragraph of every scene, including paragraph 0, so this reconstructs the
 *   engine's own grouping rather than re-deriving one.
 */
export function sceneStartParagraphs(
  speechResults: readonly ChapterParaResult[],
): number[] {
  const starts: number[] = [];
  speechResults.forEach((result, index) => {
    if (result.meta.sceneStart) starts.push(index);
  });
  // A chapter too short to group has no marked start but is still one scene.
  if (starts.length === 0 && speechResults.length > 0) starts.push(0);
  return starts;
}

/**
 * Every speech span of the chapter, in reading order, from the ENGINE'S OWN
 * prediction traces.
 *
 * ★ BUILT FROM `speechPredictions`, NOT FROM THE SEGMENTS, AND THAT IS LOAD-
 *   BEARING. The annotation path resolves a span by
 *   `(paragraphIndex, spanIndex)` against exactly this array
 *   (App.handleAnnotationConfirm), so a suggestion built off a different index
 *   space would attach to the wrong line — silently, and only for paragraphs
 *   whose segment order differs from their prediction order. The traces also
 *   already carry the engine's ranked candidates, which is the option set the
 *   model is allowed to choose between.
 */
export function attributionInputFrom(
  chapterId: string,
  chapterContentHash: string,
  paragraphs: readonly string[],
  speechPredictions: readonly AdaptivePredictionTrace[],
): AttributionReviewInput {
  const spans: AttributionSpan[] = speechPredictions
    .filter((prediction) => prediction.task === "speech")
    .map((prediction) => ({
      paragraphIndex: prediction.paragraphIndex,
      spanIndex: prediction.spanIndex,
      quote: prediction.spanText,
      speaker: prediction.predictedLabel ?? "",
      confidence: prediction.confidence,
      candidates: prediction.candidates
        .map((candidate) => candidate.label)
        .filter((label): label is string => !!label),
    }))
    .sort((a, b) => a.paragraphIndex - b.paragraphIndex || a.spanIndex - b.spanIndex);
  return { chapterId, chapterContentHash, paragraphs, spans };
}

/**
 * The chapter's scenes, as near-miss questions.
 *
 * ★ prevTension AND prevLabel ARE THREADED, BECAUSE THE ENGINE THREADS THEM.
 *   `groupIntoScenes` walks scenes in order and feeds each `classifyScene` call
 *   the previous scene's tension and resolved label; several gates read
 *   `prevTension` directly. Scoring a scene in isolation would produce a
 *   DIFFERENT candidate set than the one the engine actually gated in, and the
 *   near-miss would be an artefact of this function rather than a real
 *   hesitation.
 *
 * ★ A SCENE THAT ALREADY CARRIES A LABEL IS NEVER A QUESTION — including the
 *   one case where floor and margin alone would say otherwise. When the top
 *   reading repeats the previous scene's label, `classifyScene` steps down to
 *   the runner-up and labels the scene with THAT; the raw scores then look like
 *   a margin loss even though the engine answered. `meta.sceneLabel` is what
 *   the engine actually concluded, so it is what this filters on.
 */
export function sceneCandidatesFrom(
  paragraphs: readonly string[],
  speechResults: readonly ChapterParaResult[],
): SceneReviewCandidate[] {
  const starts = sceneStartParagraphs(speechResults);
  const out: SceneReviewCandidate[] = [];
  let prevTension: Tension | undefined;
  let prevLabel: string | undefined;

  starts.forEach((start, sceneIndex) => {
    const end = starts[sceneIndex + 1] ?? speechResults.length;
    const slice = paragraphs.slice(start, end);
    const meta = speechResults[start]?.meta;
    const tension: Tension = meta?.sceneTension ?? meta?.tension ?? "calm";
    const nearMisses = sceneCandidateScores({
      paragraphs: [...slice],
      dialogueDensity: speechResults.slice(start, end).map((r) => r.meta.dialogueDensity),
      tension,
      prevTension,
      prevLabel,
    });

    // Advance the engine's own carry BEFORE the skip, or a scene the engine
    // labelled would stop contributing its label to the next scene's context.
    prevTension = tension;
    prevLabel = meta?.sceneLabel;

    if (meta?.sceneLabel) return; // the engine answered; nothing to adjudicate
    if (slice.length === 0 || nearMisses.length === 0) return;
    out.push({ sceneIndex, paragraphs: slice, tension, nearMisses });
  });

  return out;
}

/**
 * The chapter's Chekhov candidates, as questions.
 *
 * `chaptersSince` is how many chapters have gone by WITHOUT the phrase
 * returning — `findChekhovCandidates` only flags phrases absent from every
 * later chapter, so that count is the length of the silence, which is the
 * quantity the question is actually about.
 */
export function chekhovCandidatesFrom(
  candidates: readonly ChekhovCandidate[],
  chapterNumber: number,
  chaptersSince: number,
): ChekhovReviewCandidate[] {
  return candidates
    .filter((candidate) => candidate.sentence.trim() !== "")
    .map((candidate) => ({
      phrase: candidate.phrase,
      mentions: candidate.mentions,
      sentence: candidate.sentence,
      chapterNumber,
      chaptersSince,
    }));
}

// ── The sweep ─────────────────────────────────────────────────────────────

export type SweepAnswer =
  | { kind: "attribution"; value: AttributionSuggestion }
  | { kind: "scene"; value: SceneLabelSuggestion }
  | { kind: "chekhov"; value: ChekhovVerdictRecord };

export interface AssistSweepInput {
  chapterId: string;
  chapterContentHash: string;
  attribution: AttributionReviewInput;
  scenes: readonly SceneReviewCandidate[];
  chekhov: readonly ChekhovReviewCandidate[];
}

export interface AssistSweepOptions {
  run: AssistantJSONRunner;
  modelId: string;
  /** True when this exact question has already been put to this model. */
  isAsked: (key: string) => boolean;
  /**
   * Called once per question actually asked — with the answer, or with null
   * when nothing usable came back. BOTH are recorded by the caller: a question
   * asked and abstained on must not be asked again on the next mount.
   */
  onAnswer: (key: string, answer: SweepAnswer | null) => void;
  isCancelled?: () => boolean;
  /** Test seam. Production leaves these at the module caps. */
  caps?: { attribution?: number; scene?: number; chekhov?: number };
}

export interface AssistSweepStats {
  asked: number;
  answered: number;
  /** Questions inside the cap that were already answered earlier. */
  skipped: number;
  cancelled: boolean;
}

/**
 * Spend the chapter's budget, in priority order, and stop.
 *
 * Selection happens per task BEFORE any inference, so the cap is a cap on
 * QUESTIONS ASKED rather than on answers kept: a chapter whose three top
 * attribution ties were all answered last time asks nothing and moves on,
 * instead of walking down the ranking to find three unasked ones. That is
 * deliberate — the ranking says these are the three worth asking, and
 * "everything worth asking has been asked" is the settled state the spec wants
 * a chapter to reach.
 */
export async function runAssistSweep(
  input: AssistSweepInput,
  opts: AssistSweepOptions,
): Promise<AssistSweepStats> {
  const stats: AssistSweepStats = { asked: 0, answered: 0, skipped: 0, cancelled: false };
  const cancelled = () => opts.isCancelled?.() === true;
  const caps = {
    attribution: opts.caps?.attribution ?? ATTRIBUTION_CAP,
    scene: opts.caps?.scene ?? SCENE_CAP,
    chekhov: opts.caps?.chekhov ?? CHEKHOV_CAP,
  };

  // ── 1 · attribution ─────────────────────────────────────────────────────
  for (const span of selectAttributionCandidates(input.attribution, caps.attribution)) {
    if (cancelled()) { stats.cancelled = true; return stats; }
    const offered = offeredSpeakers(span, input.attribution);
    const key = attributionKeyFor(
      input.chapterContentHash, span.paragraphIndex, span.spanIndex, opts.modelId, offered,
    );
    if (opts.isAsked(key)) { stats.skipped++; continue; }
    stats.asked++;
    const result = await runAttributionReview(span, input.attribution, {
      run: opts.run,
      modelId: opts.modelId,
    });
    if (cancelled()) { stats.cancelled = true; return stats; }
    if (!result) { opts.onAnswer(key, null); continue; }
    stats.answered++;
    opts.onAnswer(key, {
      kind: "attribution",
      value: {
        paragraphIndex: result.paragraphIndex,
        spanIndex: result.spanIndex,
        quote: span.quote,
        previousSpeaker: result.previousSpeaker,
        speaker: result.speaker,
        confidence: result.confidence,
        reason: result.reason,
      },
    });
  }

  // ── 2 · scene function ──────────────────────────────────────────────────
  for (const scene of selectSceneCandidates(input.scenes, caps.scene)) {
    if (cancelled()) { stats.cancelled = true; return stats; }
    const offered = offeredLabels(scene);
    const key = sceneKeyFor(input.chapterContentHash, scene.sceneIndex, opts.modelId, offered);
    if (opts.isAsked(key)) { stats.skipped++; continue; }
    stats.asked++;
    const result = await runSceneReview(scene, {
      run: opts.run,
      modelId: opts.modelId,
      chapterContentHash: input.chapterContentHash,
      chapterId: input.chapterId,
    });
    if (cancelled()) { stats.cancelled = true; return stats; }
    if (!result) { opts.onAnswer(key, null); continue; }
    stats.answered++;
    opts.onAnswer(key, {
      kind: "scene",
      value: {
        sceneIndex: result.sceneIndex,
        label: result.label,
        confidence: result.confidence,
        reason: result.reason,
        offered,
      },
    });
  }

  // ── 3 · Chekhov ─────────────────────────────────────────────────────────
  for (const candidate of selectChekhovCandidates(input.chekhov, caps.chekhov)) {
    if (cancelled()) { stats.cancelled = true; return stats; }
    const key = chekhovKeyFor(input.chapterContentHash, candidate.phrase, opts.modelId);
    if (opts.isAsked(key)) { stats.skipped++; continue; }
    stats.asked++;
    const result = await runChekhovReview(candidate, {
      run: opts.run,
      modelId: opts.modelId,
      chapterContentHash: input.chapterContentHash,
      chapterId: input.chapterId,
    });
    if (cancelled()) { stats.cancelled = true; return stats; }
    if (!result) { opts.onAnswer(key, null); continue; }
    stats.answered++;
    // ★ STORED WHATEVER THE VERDICT. "furniture" is the honest majority answer
    //   and it is worth keeping: it is what stops the same phrase being asked
    //   about on every mount. `confirmedPromises` is where it renders nothing.
    opts.onAnswer(key, {
      kind: "chekhov",
      value: {
        phrase: result.phrase,
        verdict: result.verdict,
        confidence: result.confidence,
        reason: result.reason,
      },
    });
  }

  return stats;
}
