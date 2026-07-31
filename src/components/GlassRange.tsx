import type { CSSProperties } from "react";

interface Props {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  /** Kept for API compatibility. The knob's glass is now always registered
   *  (see knobClassName below), so this no longer gates anything. */
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
  enableGlass: _enableGlass = false,
  className = "",
  trackStyle,
  trackUnderlayStyle,
  fillStyle,
  showFill = true,
  ariaLabel,
}: Props) {
  void _enableGlass;

  const fraction = max === min ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));
  const wrapClassName = className ? `glass-range-wrap ${className}` : "glass-range-wrap";
  // ★ The glass class is PERMANENT. `liquid-glass-control-knob` registers the
  // element with liquid-glass-filter.ts, which watches class attributes on the
  // whole document: adding it on pointerdown built a displacement map, attached
  // an SVG filter and started a ResizeObserver on the first frame of the drag,
  // which is exactly when the knob is supposed to be moving smoothly. Registered
  // once at mount instead. Resting appearance is unchanged because the engine
  // sets `backdrop-filter` and the knob's resting fill is opaque white; the
  // glass only shows once the press turns the fill translucent.
  const knobClassName = "glass-range-knob liquid-glass-control-knob";

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
      />
    </div>
  );
}
