import type { ChapterAnalysis } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";

/** Two overlapping translucent circles — speech/Venn deco */
function SpeechDeco() {
  return (
    <svg viewBox="0 0 200 120" fill="none">
      <circle cx="80"  cy="60" r="40" fill="rgba(123,159,255,0.12)" stroke="rgba(123,159,255,0.25)" strokeWidth="1" />
      <circle cx="124" cy="60" r="40" fill="rgba(123,159,255,0.10)" stroke="rgba(123,159,255,0.20)" strokeWidth="1" />
      {/* overlap highlight */}
      <ellipse cx="102" cy="60" rx="18" ry="28" fill="rgba(123,159,255,0.14)" />
      {/* sound wave lines */}
      {[8, 16, 24].map((r) => (
        <path key={r}
          d={`M${102 - r},${60 - r * 0.7} Q${102},${60 - r} ${102 + r},${60 - r * 0.7}`}
          stroke="rgba(123,159,255,0.2)" strokeWidth="0.8" fill="none" strokeLinecap="round" />
      ))}
    </svg>
  );
}

interface Props { analysis: ChapterAnalysis }

export function DialogueWidget({ analysis }: Props) {
  const speakers = analysis.speakerCounts;
  if (speakers.length === 0) return null;

  const top = speakers[0];
  const second = speakers[1];
  const totalTurns = speakers.reduce((s, sp) => s + sp.turns, 0);

  return (
    <WidgetCard bg="#121ea0" accent="#8aabff"
      topLeft="DIALOGUE" topRight={`${totalTurns} TURNS`}
      bottomLeft={second ? `+ ${second.name}` : ""}
      bottomRight={`${speakers.length} SPEAKER${speakers.length > 1 ? "S" : ""}`}
      deco={<SpeechDeco />}
    >
      <div className="widget-role-hero">
        <div className="widget-glow" style={{ background: "#7b9fff" }} />
        <span className="widget-hero-label" style={{
          color: "#7b9fff",
          fontSize: top.name.length > 8 ? "1rem" : undefined,
        }}>
          {top.name.toUpperCase()}
        </span>
      </div>
    </WidgetCard>
  );
}
