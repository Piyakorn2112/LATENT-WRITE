import type { ChapterAnalysis } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";
import { ArcRing, type ArcSegment } from "./ArcRing";
import { buildSpeakerPalette, getSpeakerColor } from "../../lib/palette";

/**
 * Speaker breakdown — multi-segment dot ring where each speaker's
 * arc length is proportional to their dialogue share. Matches the
 * Apple-Watch reference's segmented-ring language exactly: each
 * tinted segment encodes one quantity (turns × speaker), and the
 * centre cell holds the focal numeric (total turns).
 *
 * Below the dial: a compact legend row per speaker — colour dot,
 * name, share %, raw turn count, optional role tag (from
 * highMode characterInfluence). Every visible token is data; no
 * decorative pips.
 */

export function CastWidget({ analysis }: { analysis: ChapterAnalysis }) {
  const { speakerCounts, highModeAnalysis } = analysis;
  if (speakerCounts.length === 0) return null;

  const totalTurns = speakerCounts.reduce((s, sp) => s + sp.turns, 0);
  if (totalTurns === 0) return null;

  const influence = highModeAnalysis?.characterInfluence ?? [];
  const palette = buildSpeakerPalette(speakerCounts.map((s) => s.name));

  // Cap visible speakers so the chip list stays compact. Off-list speakers
  // still contribute to the arc via the "remainder" segment.
  const TOP_N = 5;
  const top = speakerCounts.slice(0, TOP_N);
  const remainderTurns = speakerCounts
    .slice(TOP_N)
    .reduce((s, sp) => s + sp.turns, 0);

  // Build arc segments as normalised 0..1 fractions of the full ring.
  const arcSegments: ArcSegment[] = [];
  let cursor = 0;
  for (let i = 0; i < top.length; i++) {
    const sp = top[i];
    const share = sp.turns / totalTurns;
    arcSegments.push({
      from: cursor,
      to: cursor + share,
      color: getSpeakerColor(palette, sp.name).text,
    });
    cursor += share;
  }
  if (remainderTurns > 0) {
    arcSegments.push({
      from: cursor,
      to: 1,
      color: "rgba(255, 255, 255, 0.32)",
    });
  }

  const rows = top.map((sp) => {
    const ci = influence.find((c) => c.name.toLowerCase() === sp.name.toLowerCase());
    return { ...sp, ci };
  });

  return (
    <WidgetCard
      bg="#0d1117"
      accent="#38bdf8"
      heroAlign="start"
      topLeft="CAST"
      topRight={`${speakerCounts.length} SPEAKERS`}
    >
      <div className="wg-content">
        {/* Dial + floating proportional name bouquet. The labels float
            around the ring at the angular midpoint of each speaker's
            segment, sized by their dialogue share (loudest = largest)
            — fills the empty corners without filler imagery. */}
        <div className="wg-cast-dial-bouquet">
          <ArcRing
            size={138}
            thickness={9}
            startAngle={-90}
            sweep={360}
            segments={arcSegments}
            gap={10}
            rounded
          >
            <span className="wg-dial-num" style={{ color: "#fff" }}>
              {totalTurns}
            </span>
            <span className="wg-dial-unit" style={{ color: "rgba(255,255,255,0.6)" }}>
              turns
            </span>
          </ArcRing>
          {top.map((sp, i) => {
            const seg = arcSegments[i];
            if (!seg) return null;
            // Segment midpoint angle, in degrees from -90 (top).
            const midFrac = (seg.from + seg.to) / 2;
            const angle = -90 + midFrac * 360;
            const rad = (angle * Math.PI) / 180;
            // Label radius — sits OUTSIDE the dial ring at a fixed offset,
            // so labels orbit the dial rather than overlapping it.
            const r = 84;
            // Centre of the bouquet container is approximately (50%, 50%).
            const x = 50 + (r * Math.cos(rad)) / 2.6;
            const y = 50 + (r * Math.sin(rad)) / 2.6;
            const share = sp.turns / totalTurns;
            // Font size scales 11 → 22 px with sqrt(share) so single-
            // dominant speakers read big, but small-share speakers stay
            // legible rather than vanishing.
            const fs = 11 + Math.sqrt(share) * 11;
            const dotColor = getSpeakerColor(palette, sp.name).text;
            return (
              <span
                key={sp.name}
                className="wg-cast-float-label"
                style={{
                  left: `${x}%`,
                  top: `${y}%`,
                  fontSize: `${fs.toFixed(1)}px`,
                  color: dotColor,
                  // Stagger the entrance so labels arrive in turn-share
                  // order rather than all at once — playful without being
                  // a continuous loop.
                  animationDelay: `${i * 60}ms`,
                }}
              >
                {sp.name}
              </span>
            );
          })}
        </div>

        <div className="wg-section">
          {rows.map((row) => {
            const dotColor = getSpeakerColor(palette, row.name).text;
            const sharePct = Math.round((row.turns / totalTurns) * 100);
            return (
              <div key={row.name} className="wg-cast-row-compact">
                <span className="wg-cast-dot" style={{ background: dotColor }} />
                <span className="wg-cast-name">{row.name}</span>
                {row.ci?.role && (
                  <span className={`wg-cast-role wg-cast-role--${row.ci.role}`}>
                    {row.ci.role}
                  </span>
                )}
                <span className="wg-cast-share">{sharePct}%</span>
                <span className="wg-cast-turns">{row.turns}t</span>
              </div>
            );
          })}
          {remainderTurns > 0 && (
            <div className="wg-cast-row-compact">
              <span
                className="wg-cast-dot"
                style={{ background: "rgba(255, 255, 255, 0.32)" }}
              />
              <span className="wg-cast-name" style={{ opacity: 0.6 }}>
                {speakerCounts.length - TOP_N} other{speakerCounts.length - TOP_N === 1 ? "" : "s"}
              </span>
              <span className="wg-cast-share">
                {Math.round((remainderTurns / totalTurns) * 100)}%
              </span>
              <span className="wg-cast-turns">{remainderTurns}t</span>
            </div>
          )}
        </div>
      </div>
    </WidgetCard>
  );
}
