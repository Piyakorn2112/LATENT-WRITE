import type {
  AdaptiveCandidateOption,
  AdaptiveLearningStore,
  AdaptivePredictionRecord,
  AdaptiveRankModelStore,
  AdaptiveRankTaskModel,
  AdaptiveTask,
} from "../types";
import { emptyAdaptiveModels } from "./adaptive-store";

export const ADAPTIVE_MIN_MODEL_SAMPLES = 8;
export const ADAPTIVE_REVIEW_THRESHOLD = 0.58;

const TASKS: AdaptiveTask[] = ["speech", "action", "entity"];

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function dot(weights: Record<string, number>, features: Record<string, number>): number {
  let sum = 0;
  for (const [feature, value] of Object.entries(features)) {
    sum += (weights[feature] ?? 0) * value;
  }
  return sum;
}

function subtractFeatures(
  left: Record<string, number>,
  right: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    out[key] = (left[key] ?? 0) - (right[key] ?? 0);
  }
  return out;
}

function cloneModel(model: AdaptiveRankTaskModel): AdaptiveRankTaskModel {
  return {
    ...model,
    weights: { ...model.weights },
  };
}

function taskModel(store: AdaptiveRankModelStore, task: AdaptiveTask): AdaptiveRankTaskModel {
  return store[task];
}

export function scoreAdaptiveAdjustment(
  model: AdaptiveRankTaskModel,
  features: Record<string, number>,
): number {
  if (model.sampleCount < ADAPTIVE_MIN_MODEL_SAMPLES) return 0;
  return model.bias + dot(model.weights, features);
}

export function rankAdaptiveCandidates(
  model: AdaptiveRankTaskModel,
  candidates: AdaptiveCandidateOption[],
): AdaptiveCandidateOption[] {
  const ranked = candidates.map((candidate) => {
    const learnedAdjustment = scoreAdaptiveAdjustment(model, candidate.features);
    return {
      ...candidate,
      learnedAdjustment,
      finalScore: candidate.baseScore + learnedAdjustment,
    };
  });
  ranked.sort((left, right) => right.finalScore - left.finalScore);
  return ranked;
}

export function estimateRankingConfidence(candidates: AdaptiveCandidateOption[]): {
  confidence: number;
  needsReview: boolean;
  ambiguityGap: number;
} {
  if (candidates.length === 0) {
    return { confidence: 0, needsReview: true, ambiguityGap: 0 };
  }
  if (candidates.length === 1) {
    return { confidence: 0.92, needsReview: false, ambiguityGap: candidates[0].finalScore };
  }
  const top = candidates[0].finalScore;
  const second = candidates[1].finalScore;
  const gap = top - second;
  const confidence = sigmoid(gap / 12);
  return {
    confidence,
    needsReview: confidence < ADAPTIVE_REVIEW_THRESHOLD || gap < 4,
    ambiguityGap: gap,
  };
}

export function retrainAdaptiveModels(store: AdaptiveLearningStore): AdaptiveRankModelStore {
  const next = emptyAdaptiveModels();

  for (const task of TASKS) {
    const model = cloneModel(taskModel(next, task));
    const labeled = store.predictions.filter(
      (prediction) => prediction.task === task && prediction.correctedLabel !== undefined,
    );

    for (const prediction of labeled) {
      const positive = prediction.candidates.find((candidate) => candidate.label === prediction.correctedLabel);
      if (!positive) continue;
      const negatives = prediction.candidates.filter((candidate) => candidate.label !== prediction.correctedLabel);
      for (const negative of negatives) {
        const diff = subtractFeatures(positive.features, negative.features);
        const margin = model.bias + dot(model.weights, diff);
        const gradient = 1 - sigmoid(margin);
        model.bias += model.learningRate * gradient;
        for (const [feature, value] of Object.entries(diff)) {
          const current = model.weights[feature] ?? 0;
          model.weights[feature] = current + model.learningRate * ((gradient * value) - model.l2 * current);
        }
        model.sampleCount += 1;
      }
    }

    model.lastUpdatedAt = Date.now();
    model.version = Math.max(1, model.version);
    next[task] = model;
  }

  return next;
}

export function applyOnlineAdaptiveUpdate(
  models: AdaptiveRankModelStore,
  prediction: AdaptivePredictionRecord,
): AdaptiveRankModelStore {
  if (prediction.correctedLabel === undefined) return models;
  const positive = prediction.candidates.find((candidate) => candidate.label === prediction.correctedLabel);
  if (!positive) return models;

  const next: AdaptiveRankModelStore = {
    ...models,
    [prediction.task]: cloneModel(models[prediction.task]),
  } as AdaptiveRankModelStore;
  const model = next[prediction.task];
  const negatives = prediction.candidates.filter((candidate) => candidate.label !== prediction.correctedLabel);

  for (const negative of negatives) {
    const diff = subtractFeatures(positive.features, negative.features);
    const margin = model.bias + dot(model.weights, diff);
    const gradient = 1 - sigmoid(margin);
    model.bias += model.learningRate * gradient;
    for (const [feature, value] of Object.entries(diff)) {
      const current = model.weights[feature] ?? 0;
      model.weights[feature] = current + model.learningRate * ((gradient * value) - model.l2 * current);
    }
    model.sampleCount += 1;
  }

  model.version += 1;
  model.lastUpdatedAt = Date.now();
  return next;
}