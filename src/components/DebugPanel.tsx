/**
 * DebugPanel — what is actually governing attribution right now.
 *
 * ★ THIS PANEL USED TO REPORT A SYSTEM THAT NO LONGER RUNS. Its Learning and
 *   Bias sections showed blend ratios, cue weights, "bias leaders" and mean
 *   confidence from the adaptive ranker, all of which stopped reaching
 *   detection when corrections became pins (see annotation-pins.ts and
 *   scripts/probe-annotation-feedback.ts). A debug panel that reports dead
 *   machinery is worse than no panel — it invites you to explain a bug with a
 *   number that cannot cause it. Confidence in particular is gone from here:
 *   the base engine still computes a top-2 gap to decide what NEEDS REVIEW,
 *   and that count is shown, but there is no longer a learned confidence to
 *   average and nothing downstream consumes one.
 *
 *   What replaced it is the two things that DO decide behaviour: where your
 *   corrections landed, and where durable state is being written.
 */
import { useMemo } from "react";
import type { PinStats } from "../lib/annotation-pins";

interface Props {
  /** Spans in the current chapter the engine wants a human to look at. */
  reviewCount: number;
  speechReviewCount: number;
  actionReviewCount: number;
  speechPredictions: number;
  actionPredictions: number;
  /** Corrections across the whole book. */
  globalCorrectionCount: number;
  /** How this chapter's corrections resolved against the current text. */
  pins: PinStats;
  /** Analysis level actually in force, and the debounce behind it. */
  intelligenceLevel: string;
  typingSettleMs: number;
  /** "project" when a folder owns the state, "local" for an unsaved draft. */
  storageTarget: "project" | "local";
  /** Chapters with a stored timeline entry, i.e. what survives a reopen. */
  storedChapters: number;
  totalChapters: number;
}

export function DebugPanel({
  reviewCount,
  speechReviewCount,
  actionReviewCount,
  speechPredictions,
  actionPredictions,
  globalCorrectionCount,
  pins,
  intelligenceLevel,
  typingSettleMs,
  storageTarget,
  storedChapters,
  totalChapters,
}: Props) {
  const chapterSummary = useMemo(
    () => [
      { label: "Spans", value: speechPredictions + actionPredictions },
      { label: "Needs review", value: reviewCount },
      { label: "Pinned here", value: pins.total - pins.unresolved },
    ],
    [speechPredictions, actionPredictions, reviewCount, pins],
  );

  // ★ The pin line is the one that explains "my correction did not stick".
  //   `relocated` means the text moved and the pin followed it; `unresolved`
  //   means the sentence is gone, so the pin is deliberately applied nowhere
  //   rather than landing on a neighbour.
  const pinSummary = useMemo(
    () => [
      { label: "Corrections", value: globalCorrectionCount },
      { label: "On original", value: pins.atIndex },
      { label: "Re-located", value: pins.relocated },
      { label: "Text gone", value: pins.unresolved },
    ],
    [globalCorrectionCount, pins],
  );

  const taskSummary = useMemo(
    () => [
      { label: "Speech", predictions: speechPredictions, review: speechReviewCount },
      { label: "Action", predictions: actionPredictions, review: actionReviewCount },
    ],
    [speechPredictions, speechReviewCount, actionPredictions, actionReviewCount],
  );

  const storageLine = storageTarget === "project"
    ? `project folder · ${storedChapters}/${totalChapters} chapters stored`
    : `local draft · ${storedChapters}/${totalChapters} chapters stored · open a project to store alongside the manuscript`;

  return (
    <div className="debug-panel" aria-label="Attribution debug panel">
      <div className="debug-panel-head">
        <div className="debug-panel-head-copy">
          <span className="debug-panel-eyebrow">Debug</span>
          <span className="debug-panel-title">Attribution</span>
        </div>
        <span className="debug-panel-head-meta">
          {intelligenceLevel} · settle {typingSettleMs}ms
        </span>
      </div>

      <div className="debug-panel-section">
        <span className="debug-panel-section-label">This chapter</span>
        <div className="debug-panel-stats-grid">
          {chapterSummary.map((item) => (
            <span key={item.label} className="debug-panel-stat-card">
              <span className="debug-panel-stat-value">{item.value}</span>
              <span className="debug-panel-stat-caption">{item.label}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="debug-panel-section">
        <span className="debug-panel-section-label">Pins</span>
        <div className="debug-panel-stats-grid">
          {pinSummary.map((item) => (
            <span key={item.label} className="debug-panel-stat-card">
              <span className="debug-panel-stat-value">{item.value}</span>
              <span className="debug-panel-stat-caption">{item.label}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="debug-panel-task-grid">
        {taskSummary.map((task) => (
          <span key={task.label} className="debug-panel-task-card">
            <span className="debug-panel-task-head">
              <span className="debug-panel-task-name">{task.label}</span>
            </span>
            <span className="debug-panel-task-metrics">
              <span className="debug-panel-task-metric">
                <span className="debug-panel-task-num">{task.predictions}</span>
                <span className="debug-panel-task-meta">spans</span>
              </span>
              <span className="debug-panel-task-metric">
                <span className="debug-panel-task-num">{task.review}</span>
                <span className="debug-panel-task-meta">review</span>
              </span>
            </span>
          </span>
        ))}
      </div>

      <div className="debug-panel-summary">
        <span className="debug-panel-section-label">State</span>
        <span className="debug-panel-line">Saving to {storageLine}</span>
        <span className="debug-panel-line">
          Corrections pin their own span and do not steer detection
        </span>
      </div>
    </div>
  );
}
