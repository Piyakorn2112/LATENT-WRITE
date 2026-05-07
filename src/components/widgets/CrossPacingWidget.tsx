import type { ChapterAnalysisResult } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";

interface Props {
  current: ChapterAnalysisResult;
  prev:    ChapterAnalysisResult | null;
  next:    ChapterAnalysisResult | null;
}

function wordCountFromParas(result: ChapterAnalysisResult): number {
  return result.paragraphs.reduce((sum, p) => {
    const trimmed = p.trim();
    if (!trimmed) return sum;
    return sum + trimmed.split(/\s+/).length;
  }, 0);
}

function peakTensionScore(result: ChapterAnalysisResult): number {
  const p = result.analysis.peakTension;
  return p === "high" ? 2 : p === "rising" ? 1 : 0;
}

function tensionLabel(level: number): string {
  return level === 2 ? "high" : level === 1 ? "rising" : "calm";
}

function tensionColor(level: number): string {
  return level === 2 ? "#fb7185" : level === 1 ? "#fbbf24" : "#94a3b8";
}

interface Verdict {
  headline: string;
  detail:   string;
  accent:   string;
}

function deriveVerdict(
  curWords: number,
  prevWords: number | null,
  nextWords: number | null,
  curPeak: number,
  prevPeak: number | null,
  nextPeak: number | null,
): Verdict {
  const neighbors = [prevWords, nextWords].filter((w): w is number => w != null);
  const avgN = neighbors.length > 0
    ? neighbors.reduce((a, b) => a + b, 0) / neighbors.length
    : null;

  if (avgN && curWords > 0) {
    const delta = (curWords - avgN) / avgN;
    if (delta < -0.35) {
      return {
        headline: "Compressed",
        detail:   `${Math.abs(Math.round(delta * 100))}% shorter than neighbours — risk of feeling rushed if the beats here are heavy.`,
        accent:   "#fb923c",
      };
    }
    if (delta > 0.45) {
      return {
        headline: "Sprawling",
        detail:   `${Math.round(delta * 100)}% longer than neighbours — check whether the middle can be trimmed without losing a beat.`,
        accent:   "#fbbf24",
      };
    }
  }

  if (curPeak === 2 && (prevPeak === 2 || nextPeak === 2)) {
    return {
      headline: "Peak Repeat",
      detail:   "Tension peaks high in two consecutive chapters — consider a quieter beat between them so the next peak still lands.",
      accent:   "#f43f5e",
    };
  }

  if (curPeak === 0 && prevPeak === 0 && nextPeak === 0) {
    return {
      headline: "Calm Streak",
      detail:   "Three calm chapters in a row — readers may drift. A small turn or revelation here keeps the spine taut.",
      accent:   "#94a3b8",
    };
  }

  return {
    headline: "In Rhythm",
    detail:   "Length and tension track the surrounding chapters — pacing reads coherent.",
    accent:   "#34d399",
  };
}

export function CrossPacingWidget({ current, prev, next }: Props) {
  const curWords = wordCountFromParas(current);
  const prevWords = prev ? wordCountFromParas(prev) : null;
  const nextWords = next ? wordCountFromParas(next) : null;
  const curPeak = peakTensionScore(current);
  const prevPeak = prev ? peakTensionScore(prev) : null;
  const nextPeak = next ? peakTensionScore(next) : null;

  if (prev == null && next == null) return null;

  const verdict = deriveVerdict(curWords, prevWords, nextWords, curPeak, prevPeak, nextPeak);
  const max = Math.max(curWords, prevWords ?? 0, nextWords ?? 0, 1);

  const W = 200;
  const H = 38;
  const PAD = 10;
  const PLOT_H = H - PAD * 2;

  const nodeData = [
    { label: "Prev", words: prevWords, peak: prevPeak, x: PAD + 6,       isCurrent: false },
    { label: "This", words: curWords,  peak: curPeak,  x: W / 2,         isCurrent: true  },
    { label: "Next", words: nextWords, peak: nextPeak, x: W - PAD - 6,   isCurrent: false },
  ];

  const yFor = (w: number | null) => {
    if (w == null) return PAD + PLOT_H * 0.5;
    return H - PAD - (w / max) * PLOT_H;
  };

  const nodes = nodeData.map((n) => ({
    ...n,
    y: yFor(n.words),
    r: n.isCurrent ? 6 : 4,
    color: n.isCurrent
      ? verdict.accent
      : n.words != null ? tensionColor(n.peak ?? 0) : "#334155",
  }));

  const arcs: React.ReactNode[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (a.words != null && b.words != null) {
      const mx = (a.x + b.x) / 2;
      const d = `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
      arcs.push(
        <path key={i} d={d} fill="none" stroke={verdict.accent}
          strokeWidth="1.2" opacity="0.28" strokeLinecap="round" />
      );
    }
  }

  return (
    <WidgetCard
      bg="#0d1117"
      accent={verdict.accent}
      heroAlign="start"
      topLeft="CROSS-PACING"
      topRight={verdict.headline.toUpperCase()}
    >
      <div className="wg-content">
        <div className="wg-section">
          <svg viewBox={`0 0 ${W} ${H}`} className="wg-phase-arc"
            preserveAspectRatio="xMidYMid meet" aria-hidden="true">
            {arcs}
            {nodes.map((n, i) => (
              <g key={i}>
                <circle cx={n.x} cy={n.y} r={n.r}
                  fill="none" stroke={n.color} strokeWidth="1.3"
                  opacity={n.words != null ? 0.6 : 0.2} />
                <circle cx={n.x} cy={n.y} r={n.isCurrent ? 2.4 : 1.6}
                  fill={n.color}
                  opacity={n.words != null ? 0.88 : 0.25} />
              </g>
            ))}
          </svg>

          <div className="wg-phase-labels">
            {nodes.map((n, i) => (
              <div key={i} className={`wg-phase-label${n.isCurrent ? " wg-phase-label--current" : ""}`}>
                <span className="wg-phase-label-name">{n.label}</span>
                <span className="wg-phase-label-val"
                  style={{ color: n.isCurrent ? verdict.accent : undefined }}>
                  {n.words != null ? `${n.words.toLocaleString()}w` : "—"}
                </span>
                {n.peak != null && (
                  <span className="wg-phase-label-tension"
                    style={{ color: tensionColor(n.peak) }}>
                    {tensionLabel(n.peak)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="wg-section wg-section-divider">
          <div className="wg-action-line">{verdict.detail}</div>
        </div>
      </div>
    </WidgetCard>
  );
}
