interface Props {
  xLabels: string[];
  yLabels: string[];
  values: number[][];
  colorScale?: "sequential" | "diverging";
  onCellClick?: (row: number, col: number) => void;
}

function cellColor(value: number, scale: "sequential" | "diverging"): string {
  const v = Math.max(0, Math.min(1, value));
  if (scale === "diverging") {
    if (v < 0.5) {
      const t = v * 2;
      return `rgba(90, 184, 224, ${0.08 + t * 0.42})`;
    }
    const t = (v - 0.5) * 2;
    return `rgba(244, 63, 94, ${0.08 + t * 0.52})`;
  }
  return `rgba(90, 184, 224, ${0.06 + v * 0.54})`;
}

export function ToolHeatmap({ xLabels, yLabels, values, colorScale = "sequential", onCellClick }: Props) {
  const cellSize = 18;
  const labelWidth = 54;

  return (
    <div className="wg-content" style={{ gap: 2, overflow: "auto" }}>
      <div style={{ display: "flex", paddingLeft: labelWidth, gap: 2 }}>
        {xLabels.map((x) => (
          <span
            key={x}
            style={{
              width: cellSize, textAlign: "center", fontSize: 8,
              fontWeight: 600, color: "rgba(255,255,255,0.4)",
              letterSpacing: "0.04em", overflow: "hidden", textOverflow: "ellipsis",
            }}
          >
            {x}
          </span>
        ))}
      </div>
      {yLabels.map((y, row) => (
        <div key={y} style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <span
            style={{
              width: labelWidth, fontSize: 9, fontWeight: 500,
              color: "rgba(255,255,255,0.6)", overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0,
            }}
          >
            {y}
          </span>
          {(values[row] || []).map((v, col) => (
            <div
              key={col}
              style={{
                width: cellSize, height: cellSize, borderRadius: 3,
                background: cellColor(v, colorScale),
                cursor: onCellClick ? "pointer" : undefined,
              }}
              onClick={onCellClick ? () => onCellClick(row, col) : undefined}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
