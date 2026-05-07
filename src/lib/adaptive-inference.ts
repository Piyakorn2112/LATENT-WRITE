import type {
  AdaptiveCandidateOption,
  AdaptiveContextMemory,
  AdaptiveInferenceContext,
  AdaptiveLearningStore,
  AdaptivePredictionRecord,
  AdaptiveTask,
  WorldData,
} from "../types";
import { buildAdaptiveContextMemory, styleOverlapScore, transitionBiasScore } from "./adaptive-memory";
import {
  ADAPTIVE_MIN_MODEL_SAMPLES,
  ADAPTIVE_REVIEW_THRESHOLD,
  estimateRankingConfidence,
  rankAdaptiveCandidates,
  retrainAdaptiveModels,
} from "./adaptive-ranker";
import { retrieveSimilarAdaptivePredictions, similarityBiasForLabel } from "./adaptive-similarity";

interface RankOptions {
  task: AdaptiveTask;
  spanText: string;
  contextBefore: string;
  contextAfter: string;
  previousSpeaker?: string | null;
}

export function buildAdaptiveInferenceContext(
  store: AdaptiveLearningStore,
  worldData?: WorldData,
): AdaptiveInferenceContext {
  const models = store.models.speech.sampleCount === 0 && store.predictions.some((p) => p.correctedLabel !== undefined)
    ? retrainAdaptiveModels(store)
    : store.models;
  const normalizedStore = models === store.models ? store : { ...store, models };
  return {
    store: normalizedStore,
    memory: buildAdaptiveContextMemory(normalizedStore, worldData),
    reviewThreshold: ADAPTIVE_REVIEW_THRESHOLD,
    minModelSamples: ADAPTIVE_MIN_MODEL_SAMPLES,
  };
}

function memoryBias(
  memory: AdaptiveContextMemory,
  task: AdaptiveTask,
  label: string | null,
  spanText: string,
  previousSpeaker?: string | null,
): number {
  if (!label) return 0;
  const character = memory.characters[label];
  if (!character) return 0;
  const prior = task === "speech"
    ? character.speechCorrections * 0.4
    : task === "action"
    ? character.actionCorrections * 0.45
    : 0;
  const style = task === "speech" ? styleOverlapScore(memory, label, spanText) * 12 : 0;
  const transition = task === "speech" ? transitionBiasScore(memory, previousSpeaker, label) * 10 : 0;
  return Math.min(20, prior + style + transition);
}

export function rerankAdaptiveCandidates(
  context: AdaptiveInferenceContext | undefined,
  candidates: AdaptiveCandidateOption[],
  options: RankOptions,
): {
  candidates: AdaptiveCandidateOption[];
  confidence: number;
  needsReview: boolean;
  ambiguityGap: number;
} {
  if (!context || candidates.length === 0) {
    const sorted = [...candidates].sort((left, right) => right.finalScore - left.finalScore);
    const ranking = estimateRankingConfidence(sorted);
    return { candidates: sorted, ...ranking };
  }

  const model = context.store.models[options.task];
  const query = `${options.contextBefore} ${options.spanText} ${options.contextAfter}`.trim();
  const matches = retrieveSimilarAdaptivePredictions(
    options.task,
    query,
    context.store.predictions,
  );

  const enriched = candidates.map((candidate) => {
    const bias = memoryBias(
      context.memory,
      options.task,
      candidate.label,
      options.spanText,
      options.previousSpeaker,
    ) + similarityBiasForLabel(candidate.label, matches);
    return {
      ...candidate,
      learnedAdjustment: candidate.learnedAdjustment + bias,
      finalScore: candidate.baseScore + bias,
      evidence: [
        ...(candidate.evidence ?? []),
        ...(bias !== 0 ? [`memory=${bias.toFixed(2)}`] : []),
      ],
    };
  });

  const ranked = rankAdaptiveCandidates(model, enriched).map((candidate) => ({
    ...candidate,
    evidence: [
      ...(candidate.evidence ?? []),
      ...(candidate.learnedAdjustment !== 0 ? [`model=${candidate.learnedAdjustment.toFixed(2)}`] : []),
    ],
  }));
  const ranking = estimateRankingConfidence(ranked);
  return {
    candidates: ranked,
    confidence: ranking.confidence,
    needsReview: ranking.confidence < context.reviewThreshold || ranking.needsReview,
    ambiguityGap: ranking.ambiguityGap,
  };
}

export function buildAdaptivePredictionRecord(
  trace: Omit<AdaptivePredictionRecord, "id" | "timestamp" | "modelVersion">,
): AdaptivePredictionRecord {
  return {
    ...trace,
    id: `${trace.chapterId}:${trace.task}:${trace.paragraphIndex}:${trace.spanIndex}`,
    timestamp: Date.now(),
    modelVersion: 1,
  };
}