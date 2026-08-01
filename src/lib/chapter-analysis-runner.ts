import type {
  AdaptiveInferenceContext,
  AdaptivePredictionTrace,
  Chapter,
  LearnedBias,
} from "../types";
import {
  detectSpeechInChapter,
  resolvePronounOwners,
  type ChapterParaResult,
  type ChapterEndContext,
  type IntelligenceLevel,
  type PronounOwner,
} from "./speech-detect";
import {
  analyzeChapter,
  type ChapterAnalysis,
  type ChapterStats,
} from "./chapter-analysis";
import { findActionSentences, predictActionActor, segmentActions, type ActionPrediction } from "./action-detect";
import { detectNarrativeEvents, type NarrativeEvent } from "./narrative-events";
import { buildSpeakerAliasMap } from "./world-data";
import type { WorldData } from "../types";

export interface ChapterAnalysisResult {
  contentSnapshot: string;
  paragraphs: string[];
  speechResults: ChapterParaResult[];
  speechPredictions: AdaptivePredictionTrace[];
  actionPredictions: ActionPrediction[][];
  analysis: ChapterAnalysis;
  endContext: ChapterEndContext | null;
  /**
   * Guessed pronoun owners per paragraph — the engine's internal pronoun
   * resolution surfaced for the highlight layer. See resolvePronounOwners.
   */
  pronounOwners: PronounOwner[][] | null;
  /**
   * The timeline engine's events, computed HERE so they ride the worker.
   *
   * Both consumers used to run detectNarrativeEvents themselves on the
   * renderer main thread — buildChapterBrief inside a useMemo on every panel
   * update, buildChapterEntry inside the story-graph effect — which put a
   * two-thousand-line clause engine on the UI thread twice per chapter for
   * the same answer this worker had all the inputs to produce once. Null on
   * results predating this field; consumers fall back to computing locally.
   */
  narrativeEvents: NarrativeEvent[] | null;
}

export interface RunChapterAnalysisInput {
  chapter: Chapter;
  prevContext: ChapterEndContext | null;
  siblingStats: ChapterStats[];
  knownNames: string[];
  level: IntelligenceLevel;
  learnedBias?: LearnedBias;
  adaptiveContext?: AdaptiveInferenceContext;
  collectPredictionDetails?: boolean;
  /** Enables the aliases in the event engine's name list — optional because
   *  harness callers predate it; omitting it only narrows the names. */
  worldData?: WorldData;
}

function clipActionSpans(spans: Array<{ start: number; end: number }>, from: number, to: number) {
  const out: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    if (span.end <= from || span.start >= to) continue;
    if (span.start < from || span.end > to) continue;
    out.push({ start: span.start - from, end: span.end - from });
  }
  return out;
}

function buildActionPredictions(
  paragraphs: string[],
  speechResults: ChapterParaResult[],
  knownNames: string[],
  learnedBias: LearnedBias | undefined,
  adaptiveContext: AdaptiveInferenceContext | undefined,
): ActionPrediction[][] {
  return paragraphs.map((para, paragraphIndex) => {
    const paraActions = findActionSentences(para);
    const segs = [...(speechResults[paragraphIndex]?.segments ?? [])].sort((a, b) => a.start - b.start);
    const predictions: ActionPrediction[] = [];
    let carryingSpeaker: string | null = null;
    let cursor = 0;

    const pushPredictions = (chunkStart: number, chunkEnd: number) => {
      const localActions = clipActionSpans(paraActions, chunkStart, chunkEnd);
      for (const action of localActions) {
        const start = action.start + chunkStart;
        const end = action.end + chunkStart;
        const spanText = para.slice(start, end);
        // ★ Smart segmentation first: a long sentence with several actors
        // becomes several predictions, each scored over ITS OWN clause with
        // the grammar's subject as a hint. A sentence that does not split
        // goes through unchanged, hint included, so "Anne watched Marilla"
        // belongs to Anne rather than to whichever name is longer.
        const segments = segmentActions(spanText, knownNames, carryingSpeaker);
        for (const segment of segments) {
          const segStart = start + segment.start;
          const segEnd = start + segment.end;
          const prediction = predictActionActor(
            para.slice(segStart, segEnd),
            knownNames,
            carryingSpeaker,
            learnedBias,
            adaptiveContext,
            para.slice(Math.max(0, segStart - 120), segStart),
            para.slice(segEnd, Math.min(para.length, segEnd + 120)),
            segment.actor ?? undefined,
          );
          predictions.push({ start: segStart, end: segEnd, ...prediction });
        }
      }
    };

    for (const seg of segs) {
      if (seg.start > cursor) pushPredictions(cursor, seg.start);
      if (seg.type === "speech" && seg.confidence >= 0.65) {
        carryingSpeaker = seg.speaker ?? carryingSpeaker;
      }
      cursor = seg.end;
    }
    if (cursor < para.length) pushPredictions(cursor, para.length);

    return predictions;
  });
}

export function toParagraphs(content: string): string[] {
  return content
    .split(/\n{2,}|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function runChapterAnalysis({
  chapter,
  prevContext,
  siblingStats,
  knownNames,
  level,
  learnedBias,
  adaptiveContext,
  collectPredictionDetails = false,
  worldData,
}: RunChapterAnalysisInput): ChapterAnalysisResult {
  const paragraphs = toParagraphs(chapter.content);

  // Alias identity for the engine: authored aliases from worldData are the
  // ground truth when a writer has recorded them; the morphological linker
  // covers the cold start. Chapter text is a narrower window than a whole book,
  // which only makes the linker MORE conservative — its coordination veto and
  // frequency vote just see less.
  const aliasCanon = new Map<string, string>();
  for (const [alias, canonical] of buildSpeakerAliasMap(knownNames, chapter.content)) {
    aliasCanon.set(alias, canonical);
  }
  for (const c of worldData?.characters ?? []) {
    if (!c.name) continue;
    for (const a of c.aliases ?? []) {
      if (a) aliasCanon.set(a.toLowerCase().trim(), c.name);
    }
  }

  const contextOut: { value: ChapterEndContext | null } = { value: null };
  const predictionTraceOut: { value: AdaptivePredictionTrace[] } | undefined = collectPredictionDetails
    ? { value: [] }
    : undefined;
  const speechResults = detectSpeechInChapter(paragraphs, knownNames, {
    intelligenceLevel: level,
    aliasCanon,
    prevChapterContext: prevContext ?? undefined,
    contextOut,
    learnedBias,
    adaptiveContext,
    predictionTraceOut,
  });
  // ★ HIGH mode always builds real predictions now — segmentation and
  // subject-side attribution are display accuracy, not a debug detail. The
  // fast/typing path keeps the cheap local highlight and pays nothing.
  const actionPredictions = (collectPredictionDetails || level === "high")
    ? buildActionPredictions(
        paragraphs,
        speechResults,
        knownNames,
        learnedBias,
        adaptiveContext,
      )
    : [];
  const analysis = analyzeChapter(paragraphs, speechResults, siblingStats);

  // Timeline events, computed off the main thread alongside everything else.
  // The name list is buildChapterEntry's exact recipe (worldData characters
  // with aliases, then attributed speakers) so the story graph sees the same
  // events it used to compute for itself.
  const eventNames = [
    ...(worldData?.characters ?? []).flatMap((c) => [c.name, ...(c.aliases ?? [])]),
    ...analysis.speakerCounts.map((sc) => sc.name),
  ].filter((n): n is string => Boolean(n) && n.length >= 2);
  const narrativeEvents = chapter.content.trim().length > 100
    ? detectNarrativeEvents(paragraphs, speechResults, {
        knownNames: eventNames,
        worldData,
        tensionByParagraph: speechResults.map((r) =>
          r.meta.tension === "high" ? 1 : r.meta.tension === "rising" ? 0.5 : 0,
        ),
      })
    : [];

  const pronounOwners = resolvePronounOwners(paragraphs, speechResults, knownNames, aliasCanon);

  return {
    contentSnapshot: chapter.content,
    paragraphs,
    speechResults,
    speechPredictions: predictionTraceOut?.value ?? [],
    actionPredictions,
    analysis,
    endContext: contextOut.value,
    narrativeEvents,
    pronounOwners,
  };
}