import { useId, useMemo } from "react";
import { TrendingUp, TrendingDown, Mountain, Activity, MapPin, Anchor } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ChapterAnalysis } from "../../lib/use-analysis";
import type { ChapterParaResult } from "../../lib/speech-detect";
import { cliffhangerScore } from "../../lib/character-voice";
import { WidgetCard } from "./WidgetCard";

const ARC_LABEL: Record<string, string> = {
  "slope-up": "Rising", "slope-down": "Falling", "plateau-high": "Sustained",
  "spike": "Spike", "double-peak": "Two Peaks", "valley": "Valley", "flat": "Flat",
};

// Per-arc-shape glyph — encodes the shape silhouette in an icon so the
// arc-shape badge reads at a glance even before the label.
const ARC_ICON: Record<string, LucideIcon> = {
  "slope-up":     TrendingUp,
  "slope-down":   TrendingDown,
  "plateau-high": Activity,
  "spike":        Mountain,
  "double-peak":  Mountain,
  "valley":       MapPin,
  "flat":         Anchor,
};

const TENSION_FILL: Record<string, number> = { calm: 1, rising: 3, high: 4, sustained: 5 };
const TENSION_COLOR: Record<string, string> = {
  calm: "#94a3b8", rising: "#fbbf24", high: "#f43f5e", sustained: "#f43f5e",
};

function tColor(v: number): string {
  return v >= 0.85 ? "#f43f5e" : v >= 0.35 ? "#fbbf24" : "#94a3b8";
}

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

interface TensionProps {
  analysis: ChapterAnalysis;
  /** Optional — when supplied, the widget computes a chapter-ending
   *  "cliffhanger" lift score and shows it in the bottom action line. */
  paragraphs?: string[];
  speechResults?: ChapterParaResult[];
}

const CLIFF_COLOR: Record<"soft" | "lift" | "hook", string> = {
  soft: "#94a3b8",
  lift: "#fbbf24",
  hook: "#f43f5e",
};

export function TensionWidget({ analysis, paragraphs, speechResults }: TensionProps) {
  const uid = useId().replace(/:/g, "_");
  const { tensionCurve, peakTension, arcShape, peakLabel, guidance } = analysis;
  const segs = analysis.highModeAnalysis?.microStructure ?? [];
  const momentum = analysis.highModeAnalysis?.narrativeMomentum;

  // Cliffhanger score is a cheap derivative of paragraph-level tension —
  // memoise so it doesn't recompute on unrelated re-renders. Only compute
  // when paragraphs + speechResults are provided.
  const cliff = useMemo(() => {
    if (!paragraphs || !speechResults) return null;
    if (paragraphs.length < 4) return null;
    return cliffhangerScore(paragraphs, speechResults);
  }, [paragraphs, speechResults]);

  const W = 440, H = 84, PAD_X = 6, PAD_Y = 14;
  const plotH = H - PAD_Y * 2;

  const pts: [number, number][] = tensionCurve.length >= 2
    ? tensionCurve.map((v, i) => [
        PAD_X + (i / (tensionCurve.length - 1)) * (W - PAD_X * 2),
        (H - PAD_Y) - v * plotH,
      ])
    : [];

  const linePath = pts.length >= 2 ? catmullRomPath(pts) : null;
  const fillPath = linePath
    ? `${linePath} L${W - PAD_X},${H - PAD_Y} L${PAD_X},${H - PAD_Y} Z`
    : null;

  const peakVal = tensionCurve.length > 0 ? Math.max(...tensionCurve) : 0;
  const peakColor = tColor(peakVal);
  const lineGradId = `tl-${uid}`;
  const fillGradId = `tf-${uid}`;

  // Locate the peak point so we can pin a marker above it. When multiple
  // points tie at peak we use the FIRST occurrence — matches the writer's
  // reading-order intuition ("where does it first hit max").
  const peakIdx = tensionCurve.length > 0
    ? tensionCurve.findIndex((v) => v === peakVal)
    : -1;
  const peakPt = peakIdx >= 0 && pts[peakIdx] ? pts[peakIdx] : null;

  // Calm/rising/high zone bands — drawn as faint horizontal guides at
  // the 0.35 and 0.85 thresholds (the same thresholds tColor() uses).
  // The eye uses these to immediately classify any point on the curve
  // without having to compare it to a remembered legend.
  const yRising = (H - PAD_Y) - 0.35 * plotH;
  const yHigh = (H - PAD_Y) - 0.85 * plotH;

  const momentumColors: Record<string, string> = {
    stuck: "#94a3b8", progressing: "#38bdf8", accelerating: "#34d399",
  };

  return (
    <WidgetCard bg="#0c1220" accent="#94a3b8" heroAlign="start"
      topLeft="TENSION ARC" topRight={peakTension.toUpperCase()}
    >
      <div className="wg-content">
        {/* Sparkline — the hero. The chart is the chapter at a glance,
            so it gets the most pixels. Layered structure (back→front):
              · Two faint guide lines at the rising/high thresholds
                (0.35 / 0.85), so any point reads its zone instantly
              · Soft fill gradient under the curve (peak-coloured)
              · The curve itself, gradient-stroked by per-point tension
              · A peak pin: vertical hairline + a small filled circle
                at the chapter's first peak — that's the data the writer
                most cares about ("where does this hit hardest")
            All of it data-bound — no decorative elements. */}
        {linePath ? (
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}
            preserveAspectRatio="none"
            className="wg-tension-chart"
            style={{ overflow: "visible", display: "block", marginBottom: 6 }}>
            <defs>
              <linearGradient id={lineGradId} x1="0%" y1="0%" x2="100%" y2="0%">
                {tensionCurve.map((v, i) => (
                  <stop key={i}
                    offset={`${((i / (tensionCurve.length - 1)) * 100).toFixed(1)}%`}
                    stopColor={tColor(v)} />
                ))}
              </linearGradient>
              <linearGradient id={fillGradId} x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor={peakColor} stopOpacity="0.26" />
                <stop offset="100%" stopColor={peakColor} stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* Threshold guides — faint dotted reference lines, exactly
                where the colour transitions happen on the gradient. */}
            <line x1={PAD_X} y1={yRising} x2={W - PAD_X} y2={yRising}
              stroke="rgba(255, 255, 255, 0.07)" strokeWidth="0.8"
              strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
            <line x1={PAD_X} y1={yHigh} x2={W - PAD_X} y2={yHigh}
              stroke="rgba(244, 63, 94, 0.16)" strokeWidth="0.8"
              strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />

            {fillPath && <path d={fillPath} fill={`url(#${fillGradId})`} />}
            <path d={linePath} fill="none" stroke={`url(#${lineGradId})`}
              strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
              vectorEffect="non-scaling-stroke" />

            {/* Peak pin — vertical hairline drops from the curve to the
                baseline, so the reader can scan straight down to the
                "where" axis without losing the y-position. */}
            {peakPt && (
              <>
                <line
                  x1={peakPt[0]} y1={peakPt[1] + 1}
                  x2={peakPt[0]} y2={H - PAD_Y}
                  stroke={peakColor} strokeWidth="0.8"
                  strokeDasharray="1.5 2"
                  opacity="0.45"
                  vectorEffect="non-scaling-stroke"
                />
                {/* Outer ring (glow halo via larger semi-transparent
                    circle) + crisp dot. Stays inside the chart bounds
                    via the increased PAD_Y above. */}
                <circle cx={peakPt[0]} cy={peakPt[1]} r="3.4"
                  fill={peakColor} opacity="0.28" />
                <circle cx={peakPt[0]} cy={peakPt[1]} r="2.1"
                  fill={peakColor} stroke="#0c1220" strokeWidth="0.8" />
              </>
            )}
          </svg>
        ) : (
          <div style={{ height: H, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "#94a3b8", opacity: 0.3, fontSize: 24 }}>—</span>
          </div>
        )}

        {/* Arc-shape badge + peak position track. The shape glyph turns
            the abstract "arcShape" classification into an at-a-glance
            silhouette; the tiny inline track encodes peak position
            without forcing the eye to read "peak ~78%". */}
        <div className="wg-tension-meta">
          <span className="wg-arc-badge"
            style={{
              color: peakColor,
              borderColor: `${peakColor}55`,
              background: `${peakColor}10`,
            }}>
            {(() => {
              const ArcGlyph = ARC_ICON[arcShape] ?? Activity;
              return <ArcGlyph size={11} strokeWidth={2.4} />;
            })()}
            <span>{ARC_LABEL[arcShape] ?? arcShape}</span>
          </span>

          {guidance.peakPosition != null && (
            <span className="wg-tension-peakloc">
              <span className="wg-tension-peakloc-key">PEAK</span>
              <span className="wg-tension-peakloc-track" aria-hidden="true">
                <span
                  className="wg-tension-peakloc-fill"
                  style={{ width: `${guidance.peakPosition}%`, background: peakColor }}
                />
                <span
                  className="wg-tension-peakloc-pip"
                  style={{ left: `${guidance.peakPosition}%`, background: peakColor }}
                />
              </span>
              <span className="wg-tension-peakloc-num"
                style={{ color: peakColor }}>
                {guidance.peakPosition}%
              </span>
            </span>
          )}

          {peakLabel && (
            <span className="wg-tension-peaklabel">{peakLabel}</span>
          )}
        </div>

        {/* Structure segments (high mode) — redesigned as a horizontal
            stack of compact tiles. Each tile shows: the segment label,
            a 5-cell tension dot row, and the momentum score (when
            present). The horizontal layout reads as a chapter shape,
            not a generic list. */}
        {segs.length > 0 && (
          <>
            <div className="wg-divider" />
            <div className="wg-tension-segs">
              {segs.map(seg => {
                const tc = TENSION_COLOR[seg.tensionProfile] ?? "#94a3b8";
                const fill = TENSION_FILL[seg.tensionProfile] ?? 1;
                const mom = momentum?.segments.find(m => m.label === seg.label);
                const momColor = mom ? (momentumColors[mom.trend] ?? "#94a3b8") : "#94a3b8";
                return (
                  <div key={seg.label} className="wg-tension-seg-tile">
                    <span className="wg-tension-seg-label">
                      {seg.label.replace("-section", "")}
                    </span>
                    <div className="wg-tension-seg-cells">
                      {[0,1,2,3,4].map(i => (
                        <span key={i} className="wg-tension-seg-cell"
                          style={i < fill ? {
                            background: tc,
                            boxShadow: `0 0 4px ${tc}88`,
                          } : undefined} />
                      ))}
                    </div>
                    <span className="wg-tension-seg-tension" style={{ color: tc }}>
                      {seg.tensionProfile}
                    </span>
                    {mom && (
                      <span className="wg-tension-seg-mom" style={{ color: momColor }}>
                        {Math.round(mom.score * 100)}%
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {momentum?.overall && (
              <div className="wg-tension-overall">
                <span>overall</span>
                <span className="wg-tension-overall-val">{momentum.overall}</span>
                {momentum.hasFakePeak && (
                  <span className="wg-tension-overall-warn">fake-peak</span>
                )}
              </div>
            )}
          </>
        )}

        {/* Cliffhanger — redesigned from a text + percentage line into a
            visual mini-meter. The bar reads "how strong is the hook?" in
            one glance; the label disambiguates the band (soft / lift /
            hook). Lives at the bottom because it's a *chapter-end*
            metric — semantically the closing note. */}
        {cliff && (
          <>
            <div className="wg-divider" />
            <div className="wg-tension-cliff">
              <span className="wg-tension-cliff-key">CLIFFHANGER</span>
              <span className="wg-tension-cliff-track" aria-hidden="true">
                <span className="wg-tension-cliff-fill"
                  style={{
                    width: `${Math.round(cliff.score * 100)}%`,
                    background: CLIFF_COLOR[cliff.label],
                  }} />
              </span>
              <span className="wg-tension-cliff-pill"
                style={{
                  color: CLIFF_COLOR[cliff.label],
                  borderColor: `${CLIFF_COLOR[cliff.label]}55`,
                }}>
                {cliff.label}
              </span>
              <span className="wg-tension-cliff-num"
                style={{ color: CLIFF_COLOR[cliff.label] }}>
                {Math.round(cliff.score * 100)}
              </span>
            </div>
            <div className="wg-action-line" style={{ marginTop: 6 }}>
              {cliff.note}
            </div>
          </>
        )}
      </div>
    </WidgetCard>
  );
}
