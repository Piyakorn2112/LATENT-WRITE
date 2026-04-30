import type { ChapterAnalysis } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";

const DENSITY_COLOR = { light: "#5de0c0", moderate: "#5ab8e0", dense: "#FF7FA5" };
const BG_DENSITY_COLOR = { light: "#086059", moderate: "#086059", dense: "#600833" };

/** Arc gauge — like a speedometer  */
function GaugeDeco({ pct, accent }: { pct: number; accent: string }) {
  const R = 38, cx = 100, cy = 78;
  const startA = -210, sweepDeg = 240;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const arc = (a: number) => ({
    x: cx + R * Math.cos(toRad(a)),
    y: cy + R * Math.sin(toRad(a)),
  });
  const s = arc(startA);
  const e = arc(startA + sweepDeg);
  const fillEnd = arc(startA + sweepDeg * Math.min(pct, 1));
  const largeArc = sweepDeg * pct > 180 ? 1 : 0;
  const color = `rgba(${parseInt(accent.slice(1, 3), 16)},${parseInt(accent.slice(3, 5), 16)},${parseInt(accent.slice(5, 7), 16)},0.3)`;

  return (
    <svg viewBox="0 24 200 100" fill="none">
      {/* track */}
      <path
        d={`M${s.x},${s.y} A${R},${R} 0 1,1 ${e.x},${e.y}`}
        stroke="rgba(255,255,255,0.08)" strokeWidth="5" strokeLinecap="round" fill="none" />
      {/* fill */}
      {pct > 0 && (
        <path
          d={`M${s.x},${s.y} A${R},${R} 0 ${largeArc},1 ${fillEnd.x},${fillEnd.y}`}
          stroke={accent} strokeWidth="5" strokeLinecap="round" fill="none" opacity="0.6" />
      )}
      {/* glow cap */}
      <circle cx={fillEnd.x} cy={fillEnd.y} r="4" fill={color} />
      {/* tick marks */}
      {Array.from({ length: 5 }, (_, i) => {
        const a = startA + (sweepDeg / 4) * i;
        const inner = { x: cx + (R - 6) * Math.cos(toRad(a)), y: cy + (R - 6) * Math.sin(toRad(a)) };
        const outer = { x: cx + (R + 6) * Math.cos(toRad(a)), y: cy + (R + 6) * Math.sin(toRad(a)) };
        return <line key={i} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y}
          stroke="rgba(255,255,255,0.15)" strokeWidth="1" />;
      })}
    </svg>
  );
}

interface Props { analysis: ChapterAnalysis }

export function PacingWidget({ analysis }: Props) {
  const { estimatedMinutes, density, pacingAdvice } = analysis.guidance;
  const accent = DENSITY_COLOR[density] ?? "#5ab8e0";
  const bg = BG_DENSITY_COLOR[density] ?? "#086059"
  // Map reading time to gauge pct: 0 min = 0%, 30 min = 100%
  const gaugePct = Math.min(estimatedMinutes / 30, 1);
  const shortAdvice = pacingAdvice.length > 36 ? pacingAdvice.slice(0, 34) + "…" : pacingAdvice;

  return (
    <WidgetCard bg={bg} accent={accent}
      topLeft="READ TIME" topRight={density.toUpperCase()}
      bottomLeft={shortAdvice}
      deco={<GaugeDeco pct={gaugePct} accent={accent} />}
    >
      <div className="widget-pacing-hero">
        <div className="widget-glow" style={{ background: accent }} />
        <span className="widget-hero-num" style={{ color: accent }}>
          {estimatedMinutes < 1 ? "<1" : estimatedMinutes}
        </span>
        <span className="widget-hero-unit" style={{ color: accent }}>MIN</span>
      </div>
    </WidgetCard>
  );
}
