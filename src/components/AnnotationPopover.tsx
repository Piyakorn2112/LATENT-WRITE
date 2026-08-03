import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AnnotationTarget, WorldData } from "../types";
import { CloseIcon } from "./Icon";

interface Props {
  target: AnnotationTarget;
  anchor: DOMRect;
  worldData: WorldData | undefined;
  /** If the user has already corrected this span, pass the corrected speaker so the
   *  popover pre-selects it instead of the raw detected speaker. */
  correctedSpeaker?: string | null;
  onConfirm: (correctedName: string | null) => void;
  onClose: () => void;
}

const POPOVER_WIDTH = 280;
const GAP = 8;

export function AnnotationPopover({ target, anchor, worldData, correctedSpeaker, onConfirm, onClose }: Props) {
  const isSpeech = target.spanType === "speech";

  // Build sorted character list: all named characters + a "null" sentinel.
  const characters: Array<string | null> = [
    ...(worldData?.characters ?? [])
      .map((c) => c.name)
      .sort((a, b) => a.localeCompare(b)),
    null, // "Narrative / No speaker"
  ];

  // Pre-select the already-corrected speaker if one exists; otherwise fall back
  // to the currently detected speaker.
  const initialSelection = correctedSpeaker !== undefined ? correctedSpeaker : target.currentSpeaker;
  const [selected, setSelected] = useState<string | null | undefined>(initialSelection);

  const listRef = useRef<HTMLUListElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Scroll an item into view within the list only — never propagate to the page.
  // scrollIntoView({ block: "nearest" }) propagates through all scrollable
  // ancestors including window, which jumps the page when the selected item is
  // the null/Narrative entry at the bottom of the list (it lies outside the
  // ul's 200px visible area and the browser ends up scrolling the page to it).
  const scrollItemIntoList = (list: HTMLUListElement, idx: number) => {
    const item = list.children[idx] as HTMLElement | undefined;
    if (!item) return;
    const itemTop = item.offsetTop;
    const itemBottom = itemTop + item.offsetHeight;
    if (itemBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = itemBottom - list.clientHeight;
    } else if (itemTop < list.scrollTop) {
      list.scrollTop = itemTop;
    }
  };

  // Auto-scroll selected item into view on mount.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const idx = characters.findIndex((c) => c === initialSelection);
    if (idx >= 0) scrollItemIntoList(list, idx);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "Enter") {
        if (selected !== target.currentSpeaker) onConfirm(selected ?? null);
        else onClose();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = characters.findIndex((c) => c === selected);
        const next = e.key === "ArrowDown"
          ? Math.min(characters.length - 1, idx + 1)
          : Math.max(0, idx - 1);
        setSelected(characters[next]);
        if (listRef.current) scrollItemIntoList(listRef.current, next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, characters, target.currentSpeaker, onConfirm, onClose]);

  // Close on outside mousedown.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const t = window.setTimeout(() => window.addEventListener("mousedown", onDown), 0);
    return () => { window.clearTimeout(t); window.removeEventListener("mousedown", onDown); };
  }, [onClose]);

  // ── Position the popover — MATCHES EntityPopover exactly ──
  // Uses position: absolute (from CSS) + window.scrollY so the popover
  // sits at a document-absolute coordinate and scrolls with the page,
  // sticking to the clicked text span.
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const cardH = card.offsetHeight;
    const winH = window.innerHeight;
    const winW = window.innerWidth;

    // Prefer below the anchor; flip up if not enough room.
    const below = anchor.bottom + GAP;
    const above = anchor.top - cardH - GAP;
    const top = (below + cardH > winH - 16 && above >= 16) ? above : below;

    let left = anchor.left + anchor.width / 2 - POPOVER_WIDTH / 2;
    left = Math.max(12, Math.min(winW - POPOVER_WIDTH - 12, left));

    setPos({
      top: Math.max(12, top) + window.scrollY,
      left: left + window.scrollX,
      visibility: "visible",
    });
  }, [anchor]);

  // "unchanged" means the user hasn't picked anything different from whatever
  // was already selected/corrected when the popover opened.
  const unchanged = selected === initialSelection;

  return (
    <div
      ref={cardRef}
      className="annotation-popover liquid-glass"
      style={pos}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="annotation-popover-header">
        <div className="annotation-popover-header-text">
          <div className="annotation-popover-eyebrow">
            {isSpeech ? "Speaker" : "Actor"}
          </div>
          <div className="annotation-popover-preview">
            "{target.spanText.slice(0, 50)}{target.spanText.length > 50 ? "…" : ""}"
          </div>
        </div>
        <button className="icon-btn annotation-popover-close" onClick={onClose} aria-label="Close">
          <CloseIcon size={13} />
        </button>
      </div>

      {/* Current attribution */}
      <div className="annotation-popover-current">
        <span className="annotation-popover-current-label">Detected</span>
        <span className="annotation-popover-current-value">
          {target.currentSpeaker || "Unattributed"}
        </span>
      </div>
      {correctedSpeaker !== undefined && correctedSpeaker !== target.currentSpeaker && (
        <div className="annotation-popover-current annotation-popover-current--corrected">
          <span className="annotation-popover-current-label">Corrected</span>
          <span className="annotation-popover-current-value">
            {correctedSpeaker || "Narrative / None"}
          </span>
        </div>
      )}

      {/* Scrollable character list — click to select */}
      <ul
        ref={listRef}
        className="annotation-popover-list"
      >
        {characters.map((name) => {
          const isSelected = selected === name;
          const isCurrent = target.currentSpeaker === name;
          return (
            <li
              key={name ?? "__null__"}
              className={`annotation-popover-item${isSelected ? " annotation-popover-item--selected" : ""}${name === null ? " annotation-popover-item--null" : ""}`}
              onClick={() => setSelected(name)}
            >
              <span>{name ?? "Narrative / None"}</span>
              {isCurrent && <span className="annotation-popover-item-badge">detected</span>}
            </li>
          );
        })}
      </ul>

      {/* Action row */}
      <div className="annotation-popover-actions">
        <button
          className="annotation-popover-btn annotation-popover-btn--confirm"
          disabled={unchanged}
          onClick={() => onConfirm(selected ?? null)}
        >
          Confirm
        </button>
        <button
          className="annotation-popover-btn annotation-popover-btn--cancel"
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
