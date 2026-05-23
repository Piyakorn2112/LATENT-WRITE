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
  let sumSq = 0;
  for (let i = 0; i < DIMENSIONS; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < DIMENSIONS; i++) vec[i] /= norm;
  return vec;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const len = Math.min(left.length, right.length);
  let sum = 0;
  for (let i = 0; i < len; i++) sum += left[i] * right[i];
  return sum;
}

const embeddingCache = new Map<string, number[]>();

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
    let embedding = embeddingCache.get(prediction.id);
    if (!embedding) {
      embedding = embedAdaptiveText(text);
      embeddingCache.set(prediction.id, embedding);
    }
    const score = cosineSimilarity(queryEmbedding, embedding);
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