import { memo, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Props {
  title: string;
  onClose: () => void;
  sidebar?: ReactNode;
  children: ReactNode;
}

function ToolOverlayInner({ title, onClose, sidebar, children }: Props) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return createPortal(
    <div
      className="wc-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="wc-panel tool-overlay-panel">
        <div className="wc-header">
          <div className="wc-header-text">
            <h2 className="wc-title">{title}</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        {sidebar ? (
          <div className="tool-overlay-body">
            <div className="tool-overlay-sidebar">{sidebar}</div>
            <div className="tool-overlay-main">{children}</div>
          </div>
        ) : (
          <div className="tool-overlay-main tool-overlay-main--full">{children}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export const ToolOverlay = memo(ToolOverlayInner);
