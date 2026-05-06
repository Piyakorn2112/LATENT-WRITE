import type { ReactNode } from "react";

/**
 * Continuous-arc dial primitive — replaces the dot-ring DialRing where a
 * smooth stroked arc reads as more polished. Matches the Apple-Watch
 * reference's arc-style gauges (not the dotted ones): clean stroke,
 * rounded caps, gap-separated multi-segment for share/breakdown widgets.
 *
 * Modes:
 *   • SINGLE-FILL — `fill: 0..1` draws one coloured arc from the start
 *     angle to that fraction of the sweep.
 *   • MULTI-SEGMENT — `segments: [{from, to, color}]` paints contiguous
 *     normalised ranges (each `from`/`to` in 0..1 of the sweep) as
 *     separate arcs with a small angular gap between them. Round line
 *     caps make each segment read as its own pill.
 *
 * Polish:
 *   • Optional `indicatorDot` paints a small bright pip at the leading
 *     edge of a single-fill arc — encodes the current value's position
 *     without adding decoration (the dot IS the data).
 *   • Track arc renders behind everything when `showTrack` is true.
 *   • Full-ring case (sweep ≥ 360 with fill = 1) is rendered as a
 *     <circle> rather than a path so the seam doesn't gap.
 */

export interface ArcSegment {
  /** Start position 0..1 along the dial's sweep. */
  from: number;
  /** End position 0..1 along the dial's sweep. */
  to: number;
  color: string;
}

interface ArcRingProps {
  size?: number;
  /** Stroke thickness in px. */
  thickness?: number;
  /** Starting angle in degrees (-90 = top). */
  startAngle?: number;
  /** Sweep range in degrees (360 = full ring; 240 = speedometer). */
  sweep?: number;
  /** Single-fill mode: fraction 0..1. */
  fill?: number;
  /** Single-fill colour. */
  color?: string;
  /** Multi-segment mode. */
  segments?: ArcSegment[];
  /** Angular gap between adjacent segments, in degrees. */
  gap?: number;
  /** Track stroke colour (faint grey by default). */
  trackColor?: string;
  /** Whether to draw the inactive track behind the fills. */
  showTrack?: boolean;
  /** Round the stroke endpoints (default true). */
  rounded?: boolean;
  /** When set + single-fill, paints a small pip at the leading edge. */
  indicatorDot?: boolean;
  children?: ReactNode;
}

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

// SVG arc command — handles `largeArc` automatically for sweeps > 180°.
function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const a = polar(cx, cy, r, startDeg);
  const b = polar(cx, cy, r, endDeg);
  const sweep = endDeg - startDeg;
  const largeArc = Math.abs(sweep) > 180 ? 1 : 0;
  const sweepFlag = sweep >= 0 ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} ${sweepFlag} ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

export function ArcRing({
  size = 132,
  thickness = 8,
  startAngle = -90,
  sweep = 360,
  fill,
  color = "#5ab8e0",
  segments,
  gap = 6,
  trackColor = "rgba(255, 255, 255, 0.08)",
  showTrack = true,
  rounded = true,
  indicatorDot = false,
  children,
}: ArcRingProps) {
  const half = size / 2;
  // Pull the radius in by half the stroke thickness + a small breathing
  // margin so caps don't clip the SVG bounds.
  const r = half - thickness / 2 - 3;
  const cap = rounded ? "round" : "butt";
  const isFullRing = sweep >= 360;

  // Build resolved segment list (in absolute degrees).
  type Resolved = { from: number; to: number; color: string };
  let resolved: Resolved[] = [];

  if (segments && segments.length > 0) {
    for (const s of segments) {
      const f = startAngle + sweep * s.from;
      const t = startAngle + sweep * s.to;
      resolved.push({ from: f, to: t, color: s.color });
    }
  } else if (fill != null) {
    const clamped = Math.max(0, Math.min(1, fill));
    if (clamped > 0) {
      resolved.push({
        from: startAngle,
        to: startAngle + sweep * clamped,
        color,
      });
    }
  }

  // Apply gap by trimming both ends of each segment by gap/2 degrees.
  // For single-fill (one entry) we don't trim — keeps the fill snug to
  // start and end. For multi-segment we trim so each piece reads as its
  // own pill with a clear gap between.
  const isMulti = !!segments && segments.length > 1;
  if (isMulti) {
    const half = gap / 2;
    resolved = resolved
      .map((s) => ({ ...s, from: s.from + half, to: s.to - half }))
      .filter((s) => s.to - s.from > 0.5);
  }

  // Indicator dot position — leading edge of the first (single-fill) arc.
  let dot: { cx: number; cy: number; color: string } | null = null;
  if (indicatorDot && !segments && resolved.length > 0) {
    const last = resolved[0];
    const p = polar(half, half, r, last.to);
    dot = { cx: p.x, cy: p.y, color: last.color };
  }

  return (
    <div className="wg-dial-wrap" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
      >
        {/* Track */}
        {showTrack && (
          isFullRing ? (
            <circle
              cx={half}
              cy={half}
              r={r}
              fill="none"
              stroke={trackColor}
              strokeWidth={thickness}
            />
          ) : (
            <path
              d={arcPath(half, half, r, startAngle, startAngle + sweep)}
              fill="none"
              stroke={trackColor}
              strokeWidth={thickness}
              strokeLinecap={cap}
            />
          )
        )}

        {/* Active arcs */}
        {resolved.map((s, i) => {
          const arcSweep = s.to - s.from;
          if (arcSweep >= 359.5) {
            // Full circle — path with same start/end is degenerate.
            return (
              <circle
                key={i}
                cx={half}
                cy={half}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={thickness}
              />
            );
          }
          return (
            <path
              key={i}
              d={arcPath(half, half, r, s.from, s.to)}
              fill="none"
              stroke={s.color}
              strokeWidth={thickness}
              strokeLinecap={cap}
            />
          );
        })}

        {/* Indicator pip — single-fill mode, at the leading edge. */}
        {dot && (
          <circle
            cx={dot.cx}
            cy={dot.cy}
            r={thickness * 0.55}
            fill="#fff"
            stroke={dot.color}
            strokeWidth={Math.max(1.4, thickness * 0.32)}
          />
        )}
      </svg>
      {children && <div className="wg-dial-center">{children}</div>}
    </div>
  );
}
