import type { ChapterAnalysis } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";

export function DiagnosticsWidget({ analysis }: { analysis: ChapterAnalysis }) {
  const { writerDiagnostics } = analysis;
  if (writerDiagnostics.length === 0) return null;

  const warnings = writerDiagnostics.filter(d => d.severity === "warning");
  const infos    = writerDiagnostics.filter(d => d.severity === "info");
  const hasWarn  = warnings.length > 0;

  const bg     = hasWarn ? "#160e04" : "#0a1018";
  const accent = hasWarn ? "#fb923c" : "#60a5fa";
  const topRight = hasWarn
    ? `${warnings.length} WARNING${warnings.length > 1 ? "S" : ""}`
    : `${infos.length} NOTE${infos.length > 1 ? "S" : ""}`;

  const ordered = [...warnings, ...infos];

  return (
    <WidgetCard bg={bg} accent={accent} heroAlign="start"
      topLeft="WRITER NOTES" topRight={topRight}
    >
      <div className="wg-content">
        <div className="wg-diag-list">
          {ordered.map((d, i) => {
            const isWarn = d.severity === "warning";
            const color  = isWarn ? "#fb923c" : "#60a5fa";
            return (
              <div key={i} className="wg-diag-item">
                <div className="wg-diag-indicator" style={{ background: color }} />
                <div className="wg-diag-body">
                  <span className="wg-diag-msg">{d.message}</span>
                  <span className="wg-diag-code">{d.code}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </WidgetCard>
  );
}
