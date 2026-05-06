import type { ReactNode } from "react";
// (no useId — glow filter removed; dial reads from colour + density alone)

/**
 * Shared dial primitive — used only where a *dotted* gauge is the
 * appropriate visual language (Cast share, Sensory channel breakdown,
 * Style mini-rings — all cases where the underlying data is discretely
 * countable). Other widgets get bespoke faces (e.g. PacingWidget uses
 * a clock-face, MomentumWidget uses an arc-segment visualisation) so
 * the family reads with personality per data type rather than as a
 * monoculture of identical dot rings.
 *
 * Two modes:
 *   • SINGLE-FILL — `fill: 0..1` fills the first N×fill dots in `color`.
 *   • MULTI-SEGMENT — `segments: [{from, to, color}]` paints contiguous
 *     dot ranges in distinct colours.
 *
 * No glow, no drop-shadow — the dial reads from colour + density alone,
 * matching the cleaner reference watch-face style.
 */

export interface DialSegment {
  /** Inclusive lower dot index. */
  from: number;
  /** Exclusive upper dot index. */
  to: number;
  color: string;
}

interface DialRingProps {
  /** Number of dots around the ring. Higher = finer-grained but more DOM. */
  dots?: number;
  /** SVG side length in CSS pixels. */
  size?: number;
  /** Starting angle in degrees (-90 = top of ring). */
  startAngle?: number;
  /** Sweep range in degrees. 360 = full ring; 240 = speedometer-style. */
  sweep?: number;
  /** Active track colour (single-fill mode only). */
  color?: string;
  /** Fraction filled 0..1 — used in single-fill mode. */
  fill?: number;
  /** Multi-segment mode — each segment paints its own dot range. */
  segments?: DialSegment[];
  /** Inactive (track) dot colour. */
  trackColor?: string;
  /** Centre slot — typically the hero numeric + a tiny icon below. */
  children?: ReactNode;
}

export function DialRing({
  dots = 60,
  size = 92,
  startAngle = -90,
  sweep = 360,
  color = "#5ab8e0",
  fill,
  segments,
  trackColor = "rgba(255, 255, 255, 0.09)",
  children,
}: DialRingProps) {
  const half = size / 2;
  // Margin off the SVG edge keeps glow halos inside the bbox without clipping.
  const r = half - Math.max(5, size * 0.07);
  const dotR = Math.max(1.1, size / 70);

  // Pre-compute angles + active-state per dot. For a sweep of less than
  // 360°, dots are distributed across [startAngle, startAngle + sweep]
  // inclusive of both endpoints (so a 240° dial with 60 dots has the
  // first dot at startAngle and the last at startAngle + sweep).
  const isFullRing = sweep >= 360;
  const denom = isFullRing ? dots : Math.max(1, dots - 1);

  const fillCount = fill != null ? Math.max(0, Math.min(dots, Math.round(fill * dots))) : 0;

  type Dot = { cx: number; cy: number; color: string; active: boolean };
  const allDots: Dot[] = [];
  for (let i = 0; i < dots; i++) {
    const a = startAngle + (sweep * i) / denom;
    const rad = (a * Math.PI) / 180;
    const cx = half + r * Math.cos(rad);
    const cy = half + r * Math.sin(rad);

    let c = trackColor;
    if (segments) {
      const seg = segments.find((s) => i >= s.from && i < s.to);
      if (seg) c = seg.color;
    } else if (fill != null && i < fillCount) {
      c = color;
    }
    allDots.push({ cx, cy, color: c, active: c !== trackColor });
  }

  return (
    <div className="wg-dial-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        {allDots.map((d, i) => (
          <circle key={i} cx={d.cx} cy={d.cy} r={dotR} fill={d.color} />
        ))}
      </svg>
      {children && <div className="wg-dial-center">{children}</div>}
    </div>
  );
}
