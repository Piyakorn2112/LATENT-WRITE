import type {
  AdaptiveLearningStore,
  AdaptivePredictionRecord,
  AdaptiveRankModelStore,
  AdaptiveRankTaskModel,
  AdaptiveTask,
} from "../types";

import { saveProjectState, loadProjectState, stateTarget } from "./project-manager";

const KEY = "glass-editor:adaptive-learning-v1";
const MAX_PERSISTED_PREDICTIONS = 2000;

function emptyTaskModel(task: AdaptiveTask): AdaptiveRankTaskModel {
  return {
    task,
    sampleCount: 0,
    learningRate: 0.08,
    l2: 0.0005,
    bias: 0,
    weights: {},
    version: 1,
    lastUpdatedAt: 0,
  };
}

export function emptyAdaptiveModels(): AdaptiveRankModelStore {
  return {
    version: 1,
    speech: emptyTaskModel("speech"),
    action: emptyTaskModel("action"),
    entity: emptyTaskModel("entity"),
  };
}

export function emptyAdaptiveStore(): AdaptiveLearningStore {
  return {
    version: 1,
    predictions: [],
    models: emptyAdaptiveModels(),
  };
}

export function loadAdaptiveStore(): AdaptiveLearningStore {
  if (stateTarget() === "project") return emptyAdaptiveStore();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyAdaptiveStore();
    const parsed = JSON.parse(raw) as AdaptiveLearningStore;
    if (parsed.version !== 1 || !Array.isArray(parsed.predictions) || !parsed.models) {
      return emptyAdaptiveStore();
    }
    const persistedPredictions = (parsed.predictions ?? [])
      .filter((prediction) => prediction.correctedLabel !== undefined)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-MAX_PERSISTED_PREDICTIONS);
    return {
      version: 1,
      predictions: persistedPredictions,
      models: {
        version: 1,
        speech: parsed.models.speech ?? emptyTaskModel("speech"),
        action: parsed.models.action ?? emptyTaskModel("action"),
        entity: parsed.models.entity ?? emptyTaskModel("entity"),
      },
    };
  } catch {
    return emptyAdaptiveStore();
  }
}

export async function loadAdaptiveStoreFromProject(): Promise<AdaptiveLearningStore | null> {
  const data = await loadProjectState<AdaptiveLearningStore>("adaptive");
  if (!data || data.version !== 1 || !Array.isArray(data.predictions) || !data.models) return null;
  return data;
}

export function saveAdaptiveStore(store: AdaptiveLearningStore): void {
  const persisted = {
    ...store,
    predictions: store.predictions
      .filter((prediction) => prediction.correctedLabel !== undefined)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-MAX_PERSISTED_PREDICTIONS),
  };
  if (stateTarget() === "project") {
    // ★ A REFUSED WRITE MUST NOT DROP THE PAYLOAD. The project can close under
    // a live session; route the data to local storage rather than losing it.
    void saveProjectState("adaptive", persisted).then((ok) => { if (!ok) writeLocalAdaptive(persisted); });
    return;
  }
  writeLocalAdaptive(persisted);
}

function writeLocalAdaptive(persisted: AdaptiveLearningStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(persisted));
  } catch {
    /* quota */
  }
}

export function buildAdaptivePredictionKey(
  prediction: Pick<AdaptivePredictionRecord, "chapterId" | "paragraphIndex" | "spanIndex" | "task">,
): string {
  return `${prediction.chapterId}|${prediction.paragraphIndex}|${prediction.spanIndex}|${prediction.task}`;
}

export function upsertAdaptivePredictions(
  store: AdaptiveLearningStore,
  predictions: AdaptivePredictionRecord[],
): AdaptiveLearningStore {
  if (predictions.length === 0) return store;

  const existing = new Map(store.predictions.map((prediction) => [buildAdaptivePredictionKey(prediction), prediction]));
  let changed = false;
  const next = new Map(existing);

  for (const prediction of predictions) {
    const key = buildAdaptivePredictionKey(prediction);
    const prev = existing.get(key);
    const mergedPrediction = prev && prediction.correctedLabel === undefined && prev.correctedLabel !== undefined
      ? { ...prediction, correctedLabel: prev.correctedLabel }
      : prediction;
    const prevSnapshot = prev
      ? JSON.stringify({
          task: prev.task,
          chapterId: prev.chapterId,
          paragraphIndex: prev.paragraphIndex,
          spanIndex: prev.spanIndex,
          spanText: prev.spanText,
          contextBefore: prev.contextBefore,
          contextAfter: prev.contextAfter,
          candidates: prev.candidates,
          predictedLabel: prev.predictedLabel,
          confidence: prev.confidence,
          needsReview: prev.needsReview,
          ambiguityGap: prev.ambiguityGap,
          source: prev.source,
          correctedLabel: prev.correctedLabel,
          modelVersion: prev.modelVersion,
        })
      : null;
    const nextSnapshot = JSON.stringify({
      task: mergedPrediction.task,
      chapterId: mergedPrediction.chapterId,
      paragraphIndex: mergedPrediction.paragraphIndex,
      spanIndex: mergedPrediction.spanIndex,
      spanText: mergedPrediction.spanText,
      contextBefore: mergedPrediction.contextBefore,
      contextAfter: mergedPrediction.contextAfter,
      candidates: mergedPrediction.candidates,
      predictedLabel: mergedPrediction.predictedLabel,
      confidence: mergedPrediction.confidence,
      needsReview: mergedPrediction.needsReview,
      ambiguityGap: mergedPrediction.ambiguityGap,
      source: mergedPrediction.source,
      correctedLabel: mergedPrediction.correctedLabel,
      modelVersion: mergedPrediction.modelVersion,
    });
    if (prevSnapshot === nextSnapshot) continue;
    next.set(key, mergedPrediction);
    changed = true;
  }

  if (!changed) return store;

  const normalized = [...next.values()]
    .filter((prediction) => prediction.correctedLabel !== undefined)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-MAX_PERSISTED_PREDICTIONS);

  return {
    ...store,
    predictions: normalized,
  };
}
