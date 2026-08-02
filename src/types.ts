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

export interface WorldGenericEntity {
  name: string;
  type?: string;
  aliases?: string[];
  description?: string;
}

export interface WorldData {
  characters: WorldCharacter[];
  places: WorldPlace[];
  factions: WorldFaction[];
  entities?: WorldGenericEntity[];
  /**
   * True once the writer has answered (or explicitly skipped) the cold-start
   * cast confirmation for this manuscript. Persisted with the novel so the
   * prompt is asked at most once per book.
   */
  castReviewed?: boolean;
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

export interface LearnedBiasContextCueWeights {
  beforeName: number;
  afterName: number;
  surroundingName: number;
  previousSpeakerCarry: number;
}

export interface LearnedBiasChapterWindow {
  chapterId: string;
  distance: number;
  rawCorrections: number;
  weightedCorrections: number;
}

export interface LearnedBiasSpeakerScope {
  name: string;
  globalWeight: number;
  localWeight: number;
  blendedWeight: number;
  speechCorrections: number;
  actionCorrections: number;
}

export interface LearnedBiasScope {
  chapterId: string | null;
  chapterRadius: number;
  chapterHalfLife: number;
  localBlend: number;
  localCorrectionCount: number;
  localWeightedSamples: number;
  globalCorrectionCount: number;
  pronounLocalWeight: number;
  transitionLocalWeight: number;
  contextCueLocalWeight: number;
  nearestChapterDistance: number | null;
  effectiveChapterCount: number;
  contextCueWeights: LearnedBiasContextCueWeights;
  chapterWindow: LearnedBiasChapterWindow[];
  topSpeakers: LearnedBiasSpeakerScope[];
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
  /**
   * Learned reliability of nearby-name and continuity clues extracted from
   * corrected spans. Used to scale local context bonuses during inference.
   */
  contextCueWeights: LearnedBiasContextCueWeights;
  /** Diagnostics describing how nearby chapters are blended with global data. */
  scope: LearnedBiasScope;
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

// ── Story Graph ───────────────────────────────────────────────────────────

export interface MajorEvent {
  label: string;
  type: "climax" | "transition" | "introduction" | "confrontation" | "revelation" | "scene-break";
  detailType?: string;
  detailLabel?: string;
  detailConfidence?: number;
  tensionPosition: number; // 0–1 position within chapter
  confidence: number;      // 0–1 scoring confidence

  // ── Fields below are written by narrative-events.ts. All optional, because
  //    entries persisted by an earlier version will not carry them.

  /**
   * The clause the event was detected in, verbatim.
   *
   * ★ This used to be computed and then thrown away: story-graph.ts selected a
   * source sentence, derived a label from it, and dropped it. The timeline could
   * therefore show a four-word chip with no way to see what it referred to and no
   * way to check whether it was right. Persisting it is what makes an event
   * inspectable, and it is what the hover card shows.
   */
  sentence?: string;
  /** 0-based paragraph. Needed for click-to-jump; `tensionPosition` alone forces
   *  a lossy round-trip through a fraction of the chapter. */
  paragraphIndex?: number;
  /** Offset of the clause inside its paragraph, for select-and-scroll. */
  offsetInParagraph?: number;
  /** The richer taxonomy from narrative-events.ts (decision, revelation,
   *  state-change…). `type` above stays for the existing colour map. */
  narrativeType?: string;
  /** `major` = a chapter summary would mention it. */
  salience?: "major" | "minor";
  /** Selection order, 0 = the chapter's strongest event. The array is stored in
   *  READING order, so a renderer that slices it selects "earliest" and reads
   *  as "best" — measured at 36.1% vs 47.0% precision on the gold set. Always
   *  select with selectTimelineChips(). Absent on pre-rank stored entries. */
  rank?: number;
  /** Resolved actor. */
  agent?: string;
  /** Which channel found it: an attributed utterance, or narration. */
  channel?: "dialogue" | "narration";
}

/** One local-model chip: a `rank` from the entry's own events, and the label to
 *  show for it. The model may only PICK and RELABEL — see chip-picker.ts. */
export interface TimelineChipPick {
  rank: number;
  label: string;
}

export interface ChapterGraphEntry {
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  /** ChapterRole string — stored as string to avoid cross-module import cycles. */
  role: string;
  tensionPeak: number;    // 0–1 normalized
  tensionCurve: number[]; // 8-point downsampled for sparkline
  charactersPresent: string[];
  wordCount: number;
  proseRegister: string;  // ProseRegister string
  majorEvents: MajorEvent[];
  lastUpdated: number;    // timestamp ms
  contentHash: string;   // cheap dedup key — prevents re-running NLP if content unchanged

  // ── The local model's chip choice. Optional: entries built before the task
  //    existed, and every entry the model has not been asked about, carry
  //    neither field, and every display consumer must render identically then.

  /**
   * Ranks of `majorEvents` the model promoted, with the label to draw. Resolved
   * for display by `selectDisplayChips`; an empty array means the model
   * declined to promote anything and the heuristic chips stand.
   *
   * ★ STALENESS BY RECONSTRUCTION, AND THE ONE PLACE IT DOES NOT HOLD.
   *   `buildChapterEntry` returns a fresh object literal that names every field
   *   it sets, so a rebuild DROPS both of these — a re-analysed chapter cannot
   *   carry chips chosen for its previous events. `enrichChapterEntryWithLM`,
   *   by contrast, returns `{...entry, majorEvents: tagged}`: it PRESERVES
   *   these fields while it prunes and re-ranks the events under them. Today
   *   that is safe because App only ever enriches a freshly built entry. If
   *   that ever changes, `lmChipsKey` is the guard, not this comment.
   */
  lmChips?: TimelineChipPick[];
  /**
   * `chipKeyFor(entry, modelId)` at the moment the picks were written. The
   * caller (the App effect) is what compares it: chips are valid only while it
   * still equals the current key. `selectDisplayChips` cannot check it — it has
   * no model id — so it resolves by rank alone and drops ranks that vanished.
   */
  lmChipsKey?: string;
}

export interface StoryGraph {
  version: 1;
  entries: Record<string, ChapterGraphEntry>; // keyed by chapterId
}

// ── Renderer Review ───────────────────────────────────────────────────────

export interface ReviewFlag {
  type: string;
  quote: string;
  fix: string;
}

export interface ReviewResult {
  chapterId: string;
  model: string;
  timestamp: number;
  flags: ReviewFlag[];
}

export interface AdaptiveInferenceContext {
  store: AdaptiveLearningStore;
  memory: AdaptiveContextMemory;
  reviewThreshold: number;
  minModelSamples: number;
}
