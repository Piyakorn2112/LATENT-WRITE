interface Props<T extends string> {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}

export function ToolPillGroup<T extends string>({ options, value, onChange }: Props<T>) {
  return (
    <div className="settings-pillgroup" role="radiogroup">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          className={`settings-pill ${value === opt.value ? "settings-pill--active" : ""}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
