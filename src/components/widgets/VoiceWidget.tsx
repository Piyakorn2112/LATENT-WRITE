import {
  BookOpen, Brain, Zap, Info,
  Eye, Ear, Hand, Wind, Sparkles, Heart, Move,
  MessageCircle, Pin, Flame,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ChapterAnalysis } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";
import { ArcRing } from "./ArcRing";

const SENSORY_META: Record<string, { label: string; color: string; icon: LucideIcon }> = {
  sight:         { label: "Sight",  color: "#fbbf24", icon: Eye      },
  sound:         { label: "Sound",  color: "#38bdf8", icon: Ear      },
  touch:         { label: "Touch",  color: "#fb923c", icon: Hand     },
  smell:         { label: "Smell",  color: "#a78bfa", icon: Wind     },
  taste:         { label: "Taste",  color: "#f472b6", icon: Sparkles },
  interoception: { label: "Body",   color: "#f43f5e", icon: Heart    },
  kinesthetic:   { label: "Motion", color: "#34d399", icon: Move     },
};

const PROSE_MODE_COLOR: Record<string, string> = {
  "sensory-rich":  "#fb923c",
  "action-driven": "#f43f5e",
  "reflective":    "#a78bfa",
  "dialogue-led":  "#38bdf8",
  "balanced":      "#94a3b8",
};

const PROSE_MODE_ICON: Record<string, LucideIcon> = {
  "sensory-rich":  Sparkles,
  "action-driven": Flame,
  "reflective":    Brain,
  "dialogue-led":  MessageCircle,
  "balanced":      Info,
};

const REGISTER_DEFS: Array<{
  key: "literary" | "introspective" | "action" | "expository";
  label: string;
  short: string;
  accent: string;
  icon: LucideIcon;
}> = [
  { key: "literary",      label: "LITERARY",   short: "Literary",  accent: "#d880ff", icon: BookOpen },
  { key: "introspective", label: "INTROSPECT", short: "Introspect", accent: "#c090ff", icon: Brain    },
  { key: "action",        label: "ACTION",     short: "Action",    accent: "#ff8040", icon: Zap      },
  { key: "expository",    label: "EXPOSITORY", short: "Exposit",   accent: "#70b8f0", icon: Info     },
];

/**
 * Voice — redesigned around three visual tiers, each native to its
 * data shape (the HI brief: stop using one bar-list for everything):
 *
 *   1. HERO MODE CARD — the chapter's dominant mode (sensory-rich,
 *      action-driven, reflective, dialogue-led, balanced) gets a
 *      prominent labelled card with its glyph + a tight stat row
 *      underneath (sensory %, action %, dialogue %, rhythm). Replaces
 *      the previous wrapped-pill row that mixed display levels.
 *
 *   2. SENSORY CHANNEL PILLS — compact per-channel chips with icon,
 *      colour swatch, and rate. Reads as a row of "what does this
 *      chapter touch on" instead of 4 bar-rows of identical visual
 *      weight. Saves vertical space and gives each channel a glyph.
 *
 *   3. REGISTER MINI-DIALS — 4 mini ArcRings, one per register, using
 *      the same family treatment as StyleWatch's mini-dial row. The
 *      strongest register reads at a glance; zero-signal registers fade.
 *
 * Signal tags (peak ¶, hotspot ¶) get a single compact strip when
 * present — quietly informative, no longer competing for hierarchy.
 */
export function VoiceWidget({ analysis }: { analysis: ChapterAnalysis }) {
  const { register, registerSignals, highModeAnalysis } = analysis;
  const proseStyle = highModeAnalysis?.proseStyle ?? null;
  const proseTexture = highModeAnalysis?.proseTexture ?? null;

  const topChannels = proseStyle?.topChannels.slice(0, 5) ?? [];

  const modeColor = proseStyle ? (PROSE_MODE_COLOR[proseStyle.dominantMode] ?? "#94a3b8") : "#94a3b8";
  const ModeIcon = proseStyle ? (PROSE_MODE_ICON[proseStyle.dominantMode] ?? Info) : Info;

  // Register max — used to scale the mini-dials to chapter-relative max,
  // so the strongest register fills its ring even when absolute values
  // are low. Empty fallback handles the "no high-mode" case below.
  const registerMax = Math.max(
    registerSignals.literary,
    registerSignals.introspective,
    registerSignals.action,
    registerSignals.expository,
    1,
  );

  const hotspots = proseStyle?.hotspotParagraphs ?? [];
  const peakIdx = highModeAnalysis?.peakTrace?.paragraphIndex ?? null;

  return (
    <WidgetCard
      bg="#0d1117"
      accent={modeColor}
      heroAlign="start"
      topLeft="VOICE"
      topRight={register.toUpperCase()}
    >
      <div className="wg-content">
        {/* HERO — mode card. Only renders when high-mode analysis is
            present (proseStyle). Otherwise the widget jumps directly to
            the register mini-dials, which work without high-mode. */}
        {proseStyle && (
          <>
            <div
              className="wg-voice-hero"
              style={{
                color: modeColor,
                borderColor: `${modeColor}55`,
                background: `linear-gradient(135deg, ${modeColor}18, ${modeColor}06)`,
              }}
            >
              <span className="wg-voice-hero-icon" style={{ color: modeColor }}>
                <ModeIcon size={22} strokeWidth={2.4} />
              </span>
              <div className="wg-voice-hero-text">
                <span className="wg-voice-hero-mode">{proseStyle.dominantMode}</span>
                <span className="wg-voice-hero-key">DOMINANT MODE</span>
              </div>
              <div className="wg-voice-hero-stats">
                <div className="wg-voice-hero-stat">
                  <span className="wg-voice-hero-stat-num" style={{ color: modeColor }}>
                    {Math.round(proseStyle.sensoryDensity * 100)}
                  </span>
                  <span className="wg-voice-hero-stat-key">sense</span>
                </div>
                <div className="wg-voice-hero-stat">
                  <span className="wg-voice-hero-stat-num">
                    {Math.round(proseStyle.actionDensity * 100)}
                  </span>
                  <span className="wg-voice-hero-stat-key">action</span>
                </div>
                {proseTexture && (
                  <div className="wg-voice-hero-stat">
                    <span className="wg-voice-hero-stat-num">
                      {Math.round(proseTexture.dialogueRatio)}
                    </span>
                    <span className="wg-voice-hero-stat-key">dialog</span>
                  </div>
                )}
              </div>
            </div>

            {/* Sensory channel pills */}
            {topChannels.length > 0 && (
              <div className="wg-voice-channels">
                {topChannels.map(({ channel, count }) => {
                  const meta = SENSORY_META[channel] ?? {
                    label: channel, color: "#94a3b8", icon: Info,
                  };
                  const ChIcon = meta.icon;
                  return (
                    <span
                      key={channel}
                      className="wg-voice-chip"
                      style={{
                        color: meta.color,
                        borderColor: `${meta.color}38`,
                        background: `${meta.color}10`,
                      }}
                    >
                      <ChIcon size={11} strokeWidth={2.4} />
                      <span className="wg-voice-chip-name">{meta.label}</span>
                      <span className="wg-voice-chip-num">{count.toFixed(1)}</span>
                    </span>
                  );
                })}
              </div>
            )}

            {/* Compact signal-marker strip */}
            {(peakIdx != null || hotspots.length > 0) && (
              <div className="wg-voice-markers">
                {peakIdx != null && (
                  <span className="wg-voice-marker">
                    <Flame size={10} strokeWidth={2.4} />
                    <span className="wg-voice-marker-key">peak</span>
                    <span className="wg-voice-marker-val">¶{peakIdx + 1}</span>
                  </span>
                )}
                {hotspots.length > 0 && (
                  <span className="wg-voice-marker">
                    <Pin size={10} strokeWidth={2.4} />
                    <span className="wg-voice-marker-key">hotspot</span>
                    <span className="wg-voice-marker-val">
                      {hotspots.slice(0, 3).map((h) => `¶${h.index + 1}`).join(" ")}
                    </span>
                  </span>
                )}
              </div>
            )}

            <div className="wg-divider" />
          </>
        )}

        {/* REGISTER MINI-DIALS — always rendered (works without high-mode) */}
        <div className="wg-voice-registers">
          {REGISTER_DEFS.map((sig) => {
            const v = registerSignals[sig.key];
            const Icon = sig.icon;
            const fill = v === 0 ? 0 : Math.max(0.06, v / registerMax);
            const dim = v === 0;
            const c = dim ? "rgba(255,255,255,0.32)" : sig.accent;
            return (
              <div
                key={sig.key}
                className={`wg-voice-register ${dim ? "wg-voice-register--zero" : ""}`}
              >
                <ArcRing
                  size={56}
                  thickness={4}
                  startAngle={-90}
                  sweep={360}
                  color={sig.accent}
                  fill={fill}
                  trackColor="rgba(255, 255, 255, 0.06)"
                  indicatorDot={!dim}
                >
                  <span className="wg-voice-register-num" style={{ color: c }}>
                    {v}
                  </span>
                  <span className="wg-voice-register-icon" style={{ color: c }}>
                    <Icon size={9} strokeWidth={2.4} />
                  </span>
                </ArcRing>
                <span className="wg-voice-register-label">{sig.short}</span>
              </div>
            );
          })}
        </div>
      </div>
    </WidgetCard>
  );
}
