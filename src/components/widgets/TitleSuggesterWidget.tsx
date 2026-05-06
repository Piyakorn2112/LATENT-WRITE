import { memo, useMemo } from "react";
import { Hash } from "lucide-react";
import type { ChapterAnalysisResult } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";

/**
 * Chapter title suggester — proposes 3 candidate titles for the active
 * chapter, derived only from data the system already has:
 *
 *   • Peak-tension paragraph's evocative noun phrase (extracted with a
 *     light POS heuristic on the paragraph that triggered the chapter's
 *     tension peak).
 *   • Top entity name (most-mentioned proper noun in the chapter).
 *   • Arc-shape lexicon ("Rising", "The Falling", "Two Peaks", …) — a
 *     poetic re-styling of the chapter's `arcShape` classification.
 *
 * The widget is intentionally a quiet utility — three candidate lines,
 * each tagged with the data point that produced it, no scores, no UI
 * for "regenerate" (the data IS the regeneration: titles update as the
 * chapter changes). Clicking copies the title to the clipboard.
 */

interface Props {
  result: ChapterAnalysisResult;
  knownNames: string[];
}

const ARC_TITLE: Record<string, string> = {
  "slope-up":     "The Rising",
  "slope-down":   "The Falling",
  "plateau-high": "Held High",
  "spike":        "The Spike",
  "double-peak":  "Two Peaks",
  "valley":       "The Valley",
  "flat":         "Even Ground",
};

// Articles + stopwords we exclude when picking the "evocative noun
// phrase" from a paragraph — these words are grammatical glue, never
// the standout image of a sentence.
const NP_STOP = new Set([
  "the","a","an","of","to","in","on","at","by","for","with","from","into",
  "onto","as","is","was","were","are","be","been","being","have","has",
  "had","do","does","did","that","this","these","those","said","like",
]);

/**
 * Pick a 2-3 word noun-ish phrase from a paragraph for use as a title.
 * Strategy: scan for short capitalised proper-noun phrases first (those
 * carry the most narrative weight), then fall back to the most "image-
 * heavy" 2-word window — a noun adjacent to an adjective/verb that
 * isn't a stopword.
 */
function pickPhrase(para: string): string | null {
  if (!para) return null;
  // Capitalised 2-3 word phrase: "Iris's Garden", "the Stone Door".
  const propRe = /\b([A-Z][a-z]+(?:'s)?(?:\s+[A-Z][a-z]+)?(?:\s+[A-Z][a-z]+)?)\b/g;
  const props: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = propRe.exec(para)) !== null) {
    const tokens = m[1].split(/\s+/);
    if (tokens.length >= 2) props.push(m[1]);
  }
  if (props.length > 0) return props[0];

  // Fall back: 2-word adjacent non-stopword pair near the centre of the
  // paragraph. Adjectives + nouns near the centre are usually the
  // sentence's payload after the subject and before its tail.
  const tokens = para.split(/\s+/).filter((t) => t.length > 2);
  if (tokens.length < 4) return null;
  const start = Math.max(0, Math.floor(tokens.length * 0.35));
  const end = Math.min(tokens.length - 1, Math.floor(tokens.length * 0.7));
  for (let i = start; i < end; i++) {
    const a = tokens[i].replace(/[^a-zA-Z'-]/g, "").toLowerCase();
    const b = tokens[i + 1].replace(/[^a-zA-Z'-]/g, "").toLowerCase();
    if (!NP_STOP.has(a) && !NP_STOP.has(b) && a.length > 3 && b.length > 3) {
      // Title-case the chosen pair.
      const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
      return `${cap(a)} ${cap(b)}`;
    }
  }
  return null;
}

interface Suggestion {
  title: string;
  source: string;
}

function TitleSuggesterWidgetImpl({ result, knownNames }: Props) {
  const suggestions: Suggestion[] = useMemo(() => {
    const out: Suggestion[] = [];

    // 1. Peak-tension paragraph phrase.
    const a = result.analysis;
    const peakTrace = a.highModeAnalysis?.peakTrace;
    let peakIdx: number | null = null;
    if (peakTrace) peakIdx = peakTrace.paragraphIndex;
    else if (a.tensionCurve.length > 0) {
      // Lightweight peak find from the curve when high-mode isn't on.
      let max = 0;
      let mi = 0;
      for (let i = 0; i < a.tensionCurve.length; i++) {
        if (a.tensionCurve[i] > max) { max = a.tensionCurve[i]; mi = i; }
      }
      // Map curve index back to paragraph index proportionally.
      peakIdx = Math.round(
        (mi / Math.max(1, a.tensionCurve.length - 1)) * (result.paragraphs.length - 1),
      );
    }
    if (peakIdx != null && result.paragraphs[peakIdx]) {
      const phrase = pickPhrase(result.paragraphs[peakIdx]);
      if (phrase) out.push({ title: phrase, source: "peak" });
    }

    // 2. Top entity. Drop possessive 's so the title reads cleanly.
    if (knownNames.length > 0) {
      // Count mentions across the chapter.
      const counts = new Map<string, number>();
      const text = result.paragraphs.join(" ");
      for (const name of knownNames) {
        const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
        const c = (text.match(re) ?? []).length;
        if (c > 0) counts.set(name, c);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top && top[1] >= 2) {
        // Pair with the arc-shape descriptor for a richer title.
        const arc = ARC_TITLE[a.arcShape];
        const flavour =
          arc && a.arcShape !== "flat"
            ? `${top[0]}, ${arc}`
            : `${top[0]}'s Hour`;
        out.push({ title: flavour, source: "entity" });
      }
    }

    // 3. Arc-shape title — always fall through with this so the widget
    // never renders empty when the chapter is short.
    const arcTitle = ARC_TITLE[a.arcShape];
    if (arcTitle && !out.some((s) => s.title === arcTitle)) {
      out.push({ title: arcTitle, source: "arc" });
    }

    // Dedupe by lowercased title; keep first occurrence.
    const seen = new Set<string>();
    return out.filter((s) => {
      const k = s.title.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 3);
  }, [result, knownNames]);

  if (suggestions.length === 0) return null;

  const handleCopy = (title: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(title).catch(() => {/* ignored */});
    }
  };

  const SOURCE_LABEL: Record<string, string> = {
    peak:   "Peak phrase",
    entity: "Entity arc",
    arc:    "Arc shape",
  };

  return (
    <WidgetCard
      bg="#0d1117"
      accent="#a78bfa"
      heroAlign="start"
      topLeft="TITLES"
      topRight={`${suggestions.length} CANDIDATES`}
    >
      <div className="wg-content">
        <div className="wg-titles-list">
          {suggestions.map((s, i) => (
            <button
              key={s.title}
              type="button"
              className="wg-title-row"
              onClick={() => handleCopy(s.title)}
              title="Click to copy"
            >
              <span className="wg-title-rank">{i + 1}</span>
              <span className="wg-title-text">{s.title}</span>
              <span className="wg-title-source">{SOURCE_LABEL[s.source]}</span>
            </button>
          ))}
        </div>

        <div className="wg-section wg-section-divider">
          <div className="wg-action-line">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <Hash size={11} strokeWidth={2.4} style={{ opacity: 0.7 }} />
              Tap a candidate to copy. Suggestions update as the chapter changes.
            </span>
          </div>
        </div>
      </div>
    </WidgetCard>
  );
}

export const TitleSuggesterWidget = memo(TitleSuggesterWidgetImpl);
