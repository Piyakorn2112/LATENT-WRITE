import { useMemo } from "react";
import { LEARN_THRESHOLD } from "../lib/annotation-learn";
import type { AdaptiveLearningMetrics, LearnedBias } from "../types";

interface Props {
  reviewCount: number;
  speechReviewCount: number;
  actionReviewCount: number;
  speechPredictions: number;
  actionPredictions: number;
  metrics: AdaptiveLearningMetrics;
  learnedBias: LearnedBias | null;
  globalCorrectionCount: number;
  typingSettleMs: number;
  modelSamples: {
    speech: number;
    action: number;
  };
}

export function DebugPanel({
  reviewCount,
  speechReviewCount,
  actionReviewCount,
  speechPredictions,
  actionPredictions,
  metrics,
  learnedBias,
  globalCorrectionCount,
  typingSettleMs,
  modelSamples,
}: Props) {
  const derived = useMemo(() => {
    const chapterPredictions = speechPredictions + actionPredictions;
    const annotationPredictions = metrics.byTask.speech.predictions + metrics.byTask.action.predictions;
    const annotationLabeled = metrics.byTask.speech.labeled + metrics.byTask.action.labeled;
    const annotationCorrected = metrics.byTask.speech.corrected + metrics.byTask.action.corrected;
    const annotationConfidence = annotationPredictions > 0
      ? (
          metrics.byTask.speech.meanConfidence * metrics.byTask.speech.predictions +
          metrics.byTask.action.meanConfidence * metrics.byTask.action.predictions
        ) / annotationPredictions
      : 0;
    const autoMatchPct = annotationLabeled > 0
      ? Math.round((1 - annotationCorrected / Math.max(1, annotationLabeled)) * 100)
      : null;
    const meanConfidencePct = Math.round(annotationConfidence * 100);
    const nearbyPct = learnedBias ? Math.round(learnedBias.scope.localBlend * 100) : 0;
    const cueLine = learnedBias
      ? `lead ${Math.round(learnedBias.contextCueWeights.beforeName * 100)}% · trail ${Math.round(learnedBias.contextCueWeights.afterName * 100)}% · surround ${Math.round(learnedBias.contextCueWeights.surroundingName * 100)}% · carry ${Math.round(learnedBias.contextCueWeights.previousSpeakerCarry * 100)}%`
      : "calibrating from confirmed corrections";
    const blendLine = learnedBias
      ? `nearby ${nearbyPct}% / global ${100 - nearbyPct}% · ${learnedBias.scope.effectiveChapterCount} chapter patch · ${learnedBias.scope.localWeightedSamples} weighted samples`
      : `warm-up ${Math.min(globalCorrectionCount, LEARN_THRESHOLD)}/${LEARN_THRESHOLD} corrections before learned bias turns on`;
    const biasLine = learnedBias?.scope.topSpeakers.length
      ? learnedBias.scope.topSpeakers
          .slice(0, 3)
          .map((speaker) => `${speaker.name} ${speaker.blendedWeight.toFixed(1)}`)
          .join(" · ")
      : null;
    return {
      chapterPredictions,
      annotationLabeled,
      autoMatchPct,
      meanConfidencePct,
      cueLine,
      blendLine,
      biasLine,
    };
  }, [speechPredictions, actionPredictions, metrics, learnedBias, globalCorrectionCount]);

  const chapterSummary = useMemo(
    () => [
      { label: "Current spans", value: derived.chapterPredictions },
      { label: "Needs review", value: reviewCount },
    ],
    [derived.chapterPredictions, reviewCount],
  );

  const learningSummary = useMemo(
    () => [
      { label: "Corrections", value: globalCorrectionCount },
      { label: "Labeled", value: derived.annotationLabeled },
      { label: "Auto-match", value: derived.autoMatchPct == null ? "—" : `${derived.autoMatchPct}%` },
      { label: "Mean conf", value: `${derived.meanConfidencePct}%` },
    ],
    [globalCorrectionCount, derived.annotationLabeled, derived.autoMatchPct, derived.meanConfidencePct],
  );

  const taskSummary = useMemo(
    () => [
      {
        label: "Speech",
        predictions: speechPredictions,
        review: speechReviewCount,
        confidence: Math.round(metrics.byTask.speech.meanConfidence * 100),
        samples: modelSamples.speech,
      },
      {
        label: "Action",
        predictions: actionPredictions,
        review: actionReviewCount,
        confidence: Math.round(metrics.byTask.action.meanConfidence * 100),
        samples: modelSamples.action,
      },
    ],
    [speechPredictions, speechReviewCount, actionPredictions, actionReviewCount, metrics, modelSamples],
  );

  return (
    <div className="debug-panel" aria-label="Adaptive system debug panel">
      <div className="debug-panel-head">
        <div className="debug-panel-head-copy">
          <span className="debug-panel-eyebrow">Debug</span>
          <span className="debug-panel-title">Annotation Engine</span>
        </div>
        <span className="debug-panel-head-meta">
          settle {typingSettleMs}ms
        </span>
      </div>

      <div className="debug-panel-section">
        <span className="debug-panel-section-label">Chapter</span>
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
        <span className="debug-panel-section-label">Learning</span>
        <div className="debug-panel-stats-grid">
          {learningSummary.map((item) => (
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
              <span className="debug-panel-task-chip">{task.samples} samples</span>
            </span>
            <span className="debug-panel-task-metrics">
              <span className="debug-panel-task-metric">
                <span className="debug-panel-task-num">{task.predictions}</span>
                <span className="debug-panel-task-meta">current</span>
              </span>
              <span className="debug-panel-task-metric">
                <span className="debug-panel-task-num">{task.review}</span>
                <span className="debug-panel-task-meta">review</span>
              </span>
              <span className="debug-panel-task-metric">
                <span className="debug-panel-task-num">{task.confidence}%</span>
                <span className="debug-panel-task-meta">conf</span>
              </span>
            </span>
          </span>
        ))}
      </div>

      <div className="debug-panel-summary">
        <span className="debug-panel-section-label">Bias</span>
        <span className="debug-panel-line">Blend {derived.blendLine}</span>
        <span className="debug-panel-line">Clues {derived.cueLine}</span>
        {derived.biasLine && <span className="debug-panel-line">Bias leaders {derived.biasLine}</span>}
      </div>
    </div>
  );
}