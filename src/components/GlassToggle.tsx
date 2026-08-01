import { useEffect, useRef, useState } from "react";

const MIN_GLASS_ACTIVE_MS = 140;
const PRESS_ANIMATION_MS = 300;

interface Props {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Optional label rendered to the screen reader. */
  ariaLabel?: string;
}

/**
 * macOS-style glass toggle. The knob shares the same shape, specular
 * border, and bounce easing as `.glass-range-knob` (see GlassRange) —
 * just scaled up for a bigger affordance, and translated horizontally
 * across a pill-shaped track instead of along a linear range.
 *
 * Behaviour:
 *   • Click anywhere on the track → toggle.
 *   • Hover → knob nudges 4px wider (matches macOS UIKit feel).
 *   • Active → knob stretches further (anticipation before the slide).
 *   • The track tints macOS green when on.
 *
 * Pure CSS transitions; no animation libs.
 */
export function GlassToggle({ checked, onChange, ariaLabel }: Props) {
  const [glassActive, setGlassActive] = useState(false);
  const [dragPreview, setDragPreview] = useState<boolean | null>(null);
  const [pressAnimationCycle, setPressAnimationCycle] = useState<"a" | "b">("a");
  const [pressAnimating, setPressAnimating] = useState(false);
  const [releaseAnimationCycle, setReleaseAnimationCycle] = useState<"a" | "b">("a");
  const [releaseAnimating, setReleaseAnimating] = useState(false);
  const dragPreviewRef = useRef<boolean | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const pointerStartXRef = useRef(0);
  const dragMovedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const glassActiveRef = useRef(false);
  const glassActivatedAtRef = useRef(0);
  const glassReleaseTimerRef = useRef<number | null>(null);

  const visualChecked = dragPreview ?? checked;
  const visualGlassActive = glassActive || pressAnimating || releaseAnimating;

  const clearGlassReleaseTimer = () => {
    if (glassReleaseTimerRef.current === null) return;
    window.clearTimeout(glassReleaseTimerRef.current);
    glassReleaseTimerRef.current = null;
  };

  const activateGlass = () => {
    clearGlassReleaseTimer();
    glassActivatedAtRef.current = performance.now();
    glassActiveRef.current = true;
    setReleaseAnimating(false);
    setGlassActive(true);
    setPressAnimating(true);
    setPressAnimationCycle((prev) => (prev === "a" ? "b" : "a"));
  };

  const startReleaseAnimation = () => {
    clearGlassReleaseTimer();
    glassActiveRef.current = false;
    setGlassActive(false);
    setPressAnimating(false);
    setReleaseAnimating(true);
    setReleaseAnimationCycle((prev) => (prev === "a" ? "b" : "a"));
  };

  const releaseGlass = (immediate = false) => {
    clearGlassReleaseTimer();
    if (immediate || !glassActiveRef.current) {
      if (visualGlassActive) startReleaseAnimation();
      return;
    }
    const elapsed = performance.now() - glassActivatedAtRef.current;
    const remaining = Math.max(0, MIN_GLASS_ACTIVE_MS - elapsed, PRESS_ANIMATION_MS - elapsed);
    if (remaining === 0) {
      startReleaseAnimation();
      return;
    }
    glassReleaseTimerRef.current = window.setTimeout(() => {
      glassReleaseTimerRef.current = null;
      startReleaseAnimation();
    }, remaining);
  };

  const resetDrag = () => {
    dragPreviewRef.current = null;
    pointerIdRef.current = null;
    pointerStartXRef.current = 0;
    dragMovedRef.current = false;
    setDragPreview(null);
  };

  useEffect(() => {
    return () => {
      clearGlassReleaseTimer();
    };
  }, []);

  return (
    <button
      role="switch"
      aria-checked={visualChecked}
      aria-label={ariaLabel}
      type="button"
      className={`glass-toggle ${visualChecked ? "glass-toggle--on" : ""} ${glassActive ? "glass-toggle--glass-active" : ""} ${pressAnimating ? `glass-toggle--press-${pressAnimationCycle}` : ""} ${releaseAnimating ? `glass-toggle--release-${releaseAnimationCycle}` : ""}`}
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
        if (e.currentTarget.closest(".settings-panel")) activateGlass();
      }}
      onPointerMove={(e) => {
        if (pointerIdRef.current !== e.pointerId) return;
        const deltaX = e.clientX - pointerStartXRef.current;
        if (!dragMovedRef.current && Math.abs(deltaX) < 4) return;
        dragMovedRef.current = true;
        const rect = e.currentTarget.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        const nextPreview = e.clientX >= midpoint;
        dragPreviewRef.current = nextPreview;
        setDragPreview(nextPreview);
      }}
      onPointerUp={(e) => {
        if (pointerIdRef.current !== e.pointerId) {
          releaseGlass();
          return;
        }
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        const nextChecked = dragMovedRef.current
          ? (dragPreviewRef.current ?? checked)
          : !checked;
        resetDrag();
        releaseGlass();
        if (nextChecked !== checked) onChange(nextChecked);
      }}
      onPointerCancel={(e) => {
        if (pointerIdRef.current === e.pointerId) {
          e.currentTarget.releasePointerCapture?.(e.pointerId);
        }
        resetDrag();
        suppressClickRef.current = false;
        releaseGlass(true);
      }}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && e.currentTarget.closest(".settings-panel")) {
          activateGlass();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") releaseGlass();
      }}
      onBlur={() => {
        resetDrag();
        suppressClickRef.current = false;
        releaseGlass(true);
      }}
    >
      <span
        className={visualGlassActive ? "glass-toggle-knob liquid-glass-control-knob" : "glass-toggle-knob"}
        onAnimationEnd={(e) => {
          if (e.animationName !== "glass-toggle-knob-press-a" && e.animationName !== "glass-toggle-knob-press-b") {
            if (e.animationName === "glass-toggle-knob-release-a" || e.animationName === "glass-toggle-knob-release-b") {
              setReleaseAnimating(false);
            }
            return;
          }
          setPressAnimating(false);
        }}
      />
    </button>
  );
}
