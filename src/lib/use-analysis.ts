import { useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedValue } from "./use-debounced";
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
  /** Cached analysis for the chapter immediately before the current one, if
   *  it was previously visited and analysed. null otherwise (no eager
   *  cross-chapter analysis — we don't trigger fresh runs just for context). */
  prevResult: ChapterAnalysisResult | null;
  /** Cached analysis for the chapter immediately after the current one. */
  nextResult: ChapterAnalysisResult | null;
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
  // Bumped when background adjacent-chapter scans complete so the
  // prevResult/nextResult memo re-derives from the updated cache.
  const [adjacentReady, setAdjacentReady] = useState(0);

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
  // worldData changes rarely (explicit edits only). When there's no world data,
  // autoExtractEntities scans all chapter text — expensive on large novels. We
  // debounce the chapters reference so that scan only runs after a typing pause,
  // not on every single keystroke.
  const debouncedChapters = useDebouncedValue(novel.chapters, 2000);
  const knownNames = useMemo(
    () => resolveKnownNames({ ...novel, chapters: debouncedChapters }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [novel.worldData, debouncedChapters],
  );

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

    // Empty chapters have nothing to analyse — don't flip the pill on, and
    // don't schedule a debounced run. Otherwise creating a new (empty)
    // chapter would leave the StatusPill stuck on "Analysing chapter…" for
    // the full debounce window even though there is no content.
    const isEmpty = chapter.content.trim().length === 0;
    if (isEmpty) {
      setIsAnalyzing(false);
      return;
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

  // High-mode background pre-scan: when intelligence is set to "high" and an
  // adjacent chapter hasn't been visited yet, run its analysis in the background
  // so the CrossArcWidget has data without requiring the user to navigate there.
  // Runs after the current chapter's result lands (result dep), deferred by a
  // short timeout so it doesn't compete with the in-flight main analysis render.
  useEffect(() => {
    if (level !== "high") return;
    if (!currentChapterId) return;

    const t = window.setTimeout(() => {
      const chapters = novel.chapters;
      const idx = chapters.findIndex((c) => c.id === currentChapterId);
      if (idx < 0) return;

      const currentCached = cache.current.get(currentChapterId);
      if (!currentCached) return; // current not analysed yet — wait for next fire

      const prevId = idx > 0 ? chapters[idx - 1].id : null;
      const nextId = idx < chapters.length - 1 ? chapters[idx + 1].id : null;
      const needPrev = !!prevId && !cache.current.has(prevId);
      const needNext = !!nextId && !cache.current.has(nextId);
      if (!needPrev && !needNext) return;

      const buildSiblings = (skipId: string): ChapterStats[] => {
        const stats: ChapterStats[] = [];
        for (const ch of chapters) {
          if (ch.id === skipId) continue;
          const c = cache.current.get(ch.id);
          if (c) stats.push(computeChapterStats(c.paragraphs, c.speechResults));
        }
        return stats;
      };

      if (needPrev) {
        const prevChapter = chapters[idx - 1];
        let prevCtx: ChapterEndContext | null = null;
        for (let i = idx - 2; i >= 0; i--) {
          const c = cache.current.get(chapters[i].id);
          if (c?.endContext) { prevCtx = c.endContext; break; }
        }
        cache.current.set(prevChapter.id, analyzeOne(prevChapter, prevCtx, buildSiblings(prevChapter.id), knownNames, level));
      }

      if (needNext) {
        const nextChapter = chapters[idx + 1];
        cache.current.set(nextChapter.id, analyzeOne(nextChapter, currentCached.endContext, buildSiblings(nextChapter.id), knownNames, level));
      }

      setAdjacentReady((v) => v + 1);
    }, 200); // yield to the main analysis render before starting background work

    return () => window.clearTimeout(t);
  }, [result, level, currentChapterId, novel.chapters, knownNames]);

  // Adjacent chapter analyses pulled from cache — no fresh runs triggered for
  // non-high modes. In high mode the background effect above pre-populates the
  // cache, so neighbours are available without the user visiting them.
  // `adjacentReady` bumps the memo when the background scan completes.
  const { prevResult, nextResult } = useMemo(() => {
    if (!currentChapterId) return { prevResult: null, nextResult: null };
    const idx = novel.chapters.findIndex((c) => c.id === currentChapterId);
    if (idx < 0) return { prevResult: null, nextResult: null };
    const prevId = idx > 0 ? novel.chapters[idx - 1].id : null;
    const nextId = idx < novel.chapters.length - 1 ? novel.chapters[idx + 1].id : null;
    return {
      prevResult: prevId ? cache.current.get(prevId) ?? null : null,
      nextResult: nextId ? cache.current.get(nextId) ?? null : null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [novel.chapters, currentChapterId, result, adjacentReady]);

  return { result, isAnalyzing, knownNames, prevResult, nextResult };
}
