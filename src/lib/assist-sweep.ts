/**
 * assist-sweep.ts — one sweep, a fixed order and a hard budget.
 *
 * The wave-2 spec (plans/assistant-adjudication-wave-2.md §4) asks for ONE
 * background pass rather than several competing ones, because two schedulers
 * against a single-slot inference host are two queues fighting for one lock.
 * This module is that pass, plus the adapters that turn a live chapter analysis
 * into the candidates each task module expects.
 *
 * ★★ ATTRIBUTION WAS THE FIRST STAGE AND IS MEASURED OUT. The spec ordered
 *    this sweep attribution → scene → Chekhov, because a wrong speaker poisons
 *    every widget downstream. It was built, wired, and then measured against
 *    the real model by scripts/probe-attribution-anchor.cjs: on five cases the
 *    prose answers unambiguously, the best of four prompt presentations scored
 *    1 right, 1 declined, 3 WRONG AND APPLIED — every wrong answer above the
 *    0.7 floor, at 0.8-1.0 confidence, so no threshold separates them. Stable
 *    across two prompt versions and four presentations (32 judgements), and the
 *    failures do not move with presentation at all: Qwen3-1.7B asserts "the
 *    line directly names the speaker" for lines that name nobody, and breaks
 *    the alternation rule it was just given.
 *
 *    The engine's own posterior is better than that. attribution-review.ts is
 *    kept, tested and unwired; its header states what would have to measure
 *    true to wire it back.
 *
 * ★★ RANK AND CAP, DO NOT SWEEP. Five questions per chapter, ~3s of idle work,
 *    bounded whatever the prose does. Measured over 73 DEV chapters, an
 *    uncapped scene pass alone would be 16.64 questions per chapter for a queue
 *    an edit invalidates before it drains. See scripts/probe-assist-funnels.ts,
 *    which is the measurement the caps come from and the way to check they fit.
 *
 * ★ THE SWEEP IS SCOPED TO THE CHAPTER THE WRITER IS IN, WHICH NARROWS THE
 *   SPEC. §4 says it "moves to the next chapter only when the current one is
 *   settled". Scene near-misses need a full chapter analysis — they come from
 *   the engine's own scene grouping — and that exists for the ACTIVE chapter
 *   only.
 *   Sweeping the book would mean re-analysing every chapter in the worker
 *   first, which is what the ledger backfill already does at one chapter per
 *   idle tick for a much cheaper payload. Scoping to the visited chapter puts
 *   the work exactly where the writer can see its result, and costs nothing
 *   for a book they are not reading.
 */
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
import type { ChekhovReviewCandidate } from "./chekhov-review";
import type { SceneReviewCandidate } from "./scene-review";
import type { ChekhovCandidate } from "./continuity";
import type { AssistantJSONRunner } from "./assistant-client";
import type { ChapterParaResult } from "./speech-detect";
import type { Tension } from "./scene-function";
import type { ChekhovVerdictRecord, SceneLabelSuggestion } from "./review-store";

// ── Adapters ──────────────────────────────────────────────────────────────

/**
 * The paragraph index each scene starts at, in reading order.
 *
 * ★ THE ONE PLACE SCENES ARE NUMBERED. The candidate builder and the display
 *   overlay both index scenes by position in this array, so a scene index can
 *   never mean two different things. `groupIntoScenes` marks the first
 *   paragraph of every scene, including paragraph 0, so this reconstructs the
 *   engine's own grouping rather than re-deriving one.
 *
 * ★★ NO MARKED STARTS MEANS NO SCENES, NEVER "ONE SCENE". This returned `[0]`
 *    as a defensive nicety, and the nicety was a bug. `detectSpeechInChapter`
 *    SKIPS the scene-grouping post-pass entirely at the `fast` level
 *    (`useGroupScenes = level !== 'fast'`), so on the typing path no paragraph
 *    carries `sceneStart` — and the fallback then manufactured a single scene
 *    spanning the WHOLE CHAPTER. The sweep would spend an inference on it every
 *    fast-analysed chapter, ask the model to name the function of an entire
 *    chapter read as a 1200-character head-and-tail excerpt, and store an
 *    answer that can never render, because HighlightLayer draws a scene label
 *    only where `meta.sceneStart` is set. Silent, permanent, and invisible to
 *    every gate that called this with grouped input.
 *
 *    With grouping ON this is never empty for a non-empty chapter —
 *    `groupIntoScenes` seeds its boundaries with [0] — so an empty result means
 *    exactly one thing: the engine has not grouped this chapter, and there is
 *    nothing here to have an opinion about.
 */
export function sceneStartParagraphs(
  speechResults: readonly ChapterParaResult[],
): number[] {
  const starts: number[] = [];
  speechResults.forEach((result, index) => {
    if (result.meta.sceneStart) starts.push(index);
  });
  return starts;
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
      // Carried through, or selectChekhovCandidates re-sorts by mentions and
      // the engine's ordering is lost between here and the model.
      concreteness: candidate.concreteness,
      chapterNumber,
      chaptersSince,
    }));
}

// ── The sweep ─────────────────────────────────────────────────────────────

export type SweepAnswer =
  | { kind: "scene"; value: SceneLabelSuggestion }
  | { kind: "chekhov"; value: ChekhovVerdictRecord };

export interface AssistSweepInput {
  chapterId: string;
  chapterContentHash: string;
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
  caps?: { scene?: number; chekhov?: number };
}

export interface AssistSweepStats {
  asked: number;
  answered: number;
  /** Questions inside the cap that were already answered earlier. */
  skipped: number;
  cancelled: boolean;
}

/**
 * Spend the chapter's budget, scene questions before Chekhov, and stop.
 *
 * Selection happens per task BEFORE any inference, so the cap is a cap on
 * QUESTIONS ASKED rather than on answers kept: a chapter whose three top
 * scene near-misses were all answered last time asks nothing and moves on,
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
    scene: opts.caps?.scene ?? SCENE_CAP,
    chekhov: opts.caps?.chekhov ?? CHEKHOV_CAP,
  };

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

  // ── 2 · Chekhov ─────────────────────────────────────────────────────────
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
