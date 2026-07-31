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
  // ★ The knob is still SHRINKING for ~280ms after the finger lifts, and the
  // glass has to survive that shrink or it pops off at the very moment the eye
  // is following the knob back down. The version this replaces got that right
  // by accident, via `glassActive || pressAnimating || releaseAnimating`; my
  // first rewrite dropped the class the instant `pressed` went false and broke
  // the tail of the expansion. `settling` is that tail, ended by the knob's own
  // transitionend rather than by a duration guessed here.
  const [settling, setSettling] = useState(false);
  const settleTimerRef = useRef<number | null>(null);
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

  const clearSettleTimer = () => {
    if (settleTimerRef.current === null) return;
    window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
  };

  const press = () => {
    clearReleaseTimer();
    clearSettleTimer();
    setSettling(false);
    pressedAtRef.current = performance.now();
    setPressed(true);
  };

  /** Begin the shrink: keep the glass on until the transform transition ends. */
  const beginSettle = () => {
    setPressed(false);
    setSettling(true);
    clearSettleTimer();
    // Safety net: if the knob was already at rest no transition runs and
    // transitionend never fires, which would strand the glass on forever.
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      setSettling(false);
    }, 420);
  };

  /** Release, but never sooner than MIN_PRESS_MS after the press landed. */
  const release = (immediate = false) => {
    clearReleaseTimer();
    if (immediate) { beginSettle(); return; }
    const remaining = MIN_PRESS_MS - (performance.now() - pressedAtRef.current);
    if (remaining <= 0) { beginSettle(); return; }
    releaseTimerRef.current = window.setTimeout(() => {
      releaseTimerRef.current = null;
      beginSettle();
    }, remaining);
  };

  const resetDrag = () => {
    dragPreviewRef.current = null;
    pointerIdRef.current = null;
    pointerStartXRef.current = 0;
    dragMovedRef.current = false;
    setDragPreview(null);
  };

  useEffect(() => () => { clearReleaseTimer(); clearSettleTimer(); }, []);

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
      {/* ★ GLASS ON PRESS ONLY — and REVERTING this is what fixed the feel.
          I briefly made the class permanent, reasoning that
          `liquid-glass-control-knob` makes liquid-glass-filter.ts register the
          element, build a displacement map and attach an SVG filter, and that
          doing so on pointerdown had to be the jank. That was a hypothesis I
          never measured, and it was wrong in the expensive direction: the class
          applies `backdrop-filter: url(#…)`, so leaving it on meant the knob
          carried a live displacement filter through every ON/OFF SLIDE as well,
          and a filtered element that MOVES must re-sample and re-filter its
          backdrop every frame. Registration is a one-off; per-frame refraction
          on a travelling element is not.
          The knob is opaque white at rest, so the glass is only ever visible
          while pressed — and a press does not move the knob. Attaching it for
          exactly that moment is both the cheapest and the original design. */}
      <span
        className={pressed || settling ? "glass-toggle-knob liquid-glass-control-knob" : "glass-toggle-knob"}
        onTransitionEnd={(e) => {
          // Only the scale tail decides; `left` and `background` finish on
          // their own schedules and must not cut the glass short.
          if (e.propertyName === "transform") { clearSettleTimer(); setSettling(false); }
        }}
      />
    </button>
  );
}
