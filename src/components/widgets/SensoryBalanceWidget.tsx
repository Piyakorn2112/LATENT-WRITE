import { Eye, Ear, Hand, Sparkles, Zap } from "lucide-react";
import type { ChapterAnalysis } from "../../lib/use-analysis";
import type { SensoryChannel } from "../../lib/chapter-analysis";
import { WidgetCard } from "./WidgetCard";
import { ArcRing, type ArcSegment } from "./ArcRing";

// Per-channel icon — picks the lucide that maps best to each sense.
// Renders inside the dial centre under the density numeric so the
// widget gains a per-chapter "personality" without static decoration:
// the centre icon binds to the channel currently dominating the chapter.
const CHANNEL_ICON: Record<SensoryChannel, typeof Eye> = {
  sight:         Eye,
  sound:         Ear,
  touch:         Hand,
  smell:         Sparkles,
  taste:         Sparkles,
  interoception: Zap,
  kinesthetic:   Zap,
};

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

function actionFor(
  topChannels: { channel: SensoryChannel; count: number }[],
  sensoryDensity: number,
): string | null {
  if (topChannels.length === 0) return null;
  const top = topChannels[0];
  const total = topChannels.reduce((s, c) => s + c.count, 0);
  if (total === 0) return null;
  const share = top.count / total;
  if (share > 0.6 && topChannels.length >= 2) {
    const second = topChannels.find((c) => c.channel !== top.channel);
    if (second) {
      return `${CHANNEL_LABEL[top.channel]} dominates (${Math.round(share * 100)}%). A pass of ${CHANNEL_LABEL[second.channel].toLowerCase()} detail would broaden the scene.`;
    }
  }
  if (sensoryDensity < 0.15 && total < 12) {
    return "Sensory density is light — grounding a key moment in one concrete detail will help the scene land.";
  }
  return null;
}

/**
 * Sensory channel breakdown — multi-segment dot ring where each sense
 * gets an arc proportional to its mention count. Centre numeric is the
 * sensory-density percentage (how concrete vs. abstract the chapter
 * reads). Mirrors CastWidget's structure so the two widgets read as
 * a family.
 */
export function SensoryBalanceWidget({ analysis }: { analysis: ChapterAnalysis }) {
  const hi = analysis.highModeAnalysis;
  if (!hi) return null;
  const ps = hi.proseStyle;
  if (!ps || ps.topChannels.length === 0) return null;

  const top = ps.topChannels.slice(0, 7);
  const total = top.reduce((s, c) => s + c.count, 0);
  if (total === 0) return null;

  // Build arc segments — one continuous arc per sensory channel,
  // proportional to mention count, in 0..1 normalised fractions.
  const segments: ArcSegment[] = [];
  let cursor = 0;
  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    const share = c.count / total;
    segments.push({
      from: cursor,
      to: cursor + share,
      color: CHANNEL_COLOR[c.channel],
    });
    cursor += share;
  }

  const action = actionFor(top, ps.sensoryDensity);
  const densityPct = Math.round(ps.sensoryDensity * 100);
  const dominantColor = CHANNEL_COLOR[top[0].channel];
  const DominantIcon = CHANNEL_ICON[top[0].channel];

  return (
    <WidgetCard
      bg="#0d1117"
      accent={dominantColor}
      heroAlign="start"
      topLeft="SENSORY"
      topRight={(MODE_LABEL[ps.dominantMode] ?? ps.dominantMode).toUpperCase()}
    >
      <div className="wg-content">
        <div className="wg-cast-dial-row">
          <ArcRing
            size={132}
            thickness={9}
            startAngle={-90}
            sweep={360}
            segments={segments}
            gap={8}
            rounded
          >
            <span className="wg-dial-num wg-dial-num--sm" style={{ color: "#fff" }}>
              {densityPct}
            </span>
            <span className="wg-dial-unit" style={{ color: "rgba(255,255,255,0.62)" }}>
              density
            </span>
            <span className="wg-dial-icon" style={{ color: dominantColor }}>
              <DominantIcon size={13} strokeWidth={2.4} />
            </span>
          </ArcRing>
        </div>

        <div className="wg-section">
          {top.map((c) => {
            const color = CHANNEL_COLOR[c.channel];
            const sharePct = Math.round((c.count / total) * 100);
            return (
              <div key={c.channel} className="wg-cast-row-compact">
                <span className="wg-cast-dot" style={{ background: color }} />
                <span className="wg-cast-name">{CHANNEL_LABEL[c.channel]}</span>
                <span className="wg-cast-share">{sharePct}%</span>
                <span className="wg-cast-turns">{c.count}</span>
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
