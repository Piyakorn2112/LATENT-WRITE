import type { ChapterAnalysisResult } from "./chapter-analysis-runner";
import { detectNarrativeEvents, selectTimelineChips, type NarrativeEvent } from "./narrative-events";

/**
 * chapter-observation.ts — the brief above the widgets.
 *
 * ─── WHY THIS WAS REWRITTEN ──────────────────────────────────────────────────
 *
 * The previous version returned ONE templated sentence chosen by a five-rule
 * waterfall over the tension curve's shape. Run over 52 chapters of the two
 * sample manuscripts it produced **six distinct sentences**:
 *
 *   17×  "Two peaks, near ¶N and ¶N, with a slack stretch between them."
 *   11×  "No clear tension peak detected. If this is meant to be a significant…"
 *   10×  "One spike at ¶N carries the chapter. The rest stays calm."
 *    5×  "Tension peaks in the first N% of the chapter…"
 *    4×  "Same double peak shape as the previous chapter."
 *    1×  "X speaks N% of the dialogue across 29 turns."
 *
 * A third of all chapters got that first line verbatim. 31% got a diagnostic
 * scold rather than an observation. 48% had no paragraph anchor at all, so there
 * was nothing to click. And the ¶ numbers those templates cite were located by
 * inverting the ≤30-bucket tension curve, which named a paragraph that was not
 * at the chapter's peak in 47.5% of cases — a confident, checkable, wrong claim
 * about the writer's own text.
 *
 * ─── WHAT IT DOES NOW ────────────────────────────────────────────────────────
 *
 * It answers the question the surface implies: what happens in this chapter.
 *
 * The lead line is built from the detected events, so it varies with the prose
 * rather than with which of five shapes the curve fell into. Under it sit up to
 * three anchored facts, each drawn from a DIFFERENT dimension so the box never
 * repeats itself: where the pressure sits, who holds the floor, and one thing
 * worth looking at. Every paragraph number comes from `analysis.peakParagraph`
 * or from an event's own `paragraphIndex`, never from inverting the curve.
 *
 * It also stops competing with the widgets. Tension shape belongs to
 * TensionWidget, the diagnostics list belongs to DiagnosticsWidget; this reports
 * the one diagnostic that outranks everything else and leaves the rest there.
 */

export interface BriefLine {
  text: string;
  /** 0-based paragraph, when the claim has a location worth jumping to. */
  paragraphIndex?: number;
  kind: "event" | "tension" | "dialogue" | "diagnostic" | "pacing" | "shape";
}

export interface ChapterBrief {
  /** One plain sentence: what happens. Always present. */
  headline: string;
  /** Anchored supporting facts, each from a different dimension. Up to three. */
  lines: BriefLine[];
  /** The events behind the headline, for the caller to render inline. */
  events: NarrativeEvent[];
  /** True when the chapter has prose but no event cleared the bar. Honest
   *  emptiness is a finding, not a gap to paper over. */
  eventless: boolean;
}

/** Back-compat shape. The panel reads `ChapterBrief`; this keeps any other
 *  caller (and the older suite) working. */
export interface ChapterObservation {
  text: string;
  paragraphIndex?: number;
  kind: BriefLine["kind"];
}

const P = (n: number) => `¶${n + 1}`; // display is 1-based

/** Lower-case an event label for mid-sentence use without destroying a name.
 *  "Helia authorizes firing" → "Helia authorizes firing" (name kept),
 *  "Doors opens onto" → "doors opens onto". */
function inline(label: string): string {
  const first = label.split(/\s+/)[0] ?? "";
  // A capitalised word that is not a sentence-initial artefact is a name.
  const isName = /^[A-Z][a-z']+$/.test(first) && first.length > 2;
  return isName ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

function listOf(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and then ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and then ${parts[parts.length - 1]}`;
}

export function buildChapterBrief(
  result: ChapterAnalysisResult,
  prevResult?: ChapterAnalysisResult | null,
): ChapterBrief | null {
  const { analysis, paragraphs } = result;
  const paraCount = paragraphs.length;
  if (paraCount < 6) return null; // too little prose to claim anything

  // ★ Precomputed in the analysis worker when available — this runs inside a
  // useMemo on the renderer main thread, and recomputing a two-thousand-line
  // clause engine there on every panel update was the single heaviest thing
  // left on the UI thread. Fallback kept for results predating the field.
  const events = result.narrativeEvents
    ?? detectNarrativeEvents(paragraphs, result.speechResults, {
      knownNames: analysis.speakerCounts.map((s) => s.name).filter(Boolean),
      tensionByParagraph: result.speechResults.map((r) =>
        r.meta.tension === "high" ? 1 : r.meta.tension === "rising" ? 0.5 : 0,
      ),
    });

  const major = events.filter((e) => e.salience === "major");
  // ★ Select by RANK, narrate in reading order. `events` arrives in paragraph
  // order, so slicing it picked the chapter's OPENING three and called them the
  // headline (measured on the gold set: 36.1% real, against 47.0% by rank).
  // The headline still reads "A at ¶2, and then B at ¶9" because that is a
  // sequence, but which three it names is now a judgement, not a position.
  const lead = selectTimelineChips(major.length ? major : events, 3);

  // ── The lead line.
  let headline: string;
  if (lead.length === 0) {
    // Deliberately not a scold. A chapter can be doing work — establishing a
    // practice, holding a mood — without containing an event, and both quiet
    // chapters in the gold set contain two events across 29 and 65 paragraphs.
    headline =
      "Nothing here reads as a turn: no decision, revelation or change of state clears the bar. " +
      "If this chapter is meant to move the story, the move is currently implied rather than shown.";
  } else {
    const clauses = lead.map((e) => `${inline(e.label)} at ${P(e.paragraphIndex)}`);
    headline = `${capitalizeFirst(listOf(clauses))}.`;
  }

  const lines: BriefLine[] = [];

  // ── 1 · Where the pressure sits, against where the events are.
  //
  // This is the observation a writer cannot make from inside the prose: whether
  // the chapter's tension is where its events are. Both numbers are now exact.
  const curve = analysis.tensionCurve ?? [];
  const maxTension = curve.length ? Math.max(...curve) : 0;
  if (maxTension >= 0.5) {
    const peak = analysis.peakParagraph;
    const nearestEvent = lead.length
      ? lead.reduce((a, b) => (Math.abs(a.paragraphIndex - peak) <= Math.abs(b.paragraphIndex - peak) ? a : b))
      : null;
    // With no events there is no gap to report. Guarding this is not decorative:
    // without it the line read "Tension peaks at ¶29, Infinity paragraphs from
    // the nearest turn."
    const gap = nearestEvent ? Math.abs(nearestEvent.paragraphIndex - peak) : null;
    const farAway = gap !== null && gap > Math.max(3, Math.round(paraCount * 0.12));
    lines.push({
      text:
        gap === null
          ? `Tension still peaks at ${P(peak)}, so the prose is doing something there that the events do not account for.`
          : farAway
            ? `Tension peaks at ${P(peak)}, ${gap} paragraphs from the nearest turn. The pressure and the event are in different places.`
            : `Tension peaks at ${P(peak)}, which is where the chapter's turn lands.`,
      paragraphIndex: peak,
      kind: "tension",
    });
  } else if (analysis.arcShape !== "flat") {
    lines.push({
      text: `The tension curve reads ${analysis.arcShape.replace(/-/g, " ")} but never rises far. The shape is there; the stakes are not yet.`,
      kind: "shape",
    });
  }

  // ── 2 · Who holds the floor. Only when there is a real conversation to skew.
  const speakers = analysis.speakerCounts ?? [];
  const totalChars = speakers.reduce((a, s) => a + s.chars, 0);
  if (speakers.length >= 2 && totalChars > 400) {
    const leadSpeaker = speakers[0];
    const share = Math.round((leadSpeaker.chars / totalChars) * 100);
    if (share >= 65) {
      lines.push({
        text: `${leadSpeaker.name} holds ${share}% of the dialogue across ${leadSpeaker.turns} turns. The scene is one person talking.`,
        kind: "dialogue",
      });
    } else if (events.some((e) => e.channel === "dialogue")) {
      const spoken = events.filter((e) => e.channel === "dialogue").length;
      lines.push({
        text: `${spoken} of ${events.length} turns happen in dialogue rather than in narration.`,
        kind: "dialogue",
      });
    }
  }

  // ── 3 · The single most actionable diagnostic. The rest stay in
  //        DiagnosticsWidget, which already lists them all.
  const warning = analysis.writerDiagnostics?.find((d) => d.severity === "warning");
  if (warning && lines.length < 3) {
    lines.push({ text: warning.message, kind: "diagnostic" });
  }

  // ── 4 · Cross-chapter echo, last, and only if there is room. It is the least
  //        actionable thing here and it used to fire as a whole observation.
  if (
    lines.length < 3 &&
    prevResult &&
    prevResult.analysis.arcShape === analysis.arcShape &&
    analysis.arcShape !== "flat"
  ) {
    lines.push({
      text: `Same ${analysis.arcShape.replace(/-/g, " ")} shape as the previous chapter.`,
      kind: "shape",
    });
  }

  return { headline, lines: lines.slice(0, 3), events, eventless: lead.length === 0 };
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Back-compat wrapper. Returns the brief's headline as the old single-sentence
 * observation, anchored to the first event.
 */
export function buildChapterObservation(
  result: ChapterAnalysisResult,
  prevResult?: ChapterAnalysisResult | null,
): ChapterObservation | null {
  const brief = buildChapterBrief(result, prevResult);
  if (!brief) return null;
  return {
    text: brief.headline,
    paragraphIndex: brief.events[0]?.paragraphIndex,
    kind: brief.eventless ? "diagnostic" : "event",
  };
}
