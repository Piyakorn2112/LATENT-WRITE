import type { Chapter, WorldData } from "../types";
import type { ChapterGraphEntry, StoryGraph } from "../types";
import type { ChapterAnalysisResult } from "./use-analysis";
import { detectMajorEvents } from "./event-detect";

const DEV = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ?? false;

import { isDesktopApp, saveProjectState, loadProjectState } from "./project-manager";

const STORY_GRAPH_KEY = "glass-editor:story-graph-v1";

export function emptyStoryGraph(): StoryGraph {
  return { version: 1, entries: {} };
}

export function loadStoryGraph(): StoryGraph {
  if (isDesktopApp()) return emptyStoryGraph();
  try {
    const raw = localStorage.getItem(STORY_GRAPH_KEY);
    if (!raw) return emptyStoryGraph();
    const parsed = JSON.parse(raw) as StoryGraph;
    if (parsed.version !== 1 || typeof parsed.entries !== "object") return emptyStoryGraph();
    return parsed;
  } catch {
    return emptyStoryGraph();
  }
}

export async function loadStoryGraphFromProject(): Promise<StoryGraph | null> {
  const data = await loadProjectState<StoryGraph>("story-graph");
  if (!data || data.version !== 1 || typeof data.entries !== "object") return null;
  return data;
}

export function saveStoryGraph(g: StoryGraph): void {
  if (isDesktopApp()) { saveProjectState("story-graph", g); return; }
  try { localStorage.setItem(STORY_GRAPH_KEY, JSON.stringify(g)); }
  catch { /* quota — ignore */ }
}

const STRUCTURAL_EVENT_LABELS = new Set(["Scene transition", "Narrative pivot", "Chapter climax"]);

function paragraphIndexForEvent(tensionPosition: number, paragraphCount: number): number {
  if (paragraphCount <= 1) return 0;
  return Math.max(0, Math.min(paragraphCount - 1, Math.round(tensionPosition * (paragraphCount - 1))));
}

export function buildChapterEntry(
  chapter: Chapter,
  result: ChapterAnalysisResult,
  worldData?: WorldData,
): ChapterGraphEntry {
  const { analysis, speechPredictions, actionPredictions } = result;

  const charSet = new Set<string>();
  // From speech and action predictions (NLP speaker detection)
  for (const p of speechPredictions) {
    if (p.predictedLabel) charSet.add(p.predictedLabel);
  }
  for (const paraPreds of actionPredictions) {
    for (const p of paraPreds) {
      if (p.actor) charSet.add(p.actor);
    }
  }
  // Also: any named character in worldData who actually appears in this chapter's text.
  // This ensures Hollow Iris characters (Nora, Iris, Helia, Kaelen…) are always tracked
  // even when the speech-detection NLP doesn't attribute dialogue to them directly.
  if (worldData?.characters) {
    for (const c of worldData.characters) {
      if (c.name && c.name.length >= 2 && chapter.content.includes(c.name)) {
        charSet.add(c.name);
      }
    }
  }

  const full = analysis.tensionCurve;
  const tensionPeak = full.length ? Math.max(...full) : 0;
  const tensionCurve = downsample(full, 8);

  const words = chapter.content.trim() ? chapter.content.trim().split(/\s+/).length : 0;

  // Heavy event detection — runs per chapter, not per keystroke
  const majorEvents = chapter.content.trim().length > 100
    ? detectMajorEvents(chapter, result, worldData)
    : [];

  return {
    chapterId: chapter.id,
    chapterNumber: chapter.number,
    chapterTitle: chapter.title,
    role: analysis.chapterRole,
    tensionPeak,
    tensionCurve,
    charactersPresent: [...charSet].slice(0, 8),
    wordCount: words,
    proseRegister: analysis.register,
    majorEvents,
    lastUpdated: Date.now(),
    contentHash: `${chapter.content.length}|${chapter.content.slice(0, 60)}`,
  };
}

/**
 * Async LM enrichment — silently improves event labels after the
 * synchronous NLP result has already been shown.
 * Falls back gracefully if the model isn't downloaded yet.
 */
export async function enrichChapterEntryWithLM(
  entry: ChapterGraphEntry,
  chapterContent: string,
): Promise<ChapterGraphEntry> {
  const paras = chapterContent
    .split(/\n{2,}|\n/)
    .map(p => p.trim())
    .filter(Boolean);
  if (paras.length === 0 || entry.majorEvents.length === 0) return entry;

  if (DEV) console.log(`[StoryGraph] LM label enrichment for Ch.${entry.chapterNumber} "${entry.chapterTitle}" — ${entry.majorEvents.length} events`);

  try {
    const { classifyEventDetail, refineEventType, semanticSimilarity, selectBestEventSentence } = await import("./narrative-lm");
    const relabeled = await Promise.all(entry.majorEvents.map(async (event) => {
      if (STRUCTURAL_EVENT_LABELS.has(event.label)) return event;

      const paragraph = paras[paragraphIndexForEvent(event.tensionPosition, paras.length)];
      if (!paragraph || paragraph.length < 20) return event;

      let selected = await selectBestEventSentence(paragraph, event.type, { fallbackLabel: event.label });
      const refinedType = await refineEventType(selected.sentence, event.type);
      if (refinedType.type !== event.type) {
        selected = await selectBestEventSentence(paragraph, refinedType.type, { fallbackLabel: selected.label });
      }

      const nextLabel = selected.label;
      if (DEV && nextLabel !== event.label) {
        console.log(`[StoryGraph] Ch.${entry.chapterNumber} relabel: "${event.label}" -> "${nextLabel}"`);
      }

      let nextEvent = nextLabel && nextLabel.length >= 6
        ? { ...event, label: nextLabel, type: refinedType.type }
        : { ...event, type: refinedType.type };
      const detail = await classifyEventDetail(selected.sentence, nextEvent.type);
      if (detail) {
        if (DEV && (detail.detailLabel !== nextEvent.detailLabel || detail.type !== nextEvent.type)) {
          console.log(`[StoryGraph] Ch.${entry.chapterNumber} detail: "${selected.sentence.slice(0, 56)}" -> ${detail.detailLabel} (${detail.type})`);
        }
        nextEvent = {
          ...nextEvent,
          type: detail.type,
          detailType: detail.detailType,
          detailLabel: detail.detailLabel,
          detailConfidence: detail.confidence,
        };
      }

      return nextEvent;
    }));

    if (relabeled.length <= 1) {
      if (DEV) console.log(`[StoryGraph] Ch.${entry.chapterNumber}: ${relabeled.length} event(s), relabel only`);
      return { ...entry, majorEvents: relabeled };
    }

    const events = [...relabeled];
    const keep   = new Array(events.length).fill(true);

    // Compare all pairs: if two events are semantically similar (> 0.72) keep higher confidence
    for (let i = 0; i < events.length; i++) {
      if (!keep[i]) continue;
      for (let j = i + 1; j < events.length; j++) {
        if (!keep[j]) continue;
        const sim = await semanticSimilarity(events[i].label, events[j].label);
        if (sim > 0.72) {
          // Keep the one with higher confidence
          const dropIdx = events[i].confidence >= events[j].confidence ? j : i;
          keep[dropIdx] = false;
          if (DEV) console.log(`[StoryGraph] Ch.${entry.chapterNumber} dedup: "${events[i].label}" ~ "${events[j].label}" (sim:${sim.toFixed(2)}) → drop "${events[dropIdx].label}"`);
        }
      }
    }

    const deduped = events.filter((_, i) => keep[i]);
    if (DEV) console.log(`[StoryGraph] ✓ Ch.${entry.chapterNumber}: ${events.length} → ${deduped.length} events after dedup`);
    return { ...entry, majorEvents: deduped };
  } catch {
    // LM unavailable — return as-is
    return entry;
  }
}

function downsample(arr: number[], n: number): number[] {
  if (!arr.length) return Array(n).fill(0);
  if (arr.length <= n) {
    const out = [...arr];
    while (out.length < n) out.push(arr[arr.length - 1]);
    return out;
  }
  return Array.from({ length: n }, (_, i) => arr[Math.floor((i / (n - 1)) * (arr.length - 1))]);
}
