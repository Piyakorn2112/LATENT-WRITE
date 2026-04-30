import type { ChapterAnalysis } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";

const RHYTHM_PALETTE: Record<string, { bg: string; accent: string; sub: string }> = {
  tight:     { bg: "#0a3858", accent: "#7dc8ff", sub: "Consistent paragraph length" },
  varied:    { bg: "#324078", accent: "#a8b8ff", sub: "Mixed paragraph rhythm" },
  expansive: { bg: "#3a2058", accent: "#d09cff", sub: "Highly variable lengths" },
};

/** Bar-pattern deco — encodes paragraph-length distribution as a left-to-right
 *  rhythm of stacked rectangles. Short paragraphs read as small bars, long as tall. */
function RhythmDeco({ shortRatio, longRatio, accent }: {
  shortRatio: number;  // 0-100 percentage of <30-word paragraphs
  longRatio: number;   // 0-100 percentage of >100-word paragraphs
  accent: string;
}) {
  // Synthesize a 20-bar pattern that respects the short/long distribution.
  const bars: number[] = [];
  for (let i = 0; i < 20; i++) {
    const seed = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
    const r = seed - Math.floor(seed);
    const isShort = r < shortRatio / 100;
    const isLong  = r > 1 - longRatio / 100;
    const h = isShort ? 16 + (r * 8)
            : isLong  ? 72 + (r * 18)
            : 36 + (r * 24);
    bars.push(h);
  }
  return (
    <svg viewBox="0 0 200 120" fill="none">
      {bars.map((h, i) => (
        <rect key={i}
          x={6 + i * 9.4}
          y={108 - h}
          width="6"
          height={h}
          rx="2" ry="2"
          fill={accent}
          opacity={0.15 + (i % 3) * 0.04} />
      ))}
    </svg>
  );
}

interface Props { analysis: ChapterAnalysis }

export function TextureWidget({ analysis }: Props) {
  const hi = analysis.highModeAnalysis;
  if (!hi) return null;

  const tex = hi.proseTexture;
  const palette = RHYTHM_PALETTE[tex.rhythmLabel] ?? RHYTHM_PALETTE.varied;
  const heroLabel = tex.rhythmLabel.toUpperCase();
  const dialogueLabel = `${Math.round(tex.dialogueRatio)}% DIALOGUE`;
  const wordsLabel = `~${Math.round(tex.avgParaWords)} w/para`;

  return (
    <WidgetCard
      bg={palette.bg} accent={palette.accent}
      topLeft="PROSE TEXTURE" topRight={dialogueLabel}
      bottomLeft={palette.sub}
      bottomRight={wordsLabel}
      deco={<RhythmDeco
        shortRatio={tex.shortParaRatio}
        longRatio={tex.longParaRatio}
        accent={palette.accent} />}
    >
      <div className="widget-role-hero">
        <div className="widget-glow" style={{ background: palette.accent }} />
        <span className="widget-hero-label" style={{ color: palette.accent }}>
          {heroLabel}
        </span>
      </div>
    </WidgetCard>
  );
}
