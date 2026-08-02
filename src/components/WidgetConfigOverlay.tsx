import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./Icon";
import {
  type WidgetConfig,
  type WidgetConfigEntry,
  type WidgetMeta,
  WIDGET_CONFIG_VERSION,
  getWidgetLabel,
  getWidgetDescription,
} from "../lib/widget-config";

interface Props {
  config: WidgetConfig;
  extraMetas?: WidgetMeta[];
  onSave: (next: WidgetConfig) => void;
  onClose: () => void;
}

function GripIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="5.5" cy="3.5" r="1.25" fill="currentColor" />
      <circle cx="10.5" cy="3.5" r="1.25" fill="currentColor" />
      <circle cx="5.5" cy="8" r="1.25" fill="currentColor" />
      <circle cx="10.5" cy="8" r="1.25" fill="currentColor" />
      <circle cx="5.5" cy="12.5" r="1.25" fill="currentColor" />
      <circle cx="10.5" cy="12.5" r="1.25" fill="currentColor" />
    </svg>
  );
}

function CheckIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 6.5L5 9L9.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WidgetConfigOverlayInner({ config, extraMetas = [], onSave, onClose }: Props) {
  const [order, setOrder] = useState<WidgetConfigEntry[]>(() => [...config.order]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dragStartY = useRef(0);
  const dragItemHeight = useRef(0);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const toggleEnabled = useCallback((id: string) => {
    setOrder((prev) =>
      prev.map((entry) =>
        entry.id === id ? { ...entry, enabled: !entry.enabled } : entry,
      ),
    );
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent, index: number) => {
    const target = e.currentTarget as HTMLElement;
    const row = target.closest("[data-wc-row]") as HTMLElement | null;
    if (!row) return;

    e.preventDefault();
    target.setPointerCapture(e.pointerId);
    dragStartY.current = e.clientY;
    dragItemHeight.current = row.offsetHeight;
    setDragIndex(index);
    setOverIndex(index);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (dragIndex === null) return;
    const delta = e.clientY - dragStartY.current;
    const steps = Math.round(delta / dragItemHeight.current);
    const clamped = Math.max(0, Math.min(order.length - 1, dragIndex + steps));
    setOverIndex(clamped);
  }, [dragIndex, order.length]);

  const handlePointerUp = useCallback(() => {
    if (dragIndex === null || overIndex === null || dragIndex === overIndex) {
      setDragIndex(null);
      setOverIndex(null);
      return;
    }

    setOrder((prev) => {
      const next = [...prev];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(overIndex, 0, moved);
      return next;
    });

    setDragIndex(null);
    setOverIndex(null);
  }, [dragIndex, overIndex]);

  const handleSave = useCallback(() => {
    onSave({ version: WIDGET_CONFIG_VERSION, order });
    onClose();
  }, [order, onSave, onClose]);

  const enabledCount = order.filter((e) => e.enabled).length;

  return createPortal(
    <div
      className="wc-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="wc-panel">
        <div className="wc-header">
          <div className="wc-header-text">
            <h2 className="wc-title">Edit Widgets</h2>
            <p className="wc-subtitle">{enabledCount} of {order.length} enabled</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="wc-list" ref={listRef}>
          {order.map((entry, index) => {
            const isDragging = dragIndex === index;
            const isDropTarget = overIndex === index && dragIndex !== null && dragIndex !== index;

            return (
              <div
                key={entry.id}
                className={`wc-row${isDragging ? " wc-row--dragging" : ""}${isDropTarget ? " wc-row--drop-target" : ""}${!entry.enabled ? " wc-row--disabled" : ""}`}
                data-wc-row=""
              >
                <div
                  className="wc-grip"
                  onPointerDown={(e) => handlePointerDown(e, index)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  aria-label={`Reorder ${getWidgetLabel(entry.id, extraMetas)}`}
                >
                  <GripIcon />
                </div>

                <button
                  type="button"
                  role="checkbox"
                  aria-checked={entry.enabled}
                  className={`wc-checkbox${entry.enabled ? " wc-checkbox--checked" : ""}`}
                  onClick={() => toggleEnabled(entry.id)}
                >
                  {entry.enabled && <CheckIcon />}
                </button>

                <div className="wc-row-text">
                  <span className="wc-row-label">{getWidgetLabel(entry.id, extraMetas)}</span>
                  <span className="wc-row-desc">{getWidgetDescription(entry.id, extraMetas)}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="wc-footer">
          <button type="button" className="wc-btn wc-btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="wc-btn wc-btn--primary" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export const WidgetConfigOverlay = memo(WidgetConfigOverlayInner);
