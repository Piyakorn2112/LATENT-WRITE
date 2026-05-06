import { memo, useMemo } from "react";
import {
  User, Users, Hourglass,
  AudioWaveform, Lightbulb, BookOpen,
} from "lucide-react";
import { WidgetCard } from "./WidgetCard";
import { ArcRing } from "./ArcRing";
import { profileChapter, type ProseProfile } from "../../lib/prose-profile";

interface Props { content: string; }

// Dark-mode-tuned palette. The IOS_COLORS palette is calibrated for the
// light editor surface (purple/indigo/blue at `text` saturation read
// fine on white, but go DIM and low-contrast on #0d1117). These values
// are the dark-mode 400-tier equivalents — vivid against the card bg
// without bleaching out, and consistent with the StyleWatch / Sensory
// dark-widget family already in use elsewhere.

const POV_LABEL: Record<ProseProfile["pov"], string> = {
  first: "1st",
  second: "2nd",
  third: "3rd",
  mixed: "Mixed",
};
const POV_LONG: Record<ProseProfile["pov"], string> = {
  first: "First person",
  second: "Second person",
  third: "Third person",
  mixed: "Mixed POV",
};
const POV_COLOR: Record<ProseProfile["pov"], string> = {
  first:  "#c084fc", // violet-400  (was IOS purple #A828B8 — too dim)
  second: "#22d3ee", // cyan-400
  third:  "#60a5fa", // blue-400    (was IOS blue #1071D8 — too dim)
  mixed:  "#fb923c", // orange-400
};

const TENSE_LABEL: Record<ProseProfile["tense"], string> = {
  past: "Past", present: "Present", mixed: "Mixed",
};
const TENSE_COLOR: Record<ProseProfile["tense"], string> = {
  past:    "#818cf8", // indigo-400 (was IOS indigo #4F45D8 — too dim)
  present: "#5eead4", // teal-300
  mixed:   "#fb923c",
};

const RHYTHM_COLOR: Record<ProseProfile["rhythm"], string> = {
  monotonous: "#fbbf24", // amber-400  (was IOS orange — clarify "needs attention")
  even:       "#60a5fa", // blue-400
  varied:     "#34d399", // emerald-400
  erratic:    "#fb7185", // rose-400
};

const SHOWTELL_COLOR: Record<ProseProfile["showTell"], string> = {
  showing:  "#34d399", // emerald-400
  balanced: "#60a5fa", // blue-400
  telling:  "#fbbf24", // amber-400 (warning, not failure)
};

const BAND_COLOR: Record<ProseProfile["fleschBand"], string> = {
  easy:   "#34d399",
  medium: "#60a5fa",
  hard:   "#c084fc", // violet-400 — bright purple instead of IOS purple
};

/**
 * Prose profile — re-laid out as two visual tiers:
 *
 *   1. Hero row: two prominent pill-cards encoding the chapter's
 *      categorical signals (POV + Tense). Both come with a lucide
 *      glyph that maps to the category, so the row reads instantly.
 *      Drift cases ("mixed") tint the pill orange and the headline
 *      flips to "POV DRIFT" / "TENSE DRIFT".
 *
 *   2. Three micro-dials: continuous-arc rings for Reading grade,
 *      Rhythm variance, and Show/Tell balance. Each centre carries a
 *      compact numeric + tiny label, matching the StyleWatch mini-dial
 *      family already in use elsewhere.
 *
 *   3. Action line + secondary stats footer (sentence count, filter
 *      density) — same as before.
 *
 * Replaces the prior generic 5-row bar list. Categorical data gets
 * categorical UI (pills with text); continuous data gets continuous
 * UI (arcs with numerics). That's the move from the HI brief: native
 * to the data shape, not one bar-chart for everything.
 */
function ProseProfileWidgetImpl({ content }: Props) {
  const p = useMemo(() => profileChapter(content), [content]);

  if (p.words < 80) return null;

  const headline = p.pov === "mixed"
    ? "POV DRIFT"
    : p.tense === "mixed"
    ? "TENSE DRIFT"
    : p.rhythm === "monotonous"
    ? "RHYTHM"
    : p.showTell === "telling"
    ? "TELLING"
    : "PROFILE";

  const accent = p.pov === "mixed" || p.tense === "mixed" || p.rhythm === "monotonous" || p.showTell === "telling"
    ? "#fb923c"  // orange-400 — warning state
    : "#60a5fa"; // blue-400 — neutral default

  const verdict = (() => {
    if (p.pov === "mixed") return "Pronoun mix suggests a POV switch — verify it's intentional.";
    if (p.tense === "mixed") return "Past- and present-tense markers compete — pick a lane.";
    if (p.rhythm === "monotonous") return "Sentence lengths cluster tightly — vary them for rhythm.";
    if (p.showTell === "telling") return "High filter-word density — consider rendering moments through senses instead.";
    if (p.fleschBand === "hard") return `Reads at grade ${p.fleschGrade} — dense for fiction; check for run-ons.`;
    if (p.showTell === "showing") return "Concrete detail outpaces filtering — strong showing-prose pass.";
    return `Reads cleanly at grade ${p.fleschGrade}.`;
  })();

  // POV pill picks an icon by person (User for 1st-person singular,
  // Users for 2nd/3rd which often involves multiple referents).
  const PovIcon = p.pov === "first" ? User : Users;

  // Reading grade dial — map grades 4..14 onto 0..1 fill, accent by band.
  const gradeFill = Math.max(0.18, Math.min(1, (p.fleschGrade - 4) / 10));

  // Rhythm dial — coefficient of variation 0..1+, clamp.
  const rhythmFill = Math.min(1, Math.max(0.08, p.rhythmCv));

  // Show/Tell dial — invert filter density so 100% = pure showing.
  const showTellFill = Math.max(0.08, Math.min(1, 1 - Math.min(1, p.filterDensity / 3)));

  // Topline POV-confidence percentage (most-dominant POV ratio).
  const povPct = Math.round(
    Math.max(p.povRatio.first, p.povRatio.second, p.povRatio.third) * 100,
  );
  // Tense confidence — if mixed, neither side dominates, show 50%.
  const tensePct = p.tense === "past"
    ? Math.round(p.tenseRatio.past * 100)
    : p.tense === "present"
    ? Math.round(p.tenseRatio.present * 100)
    : 50;

  const povColor   = POV_COLOR[p.pov];
  const tenseColor = TENSE_COLOR[p.tense];
  const gradeColor = BAND_COLOR[p.fleschBand];
  const rhythmColor = RHYTHM_COLOR[p.rhythm];
  const showTellColor = SHOWTELL_COLOR[p.showTell];

  return (
    <WidgetCard
      bg="#0d1117"
      accent={accent}
      heroAlign="start"
      topLeft="PROSE PROFILE"
      topRight={headline}
    >
      <div className="wg-content">
        {/* Hero — POV + Tense as twin category cards */}
        <div className="wg-prose-hero">
          <div
            className="wg-prose-pill"
            style={{
              color: povColor,
              borderColor: `${povColor}55`,
              background: `${povColor}10`,
            }}
          >
            <span className="wg-prose-pill-icon">
              <PovIcon size={13} strokeWidth={2.4} />
            </span>
            <div className="wg-prose-pill-text">
              <span className="wg-prose-pill-value">{POV_LABEL[p.pov]}</span>
              <span className="wg-prose-pill-key">{POV_LONG[p.pov]}</span>
            </div>
            <span className="wg-prose-pill-pct">{povPct}%</span>
          </div>
          <div
            className="wg-prose-pill"
            style={{
              color: tenseColor,
              borderColor: `${tenseColor}55`,
              background: `${tenseColor}10`,
            }}
          >
            <span className="wg-prose-pill-icon">
              <Hourglass size={13} strokeWidth={2.4} />
            </span>
            <div className="wg-prose-pill-text">
              <span className="wg-prose-pill-value">{TENSE_LABEL[p.tense]}</span>
              <span className="wg-prose-pill-key">tense</span>
            </div>
            <span className="wg-prose-pill-pct">{tensePct}%</span>
          </div>
        </div>

        {/* Three micro-dials — continuous metrics get continuous UI */}
        <div className="wg-prose-dials">
          <div className="wg-prose-dial">
            <ArcRing
              size={62}
              thickness={5}
              startAngle={-90}
              sweep={360}
              color={gradeColor}
              fill={gradeFill}
              trackColor="rgba(255, 255, 255, 0.06)"
              indicatorDot
            >
              <span className="wg-prose-dial-num" style={{ color: gradeColor }}>
                {p.fleschGrade.toFixed(1)}
              </span>
              <span className="wg-prose-dial-icon" style={{ color: gradeColor }}>
                <BookOpen size={10} strokeWidth={2.4} />
              </span>
            </ArcRing>
            <span className="wg-prose-dial-label">Reading</span>
            <span className="wg-prose-dial-sub" style={{ color: gradeColor }}>
              {p.fleschBand}
            </span>
          </div>

          <div className="wg-prose-dial">
            <ArcRing
              size={62}
              thickness={5}
              startAngle={-90}
              sweep={360}
              color={rhythmColor}
              fill={rhythmFill}
              trackColor="rgba(255, 255, 255, 0.06)"
              indicatorDot
            >
              <span className="wg-prose-dial-num" style={{ color: rhythmColor }}>
                {Math.round(rhythmFill * 100)}
              </span>
              <span className="wg-prose-dial-icon" style={{ color: rhythmColor }}>
                <AudioWaveform size={10} strokeWidth={2.4} />
              </span>
            </ArcRing>
            <span className="wg-prose-dial-label">Rhythm</span>
            <span className="wg-prose-dial-sub" style={{ color: rhythmColor }}>
              {p.rhythm}
            </span>
          </div>

          <div className="wg-prose-dial">
            <ArcRing
              size={62}
              thickness={5}
              startAngle={-90}
              sweep={360}
              color={showTellColor}
              fill={showTellFill}
              trackColor="rgba(255, 255, 255, 0.06)"
              indicatorDot
            >
              <span className="wg-prose-dial-icon" style={{ color: showTellColor }}>
                <Lightbulb size={11} strokeWidth={2.4} />
              </span>
              <span className="wg-prose-dial-num" style={{ color: showTellColor }}>
                {Math.round(showTellFill * 100)}
              </span>
            </ArcRing>
            <span className="wg-prose-dial-label">Show / Tell</span>
            <span className="wg-prose-dial-sub" style={{ color: showTellColor }}>
              {p.showTell}
            </span>
          </div>
        </div>

        <div className="wg-section wg-section-divider">
          <div className="wg-action-line">{verdict}</div>
          <div className="wg-style-meta">
            <span className="wg-style-meta-label">Sentences</span>
            <span className="wg-style-meta-value">{p.sentences}</span>
            <span className="wg-style-meta-sep">·</span>
            <span className="wg-style-meta-label">Filter</span>
            <span className="wg-style-meta-value">{p.filterDensity.toFixed(1)}/100</span>
          </div>
        </div>
      </div>
    </WidgetCard>
  );
}

export const ProseProfileWidget = memo(ProseProfileWidgetImpl);
