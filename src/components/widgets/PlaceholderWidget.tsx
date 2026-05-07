import { useMemo } from "react";
import { WidgetCard } from "./WidgetCard";

export type PlaceholderVariant = "empty" | "processing";

const SYSTEM_BLUE = "#0A84FF";

const PIP_COLORS = ["#34d399", "#fb923c", "#a78bfa", "#38bdf8"];

const MODE_BG: Record<string, string> = {
  off:     "#0d1117",
  auto:    "#0a1210",
  low:     "#14100a",
  default: "#081220",
  high:    "#100a18",
};

const ORBIT_DEFS = [
  { colorIdx: 0, orbitR: 26, dotR: 3.5, cls: "ph-orbit--1" },
  { colorIdx: 1, orbitR: 40, dotR: 3,   cls: "ph-orbit--2" },
  { colorIdx: 2, orbitR: 26, dotR: 3,   cls: "ph-orbit--3" },
  { colorIdx: 3, orbitR: 40, dotR: 3.5, cls: "ph-orbit--4" },
];

const RINGS = [
  { r: 12, sw: 4,   cls: "ph-ring--1" },
  { r: 24, sw: 4,   cls: "ph-ring--2" },
  { r: 38, sw: 4.5, cls: "ph-ring--3" },
  { r: 54, sw: 5,   cls: "ph-ring--4" },
  { r: 72, sw: 5,   cls: "ph-ring--5" },
  { r: 92, sw: 5,   cls: "ph-ring--6" },
];

function RadarDeco({ pips, orbitAngles }: { pips: string[]; orbitAngles: number[] }) {
  const cx = 100, cy = 60;

  return (
    <svg viewBox="0 0 200 120" fill="none">
      {RINGS.map((ring, i) => (
        <circle key={i} cx={cx} cy={cy} r={ring.r}
          stroke={SYSTEM_BLUE} strokeWidth={ring.sw}
          fill="none" className={`ph-ring ${ring.cls}`} />
      ))}

      {ORBIT_DEFS.map((orb, i) => {
        const rad = (orbitAngles[i] ?? 0) * Math.PI / 180;
        return (
          <g key={i} className={`ph-orbit ${orb.cls}`}
            style={{ transformOrigin: `${cx}px ${cy}px` }}>
            <circle
              cx={cx + orb.orbitR * Math.cos(rad)}
              cy={cy + orb.orbitR * Math.sin(rad)}
              r={orb.dotR} fill={pips[orb.colorIdx]}
            />
          </g>
        );
      })}
    </svg>
  );
}

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

interface Props {
  variant: PlaceholderVariant;
  intelMode?: string;
}

export function PlaceholderWidget({ variant, intelMode }: Props) {
  const orbitAngles = useMemo(
    () => ORBIT_DEFS.map(() => Math.floor(Math.random() * 360)),
    [],
  );

  if (variant === "processing") {
    const bg = MODE_BG[intelMode ?? "default"] ?? MODE_BG.default;

    return (
      <WidgetCard
        bg={bg} accent={SYSTEM_BLUE}
        topLeft="ANALYSIS" topRight="LIVE"
        bottomLeft="Reading paragraphs"
        bottomRight="Finding tension"
        deco={<RadarDeco pips={PIP_COLORS} orbitAngles={orbitAngles} />}
      >
        <div className="widget-role-hero placeholder-hero">
          <span className="ph-radar-core" />
        </div>
      </WidgetCard>
    );
  }
  return (
    <WidgetCard
      bg="#181a28" accent="#a0b4d0"
      topLeft="ANALYSIS" topRight="EMPTY"
      bottomLeft="Start writing"
      bottomRight="Widgets appear when ready"
      deco={<EmptyDeco accent="rgba(160,180,210,0.40)" />}
    >
      <div className="widget-role-hero placeholder-hero">
        <div className="widget-glow" style={{ background: "#a0b4d0", opacity: 0.2 }} />
        <span className="placeholder-cursor" aria-hidden />
      </div>
    </WidgetCard>
  );
}
