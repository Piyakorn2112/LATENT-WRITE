import type { CSSProperties } from "react";
import { useEffect, useRef } from "react";
import {
  ChevronLeft, ChevronRight, BookOpenIcon,
  PlusIcon, DownloadIcon, UploadIcon, UsersIcon, FileTextIcon, AnnotateIcon, FolderIcon,
} from "./Icon";

export type IntelMode = "off" | "low" | "default" | "high" | "auto";

// 60 : 30 : 10 feel — a=dominant, b=complement, c=highlight accent.
//
// These hex values are the originals after applying the SVG `saturate(200%)`
// colour matrix per spec (computed manually, then clamped to [0, 1] per
// channel). Pre-baking the saturation lets us drop the `saturate()` filter
// from `.intel-mesh-dot`, which is where the cross-engine green-tint
// divergence was creeping in (Chromium and WebKit pick different working
// colour spaces for filter operations). Reference matrix used:
//   R' = 1.787R − 0.715G − 0.072B
//   G' = −0.213R + 1.285G − 0.072B
//   B' = −0.213R − 0.715G + 1.928B
const ORB_COLORS: Record<Exclude<IntelMode, "off" | "auto">, { a: string; b: string; c: string }> = {
  // low — originals: #FFB42E / #F47A2D / #FFE0A0
  low:     { a: "#FFAE00", b: "#FF6500", c: "#FFDE5E" },
  // default — originals: #3D68FF / #7dd8ff / #C0D8FF
  default: { a: "#1066FF", b: "#33E9FF", c: "#AADAFF" },
  // high — originals: #8B2FF8 / #d880ff / #FFB8F8
  high:    { a: "#C50DFF", b: "#FF64FF", c: "#FFA4FF" },
};

interface IntelBtnProps {
  mode: IntelMode;
  /** When mode === "auto", the level the prescan currently resolves to. */
  resolvedLevel?: "low" | "default" | "high";
  onClick: () => void;
  analyzing: boolean;
  /** When true, overlays the bouncy gooey-eyes easter egg on the orb. */
  funMode?: boolean;
}

function IntelBtn({ mode, resolvedLevel, onClick, analyzing, funMode }: IntelBtnProps) {
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
        {/* Two stacked mesh layers — the second one overlays the first
            exactly, compounding the chroma additively. This is what
            actually carries the saturated look across both Chromium and
            WebKit; the `saturate()` filter still runs but no longer has
            to do all the lifting on its own (which is where the cross-
            engine green tint was creeping in). */}
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
        <span
          className="intel-mesh-dot intel-mesh-dot--ghost"
          data-mode={mode}
          data-resolved={isAuto ? (resolvedLevel ?? "default") : undefined}
          style={styleVars}
          aria-hidden="true"
        >
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className="intel-mesh-dot-orb" />
          ))}
        </span>
        {funMode && <IntelEyes />}
      </span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Fun-mode eyes: four stacked <path> elements per pair — pill (open) and
// arc (closed crescent) for each side. The animations cross-fade pill ↔
// arc via opacity at specific beats; the gooey filter on the parent <g>
// blends the two overlapping shapes during the cross-fade window, which
// is what reads as a liquid morph between silhouettes.
//
// Why four paths instead of one path with `d` morphing: Chromium's CSS
// `d` interpolation is finicky in practice — it requires identical
// command structure between every keyframe path and silently drops the
// animation if anything mismatches. Two static paths cross-faded by
// opacity is dramatically more reliable across browsers/versions and
// gives the same visual reading thanks to the gooey filter's alpha
// threshold smoothing the union during the transition.
//
// Shape map:
//   · OPEN PILL  — vertical stadium, default visible. scaleY(0.45) on
//                  the move keyframe is the SQUINT (focused) expression.
//                  scaleY(0.12) is the quick blink, scaleY(0.08) is the
//                  long blink.
//   · CLOSED ARC — upward crescent, default invisible. Fades in for the
//                  joyful "^_^" expression (both eyes) and the asymmetric
//                  wink (left arc only — right pill stays visible).
//
// Movement (translate) is driven by a SHARED keyframe used by all four
// paths, so both eyes always shift together — the inter-eye gap stays
// constant for the whole 8 s cycle.
//
// The outer drop-shadow on the <svg> renders AFTER the inner gooey
// filter so it haloes whichever shape pair is currently visible — soft
// contrast pop against any orb-mode colour behind.
// ─────────────────────────────────────────────────────────────────────────
function IntelEyes() {
  return (
    <svg
      className="intel-eyes"
      viewBox="-12 -12 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <filter id="intel-eyes-gooey" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="0.7" result="blur" />
          <feColorMatrix
            in="blur"
            mode="matrix"
            values="
              1 0 0 0 0
              0 1 0 0 0
              0 0 1 0 0
              0 0 0 24 -11"
            result="goo"
          />
          <feBlend in="SourceGraphic" in2="goo" />
        </filter>
      </defs>
      <g filter="url(#intel-eyes-gooey)">
        {/* Open pills — bounding box matches the user's previous <rect>
            geometry exactly: x ∈ [-4, -1] / [1, 4], y ∈ [-2.7, 3.1]. */}
        <path
          className="intel-eye intel-eye-pill intel-eye-pill--l"
          d="M -4,0.2 C -4,-1.83 -3.55,-2.7 -2.5,-2.7 C -1.45,-2.7 -1,-1.83 -1,0.2 C -1,2.23 -1.45,3.1 -2.5,3.1 C -3.55,3.1 -4,2.23 -4,0.2 Z"
        />
        <path
          className="intel-eye intel-eye-pill intel-eye-pill--r"
          d="M 1,0.2 C 1,-1.83 1.45,-2.7 2.5,-2.7 C 3.55,-2.7 4,-1.83 4,0.2 C 4,2.23 3.55,3.1 2.5,3.1 C 1.45,3.1 1,2.23 1,0.2 Z"
        />
        {/* Closed arcs — drawn as STROKED Q-curves with round line caps
            instead of filled crescent paths. Stroke-linecap: round gives
            the tips perfect circular caps for free, and stroke-width is
            the single dial for "thickness". The fill: none and stroke
            properties are set in CSS on .intel-eye-arc so the filter
            and animation still apply uniformly. */}
        <path
          className="intel-eye intel-eye-arc intel-eye-arc--l"
          d="M -3.9,0.4 Q -2.5,-2.1 -1.1,0.4"
        />
        <path
          className="intel-eye intel-eye-arc intel-eye-arc--r"
          d="M 1.1,0.4 Q 2.5,-2.1 3.9,0.4"
        />
      </g>
    </svg>
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
  onExportPdf: () => void;
  onOpenProject: () => void;
  hasChapter: boolean;
  intelMode: IntelMode;
  /** When intelMode === "auto", the level the prescan currently resolves to. */
  intelResolvedLevel?: "low" | "default" | "high";
  onCycleIntel: () => void;
  isAnalyzing: boolean;
  /** Fun-mode easter egg — overlays bouncy gooey eyes on the intel orb. */
  funMode?: boolean;
  /** Annotation mode toggle. */
  annotationMode: boolean;
  onToggleAnnotation: () => void;
}

export function Toolbar({
  chapterTitle, onChapterTitleChange,
  currentIndex, totalChapters,
  onPrev, onNext, onOpenIndex, onOpenWorld, onAddChapter,
  onImport, onExport, onExportPdf, onOpenProject, hasChapter,
  intelMode, intelResolvedLevel, onCycleIntel, isAnalyzing, funMode,
  annotationMode, onToggleAnnotation,
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
          funMode={funMode}
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
        {typeof window !== "undefined" && (window as Window & { electronAPI?: { isElectron?: boolean } }).electronAPI?.isElectron ? (
          <button className="icon-btn" onClick={onOpenProject} aria-label="Open project" title="Open project folder">
            <FolderIcon />
          </button>
        ) : (
          <button className="icon-btn" onClick={onImport} aria-label="Import .txt" title="Import .txt">
            <UploadIcon />
          </button>
        )}
        <button className="icon-btn" onClick={onExport} aria-label="Export .txt" title="Export .txt">
          <DownloadIcon />
        </button>
        <button
          className={`icon-btn toolbar-annotation-btn${annotationMode ? " icon-btn-active" : ""}`}
          onClick={onToggleAnnotation}
          aria-label="Annotation mode"
          title="Annotation mode — click speech or action spans to correct attribution"
        >
          <AnnotateIcon size={16} />
        </button>
        <button className="icon-btn" onClick={onExportPdf} aria-label="Export PDF" title="Export PDF">
          <FileTextIcon size={16} />
        </button>
      </div>
    </div>
  );
}
