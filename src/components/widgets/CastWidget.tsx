import type { CSSProperties } from "react";
import type { ChapterAnalysis } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";
import { buildSpeakerPalette, getSpeakerColor } from "../../lib/palette";

export function CastWidget({ analysis }: { analysis: ChapterAnalysis }) {
  const { speakerCounts, highModeAnalysis } = analysis;
  if (speakerCounts.length === 0) return null;

  const totalTurns = speakerCounts.reduce((s, sp) => s + sp.turns, 0);
  const influence  = highModeAnalysis?.characterInfluence ?? [];

  const speakerNames = speakerCounts.map(s => s.name);
  const palette = buildSpeakerPalette(speakerNames);

  // Merge speakerCounts with characterInfluence
  const rows = speakerCounts.slice(0, 5).map(sp => {
    const ci = influence.find(c => c.name.toLowerCase() === sp.name.toLowerCase());
    return { ...sp, ci };
  });

  return (
    <WidgetCard bg="#0d1117" accent="#38bdf8" heroAlign="start"
      topLeft="CAST" topRight={`${speakerCounts.length} SPEAKERS · ${totalTurns} TURNS`}
    >
      <div className="wg-content">
        <div className="wg-section">
          {rows.map(row => {
            const dotColor = getSpeakerColor(palette, row.name).text;
            return (
              <div key={row.name} className="wg-cast">
                <span className="wg-cast-dot" style={{ background: dotColor }} />
                <span className="wg-cast-name">{row.name}</span>
                <div className="wg-cast-bars">
                  {row.ci ? (
                    <>
                      <div className="wg-cast-bar">
                        <div className="wg-cast-bar-fill"
                          style={{ width: `${Math.round(row.ci.presence * 100)}%`, background: "#38bdf8" } as CSSProperties} />
                      </div>
                      <div className="wg-cast-bar">
                        <div className="wg-cast-bar-fill"
                          style={{ width: `${Math.round(row.ci.tensionProximity * 100)}%`, background: "#f43f5e" } as CSSProperties} />
                      </div>
                      <div className="wg-cast-bar">
                        <div className="wg-cast-bar-fill"
                          style={{ width: `${Math.round(row.ci.narrativeShift * 100)}%`, background: "#34d399" } as CSSProperties} />
                      </div>
                    </>
                  ) : (
                    <div className="wg-cast-bar">
                      <div className="wg-cast-bar-fill"
                        style={{ width: `${Math.min(100, Math.round((row.turns / Math.max(totalTurns, 1)) * 100 * 3))}%`, background: dotColor } as CSSProperties} />
                    </div>
                  )}
                </div>
                {row.ci ? (
                  <span className={`wg-cast-role wg-cast-role--${row.ci.role}`}>{row.ci.role}</span>
                ) : (
                  <span className="wg-cast-role">{row.turns}t</span>
                )}
              </div>
            );
          })}
        </div>

        {influence.length > 0 && (
          <div className="wg-cast-legend">
            <span className="wg-cast-legend-item">
              <span className="wg-cast-legend-swatch" style={{ background: "#38bdf8" }} />
              presence
            </span>
            <span className="wg-cast-legend-item">
              <span className="wg-cast-legend-swatch" style={{ background: "#f43f5e" }} />
              tension
            </span>
            <span className="wg-cast-legend-item">
              <span className="wg-cast-legend-swatch" style={{ background: "#34d399" }} />
              shift
            </span>
          </div>
        )}
      </div>
    </WidgetCard>
  );
}
