import { useEffect } from "react";
import type { Chapter } from "../types";
import { CloseIcon, TrashIcon } from "./Icon";

interface Props {
  chapters: Chapter[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export function IndexView({ chapters, currentId, onSelect, onDelete, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="index-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="index-panel liquid-glass">
        <div className="index-header">
          <h2 className="index-title">Index</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close index">
            <CloseIcon />
          </button>
        </div>

        {chapters.length === 0 ? (
          <div className="index-empty">No chapters yet. Tap + to create the first one.</div>
        ) : (
          <div className="index-list">
            {chapters.map((c) => (
              <button
                key={c.id}
                className={`index-row ${c.id === currentId ? "active" : ""}`}
                onClick={() => onSelect(c.id)}
              >
                <span className="index-row-num">{String(c.number).padStart(2, "0")}</span>
                <span className="index-row-title">
                  {c.title || `Chapter ${c.number}`}
                </span>
                <span
                  className="index-row-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete "${c.title || `Chapter ${c.number}`}"?`)) onDelete(c.id);
                  }}
                  role="button"
                  aria-label="Delete chapter"
                >
                  <span className="icon-btn" style={{ width: 28, height: 28 }}>
                    <TrashIcon size={15} />
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
