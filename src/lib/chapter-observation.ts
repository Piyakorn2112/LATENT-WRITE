import type { ChapterAnalysisResult } from "./chapter-analysis-runner";

/**
 * chapter-observation.ts — ONE sentence about the chapter, with a location.
 *
 * The analysis panel computes dozens of metrics; a number without a target is
 * decoration. This module distils the settled analysis into a single
 * observation a writer can act on at a glance, anchored to a paragraph when
 * possible. The widgets below it remain the deep-dive.
 *
 * Pure synthesis over `ChapterAnalysisResult` — no new analysis runs here.
 */

export interface ChapterObservation {
  /** One plain sentence (or two short ones). Always concrete. */
  text: string;
  /** Paragraph the observation anchors to, for click-to-jump. */
  paragraphIndex?: number;
  /** Which dimension produced it — the UI can point at the matching widget. */
  kind: "tension" | "dialogue" | "diagnostic" | "echo";
}

/** Map a tension-curve sample index to a paragraph index. */
function curveToParagraph(curveIdx: number, curveLen: number, paraCount: number): number {
  if (curveLen <= 1 || paraCount <= 0) return 0;
  return Math.min(paraCount - 1, Math.round((curveIdx / (curveLen - 1)) * (paraCount - 1)));
}

function peakIndex(curve: number[]): number {
  let best = 0;
  for (let i = 1; i < curve.length; i++) if (curve[i] > curve[best]) best = i;
  return best;
}

/** Latest index of the maximum — a curve that saturates early and holds must
 *  report where the high END is, not where it first arrived (ties → latest). */
function lastPeakIndex(curve: number[]): number {
  let best = 0;
  for (let i = 1; i < curve.length; i++) if (curve[i] >= curve[best]) best = i;
  return best;
}

/** First sample index of the longest high (≥0.66) run. */
function highRunStart(curve: number[]): number {
  let bestStart = -1;
  let bestLen = 0;
  let start = -1;
  for (let i = 0; i <= curve.length; i++) {
    const high = i < curve.length && curve[i] >= 0.66;
    if (high && start < 0) start = i;
    if (!high && start >= 0) {
      if (i - start > bestLen) { bestLen = i - start; bestStart = start; }
      start = -1;
    }
  }
  return bestStart;
}

const P = (n: number) => `¶${n + 1}`; // display is 1-based

export function buildChapterObservation(
  result: ChapterAnalysisResult,
  prevResult?: ChapterAnalysisResult | null,
): ChapterObservation | null {
  const { analysis, paragraphs } = result;
  const paraCount = paragraphs.length;
  if (paraCount < 6) return null; // too little prose for a shape claim

  const curve = analysis.tensionCurve ?? [];
  const peak = curve.length ? peakIndex(curve) : 0;
  const peakPara = curveToParagraph(peak, curve.length, paraCount);
  // A tension claim needs actual tension. Shape labels are relative (a calm
  // chapter whose curve tops out at 0.26 can still be labelled "slope-up"),
  // so every shape template is gated on the curve reaching a real peak.
  const maxTension = curve.length ? Math.max(...curve) : 0;
  const hasRealPeak = maxTension >= 0.5;

  // 1 · Distinctive tension shapes read first. These are the observations a
  //     writer cannot see while inside the prose.
  if (curve.length >= 6 && hasRealPeak) {
    switch (analysis.arcShape) {
      case "plateau-high": {
        const runStart = highRunStart(curve);
        const startPara = runStart >= 0 ? curveToParagraph(runStart, curve.length, paraCount) : peakPara;
        return {
          text: `Tension holds high from ${P(startPara)} through the end and never releases.`,
          paragraphIndex: startPara,
          kind: "tension",
        };
      }
      case "spike":
        return {
          text: `One spike at ${P(peakPara)} carries the chapter. The rest stays calm.`,
          paragraphIndex: peakPara,
          kind: "tension",
        };
      // "flat" carries no shape claim worth making: a flat-CALM chapter is
      // covered by the engine's own no-climax diagnostic below, and a flat
      // mid-tension chapter is not something to editorialise about.
      case "valley": {
        // Returning-tense point ≈ peak in the closing third.
        return {
          text: `Opens tense, goes quiet through the middle, then returns tense at ${P(peakPara)}.`,
          paragraphIndex: peakPara,
          kind: "tension",
        };
      }
      case "double-peak": {
        // Second peak = max of the samples after the midpoint. Only claim
        // two peaks when both halves actually reach one (a degenerate curve
        // under a stale shape label must fall through, not invent peaks).
        const mid = Math.floor(curve.length / 2);
        let second = mid;
        for (let i = mid; i < curve.length; i++) if (curve[i] > curve[second]) second = i;
        const first = peakIndex(curve.slice(0, mid));
        const firstPara = curveToParagraph(first, curve.length, paraCount);
        const secondPara = curveToParagraph(second, curve.length, paraCount);
        if (firstPara !== secondPara && curve[first] >= 0.6 && curve[second] >= 0.6) {
          return {
            text: `Two peaks, near ${P(firstPara)} and ${P(secondPara)}, with a slack stretch between them.`,
            paragraphIndex: firstPara,
            kind: "tension",
          };
        }
        break;
      }
    }
  }

  // 2 · A warning-grade diagnostic is inherently actionable. On a calm
  //     chapter (no real peak) the engine's own info note is the honest
  //     observation, so it qualifies too.
  const warning = analysis.writerDiagnostics?.find((d) => d.severity === "warning")
    ?? (!hasRealPeak ? analysis.writerDiagnostics?.[0] : undefined);
  if (warning) {
    return { text: warning.message, kind: "diagnostic" };
  }

  // 3 · Extreme dialogue dominance (needs a real conversation to mean much).
  const speakers = analysis.speakerCounts ?? [];
  const totalChars = speakers.reduce((a, s) => a + s.chars, 0);
  if (speakers.length >= 2 && totalChars > 400) {
    const lead = speakers[0];
    const pct = Math.round((lead.chars / totalChars) * 100);
    if (pct >= 72) {
      return {
        text: `${lead.name} speaks ${pct}% of the dialogue across ${lead.turns} turns.`,
        kind: "dialogue",
      };
    }
  }

  // 4 · Rising/falling slopes, located. Climbs report the latest max so a
  //     curve that saturates early doesn't claim an early "peak".
  if (curve.length >= 6 && hasRealPeak && analysis.arcShape === "slope-up") {
    const upPara = curveToParagraph(lastPeakIndex(curve), curve.length, paraCount);
    const atClose = upPara >= Math.floor(paraCount * 0.8);
    return {
      text: atClose
        ? `Tension climbs all chapter and peaks at ${P(upPara)}, right at the close.`
        : `Tension builds to its peak at ${P(upPara)} and holds from there.`,
      paragraphIndex: upPara,
      kind: "tension",
    };
  }
  if (curve.length >= 6 && hasRealPeak && analysis.arcShape === "slope-down") {
    return {
      text: `The peak lands at ${P(peakPara)} in the opening and everything after it descends.`,
      paragraphIndex: peakPara,
      kind: "tension",
    };
  }

  // 5 · Cross-chapter echo.
  if (prevResult && prevResult.analysis.arcShape === analysis.arcShape && analysis.arcShape !== "flat") {
    return {
      text: `Same ${analysis.arcShape.replace("-", " ")} shape as the previous chapter.`,
      kind: "echo",
    };
  }

  return null;
}
