import type { ReactNode } from "react";
import { DialRing } from "../../components/widgets/DialRing";

interface Props {
  value: number;
  label?: ReactNode;
  color?: string;
  size?: number;
}

export function ToolDialRing({ value, label, color = "#5ab8e0", size = 64 }: Props) {
  return (
    <DialRing
      fill={Math.max(0, Math.min(1, value))}
      color={color}
      size={size}
    >
      {label}
    </DialRing>
  );
}
