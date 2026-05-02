import { useId, useMemo } from "react";
import type { ChapterAnalysis } from "../../lib/use-analysis";
import type { ChapterParaResult } from "../../lib/speech-detect";
import { cliffhangerScore } from "../../lib/character-voice";
import { WidgetCard } from "./WidgetCard";

const ARC_LABEL: Record<string, string> = {
  "slope-up": "Rising", "slope-down": "Falling", "plateau-high": "Sustained",
  "spike": "Spike", "double-peak": "Two Peaks", "valley": "Valley", "flat": "Flat",
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

  const W = 440, H = 72, PAD_X = 4, PAD_Y = 6;
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

  const momentumColors: Record<string, string> = {
    stuck: "#94a3b8", progressing: "#38bdf8", accelerating: "#34d399",
  };

  return (
    <WidgetCard bg="#0c1220" accent="#94a3b8" heroAlign="start"
      topLeft="TENSION ARC" topRight={peakTension.toUpperCase()}
    >
      <div className="wg-content">
        {/* Sparkline */}
        {linePath ? (
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}
            preserveAspectRatio="none"
            style={{ overflow: "visible", display: "block", marginBottom: 4 }}>
            <defs>
              <linearGradient id={lineGradId} x1="0%" y1="0%" x2="100%" y2="0%">
                {tensionCurve.map((v, i) => (
                  <stop key={i}
                    offset={`${((i / (tensionCurve.length - 1)) * 100).toFixed(1)}%`}
                    stopColor={tColor(v)} />
                ))}
              </linearGradient>
              <linearGradient id={fillGradId} x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor={peakColor} stopOpacity="0.22" />
                <stop offset="100%" stopColor={peakColor} stopOpacity="0" />
              </linearGradient>
            </defs>
            {fillPath && <path d={fillPath} fill={`url(#${fillGradId})`} />}
            <path d={linePath} fill="none" stroke={`url(#${lineGradId})`}
              strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
              vectorEffect="non-scaling-stroke" />
          </svg>
        ) : (
          <div style={{ height: H, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "#94a3b8", opacity: 0.3, fontSize: 24 }}>—</span>
          </div>
        )}

        {/* Arc info row */}
        <div className="wg-row" style={{ marginBottom: segs.length ? 8 : 0 }}>
          <span className="wg-stat-key">{ARC_LABEL[arcShape] ?? arcShape}</span>
          {guidance.peakPosition != null && (
            <>
              <span className="wg-dot-sep">·</span>
              <span className="wg-stat-key">peak ~{guidance.peakPosition}%</span>
            </>
          )}
          {peakLabel && (
            <>
              <span className="wg-dot-sep">·</span>
              <span className="wg-stat-key">{peakLabel}</span>
            </>
          )}
        </div>

        {/* Structure segments (high mode) */}
        {segs.length > 0 && (
          <>
            <div className="wg-divider" />
            <div className="wg-section">
              {segs.map(seg => {
                const tc = TENSION_COLOR[seg.tensionProfile] ?? "#94a3b8";
                const fill = TENSION_FILL[seg.tensionProfile] ?? 1;
                const mom = momentum?.segments.find(m => m.label === seg.label);
                const momColor = mom ? (momentumColors[mom.trend] ?? "#94a3b8") : "#94a3b8";
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
              {momentum?.overall && (
                <div className="wg-seg-overall">
                  <span className="wg-seg-overall-text">
                    overall · {momentum.overall}
                    {momentum.hasFakePeak ? " · ⚠ fake-peak" : ""}
                  </span>
                </div>
              )}
            </div>
          </>
        )}

        {/* Cliffhanger meta — appears only when paragraphs are provided. A
            low-key footer keeps the widget legible while still surfacing
            an end-of-chapter hook score. */}
        {cliff && (
          <>
            <div className="wg-divider" />
            <div className="wg-style-meta">
              <span className="wg-style-meta-label">Cliffhanger</span>
              <span className="wg-style-meta-value" style={{ color: CLIFF_COLOR[cliff.label] }}>
                {cliff.label}
              </span>
              <span className="wg-style-meta-sep">·</span>
              <span className="wg-style-meta-value" style={{ color: CLIFF_COLOR[cliff.label] }}>
                {Math.round(cliff.score * 100)}%
              </span>
            </div>
            <div className="wg-action-line" style={{ marginTop: 4 }}>
              {cliff.note}
            </div>
          </>
        )}
      </div>
    </WidgetCard>
  );
}
