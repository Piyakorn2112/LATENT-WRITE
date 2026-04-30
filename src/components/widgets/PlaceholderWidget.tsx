import { WidgetCard } from "./WidgetCard";

export type PlaceholderVariant = "empty" | "processing";

/** Concentric pulsing rings — the "system is sensing" hero illustration.
 *  CSS animations on each ring stagger the pulse outward. */
function RadarDeco({ accent }: { accent: string }) {
  return (
    <svg viewBox="0 0 200 120" fill="none">
      <circle cx="100" cy="60" r="22" stroke={accent} strokeWidth="1" opacity="0.30"
        className="placeholder-ring placeholder-ring--1" />
      <circle cx="100" cy="60" r="38" stroke={accent} strokeWidth="1" opacity="0.20"
        className="placeholder-ring placeholder-ring--2" />
      <circle cx="100" cy="60" r="56" stroke={accent} strokeWidth="1" opacity="0.12"
        className="placeholder-ring placeholder-ring--3" />
    </svg>
  );
}

/** Empty page lines — descending text-like strokes for the "blank slate" hero. */
function EmptyDeco({ accent }: { accent: string }) {
  return (
    <svg viewBox="0 0 200 120" fill="none">
      {[
        { y: 26, w: 110 },
        { y: 44, w: 92  },
        { y: 62, w: 124 },
        { y: 80, w: 78  },
        { y: 98, w: 56  },
      ].map(({ y, w }, i) => (
        <line key={y} x1="40" y1={y} x2={40 + w} y2={y}
          stroke={accent} strokeWidth="1.5" strokeLinecap="round"
          opacity={0.30 - i * 0.04} />
      ))}
    </svg>
  );
}

interface Props { variant: PlaceholderVariant }

export function PlaceholderWidget({ variant }: Props) {
  if (variant === "processing") {
    return (
      <WidgetCard
        bg="#10243a" accent="#7dd8ff"
        topLeft="ANALYSIS" topRight="LIVE"
        bottomLeft="Reading paragraphs"
        bottomRight="Finding tension"
        deco={<RadarDeco accent="rgba(125,216,255,0.55)" />}
      >
        <div className="widget-role-hero placeholder-hero">
          <div className="widget-glow" style={{ background: "#7dd8ff", opacity: 0.55 }} />
          <span className="placeholder-pulse">
            <span className="placeholder-pulse-dot" />
            <span className="placeholder-pulse-dot" />
            <span className="placeholder-pulse-dot" />
          </span>
        </div>
      </WidgetCard>
    );
  }
  return (
    <WidgetCard
      bg="#1d2030" accent="#9098a8"
      topLeft="ANALYSIS" topRight="EMPTY"
      bottomLeft="Start writing"
      bottomRight="Widgets appear when ready"
      deco={<EmptyDeco accent="rgba(160,170,190,0.45)" />}
    >
      <div className="widget-role-hero placeholder-hero">
        <div className="widget-glow" style={{ background: "#9098a8", opacity: 0.25 }} />
        <span className="placeholder-cursor" aria-hidden />
      </div>
    </WidgetCard>
  );
}
