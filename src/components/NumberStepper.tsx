import { useEffect, useRef, useState } from "react";
import { PlusIcon, MinusIcon } from "./Icon";

interface Props {
  value: number;
  onChange: (next: number) => void;
  step?: number;
  min?: number;
  max?: number;
  placeholder?: string;
  className?: string;
}

// Custom-themed number input + −/+ buttons. The native <input type="number">
// spinner is hidden via CSS so the only controls are the themed buttons,
// which match the rest of the settings panel.
export function NumberStepper({
  value, onChange, step = 1, min = 0, max = Number.POSITIVE_INFINITY,
  placeholder, className = "",
}: Props) {
  const [text, setText] = useState(String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-sync the visible text whenever the canonical value changes from outside.
  useEffect(() => { setText(String(value)); }, [value]);

  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  const commit = (n: number) => {
    const c = clamp(Number.isFinite(n) ? n : 0);
    setText(String(c));
    if (c !== value) onChange(c);
  };

  const dec = () => commit(value - step);
  const inc = () => commit(value + step);

  return (
    <div className={`stepper ${className}`}>
      <button
        type="button"
        className="stepper-btn"
        onClick={dec}
        disabled={value <= min}
        aria-label="Decrease"
      >
        <MinusIcon size={14} />
      </button>
      <input
        ref={inputRef}
        className="stepper-input"
        type="text"
        inputMode="numeric"
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          // Allow free typing while editing — only digits + leading minus.
          const v = e.target.value.replace(/[^\d-]/g, "");
          setText(v);
        }}
        onBlur={() => commit(parseInt(text, 10) || 0)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "ArrowUp")   { e.preventDefault(); inc(); }
          else   if (e.key === "ArrowDown") { e.preventDefault(); dec(); }
        }}
      />
      <button
        type="button"
        className="stepper-btn"
        onClick={inc}
        disabled={value >= max}
        aria-label="Increase"
      >
        <PlusIcon size={14} />
      </button>
    </div>
  );
}
