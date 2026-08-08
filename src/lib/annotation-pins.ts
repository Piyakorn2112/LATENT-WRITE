/**
 * annotation-pins.ts — a correction is GROUND TRUTH FOR ITS SPAN.
 *
 * ★★ WHY THIS EXISTS. Corrections used to be dissolved into a global
 *    statistical prior and applied nowhere else. Two consequences, both
 *    measured (scripts/probe-annotation-feedback.ts):
 *
 *    1. The prior was evidence about WHERE THE ENGINE FAILS being used as
 *       evidence about WHO SPEAKS. Ten corrections put the whole prior
 *       budget on one character and flipped 115 of 3923 attributions
 *       book-wide (Pip→Joe, Wopsle→Joe), while held-out accuracy moved
 *       0.0pp across five books. Correcting made it worse, exactly as
 *       reported.
 *    2. The correction never reached the SPAN IT WAS ABOUT. The override
 *       lived in HighlightLayer, so it repainted the editor and nothing
 *       else: the story graph, the timeline, the chips and every LLM prompt
 *       still carried the original wrong speaker. A user could correct a
 *       line, watch the colour change, and still get asked about the wrong
 *       character.
 *
 *    Pins fix both by being boring. A correction pins that span, forever,
 *    exactly. It is memorisation, not generalisation, so it CANNOT move any
 *    other attribution — the base engine is untouched everywhere a pin does
 *    not land.
 *
 * ★★ ANCHOR BY CONTENT, NEVER BY INDEX. This is a writing app. Corrections
 *    keyed by (chapter, paragraphIndex, spanIndex) do not merely go stale
 *    when a paragraph is inserted above them — they silently RE-POINT onto a
 *    different span and assert a wrong name there. Pins carry the span text
 *    and its neighbours and are re-located on every analysis, so inserting,
 *    deleting and reordering paragraphs all keep the pin on its sentence.
 *    The stored index is kept only as a first guess.
 */
import type { AnnotationCorrection } from "../types";
import type { ChapterAnalysisResult } from "./chapter-analysis-runner";

/** Trimmed, whitespace-collapsed text; quote glyphs unified. */
function norm(s: string): string {
  return s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The tail/head of a context string, which is what stays stable under edits. */
function edge(s: string, take: number): string {
  const n = norm(s);
  return n.length <= take ? n : n.slice(-take);
}

export interface ResolvedPin {
  paragraphIndex: number;
  spanIndex: number;
  spanType: "speech" | "action";
  speaker: string | null;
  /** How the pin was located, for the debug panel and the probe. */
  via: "index" | "content" | "unresolved";
}

/**
 * Locate each correction inside the CURRENT analysis. A pin resolves when its
 * span text is found again; otherwise it is reported unresolved rather than
 * being applied to whatever now occupies its old index.
 */
export function resolvePins(
  corrections: AnnotationCorrection[],
  result: ChapterAnalysisResult,
  /**
   * ★★ THE CHAPTER `result` BELONGS TO. Pins match by sentence text, and
   *    short lines ("Yes.", "What?") repeat across a book, so a correction
   *    from another chapter can genuinely find a home in this one. Callers
   *    combining a correction list with an analysis MUST pass this: the
   *    analysis is swapped inside an effect, so right after a chapter switch
   *    the two disagree for a render. Omitted only by tests that build both
   *    sides themselves.
   */
  expectChapterId?: string | null,
): ResolvedPin[] {
  const { paragraphs, speechResults, actionPredictions } = result;
  const out: ResolvedPin[] = [];

  for (const c of corrections) {
    if (expectChapterId != null && c.chapterId !== expectChapterId) continue;
    const wantText = norm(c.spanText);
    if (!wantText) continue;
    const wantBefore = edge(c.contextBefore, 40);

    if (c.spanType === "speech") {
      // Fast path: the stored index still holds the same text.
      const atIndex = speechResults[c.paragraphIndex]?.segments[c.spanIndex];
      const para = paragraphs[c.paragraphIndex];
      if (atIndex && para && norm(para.slice(atIndex.start, atIndex.end)) === wantText) {
        out.push({ paragraphIndex: c.paragraphIndex, spanIndex: c.spanIndex, spanType: "speech", speaker: c.correctedSpeaker, via: "index" });
        continue;
      }
      // Content search. Ties are broken by matching left context, then by
      // proximity to the remembered index, so a repeated line of dialogue
      // ("Yes." twice in a chapter) pins the one the user actually clicked.
      let best: { pi: number; si: number; score: number } | null = null;
      for (let pi = 0; pi < speechResults.length; pi++) {
        const segs = speechResults[pi]?.segments ?? [];
        const text = paragraphs[pi] ?? "";
        for (let si = 0; si < segs.length; si++) {
          const seg = segs[si];
          if (norm(text.slice(seg.start, seg.end)) !== wantText) continue;
          const beforeHere = edge(text.slice(0, seg.start), 40);
          const score =
            (beforeHere === wantBefore ? 1000 : 0) - Math.abs(pi - c.paragraphIndex);
          if (!best || score > best.score) best = { pi, si, score };
        }
      }
      out.push(best
        ? { paragraphIndex: best.pi, spanIndex: best.si, spanType: "speech", speaker: c.correctedSpeaker, via: best.pi === c.paragraphIndex && best.si === c.spanIndex ? "index" : "content" }
        : { paragraphIndex: c.paragraphIndex, spanIndex: c.spanIndex, spanType: "speech", speaker: c.correctedSpeaker, via: "unresolved" });
      continue;
    }

    // Action spans are addressed by their start offset, not an ordinal.
    const atPara = actionPredictions[c.paragraphIndex] ?? [];
    const paraText = paragraphs[c.paragraphIndex] ?? "";
    const direct = atPara.find((a) => a.start === c.spanIndex);
    if (direct && norm(paraText.slice(direct.start, direct.end)) === wantText) {
      out.push({ paragraphIndex: c.paragraphIndex, spanIndex: c.spanIndex, spanType: "action", speaker: c.correctedSpeaker, via: "index" });
      continue;
    }
    let best: { pi: number; start: number; score: number } | null = null;
    for (let pi = 0; pi < actionPredictions.length; pi++) {
      const text = paragraphs[pi] ?? "";
      for (const a of actionPredictions[pi] ?? []) {
        if (norm(text.slice(a.start, a.end)) !== wantText) continue;
        const beforeHere = edge(text.slice(0, a.start), 40);
        const score = (beforeHere === wantBefore ? 1000 : 0) - Math.abs(pi - c.paragraphIndex);
        if (!best || score > best.score) best = { pi, start: a.start, score };
      }
    }
    out.push(best
      ? { paragraphIndex: best.pi, spanIndex: best.start, spanType: "action", speaker: c.correctedSpeaker, via: best.pi === c.paragraphIndex && best.start === c.spanIndex ? "index" : "content" }
      : { paragraphIndex: c.paragraphIndex, spanIndex: c.spanIndex, spanType: "action", speaker: c.correctedSpeaker, via: "unresolved" });
  }

  return out;
}

/**
 * Return an analysis with every resolved pin applied at the source, so the
 * story graph, the timeline, the chips, the knowledge ledger and every LLM
 * prompt inherit the user's answer instead of the engine's.
 *
 * Returns the SAME object when there is nothing to apply — callers memoise on
 * identity and a fresh copy each render would re-run the whole downstream
 * chain.
 */
export function applyPinsToAnalysis(
  result: ChapterAnalysisResult,
  corrections: AnnotationCorrection[],
): ChapterAnalysisResult {
  if (corrections.length === 0) return result;
  return applyResolvedPins(result, resolvePins(corrections, result));
}

/** What the pins did, for the annotation bar and the debug panel. */
export interface PinStats {
  /** Corrections recorded for this chapter. */
  total: number;
  /** Landed on the span they were recorded against. */
  atIndex: number;
  /** Re-located by content after the text moved. */
  relocated: number;
  /** Sentence no longer present — deliberately NOT applied anywhere. */
  unresolved: number;
}

export function pinStats(pins: ResolvedPin[]): PinStats {
  let atIndex = 0, relocated = 0, unresolved = 0;
  for (const p of pins) {
    if (p.via === "index") atIndex++;
    else if (p.via === "content") relocated++;
    else unresolved++;
  }
  return { total: pins.length, atIndex, relocated, unresolved };
}

/**
 * Apply pins that have ALREADY been resolved. Split out so a caller that also
 * wants to report on the pins does not pay for resolution twice.
 */
export function applyResolvedPins(
  result: ChapterAnalysisResult,
  resolved: ResolvedPin[],
): ChapterAnalysisResult {
  const pins = resolved.filter((p) => p.via !== "unresolved");
  if (pins.length === 0) return result;

  const speechByPara = new Map<number, Map<number, string | null>>();
  const actionByPara = new Map<number, Map<number, string | null>>();
  for (const p of pins) {
    const bucket = p.spanType === "speech" ? speechByPara : actionByPara;
    if (!bucket.has(p.paragraphIndex)) bucket.set(p.paragraphIndex, new Map());
    bucket.get(p.paragraphIndex)!.set(p.spanIndex, p.speaker);
  }

  const speechResults = result.speechResults.map((para, pi) => {
    const pinned = speechByPara.get(pi);
    if (!pinned || !para) return para;
    return {
      ...para,
      segments: para.segments.map((seg, si) => {
        if (!pinned.has(si)) return seg;
        const speaker = pinned.get(si);
        // `speaker` is optional on the segment; a pin to "narrative / none"
        // must REMOVE it, not set it to a string.
        const next = { ...seg };
        if (speaker) next.speaker = speaker;
        else delete next.speaker;
        return next;
      }),
    };
  });

  const actionPredictions = result.actionPredictions.map((para, pi) => {
    const pinned = actionByPara.get(pi);
    if (!pinned || !para) return para;
    return para.map((a) => (pinned.has(a.start) ? { ...a, actor: pinned.get(a.start) ?? null } : a));
  });

  // Prediction traces feed the story graph's character extraction, so they
  // must carry the pin too or the timeline keeps the engine's guess.
  // `speechPredictions` only ever holds task:'speech' traces (the runner
  // fills it from speech-detect's trace-out); action actors reach the graph
  // through `actionPredictions` above, which is why there is no action branch
  // here.
  const speechPredictions = result.speechPredictions.map((trace) => {
    const pinnedPara = speechByPara.get(trace.paragraphIndex);
    if (!pinnedPara || !pinnedPara.has(trace.spanIndex)) return trace;
    return { ...trace, predictedLabel: pinnedPara.get(trace.spanIndex) ?? null };
  });

  return { ...result, speechResults, actionPredictions, speechPredictions };
}
