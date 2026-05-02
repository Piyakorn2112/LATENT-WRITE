import type { ChapterAnalysis } from "../../lib/use-analysis";
import type { SensoryChannel } from "../../lib/chapter-analysis";
import { WidgetCard } from "./WidgetCard";

const CHANNEL_COLOR: Record<SensoryChannel, string> = {
  sight:         "#38bdf8",
  sound:         "#a78bfa",
  touch:         "#fb923c",
  smell:         "#fbbf24",
  taste:         "#f472b6",
  interoception: "#34d399",
  kinesthetic:   "#f43f5e",
};

const CHANNEL_LABEL: Record<SensoryChannel, string> = {
  sight:         "Sight",
  sound:         "Sound",
  touch:         "Touch",
  smell:         "Smell",
  taste:         "Taste",
  interoception: "Body",
  kinesthetic:   "Motion",
};

const MODE_LABEL: Record<string, string> = {
  "sensory-rich":  "Sensory-rich",
  "action-driven": "Action-driven",
  "reflective":    "Reflective",
  "dialogue-led":  "Dialogue-led",
  "balanced":      "Balanced",
};

// Build an action note when one channel is dominating the others.
function actionFor(
  topChannels: { channel: SensoryChannel; count: number }[],
  sensoryDensity: number,
): string | null {
  if (topChannels.length === 0) return null;
  const top = topChannels[0];
  const total = topChannels.reduce((s, c) => s + c.count, 0);
  if (total === 0) return null;
  const share = top.count / total;
  // Single-channel dominance: suggest weaving in another sense.
  if (share > 0.6 && topChannels.length >= 2) {
    const second = topChannels.find((c) => c.channel !== top.channel);
    if (second) {
      return `${CHANNEL_LABEL[top.channel]} dominates (${Math.round(share * 100)}%). A pass of ${CHANNEL_LABEL[second.channel].toLowerCase()} detail would broaden the scene.`;
    }
  }
  // Very thin sensory layer overall — chapter may read as abstract.
  if (sensoryDensity < 0.15 && total < 12) {
    return "Sensory density is light — grounding a key moment in one concrete detail will help the scene land.";
  }
  return null;
}

export function SensoryBalanceWidget({ analysis }: { analysis: ChapterAnalysis }) {
  const hi = analysis.highModeAnalysis;
  if (!hi) return null;
  const ps = hi.proseStyle;
  if (!ps || ps.topChannels.length === 0) return null;

  const top = ps.topChannels.slice(0, 5);
  const max = Math.max(...top.map((c) => c.count), 1);
  const action = actionFor(top, ps.sensoryDensity);

  return (
    <WidgetCard
      bg="#0d1117"
      accent={CHANNEL_COLOR[top[0].channel]}
      heroAlign="start"
      topLeft="SENSORY"
      topRight={(MODE_LABEL[ps.dominantMode] ?? ps.dominantMode).toUpperCase()}
    >
      <div className="wg-content">
        <div className="wg-section">
          {top.map((c) => {
            const color = CHANNEL_COLOR[c.channel];
            const pct = Math.max(6, Math.round((c.count / max) * 100));
            return (
              <div className="wg-momentum-row" key={c.channel}>
                <div className="wg-momentum-label">
                  {CHANNEL_LABEL[c.channel]}
                </div>
                <div className="wg-momentum-bar">
                  <div
                    className="wg-momentum-bar-fill"
                    style={{ width: `${pct}%`, background: color }}
                  />
                </div>
                <div
                  className="wg-momentum-trend"
                  style={{ color, fontVariantNumeric: "tabular-nums" }}
                >
                  {c.count}
                </div>
              </div>
            );
          })}
        </div>

        {(action || ps.styleNote) && (
          <div className="wg-section wg-section-divider">
            <div className="wg-action-line">
              {action ?? ps.styleNote}
            </div>
          </div>
        )}
      </div>
    </WidgetCard>
  );
}
