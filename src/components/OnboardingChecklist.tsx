import { useEffect, useState, useSyncExternalStore } from "react";
import { ChevronRight, CloseIcon, SparklesIcon } from "./Icon";
import {
  onbChecklist,
  onbHappened,
  onbSnapshot,
  onbSubscribe,
  recordOnb,
} from "../lib/onboarding-log";

/**
 * The getting-started dock — the corner the first session lives in after the
 * welcome screen closes.
 *
 * ★ FOUR ITEMS, ONE ALREADY DONE. The benchmark literature is unambiguous:
 *   checklist completion falls off a cliff past five items, and a list that
 *   starts partway finished nearly doubles completion for identical effort
 *   (endowed progress, a field experiment, not a hunch). Item one is
 *   credited for real work — choosing any door IS opening a story.
 *
 * ★ NEVER A MODAL, NEVER A NAG. It collapses to a count, closes for good
 *   from its own X, and comes back only if the writer asks (Help menu).
 *   Progressive disclosure: only the first unfinished item shows its hint,
 *   so the card reads as one next step, not a syllabus.
 *
 * ★ THE SANDBOX BADGE IS SEPARATE AND UNCONDITIONAL. While the sample is
 *   open the writer must always be able to see that nothing saves here and
 *   always have the way out — those two facts cannot depend on whether a
 *   checklist was dismissed.
 */

export function SampleBadge({
  onResetSample,
  onStartOwn,
}: {
  onResetSample: () => void;
  onStartOwn: () => void;
}) {
  return (
    <div className="gs-sample liquid-glass" role="note" aria-label="Sample story is open">
      <span className="gs-sample-line">
        <span className="gs-sample-name">Sample story</span>
        <span className="gs-sample-fact">nothing here saves</span>
      </span>
      <span className="gs-sample-actions">
        <button type="button" className="gs-sample-btn" onClick={onResetSample}>
          Reset
        </button>
        <button type="button" className="gs-sample-btn gs-sample-btn--primary" onClick={onStartOwn}>
          Start your own
        </button>
      </span>
    </div>
  );
}

interface ChecklistProps {
  /** Max tier is live right now — the one-time gesture line is shown until
   *  the gesture has actually been tried (tracked exploration, not a tour). */
  maxReady: boolean;
  /** Permanent dismissal — the writer owns it; Help re-summons. */
  onHide: () => void;
}

export function OnboardingChecklist({ maxReady, onHide }: ChecklistProps) {
  useSyncExternalStore(onbSubscribe, onbSnapshot);
  const items = onbChecklist();
  const doneCount = items.filter((i) => i.done).length;
  const allDone = doneCount === items.length;
  const firstOpen = items.find((i) => !i.done)?.id ?? null;
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (allDone) recordOnb("checklist-done");
  }, [allDone]);

  const showMaxHint = maxReady && !onbHappened("ask-used");
  useEffect(() => {
    if (showMaxHint) recordOnb("max-hint-shown");
  }, [showMaxHint]);

  // The dock earns its corner only once a story is open; before the first
  // door there is nothing to get started IN.
  if (!items[0].done) return null;

  if (collapsed) {
    return (
      <button
        type="button"
        className="gs-pill liquid-glass"
        onClick={() => setCollapsed(false)}
        aria-label={`Getting started, ${doneCount} of ${items.length} done`}
      >
        <span className="gs-pill-count">{doneCount}/{items.length}</span>
        <span className="gs-pill-label">getting started</span>
      </button>
    );
  }

  if (allDone) {
    return (
      <div className="gs-card liquid-glass" role="note" aria-label="First session complete">
        <div className="gs-head">
          <span className="gs-title">You're set</span>
        </div>
        <p className="gs-recap">
          Story opened, the reader observed, a sentence changed, your own book
          begun. Everything else lives in the panels, and this card retires.
        </p>
        <button
          type="button"
          className="gs-done-btn"
          onClick={() => {
            recordOnb("recap-seen");
            onHide();
          }}
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="gs-card liquid-glass" role="note" aria-label="Getting started checklist">
      <div className="gs-head">
        <span className="gs-title">Getting started</span>
        <span className="gs-count">{doneCount} of {items.length}</span>
        <button
          type="button"
          className="gs-icon-btn"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse"
          title="Collapse"
        >
          <ChevronRight size={13} className="gs-collapse-chevron" />
        </button>
        <button
          type="button"
          className="gs-icon-btn"
          onClick={() => {
            recordOnb("checklist-hidden");
            onHide();
          }}
          aria-label="Hide checklist"
          title="Hide (re-open from Help)"
        >
          <CloseIcon size={12} />
        </button>
      </div>
      <div className="gs-items">
        {items.map((item) => (
          <div key={item.id} className={`gs-item${item.done ? " gs-item--done" : ""}`}>
            <span className="gs-tick" aria-hidden="true">
              {item.done && (
                <svg viewBox="0 0 10 10" width="8" height="8">
                  <path d="M1.5 5.5l2.4 2.3L8.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
            <span className="gs-item-text">
              {item.label}
              {item.id === firstOpen && (
                <span className="gs-item-hint">{item.hint}</span>
              )}
            </span>
          </div>
        ))}
      </div>
      {showMaxHint && (
        <div className="gs-max-hint">
          <SparklesIcon size={12} />
          <span>Max is on. Right-click any paragraph to ask about it.</span>
        </div>
      )}
    </div>
  );
}
