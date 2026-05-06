import { memo, useMemo } from "react";
import { Repeat2 } from "lucide-react";
import { WidgetCard } from "./WidgetCard";

/**
 * Repetition / Echo finder — surfaces 3-grams and 4-grams that repeat
 * verbatim within the chapter. Goes deeper than `StyleWatchWidget`'s
 * single-word echoes by catching phrasal tics ("the cold smile", "as
 * if she", "his eyes were") which are the actual writerly stuck-record
 * patterns.
 *
 * Algorithm:
 *   1. Tokenise content lowercased, dropping punctuation. Skip stop-
 *      heavy n-grams (where ≥ ⌈k/2⌉ tokens are stopwords) — those are
 *      grammatical noise ("of the", "and the") not stylistic repetition.
 *   2. Count 4-grams first; for any 4-gram that repeats, also extract
 *      its constituent 3-grams to a "covered" set so we don't double-
 *      report a 3-gram that's strictly part of a 4-gram match.
 *   3. Surface the top 5 by count, longest n first, count tiebreak.
 *   4. For each top match, find the FIRST paragraph index where it
 *      occurs — useful for "where do I look".
 *
 * Pure local — no async, no external systems.
 */

interface Props {
  content: string;
}

const STOPWORDS = new Set([
  "the","a","an","and","or","but","of","to","in","on","at","by","for",
  "with","from","into","onto","as","is","was","were","are","be","been",
  "being","have","has","had","do","does","did","that","this","these",
  "those","i","he","she","it","we","you","they","him","her","them",
  "his","hers","its","their","my","your","our","what","which","who",
  "whom","when","where","why","how","not","no","so","if","then","than",
  "there","here","up","down","out","over","under","off","just","very",
  "yet","still","also","said","like","one","two",
]);

function tokenize(text: string): string[] {
  // Lowercase + match runs of letters/apostrophes — preserves contractions
  // ("it's" → "it's") and drops punctuation.
  return (text.toLowerCase().match(/\b[a-z][a-z'-]*\b/g) ?? []);
}

function ngramKey(tokens: string[], i: number, k: number): string {
  let s = tokens[i];
  for (let j = 1; j < k; j++) s += " " + tokens[i + j];
  return s;
}

function isStopHeavy(key: string, k: number): boolean {
  let stops = 0;
  for (const t of key.split(" ")) {
    if (STOPWORDS.has(t)) stops++;
  }
  // Drop n-grams that are mostly grammatical glue.
  return stops >= Math.ceil(k / 2);
}

function paragraphsOf(content: string): string[] {
  return content
    .split(/\n{2,}|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface Echo {
  phrase: string;
  count: number;
  k: number;
  firstParaIndex: number;
}

function RepetitionWidgetImpl({ content }: Props) {
  const echoes: Echo[] = useMemo(() => {
    if (!content || content.length < 200) return [];

    const tokens = tokenize(content);
    if (tokens.length < 12) return [];

    // Count 4-grams + 3-grams in one pass.
    const fourGrams = new Map<string, number>();
    const threeGrams = new Map<string, number>();
    for (let i = 0; i <= tokens.length - 3; i++) {
      const k3 = ngramKey(tokens, i, 3);
      if (!isStopHeavy(k3, 3)) {
        threeGrams.set(k3, (threeGrams.get(k3) ?? 0) + 1);
      }
      if (i <= tokens.length - 4) {
        const k4 = ngramKey(tokens, i, 4);
        if (!isStopHeavy(k4, 4)) {
          fourGrams.set(k4, (fourGrams.get(k4) ?? 0) + 1);
        }
      }
    }

    // Build "covered" set: any 3-gram fully contained inside a repeating
    // 4-gram is dropped from the 3-gram pool to avoid double counting.
    const covered = new Set<string>();
    for (const [k4, n] of fourGrams) {
      if (n < 2) continue;
      const parts = k4.split(" ");
      covered.add(parts.slice(0, 3).join(" "));
      covered.add(parts.slice(1, 4).join(" "));
    }

    const collected: Echo[] = [];
    for (const [k4, n] of fourGrams) {
      if (n >= 2) collected.push({ phrase: k4, count: n, k: 4, firstParaIndex: -1 });
    }
    for (const [k3, n] of threeGrams) {
      if (n >= 3 && !covered.has(k3)) {
        // 3-grams need a higher count threshold (3) than 4-grams (2)
        // because shorter sequences randomly co-occur more.
        collected.push({ phrase: k3, count: n, k: 3, firstParaIndex: -1 });
      }
    }

    if (collected.length === 0) return [];

    // First-paragraph attribution. Walk paragraphs in order; mark the
    // earliest paragraph each phrase is seen in.
    const paras = paragraphsOf(content);
    const phrases = collected.map((e) => e.phrase);
    const phraseRe = phrases.map((p) => ({
      phrase: p,
      // Word-bounded, case-insensitive — we lowercased during count, but
      // the original paragraph might have any casing.
      re: new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
    }));
    for (let pi = 0; pi < paras.length; pi++) {
      const p = paras[pi];
      for (const { phrase, re } of phraseRe) {
        const echo = collected.find((e) => e.phrase === phrase);
        if (echo && echo.firstParaIndex === -1 && re.test(p)) {
          echo.firstParaIndex = pi + 1;
        }
      }
    }

    // Top 5 by [longer n first, count desc].
    return collected
      .sort((a, b) => b.k - a.k || b.count - a.count)
      .slice(0, 5);
  }, [content]);

  if (echoes.length === 0) {
    return null;
  }

  const topCount = echoes[0]?.count ?? 1;
  const accent = echoes[0]?.k === 4 ? "#f43f5e" : "#fbbf24";

  return (
    <WidgetCard
      bg="#0d1117"
      accent={accent}
      heroAlign="start"
      topLeft="REPETITION"
      topRight={`${echoes.length} ECHO${echoes.length === 1 ? "" : "ES"}`}
    >
      <div className="wg-content">
        <div className="wg-rep-hero">
          <span className="wg-rep-hero-num" style={{ color: accent }}>
            {echoes.reduce((s, e) => s + e.count, 0)}
          </span>
          <span className="wg-rep-hero-key">total hits</span>
          <span className="wg-rep-hero-icon" style={{ color: accent }}>
            <Repeat2 size={18} strokeWidth={2.4} />
          </span>
        </div>

        <div className="wg-section">
          {echoes.map((e) => {
            const intensity = Math.min(1, e.count / Math.max(topCount, 2));
            const fillPct = 12 + intensity * 88;
            const c = e.k === 4 ? "#f43f5e" : "#fbbf24";
            return (
              <div className="wg-rep-row" key={e.phrase}>
                <span className="wg-rep-kbadge" style={{ color: c, borderColor: `${c}55` }}>
                  {e.k}-gram
                </span>
                <span className="wg-rep-phrase">"{e.phrase}"</span>
                <div className="wg-rep-bar">
                  <div
                    className="wg-rep-bar-fill"
                    style={{ width: `${fillPct}%`, background: c }}
                  />
                </div>
                <span className="wg-rep-count" style={{ color: c }}>
                  ×{e.count}
                </span>
                {e.firstParaIndex > 0 && (
                  <span className="wg-rep-loc">¶{e.firstParaIndex}</span>
                )}
              </div>
            );
          })}
        </div>

        <div className="wg-section wg-section-divider">
          <div className="wg-action-line">
            {echoes[0].k === 4
              ? `"${echoes[0].phrase}" repeats ${echoes[0].count}× — varying just one word will lift the prose.`
              : `Phrasal tics found — review and substitute where the repetition isn't deliberate.`}
          </div>
        </div>
      </div>
    </WidgetCard>
  );
}

export const RepetitionWidget = memo(RepetitionWidgetImpl);
