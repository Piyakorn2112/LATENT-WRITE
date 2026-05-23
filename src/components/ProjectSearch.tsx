import { useEffect, useMemo, useRef, useState } from "react";
import type { Chapter } from "../types";
import { CloseIcon } from "./Icon";

interface Props {
  chapters: Chapter[];
  onJump: (chapterId: string, offset: number, length: number) => void;
  onClose: () => void;
}

interface Hit {
  chapterId: string;
  chapterNumber: number;
  chapterTitle: string;
  offset: number;
  snippet: string;        // text around the match (already escaped for highlight insertion)
  matchStartInSnippet: number;
  matchEndInSnippet: number;
}

const MAX_HITS = 200;
const SNIPPET_RADIUS = 50;

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchAll(chapters: Chapter[], query: string, caseSensitive: boolean): Hit[] {
  if (!query) return [];
  const flags = caseSensitive ? "g" : "gi";
  const re = new RegExp(escapeRe(query), flags);
  const hits: Hit[] = [];

  for (const ch of chapters) {
    const text = ch.content;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      const sStart = Math.max(0, start - SNIPPET_RADIUS);
      const sEnd = Math.min(text.length, end + SNIPPET_RADIUS);
      const before = (sStart > 0 ? "…" : "") + text.slice(sStart, start);
      const match = text.slice(start, end);
      const after = text.slice(end, sEnd) + (sEnd < text.length ? "…" : "");
      const snippet = before + match + after;
      hits.push({
        chapterId: ch.id,
        chapterNumber: ch.number,
        chapterTitle: ch.title || `Chapter ${ch.number}`,
        offset: start,
        snippet,
        matchStartInSnippet: before.length,
        matchEndInSnippet: before.length + match.length,
      });
      if (m.index === re.lastIndex) re.lastIndex++;
      if (hits.length >= MAX_HITS) return hits;
    }
  }
  return hits;
}

export function ProjectSearch({ chapters, onJump, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const keyboardNavRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hits = useMemo(
    () => searchAll(chapters, query, caseSensitive),
    [chapters, query, caseSensitive],
  );

  // Group consecutive hits by chapter for visual grouping.
  const grouped = useMemo(() => {
    const map = new Map<string, Hit[]>();
    for (const h of hits) {
      const arr = map.get(h.chapterId);
      if (arr) arr.push(h);
      else map.set(h.chapterId, [h]);
    }
    return Array.from(map.entries());
  }, [hits]);

  useEffect(() => {
    if (active >= hits.length) setActive(Math.max(0, hits.length - 1));
  }, [hits.length, active]);

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      keyboardNavRef.current = true;
      setActive((i) => Math.min(hits.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      keyboardNavRef.current = true;
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && hits[active]) {
      e.preventDefault();
      const h = hits[active];
      onJump(h.chapterId, h.offset, query.length);
      onClose();
    }
  };

  // Scroll active item into view.
  useEffect(() => {
    if (!keyboardNavRef.current) return;
    keyboardNavRef.current = false;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-hit-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let runningIdx = 0;

  return (
    <div
      className="project-search-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="project-search liquid-glass" role="dialog" aria-label="Find in project">
        <div className="project-search-header">
          <input
            ref={inputRef}
            className="project-search-input"
            placeholder="Find in project"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onListKey}
            spellCheck={false}
          />
          <button
            className={`icon-btn project-search-case ${caseSensitive ? "icon-btn-active" : ""}`}
            onClick={() => setCaseSensitive((v) => !v)}
            title="Match case"
            aria-pressed={caseSensitive}
          >
            Aa
          </button>
          <span className="project-search-count">
            {query ? (hits.length === 0 ? "0" : `${hits.length}${hits.length >= MAX_HITS ? "+" : ""}`) : ""}
          </span>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="project-search-results" ref={listRef} onKeyDown={onListKey} tabIndex={-1}>
          {!query && (
            <div className="project-search-empty">Type to search across all chapters.</div>
          )}
          {query && hits.length === 0 && (
            <div className="project-search-empty">No matches.</div>
          )}
          {grouped.map(([chapterId, chHits]) => (
            <div key={chapterId} className="project-search-group">
              <div className="project-search-group-title">
                <span className="project-search-group-num">
                  {String(chHits[0].chapterNumber).padStart(2, "0")}
                </span>
                <span className="project-search-group-name">{chHits[0].chapterTitle}</span>
                <span className="project-search-group-count">{chHits.length}</span>
              </div>
              {chHits.map((h) => {
                const idx = runningIdx++;
                const before = h.snippet.slice(0, h.matchStartInSnippet);
                const match = h.snippet.slice(h.matchStartInSnippet, h.matchEndInSnippet);
                const after = h.snippet.slice(h.matchEndInSnippet);
                return (
                  <button
                    key={`${chapterId}-${h.offset}`}
                    className={`project-search-row ${idx === active ? "active" : ""}`}
                    data-hit-index={idx}
                    onClick={() => {
                      onJump(h.chapterId, h.offset, query.length);
                      onClose();
                    }}
                  >
                    <span className="project-search-snippet">
                      {before}
                      <mark className="project-search-mark">{match}</mark>
                      {after}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="project-search-hint">
          ↑↓ to navigate · Enter to open · Esc to close
        </div>
      </div>
    </div>
  );
}
