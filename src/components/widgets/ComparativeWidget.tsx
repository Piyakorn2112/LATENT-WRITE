import type { ChapterAnalysis } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";

/** Faint grid lines behind the bars */
function GridDeco() {
  return (
    <svg viewBox="0 0 200 120" fill="none">
      {[30, 60, 90].map((x) => (
        <line key={x} x1={x} y1="10" x2={x} y2="110"
          stroke="rgba(93,224,144,0.1)" strokeWidth="1" strokeDasharray="3,4" />
      ))}
      {[40, 70, 100].map((y) => (
        <line key={y} x1="10" y1={y} x2="190" y2={y}
          stroke="rgba(93,224,144,0.07)" strokeWidth="1" />
      ))}
    </svg>
  );
}

function ratio(val: number) {
  const pct = Math.round((val - 1) * 100);
  if (Math.abs(pct) < 5) return { label: "AVG", sign: "" };
  return { label: `${Math.abs(pct)}%`, sign: pct > 0 ? "+" : "−" };
}

interface Props { analysis: ChapterAnalysis }

export function ComparativeWidget({ analysis }: Props) {
  const comp = analysis.comparative;
  if (!comp) return null;

  const rows = [
    { key: "LEN", r: comp.lengthVsAvg },
    { key: "TEN", r: comp.tensionVsAvg },
    { key: "DIA", r: comp.dialogueVsAvg },
  ];

  return (
    <WidgetCard bg="#0c5828" accent="#5de090"
      topLeft="VS AVERAGE" topRight={comp.tensionTrend}
      bottomLeft={comp.paceComparison}
      deco={<GridDeco />}
    >
      <div className="widget-comparative-bars">
        {rows.map(({ key, r }) => {
          const { label, sign } = ratio(r);
          const color = r >= 1 ? "#5de090" : "#ff8080";
          const pct = Math.min(Math.abs((r - 1) * 100), 50) + 50;
          return (
            <div className="widget-bar-row" key={key}>
              <span className="widget-bar-key">{key}</span>
              <div className="widget-bar-track">
                <div className="widget-bar-fill" style={{
                  width: `${pct}%`,
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
    </WidgetCard>
  );
}
