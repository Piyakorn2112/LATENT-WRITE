import { Activity } from "lucide-react";
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

// Polar → Cartesian (SVG y-axis flips, so we use sin for y).
function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

// Build an SVG arc path between two angles on a single radius.
function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const a = polar(cx, cy, r, startDeg);
  const b = polar(cx, cy, r, endDeg);
  const sweep = endDeg - startDeg;
  const largeArc = Math.abs(sweep) > 180 ? 1 : 0;
  const sweepFlag = sweep >= 0 ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} ${sweepFlag} ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

/**
 * Per-segment arc dial — one sector per chapter segment (opening,
 * middle, build, close), each filled to its momentum score within its
 * own angular range. Trend colours the arc (stuck = grey,
 * progressing = blue, accelerating = green). The overall trend label
 * sits at centre with a small Activity icon for personality.
 *
 * This is intentionally NOT a dot ring — momentum is a continuous
 * quantity per segment, so a continuous arc is the more honest
 * visualisation than counting discrete dots.
 */
function MomentumDial({
  segments,
  overall,
  size = 132,
}: {
  segments: { label: string; trend: string; score: number }[];
  overall: string;
  size?: number;
}) {
  const half = size / 2;
  const r = half - 9;
  const N = segments.length;
  const gapDeg = N > 1 ? 7 : 0;
  const sectorDeg = (360 - gapDeg * N) / N;
  // -90 starts the first sector at 12 o'clock so the chapter "begins
  // at the top" — matches reading order.
  const startBase = -90;
  const overallColor = OVERALL_COLOR[overall] ?? "#94a3b8";

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {segments.map((seg, i) => {
        const a0 = startBase + i * (sectorDeg + gapDeg);
        const a1 = a0 + sectorDeg;
        // Floor at 6% so a 0-score arc still shows a tiny pip rather
        // than vanishing entirely (visual stability across chapters).
        const fillEnd = a0 + sectorDeg * Math.max(0.06, seg.score);
        const color = TREND_COLOR[seg.trend] ?? "#94a3b8";
        return (
          <g key={seg.label}>
            <path
              d={arcPath(half, half, r, a0, a1)}
              stroke="rgba(255, 255, 255, 0.08)"
              strokeWidth={6}
              strokeLinecap="round"
              fill="none"
            />
            <path
              d={arcPath(half, half, r, a0, fillEnd)}
              stroke={color}
              strokeWidth={6}
              strokeLinecap="round"
              fill="none"
            />
          </g>
        );
      })}
      {/* Subtle inner outline tying the segments visually as a single
          gauge rather than four disconnected arcs. */}
      <circle cx={half} cy={half} r={r - 12} stroke={overallColor}
              strokeWidth={1} strokeOpacity={0.18} fill="none" />
    </svg>
  );
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
        <div className="wg-cast-dial-row">
          <div className="wg-clock-wrap">
            <MomentumDial segments={segments} overall={overall} />
            <div className="wg-clock-center">
              <span className="wg-dial-num wg-dial-num--sm" style={{ color: overallColor }}>
                {Math.round(
                  (segments.reduce((s, x) => s + x.score, 0) / Math.max(segments.length, 1)) * 100,
                )}
              </span>
              <span className="wg-dial-unit" style={{ color: overallColor }}>flow</span>
              <span className="wg-dial-icon" style={{ color: overallColor }}>
                <Activity size={12} strokeWidth={2.4} />
              </span>
            </div>
          </div>
        </div>

        <div className="wg-section">
          {segments.map((seg) => {
            const color = TREND_COLOR[seg.trend] ?? "#94a3b8";
            return (
              <div className="wg-cast-row-compact" key={seg.label}>
                <span className="wg-cast-dot" style={{ background: color }} />
                <span className="wg-cast-name">{seg.label}</span>
                <span className="wg-cast-share" style={{ color }}>{seg.trend}</span>
                <span className="wg-cast-turns">
                  {Math.round(seg.score * 100)}%
                </span>
              </div>
            );
          })}
          {hasFakePeak && (
            <div className="wg-cast-row-compact">
              <span className="wg-cast-dot" style={{ background: "#fb923c" }} />
              <span className="wg-cast-name">fake-peak</span>
              <span className="wg-cast-share" style={{ color: "#fb923c" }}>warning</span>
            </div>
          )}
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
