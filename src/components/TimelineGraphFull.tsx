/**
 * Full-screen narrative timeline — "Narrative Terrain" design.
 *
 * Design system:
 *  - Spine undulates with tension: high-tension chapters rise, low-tension fall
 *  - Node radius encodes narrative weight (role + tensionPeak)
 *  - Event chips use a relaxed collision layout and stay clear of chapter nodes
 *  - Cast ledger: per-character presence bars (height = share of the chapter),
 *    ◆ where a stored event names them as agent, dashed bridges across absences
 *  - Active chapter: glowing vertical beam through full SVG height
 *  - Atmosphere: dot-grid, subtle gradient fills, cinematic not diagrammatic
 */

import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Activity } from "lucide-react";
import type { Novel, StoryGraph, MajorEvent } from "../types";
import type { TimelineCharacterTrack } from "../lib/story-graph-display";
import type { ArcInsight } from "../lib/story-arc-insights";
import { measureTextWidth } from "../lib/measure-text";
import { selectDisplayChips } from "../lib/narrative-events";
import { CloseIcon } from "./Icon";

type TimelineChapterDisplay = Pick<Novel["chapters"][number], "id" | "number" | "title">;

interface Props {
  storyGraph: StoryGraph;
  chapters: TimelineChapterDisplay[];
  characterTracks: TimelineCharacterTrack[];
  /** Cross-chapter insights from story-arc-insights, already ranked. */
  insights: ArcInsight[];
  /** Chapter whose inspector should open when the overlay mounts. */
  focusChapterId?: string | null;
  currentChapterId: string | null;
  onSelectChapter: (id: string) => void;
  /** Opens a chapter in the editor with the event's clause selected. */
  onJumpToEvent?: (chapterId: string, event: { sentence?: string; paragraphIndex?: number }) => void;
  onClose: () => void;
}

// ─── Tokens ───────────────────────────────────────────────────────────────────

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
  introduction:  "#34d399",
  transition:    "#64748b",
  "scene-break": "#475569",
};

function roleColor(r: string) { return ROLE_COLOR[r] ?? ROLE_COLOR.standard; }

// ─── Layout ───────────────────────────────────────────────────────────────────

const CHAPTER_W   = 110;   // px between chapters (wider — more room for labels)
const PAD_X       = 120;   // horizontal padding
// Spine terrain — baseline pushed to ~55% of SVG height for visual weight
const SPINE_BASE  = 280;   // baseline Y (no tension) — was 230
const TERRAIN_AMP = 60;    // max upward displacement (full tension = y=220)
// Event box collision layout constants
const EVENT_LAYOUT_OVERSCAN = 3;
const BOX_H       = 22;    // fixed box height
const BOX_GAP     = 8;     // minimum gap between boxes
const LAYOUT_ITER = 30;    // relaxation iterations — wider detail chips need more settling time
const SPRING_K    = 0.11;  // slightly looser spring so wider chips can separate before snapping back
const MIN_BOX_Y   = 24;    // boxes may not go above this Y
const NODE_BOX_GAP = 10;   // min clearance between event boxes and chapter nodes
const VIEW_OVERSCAN = 6;   // chapters rendered outside the current viewport
const BOX_VIS_PAD   = 220; // px overscan for off-column event boxes
const BOX_SIDE_PAD = 10;
const BOX_DETAIL_GAP = 6;
const BOX_DETAIL_TRACK_W = 12;
const BOX_LABEL_MAX = 38;
const BOX_LABEL_MAX_WITH_DETAIL = 28;
const BOX_MAX_W = 186;
// Chapter labels — at fixed Y just below terrain zone
const LABEL_Y_NUM   = SPINE_BASE + TERRAIN_AMP + 18;  // = 358
const LABEL_Y_TITLE = SPINE_BASE + TERRAIN_AMP + 30;  // = 370
// ── Cast ledger ──────────────────────────────────────────────────────────────
// One row per character, read against a single baseline that both halves share:
//
//   ABOVE the line  PRESENCE — a bar per chapter, height = that character's
//                   share of it (mention counts once the async track build has
//                   run; uniform otherwise). The tallest bar is ringed: that is
//                   the chapter they matter most in.
//   ON the line     CONTINUITY — soft links through consecutive chapters,
//                   dashed bridges across absences of three or more.
//   BELOW the line  AGENCY — one square per event this character DRIVES,
//                   coloured by the event's type.
//
// ★★ THE AGENCY MARK USED TO BE A DIAMOND FLOATING ABOVE THE BAR, and it was
//    the weakest thing in the ledger. It sat at `ty - h - 11`, so its height
//    changed with the bar under it and the row read as scattered rather than
//    aligned. It also encoded a single BIT — drives, or does not — while the
//    data underneath had both the COUNT and the TYPE of every driven event.
//    Below the baseline the marks share one Y, so a glance down the row reads
//    as a rhythm; one square per event makes the count countable; and colouring
//    by type says WHICH beats are theirs. "She drives three things here" and
//    "she makes the revelations" are different sentences, and only the second
//    is worth a writer's attention.
const MAX_TRACKS    = 8;
const CHAR_ZONE_TOP = SPINE_BASE + TERRAIN_AMP + 52;   // = 392
const CAST_HEADER_H = 34;   // section title, legend line, and the type key
const CHAR_TRACK_H  = 56;   // row: bars over a baseline, agency squares under it
// ★ RANGE IS WHAT MAKES A BAR READ. At 5-16px the heights were technically
//   varying and visually identical — every chapter looked like the same pill.
//   Widening the range and dropping the floor is what turns "presence" from a
//   decoration back into a quantity.
const CAST_BAR_MAX  = 24;
const CAST_BAR_MIN  = 4;
const CAST_BAR_W    = 9;
/** Agency squares below the baseline: size, gap, and how many fit before the
 *  row starts lying about the count. */
const DRIVE_TICK    = 5.4;
const DRIVE_GAP     = 2.4;
const DRIVE_MAX     = 4;
/** The event types worth naming in the cast legend. "transition" and
 *  "scene-break" are structural rather than dramatic and almost never carry an
 *  agent, so listing them would spend the legend's width on nothing. */
const CAST_LEGEND_TYPES: Array<MajorEvent["type"]> =
  ["climax", "confrontation", "revelation", "introduction"];
/**
 * Height of an EVOKED chapter's mark — a character named but not on the page.
 *
 * ★ FIXED, AND HOLLOW, ON PURPOSE. A solid bar scaled by mention count would
 *   say "she is very present here" about a chapter she spends somewhere else,
 *   which is exactly the lie the old ledger told. Talking about someone a lot
 *   is not a quantity of presence, so the mark carries no quantity: it is one
 *   outline, always the same size, categorically unlike a filled bar.
 */
const CAST_GHOST_H = 9;
/**
 * The cap that marks a chapter where they actually SPEAK.
 *
 * ★ IT HAS TO BE WIDER THAN THE BAR, and the first version was not. A 2.6px
 *   cap in the SAME COLOUR at slightly higher opacity, sitting on top of a bar
 *   of that colour, is invisible — 26 gates passed and the speaking chapters
 *   were indistinguishable from the silent ones when I looked at the render.
 *   Overhanging the bar makes the mark read as a shape rather than as a shade,
 *   which is the same reason evocation is hollow instead of faint.
 */
const CAST_VOICE_CAP  = 2.8;
const CAST_VOICE_OVER = 3.2;   // overhang per side
/** Average advance width of the 8px UI font, for fitting the stat line to the
 *  room its character's entry chapter leaves. Measured against the rendered
 *  text by verify-timeline-cast.cjs, so a wrong value fails a gate rather than
 *  silently clipping. */
const STAT_CHAR_W      = 4.5;
const STAT_LEFT_MARGIN = 6;
// SVG_H is computed per-render

// ─── Leaf-bubbling collision layout ──────────────────────────────────────────

interface BoxState {
  key: string;
  chX: number;     // source chapter X (spring anchor)
  nodeY: number;   // source chapter node center Y
  nodeR: number;   // source node radius
  color: string;
  detail: string | null;
  detailW: number;
  label: string;
  /** The chapter the event belongs to — a chip click jumps INTO that chapter. */
  chapterId: string;
  /** The stored event, whole. The label is capped at 20-30 characters and
   *  cannot justify itself; the hover card shows the event's type, agent,
   *  location, confidence and its verbatim SOURCE CLAUSE from here. */
  evt: MajorEvent;
  w: number;       // dynamic box width
  cx: number;      // center X (mutable during layout)
  cy: number;      // center Y (mutable during layout)
  sameChAs?: number; // index of "sibling" box from same chapter, for vertical bias
}

interface PlacedBox extends BoxState {
  x: number;       // left edge
  y: number;       // top edge
  branchPath: string;
}

interface VisibleRange {
  start: number;
  end: number;
}

interface ChapterRenderData {
  ch: TimelineChapterDisplay;
  entry: StoryGraph["entries"][string] | undefined;
  x: number;
  y: number;
  color: string;
  nr: number;
  isAct: boolean;
  /** Inspector rail open on this chapter. */
  isInspect: boolean;
  events: MajorEvent[];
}

interface TrackRenderData {
  name: string;
  color: string;
  /** Row BASELINE — bars grow upward from here. */
  ty: number;
  firstX: number;
  lastX: number;
  /** The one-line story of this character's presence: "9 ch · drives 3 · away 5".
   *  Capped at four items — the line is right-aligned at the character's entry
   *  chapter and has only that much room. */
  stats: string;
  /** Every stat, for the tooltip, where width costs nothing. */
  statsFull: string;
  bars: Array<{
    key: string; x: number; h: number; tip: string;
    /** On the page and talking / on the page / named but elsewhere. Drives the
     *  KIND of mark, not its shade — see CAST_GHOST_H. */
    klass: "speaking" | "present" | "mentioned";
    /** The deterministic signals could not call this chapter either way. */
    uncertain: boolean;
    /** The type of each event this character drives here, in story order.
     *  Empty when they are merely present. */
    driveTypes: string[];
    /** Events beyond DRIVE_MAX, so the row can say so instead of silently
     *  drawing fewer squares than it counted. */
    driveOverflow: number;
    /** Their biggest chapter. Ringed, so the peak is findable without reading
     *  every bar height against its neighbours. */
    peak: boolean;
  }>;
  /** Continuous runs (adjacent chapters ≤2 apart). */
  links: Array<{ key: string; x1: number; x2: number }>;
  /** Absences longer than 2 chapters, bridged with a dash. */
  bridges: Array<{ key: string; x1: number; x2: number }>;
}

const TIMELINE_OVERLAY_BODY_CLASS = "timeline-overlay-freeze";

function detailTag(event: Pick<MajorEvent, "detailLabel">): string | null {
  return event.detailLabel ? event.detailLabel.toUpperCase() : null;
}

function layoutBoxes(
  chData: Array<{
    ch: { id: string };
    x: number; y: number; nr: number;
    events: MajorEvent[];
    color: string;
  }>,
): PlacedBox[] {
  const states: BoxState[] = [];
  const nodes = chData.map(({ x, y, nr }) => ({ x, y, nr }));

  for (const { ch, x: chX, y: nodeY, nr, events } of chData) {
    for (let ei = 0; ei < events.length; ei++) {
      const evt   = events[ei];
      const detail = detailTag(evt);
      // Ellipsis-truncate (and trim trailing whitespace) so labels are never
      // silently cut, then size the box from the actual rendered text width so
      // the pill hugs the text instead of leaving a length-dependent gap.
      const rawLabel = evt.label.trim();
      const maxLen   = detail ? BOX_LABEL_MAX_WITH_DETAIL : BOX_LABEL_MAX;
      const label    = rawLabel.length > maxLen
        ? rawLabel.slice(0, maxLen - 1).trimEnd() + "…"
        : rawLabel;
      const detailTextW = detail ? measureTextWidth(detail, 6.4, { weight: 700, letterSpacingEm: 0.08 }) : 0;
      const detailW = detail ? detailTextW + BOX_DETAIL_TRACK_W : 0;
      const labelW  = measureTextWidth(label, 8.5, { italic: true, letterSpacingEm: 0.01 });
      // Collision tuning was calibrated for narrower centered chips. Keep the
      // richer tag treatment, but size from explicit text paddings so the
      // solver sees roughly the same physical box footprint that gets rendered.
      const w = Math.min(
        BOX_SIDE_PAD * 2 + detailW + (detail ? BOX_DETAIL_GAP : 0) + labelW,
        BOX_MAX_W,
      );
      // Initial position: stack above node, closest event nearest node
      const initCY = nodeY - nr - BOX_H / 2 - (ei + 1) * (BOX_H + BOX_GAP);
      states.push({
        key: `${ch.id}-${ei}-${evt.type}`,
        chX, nodeY, nodeR: nr,
        color: (EVENT_COLOR as Record<string, string>)[evt.type] ?? "#64748b",
        detail,
        detailW,
        label, w,
        chapterId: ch.id,
        evt,
        cx: chX,
        cy: Math.max(MIN_BOX_Y + BOX_H / 2, initCY),
      });
    }
  }

  // Iterative force relaxation — "leaf bubbling" dynamics
  for (let iter = 0; iter < LAYOUT_ITER; iter++) {
    // Separation: push overlapping boxes apart
    for (let i = 0; i < states.length; i++) {
      for (let j = i + 1; j < states.length; j++) {
        const a = states[i], b = states[j];
        const dx = a.cx - b.cx;
        const dy = a.cy - b.cy;
        const minX = (a.w + b.w) / 2 + BOX_GAP;
        const minY = BOX_H + BOX_GAP;
        const ox = minX - Math.abs(dx);
        const oy = minY - Math.abs(dy);

        if (ox > 0 && oy > 0) {
          // Overlap detected — separate along the smaller overlap axis
          const sameCol = Math.abs(a.chX - b.chX) < 1; // same chapter column?
          if (sameCol) {
            // Same chapter: push strictly vertical (keep boxes in column)
            const dir = a.cy <= b.cy ? -1 : 1;
            a.cy += dir * oy / 2;
            b.cy -= dir * oy / 2;
          } else if (ox < oy) {
            // Different chapters, more horizontal overlap: push apart sideways
            const dir = dx >= 0 ? 1 : -1;
            a.cx += dir * ox / 2;
            b.cx -= dir * ox / 2;
          } else {
            // Different chapters, more vertical overlap: push up/down
            const dir = a.cy <= b.cy ? -1 : 1;
            a.cy += dir * oy / 2;
            b.cy -= dir * oy / 2;
          }
        }
      }
    }

    // Spring: pull each box back toward its chapter column X
    for (const s of states) {
      s.cx += (s.chX - s.cx) * SPRING_K;
    }

    // Node avoidance: labels can float sideways, but never settle into a node circle.
    for (const s of states) {
      for (const node of nodes) {
        const maxDx = s.w / 2 + node.nr + BOX_GAP;
        if (Math.abs(s.cx - node.x) > maxDx) continue;
        const maxCy = node.y - node.nr - NODE_BOX_GAP - BOX_H / 2;
        if (s.cy > maxCy) s.cy = maxCy;
      }
    }

    // Boundary: don't go above MIN_BOX_Y
    for (const s of states) {
      if (s.cy - BOX_H / 2 < MIN_BOX_Y) s.cy = MIN_BOX_Y + BOX_H / 2;
    }
  }

  // Build final placements with bezier branch paths
  return states.map(s => {
    const x = s.cx - s.w / 2;
    const y = s.cy - BOX_H / 2;
    // Bezier from node top → box bottom-center (S-curve accommodates H offset)
    const srcX = s.chX, srcY = s.nodeY - s.nodeR;
    const dstX = s.cx,  dstY = y + BOX_H;
    const midY  = (srcY + dstY) / 2;
    const branchPath = `M${srcX},${srcY} C${srcX},${midY} ${dstX},${midY} ${dstX},${dstY}`;
    return { ...s, x, y, branchPath };
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function chapterX(i: number) { return PAD_X + i * CHAPTER_W; }

function spineY(tensionPeak: number | undefined): number {
  return SPINE_BASE - (tensionPeak ?? 0) * TERRAIN_AMP;
}

function nodeRadius(role: string, tensionPeak: number): number {
  const base = role === "climax" ? 13 : role === "pivot" ? 11 : role === "buildup" ? 9 : 7;
  return Math.min(base + tensionPeak * 3, 16);
}

function computeVisibleRange(scrollLeft: number, width: number, chapterCount: number): VisibleRange {
  if (chapterCount <= 0 || width <= 0) {
    return { start: 0, end: Math.max(0, chapterCount - 1) };
  }

  const firstVisible = Math.floor(Math.max(0, scrollLeft - PAD_X) / CHAPTER_W);
  const lastVisible  = Math.ceil(Math.max(0, scrollLeft + width - PAD_X) / CHAPTER_W);
  return {
    start: Math.max(0, firstVisible - VIEW_OVERSCAN),
    end: Math.min(chapterCount - 1, lastVisible + VIEW_OVERSCAN),
  };
}

/** Catmull-Rom spline through points (smooth terrain curve) */
function catmullRomPath(pts: Array<{x: number; y: number}>): string {
  if (pts.length < 2) return "";
  if (pts.length === 2) return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`;
  const segs: string[] = [`M${pts[0].x},${pts[0].y}`];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    segs.push(`C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x},${p2.y}`);
  }
  return segs.join(" ");
}

// ─── Component ────────────────────────────────────────────────────────────────

const StaticTimelineLayer = memo(function StaticTimelineLayer({
  svgW,
  svgH,
  areaPath,
  spinePath,
  chapters,
  trackLayouts,
  detailsReady,
  onSelectChapter,
}: {
  svgW: number;
  svgH: number;
  areaPath: string;
  spinePath: string;
  chapters: ChapterRenderData[];
  trackLayouts: TrackRenderData[];
  detailsReady: boolean;
  /** Click = INSPECT (open the rail), not navigate. Leaving the view is the
   *  inspector's "Open chapter" button — one deliberate step further — so the
   *  map can actually be explored without being thrown out of it. */
  onSelectChapter: (id: string) => void;
}) {
  return (
    <>
      {/* Dot-grid background */}
      <rect x={0} y={0} width={svgW} height={svgH} fill="url(#tg-dots)" opacity={0.5} />

      {/* Terrain fill under spine */}
      {areaPath && (
        <path d={areaPath} fill="url(#tg-terrain)" />
      )}

      {/* Active chapter beam — full-height highlight with rounded corners */}
      {chapters.map(({ ch, x, color, isAct }) => isAct ? (
        <rect
          key={`beam-${ch.id}`}
          x={x - 26} y={8}
          width={52} height={svgH - 16}
          fill={color}
          opacity={0.05}
          rx={14}
        />
      ) : null)}

      {/* Narrative spine — tension terrain curve */}
      {spinePath && (
        <path
          d={spinePath}
          fill="none"
          stroke="var(--text-tertiary)"
          strokeWidth={2.5}
          strokeOpacity={0.22}
          strokeLinejoin="round"
        />
      )}

      {/* ── Cast ledger — who is on stage, how much, and who carries it ── */}
      {trackLayouts.length > 0 && (
        <g>
          <text
            x={PAD_X - 60} y={CHAR_ZONE_TOP + 10}
            fill="var(--panel-text-3)"
            fontSize={9} fontFamily="var(--font-ui)"
            fontWeight="700" letterSpacing="0.14em"
          >
            CAST
          </text>
          <text
            x={PAD_X + 40} y={CHAR_ZONE_TOP + 10}
            fill="var(--panel-text-4)"
            fontSize={8.5} fontFamily="var(--font-ui)"
          >
            solid bar = on the page&#160;&#160;·&#160;&#160;cap = speaks here&#160;&#160;·&#160;&#160;hollow = talked about while absent&#160;&#160;·&#160;&#160;ring = their biggest chapter&#160;&#160;·&#160;&#160;below = one square per event they drive
          </text>
          {/* The square colours ARE the legend. A writer should not have to
              learn that violet means revelation from a paragraph elsewhere. */}
          <g>
            {CAST_LEGEND_TYPES.map((type, i) => (
              <g key={`cast-legend-${type}`} transform={`translate(${PAD_X + 40 + i * 92}, ${CHAR_ZONE_TOP + 19})`}>
                <rect
                  x={0} y={-4} width={DRIVE_TICK} height={DRIVE_TICK} rx={1}
                  fill={EVENT_COLOR[type]} opacity={0.95}
                />
                <text
                  x={DRIVE_TICK + 4} y={-0.6}
                  fill="var(--panel-text-4)"
                  fontSize={7.6} fontFamily="var(--font-ui)" letterSpacing="0.03em"
                >
                  {type}
                </text>
              </g>
            ))}
          </g>
        </g>
      )}
      {trackLayouts.map((track) => (
        <g key={`track-${track.name}`}>
          {/* Name + one-line story, right-aligned at the character's entry. */}
          <text
            x={track.firstX - 12} y={track.ty - 8}
            textAnchor="end"
            fill={track.color}
            fontSize={9.5} fontFamily="var(--font-ui)"
            fontWeight="650"
          >
            {track.name.length > 18 ? `${track.name.slice(0, 17)}…` : track.name}
          </text>
          <text
            x={track.firstX - 12} y={track.ty + 3}
            textAnchor="end"
            fill="var(--panel-text-4)"
            fontSize={8} fontFamily="var(--font-ui)"
          >
            {track.stats}
            <title>{`${track.name} — ${track.statsFull}`}</title>
          </text>
          {/* Continuous runs, then dashed bridges across absences. */}
          {detailsReady && track.links.map((run) => (
            <line
              key={run.key}
              x1={run.x1} y1={track.ty + 1.5}
              x2={run.x2} y2={track.ty + 1.5}
              stroke={track.color}
              strokeWidth={1.5}
              strokeOpacity={0.3}
            />
          ))}
          {detailsReady && track.bridges.map((bridge) => (
            <line
              key={bridge.key}
              x1={bridge.x1 + 6} y1={track.ty + 1.5}
              x2={bridge.x2 - 6} y2={track.ty + 1.5}
              stroke={track.color}
              strokeWidth={1}
              strokeOpacity={0.16}
              strokeDasharray="2,5"
            />
          ))}
          {/* PRESENCE above the line, AGENCY below it. One baseline, two
              readings, and every agency mark on the same Y so the row scans as
              a rhythm instead of as scatter. */}
          {detailsReady && track.bars.map((bar) => {
            // Centre the squares under the bar so the two halves share an axis
            // as well as a baseline.
            const rowW = bar.driveTypes.length * DRIVE_TICK
              + Math.max(0, bar.driveTypes.length - 1) * DRIVE_GAP;
            const rowX = bar.x - rowW / 2;
            return (
              <g key={bar.key}>
                {bar.peak && (
                  <rect
                    data-cast-mark="peak"
                    x={bar.x - CAST_BAR_W / 2 - 2.5} y={track.ty - bar.h - 3}
                    width={CAST_BAR_W + 5} height={bar.h + 6}
                    rx={4.5}
                    fill="none"
                    stroke={track.color} strokeWidth={0.9} strokeOpacity={0.42}
                  />
                )}
                {/* ★ ONE MARK, ONE MEANING. Height is how much of the chapter
                    they occupy; the cap says they speak in it; the ring says
                    it is their biggest; the squares below are agency. Nothing
                    encodes two things, and an earlier version that dimmed the
                    bar when nobody drove an event put agency on the bar as
                    well as in the squares — a pale bar reads as "less
                    present", which is the one thing the height already says.

                    EVOCATION IS A DIFFERENT KIND OF MARK, NOT A FAINTER ONE.
                    Hollow, fixed height, no cap and no ring: being talked
                    about carries no quantity of presence to draw. */}
                <rect
                  data-cast-mark="presence"
                  data-presence={bar.klass}
                  x={bar.x - CAST_BAR_W / 2} y={track.ty - bar.h}
                  width={CAST_BAR_W} height={bar.h}
                  rx={2.5}
                  fill={bar.klass === "mentioned" ? "none" : track.color}
                  opacity={bar.klass === "mentioned" ? 1 : 0.82}
                  stroke={bar.klass === "mentioned" ? track.color : "none"}
                  strokeWidth={bar.klass === "mentioned" ? 1.1 : 0}
                  strokeOpacity={bar.klass === "mentioned" ? 0.5 : 0}
                  strokeDasharray={bar.uncertain && bar.klass === "mentioned" ? "2,1.6" : undefined}
                >
                  <title>{bar.tip}</title>
                </rect>
                {bar.klass === "speaking" && (
                  <rect
                    data-cast-mark="voice"
                    x={bar.x - CAST_BAR_W / 2 - CAST_VOICE_OVER}
                    y={track.ty - bar.h - CAST_VOICE_CAP + 0.6}
                    width={CAST_BAR_W + CAST_VOICE_OVER * 2} height={CAST_VOICE_CAP}
                    rx={1.4}
                    fill={track.color} opacity={1}
                  >
                    <title>{bar.tip}</title>
                  </rect>
                )}
                {bar.driveTypes.map((type, i) => (
                  <rect
                    key={`${bar.key}-drive-${i}`}
                    data-cast-mark="drive"
                    data-drive-type={type}
                    x={rowX + i * (DRIVE_TICK + DRIVE_GAP)}
                    y={track.ty + 5.5}
                    width={DRIVE_TICK} height={DRIVE_TICK}
                    rx={1}
                    fill={(EVENT_COLOR as Record<string, string>)[type] ?? track.color}
                    opacity={0.95}
                  >
                    <title>{bar.tip}</title>
                  </rect>
                ))}
                {bar.driveOverflow > 0 && (
                  <text
                    x={rowX + rowW + 3} y={track.ty + 10}
                    fill="var(--panel-text-4)"
                    fontSize={7.5} fontFamily="var(--font-ui)" fontWeight="700"
                  >
                    +{bar.driveOverflow}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      ))}

      {/* Per-chapter elements */}
      {chapters.map(({ ch, entry, x, y, color, nr, isAct, isInspect }) => (
        <g
          key={ch.id}
          style={{ cursor: "pointer" }}
          onClick={() => { onSelectChapter(ch.id); }}
        >
          <line
            x1={x} y1={y + nr}
            x2={x} y2={LABEL_Y_NUM - 4}
            stroke="var(--divider-line)"
            strokeWidth={0.75}
            strokeOpacity={0.18}
          />

          {(entry?.role === "climax" || entry?.role === "pivot") && (
            <circle cx={x} cy={y} r={nr + 9}
              fill={color} opacity={0.11}
              filter="url(#tg-glow)"
            />
          )}

          <circle
            cx={x} cy={y} r={nr}
            fill={entry ? color : "var(--bg-glass)"}
            stroke={entry ? "none" : "var(--divider-line)"}
            strokeWidth={entry ? 0 : 1}
          />

          {isAct && (
            <circle cx={x} cy={y} r={nr + 4}
              fill="none" stroke={color}
              strokeWidth={1.5} opacity={0.55}
            />
          )}

          {/* Inspector ring — dashed, distinct from the active-chapter ring */}
          {isInspect && (
            <circle cx={x} cy={y} r={nr + 7}
              fill="none" stroke="var(--text-secondary)"
              strokeWidth={1.2} strokeDasharray="3,3" opacity={0.7}
            />
          )}

          <text
            x={x} y={LABEL_Y_NUM}
            textAnchor="middle" dominantBaseline="hanging"
            fill="var(--text-tertiary)"
            fontSize={7.5} fontFamily="var(--font-ui)"
            style={{ fontVariantNumeric: "tabular-nums" }}
            letterSpacing="0.05em"
          >
            {ch.number}
          </text>

          {ch.title && (
            <text
              x={x} y={LABEL_Y_TITLE}
              textAnchor="middle" dominantBaseline="hanging"
              fill={isAct ? "var(--text)" : "var(--text-secondary)"}
              fontSize={8.5} fontFamily="var(--font-ui)"
              fontWeight={isAct ? "600" : "400"}
              opacity={entry ? 1 : 0.4}
            >
              {ch.title.slice(0, 12)}
            </text>
          )}
        </g>
      ))}
    </>
  );
});

const EventBoxesLayer = memo(function EventBoxesLayer({ boxes, onHover, onPick }: {
  boxes: PlacedBox[];
  /** Feeds the styled hover card — the native <title> tooltip is gone because
   *  it could show only unstyled text after a fixed delay, which is most of
   *  why the chips earned nothing. */
  onHover: (box: PlacedBox | null) => void;
  onPick: (box: PlacedBox) => void;
}) {
  return (
    <>
      {boxes.map((box) => (
        <g
          key={box.key}
          style={{ cursor: "pointer" }}
          onMouseEnter={() => onHover(box)}
          onMouseLeave={() => onHover(null)}
          onClick={(e) => { e.stopPropagation(); onPick(box); }}
        >
          <path
            d={box.branchPath}
            fill="none" stroke={box.color}
            strokeWidth={1.1} strokeOpacity={0.3}
          />
          <rect
            x={box.x} y={box.y}
            width={box.w} height={BOX_H}
            rx={BOX_H / 2}
            fill={box.color} fillOpacity={0.09}
            stroke={box.color} strokeWidth={0.9} strokeOpacity={0.5}
          />
          {box.detail && (
            <>
              <text
                x={box.x + BOX_SIDE_PAD} y={box.y + BOX_H / 2}
                textAnchor="start" dominantBaseline="central"
                fill={box.color}
                fontSize={6.4} fontFamily="var(--font-ui)"
                fontWeight="700" letterSpacing="0.08em"
                opacity={0.68}
              >
                {box.detail}
              </text>
              <circle
                cx={box.x + BOX_SIDE_PAD + box.detailW - 4}
                cy={box.y + BOX_H / 2}
                r={1.2}
                fill={box.color}
                opacity={0.46}
              />
            </>
          )}
          <text
            x={box.x + BOX_SIDE_PAD + box.detailW + (box.detail ? BOX_DETAIL_GAP : 0)} y={box.y + BOX_H / 2}
            textAnchor="start" dominantBaseline="central"
            fill="var(--text-secondary)"
            fontSize={8.5} fontFamily="var(--font-ui)"
            fontStyle="italic" letterSpacing="0.01em"
          >
            {box.label}
          </text>
        </g>
      ))}
    </>
  );
});

function TimelineGraphFullImpl({
  storyGraph, chapters, characterTracks, insights, focusChapterId,
  currentChapterId, onSelectChapter, onJumpToEvent, onClose,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const layoutCacheRef = useRef<Map<string, PlacedBox[]>>(new Map());
  const [detailRange, setDetailRange] = useState<VisibleRange>(() => computeVisibleRange(0, 0, chapters.length));
  const [detailsReady, setDetailsReady] = useState(false);
  // Chapter whose inspector rail is open. Click a node to set, Esc / × to clear.
  const [inspectId, setInspectId] = useState<string | null>(focusChapterId ?? null);
  const inspectIdRef = useRef(inspectId);
  inspectIdRef.current = inspectId;
  // Event chip under the pointer — drives the styled hover card.
  const [hoverBox, setHoverBox] = useState<PlacedBox | null>(null);
  // Which insight's full sentence shows under the chip strip.
  const [activeInsight, setActiveInsight] = useState(0);
  const analyzed  = Object.keys(storyGraph.entries).length;
  const svgW      = PAD_X + Math.max(0, chapters.length - 1) * CHAPTER_W + PAD_X;
  const svgH      = CHAR_ZONE_TOP + CAST_HEADER_H + Math.max(Math.min(characterTracks.length, MAX_TRACKS), 1) * CHAR_TRACK_H + 22;

  const handleChapterSelect = useCallback((id: string) => {
    onSelectChapter(id);
    onClose();
  }, [onClose, onSelectChapter]);

  // Chapters whose analysis no longer matches their text. The insight layer
  // already worked this out (it has the content; this component does not).
  const staleIds = useMemo(
    () => new Set(insights.find((i) => i.kind === "stale")?.chapterIds ?? []),
    [insights],
  );

  const trackColor = useMemo(
    () => new Map(characterTracks.map((t) => [t.name.toLowerCase(), t.color])),
    [characterTracks],
  );

  // Centre a chapter in the viewport and open its inspector — for jumps that
  // arrive from OUTSIDE the canvas (insight chips, the panel's insight lines).
  const focusChapter = useCallback((id: string) => {
    setInspectId(id);
    const idx = chapters.findIndex((c) => c.id === id);
    const el = scrollRef.current;
    if (idx >= 0 && el) {
      el.scrollTo({ left: Math.max(0, chapterX(idx) - el.clientWidth / 2), behavior: "smooth" });
    }
  }, [chapters]);

  // Open the inspector on a clicked node WITHOUT re-centring the view — the
  // user is already looking at it. Only exception: if the rail would cover
  // the clicked node, nudge the canvas left just far enough to keep it seen.
  const inspectChapter = useCallback((id: string) => {
    setInspectId(id);
    const idx = chapters.findIndex((c) => c.id === id);
    const el = scrollRef.current;
    if (idx < 0 || !el) return;
    const railW = 340; // rail width + gutter
    const viewportX = chapterX(idx) - el.scrollLeft;
    if (viewportX > el.clientWidth - railW) {
      el.scrollTo({ left: chapterX(idx) - (el.clientWidth - railW - 20), behavior: "smooth" });
    }
  }, [chapters]);

  // Opened from an insight line in the panel: land on the chapter it cites.
  useEffect(() => {
    if (focusChapterId) focusChapter(focusChapterId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc peels one layer at a time: inspector first, then the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (inspectIdRef.current) { setInspectId(null); return; }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleBoxPick = useCallback((box: PlacedBox) => {
    if (onJumpToEvent) onJumpToEvent(box.chapterId, box.evt);
    else setInspectId(box.chapterId);
  }, [onJumpToEvent]);

  // Everything the inspector rail shows, derived once per selection.
  const inspect = useMemo(() => {
    if (!inspectId) return null;
    const ch = chapters.find((c) => c.id === inspectId);
    if (!ch) return null;
    const entry = storyGraph.entries[inspectId];
    // The canvas shows the engine's top three; the rail shows EVERYTHING the
    // engine kept, in reading order — that difference is the point of a rail.
    const events = [...(entry?.majorEvents ?? [])]
      .sort((a, b) => (a.paragraphIndex ?? 0) - (b.paragraphIndex ?? 0));
    return { ch, entry, events, stale: staleIds.has(inspectId) };
  }, [inspectId, chapters, storyGraph, staleIds]);

  useEffect(() => {
    const body = document.body;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const prevBodyOverflow = body.style.overflow;
    const prevBodyPosition = body.style.position;
    const prevBodyTop = body.style.top;
    const prevBodyLeft = body.style.left;
    const prevBodyWidth = body.style.width;
    const prevBodyTouchAction = body.style.touchAction;

    body.classList.add(TIMELINE_OVERLAY_BODY_CLASS);
    body.style.position = "fixed";
    body.style.top = `${-scrollY}px`;
    body.style.left = `${-scrollX}px`;
    body.style.width = "100%";
    body.style.overflow = "hidden";
    body.style.touchAction = "none";

    return () => {
      body.classList.remove(TIMELINE_OVERLAY_BODY_CLASS);
      body.style.overflow = prevBodyOverflow;
      body.style.position = prevBodyPosition;
      body.style.top = prevBodyTop;
      body.style.left = prevBodyLeft;
      body.style.width = prevBodyWidth;
      body.style.touchAction = prevBodyTouchAction;
      window.scrollTo(scrollX, scrollY);
    };
  }, []);

  useEffect(() => {
    let frameId = 0;
    const markReady = () => {
      setDetailsReady(true);
      frameId = 0;
    };
    if (typeof requestAnimationFrame === "function") {
      frameId = requestAnimationFrame(markReady);
    } else {
      setDetailsReady(true);
    }
    return () => {
      if (frameId !== 0) cancelAnimationFrame(frameId);
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    let rafId = 0;
    const syncDetailRange = () => {
      rafId = 0;
      const next = computeVisibleRange(el.scrollLeft, el.clientWidth, chapters.length);
      startTransition(() => {
        setDetailRange(prev => prev.start === next.start && prev.end === next.end ? prev : next);
      });
    };

    const scheduleSync = () => {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(syncDetailRange);
    };

    syncDetailRange();
    el.addEventListener("scroll", scheduleSync, { passive: true });
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(scheduleSync)
      : null;
    resizeObserver?.observe(el);

    return () => {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      el.removeEventListener("scroll", scheduleSync);
      resizeObserver?.disconnect();
    };
  }, [chapters.length]);

  // Per-chapter computed data that only changes when the graph changes.
  const baseChData = useMemo<ChapterRenderData[]>(() => chapters.map((ch, i) => {
    const entry  = storyGraph.entries[ch.id];
    const x      = chapterX(i);
    const y      = entry ? spineY(entry.tensionPeak) : SPINE_BASE;
    const color  = entry ? roleColor(entry.role) : "#475569";
    const nr     = entry ? nodeRadius(entry.role, entry.tensionPeak) : 6;
    // Best by RANK, drawn in reading order — never a slice of the stored array,
    // which is ordered by paragraph and would select the chapter's opening.
    // The local model's picks, when it has any, are ranks OF THIS ARRAY.
    const events = selectDisplayChips(entry);
    return { ch, entry, x, y, color, nr, isAct: false, isInspect: false, events };
  }), [chapters, storyGraph]);

  const chData = useMemo(
    () => baseChData.map((item) => ({
      ...item,
      isAct: item.ch.id === currentChapterId,
      isInspect: item.ch.id === inspectId,
    })),
    [baseChData, currentChapterId, inspectId],
  );

  const trackLayouts = useMemo<TrackRenderData[]>(() => {
    return characterTracks.slice(0, MAX_TRACKS).map((track, ti) => {
      // Baseline sits low in the row so the tallest bar stays inside it.
      const ty = CHAR_ZONE_TOP + CAST_HEADER_H + ti * CHAR_TRACK_H + CAST_BAR_MAX + 12;
      const detected = baseChData.filter((chapter) => track.chapterIds.has(chapter.ch.id));
      const mentionsOf = (id: string) => track.mentionsByChapter?.get(id) ?? 0;
      const maxMentions = Math.max(1, ...detected.map((c) => mentionsOf(c.ch.id)));
      const hasMentionData = detected.some((c) => mentionsOf(c.ch.id) > 0);
      let drivesTotal = 0;

      const peakMentions = hasMentionData ? maxMentions : -1;
      let speakingCount = 0;
      let evokedCount = 0;
      const bars = detected.map((chapter) => {
        const mentions = mentionsOf(chapter.ch.id);
        // ★ NO CLASSIFICATION MEANS PRESENT, NOT MENTIONED. Graphs persisted
        //   before the classifier existed carry nothing, and defaulting those
        //   to "mentioned" would redraw a writer's whole cast as ghosts on the
        //   first launch after an update.
        const klass = track.presenceByChapter?.get(chapter.ch.id) ?? "present";
        const uncertain = track.uncertainChapters?.has(chapter.ch.id) ?? false;
        if (klass === "speaking") speakingCount += 1;
        if (klass === "mentioned") evokedCount += 1;
        const drivesCount = track.drivesByChapter?.get(chapter.ch.id) ?? 0;
        // ★ TYPES ARE THE TRUTH, THE COUNT IS THE FALLBACK. `driveTypesByChapter`
        //   is only set by builders that walked majorEvents; an older persisted
        //   graph has the count alone, and a row must still draw the right
        //   NUMBER of squares then, just without their colours.
        const storedTypes = track.driveTypesByChapter?.get(chapter.ch.id);
        const allTypes = storedTypes && storedTypes.length > 0
          ? [...storedTypes]
          : Array.from({ length: drivesCount }, () => "standard");
        drivesTotal += drivesCount;
        // sqrt: presence reads perceptually, so 4x the mentions should look
        // clearly bigger without flattening every mid-weight chapter. An evoked
        // chapter gets the fixed ghost height instead — see CAST_GHOST_H.
        const h = klass === "mentioned"
          ? CAST_GHOST_H
          : hasMentionData
            ? CAST_BAR_MIN + (CAST_BAR_MAX - CAST_BAR_MIN) * Math.sqrt(mentions / maxMentions)
            : (CAST_BAR_MIN + CAST_BAR_MAX) / 2;
        const shownTypes = allTypes.slice(0, DRIVE_MAX);
        const typeNames = allTypes.length > 0
          ? ` · drives ${allTypes.length}: ${allTypes.join(", ")}`
          : "";
        const klassWord = klass === "speaking" ? "speaks here"
          : klass === "mentioned" ? "talked about, not on the page"
          : "on the page, silent";
        return {
          key: `bar-${track.name}-${chapter.ch.id}`,
          x: chapter.x,
          h,
          klass,
          uncertain,
          driveTypes: shownTypes,
          driveOverflow: Math.max(0, allTypes.length - shownTypes.length),
          // The peak is about how much of a chapter they OCCUPY, so a chapter
          // they are only talked about in can never be one.
          peak: klass !== "mentioned" && hasMentionData && mentions === peakMentions && mentions > 0,
          tip: `${track.name} — ch ${chapter.ch.number} · ${klassWord}`
            + (uncertain ? " (unsure)" : "")
            + (hasMentionData ? ` · ${mentions} mention${mentions === 1 ? "" : "s"}` : "")
            + typeNames,
        };
      });

      const links: Array<{ key: string; x1: number; x2: number }> = [];
      const bridges: Array<{ key: string; x1: number; x2: number }> = [];
      let longestGap = 0;
      for (let index = 0; index < detected.length - 1; index += 1) {
        const left = detected[index];
        const right = detected[index + 1];
        const gap = right.ch.number - left.ch.number - 1;
        longestGap = Math.max(longestGap, gap);
        const pair = {
          key: `run-${track.name}-${left.ch.id}-${right.ch.id}`,
          x1: left.x,
          x2: right.x,
        };
        (gap > 2 ? bridges : links).push(pair);
      }

      // ★ "ENTERS" MEANS WALKS ON, NOT GETS NAMED. A character the others
      //   discuss for four chapters before she arrives used to read as entering
      //   in chapter one, which is the opposite of what the writer set up.
      const firstOnPage = bars.find((b) => b.klass !== "mentioned");
      const firstOnPageCh = firstOnPage
        ? detected[bars.indexOf(firstOnPage)]?.ch.number
        : undefined;
      const firstNamedCh = detected[0]?.ch.number;
      // The chapter they are most present in. Reading it off the bars means
      // comparing every height against every other; naming it costs one word.
      const peakChapter = hasMentionData
        ? detected.find((c) =>
            mentionsOf(c.ch.id) === maxMentions
            && track.presenceByChapter?.get(c.ch.id) !== "mentioned")?.ch.number
        : undefined;
      // The gap between being talked about and turning up is a setup the writer
      // built, so it gets said out loud rather than left to be inferred.
      const heraldGap = firstOnPageCh !== undefined && firstNamedCh !== undefined
        ? firstOnPageCh - firstNamedCh
        : 0;
      // ★ THE LINE IS RIGHT-ALIGNED AT THE CHARACTER'S ENTRY, so its width is
      //   whatever margin that chapter happens to leave — for a lead who is
      //   there from chapter 1 that is almost nothing. Adding three new facts
      //   pushed those stat lines clean off the left edge with every gate
      //   green. A fixed item cap does not fix it either: the space depends on
      //   WHERE the character enters, so the line is fitted to the room it
      //   actually has and the full list lives in the tooltip, where width is
      //   free.
      const ranked = [
        firstOnPageCh !== undefined && firstOnPageCh > 1 ? `enters ${firstOnPageCh}` : null,
        heraldGap >= 2 ? `named from ${firstNamedCh}` : null,
        speakingCount > 0 ? `speaks ${speakingCount}` : null,
        drivesTotal > 0 ? `drives ${drivesTotal}` : null,
        evokedCount > 0 ? `offstage ${evokedCount}` : null,
        peakChapter !== undefined ? `peak ${peakChapter}` : null,
        longestGap >= 3 ? `away ${longestGap}` : null,
      ].filter((v): v is string => Boolean(v));
      const statsFull = [`${track.count} ch`, ...ranked].join(" · ");
      // Right-anchored at firstX - 12, so the room is everything left of that.
      const avail = (detected[0]?.x ?? PAD_X) - 12 - STAT_LEFT_MARGIN;
      let stats = `${track.count} ch`;
      for (const item of ranked) {
        const next = `${stats} · ${item}`;
        if (next.length * STAT_CHAR_W > avail) break;
        stats = next;
      }

      return {
        name: track.name,
        color: track.color,
        ty,
        firstX: detected[0]?.x ?? PAD_X,
        lastX: detected[detected.length - 1]?.x ?? PAD_X,
        stats,
        statsFull,
        bars,
        links,
        bridges,
      };
    });
  }, [baseChData, characterTracks]);

  // Spine terrain path
  const spinePath = useMemo(
    () => catmullRomPath(baseChData.map(d => ({ x: d.x, y: d.y }))),
    [baseChData],
  );

  // Filled area under spine (subtle terrain feel)
  const areaPath = useMemo(() => {
    if (baseChData.length < 2) return "";
    const first = baseChData[0];
    const last  = baseChData[baseChData.length - 1];
    const baseY = LABEL_Y_NUM - 4;
    return `${spinePath} L${last.x},${baseY} L${first.x},${baseY} Z`;
  }, [spinePath, baseChData]);

  useEffect(() => {
    layoutCacheRef.current.clear();
  }, [baseChData]);

  const layoutWindow = useMemo(() => {
    if (!detailsReady || baseChData.length === 0) {
      return { start: 0, end: -1, items: [] as ChapterRenderData[] };
    }
    const start = Math.max(0, detailRange.start - EVENT_LAYOUT_OVERSCAN);
    const end = Math.min(baseChData.length - 1, detailRange.end + EVENT_LAYOUT_OVERSCAN);
    return {
      start,
      end,
      items: baseChData.slice(start, end + 1),
    };
  }, [baseChData, detailRange, detailsReady]);

  // Leaf-bubbling collision layout only for the visible box window.
  const eventBoxes = useMemo(() => {
    if (layoutWindow.items.length === 0) return [];
    const key = `${layoutWindow.start}:${layoutWindow.end}`;
    const cached = layoutCacheRef.current.get(key);
    if (cached) return cached;
    const next = layoutBoxes(layoutWindow.items);
    layoutCacheRef.current.set(key, next);
    return next;
  }, [layoutWindow]);

  const detailLeft = detailsReady && baseChData.length > 0
    ? baseChData[Math.max(0, detailRange.start)]?.x - BOX_VIS_PAD
    : 0;
  const detailRight = detailsReady && baseChData.length > 0
    ? baseChData[Math.min(baseChData.length - 1, detailRange.end)]?.x + BOX_VIS_PAD
    : svgW;

  const visibleEventBoxes = useMemo(
    () => eventBoxes.filter(box => box.x + box.w >= detailLeft && box.x <= detailRight),
    [eventBoxes, detailLeft, detailRight],
  );

  // If the hovered chip scrolls out of the virtualised window its mouseleave
  // never fires — drop the card rather than let it orphan.
  useEffect(() => {
    setHoverBox((prev) => (prev && !visibleEventBoxes.includes(prev) ? null : prev));
  }, [visibleEventBoxes]);

  return (
    <div
      className="timeline-full-overlay"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="timeline-full-panel"
      >
        {/* ── Header ── */}
        <div className="timeline-full-header">
          <div className="timeline-full-header-main">
            <Activity size={14} style={{ color: "var(--text-tertiary)", opacity: 0.7 }} />
            <span style={{ fontFamily: "var(--font-body)", fontSize: "1rem", fontStyle: "italic", color: "var(--text)" }}>
              Story Graph
            </span>
            <span style={{ fontFamily: "var(--font-ui)", fontSize: 10, color: "var(--text-tertiary)", marginLeft: 2 }}>
              {analyzed} / {chapters.length} analyzed
            </span>
          </div>
          {/* Role legend */}
          <div className="timeline-full-legend">
            {(["climax","pivot","buildup","resolution","expository","breather","standard"] as const).map(role => (
              <div key={role} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: roleColor(role) }} />
                <span style={{ fontFamily: "var(--font-ui)", fontSize: 8.5, color: "var(--text-tertiary)", letterSpacing: "0.04em" }}>
                  {role}
                </span>
              </div>
            ))}
          </div>
          <button className="icon-btn timeline-full-close" type="button" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <CloseIcon />
          </button>
        </div>

        {/* ── Insight strip — what the graph knows across chapters ── */}
        {insights.length > 0 && (
          <div className="timeline-insight-strip">
            <div className="timeline-insight-chips">
              {insights.map((ins, i) => (
                <button
                  key={ins.kind + ins.chapterIds.join()}
                  type="button"
                  className={`timeline-insight-chip${i === activeInsight ? " timeline-insight-chip--active" : ""}`}
                  data-severity={ins.severity}
                  onClick={() => {
                    setActiveInsight(i);
                    if (ins.chapterIds[0]) focusChapter(ins.chapterIds[0]);
                  }}
                >
                  <span className="timeline-insight-dot" aria-hidden />
                  {ins.chip}
                </button>
              ))}
            </div>
            <p className="timeline-insight-detail">
              {insights[Math.min(activeInsight, insights.length - 1)].text}
            </p>
          </div>
        )}

        {/* ── Canvas + inspector share one positioning context ── */}
        <div className="timeline-full-body">
          <div
            ref={scrollRef}
            className="timeline-full-scroll"
          >
            {/* Relative wrapper the hover card positions inside — it scrolls
                WITH the canvas, so the card stays glued to its chip. margin
                auto keeps a short book centred, which is what the old svg
                min-width 100% + preserveAspectRatio letterboxing produced. */}
            <div style={{ position: "relative", width: svgW, height: svgH, margin: "0 auto" }}>
              <svg
                width={svgW}
                height={svgH}
                viewBox={`0 0 ${svgW} ${svgH}`}
                style={{ display: "block", overflow: "visible" }}
              >
                <defs>
                  <pattern id="tg-dots" x="0" y="0" width="28" height="28" patternUnits="userSpaceOnUse">
                    <circle cx="14" cy="14" r="0.8" fill="var(--divider-line)" />
                  </pattern>
                  <linearGradient id="tg-terrain" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--text)" stopOpacity="0.04" />
                    <stop offset="100%" stopColor="var(--text)" stopOpacity="0" />
                  </linearGradient>
                  <filter id="tg-glow" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="6" result="b" />
                    <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
                  </filter>
                </defs>

                <StaticTimelineLayer
                  svgW={svgW}
                  svgH={svgH}
                  areaPath={areaPath}
                  spinePath={spinePath}
                  chapters={chData}
                  trackLayouts={trackLayouts}
                  detailsReady={detailsReady}
                  onSelectChapter={inspectChapter}
                />
                {detailsReady && (
                  <EventBoxesLayer boxes={visibleEventBoxes} onHover={setHoverBox} onPick={handleBoxPick} />
                )}
              </svg>

              {/* ── Hover card — the event, allowed to justify itself ── */}
              {hoverBox && (() => {
                const below = hoverBox.y < 170;
                const evt = hoverBox.evt;
                return (
                  <div
                    className="timeline-hover-card"
                    data-below={below || undefined}
                    style={{
                      left: Math.min(Math.max(hoverBox.cx, 150), svgW - 150),
                      top: below ? hoverBox.y + BOX_H + 10 : hoverBox.y - 10,
                    }}
                  >
                    <div className="timeline-hover-card-head">
                      <span className="timeline-hover-card-type" style={{ color: hoverBox.color }}>
                        {evt.narrativeType ?? evt.type}
                      </span>
                      {evt.salience === "major" && <span className="timeline-hover-card-salience">major</span>}
                      <span className="timeline-hover-card-loc">
                        {evt.paragraphIndex !== undefined ? `¶${evt.paragraphIndex + 1}` : `${Math.round(evt.tensionPosition * 100)}%`}
                        {` · ${Math.round(evt.confidence * 100)}%`}
                      </span>
                    </div>
                    {evt.agent && <div className="timeline-hover-card-agent">{evt.agent}</div>}
                    {evt.sentence && <p className="timeline-hover-card-clause">{evt.sentence}</p>}
                    {onJumpToEvent && <div className="timeline-hover-card-hint">Click to open in the editor</div>}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* ── Chapter inspector rail ── */}
          {inspect && (
            <aside className="timeline-inspector" aria-label={`Chapter ${inspect.ch.number} details`}>
              <div className="timeline-inspector-head">
                <span className="timeline-inspector-eyebrow">Chapter {inspect.ch.number}</span>
                <button className="icon-btn" type="button" onClick={() => setInspectId(null)} aria-label="Close inspector">
                  <CloseIcon />
                </button>
              </div>
              <h3 className="timeline-inspector-title">{inspect.ch.title || `Chapter ${inspect.ch.number}`}</h3>

              {inspect.entry ? (
                <div className="timeline-inspector-scroll">
                  <div className="timeline-inspector-meta">
                    <span className="timeline-inspector-role" style={{ color: roleColor(inspect.entry.role) }}>
                      {inspect.entry.role}
                    </span>
                    <span>{inspect.entry.proseRegister}</span>
                    <span>{inspect.entry.wordCount >= 1000 ? `${(inspect.entry.wordCount / 1000).toFixed(1)}k` : inspect.entry.wordCount} words</span>
                  </div>

                  {inspect.stale && (
                    <p className="timeline-inspector-stale">
                      This chapter changed since its last analysis. What follows describes the earlier text.
                    </p>
                  )}

                  {/* ── Enhanced mode ──────────────────────────────────────
                      The chapter in prose, written by the local model from the
                      same ranked moments the chips come from. This block is
                      the whole visible difference between the two modes: it
                      exists when an entry carries a summary and is absent
                      otherwise, with no placeholder and no "unavailable" note.
                      Mode is a property of the DATA, never a switch. */}
                  {inspect.entry.lmSummary && (
                    <div className="timeline-inspector-summary">
                      <p className="timeline-inspector-summary-text">{inspect.entry.lmSummary}</p>
                      {inspect.entry.lmThroughline && (
                        <p className="timeline-inspector-summary-through">
                          {inspect.entry.lmThroughline}
                        </p>
                      )}
                    </div>
                  )}

                  {inspect.entry.tensionCurve.length > 1 && (() => {
                    const W = 268, H = 36;
                    const pts = inspect.entry!.tensionCurve;
                    const step = W / (pts.length - 1);
                    const xy = pts.map((v, i) => [i * step, H - 4 - Math.min(1, Math.max(0, v)) * (H - 8)] as const);
                    const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
                    const peakI = pts.indexOf(Math.max(...pts));
                    const rc = roleColor(inspect.entry!.role);
                    return (
                      <div className="timeline-inspector-section">
                        <p className="timeline-inspector-label">Tension</p>
                        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="timeline-inspector-spark" aria-hidden>
                          <path d={`${line} L${W},${H} L0,${H} Z`} fill={rc} opacity={0.09} />
                          <path d={line} fill="none" stroke={rc} strokeWidth={1.5} opacity={0.65} />
                          <circle cx={xy[peakI][0]} cy={xy[peakI][1]} r={2.5} fill={rc} />
                        </svg>
                      </div>
                    );
                  })()}

                  <div className="timeline-inspector-section">
                    <p className="timeline-inspector-label">What happens</p>
                    {inspect.events.length > 0 ? (
                      <ul className="timeline-inspector-events">
                        {inspect.events.map((evt, i) => (
                          <li key={`${evt.paragraphIndex ?? i}-${evt.label}`}>
                            <button
                              type="button"
                              className="timeline-inspector-event"
                              onClick={() => onJumpToEvent?.(inspect.ch.id, evt)}
                              disabled={!onJumpToEvent}
                            >
                              <span
                                className="timeline-inspector-event-dot"
                                data-salience={evt.salience ?? "major"}
                                style={{ "--evt-color": EVENT_COLOR[evt.type] ?? "#64748b" } as CSSProperties}
                              />
                              <span className="timeline-inspector-event-body">
                                <span className="timeline-inspector-event-label">{evt.label}</span>
                                <span className="timeline-inspector-event-meta">
                                  {evt.narrativeType ?? evt.type}
                                  {evt.agent ? ` · ${evt.agent}` : ""}
                                  {evt.paragraphIndex !== undefined ? ` · ¶${evt.paragraphIndex + 1}` : ""}
                                </span>
                                {evt.sentence && (
                                  <span className="timeline-inspector-event-clause">{evt.sentence}</span>
                                )}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="timeline-inspector-quiet">
                        No turn detected: nothing here reads as a decision, revelation or change of state.
                      </p>
                    )}
                  </div>

                  {inspect.entry.charactersPresent.length > 0 && (
                    <div className="timeline-inspector-section">
                      <p className="timeline-inspector-label">Cast</p>
                      <div className="timeline-inspector-cast">
                        {inspect.entry.charactersPresent.map((name) => (
                          <span key={name} className="timeline-inspector-cast-chip">
                            <span
                              className="timeline-inspector-cast-dot"
                              style={{ background: trackColor.get(name.toLowerCase()) ?? "var(--text-tertiary)" }}
                            />
                            {name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="timeline-inspector-scroll">
                  <p className="timeline-inspector-quiet">
                    Not analyzed yet. Open the chapter and the analysis will fill this in.
                  </p>
                </div>
              )}

              <button
                type="button"
                className="timeline-inspector-open"
                onClick={() => handleChapterSelect(inspect.ch.id)}
              >
                Open chapter
              </button>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

export const TimelineGraphFull = memo(TimelineGraphFullImpl);
