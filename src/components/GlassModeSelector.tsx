import { useEffect, useRef, useState } from "react";
import { KnobGlass } from "./KnobGlass";

/**
 * ★ THE CLICK DWELL. 140ms (the toggle's figure) was measured too short here:
 *   the swell itself takes 260ms, so on a plain click the canvas was unmounted
 *   before the knob ever reached full size and the refraction never visibly
 *   existed. 560 = the swell plus ~300ms of actually looking at the material.
 *   A slow press-and-hold is unaffected — the dwell only pads SHORT presses.
 */
const MIN_GLASS_ACTIVE_MS = 560;
/** Past this the pointer is dragging, not clicking. Same figure GlassToggle uses. */
const DRAG_SLOP_PX = 4;

export interface ModeOption<T extends string> {
  value: T;
  label: string;
  /** Offered but not selectable — the reason is shown, never a silent grey. */
  disabled?: boolean;
  /**
   * ★★ LOCKED IS NOT DISABLED, and the difference is the whole affordance. A
   *    `disabled` stop swallows the press, so the writer taps it, nothing
   *    happens, and the app has said nothing at all. A locked stop stays
   *    pressable, carries a PRO badge, and the CALLER refuses the change and
   *    explains why — the pattern the intelligence grid in AnalysisPanel
   *    already uses.
   */
  locked?: boolean;
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
  /**
   * ★★ REVIEW FINDING, AND THE CAUSE OF THE "STATES NOT SMOOTH" COMPLAINT:
   *    one flag drove BOTH the swell geometry and the material. When the dwell
   *    ended, the canvas unmounted and the solid label popped back on the SAME
   *    frame the 260ms shrink STARTED — a hard material pop mid-animation.
   *    The toggle never had this because its `releaseAnimating` state keeps
   *    the canvas mounted through the release. Same split here: geometry
   *    follows `glassActive`; the material follows `glassActive || releasing`,
   *    and the canvas repaints the shrinking knob each frame until the
   *    geometry has landed.
   */
  const [releasing, setReleasing] = useState(false);
  const releasingTimerRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const glassActiveRef = useRef(false);
  const glassActivatedAtRef = useRef(0);
  const releaseTimerRef = useRef<number | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const startXRef = useRef(0);
  const lastXRef = useRef(0);
  /**
   * ★ REVIEW FINDING: dragging centred the knob on the pointer, so a press on
   *   the knob's EDGE teleported it sideways the instant the slop was crossed
   *   (and the :active margin swap added 4px of its own). The grip offset —
   *   where inside the knob the finger landed — makes the first drag frame
   *   byte-identical to the resting position, which also lets `left` track the
   *   pointer with NO transition at all: nothing jumps, so nothing needs
   *   smoothing, and the knob is simply glued to the finger.
   */
  const grabOffsetRef = useRef(0);
  const movedRef = useRef(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLSpanElement>(null);

  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const current = options[index];

  /**
   * ★ THE DRAG POSITION GOES STRAIGHT TO A CSS VARIABLE, NOT THROUGH setState.
   *   A re-render per pointermove is jank waiting for a slower machine, and
   *   the knob's position during a drag is presentation, not state — nothing
   *   else needs to know it. React state changes only at the boundaries:
   *   drag started, drag ended.
   */
  const setDragLeft = (clientX: number) => {
    const track = trackRef.current, knob = knobRef.current;
    if (!track || !knob) return;
    const r = track.getBoundingClientRect();
    const kw = knob.getBoundingClientRect().width;
    const x = Math.min(r.width - kw + 2,
      Math.max(-2, clientX - grabOffsetRef.current - r.left - kw / 2));
    track.style.setProperty("--mode-drag-left", `${x.toFixed(1)}px`);
  };

  /** The knob's CENTRE picks the stop — not the pointer, which may be holding
   *  the knob by its edge. */
  const knobCentreX = (clientX: number) => clientX - grabOffsetRef.current;

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
    const finish = () => {
      glassActiveRef.current = false;
      setGlassActive(false);
      setReleasing(true);
      if (releasingTimerRef.current !== null) window.clearTimeout(releasingTimerRef.current);
      // The shrink transition is 260ms; the material rides it out, then hands
      // back to the solid knob and its label in the settled pose.
      releasingTimerRef.current = window.setTimeout(() => {
        releasingTimerRef.current = null;
        setReleasing(false);
      }, 280);
    };
    if (immediate || !glassActiveRef.current) { finish(); return; }
    const remaining = Math.max(0, MIN_GLASS_ACTIVE_MS - (performance.now() - glassActivatedAtRef.current));
    if (remaining === 0) { finish(); return; }
    releaseTimerRef.current = window.setTimeout(() => {
      releaseTimerRef.current = null;
      finish();
    }, remaining);
  };

  useEffect(() => () => {
    clearReleaseTimer();
    if (releasingTimerRef.current !== null) window.clearTimeout(releasingTimerRef.current);
  }, []);

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
          releasing ? "glass-mode--releasing" : "",
          dragging ? "glass-mode--dragging" : "",
        ].filter(Boolean).join(" ")}
        style={{ "--mode-count": options.length, "--mode-index": index } as React.CSSProperties}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          pointerIdRef.current = e.pointerId;
          startXRef.current = e.clientX;
          const kr = knobRef.current?.getBoundingClientRect();
          grabOffsetRef.current = kr && e.clientX >= kr.left && e.clientX <= kr.right
            ? e.clientX - (kr.left + kr.width / 2)
            : 0;
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
          lastXRef.current = e.clientX;
          if (!movedRef.current && Math.abs(e.clientX - startXRef.current) < DRAG_SLOP_PX) return;
          if (!movedRef.current) {
            movedRef.current = true;
            // Position BEFORE the class flips, or the knob spends one frame at
            // its old stop with the override already live.
            setDragLeft(e.clientX);
            setDragging(true);
            return;
          }
          setDragLeft(e.clientX);
        }}
        onPointerUp={(e) => {
          if (pointerIdRef.current !== e.pointerId) { releaseGlass(); return; }
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
          pointerIdRef.current = null;
          // A tap commits where it landed; a drag commits where the KNOB ended
          // (its centre tracks the pointer, so the last pointer X is the knob).
          commit(indexAt(movedRef.current ? knobCentreX(lastXRef.current) : e.clientX));
          movedRef.current = false;
          setDragging(false);
          // The override goes with the class in the same commit: the base rule
          // takes back `left`, and the spring carries the knob from wherever it
          // was dropped to its stop. That is the snap-on-release.
          trackRef.current?.style.removeProperty("--mode-drag-left");
          releaseGlass();
        }}
        onPointerCancel={(e) => {
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
          pointerIdRef.current = null;
          movedRef.current = false;
          setDragging(false);
          trackRef.current?.style.removeProperty("--mode-drag-left");
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
            {/* ★ NOT `glass-refract-text`. The badge must not be painted into
                the refraction buffer: the knob would then carry a PRO mark
                across every stop it slides over. */}
            {o.locked && <span className="glass-mode-lock" aria-label="Pro">PRO</span>}
          </button>
        ))}

        {/* ★ `--painted` while active, exactly as the toggle's knob: it clears
            the element's own fill so the canvas IS the surface — without it the
            knob's white sat on top of the material it was supposed to be. */}
        <span
          ref={knobRef}
          className={`glass-mode-knob${glassActive || releasing ? " glass-mode-knob--painted" : ""}`}
          aria-hidden="true"
        >
          <KnobGlass active={glassActive || releasing} />
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
