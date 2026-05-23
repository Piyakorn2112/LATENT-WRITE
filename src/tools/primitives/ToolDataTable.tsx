interface Column {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
}

interface Props {
  columns: Column[];
  rows: Array<Record<string, string | number>>;
  highlightRow?: (row: Record<string, string | number>) => "pass" | "fail" | "warning" | null;
}

const HIGHLIGHT_COLORS: Record<string, string> = {
  pass: "rgba(52, 199, 89, 0.08)",
  fail: "rgba(244, 63, 94, 0.08)",
  warning: "rgba(251, 191, 36, 0.08)",
};

export function ToolDataTable({ columns, rows, highlightRow }: Props) {
  return (
    <div className="wg-content" style={{ gap: 0 }}>
      <div className="wg-seg" style={{ padding: "3px 0", opacity: 0.5 }}>
        {columns.map((col) => (
          <span
            key={col.key}
            className="wg-seg-label"
            style={{ flex: 1, textAlign: col.align || "left", fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}
          >
            {col.label}
          </span>
        ))}
      </div>
      {rows.map((row, i) => {
        const hl = highlightRow?.(row);
        return (
          <div
            key={i}
            className="wg-seg"
            style={{
              padding: "3px 0",
              background: hl ? HIGHLIGHT_COLORS[hl] : undefined,
              borderRadius: hl ? 4 : undefined,
            }}
          >
            {columns.map((col) => (
              <span
                key={col.key}
                className="wg-seg-label"
                style={{ flex: 1, textAlign: col.align || "left" }}
              >
                {row[col.key]}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}
