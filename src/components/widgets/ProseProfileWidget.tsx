import { memo, useMemo } from "react";
import { WidgetCard } from "./WidgetCard";
import { profileChapter, type ProseProfile } from "../../lib/prose-profile";
import { IOS_COLORS } from "../../lib/palette";

interface Props { content: string; }

const POV_LABEL: Record<ProseProfile["pov"], string> = {
  first: "1st person", second: "2nd person", third: "3rd person", mixed: "Mixed",
};
const POV_COLOR: Record<ProseProfile["pov"], string> = {
  first:  IOS_COLORS.purple.text,
  second: IOS_COLORS.cyan.text,
  third:  IOS_COLORS.blue.text,
  mixed:  IOS_COLORS.orange.text,
};

const TENSE_COLOR: Record<ProseProfile["tense"], string> = {
  past:    IOS_COLORS.indigo.text,
  present: IOS_COLORS.teal.text,
  mixed:   IOS_COLORS.orange.text,
};

const RHYTHM_COLOR: Record<ProseProfile["rhythm"], string> = {
  monotonous: IOS_COLORS.orange.text,
  even:       IOS_COLORS.blue.text,
  varied:     IOS_COLORS.green.text,
  erratic:    IOS_COLORS.red.text,
};

const SHOWTELL_COLOR: Record<ProseProfile["showTell"], string> = {
  showing:  IOS_COLORS.green.text,
  balanced: IOS_COLORS.blue.text,
  telling:  IOS_COLORS.orange.text,
};

const BAND_COLOR: Record<ProseProfile["fleschBand"], string> = {
  easy:   IOS_COLORS.green.text,
  medium: IOS_COLORS.blue.text,
  hard:   IOS_COLORS.purple.text,
};

function ProseProfileWidgetImpl({ content }: Props) {
  const p = useMemo(() => profileChapter(content), [content]);

  // Don't render below a meaningful sample size — too noisy.
  if (p.words < 80) return null;

  // Compose a one-line verdict that picks the most actionable signal.
  const headline = p.pov === "mixed"
    ? "POV DRIFT"
    : p.tense === "mixed"
    ? "TENSE DRIFT"
    : p.rhythm === "monotonous"
    ? "RHYTHM"
    : p.showTell === "telling"
    ? "TELLING"
    : "PROFILE";

  const accent = p.pov === "mixed" || p.tense === "mixed"
    ? IOS_COLORS.orange.text
    : p.rhythm === "monotonous"
    ? IOS_COLORS.orange.text
    : p.showTell === "telling"
    ? IOS_COLORS.orange.text
    : IOS_COLORS.blue.text;

  const verdict = (() => {
    if (p.pov === "mixed") return "Pronoun mix suggests a POV switch — verify it's intentional.";
    if (p.tense === "mixed") return "Past- and present-tense markers compete — pick a lane.";
    if (p.rhythm === "monotonous") return "Sentence lengths cluster tightly — vary them for rhythm.";
    if (p.showTell === "telling") return "High filter-word density — consider rendering moments through senses instead.";
    if (p.fleschBand === "hard") return `Reads at grade ${p.fleschGrade} — dense for fiction; check for run-ons.`;
    if (p.showTell === "showing") return "Concrete detail outpaces filtering — strong showing-prose pass.";
    return `Reads cleanly at grade ${p.fleschGrade}.`;
  })();

  // Five-row bar layout — each row is one metric. Column widths match
  // wg-momentum-row so this widget visually aligns with Momentum,
  // Sensory, Style Watch and Cross-Pacing.
  type Row = { label: string; valueText: string; color: string; pct: number };
  const rows: Row[] = [
    {
      label: "POV",
      valueText: POV_LABEL[p.pov],
      color: POV_COLOR[p.pov],
      pct: Math.round(Math.max(p.povRatio.first, p.povRatio.second, p.povRatio.third) * 100),
    },
    {
      label: "Tense",
      valueText: p.tense === "past" ? "Past" : p.tense === "present" ? "Present" : "Mixed",
      color: TENSE_COLOR[p.tense],
      pct: p.tense === "past"
        ? Math.round(p.tenseRatio.past * 100)
        : p.tense === "present"
        ? Math.round(p.tenseRatio.present * 100)
        : 50,
    },
    {
      label: "Reading",
      valueText: `Grade ${p.fleschGrade.toFixed(1)}`,
      color: BAND_COLOR[p.fleschBand],
      // Map grade 4..14 → 30..100% bar width
      pct: Math.max(20, Math.min(100, Math.round(((p.fleschGrade - 4) / 10) * 100))),
    },
    {
      label: "Rhythm",
      valueText: p.rhythm[0].toUpperCase() + p.rhythm.slice(1),
      color: RHYTHM_COLOR[p.rhythm],
      // Map cv 0..1 → 0..100% (clamp)
      pct: Math.min(100, Math.round(p.rhythmCv * 100)),
    },
    {
      label: "Show / tell",
      valueText: p.showTell[0].toUpperCase() + p.showTell.slice(1),
      color: SHOWTELL_COLOR[p.showTell],
      // Filter density % inverted so 0% filter = 100% bar (all showing)
      pct: Math.max(8, Math.min(100, Math.round((1 - Math.min(1, p.filterDensity / 3)) * 100))),
    },
  ];

  return (
    <WidgetCard
      bg="#0d1117"
      accent={accent}
      heroAlign="start"
      topLeft="PROSE PROFILE"
      topRight={headline}
    >
      <div className="wg-content">
        <div className="wg-section">
          {rows.map((r) => (
            <div className="wg-momentum-row" key={r.label}>
              <div className="wg-momentum-label">{r.label}</div>
              <div className="wg-momentum-bar">
                <div className="wg-momentum-bar-fill"
                  style={{ width: `${r.pct}%`, background: r.color }} />
              </div>
              <div className="wg-momentum-trend"
                style={{ color: r.color, fontVariantNumeric: "tabular-nums" }}>
                {r.valueText}
              </div>
            </div>
          ))}
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
