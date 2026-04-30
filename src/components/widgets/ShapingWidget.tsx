import type { ChapterAnalysis } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";

export function ShapingWidget({ analysis }: { analysis: ChapterAnalysis }) {
  const hi = analysis.highModeAnalysis;
  if (!hi) return null;

  const { shapingSuggestion, intentOutcome, narrativeMomentum, peakTrace } = hi;
  const noteLines: string[] = [];
  if (peakTrace?.description) noteLines.push(peakTrace.description);
  if (intentOutcome && intentOutcome.type !== "matched") noteLines.push(intentOutcome.message);
  if (narrativeMomentum?.note) noteLines.push(narrativeMomentum.note);
  if (shapingSuggestion) noteLines.push(shapingSuggestion);

  if (noteLines.length === 0 && !intentOutcome) return null;

  return (
    <WidgetCard bg="#0e0820" accent="#a78bfa" heroAlign="start"
      topLeft="SHAPING" topRight="SUGGESTION"
    >
      <div className="wg-content">
        {intentOutcome && (
          <>
            <div className="wg-io-strip">
              <span className={`wg-io-pill wg-io-pill--${intentOutcome.type}`}>
                {intentOutcome.type === "matched"
                  ? "aligned"
                  : intentOutcome.type === "over-structural"
                  ? "over-structured"
                  : "under-structured"}
              </span>
              <span className="wg-stat">
                <span className="wg-stat-num" style={{ color: "#a78bfa" }}>
                  {Math.round(intentOutcome.structuralScore * 100)}%
                </span>
                <span className="wg-stat-key">structural</span>
              </span>
              <span className="wg-dot-sep">·</span>
              <span className="wg-stat">
                <span className="wg-stat-num" style={{ color: "#f97316" }}>
                  {Math.round(intentOutcome.perceivedScore * 100)}%
                </span>
                <span className="wg-stat-key">perceived</span>
              </span>
            </div>
            <div className="wg-divider" />
          </>
        )}
        {noteLines.length > 0 && (
          <div>
            {noteLines.map((line, i) => (
              <span key={i} className="wg-note-line">{line}</span>
            ))}
          </div>
        )}
      </div>
    </WidgetCard>
  );
}
