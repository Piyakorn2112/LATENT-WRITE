import { useId } from "react";
import type { ChapterAnalysisResult } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";

// Catmull-Rom path generator — same algorithm the reader uses for its
// hmx-arc-graph mini sparklines, so the visual feel matches.
function catmullRomPath(pts: [number, number][]): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function tColor(v: number): string {
  return v >= 0.85 ? "#f43f5e" : v >= 0.35 ? "#fbbf24" : "#94a3b8";
}

// Mini sparkline — fixed-width 100×{22|26}, used three times across the
// prev / current / next cells. The current chapter's sparkline is slightly
// taller and bolder so the eye lands on it.
function MiniArc({ curve, idBase, isCurrent = false }: {
  curve: number[]; idBase: string; isCurrent?: boolean;
}) {
  const W = 100;
  const H = isCurrent ? 30 : 24;
  const PAD_Y = 2;
  const plotH = H - 2 * PAD_Y;

  if (curve.length < 2) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}
           preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1={H / 2} x2={W} y2={H / 2}
              stroke="rgba(255,255,255,0.12)" strokeWidth="1" strokeDasharray="2 3" />
      </svg>
    );
  }

  const pts: [number, number][] = curve.map((raw, i) => {
    const v = Math.pow(raw, 1.2);
    return [(i / (curve.length - 1)) * W, H - PAD_Y - v * plotH];
  });
  const linePath = catmullRomPath(pts);
  const fillPath = `${linePath} L${W},${H} L0,${H} Z`;
  const peakColor = tColor(Math.max(...curve));
  const lineId = `${idBase}-l`;
  const fillId = `${idBase}-f`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}
         preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={lineId} x1="0%" y1="0%" x2="100%" y2="0%">
          {pts.map((_, i) => (
            <stop key={i}
                  offset={`${((i / (pts.length - 1)) * 100).toFixed(1)}%`}
                  stopColor={tColor(curve[i])} />
          ))}
        </linearGradient>
        <linearGradient id={fillId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor={peakColor} stopOpacity={isCurrent ? "0.28" : "0.16"} />
          <stop offset="100%" stopColor={peakColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill={`url(#${fillId})`} />
      <path d={linePath} fill="none" stroke={`url(#${lineId})`}
            strokeWidth={isCurrent ? 1.7 : 1.3}
            strokeLinecap="round" strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            opacity={isCurrent ? 1 : 0.85} />
    </svg>
  );
}

// 3-chapter peak-pattern lookup — same map as the reader's HighModeDeepAnalysis.
// Encodes the prev-curr-next peakTension triple as a human-readable shape.
const CROSS_PATTERN: Record<string, string> = {
  "high-high-high":   "sustained",
  "calm-high-calm":   "tension & release",
  "rising-high-calm": "peak and fall",
  "calm-high-rising": "building peak",
  "high-calm-high":   "breather window",
  "calm-calm-high":   "escalating",
  "rising-calm-high": "escalating",
  "high-high-calm":   "descending",
  "high-high-rising": "descending",
  "calm-calm-calm":   "plateau",
  "calm-rising-high": "accelerating",
  "high-calm-calm":   "decompressing",
};

interface Props {
  /** Current chapter's analysis. Required — widget is gated on it externally. */
  current: ChapterAnalysisResult;
  /** Previous chapter analysis if cached (user has visited it). */
  prev: ChapterAnalysisResult | null;
  /** Next chapter analysis if cached. */
  next: ChapterAnalysisResult | null;
}

/**
 * CrossArcWidget — replicates the reader's high-mode "Arc" row inside the
 * editor's analysis panel. Shows tension-curve sparklines for prev / current
 * / next chapter side-by-side with arrow connectors between them, plus a
 * cross-chapter pattern label (e.g., "escalating", "tension & release").
 *
 * Gating: callers should only render this in high intelligence mode.
 *
 * Data source: pulls tensionCurve and peakTension from each ChapterAnalysis.
 * No fresh analysis is triggered — adjacent chapters are read from the
 * useAnalysis cache, which is populated organically as the user navigates.
 * If a neighbour hasn't been visited yet, that cell shows a dashed
 * placeholder line and the cross-pattern is suppressed.
 */
export function CrossArcWidget({ current, prev, next }: Props) {
  const uid = useId().replace(/:/g, "_");

  const currA = current.analysis;
  const prevA = prev?.analysis ?? null;
  const nextA = next?.analysis ?? null;

  // Cross-pattern label requires BOTH neighbours present — three-chapter
  // shapes are inherently triple-keyed.
  const crossKey = prevA && nextA
    ? `${prevA.peakTension}-${currA.peakTension}-${nextA.peakTension}`
    : null;
  const pattern = crossKey ? CROSS_PATTERN[crossKey] ?? null : null;

  // Cast continuity: characters in the prev/next chapter that aren't in the
  // current one. Surfaces "who left" / "who's about to enter" as a sublabel.
  const currCast = new Set(currA.speakerCounts.map(c => c.name.toLowerCase()));
  const filterReal = (s: { name: string; turns: number }) =>
    s.turns >= 3 && s.name.toLowerCase() !== "narration" && s.name.toLowerCase() !== "unknown";
  const goneChars = (prevA?.speakerCounts ?? [])
    .filter(filterReal).filter(s => !currCast.has(s.name.toLowerCase()));
  const incomingChars = (nextA?.speakerCounts ?? [])
    .filter(filterReal).filter(s => !currCast.has(s.name.toLowerCase()));

  const peakTriple = `${prevA?.peakTension ?? "—"} → ${currA.peakTension} → ${nextA?.peakTension ?? "—"}`;

  return (
    <WidgetCard
      bg="#0d1729"
      accent="#7dd8ff"
      heroAlign="start"
      topLeft="CROSS-ARC"
      topRight={pattern ? pattern.toUpperCase() : "ARC RELATION"}
      bottomLeft={peakTriple}
      bottomRight=""
    >
      <div className="wg-content">
        <div className="cross-arc-row">
          {/* Previous chapter cell */}
          <div className="cross-arc-cell">
            <div className="cross-arc-graph">
              {prevA ? (
                <MiniArc curve={prevA.tensionCurve} idBase={`${uid}p`} />
              ) : (
                <MiniArc curve={[]} idBase={`${uid}p`} />
              )}
            </div>
            <span className="cross-arc-cell-label">prev</span>
          </div>

          <span className="cross-arc-connector" aria-hidden="true">→</span>

          {/* Current chapter cell — visually emphasised */}
          <div className="cross-arc-cell cross-arc-cell--current">
            <div className="cross-arc-graph">
              <MiniArc curve={currA.tensionCurve} idBase={`${uid}c`} isCurrent />
            </div>
            <span className="cross-arc-cell-label">current</span>
          </div>

          <span className="cross-arc-connector" aria-hidden="true">→</span>

          {/* Next chapter cell */}
          <div className="cross-arc-cell">
            <div className="cross-arc-graph">
              {nextA ? (
                <MiniArc curve={nextA.tensionCurve} idBase={`${uid}n`} />
              ) : (
                <MiniArc curve={[]} idBase={`${uid}n`} />
              )}
            </div>
            <span className="cross-arc-cell-label">next</span>
          </div>
        </div>

        {(goneChars.length > 0 || incomingChars.length > 0) && (
          <>
            <div className="wg-divider" />
            <div className="cross-arc-cast">
              {goneChars.length > 0 && (
                <span className="cross-arc-cast-line">
                  <span className="cross-arc-cast-key">gone</span>
                  <span className="cross-arc-cast-val">
                    {goneChars.slice(0, 3).map(c => c.name).join(", ")}
                  </span>
                </span>
              )}
              {incomingChars.length > 0 && (
                <span className="cross-arc-cast-line">
                  <span className="cross-arc-cast-key">incoming</span>
                  <span className="cross-arc-cast-val">
                    {incomingChars.slice(0, 3).map(c => c.name).join(", ")}
                  </span>
                </span>
              )}
            </div>
          </>
        )}

        {!prevA && !nextA && (
          <div className="cross-arc-hint">
            Visit adjacent chapters to populate the cross-arc view.
          </div>
        )}
      </div>
    </WidgetCard>
  );
}
