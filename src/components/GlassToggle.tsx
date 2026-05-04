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
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      type="button"
      className={`glass-toggle ${checked ? "glass-toggle--on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="glass-toggle-knob" />
    </button>
  );
}
