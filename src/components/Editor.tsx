import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Chapter } from "../types";
import type { AnnotationTarget, AdaptivePredictionTrace } from "../types";
import type { ChapterAnalysisResult } from "../lib/use-analysis";
import type { ActionPrediction } from "../lib/action-detect";
import { useDebouncedValue } from "../lib/use-debounced";
import { HighlightLayer } from "./HighlightLayer";
import { checkGrammar } from "../lib/grammar-check";

interface Props {
  chapter: Chapter;
  onContentChange: (next: string) => void;
  analysisResult?: ChapterAnalysisResult | null;
  knownNames?: string[];
  onEntityClick?: (name: string, anchor: DOMRect) => void;
  annotationMode?: boolean;
  onSpeechAnnotate?: (info: AnnotationTarget, anchor: DOMRect) => void;
  onActionAnnotate?: (info: AnnotationTarget, anchor: DOMRect) => void;
  annotationOverrides?: Map<string, string | null>;
  speechPredictions?: AdaptivePredictionTrace[];
  actionPredictions?: ActionPrediction[][];
  typingSettleMs?: number;
  sidePanelOpen?: boolean;
  sidePanelCompensation?: boolean;
  layoutWidthKey?: string;
}

const ANALYSIS_PANEL_RESERVED_WIDTH = 410;
const ANALYSIS_PANEL_GAP = 18;
const DOCUMENT_LEFT_MIN_GAP = 16;

export function Editor({
  chapter, onContentChange, analysisResult, knownNames, onEntityClick,
  annotationMode, onSpeechAnnotate, onActionAnnotate, annotationOverrides,
  speechPredictions, actionPredictions, typingSettleMs = 1000,
  sidePanelOpen = false,
  sidePanelCompensation = false,
  layoutWidthKey,
}: Props) {
  const articleRef = useRef<HTMLElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const [compensationShift, setCompensationShift] = useState(0);

  const resize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
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
  const isLiveTyping = settledContent !== chapter.content;

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
      const idx = settledContent.indexOf(para, from);
      if (idx < 0) continue;
      const segs = analysisResult.speechResults[i]?.segments ?? [];
      for (const s of segs) {
        if (s.type !== "speech") continue;
        spans.push({ start: idx + s.start, end: idx + s.end });
      }
      from = idx + para.length;
    }
    return spans.length ? spans : undefined;
  }, [analysisResult, settledContent]);

  const grammarSuggestions = useMemo(
    () => checkGrammar(settledContent, { context: { speechSpans } }),
    [settledContent, speechSpans],
  );

  const recomputeCompensation = useCallback(() => {
    if (!sidePanelCompensation || !sidePanelOpen) {
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
  }, [sidePanelCompensation, sidePanelOpen]);

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
            paragraphs={analysisResult.paragraphs}
            speechResults={analysisResult.speechResults}
            knownNames={knownNames}
            grammarSuggestions={isLiveTyping ? [] : grammarSuggestions}
            visible={hasHighlight}
            onEntityClick={onEntityClick}
            annotationMode={annotationMode}
            onSpeechAnnotate={onSpeechAnnotate}
            onActionAnnotate={onActionAnnotate}
            annotationOverrides={annotationOverrides}
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
            scheduleResize();
          }}
          spellCheck
          tabIndex={annotationMode ? -1 : undefined}
        />
      </div>
    </article>
  );
}
