import { memo, useMemo } from "react";
import { WidgetCard } from "./WidgetCard";
import {
  profileCharacterVoices, computeTagVariety,
  type CharacterVoiceStat,
} from "../../lib/character-voice";
import type { ChapterParaResult } from "../../lib/speech-detect";
import type { WorldData } from "../../types";
import { buildSpeakerPalette, getSpeakerColor, IOS_COLORS } from "../../lib/palette";

interface Props {
  paragraphs: string[];
  speechResults: ChapterParaResult[];
  worldData: WorldData | undefined;
  /** Joined chapter text for tag-variety computation. */
  content: string;
}

const VERDICT_COLOR: Record<string, string> = {
  balanced:     IOS_COLORS.green.text,
  "said-heavy": IOS_COLORS.orange.text,
  purple:       IOS_COLORS.purple.text,
  "no-data":    IOS_COLORS.blue.text,
};

function CharacterVoiceWidgetImpl({ paragraphs, speechResults, worldData, content }: Props) {
  const stats: CharacterVoiceStat[] = useMemo(
    () => profileCharacterVoices(paragraphs, speechResults, worldData),
    [paragraphs, speechResults, worldData],
  );
  const tag = useMemo(() => computeTagVariety(content), [content]);

  // Need at least 2 named speakers to be meaningful — otherwise it's just
  // restating per-character data the Cast widget already shows.
  if (stats.length < 2) return null;

  // Stable per-character colours from the existing palette so the widget
  // visually matches the entity highlights in the editor and the Cast card.
  const palette = buildSpeakerPalette(stats.map((s) => s.name));

  // Pick widget accent: red if any pronoun mismatch, else the most-spoken
  // character's colour (so the widget visually leads with the lead voice).
  const mismatch = stats.find((s) => s.pronounMismatch);
  const accent = mismatch
    ? IOS_COLORS.red.text
    : getSpeakerColor(palette, stats[0].name).text;

  const headline = mismatch
    ? "PRONOUN"
    : tag.verdict === "said-heavy" ? "TAG VARIETY"
    : tag.verdict === "purple"     ? "TAG OVERFLOW"
    : "VOICE";

  // Bar scaling: longest avg line drives the 100% mark.
  const maxAvg = Math.max(...stats.map((s) => s.avgLineLength), 1);

  return (
    <WidgetCard
      bg="#0d1117"
      accent={accent}
      heroAlign="start"
      topLeft="CHARACTER VOICE"
      topRight={headline}
    >
      <div className="wg-content">
        <div className="wg-section">
          {stats.slice(0, 5).map((s) => {
            const color = getSpeakerColor(palette, s.name).text;
            const pct = Math.max(8, Math.round((s.avgLineLength / maxAvg) * 100));
            return (
              <div className="wg-momentum-row" key={s.name}>
                <div className="wg-momentum-label" style={{ color }}>
                  {s.name}
                </div>
                <div className="wg-momentum-bar">
                  <div className="wg-momentum-bar-fill"
                    style={{ width: `${pct}%`, background: color }} />
                </div>
                <div className="wg-momentum-trend"
                  style={{ color, fontVariantNumeric: "tabular-nums" }}>
                  {s.avgLineLength.toFixed(0)}w
                </div>
              </div>
            );
          })}
        </div>

        {/* Pronoun mismatches surface first if present — most actionable. */}
        {mismatch && (
          <div className="wg-section wg-section-divider">
            <div className="wg-action-line">
              <strong style={{ color: IOS_COLORS.red.text }}>{mismatch.name}</strong>
              {" "}is described in worldData as a {mismatch.gender}, but pronouns near
              their dialogue read as <em>{mismatch.pronounMismatch!.observed}/them</em>.
              Reconcile or update the role description.
            </div>
          </div>
        )}

        {/* Tag variety — single line meta */}
        {tag.verdict !== "no-data" && !mismatch && (
          <div className="wg-section wg-section-divider">
            <div className="wg-action-line">
              {tag.verdict === "said-heavy"
                ? `"${Math.round(tag.saidPct * 100)}%" of attributions are plain "said". Some flavoured tags would lift the rhythm.`
                : tag.verdict === "purple"
                ? `Coloured attribution verbs dominate (${Math.round((1 - tag.saidPct) * 100)}%). "Said" is invisible — let it carry more lines.`
                : "Tag variety reads balanced — plain \"said\" carries most lines, coloured verbs accent the rest."}
            </div>
            <div className="wg-style-meta">
              <span className="wg-style-meta-label">Said</span>
              <span className="wg-style-meta-value" style={{ color: VERDICT_COLOR[tag.verdict] }}>
                {Math.round(tag.saidPct * 100)}%
              </span>
              <span className="wg-style-meta-sep">·</span>
              <span className="wg-style-meta-label">Coloured</span>
              <span className="wg-style-meta-value">{tag.coloured}</span>
              <span className="wg-style-meta-sep">·</span>
              <span className="wg-style-meta-label">Voices</span>
              <span className="wg-style-meta-value">{stats.length}</span>
            </div>
          </div>
        )}
      </div>
    </WidgetCard>
  );
}

export const CharacterVoiceWidget = memo(CharacterVoiceWidgetImpl);
