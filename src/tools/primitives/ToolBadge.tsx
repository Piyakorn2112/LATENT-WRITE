interface Props {
  label: string;
  status: "pass" | "fail" | "warning" | "info" | "neutral";
}

const STATUS_COLORS: Record<Props["status"], string> = {
  pass: "#34c759",
  fail: "#f43f5e",
  warning: "#fbbf24",
  info: "#5ab8e0",
  neutral: "#94a3b8",
};

export function ToolBadge({ label, status }: Props) {
  const color = STATUS_COLORS[status];
  return (
    <span
      className="wg-header-badge"
      style={{ color, borderColor: `${color}33` }}
    >
      {label}
    </span>
  );
}
