import type { ChapterAnalysis } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";

const SENSORY_META: Record<string, { label: string; color: string }> = {
  sight:         { label: "sight",    color: "#fbbf24" },
  sound:         { label: "sound",    color: "#38bdf8" },
  touch:         { label: "touch",    color: "#fb923c" },
  smell:         { label: "smell",    color: "#a78bfa" },
  taste:         { label: "taste",    color: "#f472b6" },
  interoception: { label: "body",     color: "#f43f5e" },
  kinesthetic:   { label: "movement", color: "#34d399" },
};

const PROSE_MODE_COLOR: Record<string, string> = {
  "sensory-rich":  "#fb923c",
  "action-driven": "#f43f5e",
  "reflective":    "#a78bfa",
  "dialogue-led":  "#38bdf8",
  "balanced":      "#94a3b8",
};

const REGISTER_DEFS = [
  { key: "literary"      as const, label: "LITERARY",   accent: "#d880ff" },
  { key: "introspective" as const, label: "INTROSPECT", accent: "#c090ff" },
  { key: "action"        as const, label: "ACTION",     accent: "#ff8040" },
  { key: "expository"    as const, label: "EXPOSITORY", accent: "#70b8f0" },
];

export function VoiceWidget({ analysis }: { analysis: ChapterAnalysis }) {
  const { register, registerSignals, highModeAnalysis } = analysis;
  const proseStyle = highModeAnalysis?.proseStyle ?? null;
  const proseTexture = highModeAnalysis?.proseTexture ?? null;

  const topChannels = proseStyle?.topChannels.slice(0, 4) ?? [];
  const maxCount = topChannels.length > 0 ? Math.max(...topChannels.map(c => c.count), 1) : 1;

  const modeColor = proseStyle ? (PROSE_MODE_COLOR[proseStyle.dominantMode] ?? "#94a3b8") : "#94a3b8";

  const sortedReg = [...REGISTER_DEFS].sort(
    (a, b) => registerSignals[b.key] - registerSignals[a.key],
  );

  const hotspots = proseStyle?.hotspotParagraphs ?? [];

  return (
    <WidgetCard bg="#0d1117" accent={modeColor} heroAlign="start"
      topLeft="VOICE" topRight={register.toUpperCase()}
    >
      <div className="wg-content">
        {/* Prose mode + stats */}
        {proseStyle && (
          <>
            <div className="wg-row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              <span className="wg-mode-pill"
                style={{ color: modeColor, borderColor: `${modeColor}44`, background: `${modeColor}14` }}>
                {proseStyle.dominantMode}
              </span>
              <span className="wg-stat">
                <span className="wg-stat-num" style={{ color: modeColor }}>
                  {Math.round(proseStyle.sensoryDensity * 100)}%
                </span>
                <span className="wg-stat-key">sensory</span>
              </span>
              <span className="wg-dot-sep">·</span>
              <span className="wg-stat">
                <span className="wg-stat-num">
                  {Math.round(proseStyle.actionDensity * 100)}%
                </span>
                <span className="wg-stat-key">action</span>
              </span>
              {proseTexture && (
                <>
                  <span className="wg-dot-sep">·</span>
                  <span className="wg-stat">
                    <span className="wg-stat-num">{Math.round(proseTexture.dialogueRatio)}%</span>
                    <span className="wg-stat-key">dialogue</span>
                  </span>
                  <span className="wg-dot-sep">·</span>
                  <span className="wg-stat">
                    <span className="wg-stat-num">{proseTexture.rhythmLabel}</span>
                    <span className="wg-stat-key">rhythm</span>
                  </span>
                </>
              )}
            </div>

            {/* Sensory channels */}
            {topChannels.length > 0 && (
              <div className="wg-section" style={{ marginBottom: 8 }}>
                {topChannels.map(({ channel, count }) => {
                  const meta = SENSORY_META[channel] ?? { label: channel, color: "#94a3b8" };
                  const w = Math.round((count / maxCount) * 100);
                  return (
                    <div key={channel} className="wg-channel">
                      <span className="wg-channel-dot" style={{ background: meta.color }} />
                      <span className="wg-channel-name">{meta.label}</span>
                      <div className="wg-channel-track">
                        <div className="wg-channel-fill"
                          style={{ width: `${w}%`, background: meta.color }} />
                      </div>
                      <span className="wg-channel-val">{count.toFixed(1)}/1k</span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Signal tags */}
            {(hi => hi && (hi.peakTrace || hotspots.length > 0 || hi.attributionStats.totalAttributed > 0))(highModeAnalysis) && (
              <div className="wg-tags" style={{ marginBottom: 8 }}>
                {highModeAnalysis!.peakTrace && (
                  <span className="wg-tag">
                    <span className="wg-tag-key">peak</span>
                    <span className="wg-tag-val">¶{highModeAnalysis!.peakTrace.paragraphIndex + 1}</span>
                  </span>
                )}
                {hotspots.length > 0 && (
                  <span className="wg-tag">
                    <span className="wg-tag-key">hotspot</span>
                    <span className="wg-tag-val">
                      {hotspots.map(h => `¶${h.index + 1}`).join("·")}
                    </span>
                  </span>
                )}
              </div>
            )}
            <div className="wg-divider" />
          </>
        )}

        {/* Register breakdown */}
        <div className="wg-section">
          {sortedReg.map(sig => {
            const v = registerSignals[sig.key];
            return (
              <div key={sig.key} className="wg-row">
                <span className="widget-bar-key widget-bar-key--wide"
                  style={{ color: v > 0 ? sig.accent : "rgba(255,255,255,0.22)" }}>
                  {sig.label}
                </span>
                <div className="widget-bar-track">
                  <div className="widget-bar-fill"
                    style={{ width: `${v}%`, background: sig.accent, opacity: 0.75 }} />
                </div>
                <span className="widget-bar-val"
                  style={{ color: v > 0 ? sig.accent : "rgba(255,255,255,0.22)" }}>
                  {v}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </WidgetCard>
  );
}
