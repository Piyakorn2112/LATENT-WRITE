export interface Chapter {
  id: string;
  number: number;
  title: string;
  content: string;
}

export interface NovelMeta {
  title: string;
  subtitle?: string;
  author: string;
  description: string;
}

// ── World data — characters, places, factions ─────────────────────────────
// Mirrors the novel-reader's worldData JSON shape so the same speech-detect
// + entity-highlight pipeline can be fed by it.
export interface WorldCharacter {
  name: string;
  aliases?: string[];
  role?: string;
  description?: string;
}

export interface WorldPlace {
  name: string;
  type?: string;
  aliases?: string[];
  description?: string;
}

export interface WorldFaction {
  name: string;
  type?: string;
  aliases?: string[];
  description?: string;
}

export interface WorldData {
  characters: WorldCharacter[];
  places: WorldPlace[];
  factions: WorldFaction[];
}

export interface Novel {
  meta: NovelMeta;
  chapters: Chapter[];
  worldData?: WorldData;
}

// ── Annotation system ─────────────────────────────────────────────────────

/** A single user correction: who is really speaking or acting at this span. */
export interface AnnotationCorrection {
  /** Unique id so merges can deduplicate. */
  id: string;
  timestamp: number;
  chapterId: string;
  /** 0-based index into the analysed paragraph array for the chapter. */
  paragraphIndex: number;
  /** 0-based index of the speech segment, or the action span start offset. */
  spanIndex: number;
  spanType: "speech" | "action";
  /** Original attribution before the user corrected it (null = unattributed). */
  originalSpeaker: string | null;
  /** What the user selected as the correct attribution (null = narrative / none). */
  correctedSpeaker: string | null;
  /** Text of the span that was corrected (for display in the export). */
  spanText: string;
  /** Up to 80 chars of prose immediately before the span. */
  contextBefore: string;
  /** Up to 80 chars of prose immediately after the span. */
  contextAfter: string;
}

export interface AnnotationStore {
  version: 1;
  corrections: AnnotationCorrection[];
}

/**
 * Learned biases derived from the annotation store. Applied additively to
 * speech-detect and action-detect — when undefined or zeroed every value
 * reduces to identity (no-op on the existing pipeline).
 */
export interface LearnedBias {
  /**
   * Additive boost applied to speakWeights initialisation.
   * `speakerPriors["Alice"] = 2.5` → Alice starts with a 2.5 head-start in
   * the Markov recency map (vs 0 for un-corrected names).
   */
  speakerPriors: Record<string, number>;
  /**
   * Pronoun-to-speaker learned weights.
   * `pronounSpeakerWeights["she"]["Alice"] = 0.8` means 80 % of times the
   * model saw "she" the user said the speaker was Alice.
   * Applied as a multiplier on each candidate's score during Tier-3 resolution.
   */
  pronounSpeakerWeights: Record<string, Record<string, number>>;
  /**
   * Bigram transition weights: P(next speaker | prev speaker).
   * `speakerTransitions["Alice"]["Bob"] = 0.6` boosts Bob when Alice spoke last.
   * Laplace-smoothed. Applied to Tier-4 extended context scoring.
   */
  speakerTransitions: Record<string, Record<string, number>>;
  /**
   * Frequency-based actor priors for action detection.
   * `actorPriors["Alice"] = 1.8` boosts Alice as an actor tiebreaker.
   */
  actorPriors: Record<string, number>;
  /** How many corrections were used to compute this bias. */
  sampleCount: number;
}

/**
 * Payload emitted when the user clicks a speech or action span in annotation mode.
 * Used by HighlightLayer → AnnotationPopover → App to record a correction.
 */
export interface AnnotationTarget {
  paragraphIndex: number;
  /** For speech spans: the 0-based index of the segment in sorted order.
   *  For action spans: the para-relative character offset of the span start. */
  spanIndex: number;
  spanType: "speech" | "action";
  currentSpeaker: string | null;
  spanText: string;
  contextBefore: string;
  contextAfter: string;
}

// ── Adaptive learning layer ──────────────────────────────────────────────

export type AdaptiveTask = "speech" | "action" | "entity";

export type AdaptiveFeatureMap = Record<string, number>;

export interface AdaptiveCandidateOption {
  label: string | null;
  source: string;
  baseScore: number;
  learnedAdjustment: number;
  finalScore: number;
  features: AdaptiveFeatureMap;
  evidence?: string[];
}

export interface AdaptivePredictionTrace {
  task: AdaptiveTask;
  paragraphIndex: number;
  spanIndex: number;
  spanText: string;
  contextBefore: string;
  contextAfter: string;
  candidates: AdaptiveCandidateOption[];
  predictedLabel: string | null;
  confidence: number;
  needsReview: boolean;
  ambiguityGap: number;
  source: string;
}

export interface AdaptivePredictionRecord extends AdaptivePredictionTrace {
  id: string;
  chapterId: string;
  timestamp: number;
  correctedLabel?: string | null;
  modelVersion: number;
}

export interface AdaptiveRankTaskModel {
  task: AdaptiveTask;
  sampleCount: number;
  learningRate: number;
  l2: number;
  bias: number;
  weights: Record<string, number>;
  version: number;
  lastUpdatedAt: number;
}

export interface AdaptiveRankModelStore {
  version: 1;
  speech: AdaptiveRankTaskModel;
  action: AdaptiveRankTaskModel;
  entity: AdaptiveRankTaskModel;
}

export interface AdaptiveCharacterMemory {
  name: string;
  speechCorrections: number;
  actionCorrections: number;
  styleTokens: Record<string, number>;
  interactionCounts: Record<string, number>;
}

export interface AdaptiveContextMemory {
  sampleCount: number;
  characters: Record<string, AdaptiveCharacterMemory>;
  speakerTransitions: Record<string, Record<string, number>>;
}

export interface AdaptiveSimilarityMatch {
  predictionId: string;
  correctedLabel: string | null;
  score: number;
  task: AdaptiveTask;
}

export interface AdaptiveLearningMetricsByTask {
  predictions: number;
  labeled: number;
  corrected: number;
  meanConfidence: number;
  needsReview: number;
}

export interface AdaptiveLearningMetrics {
  predictions: number;
  labeled: number;
  corrected: number;
  meanConfidence: number;
  needsReview: number;
  byTask: Record<AdaptiveTask, AdaptiveLearningMetricsByTask>;
}

export interface AdaptiveLearningStore {
  version: 1;
  predictions: AdaptivePredictionRecord[];
  models: AdaptiveRankModelStore;
}

export interface AdaptiveInferenceContext {
  store: AdaptiveLearningStore;
  memory: AdaptiveContextMemory;
  reviewThreshold: number;
  minModelSamples: number;
}
