import type { ReactNode, CSSProperties } from "react";

interface Props {
  bg: string;
  accent: string;
  topLeft?: ReactNode;
  topRight?: ReactNode;
  bottomLeft?: ReactNode;
  bottomRight?: ReactNode;
  /** Decorative SVG layer rendered behind content */
  deco?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
  heroAlign?: 'center' | 'start';
}

export function WidgetCard({
  bg, accent, topLeft, topRight, bottomLeft, bottomRight, deco, children, style, heroAlign,
}: Props) {
  return (
    <div
      className="widget-card"
      style={{ "--card-bg": bg, "--card-accent": accent, ...style } as CSSProperties}
    >
      <div className="widget-card-bg" />
      {/* decorative background layer */}
      {deco && <div className="widget-deco">{deco}</div>}

      <div className="widget-corners">
        <span className="widget-corner-label">{topLeft}</span>
        <span className="widget-corner-label widget-corner-right">{topRight}</span>
      </div>
      <div className={`widget-hero-area${heroAlign === 'start' ? ' widget-hero-area--start' : ''}`}>{children}</div>
      <div className="widget-corners">
        <span className="widget-corner-label widget-corner-dim">{bottomLeft}</span>
        <span className="widget-corner-label widget-corner-dim widget-corner-right">{bottomRight}</span>
      </div>
    </div>
  );
}
