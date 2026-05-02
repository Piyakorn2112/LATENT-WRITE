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
  // 0 = calm, 1 = rising, 2 = high. Use the canonical peakTension label.
  const p = result.analysis.peakTension;
  return p === "high" ? 2 : p === "rising" ? 1 : 0;
}

function tensionLabel(level: number): string {
  return level === 2 ? "high" : level === 1 ? "rising" : "calm";
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

  // Length anomaly — > 35% deviation from neighbor average.
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

  // Two consecutive high peaks — reader-fatigue risk.
  if (curPeak === 2 && (prevPeak === 2 || nextPeak === 2)) {
    return {
      headline: "Peak Repeat",
      detail:   "Tension peaks high in two consecutive chapters — consider a quieter beat between them so the next peak still lands.",
      accent:   "#f43f5e",
    };
  }

  // Calm-streak — three calm chapters in a row.
  if (curPeak === 0 && prevPeak === 0 && nextPeak === 0) {
    return {
      headline: "Calm Streak",
      detail:   "Three calm chapters in a row — readers may drift. A small turn or revelation here keeps the spine taut.",
      accent:   "#94a3b8",
    };
  }

  // Default: in rhythm.
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

  // Need at least one neighbor to be meaningful.
  if (prev == null && next == null) return null;

  const verdict = deriveVerdict(curWords, prevWords, nextWords, curPeak, prevPeak, nextPeak);
  const max = Math.max(curWords, prevWords ?? 0, nextWords ?? 0, 1);

  const rows: Array<{ label: string; words: number | null; peak: number | null; isCurrent?: boolean }> = [
    { label: "Prev", words: prevWords, peak: prevPeak },
    { label: "This", words: curWords,  peak: curPeak, isCurrent: true },
    { label: "Next", words: nextWords, peak: nextPeak },
  ];

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
          {rows.map((row) => (
            <div className="wg-momentum-row" key={row.label}>
              <div
                className="wg-momentum-label"
                style={row.isCurrent ? { color: "var(--text)" } : undefined}
              >
                {row.label}
              </div>
              <div className="wg-momentum-bar">
                {row.words != null && (
                  <div
                    className="wg-momentum-bar-fill"
                    style={{
                      width: `${Math.max(4, Math.round((row.words / max) * 100))}%`,
                      background: row.isCurrent ? verdict.accent : "#475569",
                      opacity: row.words === 0 ? 0.25 : 1,
                    }}
                  />
                )}
              </div>
              <div
                className="wg-momentum-trend"
                style={{
                  color: row.isCurrent ? verdict.accent : "#94a3b8",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {row.words != null ? `${row.words.toLocaleString()}w` : "—"}
                <span style={{ opacity: 0.5, marginLeft: 6, fontSize: 10 }}>
                  {row.peak != null ? tensionLabel(row.peak) : ""}
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="wg-section wg-section-divider">
          <div className="wg-action-line">{verdict.detail}</div>
        </div>
      </div>
    </WidgetCard>
  );
}
