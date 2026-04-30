import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Toolbar } from "./components/Toolbar";
import { Editor } from "./components/Editor";
import { IndexView } from "./components/IndexView";
import { WorldDataView } from "./components/WorldDataView";
import { EntityPopover } from "./components/EntityPopover";
import { StatusPill, type StatusTask } from "./components/StatusPill";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { newChapter, parseNovel, serializeNovel } from "./lib/parser";
import { loadNovel, saveNovel } from "./lib/storage";
import { useAnalysis } from "./lib/use-analysis";
import { lightweightPrescan } from "./lib/auto-intel";
import { renameInBook, renameInText } from "./lib/world-data";
import type { Novel, WorldData } from "./types";

export default function App() {
  const [novel, setNovel] = useState<Novel>(() => loadNovel());
  const [currentId, setCurrentId] = useState<string | null>(
    () => loadNovel().chapters[0]?.id ?? null
  );
  const [indexOpen, setIndexOpen] = useState(false);
  const [worldOpen, setWorldOpen] = useState(false);
  const [savedVisible, setSavedVisible] = useState(false);
  const [intelMode, setIntelMode] = useState<"off" | "low" | "default" | "high" | "auto">("default");

  // Inline entity popover — opened by clicking a highlighted name in the editor.
  const [entityPopover, setEntityPopover] = useState<{ name: string; anchor: DOMRect } | null>(null);

  // Status pill task — analysing, renaming, etc. Highest-priority task wins.
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

  // Persist on every change (debounced). Skip the initial mount so the
  // "saved" pip only shows after a real edit.
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

  // Auto mode resolves to one of low/default/high based on the current chapter's
  // dialogue density. Recomputed when the chapter content changes — cheap (<1ms).
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

  // Auto-rename — runs across either just the open chapter or the entire book.
  // Word-bounded + case-sensitive so "Mark" doesn't shred "marker".
  const handleRename = useCallback(
    (oldName: string, newName: string, scope: "chapter" | "book") => {
      const old = oldName.trim();
      const next = newName.trim();
      if (!old || !next || old === next) return;

      const label = scope === "book"
        ? `Renaming "${old}" → "${next}" across book…`
        : `Renaming "${old}" → "${next}" in chapter…`;
      setRenameTask({ kind: `rename-${scope}-${old}-${next}`, label });

      // Defer the heavy work to the next tick so the pill can paint first.
      window.setTimeout(() => {
        setNovel((n) => {
          if (scope === "book") {
            return renameInBook(n, old, next).novel;
          }
          // chapter scope — only the currently-open chapter
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
        // Hold the pill briefly so the message is readable, then dismiss.
        window.setTimeout(() => setRenameTask(null), 450);
      }, 16);
    },
    [currentId],
  );

  // Status pill task — analysing wins unless a rename is in flight.
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
      // schedule selection on next tick via the returned chapter id
      queueMicrotask(() => setCurrentId(c.id));
      return updated;
    });
  }, []);

  const handleDeleteChapter = useCallback(
    (id: string) => {
      setNovel((n) => {
        const remaining = n.chapters.filter((c) => c.id !== id);
        // Renumber so chapters stay 1..N
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

  const handlePrev = useCallback(() => {
    if (currentIndex > 0) setCurrentId(chapters[currentIndex - 1].id);
  }, [chapters, currentIndex]);

  const handleNext = useCallback(() => {
    if (currentIndex >= 0 && currentIndex < chapters.length - 1) {
      setCurrentId(chapters[currentIndex + 1].id);
    }
  }, [chapters, currentIndex]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); handlePrev(); }
      else if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); handleNext(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !inField) {
        e.preventDefault();
        handleAddChapter();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlePrev, handleNext, handleAddChapter]);

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

  const handleImport = useCallback(() => fileInputRef.current?.click(), []);

  const handleFileSelected = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset for re-import of same file
    if (!file) return;
    const text = await file.text();
    const parsed = parseNovel(text);
    setNovel(parsed);
    setCurrentId(parsed.chapters[0]?.id ?? null);
  }, []);

  return (
    <div className="app">
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
          chapters={chapters}
          currentId={currentId}
          onSelect={(id) => { setCurrentId(id); setIndexOpen(false); }}
          onDelete={handleDeleteChapter}
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
      />

      <div className={`saved-indicator ${savedVisible ? "visible" : ""}`}>
        saved
      </div>
    </div>
  );
}
