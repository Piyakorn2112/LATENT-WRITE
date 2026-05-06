import { useEffect, useState } from "react";

export interface StatusTask {
  /** What the system is doing — short label rendered in the pill. */
  label: string;
  /** Internal kind used for keying the animation when the message changes. */
  kind: string;
}

interface Props {
  task: StatusTask | null;
}

/**
 * Floating pill below the toolbar that announces the current background task
 * (analysing, renaming, etc). Animates in with the same reveal motion as the
 * widgets and exits with a soft fade.
 */
export function StatusPill({ task }: Props) {
  // Keep the last task visible during the exit animation so the pill doesn't
  // pop. `displayed` is what's rendered, `phase` controls enter/exit class.
  const [displayed, setDisplayed] = useState<StatusTask | null>(task);
  const [phase, setPhase] = useState<"enter" | "exit" | "hidden">(task ? "enter" : "hidden");

  useEffect(() => {
    if (task) {
      setDisplayed(task);
      setPhase("enter");
      return;
    }
    // Exit only if currently shown
    if (displayed) {
      setPhase("exit");
      const t = window.setTimeout(() => {
        setPhase("hidden");
        setDisplayed(null);
      }, 280);
      return () => window.clearTimeout(t);
    }
  }, [task, displayed]);

  if (phase === "hidden" || !displayed) return null;

  return (
    <div className="status-pill-shell">
      <div
        className={`status-pill liquid-glass status-pill--${phase} status-pill--${displayed.kind}`}
        key={displayed.kind}
        role="status"
        aria-live="polite"
      >
        <span className="status-pill-spinner" aria-hidden="true" />
        <span className="status-pill-label">{displayed.label}</span>
      </div>
    </div>
  );
}
