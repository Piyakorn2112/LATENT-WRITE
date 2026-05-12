/**
 * annotation-learn.ts
 *
 * Derives a LearnedBias from the annotation store using three NLP-inspired
 * techniques adapted to the fiction speaker-attribution domain:
 *
 *   1. Frequency Priors
 *      Each corrected speaker name receives a prior proportional to how
 *      often the user assigned it. Applied as an additive boost to the
 *      Markov speakWeights initialisation, so frequently-corrected characters
 *      start every chapter with a non-zero recency lead.
 *
 *   2. Pronoun Posteriors (Bayesian speaker diarization)
 *      For each correction, extract any gendered/neutral pronoun (he/she/they
 *      etc.) from contextBefore. Build P(speaker | pronoun) by normalising
 *      per-pronoun counts. speech-detect multiplies each Tier-3 candidate's
 *      score by these weights, nudging resolution toward the user's pattern.
 *
 *   3. Speaker Bigram Transitions
 *      Sort all corrections by (chapterId, paragraphIndex). Build a
 *      transition count matrix: count[prevSpeaker][nextSpeaker]++.
 *      Apply Laplace smoothing (+ 0.5) and row-normalise to probabilities.
 *      speech-detect applies these as multiplicative boosts during Tier-4
 *      extended context scoring — characters who frequently follow each other
 *      in the user's corrected data get promoted in ambiguous multi-speaker runs.
 *
 *   4. Actor Priors (action-detect)
 *      Same frequency logic as (1) but built from corrections where
 *      spanType === "action". Feeds attributeActor() as a tiebreaker boost.
 *
 * All signals default to identity (1× or 0 additive) when no data exists,
 * so the existing pipeline is entirely unaffected until LEARN_THRESHOLD
 * corrections accumulate.
 */

import type {
  AnnotationCorrection,
  AnnotationStore,
  LearnedBias,
  LearnedBiasChapterWindow,
  LearnedBiasContextCueWeights,
  WorldData,
} from "../types";

/** Minimum corrections before any bias is computed. */
export const LEARN_THRESHOLD = 10;

/** Scale factor for speaker/actor priors (added to speakWeights init). */
const PRIOR_SCALE = 5;

const LOCAL_CHAPTER_RADIUS = 5;
const LOCAL_CHAPTER_HALF_LIFE = 2;
const MIN_LOCAL_BLEND = 0.18;
const MAX_LOCAL_BLEND = 0.78;
const LOCAL_BLEND_TARGET_WEIGHT = 10;
const SMOOTHING_ALPHA = 0.35;

// Pronoun classes used for contextual extraction.
const PRONOUN_RE = /\b(he|she|they|him|her|them|his|hers|their)\b/i;

type WeightedMap = Record<string, number>;
type WeightedNestedMap = Record<string, Record<string, number>>;

interface CueStat {
  matches: number;
  total: number;
}

interface SpeakerSampleStats {
  speechCount: number;
  actionCount: number;
  speechWeight: number;
  actionWeight: number;
}

interface BiasAggregate {
  totalWeight: number;
  speechWeight: number;
  actionWeight: number;
  speakerCounts: WeightedMap;
  actorCounts: WeightedMap;
  pronounCounts: WeightedNestedMap;
  transitionCounts: WeightedNestedMap;
  pronounSampleWeight: number;
  transitionSampleWeight: number;
  contextCueStats: Record<keyof LearnedBiasContextCueWeights, CueStat>;
  speakerStats: Record<string, SpeakerSampleStats>;
}

export interface ComputeLearnedBiasOptions {
  currentChapterId?: string | null;
  chapterIds?: string[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function countNameMentions(text: string, speaker: string): number {
  if (!text || !speaker) return 0;
  const re = new RegExp(`\\b${speaker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
  return (text.match(re) ?? []).length;
}

function createAggregate(): BiasAggregate {
  return {
    totalWeight: 0,
    speechWeight: 0,
    actionWeight: 0,
    speakerCounts: {},
    actorCounts: {},
    pronounCounts: {},
    transitionCounts: {},
    pronounSampleWeight: 0,
    transitionSampleWeight: 0,
    contextCueStats: {
      beforeName: { matches: 0, total: 0 },
      afterName: { matches: 0, total: 0 },
      surroundingName: { matches: 0, total: 0 },
      previousSpeakerCarry: { matches: 0, total: 0 },
    },
    speakerStats: {},
  };
}

function addWeightedCount(map: WeightedMap, key: string, amount: number) {
  map[key] = (map[key] ?? 0) + amount;
}

function addWeightedNestedCount(map: WeightedNestedMap, row: string, col: string, amount: number) {
  if (!map[row]) map[row] = {};
  map[row][col] = (map[row][col] ?? 0) + amount;
}

function getSpeakerStats(aggregate: BiasAggregate, name: string): SpeakerSampleStats {
  if (!aggregate.speakerStats[name]) {
    aggregate.speakerStats[name] = {
      speechCount: 0,
      actionCount: 0,
      speechWeight: 0,
      actionWeight: 0,
    };
  }
  return aggregate.speakerStats[name];
}

function correctionSortValue(chapterId: string, chapterOrder: Map<string, number>): number {
  return chapterOrder.get(chapterId) ?? Number.MAX_SAFE_INTEGER;
}

function sortCorrections(
  a: AnnotationCorrection,
  b: AnnotationCorrection,
  chapterOrder: Map<string, number>,
): number {
  const aIndex = correctionSortValue(a.chapterId, chapterOrder);
  const bIndex = correctionSortValue(b.chapterId, chapterOrder);
  if (aIndex !== bIndex) return aIndex - bIndex;
  if (a.chapterId < b.chapterId) return -1;
  if (a.chapterId > b.chapterId) return 1;
  return a.paragraphIndex - b.paragraphIndex || a.spanIndex - b.spanIndex;
}

function chapterDistance(
  chapterId: string,
  currentChapterId: string | null | undefined,
  chapterOrder: Map<string, number>,
): number | null {
  if (!currentChapterId) return null;
  const currentIndex = chapterOrder.get(currentChapterId);
  const targetIndex = chapterOrder.get(chapterId);
  if (currentIndex == null || targetIndex == null) return null;
  return Math.abs(targetIndex - currentIndex);
}

function chapterWeight(distance: number | null): number {
  if (distance == null || distance > LOCAL_CHAPTER_RADIUS) return 0;
  return 2 ** (-distance / LOCAL_CHAPTER_HALF_LIFE);
}

function computeBlend(weightTotal: number): number {
  if (weightTotal <= 0) return 0;
  return clamp(weightTotal / LOCAL_BLEND_TARGET_WEIGHT, MIN_LOCAL_BLEND, MAX_LOCAL_BLEND);
}

function smoothedRatio(matches: number, total: number): number {
  if (total <= 0) return 0;
  return (matches + 0.5) / (total + 1);
}

function buildPriors(counts: WeightedMap, totalWeight: number): Record<string, number> {
  if (totalWeight <= 0) return {};
  const priors: Record<string, number> = {};
  for (const [name, count] of Object.entries(counts)) {
    priors[name] = (count / totalWeight) * PRIOR_SCALE;
  }
  return priors;
}

function smoothDistribution(counts: WeightedMap, labels: string[]): Record<string, number> {
  if (labels.length === 0) return {};
  const total = labels.reduce((sum, label) => sum + (counts[label] ?? 0), 0);
  const denom = total + SMOOTHING_ALPHA * labels.length;
  if (denom <= 0) return {};
  const out: Record<string, number> = {};
  for (const label of labels) {
    out[label] = ((counts[label] ?? 0) + SMOOTHING_ALPHA) / denom;
  }
  return out;
}

function mergeScalar(globalValue: number, localValue: number, blend: number): number {
  return globalValue * (1 - blend) + localValue * blend;
}

function buildDistributionRows(
  counts: WeightedNestedMap,
  labelsByRow: Record<string, string[]>,
): WeightedNestedMap {
  const out: WeightedNestedMap = {};
  for (const [row, rowCounts] of Object.entries(counts)) {
    const labels = labelsByRow[row] ?? Object.keys(rowCounts);
    const rowDistribution = smoothDistribution(rowCounts, labels);
    if (Object.keys(rowDistribution).length > 0) out[row] = rowDistribution;
  }
  return out;
}

function extractRowWeights(rows: WeightedNestedMap): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const [row, values] of Object.entries(rows)) {
    weights[row] = Object.values(values).reduce((sum, value) => sum + value, 0);
  }
  return weights;
}

function mergeDistributions(
  globalRows: WeightedNestedMap,
  localRows: WeightedNestedMap,
  localRowWeights: Record<string, number>,
): WeightedNestedMap {
  const rows = new Set([...Object.keys(globalRows), ...Object.keys(localRows)]);
  const merged: WeightedNestedMap = {};
  for (const row of rows) {
    const globalRow = globalRows[row] ?? {};
    const localRow = localRows[row] ?? {};
    const blend = computeBlend(localRowWeights[row] ?? 0);
    const labels = [...new Set([...Object.keys(globalRow), ...Object.keys(localRow)])];
    if (labels.length === 0) continue;
    let rowTotal = 0;
    merged[row] = {};
    for (const label of labels) {
      const value = mergeScalar(globalRow[label] ?? 0, localRow[label] ?? 0, blend);
      if (value <= 0) continue;
      merged[row][label] = value;
      rowTotal += value;
    }
    if (rowTotal > 0) {
      for (const label of Object.keys(merged[row])) {
        merged[row][label] /= rowTotal;
      }
    }
  }
  return merged;
}

function accumulateCorrection(aggregate: BiasAggregate, correction: AnnotationCorrection, weight: number) {
  if (weight <= 0) return;
  aggregate.totalWeight += weight;
  if (!correction.correctedSpeaker) return;

  const name = correction.correctedSpeaker;
  const speakerStats = getSpeakerStats(aggregate, name);
  if (correction.spanType === "speech") {
    aggregate.speechWeight += weight;
    addWeightedCount(aggregate.speakerCounts, name, weight);
    speakerStats.speechCount += 1;
    speakerStats.speechWeight += weight;

    const pronounMatch = PRONOUN_RE.exec(`${correction.contextBefore} ${correction.spanText} ${correction.contextAfter}`);
    if (pronounMatch) {
      const pronoun = pronounMatch[1].toLowerCase();
      addWeightedNestedCount(aggregate.pronounCounts, pronoun, name, weight);
      aggregate.pronounSampleWeight += weight;
    }

    const beforeMentions = countNameMentions(correction.contextBefore, name);
    const afterMentions = countNameMentions(correction.contextAfter, name);
    aggregate.contextCueStats.beforeName.total += weight;
    aggregate.contextCueStats.afterName.total += weight;
    aggregate.contextCueStats.surroundingName.total += weight;
    if (beforeMentions > 0) aggregate.contextCueStats.beforeName.matches += weight;
    if (afterMentions > 0) aggregate.contextCueStats.afterName.matches += weight;
    if (beforeMentions > 0 || afterMentions > 0) {
      aggregate.contextCueStats.surroundingName.matches += weight;
    }
    return;
  }

  aggregate.actionWeight += weight;
  addWeightedCount(aggregate.actorCounts, name, weight);
  speakerStats.actionCount += 1;
  speakerStats.actionWeight += weight;
}

function accumulateTransition(
  aggregate: BiasAggregate,
  prevSpeaker: string,
  nextSpeaker: string,
  weight: number,
) {
  if (weight <= 0) return;
  aggregate.contextCueStats.previousSpeakerCarry.total += weight;
  if (prevSpeaker === nextSpeaker) {
    aggregate.contextCueStats.previousSpeakerCarry.matches += weight;
  } else {
    addWeightedNestedCount(aggregate.transitionCounts, prevSpeaker, nextSpeaker, weight);
  }
  aggregate.transitionSampleWeight += weight;
}

export function computeLearnedBias(
  store: AnnotationStore,
  _worldData: WorldData | undefined,
  options: ComputeLearnedBiasOptions = {},
): LearnedBias | null {
  const { corrections } = store;
  if (corrections.length < LEARN_THRESHOLD) return null;

  const chapterOrder = new Map<string, number>();
  for (const [index, chapterId] of (options.chapterIds ?? []).entries()) {
    chapterOrder.set(chapterId, index);
  }

  const weightedCorrections = corrections.map((correction) => {
    const distance = chapterDistance(correction.chapterId, options.currentChapterId, chapterOrder);
    return {
      correction,
      distance,
      localWeight: chapterWeight(distance),
    };
  });

  const chapterWindowMap = new Map<string, LearnedBiasChapterWindow>();
  for (const { correction, distance, localWeight } of weightedCorrections) {
    if (localWeight <= 0 || distance == null) continue;
    const current = chapterWindowMap.get(correction.chapterId) ?? {
      chapterId: correction.chapterId,
      distance,
      rawCorrections: 0,
      weightedCorrections: 0,
    };
    current.rawCorrections += 1;
    current.weightedCorrections += localWeight;
    chapterWindowMap.set(correction.chapterId, current);
  }

  const speechCorrections = weightedCorrections.filter(
    ({ correction }) => correction.spanType === "speech" && correction.correctedSpeaker !== null,
  ) as Array<{
    correction: AnnotationCorrection & { correctedSpeaker: string };
    distance: number | null;
    localWeight: number;
  }>;

  const globalAggregate = createAggregate();
  const localAggregate = createAggregate();
  for (const { correction, localWeight } of weightedCorrections) {
    accumulateCorrection(globalAggregate, correction, 1);
    accumulateCorrection(localAggregate, correction, localWeight);
  }

  const sortedSpeech = [...speechCorrections].sort((a, b) =>
    sortCorrections(a.correction, b.correction, chapterOrder),
  );
  for (let i = 1; i < sortedSpeech.length; i++) {
    const prev = sortedSpeech[i - 1];
    const next = sortedSpeech[i];
    accumulateTransition(globalAggregate, prev.correction.correctedSpeaker, next.correction.correctedSpeaker, 1);
    accumulateTransition(
      localAggregate,
      prev.correction.correctedSpeaker,
      next.correction.correctedSpeaker,
      (prev.localWeight + next.localWeight) / 2,
    );
  }

  const allSpeakers = [...new Set([
    ...Object.keys(globalAggregate.speakerCounts),
    ...Object.keys(localAggregate.speakerCounts),
    ...Object.keys(globalAggregate.actorCounts),
    ...Object.keys(localAggregate.actorCounts),
  ])];

  const speakerBlend = computeBlend(localAggregate.speechWeight);
  const actorBlend = computeBlend(localAggregate.actionWeight);
  const globalSpeakerPriors = buildPriors(globalAggregate.speakerCounts, Math.max(1, globalAggregate.speechWeight));
  const localSpeakerPriors = buildPriors(localAggregate.speakerCounts, Math.max(1, localAggregate.speechWeight));
  const globalActorPriors = buildPriors(globalAggregate.actorCounts, Math.max(1, globalAggregate.actionWeight));
  const localActorPriors = buildPriors(localAggregate.actorCounts, Math.max(1, localAggregate.actionWeight));

  const speakerPriors: Record<string, number> = {};
  for (const name of new Set([...Object.keys(globalSpeakerPriors), ...Object.keys(localSpeakerPriors)])) {
    speakerPriors[name] = mergeScalar(globalSpeakerPriors[name] ?? 0, localSpeakerPriors[name] ?? 0, speakerBlend);
  }

  const actorPriors: Record<string, number> = {};
  for (const name of new Set([...Object.keys(globalActorPriors), ...Object.keys(localActorPriors)])) {
    actorPriors[name] = mergeScalar(globalActorPriors[name] ?? 0, localActorPriors[name] ?? 0, actorBlend);
  }

  const pronounLabelsByRow: Record<string, string[]> = {};
  for (const pronoun of new Set([
    ...Object.keys(globalAggregate.pronounCounts),
    ...Object.keys(localAggregate.pronounCounts),
  ])) {
    pronounLabelsByRow[pronoun] = allSpeakers.filter((name) =>
      (globalAggregate.pronounCounts[pronoun]?.[name] ?? 0) > 0 ||
      (localAggregate.pronounCounts[pronoun]?.[name] ?? 0) > 0,
    );
  }
  const globalPronounRows = buildDistributionRows(globalAggregate.pronounCounts, pronounLabelsByRow);
  const localPronounRows = buildDistributionRows(localAggregate.pronounCounts, pronounLabelsByRow);
  const pronounSpeakerWeights = mergeDistributions(
    globalPronounRows,
    localPronounRows,
    extractRowWeights(localAggregate.pronounCounts),
  );

  const transitionLabelsByRow: Record<string, string[]> = {};
  for (const speaker of allSpeakers) transitionLabelsByRow[speaker] = allSpeakers;
  const globalTransitionRows = buildDistributionRows(globalAggregate.transitionCounts, transitionLabelsByRow);
  const localTransitionRows = buildDistributionRows(localAggregate.transitionCounts, transitionLabelsByRow);
  const speakerTransitions = mergeDistributions(
    globalTransitionRows,
    localTransitionRows,
    extractRowWeights(localAggregate.transitionCounts),
  );

  const contextCueKeys: Array<keyof LearnedBiasContextCueWeights> = [
    "beforeName",
    "afterName",
    "surroundingName",
    "previousSpeakerCarry",
  ];
  const contextCueWeights = contextCueKeys.reduce<LearnedBiasContextCueWeights>((acc, key) => {
    const globalCue = globalAggregate.contextCueStats[key];
    const localCue = localAggregate.contextCueStats[key];
    const blend = computeBlend(localCue.total);
    acc[key] = mergeScalar(
      smoothedRatio(globalCue.matches, globalCue.total),
      smoothedRatio(localCue.matches, localCue.total),
      blend,
    );
    return acc;
  }, {
    beforeName: 0,
    afterName: 0,
    surroundingName: 0,
    previousSpeakerCarry: 0,
  });

  const chapterWindow = [...chapterWindowMap.values()]
    .sort((a, b) => a.distance - b.distance || b.weightedCorrections - a.weightedCorrections)
    .slice(0, LOCAL_CHAPTER_RADIUS + 1);

  const topSpeakers = [...new Set([
    ...Object.keys(globalAggregate.speakerStats),
    ...Object.keys(localAggregate.speakerStats),
  ])]
    .map((name) => ({
      name,
      globalWeight: globalSpeakerPriors[name] ?? 0,
      localWeight: localSpeakerPriors[name] ?? 0,
      blendedWeight: speakerPriors[name] ?? 0,
      speechCorrections: globalAggregate.speakerStats[name]?.speechCount ?? 0,
      actionCorrections: globalAggregate.speakerStats[name]?.actionCount ?? 0,
    }))
    .sort((a, b) => b.blendedWeight - a.blendedWeight)
    .slice(0, 5);

  return {
    speakerPriors,
    pronounSpeakerWeights,
    speakerTransitions,
    actorPriors,
    contextCueWeights,
    scope: {
      chapterId: options.currentChapterId ?? null,
      chapterRadius: LOCAL_CHAPTER_RADIUS,
      chapterHalfLife: LOCAL_CHAPTER_HALF_LIFE,
      localBlend: computeBlend(localAggregate.totalWeight),
      localCorrectionCount: weightedCorrections.filter(({ localWeight }) => localWeight > 0).length,
      localWeightedSamples: Number(localAggregate.totalWeight.toFixed(2)),
      globalCorrectionCount: corrections.length,
      pronounLocalWeight: Number(localAggregate.pronounSampleWeight.toFixed(2)),
      transitionLocalWeight: Number(localAggregate.transitionSampleWeight.toFixed(2)),
      contextCueLocalWeight: Number(localAggregate.contextCueStats.surroundingName.total.toFixed(2)),
      nearestChapterDistance: chapterWindow.length > 0 ? chapterWindow[0].distance : null,
      effectiveChapterCount: chapterWindow.length,
      contextCueWeights,
      chapterWindow,
      topSpeakers,
    },
    sampleCount: corrections.length,
  };
}

// ── Per-character breakdown helper ────────────────────────────────────────

export interface CharacterBreakdown {
  name: string;
  speechCount: number;
  actionCount: number;
  total: number;
}

/** Returns per-character correction counts, sorted by total descending.
 *  When `chapterId` is provided, only corrections for that chapter are counted. */
export function characterBreakdown(store: AnnotationStore, chapterId?: string | null): CharacterBreakdown[] {
  const corrections = chapterId
    ? store.corrections.filter((c) => c.chapterId === chapterId)
    : store.corrections;
  const map: Record<string, { speechCount: number; actionCount: number }> = {};
  for (const c of corrections) {
    const name = c.correctedSpeaker ?? "(narrative)";
    if (!map[name]) map[name] = { speechCount: 0, actionCount: 0 };
    if (c.spanType === "speech") map[name].speechCount++;
    else map[name].actionCount++;
  }
  return Object.entries(map)
    .map(([name, { speechCount, actionCount }]) => ({
      name,
      speechCount,
      actionCount,
      total: speechCount + actionCount,
    }))
    .sort((a, b) => b.total - a.total);
}
