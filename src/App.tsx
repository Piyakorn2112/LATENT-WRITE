import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { Toolbar } from "./components/Toolbar";
import { Editor } from "./components/Editor";
import { IndexView } from "./components/IndexView";
import { WorldDataView } from "./components/WorldDataView";
import { EntityPopover } from "./components/EntityPopover";
import { StatusPill, type StatusTask } from "./components/StatusPill";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { ScrollEdgeTop } from "./components/ScrollEdgeTop";
import { FindReplace } from "./components/FindReplace";
import { WordCount } from "./components/WordCount";
import { ProjectSearch } from "./components/ProjectSearch";
import { Onboarding } from "./components/Onboarding";
import { newChapter, parseNovel, serializeNovel } from "./lib/parser";
import { buildNovelHtml, printNovelBrowser } from "./lib/pdf-export";
import { loadNovel, saveNovel } from "./lib/storage";
import { useAnalysis } from "./lib/use-analysis";
import { lightweightPrescan } from "./lib/auto-intel";
import { renameInBook, renameInText } from "./lib/world-data";
import {
  loadPrefs, savePrefs, todayKey, loadDailyTotal, saveDailyTotal,
  FONT_STACKS, type Preferences,
} from "./lib/preferences";
import type { Novel, WorldData } from "./types";

declare global {
  interface Window {
    electronAPI?: {
      exportPdf: (html: string, filename: string) => Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
      isElectron?: boolean;
      onMenuCommand?: (cb: (cmd: string) => void) => () => void;
    };
  }
}

function totalWordsInNovel(novel: Novel): number {
  let n = 0;
  for (const c of novel.chapters) {
    const t = c.content.trim();
    if (t) n += t.split(/\s+/).length;
  }
  return n;
}

export default function App() {
  const [novel, setNovel] = useState<Novel>(() => loadNovel());
  const [currentId, setCurrentId] = useState<string | null>(
    () => loadNovel().chapters[0]?.id ?? null
  );
  const [indexOpen, setIndexOpen] = useState(false);
  const [worldOpen, setWorldOpen] = useState(false);
  const [savedVisible, setSavedVisible] = useState(false);
  const [intelMode, setIntelMode] = useState<"off" | "low" | "default" | "high" | "auto">("default");
  const [findOpen, setFindOpen] = useState(false);
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [prefs, setPrefs] = useState<Preferences>(() => loadPrefs());
  // Onboarding auto-shows on first launch and is re-openable from the
  // Help menu. Initial value is derived from prefs once at mount.
  const [onboardingOpen, setOnboardingOpen] = useState<boolean>(
    () => !loadPrefs().hasSeenOnboarding,
  );

  // Inline entity popover — opened by clicking a highlighted name in the editor.
  const [entityPopover, setEntityPopover] = useState<{ name: string; anchor: DOMRect } | null>(null);

  const [renameTask, setRenameTask] = useState<StatusTask | null>(null);
  const cycleIntel = useCallback(() => {
    setIntelMode((m) => {
      const order = ["auto", "default", "high", "low", "off"] as const;
      return order[(order.indexOf(m) + 1) % order.length];
    });
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const firstRunRef = useRef(true);
  const hideTimerRef = useRef<number | null>(null);

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

  // Persist on every change (debounced).
  useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false;
      return;
    }
    const saveTimer = window.setTimeout(() => {
      saveNovel(novel);
      setSavedVisible(true);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = window.setTimeout(() => setSavedVisible(false), 1200);
    }, 350);
    return () => window.clearTimeout(saveTimer);
  }, [novel]);

  // Persist prefs immediately — they're tiny.
  useEffect(() => { savePrefs(prefs); }, [prefs]);

  const autoResolvedLevel = useMemo<"low" | "default" | "high">(() => {
    if (intelMode !== "auto") return "default";
    const chapter = novel.chapters.find((c) => c.id === currentId);
    if (!chapter) return "default";
    const paragraphs = chapter.content.split(/\n{2,}|\n/).map((l) => l.trim()).filter(Boolean);
    return lightweightPrescan(paragraphs);
  }, [intelMode, novel.chapters, currentId]);

  const effectiveLevel: "low" | "default" | "high" =
    intelMode === "auto" ? autoResolvedLevel
    : intelMode === "off" ? "default"
    : intelMode;

  const {
    result: analysisResult,
    isAnalyzing: analysisRunning,
    knownNames,
    prevResult: prevAnalysisResult,
    nextResult: nextAnalysisResult,
  } = useAnalysis(novel, currentId, { level: effectiveLevel });

  const handleWorldChange = useCallback((next: WorldData) => {
    setNovel((n) => ({ ...n, worldData: next }));
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
    ?? (analysisRunning ? { kind: "analyzing", label: "Analysing chapter…" } : null);

  const chapters = novel.chapters;
  const currentIndex = useMemo(
    () => chapters.findIndex((c) => c.id === currentId),
    [chapters, currentId]
  );
  const current = currentIndex >= 0 ? chapters[currentIndex] : null;

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
    setNovel((n) => {
      const nextNumber = n.chapters.length
        ? Math.max(...n.chapters.map((c) => c.number)) + 1
        : 1;
      const c = newChapter(nextNumber);
      const updated = { ...n, chapters: [...n.chapters, c] };
      queueMicrotask(() => setCurrentId(c.id));
      return updated;
    });
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
        return { ...n, chapters: renumbered };
      });
    },
    [currentId, currentIndex]
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
    if (currentIndex > 0) setCurrentId(chapters[currentIndex - 1].id);
  }, [chapters, currentIndex]);

  const handleNext = useCallback(() => {
    if (currentIndex >= 0 && currentIndex < chapters.length - 1) {
      setCurrentId(chapters[currentIndex + 1].id);
    }
  }, [chapters, currentIndex]);

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

  const handleExportPdf = useCallback(async () => {
    const safeTitle = (novel.meta.title || "novel").replace(/[^\w\d-]+/g, "-").toLowerCase();
    const filename = `${safeTitle}.pdf`;
    if (window.electronAPI) {
      const html = buildNovelHtml(novel);
      await window.electronAPI.exportPdf(html, filename);
    } else {
      printNovelBrowser(novel);
    }
  }, [novel]);

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
    setNovel(parsed);
    setCurrentId(parsed.chapters[0]?.id ?? null);
    // Reset daily baseline since the document just got swapped wholesale.
    baselineRef.current = totalWordsInNovel(parsed);
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
      else if (mod && (e.key === "s" || e.key === "S")) { e.preventDefault(); flushSave(); }
      else if (mod && e.key === ".") { e.preventDefault(); setFocusMode((v) => !v); }
      else if (e.key === "Escape" && findOpen) { e.preventDefault(); setFindOpen(false); }
      else if (e.key === "Escape" && projectSearchOpen) { e.preventDefault(); setProjectSearchOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlePrev, handleNext, handleAddChapter, flushSave, findOpen, projectSearchOpen]);

  // Native menu wiring (Electron only). Same actions as the keyboard handler.
  useEffect(() => {
    if (!window.electronAPI?.onMenuCommand) return;
    const off = window.electronAPI.onMenuCommand((cmd) => {
      switch (cmd) {
        case "new-chapter":     handleAddChapter(); break;
        case "open-index":      setIndexOpen(true); break;
        case "open-world":      setWorldOpen(true); break;
        case "import-txt":      handleImport(); break;
        case "export-txt":      handleExport(); break;
        case "export-pdf":      handleExportPdf(); break;
        case "save":            flushSave(); break;
        case "find":            setFindOpen(true); break;
        case "project-search":  setProjectSearchOpen(true); break;
        case "focus-mode":      setFocusMode((v) => !v); break;
        case "cycle-intel":     cycleIntel(); break;
        case "prev-chapter":    handlePrev(); break;
        case "next-chapter":    handleNext(); break;
        case "show-welcome":    setOnboardingOpen(true); break;
      }
    });
    return off;
  }, [handleAddChapter, handleImport, handleExport, handleExportPdf, flushSave, cycleIntel, handlePrev, handleNext]);

  // Apply typography prefs to CSS custom properties on the editor tree.
  const editorStyle = useMemo<CSSProperties>(() => ({
    "--editor-font":        FONT_STACKS[prefs.typography.fontFamily],
    "--editor-font-size":   `${prefs.typography.fontSize}px`,
    "--editor-line-height": String(prefs.typography.lineHeight),
    "--editor-measure":     `${prefs.typography.measure}ch`,
  } as CSSProperties), [prefs.typography]);

  const appClass = `app${focusMode ? " app--focus" : ""}`;

  return (
    <div className={appClass} style={editorStyle}>
      <div className="app-drag-region" aria-hidden="true" />
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
        hasChapter={!!current}
        intelMode={intelMode}
        intelResolvedLevel={intelMode === "auto" ? autoResolvedLevel : undefined}
        onCycleIntel={cycleIntel}
        isAnalyzing={analysisRunning}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,text/plain"
        style={{ display: "none" }}
        onChange={handleFileSelected}
      />

      <StatusPill task={statusTask} />

      {current ? (
        <Editor
          key={current.id}
          chapter={current}
          onContentChange={(content) => updateCurrent((c) => ({ ...c, content }))}
          analysisResult={intelMode !== "off" ? analysisResult : null}
          knownNames={intelMode !== "off" ? knownNames : []}
          onEntityClick={(name, anchor) => setEntityPopover({ name, anchor })}
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
          worldData={novel.worldData}
          onChange={handleWorldChange}
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

      <AnalysisPanel
        result={analysisResult}
        prevResult={prevAnalysisResult}
        nextResult={nextAnalysisResult}
        isAnalyzing={analysisRunning}
        intelMode={intelMode}
        onSetIntelMode={setIntelMode}
        prefs={prefs}
        onSetPrefs={setPrefs}
        chapterId={currentId}
        chapterContent={current?.content}
        allChapters={chapters}
        chapterIndex={currentIndex}
        worldData={novel.worldData}
      />

      {current && (
        <WordCount
          content={current.content}
          todayWords={todayWords}
          goal={prefs.goals.dailyWords}
        />
      )}

      {findOpen && current && (
        <FindReplace
          content={current.content}
          onContentChange={(content) => updateCurrent((c) => ({ ...c, content }))}
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
        <Onboarding onClose={handleOnboardingClose} />
      )}

      <div className={`saved-indicator ${savedVisible ? "visible" : ""}`}>
        saved
      </div>
    </div>
  );
}
