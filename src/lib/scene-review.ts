/**
 * scene-review.ts — the near-miss task: the scene the engine ALMOST named.
 *
 * `classifyScene` abstains by design (gate → floor → margin) and 64% of scenes
 * take it, measured over 1896 scenes of DEV prose. That is not a defect queue:
 * most of those scenes genuinely have no function worth naming, and a sweep
 * over them would be 16.64 questions per chapter to relabel silence.
 *
 * ★★ ONLY THE NEAR-MISSES. A scene that produced no gated candidate at all is
 *    silence on purpose and is never asked about. The queue is exactly the
 *    scenes where the top candidate CLEARED ITS GATE — it had real evidence for
 *    that specific reading — and then fell short of FLOOR or lost MARGIN. Those
 *    are the scenes where a second opinion is deciding something, rather than
 *    inventing something.
 *
 * ★ FLOOR AND MARGIN ARE SINGLE-SOURCED FROM THE ENGINE. They are tuned
 *   against a 1566-scene corpus and they move; a copy of the numbers here would
 *   leave this module measuring a different near-miss than the engine produces.
 *
 * ★ THE ANSWER IS MARKED MODEL-SOURCED BY THE CALLER, AND
 *   scripts/test-scene-labels.ts MUST KEEP MEASURING THE ENGINE ALONE. If the
 *   accuracy harness ever reads a model-sourced label, the next person tuning
 *   scene-function.ts is tuning against the model's answers.
 */
import { fnv1a } from "./evidence-pack";
import { tidyTruncatedText } from "./assistant-client";
import { FLOOR, MARGIN } from "./scene-function";
import type { AssistantJSONRunner } from "./assistant-client";
import type { Tension } from "./scene-function";

export const SCENE_TASK = "scene-review";
/** Bump on ANY change to the prompt text or the schema. Invalidates stored labels. */
export const SCENE_PROMPT_VERSION = 1;

/** Per-chapter budget. Three questions, ranked by how close the call was. */
export const SCENE_CAP = 3;
/** A label below this is not applied. */
export const SCENE_MIN_CONFIDENCE = 0.7;

/** The engine's own decision thresholds — see the ★ in the header. */
export const SCENE_FLOOR: number = FLOOR;
export const SCENE_MARGIN: number = MARGIN;

/** Labels shown. Past three the ranking is arithmetic noise, not a shortlist. */
export const SCENE_OFFERED_CAP = 3;

/** The literal abstention. Never a label, never in `offered`. */
export const SCENE_NONE = "none";

/**
 * How much scene prose the model reads.
 *
 * ★ A BUDGET IN CHARACTERS BECAUSE THIS ONE IS SPENT BY CODE, NOT BY THE MODEL.
 *   Word budgets are for prose the MODEL writes (it cannot count characters it
 *   has not written); this is prose the excerpt builder cuts, where a character
 *   budget is exactly the thing being bounded.
 */
export const SCENE_TEXT_BUDGET = 1200;

const REASON_MAX = 120;
/** Headroom over any offered label: a `maxLength` is a guillotine, not a hint. */
const LABEL_MAX = 40;

const DEFAULT_MAX_TOKENS = 128;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * ★★ REASON FIRST. A grammar emits properties in declaration order; with the
 *    label first the model commits before it has written a word of evidence,
 *    which is how entity-review got labels contradicting their own reasons.
 *    Do not reorder these.
 *
 * ★ `label` IS A STRING, NOT AN ENUM, BECAUSE THE OFFERED SET IS PER SCENE.
 *   One schema serves every request and the near-miss labels change with every
 *   scene, so membership is checked in `normalizeSceneLabel` against the list
 *   that request was built with.
 */
export const SCENE_SCHEMA = {
  type: "object",
  properties: {
    reason: { type: "string", maxLength: REASON_MAX },
    label: { type: "string", maxLength: LABEL_MAX },
    confidence: { type: "number" },
  },
} as const;

/**
 * ★ THE SHORTLIST IS THE WHOLE QUESTION. The model is not classifying a scene
 *   from scratch — an engine already found real evidence for two or three
 *   readings and could not separate them. Framing it as "which of these, if
 *   any" is what keeps the answer inside the engine's own vocabulary.
 *
 * ★ "none" IS LAST AND IT IS FREE. A wrong label sits permanently above a
 *   colour that already says how tense the scene is, so silence costs the
 *   writer nothing and a decorative word costs them trust.
 */
export const SCENE_SYSTEM = `You are shown one scene from a novel and two or three words that an analysis
engine nearly chose to describe what the scene is DOING. It found real evidence
for each of them and could not separate them. Your job is to say which one fits,
or that none of them do.

You are given the scene's prose, how tense it reads, and the shortlist with the
engine's own scores. Choose only from that shortlist.

What the words mean — they name a scene's FUNCTION, never its mood:
- the scene is a character pursuing something against resistance, or
- the scene is a character absorbing what just happened and deciding, or
- the scene is establishing a place, a practice, or a silence.

Read the scene and ask what it is FOR. A word that only describes how loud or
how quiet the scene is has told the writer nothing they cannot already see.

Answer "${SCENE_NONE}" when no word on the shortlist is clearly right, when two of
them fit equally, or when the scene is doing several things at once. Silence is
a good answer here and it costs nothing — the scene simply keeps no label,
which is what it has now.

Answer as JSON: {"reason","label","confidence"} in that order.
reason: FIRST, one clause of at most 15 words naming what the scene does.
label: one word from the shortlist, copied exactly, or "${SCENE_NONE}".
confidence: a number from 0 to 1, how much the scene shows. Never above 1.`;

// ── input & selection ─────────────────────────────────────────────────────

/** One candidate the engine gated in but could not land. */
export interface SceneNearMiss {
  label: string;
  /** The engine's score: GATE_BASE (1) plus graded support in 0…1. */
  score: number;
}

export interface SceneReviewCandidate {
  /** Index of the scene within the chapter, in reading order. */
  sceneIndex: number;
  paragraphs: readonly string[];
  tension: Tension;
  /** The candidates that cleared their gates, BEST FIRST. */
  nearMisses: readonly SceneNearMiss[];
}

/** How far the top candidate fell short of the absolute floor. 0 for a scene
 *  that cleared the floor and lost on margin alone. */
export function floorShortfall(candidate: SceneReviewCandidate): number {
  const top = candidate.nearMisses[0];
  if (!top) return Infinity;
  return Math.max(0, SCENE_FLOOR - top.score);
}

/**
 * Did this scene actually near-miss?
 *
 * A scene whose top candidate cleared BOTH tests already has an engine label
 * and is not a question; a scene with no gated candidate is silence on purpose.
 * Only the two failure modes in between belong in the queue.
 */
export function isNearMiss(candidate: SceneReviewCandidate): boolean {
  const top = candidate.nearMisses[0];
  if (!top || !(top.score > 0)) return false;
  const runnerUp = candidate.nearMisses[1]?.score ?? 0;
  return top.score < SCENE_FLOOR || top.score - runnerUp < SCENE_MARGIN;
}

/**
 * Rank the chapter's near-misses and take the budget.
 *
 * ★ SMALLEST SHORTFALL FIRST. A scene that lost on MARGIN has a zero shortfall
 *   and ranks above every floor miss: the engine had enough absolute evidence
 *   and only lost a photo-finish, so one reading is the most likely to be
 *   decided by a second opinion. Among equal shortfalls the stronger scene runs
 *   first, because a stronger score is more evidence to answer from.
 */
export function selectSceneCandidates(
  candidates: readonly SceneReviewCandidate[],
  cap = SCENE_CAP,
): SceneReviewCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(
      ({ candidate }) =>
        candidate.paragraphs.length > 0 &&
        offeredLabels(candidate).length > 0 &&
        isNearMiss(candidate),
    )
    .sort(
      (a, b) =>
        floorShortfall(a.candidate) - floorShortfall(b.candidate) ||
        (b.candidate.nearMisses[0]?.score ?? 0) - (a.candidate.nearMisses[0]?.score ?? 0) ||
        a.index - b.index,
    )
    .slice(0, Math.max(0, cap))
    .map((entry) => entry.candidate);
}

// ── request assembly ──────────────────────────────────────────────────────

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** The labels this scene may be answered with, in the engine's own order. */
export function offeredLabels(candidate: SceneReviewCandidate): string[] {
  const out: string[] = [];
  for (const near of candidate.nearMisses) {
    const label = collapse(near.label);
    if (!label || label.toLowerCase() === SCENE_NONE) continue;
    if (out.some((existing) => existing.toLowerCase() === label.toLowerCase())) continue;
    out.push(label);
    if (out.length >= SCENE_OFFERED_CAP) break;
  }
  return out;
}

function cutHead(text: string, max: number): string {
  const body = collapse(text);
  if (body.length <= max) return body;
  const cut = body.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function cutTail(text: string, max: number): string {
  const body = collapse(text);
  if (body.length <= max) return body;
  const cut = body.slice(body.length - max);
  const space = cut.indexOf(" ");
  return `…${(space >= 0 && space < max * 0.5 ? cut.slice(space + 1) : cut).trimStart()}`;
}

/**
 * The scene, inside the budget.
 *
 * ★ HEAD AND TAIL, NOT THE FIRST 1200 CHARACTERS. Two of the readings on the
 *   shortlist are decided by where the scene ENDS — a decision beat lands late
 *   by definition, and an aftermath is recognised by what it settles into. A
 *   head-only excerpt of a long scene deletes exactly the evidence that
 *   separates them. The gap is marked so the model does not read across it as
 *   if it were continuous prose.
 */
export function sceneExcerpt(
  paragraphs: readonly string[],
  budget = SCENE_TEXT_BUDGET,
): string[] {
  const clean = paragraphs.map(collapse).filter(Boolean);
  if (clean.length === 0) return [];
  const total = clean.reduce((n, p) => n + p.length + 1, 0);
  if (total <= budget) return clean;

  const headBudget = Math.round(budget * 0.6);
  const head: string[] = [];
  let used = 0;
  let taken = 0;
  for (const paragraph of clean) {
    if (used + paragraph.length + 1 > headBudget) {
      const room = headBudget - used;
      // Only cut into a paragraph when the remainder is still a readable
      // stretch of prose; a 30-character fragment is noise.
      if (room > 120) {
        head.push(cutHead(paragraph, room));
        taken++;
      }
      break;
    }
    head.push(paragraph);
    used += paragraph.length + 1;
    taken++;
  }

  const tail: string[] = [];
  let tailUsed = 0;
  for (let i = clean.length - 1; i >= taken; i--) {
    const paragraph = clean[i];
    if (tailUsed + paragraph.length + 1 > budget - headBudget) {
      // The closing paragraph is worth cutting into for the same reason the
      // tail exists at all.
      if (tail.length === 0 && budget - headBudget > 120) {
        tail.push(cutTail(paragraph, budget - headBudget));
      }
      break;
    }
    tail.push(paragraph);
    tailUsed += paragraph.length + 1;
  }
  tail.reverse();

  return taken + tail.length >= clean.length && tail.length > 0
    ? [...head, ...tail]
    : [...head, "…", ...tail];
}

export interface SceneRequest {
  systemPrompt: string;
  userText: string;
  schema: typeof SCENE_SCHEMA;
  maxTokens: number;
  /** The labels this answer is validated against. */
  offered: string[];
}

/** The exact bytes one scene sends; the live harness drives this, not a copy. */
export function buildSceneRequest(
  candidate: SceneReviewCandidate,
  maxTokens = DEFAULT_MAX_TOKENS,
): SceneRequest {
  const offered = offeredLabels(candidate);
  const scores = new Map(
    candidate.nearMisses.map((near) => [collapse(near.label).toLowerCase(), near.score]),
  );

  const userText = [
    `SCENE ${candidate.sceneIndex} · tension reads ${candidate.tension}`,
    "",
    "THE SCENE",
    ...sceneExcerpt(candidate.paragraphs).map((line) => `  ${line}`),
    "",
    "THE SHORTLIST — the readings the engine could not separate",
    ...offered.map((label) => {
      const score = scores.get(label.toLowerCase());
      return `  - ${label}${score === undefined ? "" : `   (score ${score.toFixed(2)})`}`;
    }),
    `  - ${SCENE_NONE}   (say this whenever no word above is clearly right)`,
    "",
    "Which one is this scene doing?",
  ].join("\n");

  return {
    systemPrompt: SCENE_SYSTEM,
    userText,
    schema: SCENE_SCHEMA,
    maxTokens,
    offered,
  };
}

// ── validation ────────────────────────────────────────────────────────────

export interface SceneAnswer {
  label: string;
  confidence: number;
  reason: string;
}

/**
 * Mechanical checks only.
 *
 * Returns null — the scene keeps NO label, exactly as it does today — when the
 * shape is unusable, when the model abstained, when the label was not offered,
 * or when the confidence is below the floor. Null is the common case and the
 * cheap one; it is not a failure.
 */
export function normalizeSceneLabel(
  raw: unknown,
  offered: readonly string[],
): SceneAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  const labelRaw = value.label;
  if (typeof labelRaw !== "string") return null;
  const wanted = collapse(labelRaw).toLowerCase();
  if (!wanted || wanted === SCENE_NONE) return null;
  const label = offered.find((candidate) => collapse(candidate).toLowerCase() === wanted);
  if (!label) return null;

  const confidenceRaw = value.confidence;
  if (typeof confidenceRaw !== "number" || !Number.isFinite(confidenceRaw)) return null;
  const confidence = Math.min(1, Math.max(0, confidenceRaw));
  if (confidence < SCENE_MIN_CONFIDENCE) return null;

  const reasonRaw = value.reason;
  if (typeof reasonRaw !== "string") return null;
  const reason = tidyTruncatedText(collapse(reasonRaw).slice(0, REASON_MAX), REASON_MAX);
  if (!reason) return null;

  return { label, confidence, reason };
}

// ── cache key ─────────────────────────────────────────────────────────────

/**
 * Cache key. `fnv1a` is shared with evidence-pack so the recipe lives once.
 *
 * ★ THE OFFERED LABELS BELONG IN THE KEY. `chapterContentHash` is a coarse
 *   dedup key over the PROSE; a tuned gate or threshold in scene-function.ts
 *   re-points the shortlist while leaving the hash byte-identical, and a stored
 *   answer would then name a reading that was never offered. Same lesson as
 *   chip-picker's event fingerprint.
 */
export function sceneKeyFor(
  chapterContentHash: string,
  sceneIndex: number,
  modelId: string,
  offered: readonly string[] = [],
): string {
  return fnv1a(
    `${chapterContentHash}|s${sceneIndex}|${offered.join(",")}|${modelId}|v${SCENE_PROMPT_VERSION}`,
  );
}

// ── one scene ─────────────────────────────────────────────────────────────

export interface SceneReviewOptions {
  run: AssistantJSONRunner;
  /** From `assistantStatus().model.id`; part of the cache key. */
  modelId: string;
  chapterContentHash: string;
  chapterId?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface SceneReviewResult extends SceneAnswer {
  sceneIndex: number;
  /** Always true. The caller stores it so the accuracy harness can exclude
   *  model-sourced labels and keep measuring the engine alone. */
  modelSourced: true;
  key: string;
}

/**
 * Ask about one scene. Null on anything that is not a confident, offered
 * label — which leaves the scene unlabelled, the state it is in already.
 */
export async function runSceneReview(
  candidate: SceneReviewCandidate,
  opts: SceneReviewOptions,
): Promise<SceneReviewResult | null> {
  if (!isNearMiss(candidate)) return null;
  const request = buildSceneRequest(candidate, opts.maxTokens ?? DEFAULT_MAX_TOKENS);
  if (request.offered.length === 0) return null;

  const result = await opts.run<unknown>({
    task: SCENE_TASK,
    tag: `${opts.chapterId ?? "chapter"}:scene-${candidate.sceneIndex}`,
    systemPrompt: request.systemPrompt,
    userText: request.userText,
    schema: request.schema,
    maxTokens: request.maxTokens,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!result.ok) return null;

  const answer = normalizeSceneLabel(result.json, request.offered);
  if (!answer) return null;

  return {
    sceneIndex: candidate.sceneIndex,
    ...answer,
    modelSourced: true,
    key: sceneKeyFor(
      opts.chapterContentHash,
      candidate.sceneIndex,
      opts.modelId,
      request.offered,
    ),
  };
}
