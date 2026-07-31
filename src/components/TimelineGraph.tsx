/**
 * Compact vertical panel timeline — git-commit style.
 *
 * Information hierarchy per row:
 *  1. Chapter number     — left gutter, muted
 *  2. Role node          — spine, color encodes narrative role
 *  3. Chapter title      — primary label, bold when active
 *  4. Word count         — top-right, tabular
 *  5. Tension bar        — mini fill bar below title, shows tensionPeak
 *  6. Character dots     — up to 3 colored presence indicators, right edge
 *  7. Event sub-rows     — branching bezier below, italic label
 */

import { memo } from "react";
import type { Novel, StoryGraph, MajorEvent } from "../types";
import type { TimelineCharacterTrack } from "../lib/story-graph-display";
import { measureTextWidth } from "../lib/measure-text";
import { selectTimelineChips } from "../lib/narrative-events";

type TimelineChapterDisplay = Pick<Novel["chapters"][number], "id" | "number" | "title">;

export interface TimelineGraphProps {
  storyGraph: StoryGraph;
  chapters: TimelineChapterDisplay[];
  characterTracks: TimelineCharacterTrack[];
  currentChapterId: string | null;
  onSelectChapter: (id: string) => void;
  /** Opens the chapter with the event's source clause selected. When set, an
   *  event chip stops being decoration: clicking it goes to the scene. */
  onJumpToEvent?: (chapterId: string, event: { sentence?: string; paragraphIndex?: number }) => void;
}

// ─── Design tokens ────────────────────────────────────────────────────────────

const ROLE_COLOR: Record<string, string> = {
  climax:     "#f43f5e",
  resolution: "#10b981",
  buildup:    "#f59e0b",
  breather:   "#22c55e",
  pivot:      "#a855f7",
  expository: "#60a5fa",
  standard:   "#64748b",
};

const EVENT_COLOR: Record<MajorEvent["type"], string> = {
  climax:        "#f43f5e",
  confrontation: "#fb923c",
  revelation:    "#a855f7",
  introduction:  "#10b981",
  transition:    "#64748b",
  "scene-break": "#64748b",
};

function roleColor(role: string) { return ROLE_COLOR[role] ?? ROLE_COLOR.standard; }
function detailTag(event: MajorEvent): string | null {
  return event.detailLabel ? event.detailLabel.toUpperCase() : null;
}

// ─── Layout constants ─────────────────────────────────────────────────────────

const SPINE_X    = 40;   // x of the vertical spine line
const NUM_X      = 30;   // right edge of chapter number column
const INFO_X     = 54;   // left edge of chapter info
const SVG_W      = 330;  // total SVG width (fits 370px panel with padding)
const WC_X       = SVG_W - 4; // right edge for word-count label

const ROW_H_BASE = 52;   // base row height — slightly taller to fit tension bar
const EVENT_H    = 18;   // height per event sub-row
const PAD_TOP    = 8;    // extra top padding

// Tension bar geometry
const BAR_Y_OFF  = 10;   // offset below chapterCenterY
const BAR_H      = 3;
const BAR_MAX_W  = 150;  // max bar width
const BAR_X      = INFO_X;

// Char dot geometry
const DOT_R      = 2.8;
const DOT_GAP    = 7;
const DOT_X_END  = WC_X;  // right-align dots

// Node sizes
const NODE_R_SM   = 4.5;
const NODE_R_LG   = 7;

// ─── Row geometry ─────────────────────────────────────────────────────────────

interface RowGeom {
  chapterCenterY: number;
  eventStartY: number;
  totalH: number;
}

function computeRows(chapters: TimelineChapterDisplay[], storyGraph: StoryGraph): RowGeom[] {
  const geoms: RowGeom[] = [];
  let cursor = PAD_TOP;
  for (const ch of chapters) {
    const entry    = storyGraph.entries[ch.id];
    const evCount  = (entry?.majorEvents ?? []).length;
    const chY      = cursor + ROW_H_BASE / 2;
    const evStartY = cursor + ROW_H_BASE + EVENT_H / 2;
    const totalH   = ROW_H_BASE + evCount * EVENT_H;
    geoms.push({ chapterCenterY: chY, eventStartY: evStartY, totalH });
    cursor += totalH;
  }
  return geoms;
}

// ─── Component ────────────────────────────────────────────────────────────────

function TimelineGraphImpl({
  storyGraph, chapters, characterTracks, currentChapterId, onSelectChapter, onJumpToEvent,
}: TimelineGraphProps) {
  if (chapters.length === 0) {
    return (
      <div style={{ padding: "20px 8px", textAlign: "center", fontFamily: "var(--font-ui)", fontSize: 11, color: "var(--panel-text-4)" }}>
        No chapters yet.
      </div>
    );
  }

  const geoms    = computeRows(chapters, storyGraph);
  const svgH     = geoms.reduce((s, g) => s + g.totalH, PAD_TOP * 2);
  const spineTop = geoms[0].chapterCenterY;
  const spineBtm = geoms[geoms.length - 1].chapterCenterY;

  return (
    <svg
      width={SVG_W}
      height={svgH}
      viewBox={`0 0 ${SVG_W} ${svgH}`}
      style={{ display: "block", overflow: "visible" }}
      aria-label="Narrative timeline"
    >
      {/* ── Spine line ── */}
      <line
        x1={SPINE_X} y1={spineTop}
        x2={SPINE_X} y2={spineBtm}
        stroke="var(--divider-line)"
        strokeWidth={2.5}
      />

      {/* ── Rows ── */}
      {chapters.map((ch, i) => {
        const entry    = storyGraph.entries[ch.id];
        // ★ This had NO cap and drew every event the engine emitted — up to 40
        // on a long chapter, against the full timeline's 3. Same budget, one
        // source, so the accuracy gate describes both views.
        // ★★ And it must SELECT BY RANK, not by slicing: the stored array is in
        // reading order, so a slice shows the chapter's opening rather than its
        // strongest beats (36.1% vs 47.0% on the gold set).
        const events   = selectTimelineChips(entry?.majorEvents ?? []);
        const { chapterCenterY: cy, eventStartY: evY } = geoms[i];
        const isActive = ch.id === currentChapterId;
        const analyzed = !!entry;
        const color    = analyzed ? roleColor(entry!.role) : "var(--divider-line)";
        const isLg     = analyzed && (entry!.role === "climax" || entry!.role === "pivot");
        const nr       = isLg ? NODE_R_LG : NODE_R_SM;
        // word count omitted — already shown in the stats header, not adding value per-row
        const peak      = analyzed ? Math.min(1, entry!.tensionPeak) : 0;
        const barW      = peak * BAR_MAX_W;
        const chars = characterTracks.filter((track) => track.chapterIds.has(ch.id)).slice(0, 3);

        return (
          <g
            key={ch.id}
            style={{ cursor: "pointer" }}
            onClick={() => onSelectChapter(ch.id)}
          >
            {/* Active indicator: left accent bar */}
            {isActive && (
              <rect
                x={0} y={cy - ROW_H_BASE / 2 + 6}
                width={2} height={ROW_H_BASE - 12}
                rx={1}
                fill={color}
                opacity={0.9}
              />
            )}

            {/* Chapter number */}
            <text
              x={NUM_X} y={cy - 4}
              textAnchor="end"
              dominantBaseline="central"
              fill="var(--panel-text-4)"
              fontSize={9}
              fontFamily="var(--font-ui)"
              style={{ fontVariantNumeric: "tabular-nums" }}
              letterSpacing="0.04em"
              opacity={analyzed ? 0.85 : 0.35}
            >
              {ch.number}
            </text>

            {/* Halo for climax / pivot — filled, low opacity */}
            {isLg && (
              <circle cx={SPINE_X} cy={cy - 4} r={nr + 6} fill={color} opacity={0.15} />
            )}

            {/* Spine node */}
            <circle
              cx={SPINE_X} cy={cy - 4}
              r={nr}
              fill={analyzed ? color : "var(--panel-btn-bg)"}
              stroke={analyzed ? "none" : "var(--divider-line)"}
              strokeWidth={analyzed ? 0 : 1}
            />

            {/* Active glow ring */}
            {isActive && (
              <circle
                cx={SPINE_X} cy={cy - 4}
                r={nr + 3}
                fill="none"
                stroke={color}
                strokeWidth={1}
                opacity={0.4}
              />
            )}

            {/* Chapter title */}
            <text
              x={INFO_X} y={cy - 4}
              dominantBaseline="central"
              fill={isActive ? "var(--panel-text)" : analyzed ? "var(--panel-text-2)" : "var(--panel-text-4)"}
              fontSize={12}
              fontFamily="var(--font-ui)"
              fontWeight={isActive ? "600" : "400"}
              letterSpacing="0.005em"
            >
              {(ch.title || `Chapter ${ch.number}`).slice(0, 18)}
            </text>


            {/* Tension bar — below title */}
            {analyzed && (
              <g>
                {/* Track */}
                <rect
                  x={BAR_X} y={cy + BAR_Y_OFF}
                  width={BAR_MAX_W} height={BAR_H}
                  rx={BAR_H / 2}
                  fill="var(--divider-line)"
                  opacity={0.25}
                />
                {/* Fill */}
                {barW > 0 && (
                  <rect
                    x={BAR_X} y={cy + BAR_Y_OFF}
                    width={barW} height={BAR_H}
                    rx={BAR_H / 2}
                    fill={color}
                    opacity={isActive ? 0.8 : 0.5}
                  />
                )}
                {/* ★ Event position ticks.
                    `tensionPosition` was computed for every event and then never
                    read by this component — chips stack by ARRAY INDEX, so two
                    events at 10% and 90% of a chapter rendered with identical
                    spacing and the timeline could not show where anything
                    happened. The chips still stack, because they need the
                    vertical room to stay legible, but the bar now carries the
                    real positions so the row shows the chapter's shape at a
                    glance. */}
                {events.map((evt, ei) => (
                  <rect
                    key={`tick-${ch.id}-${ei}`}
                    x={BAR_X + Math.min(BAR_MAX_W - 1.2, Math.max(0, evt.tensionPosition * BAR_MAX_W))}
                    y={cy + BAR_Y_OFF - 2.5}
                    width={1.2}
                    height={BAR_H + 5}
                    rx={0.6}
                    fill={EVENT_COLOR[evt.type] ?? "#64748b"}
                    opacity={evt.salience === "minor" ? 0.45 : 0.85}
                  />
                ))}
              </g>
            )}

            {/* Character presence dots — right of tension bar */}
            {chars.map((track, ci) => (
              <circle
                key={`char-${ch.id}-${track.name}`}
                cx={DOT_X_END - ci * DOT_GAP}
                cy={cy + BAR_Y_OFF + BAR_H / 2}
                r={DOT_R}
                fill={track.color}
                opacity={0.72}
              />
            ))}

            {/* Event chips — badge-style rounded rects, no bezier curves */}
            {events.map((evt, ei) => {
              const chipY  = evY + ei * EVENT_H;
              const ec     = EVENT_COLOR[evt.type] ?? "#64748b";
              const detail = detailTag(evt);
              // Truncate with an ellipsis (and drop trailing whitespace) so the
              // label never gets silently cut, then size the pill to the actual
              // rendered text width — not a per-char estimate, which left a gap.
              const rawLabel = evt.label.trim();
              const maxLen   = detail ? 28 : 36;
              const label    = rawLabel.length > maxLen
                ? rawLabel.slice(0, maxLen - 1).trimEnd() + "…"
                : rawLabel;
              const SIDE_PAD = 8, DETAIL_GAP = 6, DOT_ALLOW = 6;
              const detailTextW = detail ? measureTextWidth(detail, 6.2, { weight: 700, letterSpacingEm: 0.08 }) : 0;
              const detailW = detail ? detailTextW + DOT_ALLOW : 0;
              const labelW  = measureTextWidth(label, 8.5, { italic: true, letterSpacingEm: 0.01 });
              const chipW  = Math.min(
                SIDE_PAD * 2 + detailW + (detail ? DETAIL_GAP : 0) + labelW,
                SVG_W - INFO_X - 6,
              );
              const chipH  = 14;
              const chipX  = INFO_X;
              const detailX = chipX + SIDE_PAD;
              const dotX = detailX + detailTextW + 3;
              const labelX = chipX + SIDE_PAD + detailW + (detail ? DETAIL_GAP : 0);
              return (
                <g
                  key={`evt-${ch.id}-${ei}`}
                  opacity={0.9}
                  // A chip click goes to the SCENE, not just the chapter — the
                  // row click above still selects the chapter as before.
                  onClick={onJumpToEvent
                    ? (e) => { e.stopPropagation(); onJumpToEvent(ch.id, evt); }
                    : undefined}
                >
                  {/* ★ The first hover surface this timeline has ever had.
                      An event label is capped at 28–36 characters, so the chip
                      alone can never justify itself; the writer had no way to see
                      what "Helia authorizes firing" referred to, or to check
                      whether it was right. `sentence` used to be computed in
                      story-graph.ts to derive the label and then discarded — it is
                      persisted now, so the source clause can be shown.
                      A <title> is deliberate rather than a custom popover: it
                      works inside SVG, needs no portal, and survives the
                      full-screen view's own stacking. */}
                  <title>
                    {[
                      `${evt.narrativeType ?? evt.type}${evt.salience ? ` · ${evt.salience}` : ""}`,
                      evt.paragraphIndex !== undefined
                        ? `¶${evt.paragraphIndex + 1} · ${Math.round(evt.confidence * 100)}% confidence`
                        : `${Math.round(evt.tensionPosition * 100)}% through the chapter · ${Math.round(evt.confidence * 100)}% confidence`,
                      evt.sentence ? `\n${evt.sentence}` : "",
                    ]
                      .filter(Boolean)
                      .join("\n")}
                  </title>
                  {/* Thin vertical tick from spine to first chip only */}
                  {ei === 0 && (
                    <line
                      x1={SPINE_X} y1={cy - 4 + nr}
                      x2={SPINE_X} y2={chipY - chipH / 2}
                      stroke={ec}
                      strokeWidth={1}
                      strokeOpacity={0.28}
                      strokeDasharray="2,3"
                    />
                  )}
                  {/* Badge fill */}
                  <rect
                    x={chipX} y={chipY - chipH / 2}
                    width={chipW} height={chipH}
                    rx={chipH / 2}
                    fill={ec}
                    fillOpacity={0.1}
                    stroke={ec}
                    strokeWidth={0.75}
                    strokeOpacity={0.45}
                  />
                  {detail && (
                    <>
                      <text
                        x={detailX} y={chipY}
                        textAnchor="start"
                        dominantBaseline="central"
                        fill={ec}
                        fontSize={6.2}
                        fontFamily="var(--font-ui)"
                        fontWeight="700"
                        letterSpacing="0.08em"
                        opacity={0.72}
                      >
                        {detail}
                      </text>
                      <circle cx={dotX} cy={chipY} r={1.1} fill={ec} opacity={0.5} />
                    </>
                  )}
                  <text
                    x={labelX} y={chipY}
                    textAnchor="start"
                    dominantBaseline="central"
                    fill={ec}
                    fontSize={8.5}
                    fontFamily="var(--font-ui)"
                    fontStyle="italic"
                    letterSpacing="0.01em"
                    opacity={0.88}
                  >
                    {label}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

export const TimelineGraph = memo(TimelineGraphImpl);
