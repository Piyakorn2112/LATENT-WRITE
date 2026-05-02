import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CloseIcon } from "./Icon";

interface Props {
  content: string;
  onContentChange: (next: string) => void;
  onClose: () => void;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findAllMatches(content: string, query: string, caseSensitive: boolean) {
  if (!query) return [] as number[];
  const flags = caseSensitive ? "g" : "gi";
  const re = new RegExp(escapeRegExp(query), flags);
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push(m.index);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

function jumpToMatch(content: string, start: number, length: number) {
  const ta = document.querySelector<HTMLTextAreaElement>(".document-editor");
  if (!ta) return;
  // Set the textarea's internal selection — Chromium renders this as a soft
  // grey highlight while the textarea is unfocused, so the match is visible
  // without stealing keyboard focus from the find input.
  ta.setSelectionRange(start, start + length);
  const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 24;
  const lineNum = content.slice(0, start).split("\n").length - 1;
  const taTop = ta.getBoundingClientRect().top + window.scrollY;
  const targetY = taTop + lineNum * lineHeight - window.innerHeight / 2;
  window.scrollTo({ top: Math.max(0, targetY), behavior: "smooth" });
}

export function FindReplace({ content, onContentChange, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [replace, setReplace] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [active, setActive] = useState(0);
  const queryInputRef = useRef<HTMLInputElement>(null);

  // Mount focus only — never re-grab focus afterwards, otherwise typing in
  // either field gets interrupted on every keystroke.
  useEffect(() => {
    queryInputRef.current?.focus();
    queryInputRef.current?.select();
  }, []);

  const matches = useMemo(
    () => findAllMatches(content, query, caseSensitive),
    [content, query, caseSensitive],
  );

  // Clamp active index when matches shrink. Only this — no focus side-effects.
  useEffect(() => {
    if (matches.length === 0) {
      setActive(0);
      return;
    }
    if (active >= matches.length) setActive(matches.length - 1);
  }, [matches.length, active]);

  // Auto-scroll to the active match whenever it changes (typing, next, prev).
  // Does NOT focus the textarea — the find input keeps focus so the user
  // can continue typing without re-clicking.
  const lastJumpRef = useRef<{ start: number; len: number } | null>(null);
  useEffect(() => {
    if (matches.length === 0 || !query) {
      lastJumpRef.current = null;
      return;
    }
    const start = matches[active];
    const len = query.length;
    // Skip duplicate jumps (e.g., when content updates after a replace and
    // the same match is still at this index).
    if (lastJumpRef.current && lastJumpRef.current.start === start && lastJumpRef.current.len === len) {
      return;
    }
    lastJumpRef.current = { start, len };
    jumpToMatch(content, start, len);
  }, [active, matches, query, content]);

  const next = () => {
    if (matches.length === 0) return;
    setActive((i) => (i + 1) % matches.length);
  };
  const prev = () => {
    if (matches.length === 0) return;
    setActive((i) => (i - 1 + matches.length) % matches.length);
  };

  const replaceCurrent = () => {
    if (matches.length === 0 || !query) return;
    const start = matches[active];
    const end = start + query.length;
    const updated = content.slice(0, start) + replace + content.slice(end);
    onContentChange(updated);
    // Active stays put; the *new* match (if any) at this index becomes the
    // next target after the recompute.
  };

  const replaceAll = () => {
    if (!query) return;
    const flags = caseSensitive ? "g" : "gi";
    const re = new RegExp(escapeRegExp(query), flags);
    onContentChange(content.replace(re, replace));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      next();
    } else if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      prev();
    }
  };

  return (
    <div className="find-replace liquid-glass" role="dialog" aria-label="Find and replace" onKeyDown={onKey}>
      <div className="find-replace-row">
        <input
          ref={queryInputRef}
          className="find-replace-input"
          placeholder="Find"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          spellCheck={false}
        />
        <span className="find-replace-count">
          {query
            ? matches.length === 0
              ? "0"
              : `${active + 1}/${matches.length}`
            : ""}
        </span>
        <button
          className="icon-btn find-replace-nav"
          onClick={prev}
          disabled={matches.length === 0}
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
        >
          <ChevronLeft size={16} />
        </button>
        <button
          className="icon-btn find-replace-nav"
          onClick={next}
          disabled={matches.length === 0}
          title="Next match (Enter)"
          aria-label="Next match"
        >
          <ChevronRight size={16} />
        </button>
        <button
          className={`icon-btn find-replace-case ${caseSensitive ? "icon-btn-active" : ""}`}
          onClick={() => setCaseSensitive((v) => !v)}
          title="Match case"
          aria-pressed={caseSensitive}
          aria-label="Match case"
        >
          Aa
        </button>
        <button className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <CloseIcon size={16} />
        </button>
      </div>
      <div className="find-replace-row">
        <input
          className="find-replace-input"
          placeholder="Replace"
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
          spellCheck={false}
        />
        <button
          className="find-replace-action"
          onClick={replaceCurrent}
          disabled={matches.length === 0 || !query}
        >
          Replace
        </button>
        <button
          className="find-replace-action"
          onClick={replaceAll}
          disabled={matches.length === 0 || !query}
        >
          All
        </button>
      </div>
    </div>
  );
}
