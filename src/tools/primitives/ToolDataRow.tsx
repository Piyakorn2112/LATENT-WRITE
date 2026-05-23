interface Props {
  label: string;
  value: string | number;
  status?: "pass" | "fail" | "warning";
}

const STATUS_COLORS: Record<string, string> = {
  pass: "#34c759",
  fail: "#f43f5e",
  warning: "#fbbf24",
};

export function ToolDataRow({ label, value, status }: Props) {
  const valueColor = status ? STATUS_COLORS[status] : "rgba(255,255,255,0.7)";
  return (
    <div className="wg-seg" style={{ padding: "3px 0" }}>
      <span className="wg-seg-label" style={{ flex: 1 }}>{label}</span>
      <span className="wg-stat-num" style={{ color: valueColor, fontSize: 11 }}>
        {value}
      </span>
    </div>
  );
}
