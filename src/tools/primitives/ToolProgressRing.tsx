interface Props {
  value: number;
  label?: string;
  color?: string;
  size?: number;
}

export function ToolProgressRing({ value, label, color = "#5ab8e0", size = 48 }: Props) {
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fill = Math.max(0, Math.min(1, value));
  const offset = circumference * (1 - fill);

  return (
    <div style={{ position: "relative", width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
      <svg width={size} height={size} style={{ position: "absolute", transform: "rotate(-90deg)" }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      {label && (
        <span style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.85)", zIndex: 1 }}>
          {label}
        </span>
      )}
    </div>
  );
}
