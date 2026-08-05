import { useEffect, useRef, useState } from "react";
import { KnobGlass } from "./KnobGlass";

const MIN_GLASS_ACTIVE_MS = 140;
const PRESS_ANIMATION_MS = 300;

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
 * ★ A NEW COMPONENT, NOT A WIDENED TOGGLE. It borrows GlassToggle's MOTION
 *   GRAMMAR — the same spring on the slide, the same press swell to scale(2)
 *   with the knob going translucent, the same minimum-glass-active dwell so a
 *   fast click still shows the material — and nothing else. A toggle is a
 *   binary with an implied "more is on"; this is three named states where the
 *   middle one is not half of anything, so it needs labels, a radiogroup role,
 *   and arrow keys, none of which a toggle has any business growing.
 *
 * ★★ THE LABELS ARE THE BACKDROP, AND THAT IS THE WHOLE EFFECT. Every label
 *    sits in the track and carries `glass-refract-text`, which KnobGlass reads
 *    from the live DOM and paints into its source buffer BEFORE the per-pixel
 *    resample. So on press the word under the knob is genuinely bent by the
 *    bevel — not a picture of a bent word, and not a duplicate kept in sync by
 *    hand. Slide the knob and the refraction follows the letterforms because
 *    it is reading them.
 *
 * ★ AND THE CURRENT LABEL IS LEGIBLE AT REST. At idle the knob is solid, which
 *   would bury the very label it is sitting on, so the knob carries its own
 *   copy in the inverse colour. On press that copy fades out as the knob turns
 *   translucent and the real one — refracted — takes over underneath. The
 *   reading is continuous: the word never disappears, it changes material.
 */
export function GlassModeSelector<T extends string>({
  value, options, onChange, ariaLabel,
}: Props<T>) {
  const [glassActive, setGlassActive] = useState(false);
  const [pressCycle, setPressCycle] = useState<"a" | "b">("a");
  const [pressAnimating, setPressAnimating] = useState(false);
  const [releaseCycle, setReleaseCycle] = useState<"a" | "b">("a");
  const [releaseAnimating, setReleaseAnimating] = useState(false);
  const glassActiveRef = useRef(false);
  const glassActivatedAtRef = useRef(0);
  const releaseTimerRef = useRef<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const current = options[index];
  const visualGlassActive = glassActive || pressAnimating || releaseAnimating;

  const clearReleaseTimer = () => {
    if (releaseTimerRef.current === null) return;
    window.clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = null;
  };

  const activateGlass = () => {
    clearReleaseTimer();
    glassActivatedAtRef.current = performance.now();
    glassActiveRef.current = true;
    setReleaseAnimating(false);
    setGlassActive(true);
    setPressAnimating(true);
    setPressCycle((p) => (p === "a" ? "b" : "a"));
  };

  const startRelease = () => {
    clearReleaseTimer();
    glassActiveRef.current = false;
    setGlassActive(false);
    setPressAnimating(false);
    setReleaseAnimating(true);
    setReleaseCycle((p) => (p === "a" ? "b" : "a"));
  };

  /**
   * ★ THE DWELL IS NOT DECORATION. A click can be shorter than the press
   *   animation, and releasing the glass immediately would show a frame of
   *   material and then snap — which reads as a glitch rather than a surface.
   *   Same rule and same constants as GlassToggle.
   */
  const releaseGlass = (immediate = false) => {
    clearReleaseTimer();
    if (immediate || !glassActiveRef.current) {
      if (visualGlassActive) startRelease();
      return;
    }
    const elapsed = performance.now() - glassActivatedAtRef.current;
    const remaining = Math.max(0, MIN_GLASS_ACTIVE_MS - elapsed, PRESS_ANIMATION_MS - elapsed);
    if (remaining === 0) { startRelease(); return; }
    releaseTimerRef.current = window.setTimeout(() => {
      releaseTimerRef.current = null;
      startRelease();
    }, remaining);
  };

  useEffect(() => clearReleaseTimer, []);

  const pick = (next: ModeOption<T>) => {
    if (next.disabled || next.value === value) return;
    onChange(next.value);
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
          pressAnimating ? `glass-mode--press-${pressCycle}` : "",
          releaseAnimating ? `glass-mode--release-${releaseCycle}` : "",
        ].filter(Boolean).join(" ")}
        style={{ "--mode-count": options.length, "--mode-index": index } as React.CSSProperties}
        onPointerDown={(e) => { if (e.button === 0) activateGlass(); }}
        onPointerUp={() => releaseGlass()}
        onPointerCancel={() => releaseGlass(true)}
        onPointerLeave={() => releaseGlass()}
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            disabled={o.disabled}
            title={o.title}
            className={`glass-mode-option${o.value === value ? " glass-mode-option--on" : ""}`}
            onClick={() => pick(o)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
              if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
              if (e.key === " " || e.key === "Enter") activateGlass();
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

        <span
          className={`glass-mode-knob${visualGlassActive ? " glass-mode-knob--painted" : ""}`}
          aria-hidden="true"
          onAnimationEnd={(e) => {
            if (e.animationName.startsWith("glass-mode-knob-press")) setPressAnimating(false);
            if (e.animationName.startsWith("glass-mode-knob-release")) setReleaseAnimating(false);
          }}
        >
          {/* The knob's own copy of the current word, so it stays readable
              while the knob is opaque. Fades out as the material comes up. */}
          <span className="glass-mode-knob-label">{current?.label}</span>
          <KnobGlass active={visualGlassActive} />
        </span>
      </div>
      {current?.note && <div className="glass-mode-note">{current.note}</div>}
    </div>
  );
}
