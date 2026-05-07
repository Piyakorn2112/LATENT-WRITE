import { useMemo } from "react";
import type { AdaptiveLearningMetrics } from "../types";

interface Props {
  reviewCount: number;
  speechPredictions: number;
  actionPredictions: number;
  metrics: AdaptiveLearningMetrics;
  modelSamples: {
    speech: number;
    action: number;
    entity: number;
  };
}

export function DebugPanel({
  reviewCount,
  speechPredictions,
  actionPredictions,
  metrics,
  modelSamples,
}: Props) {
  const derived = useMemo(() => {
    const chapterPredictions = speechPredictions + actionPredictions;
    const autoMatchPct = metrics.labeled > 0
      ? Math.round((1 - metrics.corrected / Math.max(1, metrics.labeled)) * 100)
      : null;
    const meanConfidencePct = Math.round(metrics.meanConfidence * 100);
    return { chapterPredictions, autoMatchPct, meanConfidencePct };
  }, [speechPredictions, actionPredictions, metrics]);

  return (
    <div className="debug-panel" aria-label="Adaptive system debug panel">
      <div className="debug-panel-head">
        <span className="debug-panel-eyebrow">Debug</span>
        <span className="debug-panel-head-meta">
          {derived.chapterPredictions} span{derived.chapterPredictions !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="debug-panel-stats">
        <span className="debug-panel-stat">
          <span className="debug-panel-num">{reviewCount}</span>
          <span className="debug-panel-label">review</span>
        </span>
        <span className="debug-panel-divider" />
        <span className="debug-panel-stat">
          <span className="debug-panel-num">{metrics.labeled}</span>
          <span className="debug-panel-label">labeled</span>
        </span>
        <span className="debug-panel-divider" />
        <span className="debug-panel-stat">
          <span className="debug-panel-num">
            {derived.autoMatchPct == null ? "—" : `${derived.autoMatchPct}%`}
          </span>
          <span className="debug-panel-label">auto</span>
        </span>
        <span className="debug-panel-divider" />
        <span className="debug-panel-stat">
          <span className="debug-panel-num">{derived.meanConfidencePct}%</span>
          <span className="debug-panel-label">conf</span>
        </span>
      </div>

      <div className="debug-panel-models">
        <span className="debug-panel-model-pill">S {modelSamples.speech}</span>
        <span className="debug-panel-model-pill">A {modelSamples.action}</span>
        <span className="debug-panel-model-pill">E {modelSamples.entity}</span>
      </div>
    </div>
  );
}