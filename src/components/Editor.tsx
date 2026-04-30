import { useEffect, useLayoutEffect, useRef } from "react";
import type { Chapter } from "../types";
import type { ChapterAnalysisResult } from "../lib/use-analysis";
import { HighlightLayer } from "./HighlightLayer";

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

  // Keep highlight visible at all times once we have results — the analysis
  // hook auto-refreshes on the debounce, so the colours stay roughly in sync
  // and any drift self-corrects. The textarea text stays transparent so the
  // highlight is what the user actually sees.
  const hasHighlight =
    !!analysisResult &&
    analysisResult.paragraphs.length > 0 &&
    analysisResult.speechResults.length > 0;

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
            content={chapter.content}
            paragraphs={analysisResult.paragraphs}
            speechResults={analysisResult.speechResults}
            knownNames={knownNames}
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
