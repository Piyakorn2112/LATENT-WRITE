import { useCallback, useRef, useState } from "react";

interface Props {
  ratio: number;
  onRatioChange: (ratio: number) => void;
}

const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;

export function SplitDivider({ ratio, onRatioChange }: Props) {
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const container = e.currentTarget.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const next = Math.min(MAX_RATIO, Math.max(MIN_RATIO, x / rect.width));
    onRatioChange(next);
  }, [dragging, onRatioChange]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  }, []);

  const handleDoubleClick = useCallback(() => {
    onRatioChange(0.5);
  }, [onRatioChange]);

  return (
    <div
      ref={containerRef}
      className={`split-divider${dragging ? " split-divider--dragging" : ""}`}
      style={{ left: `${ratio * 100}%` }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(MIN_RATIO * 100)}
      aria-valuemax={Math.round(MAX_RATIO * 100)}
      aria-label="Split pane divider"
    />
  );
}
