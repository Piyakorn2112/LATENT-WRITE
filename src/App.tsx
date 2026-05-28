import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { Toolbar } from "./components/Toolbar";
import { Editor } from "./components/Editor";
import { IndexView } from "./components/IndexView";
import { WorldDataView } from "./components/WorldDataView";
import { SplitDivider } from "./components/SplitDivider";
import { EntityPopover } from "./components/EntityPopover";
import { AnnotationPopover } from "./components/AnnotationPopover";
import { DebugPanel } from "./components/DebugPanel";

import { StatusPill, type StatusTask } from "./components/StatusPill";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { ScrollEdgeTop } from "./components/ScrollEdgeTop";
import { FindReplace } from "./components/FindReplace";
import { WordCount } from "./components/WordCount";
import { ProjectSearch } from "./components/ProjectSearch";
import { Onboarding } from "./components/Onboarding";
import { PdfExportOverlay } from "./components/PdfExportOverlay";
import { novelToMarkdown, novelToDocx, downloadBlob } from "./lib/text-export";
import { newChapter, parseNovel, serializeNovel, uid, emptyNovel } from "./lib/parser";
import { useUndoRedo } from "./lib/use-undo-redo";
import { autoParagraph } from "./lib/auto-paragraph";
import { autoSceneBreaks } from "./lib/auto-scene-break";
import {
  buildNovelHtml,
  printNovelBrowser,
  type PdfExportOptions,
} from "./lib/pdf-export";
import {
  loadNovel,
  loadNovelFromProject,
  saveNovel,
  loadCurrentChapterId,
  loadCurrentChapterIdFromProject,
  resolvePersistedCurrentChapterId,
  saveCurrentChapterId,
  clearProjectLocalStorage,
} from "./lib/storage";
import {
  emptyStoryGraph,
  loadStoryGraph, loadStoryGraphFromProject,
  saveStoryGraph, buildChapterEntry, enrichChapterEntryWithLM,
} from "./lib/story-graph";
import { loadReviewResults, loadReviewResultsFromProject, saveReviewResults } from "./lib/renderer-review";
import { getCurrentProject, reopenLastProject, openProject, scanExternalProject, importTools } from "./lib/project-manager";
import type { ToolScanEntry } from "./lib/project-manager";
import { ToolImportOverlay } from "./components/ToolImportOverlay";
import type { ToolHighlight } from "./lib/tool-runner";
import type { StoryGraph, ReviewResult } from "./types";
import { useAnalysis } from "./lib/use-analysis";
import { lightweightPrescan } from "./lib/auto-intel";
import { renameInBook, renameInText } from "./lib/world-data";
import {
  loadPrefs, savePrefs, todayKey, loadDailyTotal, saveDailyTotal,
  FONT_STACKS, type Preferences,
} from "./lib/preferences";
import { loadLicense, type Tier } from "./lib/license";
import {
  loadAnnotationStore,
  loadAnnotationStoreFromProject,
  saveAnnotationStore,
  addCorrection,
  clearAnnotations,
  exportAnnotationsJSON,
} from "./lib/annotation-store";
import { computeLearnedBias, characterBreakdown } from "./lib/annotation-learn";
import {
  computeAdaptiveMetrics,
  emptyAdaptiveStore,
  loadAdaptiveStore,
  loadAdaptiveStoreFromProject,
  saveAdaptiveStore,
  upsertAdaptivePredictions,
} from "./lib/adaptive-store";
import { buildAdaptiveInferenceContext } from "./lib/adaptive-inference";
import { applyOnlineAdaptiveUpdate, retrainAdaptiveModels } from "./lib/adaptive-ranker";
import type {
  AdaptivePredictionRecord,
  AdaptivePredictionTrace,
  Novel,
  WorldData,
  AnnotationTarget,
  LearnedBias,
} from "./types";

// Window.electronAPI type is declared in src/lib/project-manager.ts

const ELECTRON_WINDOW_UNFOCUSED_CLASS = "electron-window-unfocused";
const ELECTRON_WINDOW_UNFOCUSED_ORB_PAUSED_CLASS = "electron-window-unfocused-orb-paused";
const ELECTRON_WINDOW_UNFOCUSED_ORB_PAUSE_MS = 180;
const SCROLL_EDGE_IDLE_CLASS = "scroll-edge-idle";
const SCROLL_EDGE_IDLE_MS = 30_000;
const SCROLL_EDGE_ACTIVITY_THROTTLE_MS = 250;

function countWords(text: string): number {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    const ws = ch === 32 || ch === 10 || ch === 13 || ch === 9 || ch === 12;
    if (ws) { inWord = false; }
    else if (!inWord) { count++; inWord = true; }
  }
  return count;
}

function totalWordsInNovel(novel: Novel): number {
  let n = 0;
  for (const c of novel.chapters) {
    n += countWords(c.content);
  }
  return n;
}

function hasDesktopDraftContent(novel: Novel): boolean {
  if ((novel.meta.title || "").trim() && novel.meta.title.trim() !== "Untitled") return true;
  if ((novel.meta.subtitle || "").trim()) return true;
  if ((novel.meta.author || "").trim()) return true;
  if ((novel.meta.description || "").trim()) return true;
  if (novel.chapters.some((chapter) => chapter.title.trim() || chapter.content.trim())) return true;

  const worldData = novel.worldData;
  return !!worldData && (
    (worldData.characters?.length ?? 0) > 0 ||
    (worldData.places?.length ?? 0) > 0 ||
    (worldData.factions?.length ?? 0) > 0 ||
    (worldData.entities?.length ?? 0) > 0
  );
}

export default function App() {
  const [novel, setNovel] = useState<Novel>(() => loadNovel());
  // Initial chapter pick: prefer the last-opened chapter from localStorage,
  // but only if it's still present in the loaded novel (chapters can be
  // deleted between sessions). Falls back to chapter[0]. The id is persisted
  // on every change via the effect below so refresh keeps the writer's
  // place across sessions.
  const [currentId, setCurrentId] = useState<string | null>(() => {
    const initial = loadNovel();
    const saved = loadCurrentChapterId();
    if (saved && initial.chapters.some((c) => c.id === saved)) return saved;
    return initial.chapters[0]?.id ?? null;
  });
  const currentChapterForPersist = useMemo(() => {
    const chapter = novel.chapters.find((candidate) => candidate.id === currentId);
    return chapter ? { number: chapter.number, title: chapter.title } : null;
  }, [novel.chapters, currentId]);

  const undoRedo = useUndoRedo();
  const undoRedoSkipRef = useRef(false);

  useEffect(() => {
    if (undoRedoSkipRef.current) {
      undoRedoSkipRef.current = false;
      return;
    }
    undoRedo.push(novel);
  }, [novel]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUndo = useCallback(() => {
    const prev = undoRedo.undo();
    if (!prev) return;
    undoRedoSkipRef.current = true;
    setNovel(prev);
    if (!prev.chapters.some((c) => c.id === currentId) && prev.chapters.length > 0) {
      setCurrentId(prev.chapters[0].id);
    }
    setSecondaryId((sid) => {
      if (!sid) return sid;
      return prev.chapters.some((c) => c.id === sid) ? sid : null;
    });
  }, [undoRedo, currentId]);

  const handleRedo = useCallback(() => {
    const next = undoRedo.redo();
    if (!next) return;
    undoRedoSkipRef.current = true;
    setNovel(next);
    if (!next.chapters.some((c) => c.id === currentId) && next.chapters.length > 0) {
      setCurrentId(next.chapters[0].id);
    }
    setSecondaryId((sid) => {
      if (!sid) return sid;
      return next.chapters.some((c) => c.id === sid) ? sid : null;
    });
  }, [undoRedo, currentId]);

  // ── Split-screen state ──────────────────────────────────────────────────
  const [secondaryId, setSecondaryId] = useState<string | null>(null);
  const [activeSide, setActiveSide] = useState<"left" | "right">("left");
  const [splitRatio, setSplitRatio] = useState(0.5);

  const hydrateProjectState = useCallback(async () => {
    const [pNovel, pCurrentChapter, pStoryGraph, pReviews, pAnnotations, pAdaptive] = await Promise.all([
      loadNovelFromProject(),
      loadCurrentChapterIdFromProject(),
      loadStoryGraphFromProject(),
      loadReviewResultsFromProject(),
      loadAnnotationStoreFromProject(),
      loadAdaptiveStoreFromProject(),
    ]);

    const nextNovel = pNovel ?? emptyNovel();
    const restoredChapterId = resolvePersistedCurrentChapterId(nextNovel.chapters, pCurrentChapter);
    const nextChapterId = restoredChapterId ?? nextNovel.chapters[0]?.id ?? null;
    const nextStoryGraph = pStoryGraph ?? emptyStoryGraph();
    const nextReviewResults = pReviews ?? {};
    const nextAnnotationStore = pAnnotations ?? { version: 1, corrections: [] };
    const nextAdaptiveStore = pAdaptive ?? emptyAdaptiveStore();

    setNovel(nextNovel);
    setCurrentId(nextChapterId);
    baselineRef.current = totalWordsInNovel(nextNovel);
    setStoryGraph(nextStoryGraph);
    setReviewResults(nextReviewResults);
    setAnnotationStore(nextAnnotationStore);
    setAdaptiveStore(nextAdaptiveStore);
    setAnnotationTarget(null);
    setEntityPopover(null);
    setToolHighlights([]);

    // Empty folders must become explicit blank projects so a renderer refresh
    // cannot fall back to whatever was previously cached before Electron IPC hydrates.
    if (!pNovel) saveNovel(nextNovel);
    if (!pNovel || restoredChapterId !== nextChapterId) {
      saveCurrentChapterId(
        nextChapterId,
        nextNovel.chapters.find((chapter) => chapter.id === nextChapterId) ?? null,
      );
    }
    if (!pStoryGraph) saveStoryGraph(nextStoryGraph);
    if (!pReviews) saveReviewResults(nextReviewResults);
    if (!pAnnotations) saveAnnotationStore(nextAnnotationStore);
    if (!pAdaptive) saveAdaptiveStore(nextAdaptiveStore);
  }, []);

  // ── Desktop project hydration ──────────────────────────────────────────
  // On mount in Electron: reopen the last project and load all state from
  // the project filesystem. Desktop mode never reads/writes localStorage
  // for project data — clear any stale keys left from earlier versions.
  const [projectLoading, setProjectLoading] = useState(() => !!window.electronAPI);
  const [desktopProjectOpen, setDesktopProjectOpen] = useState(false);
  const syncDesktopProjectOpen = useCallback(async () => {
    if (!window.electronAPI) {
      setDesktopProjectOpen(false);
      return;
    }
    const project = await getCurrentProject();
    setDesktopProjectOpen(!!project);
  }, []);

  useEffect(() => {
    if (!window.electronAPI) return;
    clearProjectLocalStorage();
    let cancelled = false;
    (async () => {
      const project = await reopenLastProject();
      if (cancelled || !project) {
        setDesktopProjectOpen(false);
        setProjectLoading(false);
        return;
      }
      setDesktopProjectOpen(true);
      await hydrateProjectState();
      if (cancelled) return;
      setProjectLoading(false);
      window.dispatchEvent(new CustomEvent("project-ready"));
    })();
    return () => { cancelled = true; };
  }, [hydrateProjectState]);

  const needsProjectSaveWarning = useMemo(
    () => !!window.electronAPI && !desktopProjectOpen && hasDesktopDraftContent(novel),
    [desktopProjectOpen, novel],
  );

  useEffect(() => {
    if (window.electronAPI && projectLoading) return;
    saveCurrentChapterId(currentId, currentChapterForPersist);
  }, [currentId, currentChapterForPersist?.number, currentChapterForPersist?.title, projectLoading]);

  useEffect(() => {
    window.electronAPI?.setDraftGuardState?.({ hasUnsavedLocalDraft: needsProjectSaveWarning });
  }, [needsProjectSaveWarning]);

  const [indexOpen, setIndexOpen] = useState(false);
  const [worldOpen, setWorldOpen] = useState(false);
  const [pdfExportOpen, setPdfExportOpen] = useState(false);
  // Auto-paragraph processing state — drives both the AnalysisPanel
  // button's "working" pulse and the editor's ambient scan-orb gradient.
  // The actual paragraphing pass is fast (synchronous, sub-frame on
  // typical chapters); the lifetime of this flag is mostly UX feedback.
  const [autoParagraphing, setAutoParagraphing] = useState(false);
  // Same shape, separate flag — for the auto-scene-break pass. Kept
  // distinct so the two buttons can be in different states (e.g. user
  // hits paragraph then immediately scene-break) and the StatusPill
  // can read different labels.
  const [sceneBreaking, setSceneBreaking] = useState(false);
  const [savedVisible, setSavedVisible] = useState(false);
  const [intelMode, setIntelMode] = useState<"off" | "fast" | "default" | "high" | "auto">(() => loadPrefs().intelMode ?? "auto");
  const [findOpen, setFindOpen] = useState(false);
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [analysisPanelOpen, setAnalysisPanelOpen] = useState(false);
  const [toolImportState, setToolImportState] = useState<{
    tools: ToolScanEntry[];
    sourcePath: string;
  } | null>(null);
  const [toolHighlights, setToolHighlights] = useState<ToolHighlight[]>([]);
  const [prefs, setPrefs] = useState<Preferences>(() => loadPrefs());
  const [tier, setTier] = useState<Tier>(() => loadLicense().tier);
  const handleTierChange = useCallback((t: Tier) => {
    setTier(t);
    setIntelMode(t === "pro" ? "default" : "auto");
  }, []);
  const [storyGraph, setStoryGraph] = useState<StoryGraph>(() => loadStoryGraph());
  // Ref so the storyGraph effect can read current entries without stale closure
  const storyGraphRef = useRef(storyGraph);
  useEffect(() => { storyGraphRef.current = storyGraph; }, [storyGraph]);
  const [reviewResults, setReviewResults] = useState<Record<string, ReviewResult>>(() => loadReviewResults());
  // Onboarding auto-shows on first launch and is re-openable from the
  // Help menu. Initial value is derived from prefs once at mount.
  const [onboardingOpen, setOnboardingOpen] = useState<boolean>(
    () => !loadPrefs().hasSeenOnboarding,
  );

  // Inline entity popover — opened by clicking a highlighted name in the editor.
  const [entityPopover, setEntityPopover] = useState<{ name: string; anchor: DOMRect } | null>(null);

  // ── Chapter derivations ────────────────────────────────────────────────
  const chapters = novel.chapters;
  const currentIndex = useMemo(
    () => chapters.findIndex((c) => c.id === currentId),
    [chapters, currentId]
  );
  const current = currentIndex >= 0 ? chapters[currentIndex] : null;

  const splitView = !!prefs.splitView && chapters.length > 1;

  const activeChapterId = splitView
    ? (activeSide === "left" ? currentId : secondaryId)
    : currentId;

  const secondaryIndex = useMemo(
    () => secondaryId ? chapters.findIndex((c) => c.id === secondaryId) : -1,
    [chapters, secondaryId],
  );
  const secondaryChapter = secondaryIndex >= 0 ? chapters[secondaryIndex] : null;

  const activeChapterIndex = useMemo(
    () => activeChapterId ? chapters.findIndex((c) => c.id === activeChapterId) : -1,
    [chapters, activeChapterId],
  );
  const activeChapter = activeChapterIndex >= 0 ? chapters[activeChapterIndex] : null;

  // ── Annotation mode ────────────────────────────────────────────────────
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotationStore, setAnnotationStore] = useState(() => loadAnnotationStore());
  const [adaptiveStore, setAdaptiveStore] = useState(() => loadAdaptiveStore());
  const [learnedBias, setLearnedBias] = useState<LearnedBias | null>(null);
  const [annotationTarget, setAnnotationTarget] = useState<{ target: AnnotationTarget; anchor: DOMRect; correctedSpeaker?: string | null } | null>(null);

  const chapterOrderKey = novel.chapters.map((chapter) => chapter.id).join("\u001f");
  const chapterOrderIds = useMemo(
    () => novel.chapters.map((chapter) => chapter.id),
    [chapterOrderKey],
  );

  // Persist annotation store whenever it changes.
  useEffect(() => {
    saveAnnotationStore(annotationStore);
  }, [annotationStore]);

  // Chapter-aware bias uses chapter order + current chapter, not chapter text,
  // so it stays off the live-typing hot path.
  useEffect(() => {
    const bias = computeLearnedBias(annotationStore, novel.worldData, {
      currentChapterId: activeChapterId,
      chapterIds: chapterOrderIds,
    });
    setLearnedBias(bias);
  }, [annotationStore, novel.worldData, activeChapterId, chapterOrderIds]);

  useEffect(() => {
    saveAdaptiveStore(adaptiveStore);
  }, [adaptiveStore]);

  useEffect(() => {
    setAdaptiveStore((store) => {
      const labeledPredictions = store.predictions.filter((prediction) => prediction.correctedLabel !== undefined);
      return labeledPredictions.length === store.predictions.length
        ? store
        : { ...store, predictions: labeledPredictions };
    });
  }, []);

  const adaptiveContext = useMemo(
    () => buildAdaptiveInferenceContext(adaptiveStore, novel.worldData),
    [adaptiveStore, novel.worldData],
  );

  const adaptiveMetrics = useMemo(
    () => computeAdaptiveMetrics(adaptiveStore),
    [adaptiveStore],
  );

  const collectPredictionDetails = annotationMode || !!prefs.debugPanel;
  // Prediction-detail collection should not change the baseline chapter-analysis
  // cadence; forcing 0 ms here makes the analyzing indicator flicker on every
  // keystroke and changes refresh-time behaviour versus the original app.
  const analysisDebounceMs = 1000;

  const chapterCorrectionCount = useMemo(
    () => annotationStore.corrections.filter((correction) => correction.chapterId === activeChapterId).length,
    [annotationStore.corrections, activeChapterId],
  );

  const globalCorrectionCount = annotationStore.corrections.length;

  const annotationBreakdown = useMemo(
    () => characterBreakdown(annotationStore, activeChapterId),
    [annotationStore, activeChapterId],
  );


  // Build a lookup map so HighlightLayer can colour corrected spans immediately
  // without waiting for a full re-analysis pass.
  const annotationOverrides = useMemo<Map<string, string | null> | undefined>(() => {
    if (!activeChapterId) return undefined;
    const relevant = annotationStore.corrections.filter((c) => c.chapterId === activeChapterId);
    if (!relevant.length) return undefined;
    const map = new Map<string, string | null>();
    for (const c of relevant) {
      map.set(`${c.paragraphIndex}-${c.spanIndex}-${c.spanType}`, c.correctedSpeaker);
    }
    return map;
  }, [annotationStore.corrections, activeChapterId]);

  const handleSpeechAnnotate = useCallback((info: AnnotationTarget, anchor: DOMRect) => {
    const existing = activeChapterId
      ? annotationStore.corrections.find(
          (c) =>
            c.chapterId === activeChapterId &&
            c.paragraphIndex === info.paragraphIndex &&
            c.spanIndex === info.spanIndex &&
            c.spanType === "speech",
        )
      : undefined;
    const correctedSpeaker = existing ? existing.correctedSpeaker : undefined;
    setAnnotationTarget({ target: info, anchor, correctedSpeaker });
  }, [activeChapterId, annotationStore.corrections]);

  const handleActionAnnotate = useCallback((info: AnnotationTarget, anchor: DOMRect) => {
    const existing = activeChapterId
      ? annotationStore.corrections.find(
          (c) =>
            c.chapterId === activeChapterId &&
            c.paragraphIndex === info.paragraphIndex &&
            c.spanIndex === info.spanIndex &&
            c.spanType === "action",
        )
      : undefined;
    const correctedSpeaker = existing ? existing.correctedSpeaker : undefined;
    setAnnotationTarget({ target: info, anchor, correctedSpeaker });
  }, [activeChapterId, annotationStore.corrections]);

  const handleExportAnnotations = useCallback(() => {
    exportAnnotationsJSON(annotationStore, novel.meta.title);
  }, [annotationStore, novel.meta.title]);

  const handleClearAnnotations = useCallback(() => {
    setAnnotationStore(clearAnnotations());
    setAdaptiveStore((store) => {
      const cleared = {
        ...store,
        predictions: store.predictions.map((prediction) => {
          const { correctedLabel, ...rest } = prediction;
          return rest;
        }),
      };
      return {
        ...cleared,
        models: retrainAdaptiveModels(cleared),
      };
    });
  }, []);
  const [renameTask, setRenameTask] = useState<StatusTask | null>(null);
  const cycleIntel = useCallback(() => {
    setIntelMode((m) => {
      if (tier === "free") {
        return m === "off" ? "auto" : "off";
      }
      const order = ["auto", "default", "high", "fast", "off"] as const;
      return order[(order.indexOf(m) + 1) % order.length];
    });
  }, [tier]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const firstRunRef = useRef(true);
  const hideTimerRef = useRef<number | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const cancelPendingProjectSave = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    setSavedVisible(false);
  }, []);

  // Daily writing tracking — anchored on the *baseline* total at session start
  // for today's date. Words written today = current total − baseline. If the
  // user already had progress earlier today, that's preserved via localStorage.
  const dateRef = useRef<string>(todayKey());
  const baselineRef = useRef<number>(totalWordsInNovel(novel));
  const todayCarryRef = useRef<number>(loadDailyTotal(todayKey()));
  const [todayWords, setTodayWords] = useState<number>(loadDailyTotal(todayKey()));

  // Recompute todayWords whenever novel changes. Use deltas vs the session
  // baseline; saturate at 0 so deletions don't drive a negative count.
  useEffect(() => {
    const today = todayKey();
    if (today !== dateRef.current) {
      // Crossed midnight — start a fresh day's count.
      dateRef.current = today;
      baselineRef.current = totalWordsInNovel(novel);
      todayCarryRef.current = 0;
      setTodayWords(0);
      saveDailyTotal(today, 0);
      return;
    }
    const cur = totalWordsInNovel(novel);
    const delta = Math.max(0, cur - baselineRef.current);
    const total = todayCarryRef.current + delta;
    setTodayWords(total);
    saveDailyTotal(today, total);
  }, [novel]);

  // Midnight tick: re-check the date once a minute even when there are no
  // edits, so a session left open across midnight rolls over cleanly. The
  // recompute path above handles all the actual work; we just nudge it by
  // updating dateRef when the day changes and forcing a state refresh.
  useEffect(() => {
    const id = window.setInterval(() => {
      const today = todayKey();
      if (today !== dateRef.current) {
        dateRef.current = today;
        baselineRef.current = totalWordsInNovel(novel);
        todayCarryRef.current = loadDailyTotal(today);
        setTodayWords(todayCarryRef.current);
      }
    }, 60_000);
    return () => window.clearInterval(id);
  }, [novel]);

  // Persist on every change (debounced). Skip during project hydration so
  // the stale localStorage cache doesn't overwrite filesystem state.
  useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false;
      return;
    }
    if (projectLoading) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      saveNovel(novel);
      setSavedVisible(true);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = window.setTimeout(() => setSavedVisible(false), 1200);
    }, 350);
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [novel, projectLoading]);

  // Persist prefs immediately — they're tiny.
  useEffect(() => { savePrefs(prefs); }, [prefs]);
  useEffect(() => { setPrefs((p) => ({ ...p, intelMode })); }, [intelMode]);

  const autoResolvedLevel = useMemo<"fast" | "default" | "high">(() => {
    if (intelMode !== "auto") return "default";
    const chapter = novel.chapters.find((c) => c.id === activeChapterId);
    if (!chapter) return "default";
    const paragraphs = chapter.content.split(/\n{2,}|\n/).map((l) => l.trim()).filter(Boolean);
    return lightweightPrescan(paragraphs);
  }, [intelMode, novel.chapters, activeChapterId]);

  const effectiveLevel: "fast" | "default" | "high" =
    intelMode === "auto" ? autoResolvedLevel
    : intelMode === "off" ? "default"
    : intelMode;

  const {
    result: analysisResult,
    isAnalyzing: analysisRunning,
    knownNames,
    entityNameMap,
    prevResult: prevAnalysisResult,
    nextResult: nextAnalysisResult,
  } = useAnalysis(novel, activeChapterId, {
    debounceMs: analysisDebounceMs,
    level: effectiveLevel,
    learnedBias: learnedBias ?? undefined,
    adaptiveContext: annotationStore.corrections.length > 0 ? adaptiveContext : undefined,
    collectPredictionDetails,
  });

  // Update StoryGraph entry whenever analysis settles.
  // Deferred with setTimeout so heavy NLP never blocks a keystroke frame.
  // Content hash dedup prevents re-running NLP if the chapter text is unchanged.
  useEffect(() => {
    if (!analysisResult || !activeChapter || !activeChapter.content.trim()) return;
    if (prefs.storyNlpEnabled === false) return; // user disabled background analysis
    const chapterId = activeChapter.id;
    const content   = activeChapter.content;
    const hash = `${content.length}|${content.slice(0, 60)}`;

    const timer = setTimeout(() => {
      // Skip if content unchanged since last build
      if (storyGraphRef.current.entries[chapterId]?.contentHash === hash) return;

      const entry = buildChapterEntry(activeChapter, analysisResult, novel.worldData);
      setStoryGraph(prev => ({ ...prev, entries: { ...prev.entries, [chapterId]: entry } }));

      enrichChapterEntryWithLM(entry, content).then(enriched => {
        setStoryGraph(prev => ({ ...prev, entries: { ...prev.entries, [enriched.chapterId]: enriched } }));
      }).catch(() => {});
    }, 120); // yield current frame; 120ms is imperceptible for graph updates

    return () => clearTimeout(timer);
  }, [analysisResult]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { saveStoryGraph(storyGraph); }, [storyGraph]);
  useEffect(() => { saveReviewResults(reviewResults); }, [reviewResults]);

  const handleReviewComplete = useCallback((result: ReviewResult) => {
    setReviewResults((prev) => ({ ...prev, [result.chapterId]: result }));
  }, []);

  const handleProjectLoaded = useCallback(async (incomingNovel: Novel | null) => {
    cancelPendingProjectSave();
    if (window.electronAPI) {
      setProjectLoading(true);
      try {
        await hydrateProjectState();
        await syncDesktopProjectOpen();
      } finally {
        setProjectLoading(false);
      }
      return;
    }

    if (incomingNovel && incomingNovel.chapters.length > 0) {
      setNovel(incomingNovel);
      setCurrentId(incomingNovel.chapters[0]?.id ?? null);
      baselineRef.current = totalWordsInNovel(incomingNovel);
    } else {
      const empty = { ...emptyNovel() };
      setNovel(empty);
      setCurrentId(null);
      baselineRef.current = 0;
    }
    setStoryGraph(emptyStoryGraph());
    setReviewResults({});
    setAnnotationStore({ version: 1, corrections: [] });
    setAdaptiveStore(emptyAdaptiveStore());
    setAnnotationTarget(null);
    setEntityPopover(null);
    setSecondaryId(null);
    setActiveSide("left");
  }, [cancelPendingProjectSave, hydrateProjectState, syncDesktopProjectOpen]);

  const handleNovelRefresh = useCallback(async (incomingNovel: Novel | null) => {
    if (!incomingNovel || incomingNovel.chapters.length === 0) return;
    const restoredChapterId = window.electronAPI
      ? resolvePersistedCurrentChapterId(
          incomingNovel.chapters,
          await loadCurrentChapterIdFromProject(),
        )
      : null;
    setNovel(incomingNovel);
    setCurrentId((prev) => {
      if (restoredChapterId && incomingNovel.chapters.some((c) => c.id === restoredChapterId)) {
        return restoredChapterId;
      }
      if (prev && incomingNovel.chapters.some((c) => c.id === prev)) return prev;
      return incomingNovel.chapters[0]?.id ?? null;
    });
    baselineRef.current = totalWordsInNovel(incomingNovel);
  }, []);

  const [existingToolNames, setExistingToolNames] = useState<Set<string>>(new Set());

  const handleImportTools = useCallback(async () => {
    const result = await scanExternalProject();
    if (!result.ok || result.canceled || !result.tools?.length || !result.sourcePath) return;
    // Check what tools already exist in the current project
    const api = window.electronAPI;
    const names = new Set<string>();
    if (api) {
      const tree = await api.projectListTree();
      const toolsNode = tree.find((n: { name: string; type: string }) => n.name === "tools" && n.type === "directory");
      if (toolsNode && Array.isArray((toolsNode as { children?: unknown[] }).children)) {
        for (const child of (toolsNode as { children: Array<{ name: string; type: string; children?: Array<{ name: string }> }> }).children) {
          if (child.type === "directory" && child.children?.some((f) => f.name === "tool.json")) {
            const manifestResult = await api.projectReadFile(`tools/${child.name}/tool.json`);
            if (manifestResult.ok && manifestResult.content) {
              try { names.add(JSON.parse(manifestResult.content).name); } catch { /* skip */ }
            }
          }
        }
      }
    }
    setExistingToolNames(names);
    setToolImportState({ tools: result.tools, sourcePath: result.sourcePath });
  }, []);

  const handleImportToolsConfirm = useCallback(async (imports: Array<{ dirName: string; targetName?: string }>) => {
    if (!toolImportState) return;
    await importTools(toolImportState.sourcePath, imports);
    setToolImportState(null);
  }, [toolImportState]);

  const handleToolHighlights = useCallback((highlights: ToolHighlight[]) => {
    setToolHighlights(highlights);
  }, []);

  const handleOpenProject = useCallback(async () => {
    cancelPendingProjectSave();
    setProjectLoading(true);
    try {
      const proj = await openProject();
      if (!proj) return;
      clearProjectLocalStorage();
      await hydrateProjectState();
      await syncDesktopProjectOpen();
      window.dispatchEvent(new CustomEvent("project-ready"));
    } finally {
      setProjectLoading(false);
    }
  }, [cancelPendingProjectSave, hydrateProjectState, syncDesktopProjectOpen]);

  const handleAnnotationConfirm = useCallback((correctedName: string | null) => {
    if (!annotationTarget || !activeChapterId) { setAnnotationTarget(null); return; }
    const { target } = annotationTarget;
    const timestamp = Date.now();
    const correction = {
      id: uid(),
      timestamp,
      chapterId: activeChapterId,
      paragraphIndex: target.paragraphIndex,
      spanIndex: target.spanIndex,
      spanType: target.spanType,
      originalSpeaker: target.currentSpeaker,
      correctedSpeaker: correctedName,
      spanText: target.spanText,
      contextBefore: target.contextBefore,
      contextAfter: target.contextAfter,
    };
    setAnnotationStore((s) => addCorrection(s, correction));

    let predictionRecord: AdaptivePredictionRecord | null = null;
    if (analysisResult) {
      if (target.spanType === "speech") {
        const prediction = analysisResult.speechPredictions.find(
          (candidate) =>
            candidate.paragraphIndex === target.paragraphIndex &&
            candidate.spanIndex === target.spanIndex,
        );
        if (prediction) {
          predictionRecord = {
            ...prediction,
            id: `${activeChapterId}:speech:${prediction.paragraphIndex}:${prediction.spanIndex}`,
            chapterId: activeChapterId,
            correctedLabel: correctedName,
            timestamp,
            modelVersion: adaptiveContext.store.models.speech.version,
          };
        }
      } else {
        const prediction = analysisResult.actionPredictions[target.paragraphIndex]?.find(
          (candidate) => candidate.start === target.spanIndex,
        );
        if (prediction) {
          const paragraph = analysisResult.paragraphs[target.paragraphIndex] ?? "";
          predictionRecord = {
            id: `${activeChapterId}:action:${target.paragraphIndex}:${prediction.start}`,
            task: "action",
            chapterId: activeChapterId,
            paragraphIndex: target.paragraphIndex,
            spanIndex: prediction.start,
            spanText: paragraph.slice(prediction.start, prediction.end),
            contextBefore: paragraph.slice(Math.max(0, prediction.start - 120), prediction.start),
            contextAfter: paragraph.slice(prediction.end, Math.min(paragraph.length, prediction.end + 120)),
            candidates: prediction.candidates,
            predictedLabel: prediction.actor,
            correctedLabel: correctedName,
            confidence: prediction.confidence,
            needsReview: prediction.needsReview,
            ambiguityGap: prediction.ambiguityGap,
            source: "action-rules",
            timestamp,
            modelVersion: adaptiveContext.store.models.action.version,
          };
        }
      }
    }

    if (predictionRecord) {
      setAdaptiveStore((store) => {
        const alreadyLabeled = store.predictions.some(
          (prediction) =>
            prediction.chapterId === activeChapterId &&
            prediction.paragraphIndex === target.paragraphIndex &&
            prediction.spanIndex === target.spanIndex &&
            prediction.task === target.spanType &&
            prediction.correctedLabel !== undefined,
        );
        const next = upsertAdaptivePredictions(store, [predictionRecord]);
        return {
          ...next,
          models: alreadyLabeled
            ? retrainAdaptiveModels(next)
            : applyOnlineAdaptiveUpdate(next.models, predictionRecord),
        };
      });
    }

    setAnnotationTarget(null);
  }, [annotationTarget, activeChapterId, analysisResult, adaptiveContext.store.models.action.version, adaptiveContext.store.models.speech.version]);

  const speechReviewCount = useMemo(
    () => analysisResult?.speechPredictions.filter((prediction) => prediction.needsReview).length ?? 0,
    [analysisResult],
  );

  const actionReviewCount = useMemo(
    () => analysisResult?.actionPredictions.flat().filter((prediction) => prediction.needsReview).length ?? 0,
    [analysisResult],
  );

  const reviewCount = speechReviewCount + actionReviewCount;

  const handleWorldChange = useCallback((next: WorldData) => {
    setNovel((n) => ({ ...n, worldData: next }));
  }, []);

  const handleEntityPredictionFeedback = useCallback((
    scopeId: string,
    decisions: Array<{ prediction: AdaptivePredictionTrace; correctedLabel: string | null }>,
  ) => {
    if (decisions.length === 0) return;
    setAdaptiveStore((store) => {
      const now = Date.now();
      const records: AdaptivePredictionRecord[] = decisions.map(({ prediction, correctedLabel }) => ({
        ...prediction,
        id: `${scopeId}:entity:${prediction.spanIndex}`,
        chapterId: scopeId,
        correctedLabel,
        timestamp: now,
        modelVersion: store.models.entity.version,
      }));
      const next = upsertAdaptivePredictions(store, records);
      return {
        ...next,
        models: retrainAdaptiveModels(next),
      };
    });
  }, []);

  // Stable callback identity — feeds into HighlightLayer's useMemo dep list,
  // so a fresh lambda per render would invalidate the memo every keystroke.
  const handleEntityClick = useCallback((name: string, anchor: DOMRect) => {
    setEntityPopover({ name, anchor });
  }, []);

  const handleRename = useCallback(
    (oldName: string, newName: string, scope: "chapter" | "book") => {
      const old = oldName.trim();
      const next = newName.trim();
      if (!old || !next || old === next) return;

      const label = scope === "book"
        ? `Renaming "${old}" → "${next}" across book…`
        : `Renaming "${old}" → "${next}" in chapter…`;
      setRenameTask({ kind: `rename-${scope}-${old}-${next}`, label });

      window.setTimeout(() => {
        setNovel((n) => {
          if (scope === "book") return renameInBook(n, old, next).novel;
          if (!currentId) return n;
          return {
            ...n,
            chapters: n.chapters.map((c) => {
              if (c.id !== currentId) return c;
              const { text } = renameInText(c.content, old, next);
              return { ...c, content: text };
            }),
          };
        });
        window.setTimeout(() => setRenameTask(null), 450);
      }, 16);
    },
    [currentId],
  );

  const statusTask: StatusTask | null = renameTask
    ?? (autoParagraphing ? { kind: "auto-paragraph", label: "Re-paragraphing chapter…" } : null)
    ?? (sceneBreaking    ? { kind: "auto-paragraph", label: "Inserting scene breaks…"  } : null)
    ?? (analysisRunning  ? { kind: "analyzing",      label: "Analysing chapter…"      } : null);

  // Initialize secondaryId when entering split mode
  useEffect(() => {
    if (splitView && !secondaryId) {
      const idx = chapters.findIndex((c) => c.id === currentId);
      if (idx >= 0 && idx < chapters.length - 1) {
        setSecondaryId(chapters[idx + 1].id);
      } else if (idx > 0) {
        setSecondaryId(chapters[idx - 1].id);
      }
    }
    if (!splitView && secondaryId) {
      if (activeSide === "right" && secondaryId) {
        setCurrentId(secondaryId);
      }
      setSecondaryId(null);
      setActiveSide("left");
    }
  }, [splitView]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateChapterById = useCallback(
    (id: string, mut: (c: Novel["chapters"][number]) => Novel["chapters"][number]) => {
      setNovel((n) => ({
        ...n,
        chapters: n.chapters.map((c) => (c.id === id ? mut(c) : c)),
      }));
    },
    [],
  );

  const updateCurrent = useCallback(
    (mut: (c: Novel["chapters"][number]) => Novel["chapters"][number]) => {
      setNovel((n) => ({
        ...n,
        chapters: n.chapters.map((c) => (c.id === currentId ? mut(c) : c)),
      }));
    },
    [currentId]
  );

  const handleAddChapter = useCallback(() => {
    // Generate the new id ONCE outside the updater. setNovel's updater can be
    // invoked twice in StrictMode (and React legitimately re-runs it under
    // concurrent rendering), so any randomness inside the updater would
    // produce two different chapters with two different ids. Previously a
    // queueMicrotask scheduled inside the updater would set currentId to the
    // discarded run's id — causing the editor to land on "no chapter open"
    // because that id never made it into the committed chapters array.
    const newId = uid();
    setNovel((n) => {
      // Idempotent on re-invocation: if a previous run already appended this
      // id, return the same state.
      if (n.chapters.some((c) => c.id === newId)) return n;
      const nextNumber = n.chapters.length
        ? Math.max(...n.chapters.map((c) => c.number)) + 1
        : 1;
      const fresh = { ...newChapter(nextNumber), id: newId };
      return { ...n, chapters: [...n.chapters, fresh] };
    });
    // React 18 auto-batches this with the setNovel above (both inside the
    // same event/microtask), so currentId and chapters commit together.
    setCurrentId(newId);
  }, []);

  const handleDeleteChapter = useCallback(
    (id: string) => {
      setNovel((n) => {
        const remaining = n.chapters.filter((c) => c.id !== id);
        const renumbered = remaining.map((c, i) => ({ ...c, number: i + 1 }));
        if (currentId === id) {
          const fallback = renumbered[Math.min(currentIndex, renumbered.length - 1)];
          queueMicrotask(() => setCurrentId(fallback?.id ?? null));
        }
        if (secondaryId === id) {
          queueMicrotask(() => setSecondaryId(null));
        }
        return { ...n, chapters: renumbered };
      });
    },
    [currentId, currentIndex, secondaryId]
  );

  // Drag-reorder: move chapter `fromId` to be inserted at `toIndex` in the
  // pre-removal list. Renumber 1..N. Selection follows the moved chapter.
  const handleReorderChapter = useCallback((fromId: string, toIndex: number) => {
    setNovel((n) => {
      const fromIdx = n.chapters.findIndex((c) => c.id === fromId);
      if (fromIdx === -1) return n;
      const arr = n.chapters.slice();
      const [moved] = arr.splice(fromIdx, 1);
      // Adjust insertion index if removal shifted positions.
      const insertAt = fromIdx < toIndex ? toIndex - 1 : toIndex;
      arr.splice(Math.max(0, Math.min(arr.length, insertAt)), 0, moved);
      const renumbered = arr.map((c, i) => ({ ...c, number: i + 1 }));
      return { ...n, chapters: renumbered };
    });
  }, []);

  const handlePrev = useCallback(() => {
    if (splitView && activeSide === "right") {
      if (secondaryIndex > 0) setSecondaryId(chapters[secondaryIndex - 1].id);
      return;
    }
    if (currentIndex > 0) setCurrentId(chapters[currentIndex - 1].id);
  }, [chapters, currentIndex, splitView, activeSide, secondaryIndex]);

  const handleNext = useCallback(() => {
    if (splitView && activeSide === "right") {
      if (secondaryIndex >= 0 && secondaryIndex < chapters.length - 1) {
        setSecondaryId(chapters[secondaryIndex + 1].id);
      }
      return;
    }
    if (currentIndex >= 0 && currentIndex < chapters.length - 1) {
      setCurrentId(chapters[currentIndex + 1].id);
    }
  }, [chapters, currentIndex, splitView, activeSide, secondaryIndex]);

  const handleSecondaryPrev = useCallback(() => {
    if (secondaryIndex > 0) setSecondaryId(chapters[secondaryIndex - 1].id);
  }, [chapters, secondaryIndex]);

  const handleSecondaryNext = useCallback(() => {
    if (secondaryIndex >= 0 && secondaryIndex < chapters.length - 1) {
      setSecondaryId(chapters[secondaryIndex + 1].id);
    }
  }, [chapters, secondaryIndex]);

  const flushSave = useCallback(() => {
    saveNovel(novel);
    setSavedVisible(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setSavedVisible(false), 1200);
  }, [novel]);

  const handleExport = useCallback(() => {
    const text = serializeNovel(novel);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeTitle = (novel.meta.title || "novel").replace(/[^\w\d-]+/g, "-").toLowerCase();
    a.href = url;
    a.download = `${safeTitle}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [novel]);

  // PDF export now opens the format/paper-size overlay first. The actual
  // export runs in `doExportPdf` after the user picks options. The Electron
  // menu's `export-pdf` and the toolbar's PDF button both route through the
  // overlay so the choice surface is consistent across triggers.
  const handleExportPdf = useCallback(() => {
    setPdfExportOpen(true);
  }, []);

  const handleExportMarkdown = useCallback(() => {
    const safeTitle = (novel.meta.title || "novel").replace(/[^\w\d-]+/g, "-").toLowerCase();
    downloadBlob(`${safeTitle}.md`, novelToMarkdown(novel), "text/markdown;charset=utf-8");
  }, [novel]);

  const handleExportDocx = useCallback(() => {
    const safeTitle = (novel.meta.title || "novel").replace(/[^\w\d-]+/g, "-").toLowerCase();
    downloadBlob(
      `${safeTitle}.docx`,
      novelToDocx(novel),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  }, [novel]);

  const doExportPdf = useCallback(
    async (options: PdfExportOptions) => {
      setPdfExportOpen(false);
      const safeTitle = (novel.meta.title || "novel").replace(/[^\w\d-]+/g, "-").toLowerCase();
      const filename = `${safeTitle}.pdf`;
      if (window.electronAPI) {
        const html = buildNovelHtml(novel, options);
        await window.electronAPI.exportPdf(html, filename);
      } else {
        printNovelBrowser(novel, options);
      }
    },
    [novel],
  );

  // Smart auto-paragraph — re-segment the current chapter using
  // speech / action / time-shift signals from auto-paragraph.ts. The
  // actual pass is synchronous; we wrap it in a brief processing window
  // so the UI feedback (button pulse + editor scan-orb gradient) reads
  // as a real beat rather than an instant flicker. The orb's
  // breathe-in animation alone is 0.65 s, so the minimum visible window
  // needs to cover at least that for the cue to register.
  const handleAutoParagraph = useCallback(() => {
    const target = activeChapter;
    if (!target || autoParagraphing) return;
    setAutoParagraphing(true);
    window.setTimeout(() => {
      const next = autoParagraph(target.content, knownNames);
      if (next !== target.content) {
        updateChapterById(target.id, (c) => ({ ...c, content: next }));
      }
      window.setTimeout(() => setAutoParagraphing(false), 700);
    }, 280);
  }, [activeChapter, knownNames, autoParagraphing, updateChapterById]);

  // Auto-scene-break — companion pass to auto-paragraph. Reads the
  // existing speech-detect output (already produced for the active
  // chapter by useAnalysis) and inserts `* * *` markers at detected
  // scene boundaries. Same UX-window pattern as auto-paragraph so the
  // two buttons feel like a family.
  const handleAutoSceneBreak = useCallback(() => {
    const target = activeChapter;
    if (!target || sceneBreaking) return;
    if (!analysisResult || analysisResult.paragraphs.length < 3) return;
    setSceneBreaking(true);
    window.setTimeout(() => {
      const r = autoSceneBreaks(
        target.content,
        analysisResult.paragraphs,
        analysisResult.speechResults,
      );
      if (r.inserted > 0 && r.content !== target.content) {
        updateChapterById(target.id, (c) => ({ ...c, content: r.content }));
      }
      window.setTimeout(() => setSceneBreaking(false), 700);
    }, 280);
  }, [activeChapter, sceneBreaking, analysisResult, updateChapterById]);

  // Onboarding dismissal — flip the persistent flag once so we never
  // auto-show it again. Re-opening via the Help menu doesn't update the
  // flag (it's already true after first close).
  const handleOnboardingClose = useCallback(() => {
    setOnboardingOpen(false);
    setPrefs((p) => ({ ...p, hasSeenOnboarding: true }));
  }, []);

  const handleImport = useCallback(() => fileInputRef.current?.click(), []);

  const handleFileSelected = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();
    const parsed = parseNovel(text);
    const nextChapterId = parsed.chapters[0]?.id ?? null;
    const clearedAnnotations = clearAnnotations();
    const clearedAdaptiveStore = emptyAdaptiveStore();
    setNovel(parsed);
    setCurrentId(nextChapterId);
    setAnnotationStore(clearedAnnotations);
    setAdaptiveStore(clearedAdaptiveStore);
    setAnnotationTarget(null);
    // Reset daily baseline since the document just got swapped wholesale.
    baselineRef.current = totalWordsInNovel(parsed);
    saveNovel(parsed);
    saveCurrentChapterId(nextChapterId, parsed.chapters[0] ?? null);
    saveAnnotationStore(clearedAnnotations);
    saveAdaptiveStore(clearedAdaptiveStore);
  }, []);

  // Jump to a search hit: open the chapter, then scroll to the offset and
  // select the hit. Uses the chapter's *fresh* content (looked up from
  // `novel`) rather than the stale closure-captured `current`, since at
  // call time the React state may not have flushed the chapter swap yet.
  // Two rAFs let the new Editor (`key={current.id}`) mount + size before
  // we measure the textarea geometry.
  const handleProjectJump = useCallback((chapterId: string, offset: number, length: number) => {
    setCurrentId(chapterId);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const ta = document.querySelector<HTMLTextAreaElement>(".document-editor");
        if (!ta) return;
        const fresh = novel.chapters.find((c) => c.id === chapterId);
        if (!fresh) return;
        ta.focus();
        ta.setSelectionRange(offset, offset + length);
        const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 24;
        const lineNum = fresh.content.slice(0, offset).split("\n").length - 1;
        const taTop = ta.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({
          top: Math.max(0, taTop + lineNum * lineHeight - window.innerHeight / 2),
          behavior: "smooth",
        });
      });
    });
  }, [novel]);

  // Keyboard shortcuts — BROWSER ONLY. In Electron the application menu
  // owns every accelerator and forwards them via the `menu-command` IPC
  // (handled by the effect below). Running both handlers in Electron would
  // double-fire toggle commands like Cmd+. (focus-mode) and Cmd+Shift+I
  // (cycle intel), netting to no-op or the wrong final state.
  useEffect(() => {
    if (window.electronAPI) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      const mod = e.metaKey || e.ctrlKey;
      if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); handlePrev(); }
      else if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); handleNext(); }
      else if (mod && e.key === "Enter" && !inField) { e.preventDefault(); handleAddChapter(); }
      else if (mod && e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setProjectSearchOpen(true);
      }
      else if (mod && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setFindOpen(true);
      }
      else if (mod && e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        handleRedo();
      }
      else if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        handleUndo();
      }
      else if (mod && (e.key === "s" || e.key === "S")) { e.preventDefault(); flushSave(); }
      else if (mod && e.key === ".") { e.preventDefault(); setFocusMode((v) => !v); }
      else if (mod && e.key === "\\") {
        e.preventDefault();
        setPrefs((p) => ({ ...p, splitView: !p.splitView }));
      }
      else if (e.key === "Escape" && findOpen) { e.preventDefault(); setFindOpen(false); }
      else if (e.key === "Escape" && projectSearchOpen) { e.preventDefault(); setProjectSearchOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlePrev, handleNext, handleAddChapter, flushSave, findOpen, projectSearchOpen, handleUndo, handleRedo]);

  // Native menu wiring (Electron only). Same actions as the keyboard handler.
  useEffect(() => {
    if (!window.electronAPI?.onMenuCommand) return;
    const off = window.electronAPI.onMenuCommand((cmd) => {
      switch (cmd) {
        case "open-project":    handleOpenProject(); break;
        case "new-chapter":     handleAddChapter(); break;
        case "open-index":      setIndexOpen(true); break;
        case "open-world":      setWorldOpen(true); break;
        case "import-txt":      handleImport(); break;
        case "export-txt":      handleExport(); break;
        case "export-pdf":      handleExportPdf(); break;
        case "export-markdown": handleExportMarkdown(); break;
        case "export-docx":     handleExportDocx(); break;
        case "save":            flushSave(); break;
        case "find":            setFindOpen(true); break;
        case "project-search":  setProjectSearchOpen(true); break;
        case "focus-mode":      setFocusMode((v) => !v); break;
        case "cycle-intel":     cycleIntel(); break;
        case "prev-chapter":    handlePrev(); break;
        case "next-chapter":    handleNext(); break;
        case "show-welcome":    setOnboardingOpen(true); break;
        case "undo":            handleUndo(); break;
        case "redo":            handleRedo(); break;
        case "split-view":      setPrefs((p) => ({ ...p, splitView: !p.splitView })); break;
      }
    });
    return off;
  }, [handleAddChapter, handleImport, handleExport, handleExportPdf, handleExportMarkdown, handleExportDocx, flushSave, cycleIntel, handlePrev, handleNext, handleOpenProject, handleUndo, handleRedo]);

  useEffect(() => {
    if (!window.electronAPI?.isElectron) return;

    let orbPauseTimer: number | null = null;

    const clearOrbPauseTimer = () => {
      if (orbPauseTimer == null) return;
      window.clearTimeout(orbPauseTimer);
      orbPauseTimer = null;
    };

    const setWindowGlassFallback = (unfocused: boolean) => {
      document.body.classList.toggle(ELECTRON_WINDOW_UNFOCUSED_CLASS, unfocused);

      if (!unfocused) {
        clearOrbPauseTimer();
        document.body.classList.remove(ELECTRON_WINDOW_UNFOCUSED_ORB_PAUSED_CLASS);
        return;
      }

      clearOrbPauseTimer();
      orbPauseTimer = window.setTimeout(() => {
        orbPauseTimer = null;
        if (document.body.classList.contains(ELECTRON_WINDOW_UNFOCUSED_CLASS)) {
          document.body.classList.add(ELECTRON_WINDOW_UNFOCUSED_ORB_PAUSED_CLASS);
        }
      }, ELECTRON_WINDOW_UNFOCUSED_ORB_PAUSE_MS);
    };

    const syncWindowFocusGlassState = () => {
      setWindowGlassFallback(document.hidden || !document.hasFocus());
    };

    const handleWindowFocus = () => {
      setWindowGlassFallback(false);
    };

    const handleWindowBlur = () => {
      setWindowGlassFallback(true);
    };

    syncWindowFocusGlassState();
    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", syncWindowFocusGlassState);

    return () => {
      clearOrbPauseTimer();
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", syncWindowFocusGlassState);
      document.body.classList.remove(ELECTRON_WINDOW_UNFOCUSED_CLASS);
      document.body.classList.remove(ELECTRON_WINDOW_UNFOCUSED_ORB_PAUSED_CLASS);
    };
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.isElectron) return;

    let idleTimer: number | null = null;
    let lastPointerMoveAt = 0;

    const setScrollEdgeIdle = (idle: boolean) => {
      document.body.classList.toggle(SCROLL_EDGE_IDLE_CLASS, idle);
    };

    const clearIdleTimer = () => {
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const scheduleIdle = () => {
      clearIdleTimer();
      if (document.hidden || !document.hasFocus()) return;
      idleTimer = window.setTimeout(() => {
        if (!document.hidden && document.hasFocus()) {
          setScrollEdgeIdle(true);
        }
      }, SCROLL_EDGE_IDLE_MS);
    };

    const registerActivity = (event?: Event) => {
      if (event?.type === "pointermove") {
        const now = performance.now();
        if (now - lastPointerMoveAt < SCROLL_EDGE_ACTIVITY_THROTTLE_MS) return;
        lastPointerMoveAt = now;
      }
      setScrollEdgeIdle(false);
      scheduleIdle();
    };

    const handleWindowFocus = () => {
      setScrollEdgeIdle(false);
      scheduleIdle();
    };

    const handleWindowBlur = () => {
      clearIdleTimer();
      setScrollEdgeIdle(false);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) handleWindowBlur();
      else handleWindowFocus();
    };

    const passiveOpts = { passive: true } as AddEventListenerOptions;

    scheduleIdle();
    window.addEventListener("pointermove", registerActivity, passiveOpts);
    window.addEventListener("pointerdown", registerActivity, passiveOpts);
    window.addEventListener("wheel", registerActivity, passiveOpts);
    window.addEventListener("scroll", registerActivity, passiveOpts);
    window.addEventListener("touchstart", registerActivity, passiveOpts);
    window.addEventListener("keydown", registerActivity);
    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearIdleTimer();
      window.removeEventListener("pointermove", registerActivity, passiveOpts);
      window.removeEventListener("pointerdown", registerActivity, passiveOpts);
      window.removeEventListener("wheel", registerActivity, passiveOpts);
      window.removeEventListener("scroll", registerActivity, passiveOpts);
      window.removeEventListener("touchstart", registerActivity, passiveOpts);
      window.removeEventListener("keydown", registerActivity);
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.body.classList.remove(SCROLL_EDGE_IDLE_CLASS);
    };
  }, []);

  // Intel-mode tint colour exposed as a single CSS variable on the app
  // root so consumers (editor scan-orb, auto-paragraph status pill,
  // future intelligence-tinted UI) can inherit it without prop drilling.
  // Mirrors the WorldDataView ORB_COLOR map exactly so the auto-scan
  // orb in the world panel and the auto-paragraph orb in the editor
  // share the same per-mode tint identity.
  const orbColor = (() => {
    const m = intelMode === "auto" ? autoResolvedLevel : intelMode;
    switch (m) {
      case "off":     return "#888888";
      case "fast":    return "#DC7B19";
      case "high":    return "#A828B8";
      case "default": default: return "#1071D8";
    }
  })();

  // Apply typography prefs to CSS custom properties on the editor tree.
  const editorStyle = useMemo<CSSProperties>(() => ({
    "--editor-font":        FONT_STACKS[prefs.typography.fontFamily],
    "--editor-font-size":   `${prefs.typography.fontSize}px`,
    "--editor-line-height": String(prefs.typography.lineHeight),
    "--editor-measure":     `${prefs.typography.measure}ch`,
    "--orb-color":          orbColor,
  } as CSSProperties), [prefs.typography, orbColor]);

  const appClass = `app${focusMode ? " app--focus" : ""}`;
  const editorLayoutKey = `${prefs.typography.fontFamily}:${prefs.typography.fontSize}:${prefs.typography.measure}`;

  return (
    <div className={appClass} style={editorStyle}>
      <div className="app-drag-region" aria-hidden="true" />
      {/* Window-sized scan orb — fades in across the entire viewport
          whenever a smart-process pass is running (auto-paragraph or
          auto-scene-break). Lives at the app root so its
          `position: fixed` is positioned against the viewport (parents
          like .document have transform/contain set, which would
          otherwise reanchor fixed positioning). */}
      <div
        className={`editor-scan-orb${
          autoParagraphing || sceneBreaking ? " editor-scan-orb--visible" : ""
        }`}
        aria-hidden="true"
      />
      <ScrollEdgeTop />
      <Toolbar
        chapterTitle={current?.title ?? ""}
        onChapterTitleChange={(title) => updateCurrent((c) => ({ ...c, title }))}
        currentIndex={currentIndex}
        totalChapters={chapters.length}
        onPrev={handlePrev}
        onNext={handleNext}
        onOpenIndex={() => setIndexOpen(true)}
        onOpenWorld={() => setWorldOpen(true)}
        onAddChapter={handleAddChapter}
        onImport={handleImport}
        onExport={handleExport}
        onExportPdf={handleExportPdf}
        onOpenProject={handleOpenProject}
        hasChapter={!!current}
        intelMode={intelMode}
        intelResolvedLevel={intelMode === "auto" ? autoResolvedLevel : undefined}
        onCycleIntel={cycleIntel}
        isAnalyzing={analysisRunning}
        funMode={prefs.funMode}
        groupTools={!!prefs.groupTools}
        annotationMode={annotationMode}
        onToggleAnnotation={() => setAnnotationMode((v) => !v)}
        canUndo={undoRedo.canUndo}
        canRedo={undoRedo.canRedo}
        onUndo={handleUndo}
        onRedo={handleRedo}
        splitView={splitView}
        secondaryTitle={secondaryChapter?.title}
        onSecondaryTitleChange={secondaryId ? (title) => updateChapterById(secondaryId, (c) => ({ ...c, title })) : undefined}
        secondaryIndex={secondaryIndex}
        onSecondaryPrev={handleSecondaryPrev}
        onSecondaryNext={handleSecondaryNext}
        activeSide={activeSide}
        onActiveSideChange={setActiveSide}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,text/plain"
        style={{ display: "none" }}
        onChange={handleFileSelected}
      />

      <StatusPill task={statusTask} />

      {splitView && current && secondaryChapter ? (
        <div className={`split-editor-container${analysisPanelOpen && !focusMode && prefs.sidePanelCompensation ? " split-editor-container--panel-open" : ""}`}>
          <div
            className={`split-pane split-pane--left${activeSide === "left" ? " split-pane--active" : ""}`}
            style={{ flex: `0 0 ${splitRatio * 100}%` }}
            onPointerDown={() => setActiveSide("left")}
          >
            <Editor
              key={current.id}
              chapter={current}
              onContentChange={(content) => updateChapterById(current.id, (c) => ({ ...c, content }))}
              analysisResult={activeSide === "left" && intelMode !== "off" ? analysisResult : null}
              speechPredictions={activeSide === "left" && intelMode !== "off" ? analysisResult?.speechPredictions : undefined}
              actionPredictions={activeSide === "left" && intelMode !== "off" ? analysisResult?.actionPredictions : undefined}
              toolHighlights={activeSide === "left" && toolHighlights.length > 0 ? toolHighlights : undefined}
              knownNames={intelMode !== "off" ? knownNames : []}
              entityNameMap={intelMode !== "off" ? entityNameMap : undefined}
              onEntityClick={handleEntityClick}
              annotationMode={annotationMode}
              onSpeechAnnotate={handleSpeechAnnotate}
              onActionAnnotate={handleActionAnnotate}
              annotationOverrides={activeSide === "left" ? annotationOverrides : undefined}
              typingSettleMs={analysisDebounceMs}
              sidePanelOpen={analysisPanelOpen && !focusMode}
              sidePanelCompensation={false}
              layoutWidthKey={editorLayoutKey}
              splitMode
            />
          </div>
          <SplitDivider ratio={splitRatio} onRatioChange={setSplitRatio} />
          <div
            className={`split-pane split-pane--right${activeSide === "right" ? " split-pane--active" : ""}`}
            style={{ flex: `0 0 ${(1 - splitRatio) * 100}%` }}
            onPointerDown={() => setActiveSide("right")}
          >
            <Editor
              key={secondaryChapter.id}
              chapter={secondaryChapter}
              onContentChange={(content) => updateChapterById(secondaryChapter.id, (c) => ({ ...c, content }))}
              analysisResult={activeSide === "right" && intelMode !== "off" ? analysisResult : null}
              speechPredictions={activeSide === "right" && intelMode !== "off" ? analysisResult?.speechPredictions : undefined}
              actionPredictions={activeSide === "right" && intelMode !== "off" ? analysisResult?.actionPredictions : undefined}
              toolHighlights={activeSide === "right" && toolHighlights.length > 0 ? toolHighlights : undefined}
              knownNames={intelMode !== "off" ? knownNames : []}
              entityNameMap={intelMode !== "off" ? entityNameMap : undefined}
              onEntityClick={handleEntityClick}
              annotationMode={annotationMode}
              onSpeechAnnotate={handleSpeechAnnotate}
              onActionAnnotate={handleActionAnnotate}
              annotationOverrides={activeSide === "right" ? annotationOverrides : undefined}
              typingSettleMs={analysisDebounceMs}
              sidePanelOpen={analysisPanelOpen && !focusMode}
              sidePanelCompensation={false}
              layoutWidthKey={editorLayoutKey}
              splitMode
            />
          </div>
        </div>
      ) : current ? (
        <Editor
          key={current.id}
          chapter={current}
          onContentChange={(content) => updateCurrent((c) => ({ ...c, content }))}
          analysisResult={intelMode !== "off" ? analysisResult : null}
          speechPredictions={intelMode !== "off" ? analysisResult?.speechPredictions : undefined}
          actionPredictions={intelMode !== "off" ? analysisResult?.actionPredictions : undefined}
          toolHighlights={toolHighlights.length > 0 ? toolHighlights : undefined}
          knownNames={intelMode !== "off" ? knownNames : []}
          entityNameMap={intelMode !== "off" ? entityNameMap : undefined}
          onEntityClick={handleEntityClick}
          annotationMode={annotationMode}
          onSpeechAnnotate={handleSpeechAnnotate}
          onActionAnnotate={handleActionAnnotate}
          annotationOverrides={annotationOverrides}
          typingSettleMs={analysisDebounceMs}
          sidePanelOpen={analysisPanelOpen && !focusMode}
          sidePanelCompensation={!!prefs.sidePanelCompensation}
          layoutWidthKey={editorLayoutKey}
        />
      ) : (
        <div className="empty-state">
          <div className="empty-state-title">No chapter open</div>
          <div className="empty-state-hint">
            Tap the <strong>+</strong> in the toolbar to create your first chapter,
            or use the upload icon to import an existing .txt file.
          </div>
        </div>
      )}

      {indexOpen && (
        <IndexView
          meta={novel.meta}
          onMetaChange={(meta) => setNovel((n) => ({ ...n, meta }))}
          chapters={chapters}
          currentId={currentId}
          onSelect={(id) => { setCurrentId(id); setIndexOpen(false); }}
          onDelete={handleDeleteChapter}
          onReorder={handleReorderChapter}
          onClose={() => setIndexOpen(false)}
        />
      )}

      {worldOpen && (
        <WorldDataView
          novel={novel}
          currentChapterId={currentId ?? null}
          worldData={novel.worldData}
          intelMode={intelMode}
          adaptiveContext={adaptiveContext}
          onChange={handleWorldChange}
          onEntityPredictionFeedback={handleEntityPredictionFeedback}
          onRename={handleRename}
          onClose={() => setWorldOpen(false)}
        />
      )}

      {entityPopover && (
        <EntityPopover
          initialName={entityPopover.name}
          anchor={entityPopover.anchor}
          worldData={novel.worldData}
          onUpdate={handleWorldChange}
          onRename={handleRename}
          onClose={() => setEntityPopover(null)}
        />
      )}
      {annotationMode && (
        <div className="annotation-panel-shell">
          <div className="annotation-panel liquid-glass">
            <span className="annotation-panel-count">
              {chapterCorrectionCount} correction{chapterCorrectionCount !== 1 ? "s" : ""}
            </span>

            {reviewCount > 0 && (
              <>
                <span className="annotation-panel-divider" />
                <span className="annotation-panel-review-count">
                  {reviewCount} need{reviewCount !== 1 ? "s" : ""} review
                </span>
              </>
            )}

            {annotationBreakdown.length > 0 && (
              <>
                <span className="annotation-panel-divider" />
                <span className="annotation-panel-chars">
                  {annotationBreakdown.slice(0, 3).map((c, i) => (
                    <span key={c.name} className="annotation-panel-char-chip">
                      {i > 0 && <span className="annotation-panel-char-sep">·</span>}
                      <span className="annotation-panel-char-name">{c.name}</span>
                      <span className="annotation-panel-char-counts">
                        {c.speechCount > 0 && <span>{c.speechCount}s</span>}
                        {c.actionCount > 0 && <span>{c.actionCount}a</span>}
                      </span>
                    </span>
                  ))}
                </span>
              </>
            )}

            {/* Right-side actions */}
            <span className="annotation-panel-divider" />

            <button
              className="annotation-panel-action-btn"
              onClick={handleExportAnnotations}
              title="Export annotations as JSON"
            >
              Export
            </button>
            <button
              className="annotation-panel-action-btn"
              onClick={handleClearAnnotations}
              title="Clear all annotation corrections"
            >
              Clear
            </button>
            <button
              className="annotation-panel-exit-btn"
              onClick={() => setAnnotationMode(false)}
              title="Exit annotation mode"
              aria-label="Exit annotation mode"
            >
              Exit
            </button>
          </div>
        </div>
      )}
      {annotationTarget && (
        <AnnotationPopover
          target={annotationTarget.target}
          anchor={annotationTarget.anchor}
          worldData={novel.worldData}
          correctedSpeaker={annotationTarget.correctedSpeaker}
          onConfirm={handleAnnotationConfirm}
          onClose={() => setAnnotationTarget(null)}
        />
      )}

      <AnalysisPanel
        result={analysisResult}
        prevResult={prevAnalysisResult}
        nextResult={nextAnalysisResult}
        isAnalyzing={analysisRunning}
        intelMode={intelMode}
        onSetIntelMode={setIntelMode}
        tier={tier}
        onTierChange={handleTierChange}
        prefs={prefs}
        onSetPrefs={setPrefs}
        chapterId={activeChapterId}
        chapterTitle={activeChapter?.title}
        chapterContent={activeChapter?.content}
        needsProjectSaveWarning={needsProjectSaveWarning}
        allChapters={chapters}
        chapterIndex={activeChapterIndex}
        worldData={novel.worldData}
        storyGraph={storyGraph}
        onSelectChapter={(id) => {
          if (splitView && activeSide === "right") {
            setSecondaryId(id);
          } else {
            setCurrentId(id);
          }
        }}
        reviewResult={activeChapterId ? (reviewResults[activeChapterId] ?? null) : null}
        onReviewComplete={handleReviewComplete}
        onProjectLoaded={handleProjectLoaded}
        onNovelRefresh={handleNovelRefresh}
        onAutoParagraph={activeChapter ? handleAutoParagraph : undefined}
        autoParagraphing={autoParagraphing}
        onAutoSceneBreak={
          activeChapter && analysisResult && analysisResult.paragraphs.length >= 3
            ? handleAutoSceneBreak
            : undefined
        }
        sceneBreaking={sceneBreaking}
        onImportTools={handleImportTools}
        onToolHighlights={handleToolHighlights}
        onOpenChange={setAnalysisPanelOpen}
      />

      {current && prefs.debugPanel && analysisResult && (
        <DebugPanel
          reviewCount={reviewCount}
          speechReviewCount={speechReviewCount}
          actionReviewCount={actionReviewCount}
          speechPredictions={analysisResult.speechPredictions.length}
          actionPredictions={analysisResult.actionPredictions.flat().length}
          metrics={adaptiveMetrics}
          learnedBias={learnedBias}
          globalCorrectionCount={globalCorrectionCount}
          typingSettleMs={analysisDebounceMs}
          modelSamples={{
            speech: adaptiveContext.store.models.speech.sampleCount,
            action: adaptiveContext.store.models.action.sampleCount,
          }}
        />
      )}

      {(splitView ? activeChapter : current) && (
        <WordCount
          content={(splitView ? activeChapter! : current!).content}
          todayWords={todayWords}
          goal={prefs.goals.dailyWords}
        />
      )}

      {findOpen && (splitView ? activeChapter : current) && (
        <FindReplace
          content={(splitView ? activeChapter! : current!).content}
          onContentChange={(content) => {
            if (splitView && activeChapterId) {
              updateChapterById(activeChapterId, (c) => ({ ...c, content }));
            } else {
              updateCurrent((c) => ({ ...c, content }));
            }
          }}
          onClose={() => setFindOpen(false)}
        />
      )}

      {projectSearchOpen && (
        <ProjectSearch
          chapters={chapters}
          onJump={handleProjectJump}
          onClose={() => setProjectSearchOpen(false)}
        />
      )}

      {focusMode && (
        <button
          className="focus-exit liquid-glass"
          onClick={() => setFocusMode(false)}
          title="Exit focus mode (⌘.)"
          aria-label="Exit focus mode"
        >
          Exit focus
        </button>
      )}

      {onboardingOpen && (
        <Onboarding onClose={handleOnboardingClose} onTierChange={handleTierChange} />
      )}

      {toolImportState && (
        <ToolImportOverlay
          tools={toolImportState.tools}
          sourcePath={toolImportState.sourcePath}
          existingToolNames={existingToolNames}
          onImport={handleImportToolsConfirm}
          onClose={() => setToolImportState(null)}
        />
      )}

      {pdfExportOpen && (
        <PdfExportOverlay
          meta={novel.meta}
          novel={novel}
          onConfirm={doExportPdf}
          onClose={() => setPdfExportOpen(false)}
        />
      )}


      <div className={`saved-indicator ${savedVisible ? "visible" : ""}`}>
        saved
      </div>
    </div>
  );
}
