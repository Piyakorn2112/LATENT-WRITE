import type { AnnotationStore } from "../types";
import type { CharacterBreakdown } from "../lib/annotation-learn";

interface Props {
  store: AnnotationStore;
  breakdown: CharacterBreakdown[];
  onExport: () => void;
  onClear: () => void;
  onExit: () => void;
}

export function AnnotationPanel({ store, breakdown, onExport, onClear, onExit }: Props) {
  const total = store.corrections.length;
  // Show up to 3 top characters inline as compact chips
  const topChars = breakdown.slice(0, 3);

  return (
    <div className="annotation-panel-shell">
      <div className="annotation-panel liquid-glass">
        {/* Mode label */}
        <span className="annotation-panel-badge">
          Annotation
        </span>

        {/* Divider */}
        <span className="annotation-panel-divider" />

        {/* Correction count */}
        <span className="annotation-panel-count">
          {total} correction{total !== 1 ? "s" : ""}
        </span>

        {/* Per-character breakdown — shown when there are corrections */}
        {topChars.length > 0 && (
          <>
            <span className="annotation-panel-divider" />
            <span className="annotation-panel-chars">
              {topChars.map((c, i) => (
                <span key={c.name} className="annotation-panel-char-chip">
                  {i > 0 && <span className="annotation-panel-char-sep">·</span>}
                  <span className="annotation-panel-char-name">{c.name}</span>
                  <span className="annotation-panel-char-counts">
                    {c.speechCount > 0 && <span>{c.speechCount}s</span>}
                    {c.actionCount > 0 && <span>{c.actionCount}a</span>}
                  </span>
                </span>
              ))}
            </span>
          </>
        )}

        {/* Right-side actions */}
        <span className="annotation-panel-divider" />

        <button
          className="icon-btn annotation-panel-action-btn"
          onClick={onExport}
          title="Export annotations as JSON"
        >
          Export
        </button>
        <button
          className="icon-btn annotation-panel-action-btn"
          onClick={onClear}
          title="Clear all annotation corrections"
        >
          Clear
        </button>
        <button
          className="icon-btn annotation-panel-action-btn annotation-panel-exit-btn"
          onClick={onExit}
          title="Exit annotation mode"
          aria-label="Exit annotation mode"
        >
          ✕ Exit
        </button>
      </div>
    </div>
  );
}
