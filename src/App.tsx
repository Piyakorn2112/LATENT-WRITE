import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { Toolbar } from "./components/Toolbar";
import { Editor } from "./components/Editor";
import { IndexView } from "./components/IndexView";
import { WorldDataView } from "./components/WorldDataView";
import { SplitDivider } from "./components/SplitDivider";
import { EntityPopover } from "./components/EntityPopover";
import { MaxAskPopover } from "./components/MaxAskPopover";
import { WritingToolPopover } from "./components/WritingToolPopover";
import { runWritingTool, planWritingBatches, applyRevision, WRITING_TASK, type WritingOp } from "./lib/writing-tool";
import { buildAskInput, splitEngineParagraphs } from "./lib/max-ask-context";
import { AnnotationPopover } from "./components/AnnotationPopover";
import { DebugPanel } from "./components/DebugPanel";

import { StatusPill, type StatusTask } from "./components/StatusPill";
import { LoadingLens } from "./components/LoadingLens";
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
import { getCurrentProject, reopenLastProject, openProject, scanExternalProject, importTools, setProjectOpenState, stateTarget } from "./lib/project-manager";
import type { ToolScanEntry } from "./lib/project-manager";
import { ToolImportOverlay } from "./components/ToolImportOverlay";
import type { ToolHighlight } from "./lib/tool-runner";
import type { StoryGraph, ReviewResult, ChapterGraphEntry, TimelineChipPick } from "./types";
import { useAnalysis } from "./lib/use-analysis";
import { emptyWorldData, isWorldDataEmpty, renameInBook, renameInText } from "./lib/world-data";
import { CastConfirmOverlay } from "./components/CastConfirmOverlay";
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
import { characterBreakdown } from "./lib/annotation-learn";
import { resolvePins, applyResolvedPins, pinStats, type ResolvedPin } from "./lib/annotation-pins";
import {
  addDecision as addKnowledgeDecision,
  emptyKnowledgeLedger,
  loadKnowledgeLedger,
  loadKnowledgeLedgerFromProject,
  mergeLedgerCandidates,
  saveKnowledgeLedger,
  type ChapterKnowledgeFacts,
  type KnowledgeCandidate,
  type KnowledgeFact,
  type KnowledgeLedgerStore,
} from "./lib/knowledge-store";
import {
  buildChapterKnowledgeFacts,
  buildLedger,
  knowledgeContentHash,
  retireDeadAnchors,
} from "./lib/knowledge-ledger";
import { runPendingAdjudications, ADJUDICATOR_TASK } from "./lib/adjudicator";
import {
  chekhovCandidatesFrom,
  presenceCandidatesFrom,
  runAssistSweep,
  sceneCandidatesFrom,
  sceneStartParagraphs,
} from "./lib/assist-sweep";
import { classifyChapterPresence } from "./lib/character-presence";
import {
  alreadyAsked,
  chapterReviews,
  confirmedPromises,
  presenceOverrides as presenceOverridesFor,
  emptyReviewStore,
  loadReviewStore,
  loadReviewStoreFromProject,
  pruneReviewStore,
  recordReviewAnswer,
  saveReviewStore,
  sceneLabelOverlay,
  type AssistReviewStore,
} from "./lib/review-store";
import { SCENE_TASK, offeredLabels } from "./lib/scene-review";
import { CHEKHOV_TASK } from "./lib/chekhov-review";
import { PRESENCE_TASK } from "./lib/presence-review";
import { findChekhovCandidates } from "./lib/continuity";
import { chipKeyFor, runChipPick, CHIP_TASK } from "./lib/chip-picker";
import { summaryKeyFor, runChapterSummary, SUMMARY_TASK } from "./lib/chapter-summary";
import { assistantMode } from "./lib/preferences";
import {
  assistantAvailable,
  assistantModelId,
  assistantRunJSON,
  cancelWhere as cancelAssistantWhere,
} from "./lib/assistant-client";
import { toParagraphs, type ChapterAnalysisResult } from "./lib/chapter-analysis-runner";
import { runChapterAnalysisInWorker } from "./lib/analysis-worker-client";
import {
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
  Chapter,
  Novel,
  WorldData,
  AnnotationTarget,
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

  // ── Knowledge ledger ────────────────────────────────────────────────────
  // "Who knows what, and since when", accumulated chapter by chapter from the
  // analysis that already runs. Free to keep even when the assistant is off —
  // the ledger is set algebra, and if the model ever arrives it wants a full
  // book of facts waiting for it (plan §2). Ref + state like storyGraph: the
  // ref is what the rebuild effect reads, so it never works off a stale store.
  const [knowledgeStore, setKnowledgeStore] = useState<KnowledgeLedgerStore>(() => loadKnowledgeLedger());
  const knowledgeStoreRef = useRef(knowledgeStore);
  const knowledgeSaveTimerRef = useRef<number | null>(null);
  const commitKnowledgeStore = useCallback((next: KnowledgeLedgerStore, save: "now" | "debounced" | "never" = "never") => {
    knowledgeStoreRef.current = next;
    setKnowledgeStore(next);
    if (save === "now") { saveKnowledgeLedger(next); return; }
    if (save !== "debounced") return;
    if (knowledgeSaveTimerRef.current !== null) window.clearTimeout(knowledgeSaveTimerRef.current);
    knowledgeSaveTimerRef.current = window.setTimeout(() => {
      knowledgeSaveTimerRef.current = null;
      saveKnowledgeLedger(knowledgeStoreRef.current);
    }, 500);
  }, []);

  // Wave-2 review answers (attribution tie-breaks, scene near-misses, Chekhov
  // promises). Same ref+state shape as the ledger: the sweep reads the ref so a
  // long run never commits against a store that moved under it.
  const [assistReviews, setAssistReviews] = useState(() => loadReviewStore());
  const assistReviewsRef = useRef(assistReviews);
  const assistReviewsSaveTimerRef = useRef<number | null>(null);
  const commitAssistReviews = useCallback((
    next: AssistReviewStore,
    save: "now" | "debounced" = "debounced",
  ) => {
    assistReviewsRef.current = next;
    setAssistReviews(next);
    if (save === "now") { saveReviewStore(next); return; }
    // The sweep commits once per answer so the UI fills in as work lands, but
    // that is eight disk writes a chapter if each one is flushed.
    if (assistReviewsSaveTimerRef.current !== null) window.clearTimeout(assistReviewsSaveTimerRef.current);
    assistReviewsSaveTimerRef.current = window.setTimeout(() => {
      assistReviewsSaveTimerRef.current = null;
      saveReviewStore(assistReviewsRef.current);
    }, 500);
  }, []);
  useEffect(() => () => {
    if (assistReviewsSaveTimerRef.current !== null) {
      window.clearTimeout(assistReviewsSaveTimerRef.current);
      saveReviewStore(assistReviewsRef.current);
    }
  }, []);

  const hydrateProjectState = useCallback(async () => {
    // Hydration only ever runs with a project open, and it re-saves whatever
    // the project lacked — so the write target must be the folder before the
    // first of those saves fires, on every call path.
    setProjectOpenState(true);
    const [pNovel, pCurrentChapter, pStoryGraph, pReviews, pAnnotations, pAdaptive, pKnowledge, pAssistReviews] = await Promise.all([
      loadNovelFromProject(),
      loadCurrentChapterIdFromProject(),
      loadStoryGraphFromProject(),
      loadReviewResultsFromProject(),
      loadAnnotationStoreFromProject(),
      loadAdaptiveStoreFromProject(),
      loadKnowledgeLedgerFromProject(),
      loadReviewStoreFromProject(),
    ]);

    const nextNovel = pNovel ?? emptyNovel();
    const restoredChapterId = resolvePersistedCurrentChapterId(nextNovel.chapters, pCurrentChapter);
    const nextChapterId = restoredChapterId ?? nextNovel.chapters[0]?.id ?? null;
    const nextStoryGraph = pStoryGraph ?? emptyStoryGraph();
    const nextReviewResults = pReviews ?? {};
    const nextAnnotationStore = pAnnotations ?? { version: 1, corrections: [] };
    const nextAdaptiveStore = pAdaptive ?? emptyAdaptiveStore();
    const nextKnowledgeLedger = pKnowledge ?? emptyKnowledgeLedger();
    // Pruned on the way in: a project whose chapters changed outside the app
    // must not carry answers about chapters that no longer exist.
    const nextAssistReviews = pruneReviewStore(
      pAssistReviews ?? emptyReviewStore(),
      nextNovel.chapters.map((chapter) => chapter.id),
    );

    setNovel(nextNovel);
    setCurrentId(nextChapterId);
    baselineRef.current = totalWordsInNovel(nextNovel);
    setStoryGraph(nextStoryGraph);
    setReviewResults(nextReviewResults);
    setAnnotationStore(nextAnnotationStore);
    setAdaptiveStore(nextAdaptiveStore);
    commitKnowledgeStore(nextKnowledgeLedger);
    assistReviewsRef.current = nextAssistReviews;
    setAssistReviews(nextAssistReviews);
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
    if (!pKnowledge) saveKnowledgeLedger(nextKnowledgeLedger);
    if (!pAssistReviews || nextAssistReviews !== pAssistReviews) saveReviewStore(nextAssistReviews);
  }, [commitKnowledgeStore]);

  // ── Desktop project hydration ──────────────────────────────────────────
  // On mount in Electron: reopen the last project and load all state from
  // the project filesystem. Desktop mode never reads/writes localStorage
  // for project data — clear any stale keys left from earlier versions.
  const [projectLoading, setProjectLoading] = useState(() => !!window.electronAPI);
  const [desktopProjectOpen, setDesktopProjectOpen] = useState(false);
  const syncDesktopProjectOpen = useCallback(async () => {
    if (!window.electronAPI) {
      setProjectOpenState(false);
      setDesktopProjectOpen(false);
      return;
    }
    const project = await getCurrentProject();
    setProjectOpenState(!!project);
    setDesktopProjectOpen(!!project);
  }, []);

  useEffect(() => {
    if (!window.electronAPI) return;
    let cancelled = false;
    (async () => {
      // A failed reopen must still release the loading gate. This used to be
      // an uncaught rejection, which left the app stuck mid-boot whenever the
      // IPC was unavailable, and now also decides where state gets written.
      let project = null;
      try {
        project = await reopenLastProject();
      } catch { /* no project layer available — treat as no project */ }
      if (cancelled || !project) {
        // ★ NO PROJECT MEANS localStorage IS THE REAL STORE, SO DO NOT WIPE IT.
        //   This used to clear every key before we knew whether a project
        //   would open, which threw away the previous session's story graph
        //   and left the timeline blank on every reopen.
        setProjectOpenState(false);
        setDesktopProjectOpen(false);
        setProjectLoading(false);
        return;
      }
      // A project owns the state from here, so stale local keys must not
      // shadow it — clear them only once we know there is a folder.
      clearProjectLocalStorage();
      setProjectOpenState(true);
      setDesktopProjectOpen(true);
      try {
        await hydrateProjectState();
      } finally {
        if (!cancelled) setProjectLoading(false);
      }
      if (cancelled) return;
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
  // Intelligence is a toggle: on ("auto", kept as the stored value for pref
  // compatibility) or off. The old fast/default/high tier choice is gone —
  // analysis now CONVERGES instead: a fast pass on every edit, then a deep
  // pass that replaces it when the writer pauses (see useAnalysis converge).
  // Legacy stored tiers all map to "on".
  const [intelMode, setIntelMode] = useState<"off" | "auto">(
    () => (loadPrefs().intelMode === "off" ? "off" : "auto"),
  );
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
    // When pro is deactivated, reset to auto — manual modes require pro.
    if (t !== "pro") setIntelMode("auto");
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
  /**
   * The right-click ask surface. Present only in MAX mode with the runtime
   * available — the gate lives HERE, once, by not passing the handler at all:
   * the Editor stays mode-ignorant and off/on keep right-click untouched.
   */
  const [maxAsk, setMaxAsk] = useState<{ chapterId: string; paragraphIndex: number; x: number; y: number } | null>(null);
  const maxAskAvailable = assistantMode(prefs) === "max"
    && typeof window !== "undefined" && !!window.electronAPI;
  const handleAskParagraph = maxAskAvailable
    ? (info: { chapterId: string; paragraphIndex: number; x: number; y: number }) => setMaxAsk(info)
    : undefined;

  // ── The writing tool (max mode): right-click WITH a selection ──────────
  // The popover chooses the op; writing-tool.ts does the batching, context
  // and the grammar gate; the splice back is offset arithmetic here. While a
  // run is live only its span is locked (and pulses); edits elsewhere are
  // tracked as splices and shift the span's offsets, so the final replace
  // lands where the text actually is.
  const [writingSel, setWritingSel] = useState<{ chapterId: string; start: number; end: number; x: number; y: number } | null>(null);
  const [writingRun, setWritingRun] = useState<{ chapterId: string; start: number; end: number } | null>(null);
  const writingJobRef = useRef<{ chapterId: string; start: number; spanLen: number; original: string } | null>(null);
  const handleWriteSelection = maxAskAvailable
    ? (info: { chapterId: string; start: number; end: number; x: number; y: number }) => {
        writingJobRef.current = null;
        setWritingSel(info);
      }
    : undefined;

  /** Called with every editor content change so an edit ABOVE the in-flight
   *  span shifts its offsets; an edit that touches the span (the lock should
   *  make that impossible) abandons the run rather than mis-splicing. */
  const noteWritingShift = (chapterId: string, prev: string, next: string) => {
    const job = writingJobRef.current;
    if (!job || job.chapterId !== chapterId || prev === next) return;
    let p = 0;
    const minLen = Math.min(prev.length, next.length);
    while (p < minLen && prev[p] === next[p]) p++;
    let tailPrev = prev.length;
    let tailNext = next.length;
    while (tailPrev > p && tailNext > p && prev[tailPrev - 1] === next[tailNext - 1]) { tailPrev--; tailNext--; }
    const delta = next.length - prev.length;
    if (tailPrev <= job.start) {
      job.start += delta;
      setWritingRun((r) => (r && r.chapterId === chapterId ? { ...r, start: r.start + delta, end: r.end + delta } : r));
    } else if (p < job.start + job.spanLen) {
      writingJobRef.current = null;
      cancelAssistantWhere(({ task }) => task === WRITING_TASK);
      setWritingRun(null);
      setWritingSel(null);
    }
  };

  const runWritingJob = async (
    op: WritingOp,
    instruction: string | undefined,
    onProgress: (done: number, total: number) => void,
    onThinking?: (thinking: boolean) => void,
  ) => {
    const sel = writingSel;
    if (!sel) return null;
    const chapter = novel.chapters.find((c) => c.id === sel.chapterId);
    if (!chapter) return null;
    let job = writingJobRef.current;
    if (!job || job.chapterId !== sel.chapterId) {
      // "Write again" re-runs from the ORIGINAL selection, replacing whatever
      // the previous pass put there — the job survives across popover runs.
      job = {
        chapterId: sel.chapterId,
        start: sel.start,
        spanLen: sel.end - sel.start,
        original: chapter.content.slice(sel.start, sel.end),
      };
      writingJobRef.current = job;
    }
    setWritingRun({ chapterId: job.chapterId, start: job.start, end: job.start + job.spanLen });
    const run: typeof assistantRunJSON = (req) => assistantRunJSON({ ...req, tier: "max" });
    const before = chapter.content.slice(Math.max(0, job.start - 4000), job.start);
    // Cast present in the selection OR named by the instruction ("add more
    // detail about Mira" must carry Mira's sheet even when the selected
    // paragraph never names her), world-data info only when NON-BLANK — an
    // empty role/description is never sent.
    const characters = (novel.worldData?.characters ?? [])
      .filter((c) => c.name && (job!.original.includes(c.name) || (instruction?.includes(c.name) ?? false)))
      .map((c) => ({
        name: c.name,
        info: [c.role?.trim(), c.description?.trim()].filter(Boolean).join(" — "),
      }))
      .filter((c) => c.info !== "")
      .slice(0, 5);
    onProgress(0, planWritingBatches(job.original).length);
    try {
      const outcome = await runWritingTool(job.original, {
        run, op, instruction, before, characters,
        onProgress: (p) => onProgress(p.batchIndex + 1, p.batchCount),
        onThinking,
      });
      const j = writingJobRef.current;
      if (j && !outcome.cancelled && outcome.batchOutcomes.some((o) => o === "revised")) {
        updateChapterById(j.chapterId, (c) => ({
          ...c,
          content: applyRevision(c.content, j.start, j.start + j.spanLen, outcome.revised),
        }));
        j.spanLen = outcome.revised.length;
      }
      return outcome;
    } finally {
      setWritingRun(null);
    }
  };

  // Switching chapters mid-run assumes the task is abandoned: cancel the
  // batch chain, drop the job, hide the popover. Offsets into a chapter the
  // writer is no longer looking at are not worth keeping alive.
  useEffect(() => {
    const sel = writingSel;
    if (!sel || sel.chapterId === currentId) return;
    cancelAssistantWhere(({ task }) => task === WRITING_TASK);
    writingJobRef.current = null;
    setWritingSel(null);
    setWritingRun(null);
  }, [currentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cold-start cast confirmation — shown at most once per manuscript, and
  // only at safe moments (app load, .txt import), never mid-typing.
  const [castConfirmOpen, setCastConfirmOpen] = useState(false);
  const castPromptOfferedRef = useRef(false);

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
  const [annotationTarget, setAnnotationTarget] = useState<{ target: AnnotationTarget; anchor: DOMRect; correctedSpeaker?: string | null } | null>(null);

  // Persist annotation store whenever it changes.
  useEffect(() => {
    saveAnnotationStore(annotationStore);
  }, [annotationStore]);

  // ★ THE LEARNED BIAS IS GONE FROM THE RUNNING APP. It was recomputed here
  //   on every correction and fed to the detectors; measurement showed 0.0pp
  //   held-out benefit against up to 3.2% of attributions flipped book-wide
  //   (scripts/probe-annotation-feedback.ts). computeLearnedBias and the
  //   adaptive ranker still exist as the record of that experiment, and the
  //   probe still exercises them, but nothing on this path calls them.

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
  /** The active chapter's corrections — the source for pins and overrides. */
  const chapterCorrections = useMemo(
    () => (activeChapterId
      ? annotationStore.corrections.filter((c) => c.chapterId === activeChapterId)
      : []),
    [annotationStore.corrections, activeChapterId],
  );

  const annotationOverrides = useMemo<Map<string, string | null> | undefined>(() => {
    if (!activeChapterId) return undefined;
    const relevant = chapterCorrections;
    if (!relevant.length) return undefined;
    const map = new Map<string, string | null>();
    for (const c of relevant) {
      map.set(`${c.paragraphIndex}-${c.spanIndex}-${c.spanType}`, c.correctedSpeaker);
    }
    return map;
  }, [chapterCorrections, activeChapterId]);

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
  // Model download is the ONLY assistant progress the writer ever sees, and it
  // reuses the existing pill. One subscription for the app's lifetime; the pill
  // clears itself the moment the download stops. `kind` is deliberately stable
  // so ticking the percentage updates the label in place instead of re-keying
  // (and replaying) the pill's entrance animation.
  const [assistantTask, setAssistantTask] = useState<StatusTask | null>(null);
  useEffect(() => {
    const off = window.electronAPI?.onAssistantProgress?.((progress) => {
      if (progress.phase !== "download" || progress.state !== "downloading") {
        setAssistantTask(null);
        return;
      }
      const pct = Math.round((progress.fraction ?? 0) * 100);
      setAssistantTask({ kind: "assistant-download", label: `downloading assistant model · ${pct}%` });
    });
    return off;
  }, []);
  const cycleIntel = useCallback(() => {
    // One decision the writer can actually make: intelligence on or off.
    setIntelMode((m) => (m === "off" ? "auto" : "off"));
  }, []);
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

  const {
    result: rawAnalysisResult,
    isAnalyzing: analysisRunning,
    isRefining: analysisRefining,
    resultLevel: analysisResultLevel,
    knownNames,
    entityNameMap,
    prevResult: prevAnalysisResult,
    nextResult: nextAnalysisResult,
  } = useAnalysis(novel, activeChapterId, {
    debounceMs: analysisDebounceMs,
    converge: intelMode !== "off",
    // ★★ CORRECTIONS NO LONGER STEER DETECTION, THEY PIN IT.
    //    The learned prior and the adaptive re-ranker were both fed only by
    //    disagreements, i.e. by evidence about WHERE THE ENGINE FAILS, and
    //    applied as if they were evidence about who speaks. Measured
    //    (scripts/probe-annotation-feedback.ts): 0.0pp held-out accuracy
    //    across five books, against up to 3.2% of all attributions flipped
    //    book-wide, worst right at the activation threshold. Detection now
    //    runs at the SAME baseline the accuracy suites have always tested —
    //    those suites never passed a bias — and the user's answer is applied
    //    exactly, on its own span, by applyPinsToAnalysis below.
    collectPredictionDetails,
  });

  // ★ ONE PINNED RESULT, SHARED BY EVERY CONSUMER. The override used to live
  //   in HighlightLayer alone, so a correction repainted the editor while the
  //   story graph, the timeline, the chips and every LLM prompt kept the
  //   engine's original guess. Pinning here means the corrected speaker is
  //   what the whole app, and the model, actually sees.
  const pinned = useMemo(() => {
    if (!rawAnalysisResult || chapterCorrections.length === 0) {
      return { result: rawAnalysisResult, pins: [] as ResolvedPin[] };
    }
    const pins = resolvePins(chapterCorrections, rawAnalysisResult);
    return { result: applyResolvedPins(rawAnalysisResult, pins), pins };
  }, [rawAnalysisResult, chapterCorrections]);
  const analysisResult = pinned.result;
  const chapterPinStats = useMemo(() => pinStats(pinned.pins), [pinned.pins]);

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

  // Apply one chapter's analysis to the ledger: extract facts from the
  // analysed SNAPSHOT (paragraphs, segments and verbatim anchors must match
  // the text they came from), rebuild candidates over every chapter on file,
  // then re-check anchors against LIVE text (retireDeadAnchors) — that is the
  // invalidation contract. Shared by the active-chapter effect below and the
  // background backfill.
  const applyLedgerChapterFacts = useCallback((
    chapter: Chapter,
    chapterNumber: number,
    content: string,
    paragraphs: string[],
    speechResults: ChapterAnalysisResult["speechResults"],
  ) => {
    const store = knowledgeStoreRef.current;
    const hash = knowledgeContentHash(content);
    if (store.chapters[chapter.id]?.contentHash === hash) return;

    const facts = buildChapterKnowledgeFacts({
      chapterId: chapter.id,
      chapterNumber,
      content,
      paragraphs,
      speechResults,
      // Characters only: places and factions were a measured noise class.
      characterNames: entityNameMap.characters,
      // Whole-book corpus for the common-word-name test — chapter-scoped
      // counts read sentence-initial words as names.
      nameFilterText: novel.chapters.map((c) => c.content).join("\n\n"),
    });

    const chapters = { ...store.chapters, [chapter.id]: facts };
    const ordered = novel.chapters
      .map((c) => chapters[c.id])
      .filter((entry): entry is ChapterKnowledgeFacts => !!entry);

    // The writer's own canon and adjudicated offscreen knowledge are inputs
    // to the rebuild, never outputs of it.
    const durable = store.facts.filter(
      (fact) => fact.how === "author-asserted" || fact.how === "reference-implied",
    );
    const built = buildLedger(ordered, { decisions: store.decisions, extraFacts: durable });

    // buildLedger only emits the EARLIEST channel per pair, so a durable fact
    // can be absent from its output while still being the writer's ruling.
    // Carry it forward explicitly — a decision may not be lost to a rebuild.
    const factId = (f: KnowledgeFact) => `${f.subject}${f.entity}${f.how}${f.chapterId}`;
    const emitted = new Set(built.facts.map(factId));
    const nextFacts = [...built.facts, ...durable.filter((f) => !emitted.has(factId(f)))];

    const merged: KnowledgeLedgerStore = {
      ...store,
      chapters,
      facts: nextFacts,
      candidates: mergeLedgerCandidates(store.candidates, built.candidates),
    };
    const live = new Map(novel.chapters.map((c) => [c.id, c.content] as const));
    commitKnowledgeStore(retireDeadAnchors(merged, live), "debounced");
  }, [novel.chapters, entityNameMap.characters, commitKnowledgeStore]);

  // Update the knowledge ledger whenever analysis settles — same shape, same
  // 120ms yield, same content-hash gate as the StoryGraph effect above.
  useEffect(() => {
    if (!analysisResult || !activeChapter || !activeChapter.content.trim()) return;
    if (prefs.storyNlpEnabled === false) return; // user disabled background analysis
    const chapter = activeChapter;
    const content = analysisResult.contentSnapshot || chapter.content;

    const timer = setTimeout(() => {
      applyLedgerChapterFacts(
        chapter,
        chapter.number ?? activeChapterIndex + 1,
        content,
        analysisResult.paragraphs,
        analysisResult.speechResults,
      );
    }, 120);

    return () => clearTimeout(timer);
  }, [analysisResult]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Ledger backfill ─────────────────────────────────────────────────────
  // The effect above only covers chapters the writer VISITS; a freshly opened
  // book would never gain full-book coverage, so cross-chapter candidates
  // could not exist (the knowledge e2e caught exactly this hole). Backfill
  // analyses ONE missing or stale chapter per idle tick, through the same
  // worker the editor uses, then re-fires off its own store commit until
  // nothing is missing. Failures are skipped for the session — one broken
  // chapter must not wedge the loop.
  const ledgerBackfillBusy = useRef(false);
  const ledgerBackfillSkip = useRef(new Set<string>());
  useEffect(() => {
    if (prefs.storyNlpEnabled === false) return;
    if (entityNameMap.characters.length === 0) return; // cold start: no cast yet
    const missingIndex = novel.chapters.findIndex((c) => {
      if (!c.content.trim() || ledgerBackfillSkip.current.has(c.id)) return false;
      const onFile = knowledgeStore.chapters[c.id];
      return !onFile || onFile.contentHash !== knowledgeContentHash(c.content);
    });
    if (missingIndex === -1 || ledgerBackfillBusy.current) return;
    const target = novel.chapters[missingIndex];

    const timer = window.setTimeout(() => {
      void (async () => {
        if (ledgerBackfillBusy.current) return;
        ledgerBackfillBusy.current = true;
        try {
          const result = await runChapterAnalysisInWorker({
            chapter: target,
            prevContext: null,
            siblingStats: [],
            knownNames: entityNameMap.characters,
            worldData: novel.worldData,
            level: "default",
          });
          applyLedgerChapterFacts(
            target,
            target.number ?? missingIndex + 1,
            result.contentSnapshot || target.content,
            result.paragraphs,
            result.speechResults,
          );
        } catch {
          ledgerBackfillSkip.current.add(target.id);
        } finally {
          ledgerBackfillBusy.current = false;
        }
      })();
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [knowledgeStore, novel.chapters, prefs.storyNlpEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    if (knowledgeSaveTimerRef.current !== null) {
      window.clearTimeout(knowledgeSaveTimerRef.current);
      saveKnowledgeLedger(knowledgeStoreRef.current);
    }
  }, []);

  // Writer rulings on a surfaced finding. Both are DURABLE: a dismissal is a
  // decision, and no rebuild or re-scoring pass may resurrect the candidate.
  const handleKnowledgeKnewAlready = useCallback((candidate: KnowledgeCandidate) => {
    const store = knowledgeStoreRef.current;
    const ruled = addKnowledgeDecision(store, {
      key: candidate.key,
      ruling: "knew-already",
      timestamp: Date.now(),
      sentence: candidate.sentence,
    });
    // "They knew already" is the writer asserting story canon: record it as a
    // fact so the pair is evidence in every future evidence pack, not just a
    // silenced flag.
    const asserted: KnowledgeFact = {
      subject: candidate.speaker,
      entity: candidate.entity,
      chapterId: candidate.chapterId,
      chapterNumber: candidate.chapterNumber,
      how: "author-asserted",
      sentence: candidate.sentence,
    };
    commitKnowledgeStore({ ...ruled, facts: [...ruled.facts, asserted] }, "now");
  }, [commitKnowledgeStore]);

  const handleKnowledgeGoodCatch = useCallback((candidate: KnowledgeCandidate) => {
    const store = knowledgeStoreRef.current;
    commitKnowledgeStore(addKnowledgeDecision(store, {
      key: candidate.key,
      ruling: "good-catch",
      timestamp: Date.now(),
      sentence: candidate.sentence,
    }), "now");
  }, [commitKnowledgeStore]);

  // ── The adjudication sweep ──────────────────────────────────────────────
  // Idle-gated: 3s after the ledger settles with pending normal-band
  // candidates, and only while the assistant is enabled AND a run can succeed
  // right now (assistantAvailable is false for no-model/downloading — a
  // sweep never triggers a download). Any ledger change or unmount bumps the
  // sweep id, which cancels between items and aborts the in-flight request.
  // A hidden window defers the START of a sweep (one-shot visibilitychange
  // re-arm); an already-running item is seconds long and allowed to finish.
  const adjudicationSweepRef = useRef(0);
  useEffect(() => {
    if (!prefs.assistant?.enabled || !window.electronAPI) return;
    const hasPending = knowledgeStore.candidates.some(
      (c) => c.status === "pending" && c.band === "normal" && !knowledgeStore.decisions[c.key],
    );
    if (!hasPending) return;

    const sweepId = ++adjudicationSweepRef.current;
    const cancelled = () => adjudicationSweepRef.current !== sweepId;

    const sweep = async () => {
      if (cancelled()) return;
      if (document.hidden) {
        document.addEventListener("visibilitychange", onVisible, { once: true });
        return;
      }
      if (!(await assistantAvailable())) {
        // Not a terminal state: the model may still be downloading or memory
        // may be tight right now. Without a retry, a pending candidate would
        // wait for the next ledger change, which may never come.
        if (!cancelled()) retryTimer = window.setTimeout(() => { void sweep(); }, 30_000);
        return;
      }
      const modelId = await assistantModelId();
      if (!modelId || cancelled()) return;

      const store = knowledgeStoreRef.current;
      const orderedFacts = novel.chapters
        .map((c) => store.chapters[c.id])
        .filter((entry): entry is ChapterKnowledgeFacts => !!entry);
      // The pack reads the SAME split analysis used, against live text; a
      // candidate whose anchor died is already retired and never swept.
      const paragraphsByChapterId = new Map(
        novel.chapters.map((c) => [c.id, toParagraphs(c.content)] as const),
      );
      const majorEvents = Object.values(storyGraphRef.current.entries).flatMap((entry) =>
        entry.majorEvents.map((event) => ({
          chapterNumber: entry.chapterNumber,
          label: event.label,
          sentence: event.sentence,
          rank: event.rank,
          agent: event.agent,
        })),
      );

      const result = await runPendingAdjudications(store, {
        run: assistantRunJSON,
        modelId,
        packInputFor: (candidate) => ({
          candidate,
          chapters: orderedFacts,
          facts: store.facts,
          decisions: store.decisions,
          paragraphsByChapterId,
          worldData: novel.worldData ?? null,
          majorEvents,
          // Rung 6 (embedding retrieval) is not wired yet; the pack degrades
          // honestly without it (gated in test-evidence-pack).
          budgetTokens: 2000,
        }),
      }, { isCancelled: cancelled });

      // Verdicts reached against a snapshot only land on candidates whose
      // sentence is still the one that was judged.
      if (result.candidates.length === 0 && result.impliedFacts.length === 0) return;
      const current = knowledgeStoreRef.current;
      const byKey = new Map(result.candidates.map((c) => [c.key, c] as const));
      const candidates = current.candidates.map((c) => {
        const updated = byKey.get(c.key);
        return updated && updated.sentence === c.sentence ? updated : c;
      });
      const factId = (f: KnowledgeFact) => `${f.subject}|${f.entity}|${f.how}`;
      const known = new Set(current.facts.map(factId));
      const impliedFacts = result.impliedFacts.filter((f) => !known.has(factId(f)));
      commitKnowledgeStore({ ...current, candidates, facts: [...current.facts, ...impliedFacts] }, "now");
    };
    const onVisible = () => { if (!document.hidden && !cancelled()) void sweep(); };

    let retryTimer: number | null = null;
    const timer = window.setTimeout(() => { void sweep(); }, 3000);
    return () => {
      window.clearTimeout(timer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisible);
      adjudicationSweepRef.current++;
      cancelAssistantWhere(({ task }) => task === ADJUDICATOR_TASK);
    };
  }, [knowledgeStore, prefs.assistant?.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Timeline chip refinement ────────────────────────────────────────────
  // The model re-picks and re-labels each chapter's timeline chips in the
  // background, keyed by chipKeyFor so work only happens when the chapter's
  // events actually changed. Self-healing by design: an enrichment pass that
  // re-ranks events changes the fingerprint, which invalidates the chips,
  // which re-runs the pick over the new events. The stamp is guarded by
  // recomputing the key against the CURRENT entry, so a pick raced by a
  // rebuild is dropped, never misapplied.
  //
  // ★★ THE LOOP SELF-ARMS AND IS KICKED, NEVER DEP-DRIVEN. The old effect
  //    depended on `storyGraph`, so it advanced only when a stamp happened to
  //    change state — a chapter whose runs FAILED changed nothing and froze
  //    the whole convergence right there — and every graph change tore the
  //    effect down mid-run, cancelling the in-flight request, which was then
  //    recorded as a permanent skip. The worker now owns its own timer chain
  //    (350ms between units of work, 10s backoff after a transient failure)
  //    and a separate one-line effect kicks it when the graph changes.
  //
  // ★ CHIPS DRAIN BEFORE SUMMARIES, ACROSS CHAPTERS. Chips are what the
  //   timeline shows first — and runs of one task type carry a byte-identical
  //   system prompt, so the host's prefix cache eats the prefill from the
  //   second call on. Alternating chip/summary per chapter paid full prefill
  //   (measured 1.1–3.6s) on every single call.
  const chipBusyRef = useRef(false);
  const chipSkipRef = useRef(new Set<string>()); // `${kind}|${chapterId}|${key}`, per session
  const chipStrikesRef = useRef(new Map<string, number>()); // transient failures per key
  const chipKickRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!prefs.assistant?.enabled || !window.electronAPI) return;
    let alive = true;
    let timer: number | null = null;
    const arm = (ms: number) => {
      if (!alive) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; void tick(); }, ms);
    };

    interface Work { entry: ChapterGraphEntry; kind: "chips" | "sum"; key: string }
    const findWork = (modelId: string): Work | null => {
      const entries = Object.values(storyGraphRef.current.entries)
        .filter((entry) => entry.majorEvents.length > 0)
        .sort((a, b) => a.chapterNumber - b.chapterNumber);
      for (const entry of entries) {
        const key = chipKeyFor(entry, modelId);
        if (entry.lmChipsKey !== key && !chipSkipRef.current.has(`chips|${entry.chapterId}|${key}`))
          return { entry, kind: "chips", key };
      }
      for (const entry of entries) {
        const key = summaryKeyFor(entry, modelId);
        if (entry.lmSummaryKey !== key && !chipSkipRef.current.has(`sum|${entry.chapterId}|${key}`))
          return { entry, kind: "sum", key };
      }
      return null;
    };

    // ★ ONLY A CONTENT-SHAPED FAILURE EARNS A PERMANENT SKIP. `busy`,
    //   `cancelled`, `timeout`, `low-memory`, `no-model` are the runtime having
    //   a moment, not the chapter being unanswerable — a session-long key on
    //   those is exactly how max mode silently stopped updating chips. A
    //   transient failure backs off and retries; three strikes converts it.
    const CONTENT_FAILURES = new Set(["parse", "no-json", "schema"]);
    const noteFailure = (skipId: string, reason: string | null): number => {
      if (reason === null || CONTENT_FAILURES.has(reason)) {
        chipSkipRef.current.add(skipId);
        return 350;
      }
      const strikes = (chipStrikesRef.current.get(skipId) ?? 0) + 1;
      chipStrikesRef.current.set(skipId, strikes);
      if (strikes >= 3) { chipSkipRef.current.add(skipId); return 350; }
      return 10_000;
    };

    /** Up to `max` stale units of ONE kind — chips before summaries, so a
     *  pool shares its system prompt (prefix cache) and the sidecar batches
     *  same-shaped work across its slots. */
    const collectWork = (modelId: string, max: number): Work[] => {
      const out: Work[] = [];
      const entries = Object.values(storyGraphRef.current.entries)
        .filter((entry) => entry.majorEvents.length > 0)
        .sort((a, b) => a.chapterNumber - b.chapterNumber);
      for (const entry of entries) {
        if (out.length >= max) break;
        const key = chipKeyFor(entry, modelId);
        if (entry.lmChipsKey !== key && !chipSkipRef.current.has(`chips|${entry.chapterId}|${key}`))
          out.push({ entry, kind: "chips", key });
      }
      if (out.length > 0) return out;
      for (const entry of entries) {
        if (out.length >= max) break;
        const key = summaryKeyFor(entry, modelId);
        if (entry.lmSummaryKey !== key && !chipSkipRef.current.has(`sum|${entry.chapterId}|${key}`))
          out.push({ entry, kind: "sum", key });
      }
      return out;
    };

    /** One unit, run to stamp. Returns the re-arm delay it wants. */
    const processWork = async (
      work: Work,
      run: typeof assistantRunJSON,
      modelId: string,
      maxMode: boolean,
    ): Promise<number> => {
      const fail: { reason: string | null } = { reason: null };
      const onRunFailure = (reason: string) => { fail.reason = reason; };
      const skipId = `${work.kind}|${work.entry.chapterId}|${work.key}`;
      if (work.kind === "chips") {
        // ★ CHIPS LAND ONE BY ONE. Each pick the model finishes streaming
        //   is stamped provisionally (lmChips only — never the key, so the
        //   chapter still reads stale until the validated final answer).
        //   Guarded by the same key check as the final stamp: a stream from
        //   a superseded request cannot touch rebuilt events. Concurrent
        //   pool units stream to DIFFERENT chapters, each behind its own key.
        const provisional = (picks: TimelineChipPick[]) => {
          if (!alive) return;
          setStoryGraph((prev) => {
            const current = prev.entries[work.entry.chapterId];
            if (!current || chipKeyFor(current, modelId) !== work.key) return prev;
            return {
              ...prev,
              entries: {
                ...prev.entries,
                [work.entry.chapterId]: { ...current, lmChips: picks },
              },
            };
          });
        };
        const outcome = await runChipPick(work.entry, {
          run, modelId, rich: maxMode, onRunFailure, onPartialPicks: provisional,
        });
        if (!alive) return 350;
        if (!outcome) return noteFailure(skipId, fail.reason);
        setStoryGraph((prev) => {
          const current = prev.entries[work.entry.chapterId];
          // Recomputed against the CURRENT entry: a result raced by a
          // rebuild is dropped rather than stamped onto new events.
          if (!current || chipKeyFor(current, modelId) !== outcome.lmChipsKey) return prev;
          return {
            ...prev,
            entries: {
              ...prev.entries,
              [work.entry.chapterId]: { ...current, lmChips: outcome.lmChips, lmChipsKey: outcome.lmChipsKey },
            },
          };
        });
        return 350;
      }
      const summary = await runChapterSummary(work.entry, {
        run, modelId, onRunFailure,
        ...(maxMode ? { jsonStyle: "compact" as const } : {}),
      });
      if (!alive) return 350;
      if (!summary) return noteFailure(skipId, fail.reason);
      setStoryGraph((prev) => {
        const current = prev.entries[work.entry.chapterId];
        if (!current || summaryKeyFor(current, modelId) !== summary.lmSummaryKey) return prev;
        return {
          ...prev,
          entries: {
            ...prev.entries,
            [work.entry.chapterId]: {
              ...current,
              lmSummary: summary.lmSummary,
              lmThroughline: summary.lmThroughline,
              lmSummaryKey: summary.lmSummaryKey,
            },
          },
        };
      });
      return 350;
    };

    const tick = async () => {
      if (!alive || chipBusyRef.current) return;
      if (document.hidden) {
        document.addEventListener("visibilitychange", onVisible, { once: true });
        return;
      }
      // ★ MAX MODE UPGRADES THE WHOLE TICK: chips and summaries run on the 4B,
      //   chips may carry a grounded second line, and the cache keys carry the
      //   max model's id — so switching modes recomputes exactly once per
      //   chapter and never cross-stamps tiers.
      const maxMode = assistantMode(prefs) === "max";
      if (!(await assistantAvailable(maxMode ? "max" : undefined))) {
        arm(30_000);
        return;
      }
      // ★ THE POOL: when the llama-server sidecar exists (max mode), three
      //   chapters run at once through the batch lane and its slots decode
      //   them in one batched GPU pass (measured 1.75x,
      //   scripts/probe-llama-server.ts). Without the binary, pool size 1
      //   and NO lane flag — the in-process path stays byte-identical, and
      //   a pool would only manufacture 'busy' failures against its
      //   single-slot queue.
      const status = maxMode ? await window.electronAPI?.assistantStatus({ tier: "max" }) : null;
      const modelId = maxMode ? status?.model?.id ?? null : await assistantModelId();
      if (!modelId || !alive) return;
      // available AND not errored: after a boot failure the pool must drop
      // to 1, or three batch jobs fall through onto the single-slot host and
      // two of them manufacture 'busy' strikes every tick.
      const sc = (status as { sidecar?: { available?: boolean; error?: string } } | null)?.sidecar;
      const sidecarReady = maxMode && !!sc?.available && !sc?.error;
      const run: typeof assistantRunJSON = maxMode
        ? (req) => assistantRunJSON({ ...req, tier: "max", ...(sidecarReady ? { lane: "batch" as const } : {}) })
        : assistantRunJSON;
      const works = collectWork(modelId, sidecarReady ? 3 : 1);
      if (works.length === 0) return; // converged — the next kick reopens the loop

      chipBusyRef.current = true;
      let delay = 350;
      try {
        const delays = await Promise.all(works.map((w) => processWork(w, run, modelId, maxMode)));
        // Progress anywhere keeps the fast cadence; all-failed backs off.
        delay = delays.some((d) => d === 350) ? 350 : Math.max(...delays);
      } finally {
        chipBusyRef.current = false;
      }
      if (alive && findWork(modelId)) arm(delay);
    };
    const onVisible = () => { if (!document.hidden && alive) void tick(); };
    chipKickRef.current = () => arm(1200);

    arm(4000);
    return () => {
      alive = false;
      chipKickRef.current = () => {};
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      cancelAssistantWhere(({ task }) => task === CHIP_TASK || task === SUMMARY_TASK);
    };
  }, [prefs.assistant?.enabled, prefs.assistant?.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // A stamp, an analysis rebuild, a project switch — any graph change can make
  // chapters stale after the worker went quiet. One debounced kick; the worker
  // decides whether there is actually work.
  useEffect(() => { chipKickRef.current(); }, [storyGraph]);

  // ── The review sweep (wave 2) ───────────────────────────────────────────
  // One pass: scene near-misses, then Chekhov. Five questions per chapter,
  // ranked and capped (plans/assistant-adjudication-wave-2.md §2), ~3s of idle
  // work. The spec's third task, attribution, was built and then measured out —
  // see the ★★ at the top of assist-sweep.ts.
  //
  // Scheduling is the adjudication sweep's, deliberately: idle ≥3s, only when
  // `assistantAvailable` says a run can succeed RIGHT NOW (so a sweep never
  // triggers a download), a hidden window defers the start, 30s retry on a
  // temporary no, and an edit or unmount bumps the sweep id — which cancels
  // between items and aborts what is in flight.
  //
  // ★ IT WAITS FOR THE ANALYSIS TO SETTLE, not just to exist. A fast-tier
  //   result and the high-tier result that replaces it share a content hash
  //   but not their candidate sets, so sweeping the interim result spends part
  //   of the budget answering questions about a ranking that is about to be
  //   thrown away — and the answers do not even dedupe, because a different
  //   offered set is a different cache key.
  const reviewSweepRef = useRef(0);
  useEffect(() => {
    if (!prefs.assistant?.enabled || !window.electronAPI) return;
    if (!analysisResult || !activeChapter || !activeChapter.content.trim()) return;
    if (analysisRunning || analysisRefining) return;

    const chapter = activeChapter;
    const chapterId = chapter.id;
    // The SNAPSHOT the analysis was computed from, never the live text: the
    // candidates below are indices into it.
    const content = analysisResult.contentSnapshot || chapter.content;
    const contentHash = knowledgeContentHash(content);
    const chapters = novel.chapters;
    const chapterIndex = chapters.findIndex((c) => c.id === chapterId);

    const worldCharacters = (novel.worldData?.characters ?? [])
      .filter((c) => !!c.name && c.name.trim().length >= 2);
    const presenceCast = worldCharacters.map((c) => ({
      name: c.name.trim(), variants: c.aliases ?? [],
    }));
    const presenceVariants = new Map<string, readonly string[]>(
      worldCharacters.map((c) => [c.name.trim(), c.aliases ?? []]),
    );

    const sweepId = ++reviewSweepRef.current;
    const cancelled = () => reviewSweepRef.current !== sweepId;

    const sweep = async () => {
      if (cancelled()) return;
      if (document.hidden) {
        document.addEventListener("visibilitychange", onVisible, { once: true });
        return;
      }
      if (!(await assistantAvailable())) {
        if (!cancelled()) retryTimer = window.setTimeout(() => { void sweep(); }, 30_000);
        return;
      }
      const modelId = await assistantModelId();
      if (!modelId || cancelled()) return;

      await runAssistSweep(
        {
          chapterId,
          chapterContentHash: contentHash,
          scenes: sceneCandidatesFrom(analysisResult.paragraphs, analysisResult.speechResults),
          chekhov: chapterIndex >= 0
            ? chekhovCandidatesFrom(
                findChekhovCandidates(chapters, chapterIndex),
                chapter.number ?? chapterIndex + 1,
                // Chapters that have gone by without the phrase returning —
                // findChekhovCandidates only flags phrases absent from every
                // later chapter, so this is the length of the silence.
                Math.max(0, chapters.length - 1 - chapterIndex),
              )
            : [],
          // Only the marks character-presence.ts declared UNCERTAIN reach the
          // model; presenceCandidatesFrom is where that filter lives.
          //
          // ★ CUT FROM `content`, THE ANALYSIS SNAPSHOT, NOT FROM THE LIVE
          //   TEXT. The answer is cached under that snapshot's hash, so a
          //   snippet taken from prose the writer has since edited would be
          //   stored against a hash it was never read under.
          presence: presenceCandidatesFrom(
            classifyChapterPresence(content, presenceCast),
            content,
            chapter.number ?? chapterIndex + 1,
            presenceVariants,
          ),
        },
        {
          run: assistantRunJSON,
          modelId,
          isAsked: (key) => alreadyAsked(
            chapterReviews(assistReviewsRef.current, chapterId, contentHash, modelId), key,
          ),
          onAnswer: (key, answer) => {
            // A verdict reached against a snapshot the writer has since edited
            // is dropped, not stored: recordReviewAnswer would otherwise stamp
            // it onto the new hash and it would surface against prose it never
            // read. Same rule as the adjudication sweep's sentence check.
            if (cancelled()) return;
            commitAssistReviews(recordReviewAnswer(
              assistReviewsRef.current, chapterId, contentHash, modelId, key, answer, Date.now(),
            ));
          },
          isCancelled: cancelled,
        },
      );
    };
    const onVisible = () => { if (!document.hidden && !cancelled()) void sweep(); };

    let retryTimer: number | null = null;
    const timer = window.setTimeout(() => { void sweep(); }, 3000);
    return () => {
      window.clearTimeout(timer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisible);
      reviewSweepRef.current++;
      cancelAssistantWhere(({ task }) =>
        task === SCENE_TASK || task === CHEKHOV_TASK || task === PRESENCE_TASK);
    };
  }, [analysisResult, analysisRunning, analysisRefining, prefs.assistant?.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Reading the review answers back ─────────────────────────────────────
  // The model id is part of every cache key, so the DISPLAY needs it too — a
  // selector that cannot check which model answered would happily show a
  // previous model's verdicts after a swap.
  const [assistModelId, setAssistModelId] = useState<string | null>(null);
  useEffect(() => {
    if (!prefs.assistant?.enabled || !window.electronAPI) { setAssistModelId(null); return; }
    let alive = true;
    void assistantModelId().then((id) => { if (alive) setAssistModelId(id); });
    return () => { alive = false; };
  }, [prefs.assistant?.enabled]);

  /** The active chapter's answers, or an empty entry when they are stale. */
  const activeReviews = useMemo(() => {
    if (!activeChapterId || !assistModelId || !analysisResult) return null;
    const content = analysisResult.contentSnapshot || activeChapter?.content || "";
    // The SAME hash the sweep wrote under: the analysed snapshot, not live text.
    return chapterReviews(assistReviews, activeChapterId, knowledgeContentHash(content), assistModelId);
  }, [assistReviews, activeChapterId, assistModelId, analysisResult, activeChapter?.content]);

  /** Scene labels the model resolved, by the paragraph their scene starts at. */
  const sceneLabelOverrides = useMemo(() => {
    if (!activeReviews || !analysisResult) return undefined;
    const starts = sceneStartParagraphs(analysisResult.speechResults);
    // Re-derived, not stored: the overlay drops any answer whose shortlist has
    // moved since, which is only knowable against the CURRENT engine output.
    const shortlists = new Map(
      sceneCandidatesFrom(analysisResult.paragraphs, analysisResult.speechResults)
        .map((candidate) => [candidate.sceneIndex, offeredLabels(candidate)] as const),
    );
    const overlay = sceneLabelOverlay(activeReviews, starts, (i) => shortlists.get(i) ?? []);
    if (overlay.size === 0) return undefined;
    return new Map([...overlay].map(([paragraphIndex, value]) => [paragraphIndex, value.label]));
  }, [activeReviews, analysisResult]);

  /**
   * Presence classes the model settled, keyed chapterId -> lower-cased name.
   *
   * ★ ONE CHAPTER WIDE, BECAUSE THE SWEEP IS. assist-sweep only ever runs on
   *   the chapter the writer is in, so this map has at most one key. The ledger
   *   draws every chapter and the other rows keep the engine's own call, which
   *   is the honest state: nothing has been asked about them.
   */
  const presenceOverrides = useMemo(() => {
    if (!activeReviews || !activeChapterId) return undefined;
    const byName = presenceOverridesFor(activeReviews);
    if (byName.size === 0) return undefined;
    return new Map([[activeChapterId, byName]]);
  }, [activeReviews, activeChapterId]);

  /** Chekhov phrases the model confirmed are real promises, lowercased. */
  const confirmedChekhov = useMemo(
    () => (activeReviews ? confirmedPromises(activeReviews) : undefined),
    [activeReviews],
  );

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
    commitKnowledgeStore(emptyKnowledgeLedger(), "now");
    setAnnotationTarget(null);
    setEntityPopover(null);
    setSecondaryId(null);
    setActiveSide("left");
  }, [cancelPendingProjectSave, hydrateProjectState, syncDesktopProjectOpen, commitKnowledgeStore]);

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
      // Flip the target BEFORE hydrating: hydrate re-saves any state the
      // project lacked, and those writes belong in the project folder.
      setProjectOpenState(true);
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

  // ── Cold-start cast confirmation ────────────────────────────────────────

  /** The prompt is worth showing only for a real manuscript with no curated
   *  world data that hasn't already been asked about. */
  const castPromptNeeded = useCallback((n: Novel) => {
    if (n.worldData?.castReviewed) return false;
    if (!isWorldDataEmpty(n.worldData)) return false;
    return totalWordsInNovel(n) >= 2000;
  }, []);

  // Offer once per session at mount (deferred while onboarding is up so the
  // first-launch flow stays: welcome → editor → cast question).
  useEffect(() => {
    if (onboardingOpen || castPromptOfferedRef.current) return;
    if (castPromptNeeded(novel)) {
      castPromptOfferedRef.current = true;
      setCastConfirmOpen(true);
    }
    // Intentionally NOT keyed on `novel` — reruns only when onboarding
    // closes, so the prompt can never pop mid-typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboardingOpen]);

  const handleCastConfirm = useCallback((wd: WorldData) => {
    setNovel((n) => ({ ...n, worldData: wd }));
    setCastConfirmOpen(false);
  }, []);

  const handleCastSkip = useCallback(() => {
    // Record the answer so the question is never re-asked for this book;
    // empty buckets keep every other code path on its auto-extract fallback.
    setNovel((n) => ({
      ...n,
      worldData: { ...(n.worldData ?? emptyWorldData()), castReviewed: true },
    }));
    setCastConfirmOpen(false);
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

  // The one-shot format passes (auto-paragraph / scene-break) now surface in
  // the centred loading lens over the editor, not the top status pill — so
  // suppress the top pill while either runs.
  const lensActive = autoParagraphing || sceneBreaking;
  const lensLabel = autoParagraphing
    ? "Re-paragraphing chapter…"
    : sceneBreaking
      ? "Inserting scene breaks…"
      : "";

  // ★ NO PILL FOR ANALYSIS AT ALL — neither the fast pass nor the deep refine.
  // The toolbar orb animates for both (Toolbar `isAnalyzing` takes
  // `analysisRunning || analysisRefining`), so either pill was a second readout
  // of a state already on screen, and on a 1s debounce the first one reappeared
  // after almost every edit.
  //
  // The pill is now for tasks the orb says NOTHING about — the rename task and
  // the one-time assistant model download. Keep it that way: if a new pill only
  // restates the orb, it does not belong here. (Routine adjudication gets NO
  // pill — it is seconds of idle-time work, and a pill for it would be noise.)
  const statusTask: StatusTask | null = lensActive ? null : (renameTask ?? assistantTask);

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
    // A wholesale document swap invalidates every fact, anchor and ruling.
    commitKnowledgeStore(emptyKnowledgeLedger(), "now");
    setAnnotationTarget(null);
    // Reset daily baseline since the document just got swapped wholesale.
    baselineRef.current = totalWordsInNovel(parsed);
    saveNovel(parsed);
    saveCurrentChapterId(nextChapterId, parsed.chapters[0] ?? null);
    saveAnnotationStore(clearedAnnotations);
    saveAdaptiveStore(clearedAdaptiveStore);
    // A freshly imported manuscript is the cast prompt's best moment: the
    // writer just handed us a whole book and no world data exists yet.
    if (castPromptNeeded(parsed)) {
      castPromptOfferedRef.current = true;
      setCastConfirmOpen(true);
    }
  }, [castPromptNeeded, commitKnowledgeStore]);

  // Jump from the panel's chapter observation to the paragraph it names.
  // Resolves the paragraph's offset in the live chapter text and reuses the
  // search-hit jump (scroll + select) below.
  const handleJumpToParagraph = useCallback((paragraphIndex: number) => {
    const target = activeChapter;
    const paraText = analysisResult?.paragraphs[paragraphIndex];
    if (!target || !paraText) return;
    const offset = target.content.indexOf(paraText);
    if (offset < 0) return; // text changed since analysis — no stale jump
    handleProjectJump(target.id, offset, Math.min(paraText.length, 160));
  }, [activeChapter, analysisResult]); // eslint-disable-line react-hooks/exhaustive-deps

  // Jump from the timeline to a detected event's clause, in ANY chapter.
  // The stored event carries its verbatim source sentence, which survives
  // paragraph re-splits; locate it with indexOf against the chapter's current
  // text. Falls back to paragraph position, then to plain chapter open, so an
  // edited chapter degrades to "roughly there" instead of a stale selection.
  const handleJumpToEvent = useCallback((chapterId: string, event: { sentence?: string; paragraphIndex?: number }) => {
    const ch = novel.chapters.find((c) => c.id === chapterId);
    if (!ch) return;
    if (event.sentence) {
      const offset = ch.content.indexOf(event.sentence);
      if (offset >= 0) {
        handleProjectJump(chapterId, offset, Math.min(event.sentence.length, 200));
        return;
      }
    }
    if (event.paragraphIndex !== undefined) {
      // Same split the analysis runner uses, so the index means the same thing.
      const paras = ch.content.split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean);
      const para = paras[event.paragraphIndex];
      const offset = para ? ch.content.indexOf(para) : -1;
      if (offset >= 0) {
        handleProjectJump(chapterId, offset, Math.min(para!.length, 160));
        return;
      }
    }
    setCurrentId(chapterId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [novel.chapters]);

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
  // The orb keeps the app's AUTO identity (blue-led cycle) at all times and
  // only LEANS with the converge phase, riding the pre-built resolved-level
  // cycles and their 1.4s @property colour handoffs:
  //   fast pass running / on screen → warm lean ("fast" cycle)
  //   deep pass refining (+ a short glow tail so the 50-150ms worker run
  //   reads as a visible violet breath) → violet lean ("high" cycle)
  //   converged and quiet → no lean: the original equal cycle, more vivid.
  const [refineGlow, setRefineGlow] = useState(false);
  useEffect(() => {
    if (analysisRefining) { setRefineGlow(true); return; }
    if (!refineGlow) return;
    const t = window.setTimeout(() => setRefineGlow(false), 1200);
    return () => window.clearTimeout(t);
  }, [analysisRefining, refineGlow]);

  const intelPhase: "fast" | "high" | undefined =
    intelMode === "off" ? undefined
    : analysisRefining || refineGlow ? "high"
    : analysisRunning || analysisResultLevel !== "high" ? "fast"
    : undefined; // converged idle — pure auto cycle, vivid

  const orbColor =
    intelMode === "off" ? "#888888"
    : intelPhase === "high" ? "#A828B8"
    : intelPhase === "fast" ? "#DC7B19"
    : "#2747E6"; // the auto cycle's logo-blue anchor

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
      {/* The window-sized mode-tinted scan orb that used to fade in during
          auto-paragraph / scene-break is removed — the centred LoadingLens
          (below) is now the indicator for those passes, and a coloured glow
          would clash with the lens's neutral refraction. */}
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
        intelResolvedLevel={intelPhase}
        intelVivid={intelMode !== "off" && !intelPhase}
        onCycleIntel={cycleIntel}
        isAnalyzing={analysisRunning || analysisRefining}
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

      <LoadingLens active={lensActive} label={lensLabel} />

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
              onContentChange={(content) => {
                noteWritingShift(current.id, current.content, content);
                updateChapterById(current.id, (c) => ({ ...c, content }));
              }}
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
              sceneLabelOverrides={activeSide === "left" ? sceneLabelOverrides : undefined}
              typingSettleMs={analysisDebounceMs}
              sidePanelOpen={analysisPanelOpen && !focusMode}
              sidePanelCompensation={false}
              layoutWidthKey={editorLayoutKey}
              splitMode
              onAskParagraph={handleAskParagraph}
              onWriteSelection={handleWriteSelection}
              lockedRange={writingRun && writingRun.chapterId === current.id ? writingRun : null}
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
              onContentChange={(content) => {
                noteWritingShift(secondaryChapter.id, secondaryChapter.content, content);
                updateChapterById(secondaryChapter.id, (c) => ({ ...c, content }));
              }}
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
              sceneLabelOverrides={activeSide === "right" ? sceneLabelOverrides : undefined}
              typingSettleMs={analysisDebounceMs}
              sidePanelOpen={analysisPanelOpen && !focusMode}
              sidePanelCompensation={false}
              layoutWidthKey={editorLayoutKey}
              splitMode
              onAskParagraph={handleAskParagraph}
              onWriteSelection={handleWriteSelection}
              lockedRange={writingRun && writingRun.chapterId === secondaryChapter.id ? writingRun : null}
            />
          </div>
        </div>
      ) : current ? (
        <Editor
          key={current.id}
          chapter={current}
          onContentChange={(content) => {
            noteWritingShift(current.id, current.content, content);
            updateCurrent((c) => ({ ...c, content }));
          }}
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
          sceneLabelOverrides={sceneLabelOverrides}
          typingSettleMs={analysisDebounceMs}
          sidePanelOpen={analysisPanelOpen && !focusMode}
          sidePanelCompensation={!!prefs.sidePanelCompensation}
          layoutWidthKey={editorLayoutKey}
          onAskParagraph={handleAskParagraph}
          onWriteSelection={handleWriteSelection}
          lockedRange={writingRun && writingRun.chapterId === current.id ? writingRun : null}
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

      {castConfirmOpen && (
        <CastConfirmOverlay
          novel={novel}
          onConfirm={handleCastConfirm}
          onSkip={handleCastSkip}
        />
      )}

      {maxAsk && (() => {
        const askChapter = novel.chapters.find((c) => c.id === maxAsk.chapterId);
        const preview = askChapter
          ? (splitEngineParagraphs(askChapter.content)[maxAsk.paragraphIndex] ?? "").slice(0, 120)
          : "";
        return (
          <MaxAskPopover
            x={maxAsk.x}
            y={maxAsk.y}
            paragraphPreview={preview}
            build={(kind, question) => buildAskInput(
              { novel, chapterId: maxAsk.chapterId, worldData: novel.worldData, storyGraph },
              maxAsk.paragraphIndex, kind, question,
            )}
            onClose={() => setMaxAsk(null)}
          />
        );
      })()}

      {writingSel && (() => {
        const ch = novel.chapters.find((c) => c.id === writingSel.chapterId);
        if (!ch) return null;
        const job = writingJobRef.current;
        const original = job && job.chapterId === writingSel.chapterId
          ? job.original
          : ch.content.slice(writingSel.start, writingSel.end);
        return (
          <WritingToolPopover
            x={writingSel.x}
            y={writingSel.y}
            selectionPreview={`${original.slice(0, 110)}${original.length > 110 ? "…" : ""}`}
            selectionChars={original.length}
            batchEstimate={planWritingBatches(original).length}
            onRun={runWritingJob}
            onCancel={() => cancelAssistantWhere(({ task }) => task === WRITING_TASK)}
            onClose={() => { writingJobRef.current = null; setWritingSel(null); }}
          />
        );
      })()}

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

            {/* ★ "IS MY FIX STILL ATTACHED" IS THE ONLY STATUS A WRITER NEEDS.
                A correction pins its own sentence and changes nothing else, so
                there is no learning progress to report. What can go wrong is
                the sentence moving or being deleted, and that is exactly what
                these two numbers say. */}
            {chapterPinStats.total > 0 && (
              <>
                <span className="annotation-panel-divider" />
                <span
                  className="annotation-panel-count"
                  title={`${chapterPinStats.atIndex} on their original line, ${chapterPinStats.relocated} followed edited text`}
                >
                  {chapterPinStats.total - chapterPinStats.unresolved} pinned
                </span>
                {chapterPinStats.unresolved > 0 && (
                  <span
                    className="annotation-panel-review-count"
                    title="These corrections pointed at text that no longer exists, so they are applied nowhere rather than being moved onto a different line."
                  >
                    {chapterPinStats.unresolved} text gone
                  </span>
                )}
              </>
            )}

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
        onSetIntelMode={(m) => setIntelMode(m === "off" ? "off" : "auto")}
        onJumpToParagraph={handleJumpToParagraph}
        onJumpToEvent={handleJumpToEvent}
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
        knowledgeStore={knowledgeStore}
        confirmedChekhov={confirmedChekhov}
        presenceOverrides={presenceOverrides}
        onKnowledgeKnewAlready={handleKnowledgeKnewAlready}
        onKnowledgeGoodCatch={handleKnowledgeGoodCatch}
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
          globalCorrectionCount={globalCorrectionCount}
          pins={chapterPinStats}
          intelligenceLevel={analysisResultLevel ?? intelMode}
          typingSettleMs={analysisDebounceMs}
          storageTarget={stateTarget()}
          storedChapters={Object.keys(storyGraph.entries).length}
          totalChapters={chapters.length}
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
