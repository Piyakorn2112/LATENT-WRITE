import type { ReactNode } from "react";
import { ArcRing } from "../../components/widgets/ArcRing";

interface Props {
  value: number;
  label?: ReactNode;
  unit?: string;
  color?: string;
  size?: number;
  thickness?: number;
  showIndicator?: boolean;
}

export function ToolArcRing({ value, label, unit, color = "#5ab8e0", size = 64, thickness = 4, showIndicator }: Props) {
  return (
    <ArcRing
      fill={Math.max(0, Math.min(1, value))}
      color={color}
      size={size}
      thickness={thickness}
      showTrack
      indicatorDot={showIndicator}
    >
      {label != null && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <span style={{ fontSize: size > 48 ? 16 : 12, fontWeight: 800, color: "rgba(255,255,255,0.9)" }}>
            {label}
          </span>
          {unit && (
            <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.10em", color: "rgba(255,255,255,0.5)", textTransform: "uppercase" }}>
              {unit}
            </span>
          )}
        </div>
      )}
    </ArcRing>
  );
}
