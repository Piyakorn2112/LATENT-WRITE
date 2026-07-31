import type {
  AdaptiveInferenceContext,
  AdaptivePredictionTrace,
  Chapter,
  LearnedBias,
} from "../types";
import {
  detectSpeechInChapter,
  type ChapterParaResult,
  type ChapterEndContext,
  type IntelligenceLevel,
} from "./speech-detect";
import {
  analyzeChapter,
  type ChapterAnalysis,
  type ChapterStats,
} from "./chapter-analysis";
import { findActionSentences, predictActionActor, type ActionPrediction } from "./action-detect";
import { detectNarrativeEvents, type NarrativeEvent } from "./narrative-events";
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
        const prediction = predictActionActor(
          spanText,
          knownNames,
          carryingSpeaker,
          learnedBias,
          adaptiveContext,
          para.slice(Math.max(0, start - 120), start),
          para.slice(end, Math.min(para.length, end + 120)),
        );
        predictions.push({ start, end, ...prediction });
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
  const contextOut: { value: ChapterEndContext | null } = { value: null };
  const predictionTraceOut: { value: AdaptivePredictionTrace[] } | undefined = collectPredictionDetails
    ? { value: [] }
    : undefined;
  const speechResults = detectSpeechInChapter(paragraphs, knownNames, {
    intelligenceLevel: level,
    prevChapterContext: prevContext ?? undefined,
    contextOut,
    learnedBias,
    adaptiveContext,
    predictionTraceOut,
  });
  const actionPredictions = collectPredictionDetails
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

  return {
    contentSnapshot: chapter.content,
    paragraphs,
    speechResults,
    speechPredictions: predictionTraceOut?.value ?? [],
    actionPredictions,
    analysis,
    endContext: contextOut.value,
    narrativeEvents,
  };
}