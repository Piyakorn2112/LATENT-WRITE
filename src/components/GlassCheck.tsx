import type { ReactNode } from "react";

interface Props {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Rendered beside the box. The whole thing is one label, so this is clickable. */
  children?: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
  /** Extra class on the wrapping label, for callers that lay rows out. */
  className?: string;
  /** Aligns the box with the FIRST LINE of a multi-line label instead of centring. */
  alignTop?: boolean;
}

/**
 * A small greyscale checkbox for lists.
 *
 * ★ WHY NOT GlassToggle: that is a 44px macOS switch with a painted-glass knob,
 *   a drag gesture and a press animation — right for one setting in a panel,
 *   absurd at 14px repeated down a scan list of forty names. A checkbox in a
 *   list is a tick, not a control.
 *
 * ★ WHY THE REAL INPUT IS STILL HERE, hidden rather than replaced by a div: it
 *   carries keyboard focus, space-to-toggle, the checked state for assistive
 *   tech, and label-click association, all of which have to be hand-built and
 *   kept correct otherwise. What is removed is the browser's PAINTING of it —
 *   `appearance: none` plus opacity 0 — which is the part that differs between
 *   platforms and refuses to take the app's greys. The visible box is the
 *   sibling span, drawn entirely by this app's CSS.
 */
export function GlassCheck({
  checked, onChange, children, ariaLabel, disabled, className, alignTop,
}: Props) {
  return (
    <label
      className={`glass-check${alignTop ? " glass-check--top" : ""}${disabled ? " glass-check--disabled" : ""}${className ? ` ${className}` : ""}`}
    >
      <input
        type="checkbox"
        className="glass-check-input"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="glass-check-box" aria-hidden="true">
        {/* Drawn, not a glyph: a font tick is a different shape and weight on
            every platform, which is the problem being solved. */}
        <svg viewBox="0 0 12 12" className="glass-check-tick" focusable="false">
          <path d="M2.5 6.2 L4.8 8.5 L9.5 3.6" />
        </svg>
      </span>
      {children != null && <span className="glass-check-label">{children}</span>}
    </label>
  );
}
