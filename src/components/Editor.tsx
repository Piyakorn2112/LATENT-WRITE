import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Chapter } from "../types";
import type { AnnotationTarget, AdaptivePredictionTrace } from "../types";
import type { ChapterAnalysisResult } from "../lib/use-analysis";
import type { ActionPrediction } from "../lib/action-detect";
import type { ToolHighlight } from "../lib/tool-runner";
import { useDebouncedValue } from "../lib/use-debounced";
import { measurePerfSync } from "../lib/perf-trace";
import { resolveLiveKnownNames, type EntityNameMap } from "../lib/world-data";
import * as HighlightLayerModule from "./HighlightLayer";
import { checkGrammar } from "../lib/grammar-check";
import { paragraphIndexAt } from "../lib/max-ask-context";

const HighlightLayer = HighlightLayerModule.HighlightLayer;

interface Props {
  chapter: Chapter;
  onContentChange: (next: string) => void;
  analysisResult?: ChapterAnalysisResult | null;
  knownNames?: string[];
  entityNameMap?: EntityNameMap;
  onEntityClick?: (name: string, anchor: DOMRect) => void;
  annotationMode?: boolean;
  onSpeechAnnotate?: (info: AnnotationTarget, anchor: DOMRect) => void;
  onActionAnnotate?: (info: AnnotationTarget, anchor: DOMRect) => void;
  annotationOverrides?: Map<string, string | null>;
  /** Scene labels the local model resolved, by scene-start paragraph index.
   *  Fills a silence the engine left; it never overwrites an engine label. */
  sceneLabelOverrides?: Map<number, string>;
  speechPredictions?: AdaptivePredictionTrace[];
  actionPredictions?: ActionPrediction[][];
  toolHighlights?: ToolHighlight[];
  typingSettleMs?: number;
  sidePanelOpen?: boolean;
  sidePanelCompensation?: boolean;
  layoutWidthKey?: string;
  splitMode?: boolean;
  /**
   * Right-click on a paragraph → the max-ask surface. Present only when the
   * assistant is in max mode, so the handler's existence IS the gate: no mode
   * checks in here, and off/on modes keep whatever the platform does with
   * right-click (in Electron: nothing).
   */
  onAskParagraph?: (info: { chapterId: string; paragraphIndex: number; x: number; y: number }) => void;
  /** Right-click WITH a selection → the writing tool (max mode). */
  onWriteSelection?: (info: { chapterId: string; start: number; end: number; x: number; y: number }) => void;
  /** While the writing tool runs, this span refuses edits and pulses. */
  lockedRange?: { start: number; end: number } | null;
}

const ANALYSIS_PANEL_RESERVED_WIDTH = 410;
const ANALYSIS_PANEL_GAP = 18;
const DOCUMENT_LEFT_MIN_GAP = 16;

interface ParagraphSlice {
  start: number;
  end: number;
  text: string;
}

function resolveParagraphSlice(content: string, caret: number): ParagraphSlice {
  if (!content) return { start: 0, end: 0, text: "" };

  const clampedCaret = Math.max(0, Math.min(caret, content.length));
  let start = clampedCaret;
  while (start > 0 && content[start - 1] !== "\n") start--;

  let end = clampedCaret;
  while (end < content.length && content[end] !== "\n") end++;

  return {
    start,
    end,
    text: content.slice(start, end),
  };
}

export function Editor({
  chapter,
  onAskParagraph, onWriteSelection, lockedRange, onContentChange, analysisResult, knownNames, entityNameMap, onEntityClick,
  annotationMode, onSpeechAnnotate, onActionAnnotate, annotationOverrides, sceneLabelOverrides,
  speechPredictions, actionPredictions, toolHighlights, typingSettleMs = 1000,
  sidePanelOpen = false,
  sidePanelCompensation = false,
  layoutWidthKey,
  splitMode = false,
}: Props) {
  const articleRef = useRef<HTMLElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const [compensationShift, setCompensationShift] = useState(0);
  const [caretPosition, setCaretPosition] = useState(0);

  const resize = () => {
    const ta = taRef.current;
    if (!ta) return;
    if (splitMode) {
      const pane = ta.closest(".split-pane");
      const scrollTop = pane ? pane.scrollTop : 0;
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
      if (pane && pane.scrollTop !== scrollTop) pane.scrollTop = scrollTop;
    } else {
      const scrollY = window.scrollY;
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
      if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
    }
  };

  const scheduleResize = () => {
    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
    }
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      resize();
    });
  };

  useLayoutEffect(resize, [chapter.id]);
  useEffect(() => {
    setCaretPosition(0);
  }, [chapter.id]);
  useEffect(() => {
    return () => {
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }
    };
  }, []);
  useEffect(() => {
    const onWinResize = () => scheduleResize();
    window.addEventListener("resize", onWinResize);
    return () => window.removeEventListener("resize", onWinResize);
  }, []);

  // Blur textarea when entering annotation mode so the browser doesn't
  // scroll to the caret position on re-renders.
  useEffect(() => {
    if (annotationMode && taRef.current) {
      taRef.current.blur();
    }
  }, [annotationMode]);

  // Keep the textarea in --highlight mode for the entire duration that any
  // analysis exists, regardless of whether the current content still matches.
  // Mounting/unmounting the overlay (or toggling the textarea class) on every
  // edit causes the browser to flip compositor layers and re-paint, which
  // visually shifts the line being typed and collides it with the line above.
  // Staleness is handled inside HighlightLayer instead — when content has
  // diverged, it renders the current content as plain text in-place, keeping
  // the DOM and the textarea state perfectly stable.
  //
  // The third check (speechResults.length) was redundant — speech-detect
  // emits one result per paragraph, so it's always equal to paragraphs.length.
  // Including it just as a safety guard left grammar/entity highlights
  // invisible (opacity:0) any time speech detection produced an empty array.
  const hasHighlight =
    !!analysisResult && analysisResult.paragraphs.length > 0;

  // The analysis pipeline still settles before we recompute expensive speech /
  // grammar data, but the overlay itself stays mounted on the live content.
  // HighlightLayer already falls back to plain current text for stale regions,
  // which avoids the compositor flip caused by hiding/showing the mirror.
  const settledContent = useDebouncedValue(chapter.content, typingSettleMs);
  const analysisSnapshotContent = analysisResult?.contentSnapshot ?? settledContent;
  const syncCaretPosition = useCallback((element: HTMLTextAreaElement | null) => {
    if (!element) return;
    const nextPosition = Math.max(0, Math.min(element.selectionStart ?? 0, element.value.length));
    setCaretPosition((prev) => (prev === nextPosition ? prev : nextPosition));
  }, []);
  const activeParagraph = useMemo(
    () => resolveParagraphSlice(chapter.content, caretPosition),
    [chapter.content, caretPosition],
  );
  const liveKnownNames = useMemo(
    () => measurePerfSync(
      "highlight.live-known-names",
      () => resolveLiveKnownNames(activeParagraph.text, knownNames ?? []),
      1,
      { chapterId: chapter.id, paragraphLength: activeParagraph.text.length },
    ),
    [chapter.id, activeParagraph.text, knownNames],
  );

  // Build context.speechSpans from the speech detector so the grammar checker
  // can suppress style hints (filter, passive, adverb, wordy, cliché) inside
  // dialogue — authors stylise speech intentionally and we don't want false
  // positives there. Hard errors (spelling, agreement, capital) still fire
  // inside dialogue. This stays on the settled snapshot so grammar and the
  // enriched overlay never enter the per-keystroke path.
  const speechSpans = useMemo(() => {
    if (!analysisResult) return undefined;
    const spans: Array<{ start: number; end: number }> = [];
    let from = 0;
    for (let i = 0; i < analysisResult.paragraphs.length; i++) {
      const para = analysisResult.paragraphs[i];
      const idx = analysisSnapshotContent.indexOf(para, from);
      if (idx < 0) continue;
      const segs = analysisResult.speechResults[i]?.segments ?? [];
      for (const s of segs) {
        if (s.type !== "speech") continue;
        spans.push({ start: idx + s.start, end: idx + s.end });
      }
      from = idx + para.length;
    }
    return spans.length ? spans : undefined;
  }, [analysisResult, analysisSnapshotContent]);

  const grammarSuggestions = useMemo(
    () => checkGrammar(analysisSnapshotContent, { context: { speechSpans } }),
    [analysisSnapshotContent, speechSpans],
  );

  const recomputeCompensation = useCallback(() => {
    if (splitMode || !sidePanelCompensation || !sidePanelOpen) {
      setCompensationShift((prev) => (prev === 0 ? prev : 0));
      return;
    }

    const article = articleRef.current;
    const wrap = wrapRef.current;
    if (!article || !wrap || typeof window === "undefined") {
      setCompensationShift((prev) => (prev === 0 ? prev : 0));
      return;
    }

    const viewportWidth = window.innerWidth;
    const articleWidth = article.offsetWidth;
    const wrapWidth = wrap.offsetWidth;
    const computed = window.getComputedStyle(article);
    const padLeft = Number.parseFloat(computed.paddingLeft) || 0;
    const padRight = Number.parseFloat(computed.paddingRight) || 0;
    const innerWidth = Math.max(0, articleWidth - padLeft - padRight);
    const centeredOffset = Math.max(0, (innerWidth - wrapWidth) / 2);
    const baseArticleLeft = Math.max(0, (viewportWidth - articleWidth) / 2);
    const baseWrapLeft = baseArticleLeft + padLeft + centeredOffset;
    const baseWrapRight = baseWrapLeft + wrapWidth;
    const panelLeftEdge = viewportWidth - ANALYSIS_PANEL_RESERVED_WIDTH;
    const safeRight = panelLeftEdge - ANALYSIS_PANEL_GAP;
    const desiredShift = Math.max(0, baseWrapRight - safeRight);
    const maxShift = Math.max(0, baseWrapLeft - DOCUMENT_LEFT_MIN_GAP);
    const nextShift = Math.min(desiredShift, maxShift);

    setCompensationShift((prev) => (Math.abs(prev - nextShift) < 0.5 ? prev : nextShift));
  }, [splitMode, sidePanelCompensation, sidePanelOpen]);

  useLayoutEffect(() => {
    recomputeCompensation();
  }, [recomputeCompensation, layoutWidthKey]);

  useEffect(() => {
    const onWinResize = () => recomputeCompensation();
    window.addEventListener("resize", onWinResize);
    return () => window.removeEventListener("resize", onWinResize);
  }, [recomputeCompensation]);

  return (
    <article
      ref={articleRef}
      className="document"
      style={{ "--document-compensation-shift": `${-compensationShift}px` } as CSSProperties}
    >
      <header className="document-header">
        <div className="document-chapter-num">Chapter {chapter.number}</div>
        <h1 className="document-chapter-title">
          {chapter.title || `Chapter ${chapter.number}`}
        </h1>
      </header>

      <div ref={wrapRef} className={`editor-wrap${annotationMode ? " editor-wrap--annotate" : ""}`}>
        {analysisResult && analysisResult.paragraphs.length > 0 && (
          <HighlightLayer
            content={chapter.content}
            snapshotContent={analysisSnapshotContent}
            paragraphs={analysisResult.paragraphs}
            speechResults={analysisResult.speechResults}
            pronounOwners={analysisResult.pronounOwners}
            knownNames={knownNames}
            entityNameMap={entityNameMap}
            liveKnownNames={liveKnownNames}
            liveParagraphRange={activeParagraph.end > activeParagraph.start
              ? { start: activeParagraph.start, end: activeParagraph.end }
              : null}
            grammarSuggestions={grammarSuggestions}
            toolHighlights={toolHighlights}
            visible={hasHighlight}
            onEntityClick={onEntityClick}
            annotationMode={annotationMode}
            onSpeechAnnotate={onSpeechAnnotate}
            onActionAnnotate={onActionAnnotate}
            annotationOverrides={annotationOverrides}
            sceneLabelOverrides={sceneLabelOverrides}
            speechPredictions={speechPredictions}
            actionPredictions={actionPredictions}
          />
        )}
        <textarea
          ref={taRef}
          className={`document-editor ${hasHighlight ? "document-editor--highlight" : ""}`}
          value={chapter.content}
          placeholder="Begin writing…"
          onChange={(e) => {
            onContentChange(e.target.value);
            syncCaretPosition(e.target);
            scheduleResize();
          }}
          onSelect={(e) => syncCaretPosition(e.currentTarget)}
          onClick={(e) => syncCaretPosition(e.currentTarget)}
          onKeyUp={(e) => syncCaretPosition(e.currentTarget)}
          onFocus={(e) => syncCaretPosition(e.currentTarget)}
          onContextMenu={(onAskParagraph || onWriteSelection) ? (e) => {
            // ★ Chromium moves the caret on the right-click's own mousedown
            //   (that is how native spell-suggestions know their word), so by
            //   the time contextmenu fires, selectionStart IS the clicked
            //   offset. The e2e asserts this: the popover must preview the
            //   paragraph under the pointer, not the one last edited.
            //   EXCEPT when a real selection exists — a right-click INSIDE it
            //   keeps it, and that selection is the writing tool's input.
            const el = e.currentTarget;
            const selStart = el.selectionStart ?? 0;
            const selEnd = el.selectionEnd ?? 0;
            if (onWriteSelection && selEnd > selStart) {
              e.preventDefault();
              onWriteSelection({ chapterId: chapter.id, start: selStart, end: selEnd, x: e.clientX, y: e.clientY });
              return;
            }
            if (!onAskParagraph) return;
            e.preventDefault();
            onAskParagraph({
              chapterId: chapter.id,
              paragraphIndex: paragraphIndexAt(chapter.content, selStart),
              x: e.clientX,
              y: e.clientY,
            });
          } : undefined}
          onBeforeInput={lockedRange ? (e) => {
            // ★ ONLY THE IN-FLIGHT SPAN IS LOCKED (owner call: not the whole
            //   chapter). Any edit whose selection touches it is refused; the
            //   rest of the chapter stays editable and the App shifts the
            //   run's offsets for edits landing before it.
            const el = e.currentTarget as HTMLTextAreaElement;
            const s = el.selectionStart ?? 0;
            const en = el.selectionEnd ?? s;
            if (s < lockedRange.end && en >= lockedRange.start) e.preventDefault();
          } : undefined}
          onCut={lockedRange ? (e) => {
            const el = e.currentTarget;
            const s = el.selectionStart ?? 0;
            const en = el.selectionEnd ?? s;
            if (s < lockedRange.end && en >= lockedRange.start) e.preventDefault();
          } : undefined}
          spellCheck
          tabIndex={annotationMode ? -1 : undefined}
        />
        {lockedRange && (
          <WritingWaveOverlay textareaRef={taRef} range={lockedRange} content={chapter.content} />
        )}
      </div>
    </article>
  );
}

/**
 * The pulse over the span the writing tool is revising — ON THE TEXT ITSELF
 * (owner call: not a rounded veil). A full style-mirror of the textarea
 * re-renders the SAME glyphs in the same positions: everything outside the
 * range is transparent, and each word inside it is an accent-coloured span
 * whose opacity pulses on a staggered delay, so a wave of colour travels the
 * words while the textarea's own glyphs keep the text legible underneath.
 * Pointer-events none throughout — the textarea stays the editing surface.
 */
function WritingWaveOverlay({ textareaRef, range, content }: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  range: { start: number; end: number };
  content: string;
}) {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const cs = window.getComputedStyle(ta);
    const copy: Record<string, string> = {};
    for (const prop of [
      "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
      "padding-top", "padding-right", "padding-bottom", "padding-left",
      "border-top-width", "border-left-width", "box-sizing", "tab-size",
      "text-rendering",
    ]) {
      copy[prop] = cs.getPropertyValue(prop);
    }
    // ★ THE COVER COLOUR IS THE REAL SURFACE, RESOLVED AT RUNTIME. Each
    //   pulsing word paints a near-opaque swatch of the page behind itself,
    //   which is what dims the ORIGINAL glyphs under it — the textarea's in
    //   plain mode, the highlight layer's styled text in highlight mode
    //   (where accent-over-opaque-text was invisible). Walking up for the
    //   first non-transparent background beats guessing a token.
    let cover = "";
    for (let el: HTMLElement | null = ta; el; el = el.parentElement) {
      const bg = window.getComputedStyle(el).backgroundColor;
      if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") { cover = bg; break; }
    }
    if (!cover) cover = window.getComputedStyle(document.body).backgroundColor || "#fff";
    setStyle({
      ...(copy as CSSProperties),
      top: ta.offsetTop,
      left: ta.offsetLeft,
      width: ta.clientWidth,
      ["--wave-cover" as never]: cover,
    });
  }, [textareaRef, range.start, range.end, content]);
  if (!style) return null;

  // Word-level spans inside the range; whitespace stays as plain (transparent)
  // text so wrapping in the mirror matches the textarea exactly.
  const inRange = content.slice(range.start, range.end);
  const parts = inRange.split(/(\s+)/);
  let wordIndex = 0;
  return (
    <div className="writing-wave-text" style={style} aria-hidden>
      {content.slice(0, range.start)}
      {parts.map((part, i) => {
        if (part === "" || /^\s+$/.test(part)) return part;
        const delay = (wordIndex++ * 90) % 1530;
        return (
          <span key={i} className="writing-wave-word" style={{ animationDelay: `${delay}ms` }}>
            {part}
          </span>
        );
      })}
      {content.slice(range.end)}
    </div>
  );
}
