import type {
  AdaptivePredictionRecord,
  AdaptiveSimilarityMatch,
  AdaptiveTask,
} from "../types";

const DIMENSIONS = 64;

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function tokenizeAdaptiveText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((token) => token.length >= 3);
}

export function embedAdaptiveText(text: string): number[] {
  const vec = new Array<number>(DIMENSIONS).fill(0);
  const tokens = tokenizeAdaptiveText(text);
  for (const token of tokens) {
    const hash = hashToken(token);
    const index = hash % DIMENSIONS;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vec[index] += sign;
  }
  const norm = Math.hypot(...vec) || 1;
  return vec.map((value) => value / norm);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const len = Math.min(left.length, right.length);
  let sum = 0;
  for (let i = 0; i < len; i++) sum += left[i] * right[i];
  return sum;
}

export function retrieveSimilarAdaptivePredictions(
  task: AdaptiveTask,
  queryText: string,
  predictions: AdaptivePredictionRecord[],
  topK = 3,
  minScore = 0.78,
): AdaptiveSimilarityMatch[] {
  const queryEmbedding = embedAdaptiveText(queryText);
  const matches: AdaptiveSimilarityMatch[] = [];

  for (const prediction of predictions) {
    if (prediction.task !== task || prediction.correctedLabel === undefined) continue;
    const text = `${prediction.contextBefore} ${prediction.spanText} ${prediction.contextAfter}`.trim();
    if (!text) continue;
    const score = cosineSimilarity(queryEmbedding, embedAdaptiveText(text));
    if (score < minScore) continue;
    matches.push({
      predictionId: prediction.id,
      correctedLabel: prediction.correctedLabel,
      score,
      task,
    });
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, topK);
}

export function similarityBiasForLabel(
  label: string | null,
  matches: AdaptiveSimilarityMatch[],
): number {
  if (matches.length === 0) return 0;
  let bias = 0;
  for (const match of matches) {
    if (match.correctedLabel === label) bias += match.score * 10;
    else bias -= match.score * 2;
  }
  return Math.max(-8, Math.min(18, bias));
}