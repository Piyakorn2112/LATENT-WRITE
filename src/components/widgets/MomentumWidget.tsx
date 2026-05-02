import type { ChapterAnalysis } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";

const TREND_COLOR: Record<string, string> = {
  stuck:        "#94a3b8",
  progressing:  "#38bdf8",
  accelerating: "#34d399",
};

const OVERALL_COLOR: Record<string, string> = {
  stuck:    "#94a3b8",
  building: "#38bdf8",
  fluid:    "#34d399",
  erratic:  "#fb923c",
};

// Action note for the writer — what to look at next based on momentum shape.
function actionFor(
  segs: { label: string; trend: string; score: number }[],
  overall: string,
  hasFakePeak: boolean,
): string | null {
  if (hasFakePeak) {
    return "Tension peaks but the surrounding prose is static — try sharpening verbs around the peak so the felt-impact catches up.";
  }
  if (overall === "stuck") {
    const stuckSeg = segs.find((s) => s.trend === "stuck");
    return stuckSeg
      ? `${stuckSeg.label[0].toUpperCase() + stuckSeg.label.slice(1)} reads as static — consider tightening or adding a small turn.`
      : "Momentum is low overall — look for a beat that can carry into the next.";
  }
  if (overall === "erratic") {
    return "Pacing oscillates — check for an abrupt jump between two adjacent segments and bridge it with a transitional beat.";
  }
  const close = segs.find((s) => s.label.toLowerCase().includes("close"));
  if (close && close.trend === "stuck") {
    return "Close ends static — a final push or a hook into the next chapter would land harder.";
  }
  return null;
}

export function MomentumWidget({ analysis }: { analysis: ChapterAnalysis }) {
  const hi = analysis.highModeAnalysis;
  if (!hi || hi.narrativeMomentum.segments.length === 0) return null;

  const { segments, overall, hasFakePeak, note } = hi.narrativeMomentum;
  const overallColor = OVERALL_COLOR[overall] ?? "#94a3b8";
  const action = actionFor(segments, overall, hasFakePeak);

  return (
    <WidgetCard
      bg="#0d1117"
      accent={overallColor}
      heroAlign="start"
      topLeft="MOMENTUM"
      topRight={overall.toUpperCase()}
    >
      <div className="wg-content">
        <div className="wg-section">
          {segments.map((seg) => {
            const color = TREND_COLOR[seg.trend] ?? "#94a3b8";
            const pct = Math.max(6, Math.round(seg.score * 100));
            return (
              <div className="wg-momentum-row" key={seg.label}>
                <div className="wg-momentum-label">{seg.label}</div>
                <div className="wg-momentum-bar">
                  <div
                    className="wg-momentum-bar-fill"
                    style={{ width: `${pct}%`, background: color }}
                  />
                </div>
                <div
                  className="wg-momentum-trend"
                  style={{ color }}
                >
                  {seg.trend}
                </div>
              </div>
            );
          })}
        </div>

        {(action || note) && (
          <div className="wg-section wg-section-divider">
            <div className="wg-action-line">
              {action ?? note}
            </div>
          </div>
        )}
      </div>
    </WidgetCard>
  );
}
