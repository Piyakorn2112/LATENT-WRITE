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
import { findActionSentences, predictActionActor, segmentActions, sentenceBounds, type ActionPrediction } from "./action-detect";
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

function buildActionPredictions(
  paragraphs: string[],
  speechResults: ChapterParaResult[],
  knownNames: string[],
  learnedBias: LearnedBias | undefined,
  adaptiveContext: AdaptiveInferenceContext | undefined,
): ActionPrediction[][] {
  // ★ THE CARRY IS THE WHOLE GAME, and the old shape had none: it walked only
  // ACTION sentences and its carry came only from SPEECH, so "Mira lit the
  // lantern. She had run this place alone..." left every pronoun sentence
  // unattributed, and the anywhere-fallback then let object names steal ("He
  // nodded once at Mira" -> Mira). This version walks EVERY sentence in
  // order: a clause-initial known name advances the carry whether or not the
  // sentence is an action; a pronoun resolves to the carry, or — when the
  // carry is empty — to the paragraph's single distinct name seen so far
  // (the same singleton rule the timeline's pronoun resolution earned).
  const nameSweeps = knownNames.map((name) => ({
    name,
    // Case-exact: "the frank curiosity of someone" is not the peddler Frank.
    re: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"),
  }));

  return paragraphs.map((para, paragraphIndex) => {
    const paraActions = findActionSentences(para);
    const segs = [...(speechResults[paragraphIndex]?.segments ?? [])].sort((a, b) => a.start - b.start);
    const predictions: ActionPrediction[] = [];
    let carryingSpeaker: string | null = null;
    let actorCarry: string | null = null;
    const seenNames: string[] = [];

    for (const [sStart, sEnd] of sentenceBounds(para)) {
      const speech = segs.find((g) => g.type === "speech" && g.start < sEnd && g.end > sStart);
      if (speech) {
        if ((speech.confidence ?? 0) >= 0.65 && speech.speaker) {
          carryingSpeaker = speech.speaker;
          actorCarry = speech.speaker;
        }
      }
      const sentText = para.slice(sStart, sEnd);
      const action = !speech && paraActions.find((a) => a.start >= sStart && a.start < sEnd);
      if (action) {
        const start = Math.max(action.start, sStart);
        const end = Math.min(action.end, sEnd);
        const spanText = para.slice(start, end);
        const carryForSentence = actorCarry
          ?? (new Set(seenNames).size === 1 ? seenNames[0] : null)
          ?? carryingSpeaker;
        const segments = segmentActions(spanText, knownNames, carryForSentence);
        for (const segment of segments) {
          const segStart = start + segment.start;
          const segEnd = start + segment.end;
          // A COLLECTIVE segment is a decision, not a gap: "they stood for a
          // moment" is six people, and letting the ranker's carry candidate
          // fill it credits one person with a crowd's action.
          if (segment.via === "collective") {
            predictions.push({
              start: segStart, end: segEnd, actor: null,
              confidence: 0.9, needsReview: false, ambiguityGap: 1, candidates: [],
            });
            continue;
          }
          const prediction = predictActionActor(
            para.slice(segStart, segEnd),
            knownNames,
            carryForSentence,
            learnedBias,
            adaptiveContext,
            para.slice(Math.max(0, segStart - 120), segStart),
            para.slice(segEnd, Math.min(para.length, segEnd + 120)),
            segment.actor ?? undefined,
          );
          predictions.push({ start: segStart, end: segEnd, ...prediction });
          if (prediction.actor) actorCarry = prediction.actor;
        }
      }
      // Advance the paragraph's name memory AFTER the sentence is judged, so
      // a sentence never resolves its own subject off its own objects.
      for (const { name, re } of nameSweeps) {
        re.lastIndex = 0;
        if (re.test(sentText) && !seenNames.includes(name)) seenNames.push(name);
      }
      const initial = sentText.replace(/^[\s"'\u201c\u2018(]+/, "");
      for (const { name } of nameSweeps) {
        if (initial.startsWith(name)) { actorCarry = name; break; }
      }
    }

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