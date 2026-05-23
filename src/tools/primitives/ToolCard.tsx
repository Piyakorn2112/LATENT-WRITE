import type { ReactNode, CSSProperties } from "react";
import { WidgetCard } from "../../components/widgets/WidgetCard";

interface Props {
  bg: string;
  accent: string;
  topLeft?: ReactNode;
  topRight?: ReactNode;
  bottomLeft?: ReactNode;
  bottomRight?: ReactNode;
  deco?: ReactNode;
  heroAlign?: "center" | "start";
  children: ReactNode;
  style?: CSSProperties;
}

export function ToolCard(props: Props) {
  return <WidgetCard {...props} />;
}
