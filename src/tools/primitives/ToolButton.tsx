import type { ReactNode } from "react";

interface Props {
  variant: "primary" | "secondary";
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

export function ToolButton({ variant, children, onClick, disabled }: Props) {
  return (
    <button
      type="button"
      className={`wc-btn wc-btn--${variant}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
