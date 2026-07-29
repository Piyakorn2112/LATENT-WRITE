/**
 * confidence-bands.ts — the single owner of "how sure is sure".
 *
 * Speech attribution produces a confidence in [0, 1]. Before this module,
 * every consumer invented its own threshold (0.50 / 0.58 / 0.65 / 0.85 …)
 * and the display layer asserted every attribution with identical visual
 * authority — a 0.35 guess rendered exactly like a 0.95 certainty, which is
 * how writers learn to distrust the whole layer.
 *
 * Three bands, chosen to match the engine's own internal gates:
 *   certain — ≥ CERTAIN (0.85): speech-detect's own high-confidence bar.
 *             Rendered as a full assertion (speaker-coloured text).
 *   likely  — ≥ LIKELY (0.58): the engine's low-confidence floor, where it
 *             stops trusting its own carry logic. Rendered as a hedged claim
 *             (ink text, speaker-hued underline).
 *   unsure  — below, or no speaker at all. Rendered as an open question
 *             (ink text, neutral dotted underline) — never as an assertion.
 *
 * A writer's manual override is always `certain`: ground truth outranks any
 * model confidence.
 */

export type ConfidenceBand = "certain" | "likely" | "unsure";

export const BAND_CERTAIN = 0.85;
export const BAND_LIKELY = 0.58;

export function bandFor(
  confidence: number | undefined,
  hasSpeaker: boolean,
  hasOverride = false,
): ConfidenceBand {
  if (hasOverride) return "certain";
  if (!hasSpeaker) return "unsure";
  const c = confidence ?? 0;
  if (c >= BAND_CERTAIN) return "certain";
  if (c >= BAND_LIKELY) return "likely";
  return "unsure";
}
