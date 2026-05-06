import { memo, useMemo } from "react";
import { Eye, ArrowLeftRight, Megaphone, FileType, Quote } from "lucide-react";
import { WidgetCard } from "./WidgetCard";
import { ArcRing } from "./ArcRing";
import { checkGrammar, type GrammarSuggestion } from "../../lib/grammar-check";

// Per-kind icon — gives each mini-dial a distinct visual identity that
// reads at a glance without needing to read the label below. The icons
// pick up the same colour as the dial fill, so the kind is encoded
// twice (icon shape + colour) for redundancy.
const KIND_ICON: Record<string, typeof Eye> = {
  filter:  Eye,            // "filter words" = perception verbs
  passive: ArrowLeftRight, // passive voice flips subject ↔ object
  adverb:  Megaphone,      // -ly attribution loudens dialogue
  wordy:   FileType,       // wordy = excess text
  cliche:  Quote,          // clichés are quoted-from-elsewhere phrases
};

// Style Watch — derives prose-style metrics from the same grammar pass
// already running on the chapter, plus a couple of light NLP signals
// (sentence-start variety, repeated word echoes within 60-word windows).
//
// The widget intentionally surfaces *style* flags only — outright errors
// (spelling, agreement, confusable, etc.) are still rendered inline by
// HighlightLayer. Style-class flags would flood the editor if shown
// inline, so we aggregate them here.

interface Props {
  /** Raw chapter content. */
  content: string;
}

const STYLE_KINDS: GrammarSuggestion["kind"][] = [
  "filter", "passive", "adverb", "wordy", "cliche",
];

const KIND_META: Record<GrammarSuggestion["kind"], { label: string; color: string }> = {
  filter:      { label: "Filter words",       color: "#fbbf24" },
  passive:     { label: "Passive voice",      color: "#60a5fa" },
  adverb:      { label: "-ly attribution",    color: "#f472b6" },
  wordy:       { label: "Wordy phrases",      color: "#fb923c" },
  cliche:      { label: "Clichés",            color: "#f43f5e" },
  spelling:    { label: "Spelling",           color: "#ef4444" },
  confusable:  { label: "Confusables",        color: "#a78bfa" },
  spacing:     { label: "Spacing",            color: "#94a3b8" },
  double:      { label: "Doubled words",      color: "#94a3b8" },
  punctuation: { label: "Punctuation",        color: "#94a3b8" },
  agreement:   { label: "Agreement",          color: "#ef4444" },
  article:     { label: "Articles (a/an)",    color: "#a78bfa" },
  capital:     { label: "Capitalization",     color: "#a78bfa" },
};

// Sentence splitter — rough but good enough for variety analysis.
function splitSentences(text: string): string[] {
  const out: string[] = [];
  // Split on sentence terminators followed by whitespace+capital, OR end of string.
  const re = /[^.!?]+[.!?]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  if (out.length === 0 && text.trim()) out.push(text.trim());
  return out;
}

function firstTwoWords(s: string): string {
  const w = s.replace(/^[^A-Za-z]+/, "").split(/\s+/).slice(0, 2).join(" ").toLowerCase();
  return w;
}

// Detect echoes: same uncommon word repeated within `windowWords` words.
const STOPWORDS = new Set([
  "the","a","an","and","but","or","of","to","in","on","for","with","as","at",
  "by","from","into","onto","that","this","these","those","is","was","were",
  "are","be","been","being","have","has","had","do","does","did","will","would",
  "could","should","may","might","must","not","no","yes","so","too","very","just",
  "all","any","some","more","most","much","many","less","few","each","every",
  "i","me","my","mine","you","your","yours","he","him","his","she","her","hers",
  "it","its","we","us","our","ours","they","them","their","theirs",
  "what","which","who","whom","whose","when","where","why","how","there","here",
  "if","then","than","because","while","whether","also","yet","still","up","down",
  "out","over","under","off","said","like",
]);

interface Echo { word: string; count: number; gap: number; }

function findEchoes(text: string, windowWords = 60): Echo[] {
  const tokens = (text.toLowerCase().match(/\b[a-z][a-z'-]{4,}\b/g) ?? []);
  const seen = new Map<string, number>(); // word → most-recent token index
  const found = new Map<string, Echo>();
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i];
    if (STOPWORDS.has(w)) continue;
    const prev = seen.get(w);
    if (prev != null && i - prev <= windowWords) {
      const existing = found.get(w);
      if (existing) {
        existing.count += 1;
        existing.gap = Math.min(existing.gap, i - prev);
      } else {
        found.set(w, { word: w, count: 2, gap: i - prev });
      }
    }
    seen.set(w, i);
  }
  return [...found.values()]
    .sort((a, b) => (b.count - a.count) || (a.gap - b.gap))
    .slice(0, 5);
}

function StyleWatchWidgetImpl({ content }: Props) {
  const data = useMemo(() => {
    const all = checkGrammar(content);
    const counts: Record<string, number> = {};
    for (const k of STYLE_KINDS) counts[k] = 0;
    for (const s of all) {
      if ((STYLE_KINDS as string[]).includes(s.kind)) {
        counts[s.kind] = (counts[s.kind] ?? 0) + 1;
      }
    }

    const sentences = splitSentences(content);
    const sentenceCount = sentences.length;
    // Variety = unique opener-bigrams / sentence count. 1.0 = every opener
    // unique; ~0.5 means half the sentences start the same way.
    const openers = new Map<string, number>();
    for (const s of sentences) {
      const op = firstTwoWords(s);
      if (op) openers.set(op, (openers.get(op) ?? 0) + 1);
    }
    const variety = sentenceCount > 0 ? openers.size / sentenceCount : 1;
    const topOpener = [...openers.entries()].sort((a, b) => b[1] - a[1])[0];

    const echoes = findEchoes(content);

    const totalStyleHits = STYLE_KINDS.reduce((s, k) => s + (counts[k] ?? 0), 0);

    return {
      counts,
      totalStyleHits,
      variety,
      topOpener: topOpener && topOpener[1] >= 3 ? topOpener : null,
      sentenceCount,
      echoes,
    };
  }, [content]);

  const orderedKinds = STYLE_KINDS
    .map((k) => ({ kind: k, count: data.counts[k] ?? 0 }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);

  // Pick the dominant accent — the highest-count style category.
  const accent = orderedKinds[0]
    ? KIND_META[orderedKinds[0].kind].color
    : "#34d399";

  // Compose a single-line suggestion that picks the most actionable signal.
  const headline = (() => {
    if (data.totalStyleHits === 0 && data.echoes.length === 0 && !data.topOpener) {
      return "CLEAN PASS";
    }
    if (orderedKinds[0]) return KIND_META[orderedKinds[0].kind].label.toUpperCase();
    if (data.echoes.length) return "WORD ECHOES";
    if (data.topOpener) return "REPEAT OPENERS";
    return "STYLE WATCH";
  })();

  const verdict = (() => {
    if (data.totalStyleHits === 0 && data.echoes.length === 0 && !data.topOpener) {
      return "Prose is clean of common style traps in this pass — filter words, passive constructions, attribution adverbs, and clichés all check out.";
    }
    const parts: string[] = [];
    if (orderedKinds[0]) {
      const top = orderedKinds[0];
      parts.push(`${top.count}× ${KIND_META[top.kind].label.toLowerCase()}`);
    }
    if (data.topOpener) {
      parts.push(`"${data.topOpener[0]}…" opens ${data.topOpener[1]} sentences`);
    }
    if (data.echoes.length) {
      const e = data.echoes[0];
      parts.push(`"${e.word}" repeats inside ${e.gap} words`);
    }
    return parts.join(" · ") + ".";
  })();

  const max = Math.max(...orderedKinds.map((x) => x.count), 1);

  return (
    <WidgetCard
      bg="#0d1117"
      accent={accent}
      heroAlign="start"
      topLeft="STYLE WATCH"
      topRight={headline}
    >
      <div className="wg-content">
        {/* Row of five mini dials — one per style category. Each dial's
            fill is the count vs. the chapter-relative max, so the
            highest-count category fills its ring fully and the others
            scale proportionally. Zero-count categories get a muted
            opacity rather than disappearing, so the row's grid stays
            stable across chapters. */}
        <div className="wg-mini-dials">
          {STYLE_KINDS.map((kind) => {
            const count = data.counts[kind] ?? 0;
            const color = KIND_META[kind].color;
            const fill = max === 0 ? 0 : count / max;
            const Icon = KIND_ICON[kind];
            return (
              <div
                key={kind}
                className={`wg-mini-dial ${count === 0 ? "wg-mini-dial--zero" : ""}`}
              >
                <ArcRing
                  size={58}
                  thickness={4.5}
                  startAngle={-90}
                  sweep={360}
                  color={color}
                  fill={count === 0 ? 0 : Math.max(0.06, fill)}
                  trackColor="rgba(255, 255, 255, 0.07)"
                  rounded
                  indicatorDot={count > 0}
                >
                  <span
                    className="wg-mini-dial-num"
                    style={{ color: count === 0 ? "rgba(255,255,255,0.42)" : color }}
                  >
                    {count}
                  </span>
                  {Icon && (
                    <span
                      className="wg-mini-dial-icon"
                      style={{ color: count === 0 ? "rgba(255,255,255,0.32)" : color }}
                    >
                      <Icon size={9} strokeWidth={2.4} />
                    </span>
                  )}
                </ArcRing>
                <span className="wg-mini-dial-label">{KIND_META[kind].label}</span>
              </div>
            );
          })}
        </div>

        <div className="wg-section wg-section-divider">
          <div className="wg-action-line">{verdict}</div>
          {(data.echoes.length > 0 || data.topOpener) && (
            <div className="wg-style-meta">
              <span className="wg-style-meta-label">Variety</span>
              <span
                className="wg-style-meta-value"
                style={{ color: data.variety < 0.6 ? "#fbbf24" : "#94a3b8" }}
              >
                {Math.round(data.variety * 100)}%
              </span>
              <span className="wg-style-meta-sep">·</span>
              <span className="wg-style-meta-label">Echoes</span>
              <span className="wg-style-meta-value" style={{ color: data.echoes.length ? "#fbbf24" : "#94a3b8" }}>
                {data.echoes.length}
              </span>
            </div>
          )}
        </div>
      </div>
    </WidgetCard>
  );
}

export const StyleWatchWidget = memo(StyleWatchWidgetImpl);
