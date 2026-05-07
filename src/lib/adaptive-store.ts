import type {
  AdaptiveLearningMetrics,
  AdaptiveLearningMetricsByTask,
  AdaptiveLearningStore,
  AdaptivePredictionRecord,
  AdaptiveRankModelStore,
  AdaptiveRankTaskModel,
  AdaptiveTask,
  AnnotationCorrection,
} from "../types";

const KEY = "glass-editor:adaptive-learning-v1";
const MAX_PERSISTED_PREDICTIONS = 2000;

const TASKS: AdaptiveTask[] = ["speech", "action", "entity"];

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

export function saveAdaptiveStore(store: AdaptiveLearningStore): void {
  try {
    const persisted = {
      ...store,
      predictions: store.predictions
        .filter((prediction) => prediction.correctedLabel !== undefined)
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-MAX_PERSISTED_PREDICTIONS),
    };
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

export function attachCorrectionToAdaptiveStore(
  store: AdaptiveLearningStore,
  correction: AnnotationCorrection,
): AdaptiveLearningStore {
  const targetKey = `${correction.chapterId}|${correction.paragraphIndex}|${correction.spanIndex}|${correction.spanType}`;
  let changed = false;
  const predictions = store.predictions.map((prediction) => {
    if (buildAdaptivePredictionKey(prediction) !== targetKey) return prediction;
    changed = true;
    return {
      ...prediction,
      correctedLabel: correction.correctedSpeaker,
      timestamp: correction.timestamp,
    };
  });
  return changed ? { ...store, predictions } : store;
}

function emptyMetricsByTask(): Record<AdaptiveTask, AdaptiveLearningMetricsByTask> {
  return {
    speech: { predictions: 0, labeled: 0, corrected: 0, meanConfidence: 0, needsReview: 0 },
    action: { predictions: 0, labeled: 0, corrected: 0, meanConfidence: 0, needsReview: 0 },
    entity: { predictions: 0, labeled: 0, corrected: 0, meanConfidence: 0, needsReview: 0 },
  };
}

export function computeAdaptiveMetrics(store: AdaptiveLearningStore): AdaptiveLearningMetrics {
  const byTask = emptyMetricsByTask();
  for (const prediction of store.predictions) {
    const bucket = byTask[prediction.task];
    bucket.predictions += 1;
    bucket.meanConfidence += prediction.confidence;
    if (prediction.needsReview) bucket.needsReview += 1;
    if (prediction.correctedLabel !== undefined) {
      bucket.labeled += 1;
      if (prediction.correctedLabel !== prediction.predictedLabel) bucket.corrected += 1;
    }
  }
  for (const task of TASKS) {
    const bucket = byTask[task];
    bucket.meanConfidence = bucket.predictions > 0 ? bucket.meanConfidence / bucket.predictions : 0;
  }

  const totals = TASKS.reduce(
    (acc, task) => {
      const bucket = byTask[task];
      acc.predictions += bucket.predictions;
      acc.labeled += bucket.labeled;
      acc.corrected += bucket.corrected;
      acc.meanConfidence += bucket.meanConfidence * bucket.predictions;
      acc.needsReview += bucket.needsReview;
      return acc;
    },
    { predictions: 0, labeled: 0, corrected: 0, meanConfidence: 0, needsReview: 0 },
  );

  return {
    predictions: totals.predictions,
    labeled: totals.labeled,
    corrected: totals.corrected,
    meanConfidence: totals.predictions > 0 ? totals.meanConfidence / totals.predictions : 0,
    needsReview: totals.needsReview,
    byTask,
  };
}