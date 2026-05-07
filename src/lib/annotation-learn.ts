/**
 * annotation-learn.ts
 *
 * Derives a LearnedBias from the annotation store using three NLP-inspired
 * techniques adapted to the fiction speaker-attribution domain:
 *
 *   1. Frequency Priors
 *      Each corrected speaker name receives a prior proportional to how
 *      often the user assigned it. Applied as an additive boost to the
 *      Markov speakWeights initialisation, so frequently-corrected characters
 *      start every chapter with a non-zero recency lead.
 *
 *   2. Pronoun Posteriors (Bayesian speaker diarization)
 *      For each correction, extract any gendered/neutral pronoun (he/she/they
 *      etc.) from contextBefore. Build P(speaker | pronoun) by normalising
 *      per-pronoun counts. speech-detect multiplies each Tier-3 candidate's
 *      score by these weights, nudging resolution toward the user's pattern.
 *
 *   3. Speaker Bigram Transitions
 *      Sort all corrections by (chapterId, paragraphIndex). Build a
 *      transition count matrix: count[prevSpeaker][nextSpeaker]++.
 *      Apply Laplace smoothing (+ 0.5) and row-normalise to probabilities.
 *      speech-detect applies these as multiplicative boosts during Tier-4
 *      extended context scoring — characters who frequently follow each other
 *      in the user's corrected data get promoted in ambiguous multi-speaker runs.
 *
 *   4. Actor Priors (action-detect)
 *      Same frequency logic as (1) but built from corrections where
 *      spanType === "action". Feeds attributeActor() as a tiebreaker boost.
 *
 * All signals default to identity (1× or 0 additive) when no data exists,
 * so the existing pipeline is entirely unaffected until LEARN_THRESHOLD
 * corrections accumulate.
 */

import type { AnnotationCorrection, AnnotationStore, LearnedBias, WorldData } from "../types";

/** Minimum corrections before any bias is computed. */
export const LEARN_THRESHOLD = 10;

/** Scale factor for speaker/actor priors (added to speakWeights init). */
const PRIOR_SCALE = 5;

// Pronoun classes used for contextual extraction.
const PRONOUN_RE = /\b(he|she|they|him|her|them|his|hers|their)\b/i;

export function computeLearnedBias(
  store: AnnotationStore,
  _worldData: WorldData | undefined,
): LearnedBias | null {
  const { corrections } = store;
  if (corrections.length < LEARN_THRESHOLD) return null;

  const speechCorrections = corrections.filter(
    (c) => c.spanType === "speech" && c.correctedSpeaker !== null,
  ) as (AnnotationCorrection & { correctedSpeaker: string })[];

  const actionCorrections = corrections.filter(
    (c) => c.spanType === "action" && c.correctedSpeaker !== null,
  ) as (AnnotationCorrection & { correctedSpeaker: string })[];

  // ── 1. Frequency priors ─────────────────────────────────────────────────
  const speakerCounts: Record<string, number> = {};
  for (const c of speechCorrections) {
    speakerCounts[c.correctedSpeaker] = (speakerCounts[c.correctedSpeaker] ?? 0) + 1;
  }
  const totalSpeech = speechCorrections.length || 1;
  const speakerPriors: Record<string, number> = {};
  for (const [name, count] of Object.entries(speakerCounts)) {
    speakerPriors[name] = (count / totalSpeech) * PRIOR_SCALE;
  }

  // ── 2. Pronoun posteriors ───────────────────────────────────────────────
  // pronounCounts[pronoun][speaker] = raw count
  const pronounCounts: Record<string, Record<string, number>> = {};
  for (const c of speechCorrections) {
    const m = PRONOUN_RE.exec(c.contextBefore);
    if (!m) continue;
    const pronoun = m[1].toLowerCase();
    if (!pronounCounts[pronoun]) pronounCounts[pronoun] = {};
    pronounCounts[pronoun][c.correctedSpeaker] =
      (pronounCounts[pronoun][c.correctedSpeaker] ?? 0) + 1;
  }
  // Normalise: pronounSpeakerWeights[pronoun][speaker] ∈ [0, 1]
  const pronounSpeakerWeights: Record<string, Record<string, number>> = {};
  for (const [pronoun, speakerMap] of Object.entries(pronounCounts)) {
    const total = Object.values(speakerMap).reduce((s, n) => s + n, 0) || 1;
    pronounSpeakerWeights[pronoun] = {};
    for (const [sp, n] of Object.entries(speakerMap)) {
      pronounSpeakerWeights[pronoun][sp] = n / total;
    }
  }

  // ── 3. Bigram transitions ───────────────────────────────────────────────
  // Sort by chapter + paragraph order.
  const sorted = [...speechCorrections].sort((a, b) => {
    if (a.chapterId < b.chapterId) return -1;
    if (a.chapterId > b.chapterId) return 1;
    return a.paragraphIndex - b.paragraphIndex;
  });

  // transitionCounts[prev][next] = raw count
  const transitionCounts: Record<string, Record<string, number>> = {};
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].correctedSpeaker;
    const next = sorted[i].correctedSpeaker;
    // Skip self-transitions (same speaker continuing) — not informative for
    // deciding *which* speaker comes next in an ambiguous multi-speaker run.
    if (prev === next) continue;
    if (!transitionCounts[prev]) transitionCounts[prev] = {};
    transitionCounts[prev][next] = (transitionCounts[prev][next] ?? 0) + 1;
  }

  // Collect all unique speakers for Laplace denominator.
  const allSpeakers = Object.keys(speakerCounts);
  // Laplace smooth (+ 0.5) then row-normalise.
  const speakerTransitions: Record<string, Record<string, number>> = {};
  for (const [prev, nextMap] of Object.entries(transitionCounts)) {
    const total =
      Object.values(nextMap).reduce((s, n) => s + n, 0) +
      0.5 * allSpeakers.length; // Laplace denominator
    speakerTransitions[prev] = {};
    for (const sp of allSpeakers) {
      speakerTransitions[prev][sp] =
        ((nextMap[sp] ?? 0) + 0.5) / total;
    }
  }

  // ── 4. Actor priors ─────────────────────────────────────────────────────
  const actorCounts: Record<string, number> = {};
  for (const c of actionCorrections) {
    actorCounts[c.correctedSpeaker] = (actorCounts[c.correctedSpeaker] ?? 0) + 1;
  }
  const totalAction = actionCorrections.length || 1;
  const actorPriors: Record<string, number> = {};
  for (const [name, count] of Object.entries(actorCounts)) {
    actorPriors[name] = (count / totalAction) * PRIOR_SCALE;
  }

  return {
    speakerPriors,
    pronounSpeakerWeights,
    speakerTransitions,
    actorPriors,
    sampleCount: corrections.length,
  };
}

// ── Per-character breakdown helper ────────────────────────────────────────

export interface CharacterBreakdown {
  name: string;
  speechCount: number;
  actionCount: number;
  total: number;
}

/** Returns per-character correction counts, sorted by total descending.
 *  When `chapterId` is provided, only corrections for that chapter are counted. */
export function characterBreakdown(store: AnnotationStore, chapterId?: string | null): CharacterBreakdown[] {
  const corrections = chapterId
    ? store.corrections.filter((c) => c.chapterId === chapterId)
    : store.corrections;
  const map: Record<string, { speechCount: number; actionCount: number }> = {};
  for (const c of corrections) {
    const name = c.correctedSpeaker ?? "(narrative)";
    if (!map[name]) map[name] = { speechCount: 0, actionCount: 0 };
    if (c.spanType === "speech") map[name].speechCount++;
    else map[name].actionCount++;
  }
  return Object.entries(map)
    .map(([name, { speechCount, actionCount }]) => ({
      name,
      speechCount,
      actionCount,
      total: speechCount + actionCount,
    }))
    .sort((a, b) => b.total - a.total);
}
