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

const ROLE_BG: Record<ChapterRole, string> = {
  climax:     "#1a0810",
  resolution: "#081a14",
  buildup:    "#080f1a",
  breather:   "#081418",
  pivot:      "#18160a",
  expository: "#0d1117",
  standard:   "#0d1117",
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

function ratioDisplay(r: number): { label: string; sign: string; pct: number } {
  const pct = Math.round((r - 1) * 100);
  if (Math.abs(pct) < 5) return { label: "AVG", sign: "", pct: 0 };
  return { label: `${Math.abs(pct)}%`, sign: pct > 0 ? "+" : "−", pct };
}

function ReadTimeRing({ minutes, color, maxMinutes = 30 }: {
  minutes: number;
  color: string;
  maxMinutes?: number;
}) {
  const size = 52;
  const cx = size / 2;
  const cy = size / 2;
  const r = 20;
  const ticks = 36;
  const filledTicks = Math.min(Math.round((minutes / maxMinutes) * ticks), ticks);

  const tickElems: React.ReactNode[] = [];
  for (let i = 0; i < ticks; i++) {
    const angle = ((i / ticks) * 360 - 90) * (Math.PI / 180);
    const isMajor = i % 3 === 0;
    const len = isMajor ? 4 : 2.5;
    const w = isMajor ? 1.4 : 0.9;
    const x1 = cx + (r - len) * Math.cos(angle);
    const y1 = cy + (r - len) * Math.sin(angle);
    const x2 = cx + r * Math.cos(angle);
    const y2 = cy + r * Math.sin(angle);
    const active = i < filledTicks;

    tickElems.push(
      <line key={i}
        x1={x1} y1={y1} x2={x2} y2={y2}
        stroke={active ? color : "rgba(255,255,255,0.09)"}
        strokeWidth={w}
        strokeLinecap="round"
        opacity={active ? 0.85 : 1}
      />
    );
  }

  return (
    <div className="wg-role-ring-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        {tickElems}
      </svg>
      <div className="wg-role-ring-center">
        <span className="wg-role-ring-num" style={{ color }}>
          {minutes < 1 ? "<1" : minutes}
        </span>
        <span className="wg-role-ring-unit">min</span>
      </div>
    </div>
  );
}

export function RoleWidget({ analysis }: { analysis: ChapterAnalysis }) {
  const { chapterRole, comparative, guidance } = analysis;
  const accent = ROLE_ACCENT[chapterRole] ?? "#60a5fa";
  const bg = ROLE_BG[chapterRole] ?? "#0d1117";
  const sub    = ROLE_SUB[chapterRole] ?? "";
  const densityColor = DENSITY_COLOR[guidance.density] ?? "#38bdf8";

  const compRows = comparative ? [
    { key: "LEN", r: comparative.lengthVsAvg },
    { key: "TEN", r: comparative.tensionVsAvg },
    { key: "DIA", r: comparative.dialogueVsAvg },
  ] : [];

  return (
    <WidgetCard bg={bg} accent={accent} heroAlign="start"
      topLeft="CHAPTER ROLE" topRight={chapterRole.toUpperCase()}
    >
      <div className="wg-content">
        <div className="wg-role-header">
          <span className="wg-role-pill-v2" style={{
            color: accent,
            background: `${accent}14`,
            borderColor: `${accent}30`,
          }}>
            {chapterRole.toUpperCase()}
          </span>
          <span className="wg-role-sub">{sub}</span>
        </div>

        <div className="wg-role-hero-row">
          <ReadTimeRing
            minutes={guidance.estimatedMinutes}
            color={densityColor}
          />
          <div className="wg-role-meta-col">
            <div className="wg-role-density-pill" style={{
              color: densityColor,
              borderColor: `${densityColor}35`,
              background: `${densityColor}0c`,
            }}>
              {guidance.density}
            </div>
            {comparative && (
              <span className="wg-role-trend" style={{ color: accent }}>
                {comparative.tensionTrend}
              </span>
            )}
          </div>
        </div>

        {compRows.length > 0 && (
          <>
            <div className="wg-divider" />
            <div className="wg-role-deviation-bars">
              {compRows.map(({ key, r }) => {
                const { label, sign, pct } = ratioDisplay(r);
                const isAbove = pct > 0;
                const color = Math.abs(pct) < 5 ? "#94a3b8" : isAbove ? "#34d399" : "#f87171";
                const barWidth = Math.min(Math.abs(pct), 50);
                return (
                  <div key={key} className="wg-dev-row">
                    <span className="wg-dev-key">{key}</span>
                    <div className="wg-dev-track">
                      <div className="wg-dev-center" />
                      <div className="wg-dev-fill" style={{
                        width: `${barWidth}%`,
                        background: color,
                        [isAbove ? "left" : "right"]: "50%",
                        opacity: 0.7,
                      }} />
                    </div>
                    <span className="wg-dev-val" style={{ color }}>
                      {sign}{label}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {comparative?.paceComparison && (
          <>
            <div className="wg-divider" />
            <div className="wg-action-line">{comparative.paceComparison}</div>
          </>
        )}
      </div>
    </WidgetCard>
  );
}
