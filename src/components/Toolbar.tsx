import type { CSSProperties } from "react";
import { useEffect, useRef } from "react";
import {
  ChevronLeft, ChevronRight, BookOpenIcon,
  PlusIcon, DownloadIcon, UploadIcon, UsersIcon,
} from "./Icon";

export type IntelMode = "off" | "low" | "default" | "high" | "auto";

// 60 : 30 : 10 feel — a=dominant, b=complement, c=highlight accent
const ORB_COLORS: Record<Exclude<IntelMode, "off" | "auto">, { a: string; b: string; c: string }> = {
  low:     { a: "#FFB42E", b: "#F47A2D", c: "#FFE0A0" },  // orange-yellow / deep orange / pale gold
  default: { a: "#3D68FF", b: "#7dd8ff", c: "#C0D8FF" },  // vivid blue / sky / pale blue
  high:    { a: "#8B2FF8", b: "#d880ff", c: "#FFB8F8" },  // deep purple / lavender / pink
};

interface IntelBtnProps {
  mode: IntelMode;
  /** When mode === "auto", the level the prescan currently resolves to. */
  resolvedLevel?: "low" | "default" | "high";
  onClick: () => void;
  analyzing: boolean;
}

function IntelBtn({ mode, resolvedLevel, onClick, analyzing }: IntelBtnProps) {
  // Same 6-orb geometry for ALL modes — auto cycles colours via CSS @property
  // animation, no extra dots, no scale transitions, no jump frames.
  const isAuto = mode === "auto";
  const single = mode === "low" || mode === "default" || mode === "high"
    ? ORB_COLORS[mode]
    : null;

  // For auto mode the colours come entirely from @keyframes; no inline style
  // variables required. For single modes, set --orb-a/b/c inline as before.
  const styleVars = !isAuto && single
    ? ({ "--orb-a": single.a, "--orb-b": single.b, "--orb-c": single.c } as CSSProperties)
    : undefined;

  const ariaLabel = isAuto
    ? `Intelligence mode: auto (resolved to ${resolvedLevel ?? "default"})${analyzing ? " (analyzing)" : ""}`
    : `Intelligence mode: ${mode}${analyzing ? " (analyzing)" : ""}`;

  const titleText = isAuto
    ? `Intelligence: auto → ${resolvedLevel ?? "default"} (click to cycle)`
    : `Intelligence: ${mode} (click to cycle)`;

  return (
    <button
      className={`icon-btn intel-btn ${mode !== "off" ? "icon-btn-active" : ""} ${analyzing ? "intel-btn--analyzing" : ""}`}
      onClick={onClick}
      aria-label={ariaLabel}
      title={titleText}
    >
      <span className="intel-btn-inner">
        <span
          className="intel-mesh-dot"
          data-mode={mode}
          data-resolved={isAuto ? (resolvedLevel ?? "default") : undefined}
          style={styleVars}
        >
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className="intel-mesh-dot-orb" />
          ))}
        </span>
      </span>
    </button>
  );
}

interface Props {
  chapterTitle: string;
  onChapterTitleChange: (title: string) => void;
  currentIndex: number;
  totalChapters: number;
  onPrev: () => void;
  onNext: () => void;
  onOpenIndex: () => void;
  onOpenWorld: () => void;
  onAddChapter: () => void;
  onImport: () => void;
  onExport: () => void;
  hasChapter: boolean;
  intelMode: IntelMode;
  /** When intelMode === "auto", the level the prescan currently resolves to. */
  intelResolvedLevel?: "low" | "default" | "high";
  onCycleIntel: () => void;
  isAnalyzing: boolean;
}

export function Toolbar({
  chapterTitle, onChapterTitleChange,
  currentIndex, totalChapters,
  onPrev, onNext, onOpenIndex, onOpenWorld, onAddChapter,
  onImport, onExport, hasChapter,
  intelMode, intelResolvedLevel, onCycleIntel, isAnalyzing,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (hasChapter && chapterTitle === "" && inputRef.current) {
      inputRef.current.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasChapter, currentIndex]);

  return (
    <div className="toolbar-shell">
      <div className="toolbar liquid-glass">
        {/* Intelligence mode toggle */}
        <IntelBtn
          mode={intelMode}
          resolvedLevel={intelResolvedLevel}
          onClick={onCycleIntel}
          analyzing={isAnalyzing}
        />

        {/* Chapter index */}
        <button
          className="icon-btn"
          onClick={onOpenIndex}
          aria-label="Chapter index"
          title="Chapter index"
        >
          <BookOpenIcon size={17} />
        </button>

        {/* World data — characters, places, factions */}
        <button
          className="icon-btn"
          onClick={onOpenWorld}
          aria-label="World data"
          title="World data"
        >
          <UsersIcon size={17} />
        </button>

        <div className="toolbar-divider" />

        <button
          className="icon-btn"
          onClick={onPrev}
          disabled={currentIndex <= 0}
          aria-label="Previous chapter"
          title="Previous chapter"
        >
          <ChevronLeft />
        </button>
        <button
          className="icon-btn"
          onClick={onNext}
          disabled={currentIndex >= totalChapters - 1 || totalChapters === 0}
          aria-label="Next chapter"
          title="Next chapter"
        >
          <ChevronRight />
        </button>

        <input
          ref={inputRef}
          className="toolbar-title-input"
          value={chapterTitle}
          onChange={(e) => onChapterTitleChange(e.target.value)}
          placeholder={hasChapter ? "Chapter title" : "Add a chapter to begin"}
          disabled={!hasChapter}
          spellCheck={false}
        />

        <span className="chapter-counter">
          {totalChapters > 0 ? `${currentIndex + 1} / ${totalChapters}` : "—"}
        </span>

        <div className="toolbar-divider" />

        <button className="icon-btn" onClick={onAddChapter} aria-label="New chapter" title="New chapter">
          <PlusIcon />
        </button>
        <button className="icon-btn" onClick={onImport} aria-label="Import .txt" title="Import .txt">
          <UploadIcon />
        </button>
        <button className="icon-btn" onClick={onExport} aria-label="Export .txt" title="Export .txt">
          <DownloadIcon />
        </button>
      </div>
    </div>
  );
}
