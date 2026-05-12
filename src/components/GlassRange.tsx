import type { CSSProperties } from "react";

interface Props {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
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
 * div with the .liquid-glass class is the visual knob — it tracks the
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
  className = "",
  trackStyle,
  trackUnderlayStyle,
  fillStyle,
  showFill = true,
  ariaLabel,
}: Props) {
  const fraction = max === min ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));
  const wrapClassName = className ? `glass-range-wrap ${className}` : "glass-range-wrap";

  return (
    <div className={wrapClassName}>
      <div className="glass-range-track" style={trackStyle}>
        {trackUnderlayStyle && <div className="glass-range-underlay" style={trackUnderlayStyle} />}
        {showFill && <div className="glass-range-fill" style={{ width: `${fraction * 100}%`, ...fillStyle }} />}
        <div
          className="glass-range-knob"
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
      />
    </div>
  );
}
