import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { Chapter } from "../types";
import type { ChapterAnalysisResult } from "../lib/use-analysis";
import { HighlightLayer } from "./HighlightLayer";
import { checkGrammar } from "../lib/grammar-check";

interface Props {
  chapter: Chapter;
  onContentChange: (next: string) => void;
  analysisResult?: ChapterAnalysisResult | null;
  knownNames?: string[];
  onEntityClick?: (name: string, anchor: DOMRect) => void;
}

export function Editor({
  chapter, onContentChange, analysisResult, knownNames, onEntityClick,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  const resize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  };

  useLayoutEffect(resize, [chapter.id]);
  useEffect(() => {
    const onWinResize = () => resize();
    window.addEventListener("resize", onWinResize);
    return () => window.removeEventListener("resize", onWinResize);
  }, []);

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

  // useDeferredValue lets React render the HighlightLayer at *low* priority.
  // While the user is typing, the textarea (controlled by `chapter.content`)
  // updates instantly; the highlight overlay re-renders during idle time
  // with the deferred content. If the user keeps typing, React abandons
  // the in-flight low-priority render and restarts with the latest value.
  // Both `content` and `grammarSuggestions` need to come from the same
  // source so positions and ranges stay aligned.
  const deferredContent = useDeferredValue(chapter.content);

  // Build context.speechSpans from the speech detector so the grammar checker
  // can suppress style hints (filter, passive, adverb, wordy, cliché) inside
  // dialogue — authors stylise speech intentionally and we don't want false
  // positives there. Hard errors (spelling, agreement, capital) still fire
  // inside dialogue. Coordinates are absolute over `deferredContent`, derived
  // by locating each paragraph's offset and adding each speech segment's
  // paragraph-relative range.
  const speechSpans = useMemo(() => {
    if (!analysisResult) return undefined;
    const spans: Array<{ start: number; end: number }> = [];
    let from = 0;
    for (let i = 0; i < analysisResult.paragraphs.length; i++) {
      const para = analysisResult.paragraphs[i];
      const idx = deferredContent.indexOf(para, from);
      if (idx < 0) continue;
      const segs = analysisResult.speechResults[i]?.segments ?? [];
      for (const s of segs) {
        if (s.type !== "speech") continue;
        spans.push({ start: idx + s.start, end: idx + s.end });
      }
      from = idx + para.length;
    }
    return spans.length ? spans : undefined;
  }, [analysisResult, deferredContent]);

  const grammarSuggestions = useMemo(
    () => checkGrammar(deferredContent, { context: { speechSpans } }),
    [deferredContent, speechSpans],
  );

  return (
    <article className="document">
      <header className="document-header">
        <div className="document-chapter-num">Chapter {chapter.number}</div>
        <h1 className="document-chapter-title">
          {chapter.title || `Chapter ${chapter.number}`}
        </h1>
      </header>

      <div className="editor-wrap">
        {analysisResult && analysisResult.paragraphs.length > 0 && (
          <HighlightLayer
            content={deferredContent}
            paragraphs={analysisResult.paragraphs}
            speechResults={analysisResult.speechResults}
            knownNames={knownNames}
            grammarSuggestions={grammarSuggestions}
            visible={hasHighlight}
            onEntityClick={onEntityClick}
          />
        )}
        <textarea
          ref={taRef}
          className={`document-editor ${hasHighlight ? "document-editor--highlight" : ""}`}
          value={chapter.content}
          placeholder="Begin writing…"
          onChange={(e) => {
            onContentChange(e.target.value);
            resize();
          }}
          spellCheck
        />
      </div>
    </article>
  );
}
