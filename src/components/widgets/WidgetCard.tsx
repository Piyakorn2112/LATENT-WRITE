import { createContext, useContext, useState, type ReactNode, type CSSProperties } from "react";

/**
 * What this card is showing, in the writer's language.
 *
 * ★ THREADED BY CONTEXT, NOT BY PROP. Every widget renders its own WidgetCard,
 *   so a `help` prop would mean editing all thirteen widgets and keeping the
 *   copy next to the maths, where it drifts. The copy lives once in
 *   WIDGET_REGISTRY and the panel provides it per slot; a widget that renders
 *   outside the panel (tool plugins, the placeholder) simply gets nothing.
 */
export const WidgetHelpContext = createContext<string | undefined>(undefined);

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

// Inline rather than in styles.css: the affordance is three elements that
// belong to this chassis alone, and the corner-label register they borrow is
// already defined right here in the markup.
const HELP_BTN: CSSProperties = {
  appearance: "none",
  background: "rgba(255, 255, 255, 0.10)",
  border: "none",
  borderRadius: "999px",
  width: 15,
  height: 15,
  padding: 0,
  marginLeft: 6,
  flex: "0 0 auto",
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
  fontSize: 9,
  fontWeight: 700,
  lineHeight: "15px",
  letterSpacing: 0,
  color: "rgba(255, 255, 255, 0.62)",
  textAlign: "center",
};

const HELP_TEXT: CSSProperties = {
  fontFamily: "var(--font-ui)",
  fontSize: 11,
  lineHeight: 1.5,
  letterSpacing: "0.005em",
  color: "rgba(255, 255, 255, 0.72)",
  margin: "0 0 12px",
  position: "relative",
  zIndex: 2,
};

export function WidgetCard({
  bg, accent, topLeft, topRight, bottomLeft, bottomRight, deco, children, style, heroAlign,
}: Props) {
  const help = useContext(WidgetHelpContext);
  const [showHelp, setShowHelp] = useState(false);

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
        <span
          className="widget-corner-label widget-corner-right"
          style={{ display: "flex", alignItems: "flex-start", justifyContent: "flex-end", minWidth: 0 }}
        >
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{topRight}</span>
          {help && (
            <button
              type="button"
              style={HELP_BTN}
              aria-expanded={showHelp}
              aria-label={showHelp ? "Hide what this shows" : "What does this show?"}
              onClick={() => setShowHelp((v) => !v)}
            >
              {showHelp ? "×" : "?"}
            </button>
          )}
        </span>
      </div>

      {/* Above the content, so the explanation and the thing it explains are
          read in that order. The list's height animation absorbs the shift. */}
      {help && showHelp && <p style={HELP_TEXT}>{help}</p>}

      <div className={`widget-hero-area${heroAlign === 'start' ? ' widget-hero-area--start' : ''}`}>{children}</div>
      <div className="widget-corners">
        <span className="widget-corner-label widget-corner-dim">{bottomLeft}</span>
        <span className="widget-corner-label widget-corner-dim widget-corner-right">{bottomRight}</span>
      </div>
    </div>
  );
}
