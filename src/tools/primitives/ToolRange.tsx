import { GlassRange } from "../../components/GlassRange";

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  formatValue?: (v: number) => string;
  onChange: (v: number) => void;
}

export function ToolRange({ label, value, min, max, step = 1, formatValue, onChange }: Props) {
  const display = formatValue ? formatValue(value) : String(value);
  return (
    <div className="settings-stack">
      <div className="settings-stack-head">
        <label className="settings-label">{label}</label>
        <span className="settings-value">{display}</span>
      </div>
      <GlassRange
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={onChange}
        ariaLabel={label}
      />
    </div>
  );
}
