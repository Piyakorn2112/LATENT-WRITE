import { memo, useMemo } from "react";
import { AudioWaveform } from "lucide-react";
import { WidgetCard } from "./WidgetCard";

/**
 * Sentence-rhythm widget — visualises the chapter's prose as a beat
 * histogram, one bar per sentence, height = word count. The variance
 * of those bar heights is the "rhythm score": low variance reads as
 * monotonous prose, high variance as a varied cadence.
 *
 * Design choices:
 *   • Bars are coloured by length-bucket (short / medium / long /
 *     very-long), so the row reads like an audio waveform with the
 *     occasional bright peak — same spirit as the AQI rainbow gauge in
 *     the reference image, where the colour itself carries data.
 *   • A subtle "median" baseline crosses the bars so the user can spot
 *     deviations at a glance.
 *   • Below the histogram: variance score, average length, and the
 *     longest sentence's word count.
 *
 * No new analysis runs — sentence splitting reuses the lightweight
 * regex pattern already in use elsewhere (StyleWatchWidget, etc.).
 */

interface Props {
  content: string;
}

const BUCKET_COLOR = {
  short:  "#34d399", // ≤8 words   — punchy
  medium: "#5ab8e0", // 9–18 words — natural
  long:   "#fbbf24", // 19–30      — getting heavy
  xl:     "#f43f5e", // 31+        — very long
};

function bucketOf(n: number): keyof typeof BUCKET_COLOR {
  if (n <= 8) return "short";
  if (n <= 18) return "medium";
  if (n <= 30) return "long";
  return "xl";
}

function splitSentences(text: string): string[] {
  const out: string[] = [];
  // Sentences end at .!? optionally followed by a closing quote/paren,
  // then whitespace or end-of-string. Same pattern as auto-paragraph.
  const re = /[^.!?]+[.!?]+(?:['")\]’”]?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  // Trailing fragment without terminal punctuation.
  if (out.length === 0 && text.trim()) out.push(text.trim());
  return out;
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

// Standard-deviation as the rhythm score. Returned as 0-100 where 100
// is "very varied" — empirically a fiction chapter with healthy rhythm
// scores ~40-65; <25 reads as monotonous, >75 as erratic.
function rhythmScore(lengths: number[]): number {
  if (lengths.length < 2) return 0;
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((s, n) => s + (n - mean) ** 2, 0) / lengths.length;
  const stdDev = Math.sqrt(variance);
  // Map stdDev (typical 2-15) onto 0-100. tanh keeps the upper end
  // bounded without a hard cap.
  return Math.round(100 * Math.tanh(stdDev / 12));
}

function rhythmLabel(score: number): { label: string; color: string } {
  if (score < 25) return { label: "MONOTONOUS",   color: "#94a3b8" };
  if (score < 45) return { label: "STEADY",       color: "#5ab8e0" };
  if (score < 70) return { label: "VARIED",       color: "#34d399" };
  return            { label: "RESTLESS",      color: "#fbbf24" };
}

function action(lengths: number[], score: number, longest: number): string | null {
  if (lengths.length < 6) return null;
  if (score < 25) {
    return "Sentences sit in a narrow length band — interleaving a short, sharp beat or a longer descriptive one will lift the rhythm.";
  }
  if (longest > 50) {
    return `One sentence runs ${longest} words — consider breaking it for breath and emphasis.`;
  }
  if (score > 78) {
    return "Lengths swing widely — check if any short fragment is stranded mid-paragraph and would read better fused with a neighbour.";
  }
  return null;
}

function RhythmWidgetImpl({ content }: Props) {
  const data = useMemo(() => {
    const sentences = splitSentences(content);
    const lengths = sentences.map(wordCount).filter((n) => n > 0);
    if (lengths.length === 0) return null;
    const score = rhythmScore(lengths);
    const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const longest = Math.max(...lengths);
    const median = (() => {
      const s = [...lengths].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    })();
    return { lengths, score, avg, longest, median, sentenceCount: lengths.length };
  }, [content]);

  if (!data) return null;
  if (data.sentenceCount < 4) return null;

  const { lengths, score, avg, longest, median, sentenceCount } = data;
  const label = rhythmLabel(score);
  const note = action(lengths, score, longest);

  // Histogram geometry — bar widths shrink for long chapters so the row
  // never spills horizontally. Cap at 80 bars by sampling proportionally
  // (every Nth sentence) so the visual stays readable on huge chapters.
  // Sampled slots also remember the original sentence span so the hover
  // tooltip can name the index range honestly.
  const W = 440;
  const H = 64;
  const MAX_BARS = 80;
  const stride = Math.max(1, Math.ceil(lengths.length / MAX_BARS));
  const sampled: { len: number; from: number; to: number }[] = [];
  for (let i = 0; i < lengths.length; i += stride) {
    let sum = 0;
    let n = 0;
    for (let j = 0; j < stride && i + j < lengths.length; j++) {
      sum += lengths[i + j];
      n++;
    }
    sampled.push({ len: sum / Math.max(1, n), from: i + 1, to: i + n });
  }

  const peak = Math.max(...sampled.map((s) => s.len), 1);
  const barW = W / sampled.length;
  // Inter-bar gap of 22% feels native to iOS widget rhythm (Health app's
  // weekly bars share a similar ratio). Caps min/max so very dense
  // (downsampled) charts don't lose their slot definition.
  const innerBarW = Math.max(1.6, Math.min(barW * 0.78, barW - 1.6));

  // Baseline (median) y — rendered behind the bars as a faint dotted
  // reference. The bars are foreground; everything else recedes.
  const baselineY = H - (median / peak) * H;

  return (
    <WidgetCard
      bg="#0d1117"
      accent={label.color}
      heroAlign="start"
      topLeft="RHYTHM"
      topRight={label.label}
    >
      <div className="wg-content">
        <div className="wg-rhythm-hero">
          <div className="wg-rhythm-stats">
            <div className="wg-rhythm-stat">
              <span className="wg-rhythm-stat-num" style={{ color: label.color }}>
                {score}
              </span>
              <span className="wg-rhythm-stat-key">variance</span>
            </div>
            <span
              className="wg-rhythm-stat-icon"
              style={{ color: label.color }}
              aria-hidden="true"
            >
              <AudioWaveform size={18} strokeWidth={2.4} />
            </span>
          </div>
          <svg
            className="wg-rhythm-chart"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            width="100%"
            height={H}
            role="img"
            aria-label={`Sentence-length histogram, ${sentenceCount} sentences, longest ${longest} words.`}
          >
            {/* Slot tracks — a faint full-height pill behind every bar.
                Encodes the rhythm grid honestly: every sentence has a
                slot, even short ones, so the eye reads the cadence as
                density of presence rather than just "where the colour
                is". This is the spacing/layering move from the Apple-HI
                brief — no extra hue, just depth. */}
            {sampled.map((_, i) => {
              const x = i * barW + (barW - innerBarW) / 2;
              return (
                <rect
                  key={`slot-${i}`}
                  x={x.toFixed(2)}
                  y={1}
                  width={innerBarW.toFixed(2)}
                  height={H - 2}
                  rx={Math.min(2, innerBarW / 2)}
                  fill="rgba(255, 255, 255, 0.04)"
                />
              );
            })}

            {/* Median baseline — chapter's typical sentence length, faint
                dotted reference so deviations read at a glance. */}
            <line
              x1={0}
              y1={baselineY}
              x2={W}
              y2={baselineY}
              stroke="rgba(255, 255, 255, 0.16)"
              strokeWidth={1}
              strokeDasharray="3 4"
            />

            {/* Foreground bars — each rises from the baseline on mount
                with a tiny stagger (12 ms × i) so the chart feels alive
                without looping. Saturation pulled to 0.78 for native
                widget calmness. */}
            {sampled.map((s, i) => {
              const h = Math.max(2.5, (s.len / peak) * H);
              const y = H - h;
              const x = i * barW + (barW - innerBarW) / 2;
              const c = BUCKET_COLOR[bucketOf(s.len)];
              const isPeak = s.len >= peak * 0.99;
              const sentenceLabel =
                s.from === s.to
                  ? `Sentence ${s.from}`
                  : `Sentences ${s.from}–${s.to}`;
              return (
                <g
                  key={`bar-${i}`}
                  className="wg-rhythm-bar"
                  style={{ animationDelay: `${i * 12}ms` }}
                >
                  <title>{`${sentenceLabel} · ${Math.round(s.len)} words`}</title>
                  <rect
                    x={x.toFixed(2)}
                    y={y.toFixed(2)}
                    width={innerBarW.toFixed(2)}
                    height={h.toFixed(2)}
                    rx={Math.min(2, innerBarW / 2)}
                    fill={c}
                    opacity={0.78}
                  />
                  {/* Data-bound highlight: peak (longest) bars get a 1px
                      brighter top cap, calling attention to the
                      chapter's longest sentence(s) without decorating
                      anything that lacks meaning. */}
                  {isPeak && (
                    <rect
                      x={x.toFixed(2)}
                      y={y.toFixed(2)}
                      width={innerBarW.toFixed(2)}
                      height={1.6}
                      rx={Math.min(2, innerBarW / 2)}
                      fill="#fff"
                      opacity={0.62}
                    />
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        <div className="wg-row" style={{ flexWrap: "wrap", gap: 8 }}>
          <span className="wg-stat">
            <span className="wg-stat-num">{Math.round(avg)}</span>
            <span className="wg-stat-key">avg words</span>
          </span>
          <span className="wg-dot-sep">·</span>
          <span className="wg-stat">
            <span className="wg-stat-num">{longest}</span>
            <span className="wg-stat-key">longest</span>
          </span>
          <span className="wg-dot-sep">·</span>
          <span className="wg-stat">
            <span className="wg-stat-num">{sentenceCount}</span>
            <span className="wg-stat-key">sentences</span>
          </span>
        </div>

        {note && (
          <div className="wg-section wg-section-divider">
            <div className="wg-action-line">{note}</div>
          </div>
        )}
      </div>
    </WidgetCard>
  );
}

export const RhythmWidget = memo(RhythmWidgetImpl);
