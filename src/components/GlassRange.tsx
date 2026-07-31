import { useEffect, useState, type CSSProperties } from "react";

interface Props {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  enableGlass?: boolean;
  className?: string;
  trackStyle?: CSSProperties;
  trackUnderlayStyle?: CSSProperties;
  fillStyle?: CSSProperties;
  showFill?: boolean;
  ariaLabel?: string;
}

/**
 * Custom range slider with a liquid-glass knob.
 *
 * The native <input type="range"> is overlaid at full opacity-0 so all
 * keyboard/pointer interaction falls through to it naturally. A positioned
 * div with a dedicated control-glass activation class is the visual knob — it tracks the
 * current value via a CSS custom property fed into calc().
 *
 * backdrop-filter on ::-webkit-slider-thumb is silently ignored by Chromium;
 * this component works around that constraint entirely.
 */
export function GlassRange({
  min,
  max,
  step,
  value,
  onChange,
  enableGlass = false,
  className = "",
  trackStyle,
  trackUnderlayStyle,
  fillStyle,
  showFill = true,
  ariaLabel,
}: Props) {
  const [glassActive, setGlassActive] = useState(false);

  useEffect(() => {
    if (!glassActive) return;
    const reset = () => setGlassActive(false);
    window.addEventListener("pointerup", reset);
    window.addEventListener("pointercancel", reset);
    return () => {
      window.removeEventListener("pointerup", reset);
      window.removeEventListener("pointercancel", reset);
    };
  }, [glassActive]);

  const fraction = max === min ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));
  const wrapClassName = className ? `glass-range-wrap ${className}` : "glass-range-wrap";
  // ★ Glass while dragging only. See the note in GlassToggle: making this class
  // permanent looked like it would avoid registration work on pointerdown, but
  // the class applies `backdrop-filter: url(#…)`, so an always-on knob carries a
  // live displacement filter every frame it moves. Registration is a one-off;
  // per-frame refraction on a moving element is not.
  const knobClassName = glassActive ? "glass-range-knob liquid-glass-control-knob" : "glass-range-knob";

  return (
    <div className={wrapClassName}>
      <div className="glass-range-track" style={trackStyle}>
        {trackUnderlayStyle && <div className="glass-range-underlay" style={trackUnderlayStyle} />}
        {showFill && <div className="glass-range-fill" style={{ width: `${fraction * 100}%`, ...fillStyle }} />}
        <div
          className={knobClassName}
          style={{ "--glass-range-frac": String(fraction) } as CSSProperties}
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="glass-range-input"
        aria-label={ariaLabel}
        onPointerDown={(e) => {
          if (enableGlass || e.currentTarget.closest(".settings-panel")) setGlassActive(true);
        }}
        onPointerUp={() => setGlassActive(false)}
        onPointerCancel={() => setGlassActive(false)}
        onBlur={() => setGlassActive(false)}
      />
    </div>
  );
}
