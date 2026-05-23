/**
 * paragraph-risk.ts
 *
 * Scores each paragraph for "review risk" using signals already computed
 * locally, then selects a targeted excerpt for Claude's scan prompt.
 *
 * Used ONLY for /scan (workload reduction): never used for writing commands
 * where full context is always preferred.
 *
 * Risk signals (all local, zero API cost):
 *   local_flag_hit    × 3.0  — sentence was flagged by runLocalReview
 *   tension_high      × 2.0  — paragraph is 'high' tension
 *   tension_rising    × 1.0  — paragraph is 'rising' tension
 *   low_conf_speech   × 1.5  — paragraph has speech attribution < 0.60
 *
 * Selection: pick paragraphs above the risk threshold, plus a 1-paragraph
 * context buffer around each selected paragraph, until the token budget is met.
 */

import type { ChapterParaResult } from './speech-detect';
import type { ReviewFlag } from '../types';

// ── Public types ───────────────────────────────────────────────────────────

export interface ParagraphRiskScore {
  index: number;
  score: number;
  reasons: string[];
}

export interface RiskExcerpt {
  /** Paragraphs included in the excerpt, in original order. */
  paragraphs: string[];
  /** Original indices of the selected paragraphs. */
  selectedIndices: Set<number>;
  /** Estimated character count of the excerpt. */
  charCount: number;
  /** Whether any paragraphs were omitted to fit the budget. */
  truncated: boolean;
}

// ── Scoring ────────────────────────────────────────────────────────────────

/**
 * Score every paragraph by its review risk.
 * A higher score means Claude's review attention is more warranted there.
 */
export function scoreParagraphs(
  paragraphs: string[],
  paraResults: ChapterParaResult[],
  localFlags: ReviewFlag[],
): ParagraphRiskScore[] {
  // Build a set of sentence prefixes (first 60 chars) for fast flag lookup
  const flaggedPhrases = new Set(localFlags.map(f => (f.quote ?? '').slice(0, 60).toLowerCase()));

  return paragraphs.map((para, i): ParagraphRiskScore => {
    const result = paraResults[i];
    let score = 0;
    const reasons: string[] = [];

    // Signal: local flag hit
    const paraLower = para.toLowerCase();
    const flagHits = localFlags.filter(f => {
      const phrase = (f.quote ?? '').slice(0, 60).toLowerCase();
      return phrase.length > 5 && paraLower.includes(phrase);
    }).length;
    if (flagHits > 0) {
      score += flagHits * 3.0;
      reasons.push(`${flagHits} local flag(s)`);
    }

    // Signal: paragraph tension
    if (result) {
      if (result.meta.tension === 'high') {
        score += 2.0;
        reasons.push('high tension');
      } else if (result.meta.tension === 'rising') {
        score += 1.0;
        reasons.push('rising tension');
      }

      // Signal: low-confidence speech attribution
      const lowConfSegs = result.segments.filter(s => s.type === 'speech' && s.confidence > 0 && s.confidence < 0.60);
      if (lowConfSegs.length > 0) {
        score += lowConfSegs.length * 1.5;
        reasons.push(`${lowConfSegs.length} low-conf speech segment(s)`);
      }
    }

    void flaggedPhrases;
    return { index: i, score, reasons };
  });
}

/**
 * Select a targeted excerpt for the scan prompt.
 * Always includes: first paragraph (context) + last paragraph (context)
 * + all paragraphs above the risk threshold within the char budget.
 *
 * @param paragraphs      - full chapter paragraph array
 * @param scores          - from scoreParagraphs()
 * @param maxChars        - character budget (default 12_000 for ~3k tokens)
 * @param minScore        - minimum score to auto-include (default 1.5)
 */
export function selectRiskExcerpt(
  paragraphs: string[],
  scores: ParagraphRiskScore[],
  maxChars = 12_000,
  minScore = 1.5,
): RiskExcerpt {
  if (paragraphs.length === 0) {
    return { paragraphs: [], selectedIndices: new Set(), charCount: 0, truncated: false };
  }

  // Always include first and last paragraphs for context anchoring
  const mustInclude = new Set<number>([0, paragraphs.length - 1]);

  // Add high-risk paragraphs + their neighbors
  const aboveThreshold = scores
    .filter(s => s.score >= minScore)
    .sort((a, b) => b.score - a.score);

  const selected = new Set<number>(mustInclude);
  let charCount = 0;
  for (const idx of mustInclude) charCount += paragraphs[idx].length + 2;

  // Greedily add risk paragraphs + context buffers
  for (const { index: idx } of aboveThreshold) {
    const candidates = [
      Math.max(0, idx - 1),
      idx,
      Math.min(paragraphs.length - 1, idx + 1),
    ];
    const newCost = candidates
      .filter(c => !selected.has(c))
      .reduce((s, c) => s + paragraphs[c].length + 2, 0);
    if (charCount + newCost <= maxChars) {
      for (const c of candidates) selected.add(c);
      charCount += newCost;
    }
    if (charCount >= maxChars * 0.95) break;
  }

  // Fill remaining budget with sequential paragraphs (ensures dense chapters get coverage)
  for (let i = 0; i < paragraphs.length && charCount < maxChars * 0.90; i++) {
    if (!selected.has(i)) {
      const cost = paragraphs[i].length + 2;
      if (charCount + cost <= maxChars) {
        selected.add(i);
        charCount += cost;
      }
    }
  }

  // Build excerpt in original order, with gap markers
  const sortedIndices = [...selected].sort((a, b) => a - b);
  const excerptParagraphs: string[] = [];
  let prev = -1;
  for (const idx of sortedIndices) {
    if (prev >= 0 && idx > prev + 1) {
      excerptParagraphs.push(`[...${idx - prev - 1} paragraph(s) omitted...]`);
    }
    excerptParagraphs.push(paragraphs[idx]);
    prev = idx;
  }

  const totalChars = excerptParagraphs.reduce((s, p) => s + p.length, 0);
  const truncated = selected.size < paragraphs.length;

  return { paragraphs: excerptParagraphs, selectedIndices: selected, charCount: totalChars, truncated };
}
