interface Props {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}

function catmullRomPath(points: Array<[number, number]>): string {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M${points[0][0]},${points[0][1]}L${points[1][0]},${points[1][1]}`;
  }

  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;

    d += `C${cp1x},${cp1y},${cp2x},${cp2y},${p2[0]},${p2[1]}`;
  }
  return d;
}

export function ToolSparkline({ values, color = "#5ab8e0", width = 120, height = 32 }: Props) {
  if (values.length < 2) return null;

  const padding = 2;
  const w = width - padding * 2;
  const h = height - padding * 2;

  const points: Array<[number, number]> = values.map((v, i) => [
    padding + (i / (values.length - 1)) * w,
    padding + (1 - Math.max(0, Math.min(1, v))) * h,
  ]);

  const pathD = catmullRomPath(points);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} fill="none">
      <path d={pathD} stroke={color} strokeWidth={1.5} strokeLinecap="round" fill="none" />
    </svg>
  );
}
