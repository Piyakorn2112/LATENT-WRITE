import { useEffect, useMemo, useRef, useState } from "react";
import type { Chapter, Novel } from "../types";
import {
  detectSpeechInChapter,
  type ChapterParaResult,
  type ChapterEndContext,
  type IntelligenceLevel,
} from "./speech-detect";
import {
  analyzeChapter,
  computeChapterStats,
  type ChapterAnalysis,
  type ChapterStats,
  type ChapterRole,
  type ProseRegister,
} from "./chapter-analysis";
import { resolveKnownNames } from "./world-data";

export type {
  ChapterParaResult,
  ChapterAnalysis,
  ChapterStats,
  ChapterRole,
  ProseRegister,
  IntelligenceLevel,
};

export interface ChapterAnalysisResult {
  paragraphs: string[];
  speechResults: ChapterParaResult[];
  analysis: ChapterAnalysis;
  /** Captured at end of detection — passed forward to seed the next chapter. */
  endContext: ChapterEndContext | null;
}

// Split chapter content into non-empty paragraphs (double-newline or single-newline separated)
function toParagraphs(content: string): string[] {
  return content
    .split(/\n{2,}|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// Run speech detection + chapter analysis for one chapter, threading context.
function analyzeOne(
  chapter: Chapter,
  prevContext: ChapterEndContext | null,
  siblingStats: ChapterStats[],
  knownNames: string[],
  level: IntelligenceLevel,
): ChapterAnalysisResult {
  const paragraphs = toParagraphs(chapter.content);
  const contextOut: { value: ChapterEndContext | null } = { value: null };
  const speechResults = detectSpeechInChapter(paragraphs, knownNames, {
    intelligenceLevel: level,
    prevChapterContext: prevContext ?? undefined,
    contextOut,
  });
  const analysis = analyzeChapter(paragraphs, speechResults, siblingStats);
  return { paragraphs, speechResults, analysis, endContext: contextOut.value };
}

interface UseAnalysisOptions {
  /** How long after the last keystroke to wait before running analysis (ms) */
  debounceMs?: number;
  /** Intelligence tier — falls through directly to speech-detect. */
  level?: IntelligenceLevel;
}

interface UseAnalysisReturn {
  result: ChapterAnalysisResult | null;
  isAnalyzing: boolean;
  /** Resolved entity name list — exposed so HighlightLayer can highlight uniformly. */
  knownNames: string[];
}

// Runs the full speech-detect → chapter-analysis pipeline for the current chapter.
// Lazy: debounced on edits, instant cache hit on chapter switch.
// Cross-chapter: previous chapter's endContext seeds the current chapter's
// pronoun-resolution recency weights (matches novel-reader behaviour).
// World-aware: knownNames pulled from novel.worldData (or auto-extracted as fallback).
export function useAnalysis(
  novel: Novel,
  currentChapterId: string | null,
  options: UseAnalysisOptions = {},
): UseAnalysisReturn {
  const { debounceMs = 1000, level = "default" } = options;
  const [result, setResult] = useState<ChapterAnalysisResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // Cache previous results keyed by chapter id so switching chapters restores
  // stale data instantly. Includes endContext so we don't re-run detection
  // just to thread context forward.
  const cache = useRef<Map<string, ChapterAnalysisResult>>(new Map());

  // Invalidate cache for chapters whose content changed (cheap content-hash check).
  // We track each chapter's last analysed content length+head to detect edits.
  const contentSig = useRef<Map<string, string>>(new Map());

  // Track which chapter the currently-displayed `result` belongs to. Used to
  // decide whether to clear `result` on chapter switch (different id) vs
  // hold the stale value while typing in the same chapter.
  const resultChapterId = useRef<string | null>(null);

  // Resolved entity names — pulls from world data, falls back to auto-extraction.
  // Memoized on novel reference so we don't rebuild every render.
  const knownNames = useMemo(() => resolveKnownNames(novel), [novel]);

  useEffect(() => {
    if (!currentChapterId) {
      setResult(null);
      resultChapterId.current = null;
      return;
    }

    const chapters = novel.chapters;
    const currentIndex = chapters.findIndex((c) => c.id === currentChapterId);
    if (currentIndex < 0) return;
    const chapter = chapters[currentIndex];

    // Track content signature so we know when to recompute. Crucially we do
    // NOT delete the cached result on content change — the previous analysis
    // is still a useful "stale" view while we debounce + recompute the fresh
    // one. Otherwise the panel flashes empty between every keystroke and the
    // user sees a double reveal (widgets exit → placeholder → widgets reveal).
    const sig = `${chapter.content.length}::${chapter.content.slice(0, 64)}`;
    contentSig.current.set(chapter.id, sig);

    // Show whatever we have cached as a stale view immediately so the panel
    // doesn't flash empty. Only clear the displayed result when (a) the user
    // switched chapters and the new one has no cache, or (b) the chapter is
    // genuinely empty. When typing in a cached chapter the stale entry is
    // still valid until the fresh analysis lands — keep it visible.
    const stale = cache.current.get(currentChapterId);
    const switchedChapter = resultChapterId.current !== currentChapterId;
    if (stale) {
      setResult(stale);
      resultChapterId.current = currentChapterId;
    } else if (chapter.content.trim().length === 0 || switchedChapter) {
      setResult(null);
      resultChapterId.current = currentChapterId;
    }

    setIsAnalyzing(true);

    const timer = window.setTimeout(() => {
      // Sibling stats for chapters that already have results cached
      const siblingStats: ChapterStats[] = [];
      for (let i = 0; i < chapters.length; i++) {
        if (i === currentIndex) continue;
        const cached = cache.current.get(chapters[i].id);
        if (!cached) continue;
        siblingStats.push(
          computeChapterStats(cached.paragraphs, cached.speechResults),
        );
      }

      // Thread end-context forward from the nearest preceding analysed chapter.
      // Reading from cache directly — no re-running detect just for context.
      let prevContext: ChapterEndContext | null = null;
      for (let i = currentIndex - 1; i >= 0; i--) {
        const cached = cache.current.get(chapters[i].id);
        if (cached?.endContext) { prevContext = cached.endContext; break; }
      }

      const fresh = analyzeOne(chapter, prevContext, siblingStats, knownNames, level);
      cache.current.set(currentChapterId, fresh);
      setResult(fresh);
      resultChapterId.current = currentChapterId;
      setIsAnalyzing(false);
    }, debounceMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [novel.chapters, currentChapterId, debounceMs, level, knownNames]);

  return { result, isAnalyzing, knownNames };
}
