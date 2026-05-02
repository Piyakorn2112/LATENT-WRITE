import { useMemo } from "react";
import { WidgetCard } from "./WidgetCard";
import { summarizeContinuity } from "../../lib/continuity";
import { IOS_COLORS } from "../../lib/palette";
import type { Chapter, WorldData } from "../../types";

interface Props {
  chapters: Chapter[];
  worldData: WorldData | undefined;
  chapterIndex: number;
}

const SECTION_BORDER = "rgba(255,255,255,0.06)";

export function ContinuityWidget({ chapters, worldData, chapterIndex }: Props) {
  const summary = useMemo(
    () => summarizeContinuity(chapters, worldData, chapterIndex),
    [chapters, worldData, chapterIndex],
  );

  if (!summary.hasAnything) return null;

  // Most-actionable signal becomes the headline & accent.
  const accent =
    summary.outOfOrder.length > 0 ? IOS_COLORS.red.text :
    summary.handoff             ? IOS_COLORS.orange.text :
                                  IOS_COLORS.purple.text;

  const headline =
    summary.outOfOrder.length > 0 ? "TIMELINE SLIP" :
    summary.handoff             ? "HAND-OFF" :
                                  "CHEKHOV";

  return (
    <WidgetCard
      bg="#0d1117"
      accent={accent}
      heroAlign="start"
      topLeft="CONTINUITY"
      topRight={headline}
    >
      <div className="wg-content">
        {/* Out-of-order character mentions */}
        {summary.outOfOrder.length > 0 && (
          <div className="wg-section">
            {summary.outOfOrder.slice(0, 3).map((h) => (
              <div className="wg-momentum-row" key={h.character}>
                <div className="wg-momentum-label" style={{ color: IOS_COLORS.red.text }}>
                  {h.character}
                </div>
                <div className="wg-momentum-bar">
                  <div className="wg-momentum-bar-fill"
                    style={{ width: "100%", background: IOS_COLORS.red.text, opacity: 0.6 }} />
                </div>
                <div className="wg-momentum-trend" style={{ color: IOS_COLORS.red.text, fontVariantNumeric: "tabular-nums" }}>
                  ch {h.firstChapter}
                </div>
              </div>
            ))}
            <div className="wg-action-line">
              {summary.outOfOrder.length === 1
                ? `First "official" appearance is in chapter ${summary.outOfOrder[0].firstChapter}. Verify this isn't a flashback that needs marking.`
                : `${summary.outOfOrder.length} characters here are introduced later in the book — confirm intentional.`}
            </div>
          </div>
        )}

        {/* Hand-off (time / place drift between prev and this chapter) */}
        {summary.handoff && (
          <div className="wg-section" style={{
            paddingTop: summary.outOfOrder.length > 0 ? 8 : 0,
            borderTop: summary.outOfOrder.length > 0 ? `1px solid ${SECTION_BORDER}` : "none",
            marginTop: summary.outOfOrder.length > 0 ? 6 : 0,
          }}>
            <div className="wg-style-meta" style={{ marginBottom: 4 }}>
              <span className="wg-style-meta-label">Prev ends</span>
              <span className="wg-style-meta-value">
                {[summary.handoff.prevPlace, summary.handoff.prevTime].filter(Boolean).join(" · ") || "—"}
              </span>
            </div>
            <div className="wg-style-meta">
              <span className="wg-style-meta-label">Opens</span>
              <span className="wg-style-meta-value" style={{ color: IOS_COLORS.orange.text }}>
                {[summary.handoff.thisPlace, summary.handoff.thisTime].filter(Boolean).join(" · ") || "—"}
              </span>
            </div>
            <div className="wg-action-line">
              {summary.handoff.drift === "both"
                ? "Place and time both shift — make the transition explicit on the page."
                : summary.handoff.drift === "place"
                ? "Place changes from the previous chapter — does the opening orient the reader?"
                : "Time of day changes from the previous chapter — anchor the reader."}
            </div>
          </div>
        )}

        {/* Chekhov candidates */}
        {summary.chekhov.length > 0 && (
          <div className="wg-section" style={{
            paddingTop: (summary.outOfOrder.length > 0 || summary.handoff) ? 8 : 0,
            borderTop: (summary.outOfOrder.length > 0 || summary.handoff) ? `1px solid ${SECTION_BORDER}` : "none",
            marginTop: (summary.outOfOrder.length > 0 || summary.handoff) ? 6 : 0,
          }}>
            <div className="wg-style-meta" style={{ marginBottom: 6 }}>
              <span className="wg-style-meta-label">Introduced — never recurs</span>
            </div>
            <div className="wg-tags">
              {summary.chekhov.slice(0, 5).map((c) => (
                <span key={c.phrase} className="wg-tag">
                  <span className="wg-tag-key">{c.phrase}</span>
                  <span className="wg-tag-val">{c.mentions}×</span>
                </span>
              ))}
            </div>
            <div className="wg-action-line" style={{ marginTop: 4 }}>
              Concrete things mentioned here that don't return. Pay them off, fade them, or cut them.
            </div>
          </div>
        )}
      </div>
    </WidgetCard>
  );
}
