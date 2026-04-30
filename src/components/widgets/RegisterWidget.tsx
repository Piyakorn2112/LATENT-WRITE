import type { ChapterAnalysis } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";

/** Radial / starburst deco — four axes emanating from center, lengths from signal strengths */
function SignalDeco({ literary, introspective, action, expository }: {
  literary: number; introspective: number; action: number; expository: number;
}) {
  const cx = 100, cy = 60;
  // Four cardinal axes: top, right, bottom, left
  const maxLen = 52;
  const axes = [
    { dx: 0,    dy: -1,  v: literary,      color: "rgba(216,128,255,0.30)" },
    { dx: 1,    dy: 0,   v: introspective,  color: "rgba(168,140,255,0.25)" },
    { dx: 0,    dy: 1,   v: expository,     color: "rgba(112,184,240,0.25)" },
    { dx: -1,   dy: 0,   v: action,         color: "rgba(255,128,64,0.25)"  },
  ];
  return (
    <svg viewBox="0 0 200 120" fill="none">
      {/* Faint grid rings */}
      {[20, 35, 50].map((r, i) => (
        <ellipse key={r} cx={cx} cy={cy} rx={r * 1.7} ry={r}
          stroke="rgba(255,255,255,0.05)" strokeWidth="1" opacity={1 - i * 0.2} />
      ))}
      {/* Signal arms */}
      {axes.map((ax, i) => {
        const len = (ax.v / 100) * maxLen;
        return (
          <line key={i}
            x1={cx} y1={cy}
            x2={cx + ax.dx * len * 1.7}
            y2={cy + ax.dy * len}
            stroke={ax.color} strokeWidth={2 + (ax.v / 100) * 3}
            strokeLinecap="round" />
        );
      })}
      {/* Center dot */}
      <circle cx={cx} cy={cy} r="3" fill="rgba(255,255,255,0.2)" />
    </svg>
  );
}

const REGISTER_META: Record<string, { bg: string; accent: string }> = {
  literary:      { bg: "#2d0a52", accent: "#d880ff" },
  action:        { bg: "#7a1e00", accent: "#ff8040" },
  expository:    { bg: "#0e2848", accent: "#70b8f0" },
  introspective: { bg: "#360860", accent: "#c090ff" },
  mixed:         { bg: "#0a3844", accent: "#5ae0c0" },
};

const SIGNAL_DEFS = [
  { key: "literary"      as const, label: "LITERARY",   accent: "#d880ff" },
  { key: "introspective" as const, label: "INTROSPECT", accent: "#c090ff" },
  { key: "action"        as const, label: "ACTION",     accent: "#ff8040" },
  { key: "expository"    as const, label: "EXPOSITORY", accent: "#70b8f0" },
];

interface Props { analysis: ChapterAnalysis }

export function RegisterWidget({ analysis }: Props) {
  const { register, registerSignals } = analysis;
  const meta = REGISTER_META[register] ?? REGISTER_META.mixed;
  const label = register.toUpperCase();

  // Sort signals descending so strongest shows at top
  const sorted = [...SIGNAL_DEFS].sort(
    (a, b) => registerSignals[b.key] - registerSignals[a.key],
  );

  return (
    <WidgetCard bg={meta.bg} accent={meta.accent}
      topLeft="PROSE REGISTER" topRight={label}
      deco={<SignalDeco
        literary={registerSignals.literary}
        introspective={registerSignals.introspective}
        action={registerSignals.action}
        expository={registerSignals.expository} />}
    >
      <div className="widget-register-signals">
        {sorted.map(sig => {
          const v = registerSignals[sig.key];
          return (
            <div className="widget-bar-row" key={sig.key}>
              <span className="widget-bar-key widget-bar-key--wide"
                style={{ color: v > 0 ? sig.accent : "rgba(255,255,255,0.25)" }}>
                {sig.label}
              </span>
              <div className="widget-bar-track">
                <div className="widget-bar-fill" style={{
                  width: `${v}%`,
                  background: sig.accent,
                  opacity: 0.75,
                }} />
              </div>
              <span className="widget-bar-val" style={{
                color: v > 0 ? sig.accent : "rgba(255,255,255,0.25)",
              }}>
                {v}
              </span>
            </div>
          );
        })}
      </div>
    </WidgetCard>
  );
}
