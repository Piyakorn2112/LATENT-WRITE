// @ts-nocheck — vendored copy; suppress unused-variable errors from the original source
/**
 * chapter-analysis.ts
 *
 * Structural analysis of a processed chapter — no NLP required.
 * Derives tension arc, event sequence, and character interaction summaries
 * entirely from the signals already computed by speech-detect.ts.
 *
 * All summary generators are template-driven for zero external dependencies.
 *
 * v2 additions:
 *   - ReaderGuidance: predictive + assistive reading strategy advice
 *   - ComparativeIntel: chapter vs running-average comparison
 *   - Edge-case hardening for ultra-short, zero-dialogue, and pure-dialogue chapters
 */

import { ChapterParaResult, IntelligenceLevel } from './speech-detect';

// ── Public types ──────────────────────────────────────────────────────────

/**
 * A4 — Classification of the chapter's tension arc shape.
 * Used for richer summary templates and the Writer Feedback mode.
 */
export type ArcShape =
  | 'slope-up'      // Monotonic rise toward end
  | 'slope-down'    // Monotonic fall from early peak
  | 'plateau-high'  // Sustained high tension ≥ 50% of chapter
  | 'spike'         // Brief intense peak then resolution
  | 'double-peak'   // Two distinct high-tension clusters
  | 'valley'        // Opens tense, calms, returns tense
  | 'flat'          // No significant variance

/**
 * Structural role this chapter plays in the narrative arc.
 * Derived from arcShape, comparative tension, and peak position.
 */
export type ChapterRole =
  | 'climax'      // Peak tension, events dominate, dialogue rapid
  | 'resolution'  // Tension drops from prior high, slower pace
  | 'buildup'     // Tension rising relative to recent average
  | 'breather'    // Tension well below arc average, light pacing
  | 'pivot'       // Calm surface but contains a critical quiet pivot moment
  | 'expository'  // World-building / info-dense, low dialogue
  | 'standard'    // No clear structural role

/**
 * H2 — Vocabulary register classification for the chapter's prose.
 * Used for the register badge and content profile in guidance.
 */
export type ProseRegister =
  | 'literary'      // Long sentences, abstract vocabulary, sparse punctuation
  | 'action'        // Short sentences, physical verbs, high punctuation density
  | 'expository'    // Proper nouns, descriptive clauses, world-building
  | 'introspective' // First-person markers, modal verbs, internal state words
  | 'mixed'

// ── Public interface ──────────────────────────────────────────────────────

export interface ChapterAnalysis {
  /**
   * Normalized tension values (0 = calm, 0.5 = rising, 1 = high),
   * sampled at up to 30 evenly-spaced points, Gaussian-smoothed.
   * Suitable for plotting a sparkline / tension curve.
   */
  tensionCurve: number[];

  /** "The chapter builds gradually…" — arc-level description. */
  timelineSummary: string;

  /** "A confrontation emerges, escalates through…" — event-sequence description. */
  eventSummary: string;

  /** "The interaction is asymmetrical, with Iris holding…" — dialogue dynamics. */
  characterSummary: string;

  /**
   * Full synthesised paragraph that weaves all three summaries together.
   * Shown as the primary display text in the Chapter Intelligence Panel.
   */
  combinedSummary: string;

  /** Highest tension level reached in the chapter. */
  peakTension: 'calm' | 'rising' | 'high';

  /** Label of the most prominent high-tension paragraph (if any). */
  peakLabel?: string;

  /** Per-speaker totals, sorted descending by confidence-weighted character count. */
  speakerCounts: Array<{ name: string; chars: number; turns: number }>;

  /** Predictive reading strategy advice for this chapter. */
  guidance: ReaderGuidance;

  /** Comparative intelligence vs chapter averages (null when no siblings). */
  comparative: ComparativeIntel | null;

  /** A4: Narrative arc shape classification. */
  arcShape: ArcShape;

  /** Structural role this chapter plays in the broader narrative. */
  chapterRole: ChapterRole;

  /** H2: Vocabulary register of the chapter's prose. */
  register: ProseRegister;

  /** Raw register signal strengths — normalized 0-100 — for breakdown visualization. */
  registerSignals: { literary: number; introspective: number; action: number; expository: number };

  /**
   * Actionable writer diagnostics. Empty array if no issues detected.
   * Only populated when writerMode is active.
   */
  writerDiagnostics: WriterDiagnosticItem[];

  /**
   * Deep analysis for writer mode — only computed when intelligenceLevel === 'high'.
   * Contains cause tracing, micro-structure, cognitive load, and attribution stats.
   */
  highModeAnalysis?: HighModeAnalysis;
}

/** A single actionable writer diagnostic item. */
export interface WriterDiagnosticItem {
  /** Short label (e.g. 'LOW_TENSION_CONTRAST') for keying/icons */
  code: string;
  /** Human-readable message writer can act on */
  message: string;
  /** Severity: warning = worth reviewing, info = minor note */
  severity: 'warning' | 'info';
}

/** Actionable reading strategy recommendation. */
export interface ReaderGuidance {
  /** "Dense chapter → slow reading recommended" */
  pacingAdvice: string;
  /** "Tension peaks at ~60% → pay attention there" */
  tensionPeakHint: string;
  /** "Low dialogue → expect internal / system-heavy content" */
  contentProfile: string;
  /** Combined short recommendation sentence */
  readingStrategy: string;
  /** Estimated reading time in minutes (at ~230 WPM) */
  estimatedMinutes: number;
  /** Overall density category */
  density: 'light' | 'moderate' | 'dense';
  /** Tension peak position as percentage (0-100), or null */
  peakPosition: number | null;
}

/** Chapter vs running-average comparison stats. */
export interface ComparativeIntel {
  /** Ratio: this chapter's dialogue density / running avg (1.0 = exactly average) */
  dialogueVsAvg: number;
  /** Ratio: this chapter's tension score / running avg */
  tensionVsAvg: number;
  /** Ratio: this chapter's length / running avg */
  lengthVsAvg: number;
  /** Human-readable dialogue comparison */
  dialogueComparison: string;
  /** Human-readable tension trend */
  tensionTrend: string;
  /** Human-readable pacing comparison */
  paceComparison: string;
}

/** Stats from sibling chapters used for comparative intelligence. */
export interface ChapterStats {
  paragraphCount: number;
  wordCount: number;
  avgDialogueDensity: number;
  avgTensionScore: number;
}

// ── High Mode Analysis ────────────────────────────────────────────────────

/**
 * Cause trace for the tension peak — identifies which paragraph triggered the
 * peak and what structural signals drove it. High mode only.
 */
export interface HighModePeakTrace {
  /** 0-based paragraph index of the triggering paragraph */
  paragraphIndex: number;
  /** Position as 0-100% through chapter */
  position: number;
  /** Signal descriptions, e.g. "dense philosophical exposition", "sustained abstract phrasing" */
  signals: string[];
  /** Human-readable cause sentence */
  description: string;
}

/**
 * A segment of the chapter's tension micro-structure.
 * High mode decomposes the chapter into ~4 segments with individual profiles.
 */
export interface HighModeMicroSegment {
  /** e.g. "opening", "mid-section", "close", or "0–25%" */
  label: string;
  /** Start position as 0-100% */
  from: number;
  /** End position as 0-100% */
  to: number;
  tensionProfile: 'calm' | 'rising' | 'sustained' | 'high';
  description: string;
}

/**
 * Extended deep analysis — only computed when intelligenceLevel === 'high'.
 * Designed to be surfaced progressively in the writer feedback panel.
 */
export interface HighModeAnalysis {
  /** What triggered the peak and which signals contributed */
  peakTrace: HighModePeakTrace | null;
  /** Chapter broken into 3-4 time segments with individual tension readings */
  microStructure: HighModeMicroSegment[];
  /** Quick texture fingerprint of the chapter */
  proseTexture: {
    /** Percentage of paragraphs that contain dialogue (0-100) */
    dialogueRatio: number;
    /** Average words per paragraph */
    avgParaWords: number;
    /** Paragraph length variation: tight = consistent, varied = mixed, expansive = highly variable */
    rhythmLabel: 'tight' | 'varied' | 'expansive';
    /** Percentage of paragraphs under 30 words — punchiness indicator */
    shortParaRatio: number;
    /** Percentage of paragraphs over 100 words — density indicator */
    longParaRatio: number;
  };
  /** Speech attribution confidence overview */
  attributionStats: {
    /** Average confidence across all attributed segments, 0-100 */
    overallConfidence: number;
    /** 0-based paragraph indices where attribution was ambiguous (confidence < 0.50) */
    ambiguousParagraphs: number[];
    highConfidenceCount: number;
    totalAttributed: number;
  };
  /**
   * Intent-based shaping suggestion — null if peak position is already well-grounded
   * or if there is no peak to comment on. Never a "fix this" directive.
   */
  shapingSuggestion: string | null;

  /** Momentum profile per narrative segment — how much the chapter is actually moving. */
  narrativeMomentum: NarrativeMomentum;
  /** Structural vs perceived impact comparison. */
  intentOutcome: IntentOutcomeProfile;
  /** Per-character influence analysis (top-4 speakers). */
  characterInfluence: CharacterInfluence[];
  /**
   * Sensory and action-prose profile — only present in high mode.
   * Read-only signal; never alters speech attribution or tension scoring.
   */
  proseStyle: ProseStyleProfile;
}

// ── High Mode extra analytics ─────────────────────────────────────────────

/** Momentum reading for one narrative segment. */
export interface NarrativeMomentumSegment {
  /** 'opening' | 'mid-section' | 'close' */
  label: string;
  from: number;
  to: number;
  /** 0-1 composite movement score */
  score: number;
  /** Momentum quality */
  trend: 'stuck' | 'progressing' | 'accelerating';
}

/** Chapter-wide narrative momentum derived from tension + dialogue + structure changes. */
export interface NarrativeMomentum {
  segments: NarrativeMomentumSegment[];
  overall: 'stuck' | 'building' | 'fluid' | 'erratic';
  /** High tension segment whose momentum score is below 0.15 — a "fake peak". */
  hasFakePeak: boolean;
  /** Brief contextual note when something notable is detected; null otherwise. */
  note: string | null;
}

/** Comparison of structural signal strength vs estimated narrative felt-impact. */
export interface IntentOutcomeProfile {
  /** 0-1: structural signal (arc shape, role, peak tension) */
  structuralScore: number;
  /** 0-1: estimated felt impact from prose texture signals */
  perceivedScore: number;
  /** 'matched' if within 0.25, 'over-structural' if structure > perceived, 'under-structural' if inverse */
  type: 'matched' | 'over-structural' | 'under-structural';
  message: string;
}

/** Per-character influence in the chapter — not just who talks most. */
export interface CharacterInfluence {
  name: string;
  /** 0-1 composite influence score */
  influenceScore: number;
  /** Dialogue volume share 0-1 */
  presence: number;
  /** Proximity to tension peaks 0-1 */
  tensionProximity: number;
  /** Appears at tension transitions 0-1 */
  narrativeShift: number;
  role: 'dominant' | 'present' | 'peripheral';
}

/** Sensory channels detected in prose. Kinesthetic = body movement; interoception = internal body. */
export type SensoryChannel =
  | 'sight'
  | 'sound'
  | 'touch'
  | 'smell'
  | 'taste'
  | 'interoception'
  | 'kinesthetic';

/**
 * Sensory-detail and action-prose profile for the chapter.
 * High-mode only — costs O(N · vocab) per chapter.
 *
 * Designed to enhance, not replace, existing register / role detection:
 *   - briefLabel  → reader-side single capsule (kept terse, no bloat)
 *   - topChannels + hotspotParagraphs → writer-side deep analysis card
 *   - dominantMode → contributes a small bonus to intentOutcome.perceivedScore
 */
export interface ProseStyleProfile {
  /** Hits per 1000 words for each sensory channel. Values ≥ 0; usually 0–25. */
  channels: Record<SensoryChannel, number>;
  /** 0-1 fraction of paragraphs with ≥2 active sensory channels. */
  sensoryDensity: number;
  /** 0-1 fraction of paragraphs whose dominant mode is action-prose. */
  actionDensity: number;
  /** Single classification for headline display. */
  dominantMode:
    | 'sensory-rich'
    | 'action-driven'
    | 'reflective'
    | 'dialogue-led'
    | 'balanced';
  /** Short reader-facing label (≤ ~70 chars). Renders inside one guidance capsule. */
  briefLabel: string;
  /** Up to 3 paragraph indices with the strongest sensory or action signal. */
  hotspotParagraphs: Array<{
    /** 0-based paragraph index */
    index: number;
    /** Channels active in this paragraph (≥ 1 hit each) */
    channels: SensoryChannel[];
    /** Whether the paragraph reads as action-led or sensory-led */
    signal: 'sensory' | 'action';
  }>;
  /** Top channels (raw count > 0), sorted descending — for deep-panel chips. */
  topChannels: Array<{ channel: SensoryChannel; count: number }>;
  /** Optional one-line shaping note for writer-side. Null when nothing notable. */
  styleNote: string | null;
}

// ── analyzeChapter ────────────────────────────────────────────────────────

/**
 * Runs a full structural analysis over a processed chapter.
 * Safe to call on every chapter change — pure, no side effects.
 *
 * @param paragraphs    Raw paragraph text strings (same array passed to detectSpeechInChapter)
 * @param results       Output of detectSpeechInChapter for the same paragraphs
 * @param siblingStats  Optional stats from neighboring chapters for comparative intel
 */
export function analyzeChapter(
  paragraphs: string[],
  results: ChapterParaResult[],
  siblingStats?: ChapterStats[],
  currentChapterIndex?: number,  // H5: position in arc for positional weighting
  intelligenceLevel?: IntelligenceLevel,
  /** Analysis of the immediately preceding chapter — enables cross-chapter writer diagnostics. */
  prevChapterAnalysis?: ChapterAnalysis,
): ChapterAnalysis {
  const empty: ChapterAnalysis = {
    tensionCurve: [0],
    timelineSummary: 'Not enough content to analyse.',
    eventSummary: 'No events detected.',
    characterSummary: 'No dialogue detected.',
    combinedSummary: 'The chapter contains no analysable content.',
    peakTension: 'calm',
    speakerCounts: [],
    guidance: {
      pacingAdvice: 'Standard reading pace.',
      tensionPeakHint: 'No significant tension peaks.',
      contentProfile: 'Insufficient content to profile.',
      readingStrategy: 'Read at your pace.',
      estimatedMinutes: 0,
      density: 'light',
      peakPosition: null,
    },
    comparative: null,
    arcShape: 'flat',
    chapterRole: 'standard',
    register: 'mixed',
    registerSignals: { literary: 0, introspective: 0, action: 0, expository: 0 },
    writerDiagnostics: [],
  };
  if (results.length === 0) return empty;

  // ── Word count & reading time ────────────────────────────────────────
  const totalWords = paragraphs.reduce((sum, p) => sum + p.split(/\s+/).filter(Boolean).length, 0);
  const estimatedMinutes = Math.max(1, Math.round(totalWords / 230));

  // ── Tension curve (≤ 30 evenly-spaced samples, Gaussian-smoothed) ────────
  const N = Math.min(30, results.length);
  const step = results.length / N;
  const rawCurve = Array.from({ length: N }, (_, i) => {
    const idx = Math.min(Math.round(i * step), results.length - 1);
    const t = results[idx].meta.tension;
    return t === 'high' ? 1 : t === 'rising' ? 0.5 : 0;
  });
  // A6 — Gaussian kernel smoothing (σ=0.8, window 5) - reduced smoothing.
  const SIGMA = 0.8;
  const tensionCurve = rawCurve.map((_, i, a) => {
    let sum = 0, wsum = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(a.length - 1, i + 2); j++) {
      const w = Math.exp(-((j - i) ** 2) / (2 * SIGMA ** 2));
      sum  += a[j] * w;
      wsum += w;
    }
    return sum / wsum;
  });

  // A4 — Arc shape classification
  const arcShape = classifyArcShape(rawCurve);

  // H2 — Prose register detection
  const sents = paragraphs.join(' ').split(/(?<=[.!?])\s+(?=[A-Z"'])/).filter(s => s.trim().length > 3);
  const avgSentenceLength = sents.length > 0
    ? sents.reduce((a, s) => a + s.length, 0) / sents.length
    : 0;
  const allText = paragraphs.join(' ');
  const punctuationDensity = (allText.match(/[,.!?;:—]/g) ?? []).length / Math.max(1, allText.length);
  const avgDialogueDensityForRegister = results.reduce((s, r) => s + r.meta.dialogueDensity, 0) / results.length;
  const { label: register, signals: registerSignals } = detectProseRegister(
    paragraphs, avgSentenceLength, avgDialogueDensityForRegister, punctuationDensity,
  );

  // ── Arc analysis ──────────────────────────────────────────────────────
  // P1: derive peakTension from the RAW (unsmoothed) curve so a single
  // high-tension paragraph isn't averaged away by the Gaussian smoother.
  const rawPeak = rawCurve.length > 0 ? Math.max(...rawCurve) : 0;
  const peakTension: 'calm' | 'rising' | 'high' =
    rawPeak >= 0.85 ? 'high' : rawPeak >= 0.35 ? 'rising' : 'calm';

  // Count paragraphs per tension level (still needed for summaries & guidance)
  const highCount   = results.filter(r => r.meta.tension === 'high').length;
  const risingCount = results.filter(r => r.meta.tension === 'rising').length;
  void risingCount; // used transitively via peakTension but keep for future templates

  const fifth = Math.max(1, Math.ceil(results.length / 5));
  const opensHot  = results.slice(0, fifth).some(r => r.meta.tension !== 'calm');
  const closesHot = results.slice(-fifth).some(r  => r.meta.tension !== 'calm');

  // Which third of the chapter contains the most high-tension paragraphs?
  const third = Math.max(1, Math.ceil(results.length / 3));
  const thirdCounts = [0, 1, 2].map(t =>
    results.slice(t * third, (t + 1) * third).filter(r => r.meta.tension === 'high').length,
  );
  const peakThird = thirdCounts.indexOf(Math.max(...thirdCounts));

  const peakLabel = results.find(r => r.meta.tension === 'high' && r.meta.label)?.meta.label;

  // ── Tension peak position (percentage) ────────────────────────────────
  let peakPosition: number | null = null;
  const firstHighIdx = results.findIndex(r => r.meta.tension === 'high');
  if (firstHighIdx >= 0 && results.length > 1) {
    peakPosition = Math.round((firstHighIdx / (results.length - 1)) * 100);
  }

  // ── Event extraction (from high/rising paragraph labels, in order) ───
  const eventLabels = results
    .filter(r => (r.meta.tension === 'high' || r.meta.tension === 'rising') && r.meta.label)
    .map(r => r.meta.label!);
  const uniqueEvents = [...new Set(eventLabels)];

  // ── Silence / suppression counts ─────────────────────────────────────
  const silenceKw   = ['silence', 'said nothing', 'refused to', 'without a word', 'turned away'];
  const suppressKw  = ['bit back', 'fought the urge', 'swallowed hard', 'carefully controlled',
                       'did not react', 'did not speak', 'did not answer', 'held back',
                       'killing intent', 'suppressed', 'held it in'];
  const silenceCount     = paragraphs.filter(p => silenceKw.some(w => p.toLowerCase().includes(w))).length;
  const suppressionCount = paragraphs.filter(p => suppressKw.some(w => p.toLowerCase().includes(w))).length;

  // ── Speaker analysis — A5: Confidence-Weighted ────────────────────────
  // Each segment's contribution is scaled by attribution confidence.
  // Low-confidence segments (pronoun-resolved, extended-context) count less,
  // preventing skewed speaker distributions in ambiguous prose.
  // Turns only count for high-confidence (≥ 0.60) attributions — turn-switching
  // should reflect intentional dialogue exchange, not uncertain pronoun guesses.
  const speakerCharMap = new Map<string, number>();
  const speakerTurnMap = new Map<string, number>();
  let totalSwitches = 0;
  let lastSpeaker: string | undefined;

  for (const result of results) {
    for (const seg of result.segments) {
      if (seg.type !== 'speech' || !seg.speaker) continue;
      // A5: weight char contribution by confidence (floor 0.30 for any attribution)
      const weight = seg.confidence > 0 ? Math.max(0.30, seg.confidence) : 0.30;
      const weightedChars = (seg.end - seg.start) * weight;
      speakerCharMap.set(seg.speaker, (speakerCharMap.get(seg.speaker) ?? 0) + weightedChars);
      // A5: turns + switches only for sufficiently confident attributions
      if (seg.confidence >= 0.60) {
        speakerTurnMap.set(seg.speaker, (speakerTurnMap.get(seg.speaker) ?? 0) + 1);
        if (lastSpeaker !== undefined && seg.speaker !== lastSpeaker) totalSwitches++;
        lastSpeaker = seg.speaker;
      }
    }
  }

  const speakerCounts = Array.from(speakerCharMap.entries())
    .map(([name, chars]) => ({ name, chars, turns: speakerTurnMap.get(name) ?? 0 }))
    .sort((a, b) => b.chars - a.chars);

  const totalSpeechChars = speakerCounts.reduce((s, x) => s + x.chars, 0);
  const dominant = speakerCounts[0];
  const dominantPct = dominant && totalSpeechChars > 0 ? dominant.chars / totalSpeechChars : 0;
  const avgDialogueDensity = results.reduce((s, r) => s + r.meta.dialogueDensity, 0) / results.length;

  // ── Average tension score (0-1 numeric) ──────────────────────────────
  const avgTensionScore = results.reduce((s, r) => {
    const t = r.meta.tension;
    return s + (t === 'high' ? 1 : t === 'rising' ? 0.5 : 0);
  }, 0) / results.length;

  // ── Density classification ────────────────────────────────────────────
  const avgWordsPerPara = totalWords / Math.max(1, paragraphs.length);
  const density: 'light' | 'moderate' | 'dense' =
    avgWordsPerPara > 120 || (totalWords > 3000 && avgDialogueDensity < 0.15)
      ? 'dense'
      : avgWordsPerPara < 50 || (totalWords < 1200 && avgDialogueDensity > 0.5)
      ? 'light'
      : 'moderate';

  // ── Generate summaries ────────────────────────────────────────────────
  const timelineSummary = buildTimelineSummary(
    peakTension, opensHot, closesHot, peakThird,
    highCount, results.length, peakLabel, silenceCount, suppressionCount, avgDialogueDensity,
    intelligenceLevel, peakPosition, avgTensionScore,
  );
  const eventSummary = buildEventSummary(
    uniqueEvents, peakTension, silenceCount, suppressionCount, avgDialogueDensity,
    intelligenceLevel, peakPosition, highCount, results.length,
  );
  const characterSummary = buildCharacterSummary(
    speakerCounts, dominantPct, totalSwitches, avgDialogueDensity,
    intelligenceLevel, totalSpeechChars,
  );

  // ── Reader guidance ──────────────────────────────────────────────────
  const guidance = buildReaderGuidance(
    density, avgDialogueDensity, peakTension, peakPosition,
    estimatedMinutes, totalSwitches, speakerCounts.length,
    highCount, results.length, avgTensionScore, register,
  );

  // ── Comparative intelligence ──────────────────────────────────────────
  const comparative = siblingStats && siblingStats.length > 0
    ? buildComparativeIntel(
        { paragraphCount: paragraphs.length, wordCount: totalWords, avgDialogueDensity, avgTensionScore },
        siblingStats,
        currentChapterIndex,
      )
    : null;

  // ── Combined summary (uses comparative for context-aware language) ────
  const combinedSummary = buildCombinedSummary(
    peakTension, opensHot, closesHot, highCount, results.length,
    avgDialogueDensity, silenceCount, suppressionCount,
    uniqueEvents, dominant?.name, dominantPct, totalSwitches, comparative,
    arcShape, peakPosition,
  );


  // ── Chapter role classification ──────────────────────────────────────────────────────
  const chapterRole = classifyChapterRole(
    arcShape, peakTension, peakPosition, avgTensionScore,
    comparative, avgDialogueDensity, uniqueEvents, register,
  );

  // ── Writer diagnostics ───────────────────────────────────────────────────────────────
  const writerDiagnostics = buildWriterDiagnostics(
    tensionCurve, rawCurve, arcShape, peakTension, peakPosition,
    avgDialogueDensity, comparative, chapterRole, highCount, results.length,
    speakerCounts, register, prevChapterAnalysis,
  );

  // ── High mode analysis (only when intelligenceLevel === 'high') ───────────────────
  const highModeAnalysis = intelligenceLevel === 'high'
    ? buildHighModeAnalysis(
        paragraphs, results, rawCurve, firstHighIdx, peakPosition, results.length,
        speakerCounts, arcShape, chapterRole,
      )
    : undefined;

  return {
    tensionCurve,
    timelineSummary,
    eventSummary,
    characterSummary,
    combinedSummary,
    peakTension,
    peakLabel,
    speakerCounts,
    guidance,
    comparative,
    arcShape,
    chapterRole,
    register,
    registerSignals,
    writerDiagnostics,
    highModeAnalysis,
  };
}

// ── High mode analysis builder ────────────────────────────────────────────

const ABSTRACT_WORDS = [
  'opacity','transparency','legitimacy','mechanism','institutional','philosophical',
  'existence','consciousness','identity','perception','infrastructure','authority',
  'inevitable','fundamental','conceptual','systematic','theoretical','recursive',
  'abstraction','definition','implication','consequence','assumption','framework',
  'narrative','construct','ambiguity','deliberate','structural','contingent',
];

const EMOTIONAL_WORDS = [
  'fear','grief','rage','dread','horror','terror','despair','anguish','shame',
  'guilt','hope','longing','love','hatred','betrayal','loss','forgiveness',
  'tender','hollow','ache','silence','weight','cold','hollow','broken','fragile',
  'afraid','angry','hurt','numb','empty','tighten','clench','tremble','shudder',
];

// ── Sensory / action prose detection (high-mode only) ────────────────────

/**
 * Lightweight word-list dictionaries per sensory channel. The lists are kept
 * deliberately small — both for performance and to avoid accidental coupling
 * with the tension scorer's vocabulary in speech-detect.ts. Each token is
 * matched as a whole-word boundary substring, lowercased.
 *
 * Multi-word tokens (e.g. "the smell of") are matched as plain substrings
 * because their phrasing already ensures specificity.
 */
const SENSORY_LEXICON: Record<SensoryChannel, readonly string[]> = {
  sight: [
    'gleam','gleamed','glimmer','glimmered','shimmer','shimmered',
    'glow','glowed','glinted','flashed','sparkle','sparkled',
    'shadow','silhouette','reflection','reflected','glanced','watched',
    'stared','peered','squinted','blinked','noticed','observed',
    'amber light','golden light','dim light','pale light','sunlight','moonlight',
    'the colour','the color','the hue','blurred','focused','out of focus',
    'caught his eye','caught her eye','caught their eye',
  ],
  sound: [
    'heard','listening','silence','hushed','quiet',
    'hum','hummed','buzz','buzzed','whir','whirring','rattle','rattled',
    'click','clicked','clatter','clattered','creak','creaked','groan','groaned',
    'whisper','whispered','murmur','murmured','footsteps','footfall',
    'echo','echoed','rang out','rang in','ringing',
    'a sound','the sound of','the noise of','a voice','noise',
    'silent as','distant rumble','low growl','sharp crack',
  ],
  touch: [
    'warm','cool','cold','chill','chilled','hot','feverish',
    'smooth','rough','coarse','soft','hard','solid','firm',
    'damp','wet','dry','sticky','slick','silken','velvet',
    'brushed against','grazed','traced','pressed','pressed against',
    'gripped','grip','clasped','clasp','squeezed','tightened around',
    'the texture','the weight of','the pressure of','her fingertips','his fingertips',
    'their fingertips','calloused','tender','bristled','stinging',
  ],
  smell: [
    'smelled','smelt','scent','scented','aroma','perfume','perfumed',
    'odour','odor','fragrance','reek','reeked','stench','stenches',
    'the smell of','smell of','the scent of','redolent of','the air smelled',
    'whiff of','tinge of','the odour of','musty','woodsmoke',
  ],
  taste: [
    'tasted','tastes','tasting','bitter','sweet','sour','salty','savoury','savory',
    'metallic','coppery','tangy','flavour','flavor','bittersweet',
    'the taste of','sip','sipped','swallowed','tongue',
  ],
  interoception: [
    'heart pounded','heart raced','heart thudded','heartbeat','pulse quickened',
    'pulse slowed','her chest','his chest','their chest','tightness in',
    'breath caught','held her breath','held his breath','their breath',
    'shallow breath','exhaled','inhaled','dizzy','dizziness','lightheaded',
    'nausea','nauseated','queasy','sick to','butterflies',
    'the ache','an ache','aching','exhausted','exhaustion',
    'shivered','shivering','goosebumps','her stomach','his stomach',
    'a knot','knotted','clenched her jaw','clenched his jaw','muscle tensed',
  ],
  kinesthetic: [
    'leaned','leaning','crossed the room','crossed the floor','stepped',
    'pivoted','turned toward','turned away','reached for','reached out',
    'set down','set it down','set the','rose from','rose to','sat down',
    'sat up','straightened','lowered herself','lowered himself','knelt',
    'crouched','sprang','vaulted','strode','paced','pacing',
    'shifted','shifted weight','shoulders rolled','tilted his head','tilted her head',
    'slouched','sprawled','perched','balanced',
  ],
};

/**
 * Action verbs distinct from kinesthetic body-positioning. These are kinetic /
 * confrontational / impact-driven verbs that mark "action-prose" rather than
 * mere movement. Intentionally short and *not* a superset of
 * speech-detect.ts's confrontationVerbs — we sample only the verbs that are
 * clearly physical action (not psychological).
 */
const ACTION_LEXICON: readonly string[] = [
  'struck','strike','striking','slammed','slammed into','smashed','crashed',
  'shoved','yanked','seized','grabbed','tackled','wrestled',
  'lunged','charged','sprinted','dashed','dove','rolled','vaulted',
  'kicked','punched','threw','hurled','flung','tossed',
  'fired','shot','ducked','dodged','deflected','parried',
  'slashed','cut','cut through','sliced','pierced','impaled',
  'shattered','exploded','detonated','collided','rebounded',
  'wrenched','tore','ripped','split open','knocked',
  'leapt','jumped','sprang','twisted','spun','recoiled',
];

interface ParaProseSignal {
  /** Channels with ≥ 1 hit in this paragraph. */
  channels: SensoryChannel[];
  /** Whether this paragraph reads more like action than sensory description. */
  isAction: boolean;
  /** Short-sentence ratio used for action gating. */
  shortRatio: number;
  /** Total sensory hits across all channels. */
  sensoryHits: number;
  /** Total action-verb hits. */
  actionHits: number;
}

interface CompiledLexicon {
  singleWordRe: RegExp | null;
  multiWordPhrases: readonly string[];
}

function compileLexicon(words: readonly string[]): CompiledLexicon {
  const singles: string[] = [];
  const multi: string[] = [];
  for (const w of words) {
    if (w.includes(' ')) multi.push(w);
    else singles.push(w);
  }
  return {
    singleWordRe: singles.length > 0
      ? new RegExp(`\\b(?:${singles.join('|')})\\b`, 'gi')
      : null,
    multiWordPhrases: multi,
  };
}

const COMPILED_SENSORY: Record<SensoryChannel, CompiledLexicon> = {
  sight: compileLexicon(SENSORY_LEXICON.sight),
  sound: compileLexicon(SENSORY_LEXICON.sound),
  touch: compileLexicon(SENSORY_LEXICON.touch),
  smell: compileLexicon(SENSORY_LEXICON.smell),
  taste: compileLexicon(SENSORY_LEXICON.taste),
  interoception: compileLexicon(SENSORY_LEXICON.interoception),
  kinesthetic: compileLexicon(SENSORY_LEXICON.kinesthetic),
};

const COMPILED_ACTION = compileLexicon(ACTION_LEXICON);

/** Per-paragraph signal extraction. Pure, no shared state. */
function scoreProseParagraph(para: string): ParaProseSignal {
  const lower = para.toLowerCase();
  const channels: SensoryChannel[] = [];
  let sensoryHits = 0;
  for (const ch of Object.keys(COMPILED_SENSORY) as SensoryChannel[]) {
    let hits = 0;
    const compiled = COMPILED_SENSORY[ch];
    if (compiled.singleWordRe) {
      compiled.singleWordRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = compiled.singleWordRe.exec(lower)) !== null) hits++;
    }
    for (const phrase of compiled.multiWordPhrases) {
      if (lower.includes(phrase)) hits++;
    }
    if (hits > 0) channels.push(ch);
    sensoryHits += hits;
  }

  let actionHits = 0;
  if (COMPILED_ACTION.singleWordRe) {
    COMPILED_ACTION.singleWordRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = COMPILED_ACTION.singleWordRe.exec(lower)) !== null) actionHits++;
  }
  for (const phrase of COMPILED_ACTION.multiWordPhrases) {
    if (lower.includes(phrase)) actionHits++;
  }

  // Short-sentence ratio — kinetic prose tends to fragment.
  const sents = para.split(/(?<=[.!?])\s+(?=[A-Z"'—])/).filter(s => s.trim().length > 3);
  const shortRatio = sents.length > 0
    ? sents.filter(s => s.trim().length < 60).length / sents.length
    : 0;

  // Action paragraphs: ≥ 2 action verbs OR (≥ 1 action verb AND short-sentence dominance).
  const isAction = actionHits >= 2 || (actionHits >= 1 && shortRatio >= 0.6);

  return { channels, isAction, shortRatio, sensoryHits, actionHits };
}

/**
 * Aggregate per-paragraph signals into a chapter-wide prose-style profile.
 * Returns a fully-formed ProseStyleProfile suitable for both reader brief
 * and writer deep-analysis consumption.
 */
function analyzeProseStyle(
  paragraphs: string[],
  results: ChapterParaResult[],
): ProseStyleProfile {
  const channelCounts: Record<SensoryChannel, number> = {
    sight: 0, sound: 0, touch: 0, smell: 0, taste: 0,
    interoception: 0, kinesthetic: 0,
  };

  const perPara: ParaProseSignal[] = [];
  let totalWords = 0;
  let actionParaCount = 0;
  let multiSensoryParaCount = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    totalWords += para.split(/\s+/).filter(Boolean).length;
    const sig = scoreProseParagraph(para);
    perPara.push(sig);
    for (const ch of sig.channels) channelCounts[ch]++;
    if (sig.isAction) actionParaCount++;
    if (sig.channels.length >= 2) multiSensoryParaCount++;
  }

  const wordsPer1000 = Math.max(1, totalWords) / 1000;
  const channels: Record<SensoryChannel, number> = {
    sight: channelCounts.sight / wordsPer1000,
    sound: channelCounts.sound / wordsPer1000,
    touch: channelCounts.touch / wordsPer1000,
    smell: channelCounts.smell / wordsPer1000,
    taste: channelCounts.taste / wordsPer1000,
    interoception: channelCounts.interoception / wordsPer1000,
    kinesthetic: channelCounts.kinesthetic / wordsPer1000,
  };

  const totalParas = paragraphs.length;
  const actionDensity   = totalParas > 0 ? actionParaCount     / totalParas : 0;
  const sensoryDensity  = totalParas > 0 ? multiSensoryParaCount / totalParas : 0;

  // Top channels (raw count > 0) sorted descending.
  const topChannels = (Object.entries(channelCounts) as Array<[SensoryChannel, number]>)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([channel, count]) => ({ channel, count }));

  // Hotspot paragraphs: prefer multi-channel sensory peaks, then strong action paras.
  type Hotspot = ProseStyleProfile['hotspotParagraphs'][number];
  const sensoryHotspots: Array<Hotspot & { score: number }> = perPara
    .map((sig, idx) => ({
      index: idx,
      channels: sig.channels,
      signal: 'sensory' as const,
      score: sig.channels.length * 2 + sig.sensoryHits,
    }))
    .filter(h => h.channels.length >= 2)
    .sort((a, b) => b.score - a.score);

  const actionHotspots: Array<Hotspot & { score: number }> = perPara
    .map((sig, idx) => ({
      index: idx,
      channels: sig.channels,
      signal: 'action' as const,
      score: sig.actionHits * 1.5 + sig.shortRatio,
    }))
    .filter(h => perPara[h.index].isAction)
    .sort((a, b) => b.score - a.score);

  const merged: Hotspot[] = [
    ...sensoryHotspots.slice(0, 2).map(({ score: _s, ...rest }) => { void _s; return rest; }),
    ...actionHotspots.slice(0, 2).map(({ score: _s, ...rest }) => { void _s; return rest; }),
  ];
  // De-dup by index, keep first occurrence (sensory wins ties).
  const seen = new Set<number>();
  const hotspotParagraphs: Hotspot[] = [];
  for (const h of merged) {
    if (seen.has(h.index)) continue;
    seen.add(h.index);
    hotspotParagraphs.push(h);
    if (hotspotParagraphs.length >= 3) break;
  }

  // Dominant mode classification.
  const avgDialogueDensity = results.length > 0
    ? results.reduce((s, r) => s + r.meta.dialogueDensity, 0) / results.length
    : 0;
  let dominantMode: ProseStyleProfile['dominantMode'];
  if (actionDensity >= 0.30) {
    dominantMode = 'action-driven';
  } else if (sensoryDensity >= 0.30 && actionDensity < 0.18) {
    dominantMode = 'sensory-rich';
  } else if (avgDialogueDensity >= 0.45 && sensoryDensity < 0.18) {
    dominantMode = 'dialogue-led';
  } else if (sensoryDensity < 0.12 && actionDensity < 0.12 && avgDialogueDensity < 0.30) {
    dominantMode = 'reflective';
  } else {
    dominantMode = 'balanced';
  }

  // Reader brief — single short label naming the mode and (when present) top channels.
  const top2 = topChannels.slice(0, 2).map(c => c.channel);
  const channelNames: Record<SensoryChannel, string> = {
    sight: 'sight', sound: 'sound', touch: 'touch', smell: 'smell',
    taste: 'taste', interoception: 'body', kinesthetic: 'movement',
  };
  let briefLabel: string;
  switch (dominantMode) {
    case 'action-driven':
      briefLabel = top2.length >= 1
        ? `Action-driven prose — kinetic with ${channelNames[top2[0]]} cues.`
        : 'Action-driven prose — kinetic and physical.';
      break;
    case 'sensory-rich':
      briefLabel = top2.length >= 2
        ? `Sensory-rich prose — ${channelNames[top2[0]]} and ${channelNames[top2[1]]} foreground.`
        : top2.length === 1
          ? `Sensory-rich prose — ${channelNames[top2[0]]} foreground.`
          : 'Sensory-rich prose — descriptive texture forward.';
      break;
    case 'dialogue-led':
      briefLabel = 'Dialogue-led prose — sensory detail in the background.';
      break;
    case 'reflective':
      briefLabel = 'Reflective prose — interior over sensory or action.';
      break;
    default:
      briefLabel = top2.length >= 1
        ? `Balanced prose — ${channelNames[top2[0]]} present without dominating.`
        : 'Balanced prose — texture and pace evenly distributed.';
  }

  // Writer-side shaping note — surface only when something is actually skewed.
  let styleNote: string | null = null;
  if (dominantMode === 'reflective' && totalParas >= 6 && sensoryDensity < 0.08) {
    styleNote = 'Sensory channels are quiet — readers may experience the chapter at a remove. A grounding sensory beat can re-anchor them.';
  } else if (dominantMode === 'action-driven' && sensoryDensity < 0.08) {
    styleNote = 'Action prose is dense, but sensory channels are thin — the kinetic moments may read as choreographed rather than felt.';
  } else if (
    dominantMode === 'sensory-rich' &&
    avgDialogueDensity < 0.10 &&
    actionDensity < 0.05 &&
    totalParas >= 6
  ) {
    styleNote = 'Sensory texture is strong; consider whether one or two paragraphs would benefit from an action beat or exchange to vary the rhythm.';
  } else if (
    topChannels.length >= 1 &&
    topChannels[0].count >= Math.max(6, Math.round(totalParas * 0.6)) &&
    (topChannels[1]?.count ?? 0) <= topChannels[0].count * 0.3
  ) {
    styleNote = `${channelNames[topChannels[0].channel]} dominates the sensory mix — broadening to a second channel can deepen scene immersion.`;
  }

  return {
    channels,
    sensoryDensity,
    actionDensity,
    dominantMode,
    briefLabel,
    hotspotParagraphs,
    topChannels,
    styleNote,
  };
}

function buildHighModeAnalysis(
  paragraphs: string[],
  results: ChapterParaResult[],
  rawCurve: number[],
  firstHighIdx: number,
  peakPosition: number | null,
  total: number,
  speakerCounts: Array<{ name: string; chars: number; turns: number }>,
  arcShape: ArcShape,
  chapterRole: ChapterRole,
): HighModeAnalysis {

  // ── Peak cause trace ────────────────────────────────────────────────────
  let peakTrace: HighModePeakTrace | null = null;
  if (firstHighIdx >= 0) {
    const para = paragraphs[firstHighIdx] ?? '';
    const words = para.split(/\s+/).filter(Boolean);
    const paraLow = para.toLowerCase();
    const signals: string[] = [];

    // Long sentence density: split on sentence-ending punctuation, avg length
    const sentences = para.split(/[.!?]+/).filter(s => s.trim().length > 10);
    const avgSentLen = sentences.length > 0 ? words.length / sentences.length : 0;
    if (avgSentLen > 30) signals.push('dense philosophical exposition (avg ' + Math.round(avgSentLen) + ' words/sentence)');
    else if (avgSentLen > 20) signals.push('sustained long-form sentences');

    // Abstract vocabulary
    const abstractCount = ABSTRACT_WORDS.filter(w => paraLow.includes(w)).length;
    if (abstractCount >= 3) signals.push('high abstract vocabulary density (' + abstractCount + ' abstract terms)');
    else if (abstractCount >= 1) signals.push('abstract conceptual framing');

    // Emotional keywords
    const emotionalCount = EMOTIONAL_WORDS.filter(w => paraLow.includes(w)).length;
    if (emotionalCount >= 2) signals.push('charged emotional language (' + emotionalCount + ' emotional keywords)');
    else if (emotionalCount === 1) signals.push('emotional undertone present');

    // Dialogue intensity (from results)
    const paraResult = results[firstHighIdx];
    if (paraResult && paraResult.meta.dialogueDensity > 0.55) {
      signals.push('high dialogue intensity');
    } else if (paraResult && paraResult.meta.dialogueDensity > 0.30) {
      signals.push('active dialogue exchange');
    }

    // Label from meta
    if (paraResult?.meta.label) {
      signals.push(`tension label: "${paraResult.meta.label}"`);
    }

    if (signals.length === 0) signals.push('paragraph rhythm and structural weight');

    const pos = peakPosition ?? Math.round((firstHighIdx / Math.max(1, total - 1)) * 100);
    const signalSummary = signals.slice(0, 3).join(', ');
    const range = firstHighIdx >= 2
      ? `paragraphs ${firstHighIdx - 1}–${firstHighIdx + 1}`
      : `the opening paragraphs`;

    peakTrace = {
      paragraphIndex: firstHighIdx,
      position: pos,
      signals,
      description: `Peak driven by ${signalSummary} across ${range}.`,
    };
  }

  // ── Micro-structure (3-4 segments) ─────────────────────────────────────
  const microStructure: HighModeMicroSegment[] = [];
  const segDefs = [
    { label: 'opening',      from: 0,   to: 25  },
    { label: 'mid-section',  from: 25,  to: 65  },
    { label: 'close',        from: 65,  to: 100 },
  ];

  for (const { label, from, to } of segDefs) {
    const startIdx = Math.floor((from / 100) * rawCurve.length);
    const endIdx   = Math.ceil( (to   / 100) * rawCurve.length);
    const slice    = rawCurve.slice(startIdx, endIdx);
    if (slice.length === 0) continue;

    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    const max = Math.max(...slice);
    const profile: HighModeMicroSegment['tensionProfile'] =
      max >= 0.85 ? (avg > 0.6 ? 'sustained' : 'high')
      : avg >= 0.4 ? 'rising'
      : 'calm';

    let desc: string;
    if (profile === 'sustained') desc = `Tension stays elevated throughout the ${label}.`;
    else if (profile === 'high')  desc = `A sharp peak appears in the ${label}.`;
    else if (profile === 'rising') desc = `Tension gradually builds through the ${label}.`;
    else desc = `The ${label} is calm and grounded.`;

    microStructure.push({ label, from, to, tensionProfile: profile, description: desc });
  }

  // ── Prose texture fingerprint ────────────────────────────────────────────
  const quotedParas = paragraphs.filter(p => /["\u201c\u201d]/.test(p)).length;
  const dialogueRatio = Math.round((quotedParas / Math.max(1, paragraphs.length)) * 100);
  const paraWordCounts = paragraphs.map(p => p.split(/\s+/).filter(Boolean).length);
  const avgParaWords = Math.round(paraWordCounts.reduce((a, b) => a + b, 0) / Math.max(1, paraWordCounts.length));
  const mean = avgParaWords;
  const variance = paraWordCounts.reduce((s, w) => s + (w - mean) ** 2, 0) / Math.max(1, paraWordCounts.length);
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
  const rhythmLabel: 'tight' | 'varied' | 'expansive' = cv < 0.45 ? 'tight' : cv < 0.85 ? 'varied' : 'expansive';
  const shortParaRatio = Math.round((paraWordCounts.filter(w => w < 30).length  / Math.max(1, paraWordCounts.length)) * 100);
  const longParaRatio  = Math.round((paraWordCounts.filter(w => w > 100).length / Math.max(1, paraWordCounts.length)) * 100);
  const proseTexture: HighModeAnalysis['proseTexture'] = { dialogueRatio, avgParaWords, rhythmLabel, shortParaRatio, longParaRatio };

  // ── Attribution confidence stats ────────────────────────────────────────
  let totalConf = 0;
  let totalAttr = 0;
  let highConfCount = 0;
  const ambiguousParagraphs: number[] = [];

  for (let i = 0; i < results.length; i++) {
    let hasAmbiguous = false;
    for (const seg of results[i].segments) {
      if (seg.type !== 'speech') continue;
      if (!seg.speaker) continue;
      totalConf += seg.confidence;
      totalAttr++;
      if (seg.confidence >= 0.70) highConfCount++;
      if (seg.confidence < 0.50) hasAmbiguous = true;
    }
    if (hasAmbiguous) ambiguousParagraphs.push(i);
  }
  const overallConfidence = totalAttr > 0 ? Math.round((totalConf / totalAttr) * 100) : 0;

  // ── Shaping suggestion (intent-based, not corrective) ──────────────────
  let shapingSuggestion: string | null = null;
  if (peakPosition !== null && peakPosition < 15) {
    shapingSuggestion = `The peak arrives at ${peakPosition}% — earlier than most readers have had time to orient. If the goal is gradual grounding before intensity, shifting the peak toward 20–35% may improve reader footing without losing the opening energy.`;
  } else if (peakPosition !== null && peakPosition > 88) {
    shapingSuggestion = `The peak lands at ${peakPosition}%, very close to the end. This works well for chapter-closing revelation, but if readers need time to absorb it, a short quiet coda after the peak could help.`;
  }

  // ── Narrative momentum ──────────────────────────────────────────────────
  // Momentum = how much the chapter is actually moving per segment.
  // Score = f(tension delta, dialogue delta between adjacent segments).
  const segDefs2 = [
    { label: 'opening',     from: 0,  to: 25  },
    { label: 'mid-section', from: 25, to: 65  },
    { label: 'close',       from: 65, to: 100 },
  ];
  const segStats = segDefs2.map(({ label, from, to }) => {
    const startIdx = Math.floor((from / 100) * rawCurve.length);
    const endIdx   = Math.ceil( (to   / 100) * rawCurve.length);
    const curveSlice = rawCurve.slice(startIdx, endIdx);
    const resSlice   = results.slice(startIdx, endIdx);
    const avgTension  = curveSlice.length > 0 ? curveSlice.reduce((a, b) => a + b, 0) / curveSlice.length : 0;
    const avgDialogue = resSlice.length > 0
      ? resSlice.reduce((s, r) => s + r.meta.dialogueDensity, 0) / resSlice.length
      : 0;
    return { label, from, to, avgTension, avgDialogue };
  });

  const momentumSegments: NarrativeMomentumSegment[] = segStats.map((seg, i) => {
    const prev = segStats[i - 1];
    const tensionDelta  = prev ? Math.abs(seg.avgTension  - prev.avgTension)  : 0;
    const dialogueDelta = prev ? Math.abs(seg.avgDialogue - prev.avgDialogue) : 0;
    // Opening segment: score from internal tension variance
    let score: number;
    if (i === 0) {
      const startI = Math.floor((seg.from / 100) * rawCurve.length);
      const endI   = Math.ceil( (seg.to   / 100) * rawCurve.length);
      const sl = rawCurve.slice(startI, endI);
      const mu = sl.reduce((a, b) => a + b, 0) / Math.max(1, sl.length);
      const vari = sl.reduce((s, v) => s + (v - mu) ** 2, 0) / Math.max(1, sl.length);
      score = Math.min(1, Math.sqrt(vari) * 3);
    } else {
      score = Math.min(1, 0.6 * tensionDelta * 2.5 + 0.4 * dialogueDelta * 3);
    }
    const trend: NarrativeMomentumSegment['trend'] =
      score < 0.12 ? 'stuck' : score < 0.38 ? 'progressing' : 'accelerating';
    return { label: seg.label, from: seg.from, to: seg.to, score, trend };
  });

  const momentumScores = momentumSegments.map(s => s.score);
  const momentumAvg = momentumScores.reduce((a, b) => a + b, 0) / Math.max(1, momentumScores.length);
  const momentumRange = Math.max(...momentumScores) - Math.min(...momentumScores);
  const overallMomentum: NarrativeMomentum['overall'] =
    momentumAvg < 0.12 ? 'stuck'
    : momentumRange > 0.5 ? 'erratic'
    : momentumAvg < 0.3 ? 'building'
    : 'fluid';

  // Fake peak: a segment with high avg tension but near-zero momentum
  const highTensionSeg = segStats.find(s => s.avgTension >= 0.7);
  const hasFakePeak = !!highTensionSeg && momentumSegments.some(
    m => m.label === highTensionSeg.label && m.score < 0.15,
  );

  let momentumNote: string | null = null;
  if (hasFakePeak) {
    momentumNote = 'Tension metrics suggest a peak, but lack of structural change reduces perceived impact.';
  } else if (overallMomentum === 'stuck') {
    momentumNote = 'High tension, low progression — consider advancing stakes or shifting the scene focus.';
  } else if (overallMomentum === 'erratic') {
    momentumNote = 'Uneven momentum across segments — check for abrupt tonal jumps.';
  }

  const narrativeMomentum: NarrativeMomentum = {
    segments: momentumSegments,
    overall: overallMomentum,
    hasFakePeak,
    note: momentumNote,
  };

  // ── Intent vs Outcome ───────────────────────────────────────────────────
  // Structural score: what the structural signals imply about narrative weight.
  let structuralScore = 0;
  const rawPeakInCurve = rawCurve.length > 0 ? Math.max(...rawCurve) : 0;
  if (rawPeakInCurve >= 0.85) structuralScore += 0.45;
  else if (rawPeakInCurve >= 0.45) structuralScore += 0.25;
  if (chapterRole === 'climax')  structuralScore += 0.30;
  else if (chapterRole === 'buildup') structuralScore += 0.15;
  if (arcShape === 'slope-up' || arcShape === 'plateau-high' || arcShape === 'spike') structuralScore += 0.20;
  else if (arcShape === 'double-peak') structuralScore += 0.10;
  structuralScore = Math.min(1, structuralScore);

  // ── Sensory / action prose-style profile (used both standalone and as a
  //    perceived-impact signal). Computed once before perceivedScore so the
  //    bonus stays bounded.
  const proseStyle = analyzeProseStyle(paragraphs, results);

  // Perceived score: prose texture signals about felt impact.
  let perceivedScore = 0;
  if (avgParaWords < 60)  perceivedScore += 0.30;
  else if (avgParaWords < 100) perceivedScore += 0.18;
  if (dialogueRatio > 55)  perceivedScore += 0.30;
  else if (dialogueRatio > 30) perceivedScore += 0.18;
  if (rhythmLabel === 'varied') perceivedScore += 0.18;
  else if (rhythmLabel === 'expansive') perceivedScore += 0.08;
  if (overallConfidence > 72)  perceivedScore += 0.18;
  else if (overallConfidence > 55) perceivedScore += 0.10;
  // Cross-system enhancement: action-driven or sensory-rich prose adds a small
  // perceived-impact bonus (capped ≤ 0.10 to keep matched/over/under labels stable).
  if (proseStyle.dominantMode === 'action-driven') {
    perceivedScore += Math.min(0.10, proseStyle.actionDensity * 0.20);
  } else if (proseStyle.dominantMode === 'sensory-rich') {
    perceivedScore += Math.min(0.08, proseStyle.sensoryDensity * 0.15);
  }
  perceivedScore = Math.min(1, perceivedScore);

  const diff = structuralScore - perceivedScore;
  const ioType: IntentOutcomeProfile['type'] =
    Math.abs(diff) < 0.22 ? 'matched'
    : diff > 0 ? 'over-structural'
    : 'under-structural';

  let ioMessage: string;
  if (ioType === 'matched') {
    ioMessage = 'Structure and perceived impact are well-aligned.';
  } else if (ioType === 'over-structural') {
    ioMessage = `Tension metrics suggest a climactic weight (${Math.round(structuralScore * 100)}%), but the prose texture reads lighter (${Math.round(perceivedScore * 100)}%). Long or abstract paragraphs may be diffusing the intended impact.`;
  } else {
    ioMessage = `The prose reads with high energy (${Math.round(perceivedScore * 100)}%), but structural signals are subdued (${Math.round(structuralScore * 100)}%). The chapter has more felt urgency than its arc position suggests — which can be a feature.`;
  }

  const intentOutcome: IntentOutcomeProfile = { structuralScore, perceivedScore, type: ioType, message: ioMessage };

  // ── Character influence map (top-4 speakers) ──────────────────────────
  const totalSpeechChars = speakerCounts.reduce((s, x) => s + x.chars, 0);
  // Count high-tension paragraphs total
  const highTensionParaCount = results.filter(r => r.meta.tension !== 'calm').length;
  // Count tension-transition paragraphs: where tension changes from prev
  const transitionCount = results.filter((r, i) =>
    i > 0 && r.meta.tension !== results[i - 1].meta.tension,
  ).length;

  const characterInfluence: CharacterInfluence[] = speakerCounts.slice(0, 4).map(sc => {
    const presence = totalSpeechChars > 0 ? sc.chars / totalSpeechChars : 0;

    // Paragraphs where this speaker has a segment with tension ≠ 'calm'
    let tensionParasWithSpeaker = 0;
    let shiftParasWithSpeaker = 0;
    for (let i = 0; i < results.length; i++) {
      const hasSpeaker = results[i].segments.some(
        seg => seg.type === 'speech' && seg.speaker === sc.name,
      );
      if (!hasSpeaker) continue;
      if (results[i].meta.tension !== 'calm') tensionParasWithSpeaker++;
      if (i > 0 && results[i].meta.tension !== results[i - 1].meta.tension) shiftParasWithSpeaker++;
    }
    const tensionProximity = highTensionParaCount > 0
      ? Math.min(1, tensionParasWithSpeaker / highTensionParaCount)
      : 0;
    const narrativeShift = transitionCount > 0
      ? Math.min(1, shiftParasWithSpeaker / transitionCount)
      : 0;

    const influenceScore = Math.min(1,
      0.33 * presence + 0.40 * tensionProximity + 0.27 * narrativeShift,
    );
    const role: CharacterInfluence['role'] =
      influenceScore >= 0.45 ? 'dominant'
      : influenceScore >= 0.20 ? 'present'
      : 'peripheral';

    return { name: sc.name, influenceScore, presence, tensionProximity, narrativeShift, role };
  });

  return {
    peakTrace,
    microStructure,
    proseTexture,
    attributionStats: {
      overallConfidence,
      ambiguousParagraphs,
      highConfidenceCount: highConfCount,
      totalAttributed: totalAttr,
    },
    shapingSuggestion,
    narrativeMomentum,
    intentOutcome,
    characterInfluence,
    proseStyle,
  };
}

// ── computeChapterStats ───────────────────────────────────────────────────

/**
 * Lightweight stats extraction for a chapter — used to build the sibling
 * context array for comparative intelligence without running full analysis.
 */
export function computeChapterStats(
  paragraphs: string[],
  results: ChapterParaResult[],
): ChapterStats {
  const wordCount = paragraphs.reduce((sum, p) => sum + p.split(/\s+/).filter(Boolean).length, 0);
  const avgDialogueDensity = results.length > 0
    ? results.reduce((s, r) => s + r.meta.dialogueDensity, 0) / results.length
    : 0;
  const avgTensionScore = results.length > 0
    ? results.reduce((s, r) => {
        const t = r.meta.tension;
        return s + (t === 'high' ? 1 : t === 'rising' ? 0.5 : 0);
      }, 0) / results.length
    : 0;
  return { paragraphCount: paragraphs.length, wordCount, avgDialogueDensity, avgTensionScore };
}

// ── Reader guidance builder ───────────────────────────────────────────────

function buildReaderGuidance(
  density: 'light' | 'moderate' | 'dense',
  dialogueDensity: number,
  peakTension: 'calm' | 'rising' | 'high',
  peakPosition: number | null,
  estimatedMinutes: number,
  totalSwitches: number,
  speakerCount: number,
  highCount: number,
  totalParas: number,
  avgTensionScore: number,
  register: ProseRegister,
): ReaderGuidance {
  // Pacing advice
  const pacingAdvice =
    density === 'dense'
      ? 'Dense chapter — slow reading recommended. Take your time with the prose.'
      : density === 'light'
      ? 'Light chapter — flows quickly. Good momentum reading.'
      : 'Moderate density — standard reading pace works well.';

  // Tension peak hint
  let tensionPeakHint: string;
  if (peakPosition !== null && peakTension === 'high') {
    if (peakPosition <= 20) {
      tensionPeakHint = `Tension peaks early (~${peakPosition}%) — the chapter opens with intensity.`;
    } else if (peakPosition >= 80) {
      tensionPeakHint = `Tension peaks late (~${peakPosition}%) — builds toward a climax at the end.`;
    } else {
      tensionPeakHint = `Tension peaks at ~${peakPosition}% — pay attention to the shift there.`;
    }
  } else if (peakTension === 'rising') {
    tensionPeakHint = 'Tension builds gradually — no single sharp peak, but growing pressure.';
  } else {
    tensionPeakHint = 'Calm chapter — no significant tension peaks to watch for.';
  }

  // H2: Content profile uses prose register for a more precise description
  let contentProfile: string;
  switch (register) {
    case 'literary':
      contentProfile = 'Literary prose — long, abstract sentences. Slow down and let the language work.';
      break;
    case 'action':
      contentProfile = 'Action-paced prose — short sentences, physical momentum. Fast reading natural.';
      break;
    case 'introspective':
      contentProfile = 'Introspective chapter — internal monologue dominant. Read attentively for emotional subtext.';
      break;
    case 'expository':
      contentProfile = 'World-building / expository content — dense proper nouns and description.';
      break;
    default:
      // Fallback to dialogue-based profile for mixed register
      if (dialogueDensity < 0.08) {
        contentProfile = 'Very low dialogue — expect narration-heavy, internal, or system-descriptive content.';
      } else if (dialogueDensity < 0.20) {
        contentProfile = 'Low dialogue — primarily narrative with occasional exchanges.';
      } else if (dialogueDensity > 0.60) {
        contentProfile = 'Dialogue-heavy — fast-paced character exchange dominates.';
      } else if (dialogueDensity > 0.40) {
        contentProfile = 'Balanced toward dialogue — active character interaction with narrative framing.';
      } else {
        contentProfile = 'Balanced mix of dialogue and narration.';
      }
  }

  // Combined reading strategy
  const highDensityRatio = highCount / Math.max(1, totalParas);
  let readingStrategy: string;
  if (density === 'dense' && peakTension === 'high') {
    readingStrategy = `~${estimatedMinutes} min read. Dense and intense — engage slowly, the payoff rewards attention.`;
  } else if (density === 'dense' && dialogueDensity < 0.10) {
    readingStrategy = `~${estimatedMinutes} min read. Philosophical or world-building heavy — let the prose breathe.`;
  } else if (density === 'light' && dialogueDensity > 0.50) {
    readingStrategy = `~${estimatedMinutes} min read. Quick dialogue-driven chapter — momentum reading.`;
  } else if (peakTension === 'high' && highDensityRatio > 0.3) {
    readingStrategy = `~${estimatedMinutes} min read. High tension sustained throughout — stay locked in.`;
  } else if (speakerCount >= 4 && totalSwitches > 6) {
    readingStrategy = `~${estimatedMinutes} min read. Multi-voice chapter — track the speakers carefully.`;
  } else {
    readingStrategy = `~${estimatedMinutes} min read. Standard pacing — enjoy the flow.`;
  }

  return {
    pacingAdvice,
    tensionPeakHint,
    contentProfile,
    readingStrategy,
    estimatedMinutes,
    density,
    peakPosition,
  };
}

// ── Comparative intelligence builder ──────────────────────────────────────

function buildComparativeIntel(
  current: ChapterStats,
  siblings: ChapterStats[],
  currentIndex?: number,  // H5: position in arc for expo-proximity weighting
): ComparativeIntel {
  // H5 — Positional weighting: nearby chapters contribute more to the average.
  // Each sibling is weighted by exp(-dist × 0.15) where dist = |i - currentIndex|.
  // When currentIndex is unknown, all siblings are weighted equally.
  const weights = siblings.map((_, i) => {
    if (currentIndex == null) return 1;
    const dist = Math.abs(i - currentIndex);
    return Math.exp(-dist * 0.15);
  });
  const wSum = weights.reduce((s, w) => s + w, 0);

  const wAvgDialogue = siblings.reduce((s, c, i) => s + c.avgDialogueDensity * weights[i], 0) / wSum;
  const wAvgTension  = siblings.reduce((s, c, i) => s + c.avgTensionScore    * weights[i], 0) / wSum;
  const wAvgWords    = siblings.reduce((s, c, i) => s + c.wordCount          * weights[i], 0) / wSum;

  const dialogueVsAvg = wAvgDialogue > 0 ? current.avgDialogueDensity / wAvgDialogue : 1;
  const tensionVsAvg  = wAvgTension  > 0 ? current.avgTensionScore    / wAvgTension  : 1;
  const lengthVsAvg   = wAvgWords    > 0 ? current.wordCount          / wAvgWords    : 1;

  // Dialogue comparison
  let dialogueComparison: string;
  if (dialogueVsAvg > 1.5) {
    dialogueComparison = 'Significantly more dialogue-heavy than average.';
  } else if (dialogueVsAvg > 1.15) {
    dialogueComparison = 'More dialogue than the surrounding chapters.';
  } else if (dialogueVsAvg < 0.5) {
    dialogueComparison = 'Much less dialogue than average — narration-dominant.';
  } else if (dialogueVsAvg < 0.85) {
    dialogueComparison = 'Less dialogue than the surrounding chapters.';
  } else {
    dialogueComparison = 'Dialogue balance is close to the arc average.';
  }

  // Tension trend
  let tensionTrend: string;
  if (tensionVsAvg > 1.6) {
    tensionTrend = 'This chapter is notably more intense than its neighbors.';
  } else if (tensionVsAvg > 1.15) {
    tensionTrend = 'Slightly elevated tension compared to recent chapters.';
  } else if (tensionVsAvg < 0.5 && wAvgTension > 0.1) {
    tensionTrend = 'A breather chapter — tension drops well below the arc average.';
  } else if (tensionVsAvg < 0.85) {
    tensionTrend = 'Calmer than the surrounding chapters.';
  } else {
    tensionTrend = 'Tension level is consistent with the arc average.';
  }

  // Pace comparison
  let paceComparison: string;
  if (lengthVsAvg > 1.35) {
    paceComparison = 'Longer than average — this chapter takes its time.';
  } else if (lengthVsAvg > 1.1) {
    paceComparison = 'Slightly longer than average.';
  } else if (lengthVsAvg < 0.65) {
    paceComparison = 'Noticeably shorter — a compact, fast-paced chapter.';
  } else if (lengthVsAvg < 0.9) {
    paceComparison = 'Shorter than average — brisk pacing.';
  } else {
    paceComparison = 'Length is typical for this arc.';
  }

  return { dialogueVsAvg, tensionVsAvg, lengthVsAvg, dialogueComparison, tensionTrend, paceComparison };
}

// ── Summary builder helpers ───────────────────────────────────────────────

function buildTimelineSummary(
  peak: 'calm' | 'rising' | 'high',
  opensHot: boolean,
  closesHot: boolean,
  peakThird: number,
  highCount: number,
  total: number,
  peakLabel: string | undefined,
  silenceCount: number,
  suppressionCount: number,
  avgDialogueDensity: number,
  intelligenceLevel?: IntelligenceLevel,
  peakPosition?: number | null,
  avgTensionScore?: number,
): string {
  // ── High mode: compact prose, no %, @, arrows ─────────────────────────────
  if (intelligenceLevel === 'high') {
    const highPct = total > 0 ? Math.round((highCount / total) * 100) : 0;
    const opening = opensHot ? 'Opens elevated' : 'Opens calm';
    const closing = closesHot ? 'unresolved close' : 'quieter close';
    const peakPhrase = peakPosition != null
      ? (peakPosition < 33 ? 'peaks early' : peakPosition > 66 ? 'peaks late' : 'peaks near mid-chapter')
      : (peakThird === 0 ? 'peaks early' : peakThird === 2 ? 'peaks late' : 'peaks near mid-chapter');
    if (peak === 'calm') {
      const qual = silenceCount + suppressionCount > 4
        ? 'held in silence and suppression'
        : avgDialogueDensity > 0.5 ? 'carried by conversation' : 'atmospheric accumulation';
      return `${opening}, ${qual}, ${closing}. No high-tension passages.`;
    }
    const tensionDesc = highPct > 40 ? 'High tension through much of the chapter'
      : highPct > 15 ? 'Tension elevated in a significant portion of the chapter'
      : peak === 'rising' ? 'Rising tension throughout'
      : 'Brief tension peak';
    return `${opening}, ${peakPhrase}, ${closing}. ${tensionDesc}.`;
  }

  // ── Default mode: current prose quality with a position number where available ──
  if (intelligenceLevel === 'default' || intelligenceLevel === undefined) {
    if (peak === 'calm') {
      if (silenceCount + suppressionCount > 4)
        return 'The chapter maintains a quiet, restrained register — weight carried through silence rather than confrontation.';
      if (avgDialogueDensity > 0.5)
        return 'The chapter is carried primarily by conversation — tension lives in what is said or withheld.';
      return 'The chapter moves at a reflective, unhurried pace, building meaning through accumulation rather than tension.';
    }
    const labelMap: Record<string, string> = {
      confrontation: 'a direct confrontation', impact: 'a moment of impact',
      'breaking point': 'a breaking point', intense: 'a sharp, fragmented peak',
      pressure: 'a sustained pressure point', 'rapid exchange': 'a rapid, escalating exchange',
      combat: 'a combat sequence', tense: 'a moment of concentrated tension',
    };
    const peakDesc = (peakLabel && labelMap[peakLabel]) ?? 'a tension peak';
    const peakPos  = peakPosition != null
      ? `at ~${peakPosition}%`
      : peakThird === 0 ? 'early' : peakThird === 2 ? 'near its close' : 'at its center';
    const opening  = opensHot ? 'opens under pressure' : 'opens in relative calm';
    const closing  = closesHot ? 'carrying that tension through' : 'settling into quieter ground';
    if (peak === 'rising')
      return `The chapter ${opening}, accumulating pressure that surfaces ${peakPos} before ${closing}.`;
    const density = highCount / total;
    if (density > 0.4)
      return `The chapter sustains high tension through much of its length, anchored by ${peakDesc} ${peakPos}.`;
    return `The chapter ${opening}, arrives at ${peakDesc} ${peakPos}, and ${closing}.`;
  }

  // ── Low mode: brief and general ─────────────────────────────────────────
  if (peak === 'calm') return 'A quiet, measured chapter — no significant tension.';
  const opening = opensHot ? 'Opens tense' : 'Opens calmly';
  const closing = closesHot ? 'ends without resolution' : 'settles at the close';
  return `${opening}, ${peak === 'rising' ? 'builds steadily' : 'peaks ' + (peakThird === 0 ? 'early' : peakThird === 2 ? 'late' : 'mid-chapter')}, ${closing}.`;
}

function buildEventSummary(
  events: string[],
  peak: 'calm' | 'rising' | 'high',
  silenceCount: number,
  suppressionCount: number,
  avgDialogueDensity: number,
  intelligenceLevel?: IntelligenceLevel,
  peakPosition?: number | null,
  highCount?: number,
  total?: number,
): string {
  // ── High mode: terse prose, no %, @, arrows ─────────────────────────────
  if (intelligenceLevel === 'high') {
    if (events.length === 0) {
      if (peak === 'calm') {
        if (silenceCount > 3) return `No discrete events — prolonged silence carries the weight.`;
        if (avgDialogueDensity > 0.4) return 'Dialogue-driven. Tension emerges through exchange, not action.';
        return 'No events detected. Atmospheric and reflective.';
      }
      return 'Diffuse tension without a singular event surface.';
    }
    if (events.length === 1) {
      const tail = suppressionCount > 2 ? `, with ${suppressionCount} suppressed moments` : '';
      return `${events[0].charAt(0).toUpperCase() + events[0].slice(1)}${tail}, unresolved.`;
    }
    const joined = events.length === 2
      ? `${events[0]} leading to ${events[1]}`
      : events.slice(0, -1).join(', leading to ') + ', then ' + events[events.length - 1];
    return `${joined.charAt(0).toUpperCase() + joined.slice(1)}. ${events.length} distinct event types.`;
  }

  // ── Default mode: current behaviour ─────────────────────────────────────
  if (intelligenceLevel === 'default' || intelligenceLevel === undefined) {
    if (events.length === 0) {
      if (peak === 'calm') {
        if (silenceCount > 3) return 'No discrete events — tension accumulates through prolonged silence and withheld speech.';
        if (avgDialogueDensity > 0.4) return 'The chapter is primarily driven by dialogue — tension emerges through conversation rather than scene events.';
        return 'No major events detected. Emotional weight carried through atmosphere and implication.';
      }
      return 'Pressure accumulates without resolving into a named event — tension is sustained and diffuse.';
    }
    const verbMap: Record<string, string> = {
      confrontation: 'a confrontation develops', impact: 'an impact event unfolds',
      'breaking point': 'a breaking point is reached', intense: 'an intense moment surfaces',
      pressure: 'sustained pressure builds', 'rapid exchange': 'a rapid exchange escalates',
      combat: 'a combat sequence unfolds', tense: 'tension concentrates',
      'quiet pivot': 'a quiet but pivotal moment surfaces',
    };
    const firstVerb = verbMap[events[0]] ?? `a moment of ${events[0]} emerges`;
    const cap = firstVerb.charAt(0).toUpperCase() + firstVerb.slice(1);
    if (events.length === 1) {
      const tail = suppressionCount > 2 ? ', charged by suppressed emotion' : '';
      return `${cap}${tail}, leaving an unresolved residue.`;
    }
    const last = events[events.length - 1];
    const endMap: Record<string, string> = {
      'breaking point': 'culminating in a breaking point', pressure: 'settling into sustained pressure',
      confrontation: 'arriving at an open confrontation', intense: 'peaking in sharp fragmentation', combat: 'resolving through combat',
    };
    const lastDesc = endMap[last] ?? `resolving into ${last}`;
    const mid = events.slice(1, -1);
    if (mid.length === 0) {
      const silTail = silenceCount > 2 ? ', held in place by silence' : '';
      return `${cap}, ${lastDesc}${silTail}.`;
    }
    return `${cap}, escalates through ${mid.join(' and ')}, and ${lastDesc}.`;
  }

  // ── Low mode: single-clause ─────────────────────────────────────────────
  if (events.length === 0) return peak === 'calm' ? 'No events. Reflective in nature.' : 'No distinct event — diffuse tension.';
  return events.length === 1 ? `${events[0].charAt(0).toUpperCase() + events[0].slice(1)}.` : `${events[0]} → ${events[events.length - 1]}.`;
}

function buildCharacterSummary(
  speakers: Array<{ name: string; chars: number; turns: number }>,
  dominantPct: number,
  totalSwitches: number,
  avgDialogueDensity: number,
  intelligenceLevel?: IntelligenceLevel,
  totalSpeechChars?: number,
): string {
  if (speakers.length === 0 || avgDialogueDensity < 0.05)
    return intelligenceLevel === 'high'
      ? 'No attributed dialogue — narration dominant.'
      : 'The chapter carries no attributed dialogue — narration holds the entire weight.';

  const dominant  = speakers[0];
  const secondary = speakers[1];

  // ── High mode: compact prose, no percentages ────────────────────────────
  if (intelligenceLevel === 'high') {
    if (speakers.length === 1)
      return `${dominant.name} speaks alone — effectively a monologue (${dominant.turns} turns).`;
    const switchLabel = totalSwitches > 10 ? 'rapid' : totalSwitches > 5 ? 'moderate' : 'sparse';
    const dominanceDesc = dominantPct > 0.65
      ? `${dominant.name} leads with ${dominant.turns} turns`
      : `${dominant.name} (${dominant.turns} turns) and ${secondary?.name ?? 'others'} (${secondary?.turns ?? 0} turns) share the space`;
    return `${dominanceDesc}. ${totalSwitches} exchanges, ${switchLabel} pace.`;
  }

  // ── Default mode: current prose quality ─────────────────────────────────
  if (intelligenceLevel === 'default' || intelligenceLevel === undefined) {
    if (speakers.length === 1)
      return `Only ${dominant.name} speaks — effectively a monologue, with no response from others.`;
    const balance = dominantPct > 0.75 ? 'strongly asymmetrical'
      : dominantPct > 0.6 ? 'asymmetrical' : 'roughly balanced';
    const switchDesc = totalSwitches > 10 ? 'with rapid back-and-forth switching'
      : totalSwitches > 5 ? 'with moderate exchange' : 'with infrequent switching';
    const control = dominantPct > 0.65
      ? `${dominant.name} holds most of the dialogue, shaping its direction`
      : `${dominant.name} and ${secondary?.name ?? 'others'} contribute in roughly equal measure`;
    return `The interaction is ${balance}, ${switchDesc}. ${control}.`;
  }

  // ── Low mode: brief ──────────────────────────────────────────────────────
  if (speakers.length === 1) return `${dominant.name} speaks alone.`;
  const balance = dominantPct > 0.7 ? `${dominant.name} dominant` : 'roughly equal';
  return `${speakers.slice(0, 2).map(s => s.name).join(' and ')} — ${balance}.`;
}

function buildCombinedSummary(
  peak: 'calm' | 'rising' | 'high',
  opensHot: boolean,
  closesHot: boolean,
  highCount: number,
  total: number,
  avgDialogueDensity: number,
  silenceCount: number,
  suppressionCount: number,
  events: string[],
  dominantSpeaker: string | undefined,
  dominantPct: number,
  totalSwitches: number,
  comparative?: ComparativeIntel | null,
  arcShape?: ArcShape,
  peakPosition?: number | null,
): string {
  const highDensity    = highCount / total;
  const dialogueLow    = avgDialogueDensity < 0.15;
  const restraintHeavy = silenceCount + suppressionCount > 4;
  const hasDialogue    = !!dominantSpeaker && avgDialogueDensity >= 0.05;

  // ── Arc progression — what the curve does across the chapter ──────────────
  let arcDesc: string;
  switch (arcShape) {
    case 'slope-up':
      arcDesc = peakPosition != null && peakPosition >= 75
        ? 'tension climbing to a late peak'
        : 'tension building steadily through the chapter';
      break;
    case 'slope-down':
      arcDesc = 'tension receding from an early high';
      break;
    case 'plateau-high':
      arcDesc = 'tension held at a sustained high throughout';
      break;
    case 'spike':
      arcDesc = peakPosition != null
        ? `tension spiking near the ${peakPosition <= 33 ? 'opening' : peakPosition >= 67 ? 'close' : 'middle'} then withdrawing`
        : 'tension spiking briefly then withdrawing';
      break;
    case 'double-peak':
      arcDesc = 'tension peaking twice without full release between them';
      break;
    case 'valley':
      arcDesc = 'tension opening tense, dipping, then returning toward the close';
      break;
    default: // flat or undefined
      arcDesc = restraintHeavy
        ? 'tension held in quiet restraint throughout'
        : dialogueLow
        ? 'tension staying low throughout'
        : 'tension holding relatively flat';
  }

  // ── Comparative qualifier — where this chapter sits in the broader arc ─────
  let comparativeClause = '';
  if (comparative) {
    if (comparative.tensionVsAvg > 1.5)
      comparativeClause = ' — notably more intense than the arc around it';
    else if (comparative.tensionVsAvg < 0.55 && comparative.tensionVsAvg > 0)
      comparativeClause = ' — well below the arc\'s established intensity';
    else if (comparative.dialogueVsAvg > 1.5)
      comparativeClause = ' — more dialogue-dense than the arc average';
    else if (comparative.dialogueVsAvg < 0.55)
      comparativeClause = ' — narration-heavy against surrounding chapters';
  }

  // ── Atmosphere / texture ───────────────────────────────────────────────────
  const textureDesc = restraintHeavy
    ? 'weight carried through restraint and withheld speech'
    : peak === 'high' && highDensity > 0.4
    ? 'intensity sustained without release'
    : peak === 'rising'
    ? 'pressure accumulating beneath the surface'
    : dialogueLow
    ? 'meaning built through atmosphere and implication'
    : avgDialogueDensity > 0.4
    ? 'meaning made through exchange rather than event'
    : 'emotional weight accumulating steadily';

  // Sentence 1: arc shape + comparative context + texture
  const s1 = `${opensHot ? 'Opens' : 'Unfolds'} with ${arcDesc}${comparativeClause}, ${textureDesc}.`;

  // ── Event (compact label) ──────────────────────────────────────────────────
  const verbMap: Record<string, string> = {
    confrontation:    'A confrontation becomes the pivot',
    'rapid exchange': 'A rapid, contested exchange drives the energy',
    'breaking point': 'A breaking point gives the chapter its centre',
    'quiet pivot':    'A quiet shift changes direction beneath the surface',
    impact:           'An impact event marks its turning point',
    combat:           'A combat sequence marks its turning point',
    tense:            'Concentrated tension anchors the chapter',
    pressure:         'Sustained pressure accumulates',
    intense:          'An intense peak surfaces',
  };
  const noEventPhrase = avgDialogueDensity > 0.4
    ? 'No single event marks it'
    : 'No discrete event';
  let eventClause: string;
  if (events.length === 0) {
    eventClause = noEventPhrase;
  } else if (events.length === 1) {
    eventClause = verbMap[events[0]] ?? `A moment of ${events[0]} anchors the chapter`;
  } else {
    const last = events[events.length - 1];
    const endMap: Record<string, string> = {
      'breaking point': 'a breaking point',
      confrontation:    'open confrontation',
      pressure:         'sustained pressure',
      combat:           'combat',
    };
    const first = verbMap[events[0]] ?? `A moment of ${events[0]} surfaces`;
    eventClause = `${first}, escalating to ${endMap[last] ?? last}`;
  }

  // ── Voice dynamics (compact) ──────────────────────────────────────────────
  let voiceClause = '';
  if (hasDialogue) {
    voiceClause = dominantPct > 0.75
      ? `${dominantSpeaker} controls the exchange with little counterweight`
      : dominantPct > 0.55
      ? `${dominantSpeaker} sets the terms; the others hold unequal ground`
      : totalSwitches > 10
      ? 'dialogue fragments into rapid turns'
      : totalSwitches > 6
      ? 'voices contest without clear resolution'
      : 'voices hold their ground in measured succession';
  }

  // ── Close ──────────────────────────────────────────────────────────────────
  const closeClause = closesHot
    ? 'ends open and unresolved'
    : restraintHeavy
    ? 'closes in contained but unresolved tension'
    : peak === 'rising'
    ? 'trails off with pressure still present'
    : 'arrives at quieter, uncertain ground';

  // Sentence 2: [event]; [voice] — close.
  const s2 = hasDialogue && voiceClause
    ? `${eventClause}; ${voiceClause} — it ${closeClause}.`
    : `${eventClause} — it ${closeClause}.`;

  return `${s1} ${s2}`;
}
// ── A4: Arc Shape Classifier ────────────────────────────────────────────────────────────────────

/**
 * Classifies the tension curve into one of 7 narrative arc shapes.
 * Operates on the raw (pre-smoothed) curve for sharper peak detection.
 * One pass over ≤ 30 values — O(N) with tiny constant.
 */
function classifyArcShape(curve: number[]): ArcShape {
  if (curve.length < 3) return 'flat';

  const mid  = Math.floor(curve.length / 2);
  const early = curve.slice(0, mid);
  const late  = curve.slice(mid);
  const avgE  = early.reduce((a, v) => a + v, 0) / early.length;
  const avgL  = late.reduce((a, v) => a + v, 0) / late.length;
  const max   = Math.max(...curve);
  const variance = curve.reduce((s, v) => s + (v - (avgE + avgL) / 2) ** 2, 0) / curve.length;

  if (variance < 0.02) return 'flat';

  const highCount = curve.filter(v => v >= 0.75).length;
  if (highCount / curve.length >= 0.5) return 'plateau-high';

  // Double-peak: two separated clusters of high values
  let inCluster = false, clusterCount = 0;
  for (let i = 0; i < curve.length; i++) {
    if (curve[i] >= 0.6 && !inCluster) { inCluster = true; clusterCount++; }
    if (curve[i] < 0.3 && inCluster)   { inCluster = false; }
  }
  if (clusterCount >= 2) return 'double-peak';

  if (avgE > 0.5 && avgL < 0.2) return 'slope-down';
  if (avgL > 0.5 && avgE < 0.2) return 'slope-up';

  const minVal = Math.min(...curve);
  if (avgE > 0.4 && avgL > 0.4 && minVal < 0.15) return 'valley';

  const peakDuration = curve.filter(v => v >= 0.7).length / curve.length;
  if (peakDuration <= 0.20 && max >= 0.8) return 'spike';

  return avgL > avgE ? 'slope-up' : 'slope-down';
}

// ── H2: Prose Register Detector ───────────────────────────────────────────────────────────────

/**
 * Classifies the prose register using lightweight lexical signals.
 * No external dictionary — marker lists are small and fast.
 */
function detectProseRegister(
  paragraphs: string[],
  avgSentenceLength: number,
  avgDialogueDensity: number,
  punctuationDensity: number,
): { label: ProseRegister; signals: { literary: number; introspective: number; action: number; expository: number } } {
  const text = paragraphs.join(' ').toLowerCase();

  const introspectiveMarkers = [
    'i thought', 'i felt', 'i wondered', 'i realized', 'i remember',
    'my mind', 'within me', 'i could not', 'i would not', 'i had to', 'i needed to',
  ];
  const actionMarkers = [
    'struck', 'dodged', 'lunged', 'sprinted', 'fired', 'blocked',
    'shattered', 'exploded', 'charged', 'slashed', 'detonated', 'collided',
  ];
  const expositoryMarkers = [
    'the kingdom of', 'the city of', 'known as', 'referred to as',
    'had long been', 'for centuries', 'the ancient', 'the northern', 'the eastern',
    'the guild', 'the order', 'the empire',
  ];
  const literaryMarkers = [
    'as though', 'as if', 'like a', 'the weight of', 'the absence of',
    'the distance between', 'something like', 'a kind of', 'in the way that',
  ];

  const score = (markers: string[]) => markers.filter(m => text.includes(m)).length;
  const iScore = score(introspectiveMarkers);
  const aScore = score(actionMarkers);
  const eScore = score(expositoryMarkers);
  const lScore = score(literaryMarkers);

  const rawSignals = [
    { type: 'introspective' as const, v: iScore * 2 + (avgSentenceLength > 80  ? 1 : 0) },
    { type: 'action'        as const, v: aScore * 2 + (punctuationDensity > 0.08 ? 2 : 0) },
    { type: 'expository'    as const, v: eScore * 2 + (avgDialogueDensity < 0.10 ? 1 : 0) },
    { type: 'literary'      as const, v: lScore * 2 + (avgSentenceLength > 130  ? 3 : 0) },
  ].sort((a, b) => b.v - a.v);

  const maxV = Math.max(...rawSignals.map(s => s.v), 1);
  const normalize = (v: number) => Math.round((v / maxV) * 100);
  const signals = {
    literary:      normalize(lScore * 2 + (avgSentenceLength > 130  ? 3 : 0)),
    introspective: normalize(iScore * 2 + (avgSentenceLength > 80   ? 1 : 0)),
    action:        normalize(aScore * 2 + (punctuationDensity > 0.08 ? 2 : 0)),
    expository:    normalize(eScore * 2 + (avgDialogueDensity < 0.10 ? 1 : 0)),
  };

  let label: ProseRegister;
  if (rawSignals[0].v < 3) label = 'mixed';
  else if (rawSignals[0].v - rawSignals[1].v < 2) label = 'mixed';
  else label = rawSignals[0].type;

  return { label, signals };
}
// ── Chapter Role Classifier ──────────────────────────────────────────────

/**
 * Classifies the structural role of this chapter within the narrative arc.
 * Uses arcShape, comparative intel, peak position, dialogue density, and
 * register — no ML required, purely feature-engineered heuristics.
 */
function classifyChapterRole(
  arcShape: ArcShape,
  peakTension: 'calm' | 'rising' | 'high',
  peakPosition: number | null,
  avgTensionScore: number,
  comparative: ComparativeIntel | null,
  avgDialogueDensity: number,
  events: string[],
  register: ProseRegister,
): ChapterRole {
  const tensionVsAvg = comparative?.tensionVsAvg ?? 1;
  const eventful = events.length > 0;
  const nonLiterary = register !== 'literary';
  const shapeCanCarryClimax = eventful || register !== 'literary';
  const sustainedHigh = avgTensionScore >= 0.50;
  const strongOutlier = tensionVsAvg >= 1.30;
  const elevatedOutlier = tensionVsAvg >= 1.10;
  const climacticTexture = register === 'action' || avgDialogueDensity >= 0.18;
  const latePeak = peakPosition != null && peakPosition >= 60;
  const midPeak = peakPosition != null && peakPosition >= 35 && peakPosition <= 70;

  // Resolution: tension drops significantly from arc average, after high tension
  if (
    tensionVsAvg < 0.55 &&
    (comparative?.tensionVsAvg ?? 1) < 0.7 &&
    peakTension !== 'high'
  ) return 'resolution';

  // Breather: tension well below arc average, light pacing
  if (tensionVsAvg < 0.4 && avgDialogueDensity < 0.2) return 'breather';

  // Pivot: quiet turning point or a valley-shaped structural reversal.
  if (
    (events.some(e => e === 'quiet pivot') || arcShape === 'valley') &&
    midPeak &&
    tensionVsAvg >= 0.9 &&
    tensionVsAvg < 1.5
  ) return 'pivot';

  // Expository: world-building register, low dialogue, not a strong tension outlier.
  if (
    register === 'expository' &&
    avgDialogueDensity < 0.15 &&
    (peakTension !== 'high' || (tensionVsAvg < 1.2 && avgTensionScore < 0.45))
  ) return 'expository';

  // Climax: reserve this for the strongest structural peaks, not every spike.
  if (peakTension === 'high' && shapeCanCarryClimax) {
    if (
      arcShape === 'plateau-high' &&
      sustainedHigh &&
      elevatedOutlier
    ) return 'climax';

    if (
      arcShape === 'double-peak' &&
      (
        (sustainedHigh && strongOutlier) ||
        (climacticTexture && avgTensionScore >= 0.44 && tensionVsAvg >= 1.18) ||
        (nonLiterary && avgTensionScore >= 0.42 && tensionVsAvg >= 1.12)
      )
    ) return 'climax';

    if (
      arcShape === 'spike' &&
      (
        (avgTensionScore >= 0.48 && tensionVsAvg >= 1.35) ||
        (climacticTexture && avgTensionScore >= 0.40 && tensionVsAvg >= 1.22) ||
        (nonLiterary && avgTensionScore >= 0.34 && tensionVsAvg >= 1.12)
      )
    ) return 'climax';

    if (
      arcShape === 'slope-up' &&
      avgTensionScore >= 0.58 &&
      strongOutlier
    ) return 'climax';

    if (
      arcShape === 'valley' &&
      sustainedHigh &&
      tensionVsAvg >= 1.6
    ) return 'climax';
  }

  // Buildup: rising or elevated pressure that hasn't earned full climax status.
  if (
    (arcShape === 'slope-up' || arcShape === 'valley' || arcShape === 'double-peak' || arcShape === 'spike') &&
    (elevatedOutlier || peakTension === 'rising' || avgTensionScore >= 0.4)
  ) return 'buildup';

  return 'standard';
}

// ── Writer Diagnostics Builder ────────────────────────────────────────────

/**
 * Produces actionable, writer-facing diagnostic items.
 * Uses the full data pipeline outputs — tension curve, comparative intel,
 * arc shape, and chapter role — to surface issues that are hard to spot
 * by reading the draft alone.
 *
 * Severity guide:
 *   'warning' = real structural issue worth addressing
 *   'info'    = contextual note for the writer's awareness
 */
function buildWriterDiagnostics(
  tensionCurve: number[],
  rawCurve: number[],
  arcShape: ArcShape,
  peakTension: 'calm' | 'rising' | 'high',
  peakPosition: number | null,
  avgDialogueDensity: number,
  comparative: ComparativeIntel | null,
  chapterRole: ChapterRole,
  highCount: number,
  totalParas: number,
  speakerCounts: Array<{ name: string; chars: number; turns: number }>,
  register: ProseRegister,
  prevChapterAnalysis?: ChapterAnalysis,
): WriterDiagnosticItem[] {
  const items: WriterDiagnosticItem[] = [];

  // ── Tension contrast ───────────────────────────────────────────
  if (rawCurve.length >= 3) {
    const curveMax = Math.max(...rawCurve);
    const curveMin = Math.min(...rawCurve);
    const contrast = curveMax - curveMin;
    if (contrast < 0.25) {
      items.push({
        code: 'LOW_TENSION_CONTRAST',
        message: `Tension stays flat throughout (range: ${(contrast * 100).toFixed(0)}%). Consider adding a sharper peak or a moment of release to create contrast.`,
        severity: 'warning',
      });
    } else if (contrast < 0.40 && chapterRole === 'climax') {
      items.push({
        code: 'LOW_CONTRAST_FOR_CLIMAX',
        message: `This chapter is classified as a climax but tension contrast is only ${(contrast * 100).toFixed(0)}%. A climax chapter typically needs a sharper drop before or after its peak.`,
        severity: 'warning',
      });
    }
  }

  // ── Climax detection ───────────────────────────────────────────
  if (peakTension !== 'high' && chapterRole !== 'breather' && chapterRole !== 'resolution') {
    items.push({
      code: 'NO_CLEAR_CLIMAX',
      message: 'No clear tension peak detected. If this is meant to be a significant chapter, consider adding a moment where the prose or dialogue breaks from its established pattern.',
      severity: 'info',
    });
  }

  // ── Peak position ────────────────────────────────────────────
  if (peakTension === 'high' && peakPosition !== null && peakPosition > 85) {
    items.push({
      code: 'LATE_PEAK',
      message: `Tension peaks very late (${peakPosition}%). If this is intentional, ensure there is enough breathing room after — very late peaks can feel cut-off.`,
      severity: 'info',
    });
  }
  if (peakTension === 'high' && peakPosition !== null && peakPosition < 10) {
    items.push({
      code: 'VERY_EARLY_PEAK',
      message: `Tension peaks in the first 10% of the chapter (${peakPosition}%). Readers need context before intensity — consider building slightly before the peak.`,
      severity: 'warning',
    });
  }

  // ── Dialogue drought (comparative) ────────────────────────────
  if (comparative) {
    if (comparative.dialogueVsAvg < 0.45) {
      items.push({
        code: 'LOW_DIALOGUE_EXTENDED',
        message: `Dialogue density is ${((1 - comparative.dialogueVsAvg) * 100).toFixed(0)}% below the arc average. If this is consistent across several chapters, readers may feel disconnected from the characters.`,
        severity: 'warning',
      });
    }
    if (comparative.tensionVsAvg > 2.0) {
      items.push({
        code: 'TENSION_SPIKE_OUTLIER',
        message: `Tension is ${comparative.tensionVsAvg.toFixed(1)}x the arc average — a significant outlier. Ensure the surrounding chapters are building toward this rather than making it feel isolated.`,
        severity: 'info',
      });
    }
    if (comparative.lengthVsAvg < 0.5) {
      items.push({
        code: 'UNUSUALLY_SHORT',
        message: 'This chapter is less than half the arc\'s average length. Short chapters can be powerful, but verify this is intentional — it may feel rushed.',
        severity: 'info',
      });
    }
  }

  // ── Arc shape mismatches ────────────────────────────────────────
  if (arcShape === 'flat' && peakTension === 'high') {
    items.push({
      code: 'FLAT_CURVE_WITH_HIGH_TENSION',
      message: 'High tension paragraphs are present but the overall arc is flat — the tension may be scattered rather than building. Consider grouping intense moments to create a readable peak.',
      severity: 'warning',
    });
  }
  if (arcShape === 'slope-down' && highCount > 0 && (highCount / totalParas) > 0.25) {
    items.push({
      code: 'FRONT_LOADED',
      message: 'Tension is concentrated in the opening and drops throughout. Unless this is a resolution chapter, the second half may lose momentum.',
      severity: 'info',
    });
  }

  // ── Cross-chapter diagnostics (require prevChapterAnalysis) ────────────
  if (prevChapterAnalysis) {

    // PACING_FATIGUE: consecutive climax/buildup chapters without a breather
    const prevRole = prevChapterAnalysis.chapterRole;
    const isHighEnergyRole = (r: ChapterRole) => r === 'climax' || r === 'buildup';
    if (isHighEnergyRole(prevRole) && isHighEnergyRole(chapterRole)) {
      items.push({
        code: 'PACING_FATIGUE',
        message: `Two consecutive chapters with a '${prevRole}' → '${chapterRole}' role. Readers need contrast to feel the peaks — consider a moment of release before re-escalating.`,
        severity: 'warning',
      });
    }

    // SCENE_BLEED: prev chapter ended high-tension AND current opens hot
    const prevCurve = prevChapterAnalysis.tensionCurve;
    const prevEndsHot = prevCurve.length > 0 && prevCurve[prevCurve.length - 1] > 0.45;
    const currentOpensHot = tensionCurve.length > 0 && tensionCurve[0] > 0.45;
    if (prevEndsHot && currentOpensHot) {
      items.push({
        code: 'SCENE_BLEED',
        message: 'The previous chapter ended at high tension and this one opens hot. Without a brief grounding beat, readers lose the sense of scene transition. Consider a short anchor at the start.',
        severity: 'info',
      });
    }

    // CHARACTER_DROPOFF: character dominant in prev chapter nearly absent here
    const prevDominant = prevChapterAnalysis.speakerCounts[0];
    if (prevDominant) {
      const prevTotal = prevChapterAnalysis.speakerCounts.reduce((s, x) => s + x.chars, 0);
      const prevShare = prevTotal > 0 ? prevDominant.chars / prevTotal : 0;
      if (prevShare >= 0.40) {
        const currentTotal = speakerCounts.reduce((s, x) => s + x.chars, 0);
        const currentEntry = speakerCounts.find(s => s.name === prevDominant.name);
        const currentShare = currentTotal > 0 && currentEntry ? currentEntry.chars / currentTotal : 0;
        if (currentShare < 0.10) {
          items.push({
            code: 'CHARACTER_DROPOFF',
            message: `${prevDominant.name} drove ${Math.round(prevShare * 100)}% of dialogue last chapter but is nearly absent here. If intentional, the reader may need acknowledgment of their absence.`,
            severity: 'info',
          });
        }
      }
    }

    // REGISTER_SHIFT: prose register changes at chapter boundary (non-mixed only)
    if (
      prevChapterAnalysis.register !== register &&
      prevChapterAnalysis.register !== 'mixed' &&
      register !== 'mixed'
    ) {
      items.push({
        code: 'REGISTER_SHIFT',
        message: `Prose register shifts from '${prevChapterAnalysis.register}' to '${register}' at this chapter boundary. This can work as intentional tonal contrast — verify it matches the narrative transition.`,
        severity: 'info',
      });
    }
  }

  return items;
}
