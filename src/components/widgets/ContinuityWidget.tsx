import { memo, useMemo } from "react";
import {
  AlertTriangle, ArrowRight, Clock4, MapPin,
  Anchor, Sparkles,
} from "lucide-react";
import { WidgetCard } from "./WidgetCard";
import { summarizeContinuity } from "../../lib/continuity";
import { surfacedKnowledgeFindings, isPinnedFinding } from "../../lib/knowledge-store";
import type { KnowledgeCandidate, KnowledgeLedgerStore } from "../../lib/knowledge-store";
import type { Chapter, WorldData } from "../../types";

// Dark-mode-tuned issue colours. The system's IOS_COLORS palette is
// calibrated for the light editor surface (red/orange/purple at
// `text` saturation level look fine on white, but read DIM on
// #0d1117). These three values are the dark-mode equivalents — rose-
// 400, orange-400, violet-300 — and pass AA contrast against the card
// bg without bleaching out.

interface Props {
  chapters: Chapter[];
  worldData: WorldData | undefined;
  chapterIndex: number;
  /** Knowledge ledger. Findings are read through the shared selector only. */
  knowledgeStore?: KnowledgeLedgerStore;
  /**
   * Chekhov phrases the local model confirmed are real promises, lowercased,
   * from `confirmedPromises` — the shared selector, never re-derived here.
   *
   * ★ IT MARKS, IT NEVER FILTERS. The regex found every phrase in this list and
   *   the writer can see them all; a small model's "furniture" verdict is not
   *   the authority that removes one from view. Confirmation is additive —
   *   spec §3.2, and the reason a wrong verdict costs a writer nothing here.
   */
  confirmedChekhov?: Set<string>;
  onKnewAlready?: (candidate: KnowledgeCandidate) => void;
  onGoodCatch?: (candidate: KnowledgeCandidate) => void;
}

/**
 * Continuity — redesigned around three visually-distinct issue blocks
 * with a top severity strip that summarises everything at a glance.
 *
 *   1. SEVERITY STRIP — compact chip row at top: timeline / hand-off /
 *      chekhov counts, severity-tinted. The chapter's overall
 *      continuity health reads in one scan, no scrolling required.
 *
 *   2. TIMELINE SLIPS — "introduced later, appearing now" characters
 *      get a list of warning chips with chapter-pin badges.
 *      Replaces the previous bar-row treatment which encoded no
 *      meaningful magnitude (just a constant red bar).
 *
 *   3. HAND-OFF — visual flow: prev-chapter card → arrow → this-chapter
 *      card. Each card shows place + time icon + value. Drift dimension
 *      ("place", "time", "both") tints the arrow + outline.
 *
 *   4. CHEKHOV — small pill stack of "introduced but never recurs"
 *      phrases, each with a tiny anchor icon since they're floating
 *      threads waiting for an anchor.
 *
 *   5. KNOWLEDGE — adjudicated "this character cannot know that yet"
 *      findings from the knowledge ledger. Same block grammar, and the
 *      same family as a timeline slip (someone is ahead of the story),
 *      so it carries the timeline colour rather than a new one.
 *      SILENCE IS THE DEFAULT: no findings renders no heading, no empty
 *      state, nothing at all.
 *
 * Replaces the prior mixed-language layout with a unified visual
 * grammar across all three issue types.
 */

const TIMELINE_COLOR = "#fb7185"; // rose-400 — vivid against #0d1117
const HANDOFF_COLOR  = "#fb923c"; // orange-400 — already dark-mode-friendly
const CHEKHOV_COLOR  = "#c084fc"; // violet-400 — replaces the dim #A828B8 IOS purple

/** Quiet inline ruling — the widget's own chip geometry, in the neutral
 *  values the hand-off cards already use, so it reads as an action rather
 *  than another finding. Colours are inline because the card is a fixed dark
 *  surface and inherits nothing from the theme. */
const RULING_STYLE = {
  color: "rgba(255, 255, 255, 0.78)",
  borderColor: "rgba(255, 255, 255, 0.07)",
  background: "rgba(255, 255, 255, 0.025)",
  fontFamily: "inherit",
  cursor: "pointer",
} as const;

function ContinuityWidgetImpl({
  chapters, worldData, chapterIndex, knowledgeStore, confirmedChekhov, onKnewAlready, onGoodCatch,
}: Props) {
  const summary = useMemo(
    () => summarizeContinuity(chapters, worldData, chapterIndex),
    [chapters, worldData, chapterIndex],
  );

  // ★ ONE SELECTOR. Never re-implement the surfacing conditions here — the
  //   widget must show exactly what the harness measures.
  const knowledge = useMemo(
    () => (knowledgeStore ? surfacedKnowledgeFindings(knowledgeStore) : []),
    [knowledgeStore],
  );

  // Confirmed promises sort to the front of the visible six. The list is
  // capped at six for space, and a phrase the model called a real promise
  // losing its place to a curtain is the one ordering that would matter.
  const chekhovShown = useMemo(() => {
    if (!confirmedChekhov || confirmedChekhov.size === 0) return summary.chekhov.slice(0, 6);
    const rank = (phrase: string) => (confirmedChekhov.has(phrase.trim().toLowerCase()) ? 0 : 1);
    return [...summary.chekhov].sort((a, b) => rank(a.phrase) - rank(b.phrase)).slice(0, 6);
  }, [summary.chekhov, confirmedChekhov]);
  const promisedCount = chekhovShown.filter(
    (c) => confirmedChekhov?.has(c.phrase.trim().toLowerCase()),
  ).length;

  if (!summary.hasAnything && knowledge.length === 0) return null;

  // Most-actionable signal becomes the headline & accent.
  const accent =
    summary.outOfOrder.length > 0 ? TIMELINE_COLOR :
    summary.handoff             ? HANDOFF_COLOR :
    summary.chekhov.length > 0  ? CHEKHOV_COLOR :
                                  TIMELINE_COLOR;

  const headline =
    summary.outOfOrder.length > 0 ? "TIMELINE SLIP" :
    summary.handoff             ? "HAND-OFF" :
    summary.chekhov.length > 0  ? "CHEKHOV" :
                                  "KNOWLEDGE";

  // Severity strip — only show counts that are non-zero.
  const strip: Array<{ key: string; count: number; color: string; label: string; icon: typeof AlertTriangle }> = [];
  if (summary.outOfOrder.length > 0) {
    strip.push({
      key: "timeline", count: summary.outOfOrder.length,
      color: TIMELINE_COLOR, label: "timeline",
      icon: AlertTriangle,
    });
  }
  if (summary.handoff) {
    strip.push({
      key: "handoff", count: 1,
      color: HANDOFF_COLOR, label: "hand-off",
      icon: ArrowRight,
    });
  }
  if (summary.chekhov.length > 0) {
    strip.push({
      key: "chekhov", count: summary.chekhov.length,
      color: CHEKHOV_COLOR, label: "chekhov",
      icon: Anchor,
    });
  }

  return (
    <WidgetCard
      bg="#0d1117"
      accent={accent}
      heroAlign="start"
      topLeft="CONTINUITY"
      topRight={headline}
    >
      <div className="wg-content">
        {/* Severity strip */}
        {strip.length > 0 && (
          <div className="wg-cont-strip">
            {strip.map(({ key, count, color, label, icon: Icon }) => (
              <span
                key={key}
                className="wg-cont-strip-chip"
                style={{
                  color,
                  borderColor: `${color}55`,
                  background: `${color}10`,
                }}
              >
                <Icon size={11} strokeWidth={2.4} />
                <span className="wg-cont-strip-count">{count}</span>
                <span className="wg-cont-strip-label">{label}</span>
              </span>
            ))}
          </div>
        )}

        {/* Timeline slips */}
        {summary.outOfOrder.length > 0 && (
          <div className="wg-cont-block">
            <div className="wg-cont-block-head">
              <AlertTriangle size={10} strokeWidth={2.4} style={{ color: TIMELINE_COLOR }} />
              <span style={{ color: TIMELINE_COLOR }}>Introduced later in the book</span>
            </div>
            <div className="wg-cont-slips">
              {summary.outOfOrder.slice(0, 5).map((h) => (
                <span key={h.character} className="wg-cont-slip">
                  <span
                    className="wg-cont-slip-name"
                    style={{ color: TIMELINE_COLOR }}
                  >
                    {h.character}
                  </span>
                  <span className="wg-cont-slip-pin">ch {h.firstChapter}</span>
                </span>
              ))}
            </div>
            <div className="wg-action-line">
              {summary.outOfOrder.length === 1
                ? `First "official" appearance is in chapter ${summary.outOfOrder[0].firstChapter}. Verify this isn't a flashback that needs marking.`
                : `${summary.outOfOrder.length} characters here are introduced later in the book — confirm intentional.`}
            </div>
          </div>
        )}

        {/* Hand-off — prev → curr visual flow */}
        {summary.handoff && (
          <div className="wg-cont-block">
            <div className="wg-cont-block-head">
              <ArrowRight size={10} strokeWidth={2.4} style={{ color: HANDOFF_COLOR }} />
              <span style={{ color: HANDOFF_COLOR }}>Chapter hand-off</span>
            </div>
            <div className="wg-cont-handoff">
              <div className="wg-cont-handoff-card">
                <div className="wg-cont-handoff-card-key">Prev ends</div>
                <div className="wg-cont-handoff-card-row">
                  <MapPin size={11} strokeWidth={2.4} style={{ opacity: 0.62 }} />
                  <span className="wg-cont-handoff-card-val">
                    {summary.handoff.prevPlace || "—"}
                  </span>
                </div>
                <div className="wg-cont-handoff-card-row">
                  <Clock4 size={11} strokeWidth={2.4} style={{ opacity: 0.62 }} />
                  <span className="wg-cont-handoff-card-val">
                    {summary.handoff.prevTime || "—"}
                  </span>
                </div>
              </div>
              <span className="wg-cont-handoff-arrow" style={{ color: HANDOFF_COLOR }}>
                <ArrowRight size={18} strokeWidth={2.4} />
              </span>
              <div
                className="wg-cont-handoff-card wg-cont-handoff-card--this"
                style={{ borderColor: `${HANDOFF_COLOR}55` }}
              >
                <div className="wg-cont-handoff-card-key" style={{ color: HANDOFF_COLOR }}>
                  Opens
                </div>
                <div className="wg-cont-handoff-card-row">
                  <MapPin
                    size={11}
                    strokeWidth={2.4}
                    style={{
                      color:
                        summary.handoff.drift === "place" ||
                        summary.handoff.drift === "both"
                          ? HANDOFF_COLOR
                          : "rgba(255,255,255,0.62)",
                    }}
                  />
                  <span
                    className="wg-cont-handoff-card-val"
                    style={{
                      color:
                        summary.handoff.drift === "place" ||
                        summary.handoff.drift === "both"
                          ? HANDOFF_COLOR
                          : undefined,
                    }}
                  >
                    {summary.handoff.thisPlace || "—"}
                  </span>
                </div>
                <div className="wg-cont-handoff-card-row">
                  <Clock4
                    size={11}
                    strokeWidth={2.4}
                    style={{
                      color:
                        summary.handoff.drift === "time" ||
                        summary.handoff.drift === "both"
                          ? HANDOFF_COLOR
                          : "rgba(255,255,255,0.62)",
                    }}
                  />
                  <span
                    className="wg-cont-handoff-card-val"
                    style={{
                      color:
                        summary.handoff.drift === "time" ||
                        summary.handoff.drift === "both"
                          ? HANDOFF_COLOR
                          : undefined,
                    }}
                  >
                    {summary.handoff.thisTime || "—"}
                  </span>
                </div>
              </div>
            </div>
            <div className="wg-action-line">
              {summary.handoff.drift === "both"
                ? "Place and time both shift — make the transition explicit on the page."
                : summary.handoff.drift === "place"
                ? "Place changes from the previous chapter — does the opening orient the reader?"
                : "Time of day changes from the previous chapter — anchor the reader."}
            </div>
          </div>
        )}

        {/* Chekhov candidates */}
        {summary.chekhov.length > 0 && (
          <div className="wg-cont-block">
            <div className="wg-cont-block-head">
              <Sparkles size={10} strokeWidth={2.4} style={{ color: CHEKHOV_COLOR }} />
              <span style={{ color: CHEKHOV_COLOR }}>
                Introduced — never recurs
              </span>
            </div>
            <div className="wg-cont-chekhov">
              {chekhovShown.map((c) => {
                const promised = confirmedChekhov?.has(c.phrase.trim().toLowerCase()) ?? false;
                return (
                  <span
                    key={c.phrase}
                    className="wg-cont-chekhov-chip"
                    style={{
                      borderColor: promised ? `${CHEKHOV_COLOR}7a` : `${CHEKHOV_COLOR}38`,
                      background: promised ? `${CHEKHOV_COLOR}1f` : `${CHEKHOV_COLOR}10`,
                    }}
                  >
                    <Anchor
                      size={9}
                      strokeWidth={2.4}
                      style={{ color: CHEKHOV_COLOR, opacity: promised ? 1 : 0.78 }}
                    />
                    <span
                      className="wg-cont-chekhov-name"
                      style={{ color: CHEKHOV_COLOR, fontWeight: promised ? 600 : undefined }}
                    >
                      {c.phrase}
                    </span>
                    <span className="wg-cont-chekhov-num">{c.mentions}×</span>
                  </span>
                );
              })}
            </div>
            <div className="wg-action-line">
              {promisedCount > 0
                ? `Concrete things mentioned here that don't return. ${promisedCount === 1 ? "One reads" : `${promisedCount} read`} as a real promise — pay ${promisedCount === 1 ? "it" : "them"} off, fade ${promisedCount === 1 ? "it" : "them"}, or cut ${promisedCount === 1 ? "it" : "them"}.`
                : "Concrete things mentioned here that don't return. Pay them off, fade them, or cut them."}
            </div>
          </div>
        )}

        {/* Knowledge — one plain sentence per confirmed finding, the model's
            reason underneath, and the writer's two rulings. */}
        {knowledge.length > 0 && (
          <div className="wg-cont-block">
            <div className="wg-cont-block-head">
              <AlertTriangle size={10} strokeWidth={2.4} style={{ color: TIMELINE_COLOR }} />
              <span style={{ color: TIMELINE_COLOR }}>Knowledge</span>
            </div>
            {knowledge.map((c) => {
              // "Good catch" PINS: the writer acknowledged a real break, so it
              // stays visible without buttons until the prose changes and the
              // anchor retires it (plan §2). "Knew already" never reaches here.
              const pinned = knowledgeStore ? isPinnedFinding(knowledgeStore, c.key) : false;
              return (
                <div key={c.key} className="wg-section">
                  <span className="wg-diag-msg">
                    {c.speaker} names {c.entity} in chapter {c.chapterNumber}, but has never met them or heard of them.
                  </span>
                  {c.verdict?.reason && (
                    <span className="wg-action-line">{c.verdict.reason}</span>
                  )}
                  {pinned ? (
                    <span className="wg-action-line">marked to fix — clears when the line changes</span>
                  ) : (onKnewAlready || onGoodCatch) && (
                    <div className="wg-cont-chekhov">
                      {onKnewAlready && (
                        <button
                          type="button"
                          className="wg-cont-chekhov-chip"
                          style={RULING_STYLE}
                          onClick={() => onKnewAlready(c)}
                        >
                          They knew already
                        </button>
                      )}
                      {onGoodCatch && (
                        <button
                          type="button"
                          className="wg-cont-chekhov-chip"
                          style={RULING_STYLE}
                          onClick={() => onGoodCatch(c)}
                        >
                          Good catch
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </WidgetCard>
  );
}

export const ContinuityWidget = memo(ContinuityWidgetImpl);
