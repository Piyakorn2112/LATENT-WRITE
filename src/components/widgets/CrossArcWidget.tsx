import { useId } from "react";
import { ChevronRight, ArrowLeft, ArrowRight, Sparkles } from "lucide-react";
import type { ChapterAnalysisResult } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";

// ── Sparkline helpers (shared with TensionWidget; kept inline so the
// cross-arc cells stay self-contained at small sizes) ──────────────────
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

// Dark-mode-tuned tension colours — same palette family as the rest of
// the dark-widget refresh (rose / amber / slate at the 400 tier).
function tColor(v: number): string {
  return v >= 0.85 ? "#fb7185" : v >= 0.35 ? "#fbbf24" : "#94a3b8";
}

// Per-tension cell tint. Reads as "what energy zone is this chapter in"
// at a glance — calm cells tinted slate-blue, rising amber, high rose.
// Subtle (≤ 8% alpha) so the sparkline is the eye's first-stop, not the
// background colour.
const PEAK_TINT: Record<string, { bg: string; border: string; label: string }> = {
  calm:     { bg: "rgba(148, 163, 184, 0.05)", border: "rgba(148, 163, 184, 0.18)", label: "rgba(148, 163, 184, 0.92)" },
  rising:   { bg: "rgba(251, 191, 36, 0.08)",  border: "rgba(251, 191, 36, 0.22)",  label: "rgba(251, 191, 36, 0.95)"  },
  high:     { bg: "rgba(251, 113, 133, 0.10)", border: "rgba(251, 113, 133, 0.28)", label: "rgba(251, 113, 133, 0.95)" },
};

// 3-chapter peak-pattern → colour. Energy-grouped: high-tension shapes
// run rose, mixed/transitional run amber, low-tension run blue. Same
// thinking as PEAK_TINT — the colour is doing semantic work (energy
// class), not decoration.
const PATTERN_META: Record<string, { color: string; label: string }> = {
  "sustained":         { color: "#fb7185", label: "Sustained"        },
  "tension & release": { color: "#fb923c", label: "Tension & Release"},
  "peak and fall":     { color: "#fb923c", label: "Peak & Fall"      },
  "building peak":     { color: "#fb923c", label: "Building Peak"    },
  "breather window":   { color: "#60a5fa", label: "Breather"         },
  "escalating":        { color: "#fb7185", label: "Escalating"       },
  "descending":        { color: "#60a5fa", label: "Descending"       },
  "plateau":           { color: "#94a3b8", label: "Plateau"          },
  "accelerating":      { color: "#fb7185", label: "Accelerating"     },
  "decompressing":     { color: "#60a5fa", label: "Decompressing"    },
};

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

// ── Mini-arc — sparkline with peak pip, tinted cell background ────────
interface MiniArcProps {
  curve: number[];
  idBase: string;
  isCurrent?: boolean;
}

function MiniArc({ curve, idBase, isCurrent = false }: MiniArcProps) {
  const W = 100;
  const H = isCurrent ? 36 : 28;
  const PAD_Y = 4;
  const plotH = H - 2 * PAD_Y;

  if (curve.length < 2) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}
           preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1={H / 2} x2={W} y2={H / 2}
              stroke="rgba(255,255,255,0.10)" strokeWidth="1"
              strokeDasharray="2 3" />
      </svg>
    );
  }

  const pts: [number, number][] = curve.map((raw, i) => {
    // Mild gamma so peaks read with more drama at small sizes.
    const v = Math.pow(raw, 1.2);
    return [(i / (curve.length - 1)) * W, H - PAD_Y - v * plotH];
  });
  const linePath = catmullRomPath(pts);
  const fillPath = `${linePath} L${W},${H} L0,${H} Z`;

  // Locate the chapter's peak — first occurrence of max — for the pip.
  const maxV = Math.max(...curve);
  const peakIdx = curve.findIndex((v) => v === maxV);
  const peakPt = peakIdx >= 0 ? pts[peakIdx] : null;
  const peakColor = tColor(maxV);

  const lineId = `${idBase}-l`;
  const fillId = `${idBase}-f`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}
         preserveAspectRatio="none" aria-hidden="true"
         style={{ overflow: "visible" }}>
      <defs>
        <linearGradient id={lineId} x1="0%" y1="0%" x2="100%" y2="0%">
          {pts.map((_, i) => (
            <stop key={i}
                  offset={`${((i / (pts.length - 1)) * 100).toFixed(1)}%`}
                  stopColor={tColor(curve[i])} />
          ))}
        </linearGradient>
        <linearGradient id={fillId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor={peakColor} stopOpacity={isCurrent ? "0.30" : "0.18"} />
          <stop offset="100%" stopColor={peakColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill={`url(#${fillId})`} />
      <path d={linePath} fill="none" stroke={`url(#${lineId})`}
            strokeWidth={isCurrent ? 1.9 : 1.4}
            strokeLinecap="round" strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            opacity={isCurrent ? 1 : 0.86} />
      {/* Peak pip — small ring + dot at the chapter's peak. Smaller than
          TensionWidget's pin (no vertical hairline) since the cell is
          tiny; the pip alone communicates "the peak is here" without
          dominating the cell. */}
      {peakPt && (
        <>
          <circle cx={peakPt[0]} cy={peakPt[1]}
                  r={isCurrent ? 2.4 : 1.8}
                  fill={peakColor} opacity={0.32} />
          <circle cx={peakPt[0]} cy={peakPt[1]}
                  r={isCurrent ? 1.4 : 1.1}
                  fill={peakColor} />
        </>
      )}
    </svg>
  );
}

interface Props {
  current: ChapterAnalysisResult;
  prev: ChapterAnalysisResult | null;
  next: ChapterAnalysisResult | null;
}

/**
 * CrossArcWidget — three-chapter arc context. HI redesign over the
 * earlier flat sparkline row:
 *
 *   • Pattern label is a tinted pill placed prominently above the row
 *     (red for high-energy patterns, amber for transitional, blue for
 *     decompressing/breather, slate for plateau).
 *   • Each chapter cell tinted by its peak-tension energy band (calm /
 *     rising / high) so the energy class is encoded TWICE — in the
 *     cell wash and in the curve itself. Reduces eye-jump between
 *     legend and chart.
 *   • Each sparkline carries a peak pip at the chapter's peak point —
 *     small ring + dot, same idiom as TensionWidget's peak pin scaled
 *     down for the small cells.
 *   • Cast continuity uses chip rows with directional arrows (← gone,
 *     → incoming) instead of the previous key/value text rows.
 *   • Empty state gets a quiet hint with an icon.
 */
export function CrossArcWidget({ current, prev, next }: Props) {
  const uid = useId().replace(/:/g, "_");

  const currA = current.analysis;
  const prevA = prev?.analysis ?? null;
  const nextA = next?.analysis ?? null;

  const crossKey = prevA && nextA
    ? `${prevA.peakTension}-${currA.peakTension}-${nextA.peakTension}`
    : null;
  const patternKey = crossKey ? CROSS_PATTERN[crossKey] : null;
  const patternMeta = patternKey ? PATTERN_META[patternKey] : null;

  // Cast continuity (same logic as before, just now consumed by chips).
  const currCast = new Set(currA.speakerCounts.map(c => c.name.toLowerCase()));
  const filterReal = (s: { name: string; turns: number }) =>
    s.turns >= 3 && s.name.toLowerCase() !== "narration" && s.name.toLowerCase() !== "unknown";
  const goneChars = (prevA?.speakerCounts ?? [])
    .filter(filterReal).filter(s => !currCast.has(s.name.toLowerCase()));
  const incomingChars = (nextA?.speakerCounts ?? [])
    .filter(filterReal).filter(s => !currCast.has(s.name.toLowerCase()));

  // Cell tints by peak tension band.
  const prevTint = prevA ? PEAK_TINT[prevA.peakTension] : PEAK_TINT.calm;
  const currTint = PEAK_TINT[currA.peakTension] ?? PEAK_TINT.calm;
  const nextTint = nextA ? PEAK_TINT[nextA.peakTension] : PEAK_TINT.calm;

  const accent = patternMeta?.color ?? "#7dd8ff";

  return (
    <WidgetCard
      bg="#0d1729"
      accent={accent}
      heroAlign="start"
      topLeft="CROSS-ARC"
      topRight={
        prevA && nextA
          ? `${prevA.peakTension} → ${currA.peakTension} → ${nextA.peakTension}`
          : "ARC RELATION"
      }
    >
      <div className="wg-content">
        {/* Pattern badge — front-and-centre when both neighbours are
            cached, otherwise hidden so the empty state can speak. */}
        {patternMeta && (
          <div className="wg-cross-pattern-row">
            <span
              className="wg-cross-pattern-pill"
              style={{
                color: patternMeta.color,
                borderColor: `${patternMeta.color}55`,
                background: `${patternMeta.color}12`,
              }}
            >
              <Sparkles size={11} strokeWidth={2.4} />
              <span>{patternMeta.label}</span>
            </span>
          </div>
        )}

        {/* Three-cell sparkline row */}
        <div className="wg-cross-row">
          <div
            className={`wg-cross-cell ${prevA ? "" : "wg-cross-cell--empty"}`}
            style={prevA ? {
              background: prevTint.bg,
              borderColor: prevTint.border,
            } : undefined}
          >
            <span className="wg-cross-cell-key">prev</span>
            <div className="wg-cross-graph">
              <MiniArc
                curve={prevA?.tensionCurve ?? []}
                idBase={`${uid}p`}
              />
            </div>
            <span
              className="wg-cross-cell-tension"
              style={prevA ? { color: prevTint.label } : undefined}
            >
              {prevA?.peakTension ?? "—"}
            </span>
          </div>

          <span className="wg-cross-arrow" aria-hidden="true">
            <ChevronRight size={14} strokeWidth={2.4} />
          </span>

          <div
            className="wg-cross-cell wg-cross-cell--current"
            style={{
              background: currTint.bg,
              borderColor: currTint.border,
              boxShadow: `inset 0 0 0 1px ${currTint.border}`,
            }}
          >
            <span className="wg-cross-cell-key wg-cross-cell-key--current">
              current
            </span>
            <div className="wg-cross-graph">
              <MiniArc curve={currA.tensionCurve} idBase={`${uid}c`} isCurrent />
            </div>
            <span
              className="wg-cross-cell-tension"
              style={{ color: currTint.label }}
            >
              {currA.peakTension}
            </span>
          </div>

          <span className="wg-cross-arrow" aria-hidden="true">
            <ChevronRight size={14} strokeWidth={2.4} />
          </span>

          <div
            className={`wg-cross-cell ${nextA ? "" : "wg-cross-cell--empty"}`}
            style={nextA ? {
              background: nextTint.bg,
              borderColor: nextTint.border,
            } : undefined}
          >
            <span className="wg-cross-cell-key">next</span>
            <div className="wg-cross-graph">
              <MiniArc
                curve={nextA?.tensionCurve ?? []}
                idBase={`${uid}n`}
              />
            </div>
            <span
              className="wg-cross-cell-tension"
              style={nextA ? { color: nextTint.label } : undefined}
            >
              {nextA?.peakTension ?? "—"}
            </span>
          </div>
        </div>

        {/* Cast continuity — visual flow rows with directional arrows */}
        {(goneChars.length > 0 || incomingChars.length > 0) && (
          <>
            <div className="wg-divider" />
            <div className="wg-cross-cast">
              {goneChars.length > 0 && (
                <div className="wg-cross-cast-row">
                  <span className="wg-cross-cast-key">
                    <ArrowLeft size={10} strokeWidth={2.4} />
                    <span>gone</span>
                  </span>
                  <div className="wg-cross-cast-chips">
                    {goneChars.slice(0, 4).map((c) => (
                      <span key={c.name} className="wg-cross-cast-chip wg-cross-cast-chip--gone">
                        {c.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {incomingChars.length > 0 && (
                <div className="wg-cross-cast-row">
                  <span className="wg-cross-cast-key wg-cross-cast-key--in">
                    <ArrowRight size={10} strokeWidth={2.4} />
                    <span>incoming</span>
                  </span>
                  <div className="wg-cross-cast-chips">
                    {incomingChars.slice(0, 4).map((c) => (
                      <span key={c.name} className="wg-cross-cast-chip wg-cross-cast-chip--in">
                        {c.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {!prevA && !nextA && (
          <div className="wg-cross-hint">
            <Sparkles size={11} strokeWidth={2.4} style={{ opacity: 0.55 }} />
            <span>Visit adjacent chapters to populate the cross-arc view.</span>
          </div>
        )}
      </div>
    </WidgetCard>
  );
}
