import type { CSSProperties } from "react";

interface Props {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
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
export function GlassRange({ min, max, step, value, onChange }: Props) {
  const fraction = (value - min) / (max - min);

  return (
    <div className="glass-range-wrap">
      <div className="glass-range-track">
        <div className="glass-range-fill" style={{ width: `${fraction * 100}%` }} />
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
      />
    </div>
  );
}
