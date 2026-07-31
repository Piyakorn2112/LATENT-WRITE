import { useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedValue } from "./use-debounced";
import type { AdaptiveInferenceContext, LearnedBias, Novel } from "../types";
import {
  type ChapterParaResult,
  type ChapterEndContext,
  type IntelligenceLevel,
} from "./speech-detect";
import {
  computeChapterStats,
  type ChapterAnalysis,
  type ChapterStats,
  type ChapterRole,
  type ProseRegister,
} from "./chapter-analysis";
import { resolveEntityNameMap, type EntityNameMap } from "./world-data";
import { runChapterAnalysisInWorker } from "./analysis-worker-client";
import { runChapterAnalysis, type ChapterAnalysisResult } from "./chapter-analysis-runner";
import { logPerfEvent } from "./perf-trace";

export type {
  ChapterParaResult,
  ChapterAnalysis,
  ChapterStats,
  ChapterRole,
  ProseRegister,
  IntelligenceLevel,
};
export type { ChapterAnalysisResult } from "./chapter-analysis-runner";

type IdleHandle = number;
const scheduleIdle: (cb: () => void) => IdleHandle =
  typeof (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number }).requestIdleCallback === "function"
    ? ((cb) => (globalThis as { requestIdleCallback: (cb: () => void, opts?: { timeout?: number }) => number }).requestIdleCallback(cb, { timeout: 200 }))
    : ((cb) => requestAnimationFrame(cb) as IdleHandle);

const cancelIdle: (handle: IdleHandle) => void =
  typeof (globalThis as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback === "function"
    ? ((handle) => (globalThis as { cancelIdleCallback: (handle: number) => void }).cancelIdleCallback(handle))
    : ((handle) => cancelAnimationFrame(handle));

interface UseAnalysisOptions {
  /** How long after the last keystroke to wait before running analysis (ms) */
  debounceMs?: number;
  /** Intelligence tier — falls through directly to speech-detect. */
  level?: IntelligenceLevel;
  /**
   * Converge-on-idle: the debounced pass runs at "fast" for responsiveness,
   * then, if the writer stays idle, the same content re-runs at "high" and
   * the deep result replaces the fast one. The writer never picks a tier —
   * the display simply converges on the best answer available. When set,
   * `level` is ignored.
   */
  converge?: boolean;
  /** Learned biases derived from user annotation corrections. */
  learnedBias?: LearnedBias;
  /** Adaptive online ranker + memory layer layered on top of deterministic rules. */
  adaptiveContext?: AdaptiveInferenceContext;
  /** Collect per-span prediction details used by annotation/debug surfaces. */
  collectPredictionDetails?: boolean;
}

/** How long after the fast result lands before the deep pass starts. */
const CONVERGE_IDLE_MS = 1600;

interface UseAnalysisReturn {
  result: ChapterAnalysisResult | null;
  isAnalyzing: boolean;
  /** True while the idle "high" refinement pass is in flight (converge mode). */
  isRefining: boolean;
  /** Which tier produced the currently displayed result (null = none yet). */
  resultLevel: IntelligenceLevel | null;
  /** All entity names (all types) — exposed so HighlightLayer can highlight all entities. */
  knownNames: string[];
  /** Type-structured entity names — characters only go to speech-detect; the highlight
   *  layer uses this to render places/factions/entities with distinct visual styles. */
  entityNameMap: EntityNameMap;
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
  const { debounceMs = 1000, converge = false } = options;
  // Under converge the first pass is always fast and the refinement is always
  // high; the caller's level applies only to the classic single-pass path.
  const level = converge ? "fast" : (options.level ?? "default");
  const refineLevel: IntelligenceLevel = "high";
  const adaptiveSpeechVersion = options.adaptiveContext?.store.models.speech.version ?? 0;
  const adaptiveActionVersion = options.adaptiveContext?.store.models.action.version ?? 0;
  const [result, setResult] = useState<ChapterAnalysisResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const [resultLevel, setResultLevel] = useState<IntelligenceLevel | null>(null);
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
  const entityNameMap = useMemo(
    () => resolveEntityNameMap({ ...novel, chapters: debouncedChapters }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [novel.worldData, debouncedChapters],
  );
  // All entity names for the highlight layer (places, factions, entities, characters).
  const knownNames = useMemo(() => entityNameMap.all, [entityNameMap]);
  // Character names only — the only type eligible to be attributed as speakers.
  const characterNames = useMemo(() => entityNameMap.characters, [entityNameMap]);

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
    let cancelled = false;
    let refineTimer: number | null = null;

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const siblingStats: ChapterStats[] = [];
          for (let i = 0; i < chapters.length; i++) {
            if (i === currentIndex) continue;
            const cached = cache.current.get(chapters[i].id);
            if (!cached) continue;
            siblingStats.push(
              computeChapterStats(cached.paragraphs, cached.speechResults),
            );
          }

          let prevContext: ChapterEndContext | null = null;
          for (let i = currentIndex - 1; i >= 0; i--) {
            const cached = cache.current.get(chapters[i].id);
            if (cached?.endContext) { prevContext = cached.endContext; break; }
          }

          const input = {
            chapter,
            prevContext,
            siblingStats,
            knownNames: characterNames,
            worldData: novel.worldData, // speech-detect only receives character names
            level,
            learnedBias: options.learnedBias,
            adaptiveContext: options.adaptiveContext,
            collectPredictionDetails: options.collectPredictionDetails,
          };
          const startedAt = performance.now();
          const fresh = await runChapterAnalysisInWorker(input).catch(() => runChapterAnalysis(input));
          logPerfEvent("analysis.current", performance.now() - startedAt, 8, {
            chapterId: chapter.id,
            paragraphs: fresh.paragraphs.length,
          });
          if (cancelled) return;
          cache.current.set(currentChapterId, fresh);
          setResult(fresh);
          setResultLevel(level);
          resultChapterId.current = currentChapterId;

          // Converge-on-idle: the fast answer is on screen; if the writer
          // stays idle, quietly replace it with the deep one. Any edit or
          // chapter switch re-runs this effect, whose cleanup cancels both
          // the timer and an in-flight refinement commit.
          if (converge) {
            refineTimer = window.setTimeout(() => {
              void (async () => {
                setIsRefining(true);
                try {
                  const refineStart = performance.now();
                  const refineInput = { ...input, level: refineLevel };
                  const refined = await runChapterAnalysisInWorker(refineInput)
                    .catch(() => runChapterAnalysis(refineInput));
                  logPerfEvent("analysis.refine", performance.now() - refineStart, 8, {
                    chapterId: chapter.id,
                  });
                  if (cancelled) return;
                  cache.current.set(currentChapterId, refined);
                  setResult(refined);
                  setResultLevel(refineLevel);
                } finally {
                  if (!cancelled) setIsRefining(false);
                }
              })();
            }, CONVERGE_IDLE_MS);
          }
        } finally {
          if (!cancelled) setIsAnalyzing(false);
        }
      })();
    }, debounceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (refineTimer !== null) window.clearTimeout(refineTimer);
      setIsRefining(false);
    };
  }, [novel.chapters, currentChapterId, debounceMs, level, converge, knownNames, options.learnedBias, adaptiveSpeechVersion, adaptiveActionVersion, options.collectPredictionDetails]);

  // High-mode background pre-scan: when intelligence is set to "high" and an
  // adjacent chapter hasn't been visited yet, run its analysis in the background
  // so the CrossArcWidget has data without requiring the user to navigate there.
  // Runs after the current chapter's result lands (result dep), deferred by a
  // short timeout so it doesn't compete with the in-flight main analysis render.
  useEffect(() => {
    // Adjacent pre-analysis runs whenever the deep tier is in play — either
    // the classic "high" setting or converge mode (whose refinement is high).
    if (level !== "high" && !converge) return;
    if (!currentChapterId) return;

    let cancelled = false;
    let idleHandle: IdleHandle | null = null;

    const scheduleTaskQueue = (tasks: Array<() => Promise<void>>) => {
      if (cancelled || tasks.length === 0) return;
      idleHandle = scheduleIdle(() => {
        idleHandle = null;
        if (cancelled) return;
        const task = tasks.shift();
        if (!task) return;
        void task().finally(() => {
          if (tasks.length > 0) scheduleTaskQueue(tasks);
        });
      });
    };

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

      const tasks: Array<() => Promise<void>> = [];

      if (needPrev) {
        const prevChapter = chapters[idx - 1];
        let prevCtx: ChapterEndContext | null = null;
        for (let i = idx - 2; i >= 0; i--) {
          const c = cache.current.get(chapters[i].id);
          if (c?.endContext) { prevCtx = c.endContext; break; }
        }
        tasks.push(async () => {
          const input = {
            chapter: prevChapter,
            prevContext: prevCtx,
            siblingStats: buildSiblings(prevChapter.id),
            knownNames: characterNames,
            worldData: novel.worldData,
            level: converge ? refineLevel : level,
            learnedBias: options.learnedBias,
          };
          const fresh = await runChapterAnalysisInWorker(input).catch(() => runChapterAnalysis(input));
          if (cancelled) return;
          cache.current.set(prevChapter.id, fresh);
          setAdjacentReady((v) => v + 1);
        });
      }

      if (needNext) {
        const nextChapter = chapters[idx + 1];
        tasks.push(async () => {
          const input = {
            chapter: nextChapter,
            prevContext: currentCached.endContext,
            siblingStats: buildSiblings(nextChapter.id),
            knownNames: characterNames,
            worldData: novel.worldData,
            level: converge ? refineLevel : level,
            learnedBias: options.learnedBias,
          };
          const fresh = await runChapterAnalysisInWorker(input).catch(() => runChapterAnalysis(input));
          if (cancelled) return;
          cache.current.set(nextChapter.id, fresh);
          setAdjacentReady((v) => v + 1);
        });
      }

      scheduleTaskQueue(tasks);
    }, 200); // yield to the main analysis render before starting background work

    return () => {
      cancelled = true;
      window.clearTimeout(t);
      if (idleHandle !== null) cancelIdle(idleHandle);
    };
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

  return { result, isAnalyzing, isRefining, resultLevel, knownNames, entityNameMap, prevResult, nextResult };
}
