import { useEffect, useRef, useState } from "react";
import { KnobGlass } from "./KnobGlass";

const MIN_GLASS_ACTIVE_MS = 140;
/** Past this the pointer is dragging, not clicking. Same figure GlassToggle uses. */
const DRAG_SLOP_PX = 4;

export interface ModeOption<T extends string> {
  value: T;
  label: string;
  /** Offered but not selectable — the reason is shown, never a silent grey. */
  disabled?: boolean;
  /** One line under the track when this option is current. */
  note?: string;
  title?: string;
}

interface Props<T extends string> {
  value: T;
  options: ReadonlyArray<ModeOption<T>>;
  onChange: (next: T) => void;
  ariaLabel?: string;
}

/**
 * GlassModeSelector — a three-stop track with a glass knob.
 *
 * ★ A NEW COMPONENT, NOT A WIDENED TOGGLE, but it borrows GlassToggle's whole
 *   INTERACTION grammar: pointer capture, a slop threshold before a press
 *   becomes a drag, a live preview that follows the finger, a minimum
 *   glass-active dwell so a fast click still shows the material, and commit on
 *   release. What it does not borrow is `transform: scale()` — see the CSS.
 *
 * ★★ THE KNOB IS DRAGGABLE, AND THE DRAG IS THE POINT. A three-stop control
 *    that can only be clicked is three buttons wearing a knob. Pointer capture
 *    is what makes it work off the edge of the track: without it the drag dies
 *    the moment the finger leaves the 30px-tall strip, which on a real pointer
 *    is immediately.
 *
 * ★★ ONE COMMIT PATH. The options are real radios for keyboard and assistive
 *    tech, but they carry no click handler — every pointer commit happens on
 *    the track's pointerup, from the stop under the pointer. Two commit paths
 *    is how a drag that ends over one option fires the click of another.
 */
export function GlassModeSelector<T extends string>({
  value, options, onChange, ariaLabel,
}: Props<T>) {
  const [glassActive, setGlassActive] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const glassActiveRef = useRef(false);
  const glassActivatedAtRef = useRef(0);
  const releaseTimerRef = useRef<number | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const startXRef = useRef(0);
  const movedRef = useRef(false);
  const trackRef = useRef<HTMLDivElement>(null);

  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const shownIndex = dragIndex ?? index;
  const current = options[shownIndex];

  const clearReleaseTimer = () => {
    if (releaseTimerRef.current === null) return;
    window.clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = null;
  };

  const activateGlass = () => {
    clearReleaseTimer();
    glassActivatedAtRef.current = performance.now();
    glassActiveRef.current = true;
    setGlassActive(true);
  };

  /** ★ The dwell: a click can be shorter than the swell, and releasing the
   *  material immediately reads as a glitch rather than a surface. */
  const releaseGlass = (immediate = false) => {
    clearReleaseTimer();
    const finish = () => { glassActiveRef.current = false; setGlassActive(false); };
    if (immediate || !glassActiveRef.current) { finish(); return; }
    const remaining = Math.max(0, MIN_GLASS_ACTIVE_MS - (performance.now() - glassActivatedAtRef.current));
    if (remaining === 0) { finish(); return; }
    releaseTimerRef.current = window.setTimeout(() => {
      releaseTimerRef.current = null;
      finish();
    }, remaining);
  };

  useEffect(() => clearReleaseTimer, []);

  /** Which stop is under this client X? Clamped, so a drag past either end
   *  parks on the end rather than doing nothing. */
  const indexAt = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return index;
    const r = el.getBoundingClientRect();
    const inner = r.width - 4;
    if (inner <= 0) return index;
    const frac = (clientX - (r.left + 2)) / inner;
    return Math.min(options.length - 1, Math.max(0, Math.floor(frac * options.length)));
  };

  /** ★ A disabled stop is never landed on. The nearest enabled one below it is
   *  taken instead, so dragging across a greyed option feels like it is simply
   *  not there rather than like the control has stuck. */
  const nearestEnabled = (want: number): number => {
    if (!options[want]?.disabled) return want;
    for (let d = 1; d < options.length; d += 1) {
      if (!options[want - d]?.disabled && want - d >= 0) return want - d;
      if (!options[want + d]?.disabled && want + d < options.length) return want + d;
    }
    return index;
  };

  const commit = (i: number) => {
    const next = options[nearestEnabled(i)];
    if (next && !next.disabled && next.value !== value) onChange(next.value);
  };

  const move = (delta: number) => {
    for (let i = index + delta; i >= 0 && i < options.length; i += delta) {
      if (!options[i].disabled) { onChange(options[i].value); return; }
    }
  };

  return (
    <div className="glass-mode-wrap">
      <div
        ref={trackRef}
        role="radiogroup"
        aria-label={ariaLabel}
        className={[
          "glass-mode",
          glassActive ? "glass-mode--glass-active" : "",
          dragIndex !== null ? "glass-mode--dragging" : "",
        ].filter(Boolean).join(" ")}
        style={{ "--mode-count": options.length, "--mode-index": shownIndex } as React.CSSProperties}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          pointerIdRef.current = e.pointerId;
          startXRef.current = e.clientX;
          movedRef.current = false;
          // ★ Capture, or the drag dies the instant the finger leaves a 30px
          //   strip. It THROWS when the pointer is not active (a synthetic
          //   event, a pointer already released) — and an exception here would
          //   abort the handler and leave the control dead for that press, so
          //   the drag must survive capture being unavailable.
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no capture */ }
          activateGlass();
        }}
        onPointerMove={(e) => {
          if (pointerIdRef.current !== e.pointerId) return;
          if (!movedRef.current && Math.abs(e.clientX - startXRef.current) < DRAG_SLOP_PX) return;
          movedRef.current = true;
          const at = nearestEnabled(indexAt(e.clientX));
          setDragIndex((prev) => (prev === at ? prev : at));
        }}
        onPointerUp={(e) => {
          if (pointerIdRef.current !== e.pointerId) { releaseGlass(); return; }
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
          pointerIdRef.current = null;
          // A tap commits where it landed; a drag commits where it ended.
          commit(movedRef.current ? (dragIndex ?? index) : indexAt(e.clientX));
          movedRef.current = false;
          setDragIndex(null);
          releaseGlass();
        }}
        onPointerCancel={(e) => {
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
          pointerIdRef.current = null;
          movedRef.current = false;
          setDragIndex(null);
          releaseGlass(true);
        }}
      >
        {options.map((o, i) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            disabled={o.disabled}
            title={o.title}
            tabIndex={i === index ? 0 : -1}
            className={`glass-mode-option${o.value === value ? " glass-mode-option--on" : ""}`}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
              if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
              if (e.key === " " || e.key === "Enter") { e.preventDefault(); activateGlass(); commit(i); }
            }}
            onKeyUp={(e) => { if (e.key === " " || e.key === "Enter") releaseGlass(); }}
            onBlur={() => releaseGlass(true)}
          >
            {/* ★ `glass-refract-text` is the contract with KnobGlass: it reads
                these from the live DOM, with their real font and colour, and
                paints them into the buffer it then refracts. */}
            <span className="glass-mode-label glass-refract-text">{o.label}</span>
          </button>
        ))}

        <span className="glass-mode-knob" aria-hidden="true">
          <KnobGlass active={glassActive} />
        </span>
        {/* Sibling, not child: the knob's growth cannot reach the type. */}
        <span className="glass-mode-knob-cap" aria-hidden="true">
          <span className="glass-mode-knob-label">{current?.label}</span>
        </span>
      </div>
      {current?.note && <div className="glass-mode-note">{current.note}</div>}
    </div>
  );
}
