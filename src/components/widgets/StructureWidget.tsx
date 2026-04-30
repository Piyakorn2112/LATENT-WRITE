import type { ChapterAnalysis } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";

const TENSION_COLOR: Record<string, string> = {
  calm: "#94a3b8", rising: "#fbbf24", high: "#f43f5e", sustained: "#f43f5e",
};
const TENSION_FILL: Record<string, number> = { calm: 1, rising: 3, high: 4, sustained: 5 };
const MOMENTUM_COLOR: Record<string, string> = {
  stuck: "#94a3b8", progressing: "#38bdf8", accelerating: "#34d399",
};

export function StructureWidget({ analysis }: { analysis: ChapterAnalysis }) {
  const hi = analysis.highModeAnalysis;
  if (!hi || hi.microStructure.length === 0) return null;

  const { microStructure, narrativeMomentum, attributionStats } = hi;
  const overall = narrativeMomentum.overall;
  const overallColor = overall === "fluid" ? "#34d399"
    : overall === "building" ? "#38bdf8"
    : overall === "erratic" ? "#fb923c"
    : "#94a3b8";

  return (
    <WidgetCard bg="#0d1117" accent="#38bdf8" heroAlign="start"
      topLeft="STRUCTURE" topRight={overall.toUpperCase()}
    >
      <div className="wg-content">
        <div className="wg-section">
          {microStructure.map(seg => {
            const tc = TENSION_COLOR[seg.tensionProfile] ?? "#94a3b8";
            const fill = TENSION_FILL[seg.tensionProfile] ?? 1;
            const mom = narrativeMomentum.segments.find(m => m.label === seg.label);
            const momColor = mom ? (MOMENTUM_COLOR[mom.trend] ?? "#94a3b8") : "#94a3b8";
            return (
              <div key={seg.label} className="wg-seg">
                <span className="wg-seg-dot" style={{ background: tc }} />
                <span className="wg-seg-label">{seg.label.replace("-section", "")}</span>
                <div className="wg-seg-cells">
                  {[0,1,2,3,4].map(i => (
                    <span key={i} className="wg-seg-cell"
                      style={i < fill ? { background: tc } : undefined} />
                  ))}
                </div>
                <span className="wg-seg-tension" style={{ color: tc }}>{seg.tensionProfile}</span>
                {mom && (
                  <span className="wg-seg-momentum" style={{ color: momColor }}>
                    {Math.round(mom.score * 100)}%
                  </span>
                )}
              </div>
            );
          })}
          <div className="wg-seg-overall">
            <span className="wg-seg-overall-text" style={{ color: overallColor }}>
              overall · {overall}
            </span>
            {narrativeMomentum.hasFakePeak && (
              <span className="wg-seg-overall-text" style={{ color: "#fb923c" }}> · fake-peak detected</span>
            )}
          </div>
        </div>

        {attributionStats.totalAttributed > 0 && (
          <>
            <div className="wg-divider" />
            <div className="wg-tags">
              <span className="wg-tag">
                <span className="wg-tag-key">conf</span>
                <span className="wg-tag-val">{attributionStats.overallConfidence}%</span>
              </span>
              {attributionStats.ambiguousParagraphs.length > 0 && (
                <span className="wg-tag">
                  <span className="wg-tag-key">ambig</span>
                  <span className="wg-tag-val">
                    {attributionStats.ambiguousParagraphs.slice(0, 4).map(p => `¶${p + 1}`).join("·")}
                    {attributionStats.ambiguousParagraphs.length > 4 ? "+" : ""}
                  </span>
                </span>
              )}
              {hi.peakTrace && (
                <span className="wg-tag">
                  <span className="wg-tag-key">peak</span>
                  <span className="wg-tag-val">¶{hi.peakTrace.paragraphIndex + 1}</span>
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </WidgetCard>
  );
}
