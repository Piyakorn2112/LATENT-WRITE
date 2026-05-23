import { memo, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./Icon";
import type { ToolScanEntry } from "../lib/project-manager";

interface Props {
  tools: ToolScanEntry[];
  sourcePath: string;
  existingToolNames: Set<string>;
  onImport: (imports: Array<{ dirName: string; targetName?: string }>) => void;
  onClose: () => void;
}

function CheckIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 6.5L5 9L9.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const SURFACE_LABELS: Record<string, string> = {
  chat: "Chat",
  widget: "Widget",
  sidebar: "Sidebar",
  overlay: "Overlay",
  highlight: "Highlight",
};

function ToolImportOverlayInner({ tools, sourcePath, existingToolNames, onImport, onClose }: Props) {
  const [selected, setSelected] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const t of tools) {
      if (!existingToolNames.has(t.manifest.name)) initial.add(t.dirName);
    }
    return initial;
  });

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const toggle = useCallback((dirName: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(dirName)) next.delete(dirName);
      else next.add(dirName);
      return next;
    });
  }, []);

  const handleImport = useCallback(() => {
    const imports: Array<{ dirName: string; targetName?: string }> = [];
    for (const dirName of selected) {
      const tool = tools.find((t) => t.dirName === dirName);
      if (!tool) continue;
      const conflict = existingToolNames.has(tool.manifest.name);
      if (conflict) {
        imports.push({ dirName, targetName: `${tool.manifest.name}-imported` });
      } else {
        imports.push({ dirName });
      }
    }
    onImport(imports);
  }, [selected, tools, existingToolNames, onImport]);

  const selectedCount = selected.size;
  const shortPath = sourcePath.replace(/^.*\/([^/]+)$/, "$1");

  return createPortal(
    <div
      className="wc-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="wc-panel">
        <div className="wc-header">
          <div className="wc-header-text">
            <h2 className="wc-title">Import Tools</h2>
            <p className="wc-subtitle">from {shortPath}</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="wc-list">
          {tools.map((tool) => {
            const checked = selected.has(tool.dirName);
            const conflict = existingToolNames.has(tool.manifest.name);
            const edited = conflict && tool.manifest.edited;

            return (
              <div
                key={tool.dirName}
                className={`wc-row${!checked ? " wc-row--disabled" : ""}`}
                data-wc-row=""
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  className={`wc-checkbox${checked ? " wc-checkbox--checked" : ""}`}
                  onClick={() => toggle(tool.dirName)}
                >
                  {checked && <CheckIcon />}
                </button>

                <div className="wc-row-text">
                  <span className="wc-row-label">
                    {tool.manifest.display}
                    <span style={{ opacity: 0.5, fontWeight: 400, marginLeft: 6, fontSize: 10 }}>
                      v{tool.manifest.version}
                    </span>
                    {conflict && (
                      <span className="ti-conflict-badge">{edited ? "EDITED" : "EXISTS"}</span>
                    )}
                  </span>
                  <span className="wc-row-desc">
                    {tool.manifest.description}
                    <span className="ti-surface-pills">
                      {tool.manifest.surfaces.map((s) => (
                        <span key={s} className="ti-surface-pill">{SURFACE_LABELS[s] ?? s}</span>
                      ))}
                    </span>
                  </span>
                  {conflict && checked && (
                    <span className="ti-conflict-note">
                      {edited
                        ? `Will import as "${tool.manifest.name}-imported"`
                        : "Will replace existing tool"}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="wc-footer">
          <button type="button" className="wc-btn wc-btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="wc-btn wc-btn--primary"
            disabled={selectedCount === 0}
            onClick={handleImport}
          >
            Import{selectedCount > 0 ? ` (${selectedCount})` : ""}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export const ToolImportOverlay = memo(ToolImportOverlayInner);
