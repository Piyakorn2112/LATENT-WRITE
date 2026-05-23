import { memo, useMemo } from "react";
import { Repeat2 } from "lucide-react";
import { WidgetCard } from "./WidgetCard";
import { findEchoes } from "../../lib/repetition";

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


function RepetitionWidgetImpl({ content }: Props) {
  const echoes = useMemo(() => findEchoes(content), [content]);

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
