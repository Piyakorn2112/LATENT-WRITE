import type { ChapterAnalysis } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";

const PROFILE_COLOR: Record<string, string> = {
  calm:      "rgba(125,216,255,0.55)",
  rising:    "rgba(255,180,80,0.65)",
  sustained: "rgba(255,140,90,0.70)",
  high:      "rgba(255,90,90,0.85)",
};

const MOMENTUM_PALETTE: Record<string, { bg: string; accent: string }> = {
  building:    { bg: "#3a1480", accent: "#c0a0ff" },
  fluid:       { bg: "#0f4a4a", accent: "#7adcd0" },
  erratic:     { bg: "#7a2a40", accent: "#ff9bb4" },
  stuck:       { bg: "#352f3c", accent: "#a89eb8" },
};

/** Micro-structure preview — vertical bars per chapter segment, height encodes
 *  tension profile, colour matches the profile. Sits as the deco layer behind
 *  the hero label. */
function MicroStructureDeco({ segments, accent }: {
  segments: { from: number; to: number; tensionProfile: string }[];
  accent: string;
}) {
  return (
    <svg viewBox="0 0 200 120" fill="none" preserveAspectRatio="none">
      {/* baseline track */}
      <line x1="14" y1="100" x2="186" y2="100"
        stroke={accent} strokeWidth="0.8" opacity="0.20" />
      {segments.map((seg, i) => {
        const x = 14 + (seg.from / 100) * 172;
        const w = ((seg.to - seg.from) / 100) * 172;
        const h = seg.tensionProfile === "high"      ? 70
                : seg.tensionProfile === "sustained" ? 54
                : seg.tensionProfile === "rising"    ? 38
                : 22;
        const fill = PROFILE_COLOR[seg.tensionProfile] ?? accent;
        return (
          <rect key={i} x={x + 2} y={100 - h} width={Math.max(w - 4, 8)} height={h}
            rx="4" ry="4" fill={fill} opacity="0.30" />
        );
      })}
    </svg>
  );
}

interface Props { analysis: ChapterAnalysis }

export function DeepAnalysisWidget({ analysis }: Props) {
  const hi = analysis.highModeAnalysis;
  if (!hi || hi.microStructure.length === 0) return null;

  const momentum = hi.narrativeMomentum;
  const palette = MOMENTUM_PALETTE[momentum.overall] ?? MOMENTUM_PALETTE.fluid;
  const heroLabel = momentum.overall.toUpperCase();

  // Prefer the shaping suggestion (intent-based), fall back to momentum note,
  // else the first micro-segment description.
  const note = hi.shapingSuggestion ?? momentum.note ?? hi.microStructure[0].description;
  const shortNote = note.length > 44 ? note.slice(0, 42) + "…" : note;

  const segCount = hi.microStructure.length;

  return (
    <WidgetCard
      bg={palette.bg} accent={palette.accent}
      topLeft="DEEP ANALYSIS" topRight={`${segCount} SEGMENTS`}
      bottomLeft={shortNote}
      bottomRight={momentum.hasFakePeak ? "fake-peak" : ""}
      deco={<MicroStructureDeco segments={hi.microStructure} accent={palette.accent} />}
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
