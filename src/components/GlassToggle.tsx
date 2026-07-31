import { useEffect, useRef, useState } from "react";

/** How long the pressed look is held even for an instant click, so a fast
 *  toggle still shows the knob lift instead of flickering. */
const MIN_PRESS_MS = 160;

interface Props {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Optional label rendered to the screen reader. */
  ariaLabel?: string;
}

/**
 * macOS-style glass toggle. The knob shares the same shape, specular border and
 * bounce easing as `.glass-range-knob` (see GlassRange), scaled up for a bigger
 * affordance and translated across a pill track instead of along a slider.
 *
 * Behaviour:
 *   • Click anywhere on the track → toggle. Drag across the midpoint → set.
 *   • Hover → knob nudges wider (matches macOS UIKit feel).
 *   • Press → knob lifts off the track, then settles back on release.
 *
 * ─── WHY THIS IS SO MUCH SMALLER THAN IT WAS ─────────────────────────────────
 *
 * The press/release used to be four @keyframes with `forwards`, alternating
 * `--press-a`/`--press-b` classes purely to force a restart, four pieces of
 * state (glassActive, pressAnimating, releaseAnimating, and two cycle flags)
 * and a timer that computed when the release was allowed to begin. That timer
 * expired on the same frame the press animation ended, so the two RACED, and
 * when the release won the knob snapped back to the release keyframe's opening
 * value before animating down. That snap is the "broken transition".
 *
 * The slider next door never had the problem because it never used animations:
 * it declares a target and lets a transition interrupt smoothly from whatever
 * the current computed value happens to be. This now does the same, so the only
 * state left is what genuinely cannot be expressed in CSS — the drag preview,
 * and holding the pressed look for a minimum time.
 */
export function GlassToggle({ checked, onChange, ariaLabel }: Props) {
  const [pressed, setPressed] = useState(false);
  const [dragPreview, setDragPreview] = useState<boolean | null>(null);
  const dragPreviewRef = useRef<boolean | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const pointerStartXRef = useRef(0);
  const dragMovedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const pressedAtRef = useRef(0);
  const releaseTimerRef = useRef<number | null>(null);

  const visualChecked = dragPreview ?? checked;

  const clearReleaseTimer = () => {
    if (releaseTimerRef.current === null) return;
    window.clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = null;
  };

  const press = () => {
    clearReleaseTimer();
    pressedAtRef.current = performance.now();
    setPressed(true);
  };

  /** Release, but never sooner than MIN_PRESS_MS after the press landed. */
  const release = (immediate = false) => {
    clearReleaseTimer();
    if (immediate) { setPressed(false); return; }
    const remaining = MIN_PRESS_MS - (performance.now() - pressedAtRef.current);
    if (remaining <= 0) { setPressed(false); return; }
    releaseTimerRef.current = window.setTimeout(() => {
      releaseTimerRef.current = null;
      setPressed(false);
    }, remaining);
  };

  const resetDrag = () => {
    dragPreviewRef.current = null;
    pointerIdRef.current = null;
    pointerStartXRef.current = 0;
    dragMovedRef.current = false;
    setDragPreview(null);
  };

  useEffect(() => clearReleaseTimer, []);

  return (
    <button
      role="switch"
      aria-checked={visualChecked}
      aria-label={ariaLabel}
      type="button"
      className={
        `glass-toggle${visualChecked ? " glass-toggle--on" : ""}` +
        `${pressed ? " glass-toggle--pressed" : ""}`
      }
      onClick={() => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        onChange(!checked);
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        pointerIdRef.current = e.pointerId;
        pointerStartXRef.current = e.clientX;
        dragMovedRef.current = false;
        dragPreviewRef.current = null;
        setDragPreview(null);
        suppressClickRef.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        press();
      }}
      onPointerMove={(e) => {
        if (pointerIdRef.current !== e.pointerId) return;
        const deltaX = e.clientX - pointerStartXRef.current;
        if (!dragMovedRef.current && Math.abs(deltaX) < 4) return;
        dragMovedRef.current = true;
        const rect = e.currentTarget.getBoundingClientRect();
        const nextPreview = e.clientX >= rect.left + rect.width / 2;
        dragPreviewRef.current = nextPreview;
        setDragPreview(nextPreview);
      }}
      onPointerUp={(e) => {
        if (pointerIdRef.current !== e.pointerId) { release(); return; }
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        const nextChecked = dragMovedRef.current
          ? (dragPreviewRef.current ?? checked)
          : !checked;
        resetDrag();
        release();
        if (nextChecked !== checked) onChange(nextChecked);
      }}
      onPointerCancel={(e) => {
        if (pointerIdRef.current === e.pointerId) {
          e.currentTarget.releasePointerCapture?.(e.pointerId);
        }
        resetDrag();
        suppressClickRef.current = false;
        release(true);
      }}
      onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") press(); }}
      onKeyUp={(e) => { if (e.key === " " || e.key === "Enter") release(); }}
      onBlur={() => {
        resetDrag();
        suppressClickRef.current = false;
        release(true);
      }}
    >
      {/* ★ The glass class is PERMANENT, not toggled on press.
          `liquid-glass-control-knob` is not decoration: liquid-glass-filter.ts
          watches class attributes across the document and, the moment it
          appears, registers the element, builds a displacement map, attaches an
          SVG filter and starts a ResizeObserver. Flipping it on pointerdown ran
          all of that on the first frame of the press — the other half of why
          this felt broken. Leaving it on costs one registration at mount (the
          map cache is keyed by size, so every knob in the app shares one) and is
          identical at rest, because the engine sets `backdrop-filter` and the
          resting fill is opaque white: there is nothing to see through. The
          glass appears only when the press makes the fill translucent, which is
          exactly the intent. */}
      <span className="glass-toggle-knob liquid-glass-control-knob" />
    </button>
  );
}
