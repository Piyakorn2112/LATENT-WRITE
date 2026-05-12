import { useEffect, useState } from "react";
import type { Chapter, NovelMeta } from "../types";
import { CloseIcon, TrashIcon, BookOpenIcon, UsersIcon } from "./Icon";

type Tab = "info" | "chapters";

interface Props {
  meta: NovelMeta;
  onMetaChange: (next: NovelMeta) => void;
  chapters: Chapter[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onReorder: (fromId: string, toIndex: number) => void;
  onClose: () => void;
}

export function IndexView({
  meta, onMetaChange,
  chapters, currentId,
  onSelect, onDelete, onReorder, onClose,
}: Props) {
  const [tab, setTab] = useState<Tab>("chapters");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onDragStart = (e: React.DragEvent, id: string) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  };

  const onRowDragOver = (e: React.DragEvent, index: number) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const above = e.clientY < rect.top + rect.height / 2;
    setDropIndex(above ? index : index + 1);
  };

  const onListDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (!dragId || dropIndex == null) return;
    onReorder(dragId, dropIndex);
    setDragId(null);
    setDropIndex(null);
  };

  const onDragEnd = () => {
    setDragId(null);
    setDropIndex(null);
  };

  const setMeta = (patch: Partial<NovelMeta>) => onMetaChange({ ...meta, ...patch });

  const totalWords = chapters.reduce((sum, c) => {
    const t = c.content.trim();
    return sum + (t ? t.split(/\s+/).length : 0);
  }, 0);

  return (
    <div
      className="index-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="world-panel index-panel-v2">
        <div className="world-header">
          <h2 className="world-title">Index</h2>
          <div className="world-tabs">
            <button
              className={`world-tab ${tab === "chapters" ? "world-tab--active" : ""}`}
              onClick={() => setTab("chapters")}
            >
              <BookOpenIcon size={13} />
              <span>Chapters</span>
              <span className="world-tab-count">{chapters.length}</span>
            </button>
            <button
              className={`world-tab ${tab === "info" ? "world-tab--active" : ""}`}
              onClick={() => setTab("info")}
            >
              <UsersIcon size={13} />
              <span>Book Info</span>
            </button>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close index">
            <CloseIcon />
          </button>
        </div>

        {tab === "info" ? (
          <div className="bookinfo-form">
            <label className="bookinfo-field">
              <span className="bookinfo-label">Title</span>
              <input
                className="bookinfo-input bookinfo-input--title"
                value={meta.title}
                onChange={(e) => setMeta({ title: e.target.value })}
                placeholder="Untitled"
              />
            </label>
            <label className="bookinfo-field">
              <span className="bookinfo-label">Subtitle</span>
              <input
                className="bookinfo-input"
                value={meta.subtitle ?? ""}
                onChange={(e) => setMeta({ subtitle: e.target.value })}
                placeholder="A novel · or remembered fragments"
              />
            </label>
            <label className="bookinfo-field">
              <span className="bookinfo-label">Author</span>
              <input
                className="bookinfo-input"
                value={meta.author}
                onChange={(e) => setMeta({ author: e.target.value })}
                placeholder="Your name"
              />
            </label>
            <label className="bookinfo-field">
              <span className="bookinfo-label">Description</span>
              <textarea
                className="bookinfo-textarea"
                value={meta.description}
                onChange={(e) => setMeta({ description: e.target.value })}
                placeholder="A short pitch, blurb, or note about this book."
                rows={5}
              />
            </label>

            <div className="bookinfo-stats">
              <div className="bookinfo-stat">
                <div className="bookinfo-stat-num">{chapters.length}</div>
                <div className="bookinfo-stat-label">chapters</div>
              </div>
              <div className="bookinfo-stat">
                <div className="bookinfo-stat-num">{totalWords.toLocaleString()}</div>
                <div className="bookinfo-stat-label">total words</div>
              </div>
              <div className="bookinfo-stat">
                <div className="bookinfo-stat-num">
                  {Math.max(1, Math.round(totalWords / 250)).toLocaleString()}
                </div>
                <div className="bookinfo-stat-label">est. pages</div>
              </div>
            </div>
          </div>
        ) : chapters.length === 0 ? (
          <div className="index-empty">No chapters yet. Tap + to create the first one.</div>
        ) : (
          <>
            <div
              className="chapter-list"
              onDragOver={(e) => e.preventDefault()}
              onDrop={onListDrop}
            >
              {chapters.map((c, i) => (
                <div key={c.id} className="chapter-card-wrap">
                  {dropIndex === i && dragId && (
                    <div className="chapter-drop-line" aria-hidden="true" />
                  )}
                  <button
                    className={`chapter-card ${c.id === currentId ? "chapter-card--active" : ""} ${dragId === c.id ? "chapter-card--dragging" : ""}`}
                    onClick={() => onSelect(c.id)}
                    draggable
                    onDragStart={(e) => onDragStart(e, c.id)}
                    onDragOver={(e) => onRowDragOver(e, i)}
                    onDragEnd={onDragEnd}
                  >
                    <span className="chapter-card-num">{String(c.number).padStart(2, "0")}</span>
                    <span className="chapter-card-body">
                      <span className="chapter-card-title">
                        {c.title || `Chapter ${c.number}`}
                      </span>
                      <span className="chapter-card-meta">
                        {(() => {
                          const t = c.content.trim();
                          const w = t ? t.split(/\s+/).length : 0;
                          return w === 0 ? "Empty" : `${w.toLocaleString()} words`;
                        })()}
                      </span>
                    </span>
                    <span
                      className="chapter-card-delete"
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
                </div>
              ))}
              {dropIndex === chapters.length && dragId && (
                <div className="chapter-drop-line" aria-hidden="true" />
              )}
            </div>

            <div className="index-hint">
              Drag a chapter to reorder. Numbers update automatically.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
