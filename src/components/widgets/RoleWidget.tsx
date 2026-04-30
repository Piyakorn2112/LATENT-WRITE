import type { ChapterAnalysis, ChapterRole } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";

const ROLE_ACCENT: Record<ChapterRole, string> = {
  climax:     "#f43f5e",
  resolution: "#34d399",
  buildup:    "#60a5fa",
  breather:   "#38bdf8",
  pivot:      "#fbbf24",
  expository: "#94a3b8",
  standard:   "#60a5fa",
};

const ROLE_SUB: Record<ChapterRole, string> = {
  climax:     "Peak narrative tension",
  resolution: "Tension resolves",
  buildup:    "Rising pressure",
  breather:   "Pacing relief",
  pivot:      "Narrative turn",
  expository: "World & context",
  standard:   "Steady progression",
};

const DENSITY_COLOR: Record<string, string> = {
  light: "#34d399", moderate: "#38bdf8", dense: "#f43f5e",
};

function ratioDisplay(r: number): { label: string; sign: string } {
  const pct = Math.round((r - 1) * 100);
  if (Math.abs(pct) < 5) return { label: "AVG", sign: "" };
  return { label: `${Math.abs(pct)}%`, sign: pct > 0 ? "+" : "−" };
}

export function RoleWidget({ analysis }: { analysis: ChapterAnalysis }) {
  const { chapterRole, comparative, guidance } = analysis;
  const accent = ROLE_ACCENT[chapterRole] ?? "#60a5fa";
  const sub    = ROLE_SUB[chapterRole] ?? "";
  const densityColor = DENSITY_COLOR[guidance.density] ?? "#38bdf8";

  const compRows = comparative ? [
    { key: "LEN", r: comparative.lengthVsAvg },
    { key: "TEN", r: comparative.tensionVsAvg },
    { key: "DIA", r: comparative.dialogueVsAvg },
  ] : [];

  return (
    <WidgetCard bg="#0d1117" accent={accent} heroAlign="start"
      topLeft="CHAPTER ROLE" topRight={chapterRole.toUpperCase()}
    >
      <div className="wg-content">
        {/* Role header */}
        <div className="wg-role-header">
          <span className="wg-role-pill" style={{ color: accent }}>{chapterRole.toUpperCase()}</span>
          <span className="wg-dot-sep">·</span>
          <span className="wg-role-sub">{sub}</span>
        </div>

        {/* Pacing row */}
        <div className="wg-row" style={{ marginBottom: 8 }}>
          <span className="wg-stat">
            <span className="wg-stat-num" style={{ color: densityColor }}>
              {guidance.estimatedMinutes < 1 ? "<1" : guidance.estimatedMinutes}
            </span>
            <span className="wg-stat-key">min</span>
          </span>
          <span className="wg-dot-sep">·</span>
          <span className="wg-stat">
            <span className="wg-stat-num" style={{ color: densityColor }}>{guidance.density}</span>
            <span className="wg-stat-key">density</span>
          </span>
          {comparative && (
            <>
              <span className="wg-dot-sep">·</span>
              <span className="wg-stat-key">{comparative.tensionTrend}</span>
            </>
          )}
        </div>

        {/* Comparative bars */}
        {compRows.length > 0 && (
          <>
            <div className="wg-divider" />
            <div className="widget-comparative-bars" style={{ padding: "4px 0" }}>
              {compRows.map(({ key, r }) => {
                const { label, sign } = ratioDisplay(r);
                const color = r >= 1 ? "#34d399" : "#f87171";
                return (
                  <div key={key} className="widget-bar-row">
                    <span className="widget-bar-key">{key}</span>
                    <div className="widget-bar-track">
                      <div className="widget-bar-fill" style={{
                        width: `${Math.min(Math.abs((r - 1) * 100), 50) + 50}%`,
                        background: color, opacity: 0.75,
                      }} />
                    </div>
                    <span className="widget-bar-val" style={{ color }}>
                      {sign}{label}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Pace comparison text */}
        {comparative?.paceComparison && (
          <>
            <div className="wg-divider" />
            <span className="wg-stat-key" style={{ fontSize: 9.5, lineHeight: 1.4 }}>
              {comparative.paceComparison}
            </span>
          </>
        )}
      </div>
    </WidgetCard>
  );
}
