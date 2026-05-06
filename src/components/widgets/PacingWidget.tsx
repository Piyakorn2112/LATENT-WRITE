import type { ReactElement } from "react";
import { Clock } from "lucide-react";
import type { ChapterAnalysis } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";

const DENSITY_COLOR = { light: "#5de0c0", moderate: "#5ab8e0", dense: "#FF7FA5" };
const BG_DENSITY_COLOR = { light: "#086059", moderate: "#0a3d6c", dense: "#600833" };

/**
 * Reading-time clock face — a literal clock visualisation rather than a
 * generic dot ring. Reading time is *time*, so the gauge speaks the
 * native language of time: hour ticks at 12/3/6/9 (longer), minute
 * ticks (shorter), and a single coloured minute hand pointing to the
 * estimated minutes value mapped onto a 60-minute clock face.
 *
 * Why not a dot ring like CastWidget: keeping a uniform dial size
 * across widgets while letting each one have its own visual character
 * is the reference style the user pointed to. Time = clock; cast share
 * = ring of segments; sentence rhythm = histogram; etc. Same SIZE
 * family, distinct CHARACTER per data type.
 */
function ClockFace({ minutes, accent }: { minutes: number; accent: string }) {
  const size = 148;
  const half = size / 2;
  const r = half - 8;

  // 60 ticks total — every 5th is an "hour" tick (longer + brighter).
  const ticks: ReactElement[] = [];
  for (let i = 0; i < 60; i++) {
    const angle = (i / 60) * 360 - 90; // 0 minutes = top
    const rad = (angle * Math.PI) / 180;
    const isHour = i % 5 === 0;
    const inner = r - (isHour ? 9 : 4);
    const cx = half;
    const cy = half;
    const x1 = cx + inner * Math.cos(rad);
    const y1 = cy + inner * Math.sin(rad);
    const x2 = cx + r * Math.cos(rad);
    const y2 = cy + r * Math.sin(rad);
    ticks.push(
      <line
        key={i}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={isHour ? "rgba(255, 255, 255, 0.42)" : "rgba(255, 255, 255, 0.14)"}
        strokeWidth={isHour ? 1.8 : 1.1}
        strokeLinecap="round"
      />,
    );
  }

  // Minute hand position. Reading times above 60 are uncommon but if the
  // chapter is genuinely huge we still want the hand to sit somewhere
  // sensible — wrap with mod 60 so a 75-min chapter shows the hand at
  // 15 min position (visually "well past an hour" with a faint outer ring
  // hint we add via a second hand).
  const wrappedMin = ((minutes % 60) + 60) % 60;
  const minuteAngle = (wrappedMin / 60) * 360 - 90;
  const handRad = (minuteAngle * Math.PI) / 180;
  const handLen = r - 18;
  const handX = half + handLen * Math.cos(handRad);
  const handY = half + handLen * Math.sin(handRad);

  // Optional second-pass indicator if minutes overflows 60 — small dot
  // just outside the tick ring at the same angle, signalling "you've
  // wrapped". Keeps the hand readable inside the face while still
  // encoding the overflow data.
  const overflow = minutes >= 60;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {ticks}
      {/* Minute hand */}
      <line
        x1={half}
        y1={half}
        x2={handX}
        y2={handY}
        stroke={accent}
        strokeWidth={3.4}
        strokeLinecap="round"
      />
      {/* Hub */}
      <circle cx={half} cy={half} r={3.5} fill={accent} />
      {overflow && (
        <circle
          cx={half + (r + 4) * Math.cos(handRad)}
          cy={half + (r + 4) * Math.sin(handRad)}
          r={2}
          fill={accent}
          opacity="0.7"
        />
      )}
    </svg>
  );
}

interface Props {
  analysis: ChapterAnalysis;
}

export function PacingWidget({ analysis }: Props) {
  const { estimatedMinutes, density, pacingAdvice } = analysis.guidance;
  const accent = DENSITY_COLOR[density] ?? "#5ab8e0";
  const bg = BG_DENSITY_COLOR[density] ?? "#0a3d6c";
  const shortAdvice = pacingAdvice.length > 36 ? pacingAdvice.slice(0, 34) + "…" : pacingAdvice;

  return (
    <WidgetCard
      bg={bg}
      accent={accent}
      topLeft="READ TIME"
      topRight={density.toUpperCase()}
      bottomLeft={shortAdvice}
    >
      <div className="widget-pacing-hero">
        <div className="wg-clock-wrap">
          <ClockFace minutes={estimatedMinutes} accent={accent} />
          <div className="wg-clock-center">
            <span className="wg-dial-num" style={{ color: accent }}>
              {estimatedMinutes < 1 ? "<1" : estimatedMinutes}
            </span>
            <span className="wg-dial-unit" style={{ color: accent }}>min</span>
            <span className="wg-dial-icon" style={{ color: accent }}>
              <Clock size={11} strokeWidth={2.4} />
            </span>
          </div>
        </div>
      </div>
    </WidgetCard>
  );
}
