/**
 * Full-screen narrative timeline — "Narrative Terrain" design.
 *
 * Design system:
 *  - Spine undulates with tension: high-tension chapters rise, low-tension fall
 *  - Node radius encodes narrative weight (role + tensionPeak)
 *  - Event chips use a relaxed collision layout and stay clear of chapter nodes
 *  - Character tracks: dashed baseline (full span) + solid dots (where detected)
 *    guarantees every character always appears consistently
 *  - Active chapter: glowing vertical beam through full SVG height
 *  - Atmosphere: dot-grid, subtle gradient fills, cinematic not diagrammatic
 */

import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity } from "lucide-react";
import type { Novel, StoryGraph, MajorEvent } from "../types";
import type { TimelineCharacterTrack } from "../lib/story-graph-display";
import { measureTextWidth } from "../lib/measure-text";
import { CloseIcon } from "./Icon";

type TimelineChapterDisplay = Pick<Novel["chapters"][number], "id" | "number" | "title">;

interface Props {
  storyGraph: StoryGraph;
  chapters: TimelineChapterDisplay[];
  characterTracks: TimelineCharacterTrack[];
  currentChapterId: string | null;
  onSelectChapter: (id: string) => void;
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
const MAX_EVENTS  = 3;     // max events per chapter fed into layout
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
const BOX_LABEL_MAX = 30;
const BOX_LABEL_MAX_WITH_DETAIL = 20;
const BOX_MAX_W = 186;
// Chapter labels — at fixed Y just below terrain zone
const LABEL_Y_NUM   = SPINE_BASE + TERRAIN_AMP + 18;  // = 358
const LABEL_Y_TITLE = SPINE_BASE + TERRAIN_AMP + 30;  // = 370
// Character tracks
const MAX_TRACKS    = 6;
const CHAR_ZONE_TOP = SPINE_BASE + TERRAIN_AMP + 52;   // = 392
const CHAR_TRACK_H  = 33;
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
  /** Hover text: type, salience, location, confidence, and the SOURCE CLAUSE.
   *  Threaded all the way through the layout because the label is capped at
   *  20-30 characters and cannot justify itself; before `sentence` was
   *  persisted there was nothing to show here. */
  tip: string;
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
  events: Array<{ type: MajorEvent["type"]; label: string; detailLabel?: string }>;
}

interface TrackRenderData {
  name: string;
  color: string;
  ty: number;
  firstX: number;
  lastX: number;
  points: Array<{ key: string; x: number }>;
  segments: Array<{ key: string; x1: number; x2: number }>;
}

const TIMELINE_OVERLAY_BODY_CLASS = "timeline-overlay-freeze";

function detailTag(event: Pick<MajorEvent, "detailLabel">): string | null {
  return event.detailLabel ? event.detailLabel.toUpperCase() : null;
}

function layoutBoxes(
  chData: Array<{
    ch: { id: string };
    x: number; y: number; nr: number;
    events: Array<{
      type: string; label: string; detailLabel?: string;
      sentence?: string; paragraphIndex?: number; narrativeType?: string;
      salience?: string; confidence?: number; tensionPosition?: number;
    }>;
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
        tip: [
          `${evt.narrativeType ?? evt.type}${evt.salience ? ` · ${evt.salience}` : ""}`,
          evt.paragraphIndex !== undefined
            ? `¶${evt.paragraphIndex + 1}${evt.confidence !== undefined ? ` · ${Math.round(evt.confidence * 100)}% confidence` : ""}`
            : evt.tensionPosition !== undefined
              ? `${Math.round(evt.tensionPosition * 100)}% through the chapter`
              : "",
          evt.sentence ? `\n${evt.sentence}` : "",
        ].filter(Boolean).join("\n"),
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

      {/* Character tracks — dashed baseline + presence dots */}
      {trackLayouts.map((track) => (
        <g key={`track-${track.name}`}>
          <line
            x1={track.firstX} y1={track.ty}
            x2={track.lastX}  y2={track.ty}
            stroke={track.color}
            strokeWidth={1}
            strokeOpacity={0.15}
            strokeDasharray="2,6"
          />
          <text
            x={track.firstX - 10} y={track.ty}
            textAnchor="end" dominantBaseline="central"
            fill={track.color}
            fontSize={8} fontFamily="var(--font-ui)"
            fontWeight="700" letterSpacing="0.08em"
            opacity={0.6}
          >
            {track.name.slice(0, 7).toUpperCase()}
          </text>
          {detailsReady && track.segments.map((segment) => (
            <line
              key={segment.key}
              x1={segment.x1} y1={track.ty}
              x2={segment.x2} y2={track.ty}
              stroke={track.color}
              strokeWidth={1.5}
              strokeOpacity={0.35}
            />
          ))}
          {detailsReady && track.points.map((point) => (
            <circle
              key={point.key}
              cx={point.x} cy={track.ty} r={4.5}
              fill={track.color} opacity={0.82}
            />
          ))}
        </g>
      ))}

      {/* Per-chapter elements */}
      {chapters.map(({ ch, entry, x, y, color, nr, isAct }) => (
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

const EventBoxesLayer = memo(function EventBoxesLayer({ boxes }: { boxes: PlacedBox[] }) {
  return (
    <>
      {boxes.map((box) => (
        <g key={box.key}>
          <path
            d={box.branchPath}
            fill="none" stroke={box.color}
            strokeWidth={1.1} strokeOpacity={0.3}
          />
          <title>{box.tip}</title>
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
  storyGraph, chapters, characterTracks, currentChapterId, onSelectChapter, onClose,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const layoutCacheRef = useRef<Map<string, PlacedBox[]>>(new Map());
  const [detailRange, setDetailRange] = useState<VisibleRange>(() => computeVisibleRange(0, 0, chapters.length));
  const [detailsReady, setDetailsReady] = useState(false);
  const analyzed  = Object.keys(storyGraph.entries).length;
  const svgW      = PAD_X + Math.max(0, chapters.length - 1) * CHAPTER_W + PAD_X;
  const svgH      = CHAR_ZONE_TOP + Math.max(characterTracks.length, 1) * CHAR_TRACK_H + 20;

  const handleChapterSelect = useCallback((id: string) => {
    onSelectChapter(id);
    onClose();
  }, [onClose, onSelectChapter]);

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
    const events = (entry?.majorEvents ?? []).slice(0, MAX_EVENTS);
    return { ch, entry, x, y, color, nr, isAct: false, events };
  }), [chapters, storyGraph]);

  const chData = useMemo(
    () => baseChData.map((item) => ({ ...item, isAct: item.ch.id === currentChapterId })),
    [baseChData, currentChapterId],
  );

  const trackLayouts = useMemo<TrackRenderData[]>(() => {
    const firstX = baseChData[0]?.x ?? PAD_X;
    const lastX = baseChData[baseChData.length - 1]?.x ?? PAD_X;
    return characterTracks.slice(0, MAX_TRACKS).map((track, ti) => {
      const ty = CHAR_ZONE_TOP + ti * CHAR_TRACK_H + CHAR_TRACK_H / 2;
      const detected = baseChData.filter((chapter) => track.chapterIds.has(chapter.ch.id));
      const points = detected.map((chapter) => ({
        key: `dot-${track.name}-${chapter.ch.id}`,
        x: chapter.x,
      }));
      const segments: Array<{ key: string; x1: number; x2: number }> = [];
      for (let index = 0; index < detected.length - 1; index += 1) {
        const left = detected[index];
        const right = detected[index + 1];
        if (right.ch.number - left.ch.number > 2) continue;
        segments.push({
          key: `seg-${track.name}-${left.ch.id}-${right.ch.id}`,
          x1: left.x,
          x2: right.x,
        });
      }
      return {
        name: track.name,
        color: track.color,
        ty,
        firstX,
        lastX,
        points,
        segments,
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

        {/* ── Scrollable SVG canvas ── */}
        <div
          ref={scrollRef}
          className="timeline-full-scroll"
        >
          <svg
            width={svgW}
            height={svgH}
            viewBox={`0 0 ${svgW} ${svgH}`}
            style={{ display: "block", minWidth: "100%", overflow: "visible" }}
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
              onSelectChapter={handleChapterSelect}
            />
            {detailsReady && (
              <EventBoxesLayer boxes={visibleEventBoxes} />
            )}
          </svg>
        </div>
      </div>
    </div>
  );
}

export const TimelineGraphFull = memo(TimelineGraphFullImpl);
