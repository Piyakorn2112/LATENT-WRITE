import { useEffect, useState } from "react";

interface Props {
  /** Show the lens while a one-shot format pass runs. */
  active: boolean;
  /** Centre label, e.g. "Inserting scene breaks…". */
  label: string;
}

/**
 * A big, completely clear circle that sits over the editor scroll area —
 * in front of the text, behind the toolbar/panels — during the one-shot
 * format passes (auto-paragraph, scene-break). It carries no fill, border,
 * or blur of its own: the liquid-glass engine applies displacement-only
 * refraction (blur 0, see readBlur in liquid-glass-filter.ts), so the only
 * thing visible is the lens distortion of the text scrolling behind it.
 * The loading pill sits at the lens centre as the indicator.
 *
 * Mount/unmount is deferred so the fade-out can play; while mounted the
 * `data-liquid-glass-transient` attr makes the engine drop the generated
 * filter the moment the lens leaves the DOM.
 */
export function LoadingLens({ active, label }: Props) {
  const [mounted, setMounted] = useState(active);
  const [shown, setShown] = useState(false);
  const [displayLabel, setDisplayLabel] = useState(label);

  useEffect(() => {

  if (active) {

    setDisplayLabel(label);

    setMounted(true);

    let r1 = requestAnimationFrame(() => {

      let r2 = requestAnimationFrame(() => {

        setShown(true);

      });

      return () => cancelAnimationFrame(r2);

    });

    return () => cancelAnimationFrame(r1);

  }

  setShown(false);

  const t = window.setTimeout(() => setMounted(false), 380);

  return () => window.clearTimeout(t);

}, [active, label]);

  if (!mounted) return null;

  return (
    <div className={`loading-lens-shell${shown ? " loading-lens-shell--on" : ""}`} aria-hidden="true">
      <div className="liquid-glass-lens" data-liquid-glass-transient="true" />
      {/* Masks the editor text to the lens circle — fades to the page colour
          outside it, so the whole area reads as enclosed inside the bubble. */}
      <div className="loading-lens-fade" />
      {/* Soft backdrop-blur spot behind the loading text — its edge is
          feathered by a radial mask so the blur fades out softly. */}
      <div className="loading-lens-core" />
      <div className="liquid-glass-lens-edge" />
      <div
        className="loading-lens-pill status-pill  "
        data-liquid-glass-transient="true"
        role="status"
        aria-live="polite"
      >
        <span className="status-pill-spinner" aria-hidden="true" />
        <span className="status-pill-label">{displayLabel}</span>
      </div>
    </div>
  );
}
