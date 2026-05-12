import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ChapterAnalysis } from "../../lib/use-analysis";
import { WidgetCard } from "./WidgetCard";
import { ArcRing, type ArcSegment } from "./ArcRing";
import { buildSpeakerPalette, getSpeakerColor } from "../../lib/palette";

type FloatLabelSide = "left" | "right" | "center";

interface FloatLabelSeed {
  key: string;
  angle: number;
  leftPct: number;
  topPct: number;
  share: number;
  fontSize: number;
  color: string;
  side: FloatLabelSide;
}

interface FloatLabelOffset {
  dx: number;
  dy: number;
}

const TOP_N = 5;
const FLOAT_LABEL_GAP_PX = 9;
const FLOAT_LABEL_MAX_OUTSET_PX = 10;
const FLOAT_LABEL_MAX_INSET_PX = 10;
const FLOAT_LABEL_CENTER_BIAS_PX = 4;
const TAU = Math.PI * 2;

function normalizeAngle(angle: number): number {
  const normalized = angle % TAU;
  return normalized < 0 ? normalized + TAU : normalized;
}

function roundOffset(value: number): number {
  return Math.round(value * 10) / 10;
}

function areOffsetsEqual(
  current: Record<string, FloatLabelOffset>,
  next: Record<string, FloatLabelOffset>,
): boolean {
  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  if (currentKeys.length !== nextKeys.length) return false;
  for (const key of nextKeys) {
    const curr = current[key];
    const candidate = next[key];
    if (!curr || !candidate) return false;
    if (curr.dx !== candidate.dx || curr.dy !== candidate.dy) return false;
  }
  return true;
}

function solveFloatLabelOffsets(
  seeds: FloatLabelSeed[],
  measurements: Record<string, { width: number; height: number }>,
  containerWidth: number,
  containerHeight: number,
): Record<string, FloatLabelOffset> {
  if (seeds.length === 0 || containerWidth === 0 || containerHeight === 0) {
    return {};
  }

  const centerX = containerWidth / 2;
  const centerY = containerHeight / 2;
  const items = seeds
    .map((seed) => {
      const measurement = measurements[seed.key];
      const baseX = (seed.leftPct / 100) * containerWidth;
      const baseY = (seed.topPct / 100) * containerHeight;
      const radius = Math.max(48, Math.hypot(baseX - centerX, baseY - centerY));
      return {
        ...seed,
        baseX,
        baseY,
        radius,
        normalizedAngle: normalizeAngle(seed.angle),
        width: measurement?.width ?? 0,
        height: measurement?.height ?? 0,
      };
    });

  if (items.length === 1) {
    return {
      [items[0].key]: { dx: 0, dy: 0 },
    };
  }

  let breakAt = 0;
  let largestGap = -1;
  for (let i = 0; i < items.length; i++) {
    const current = items[i].normalizedAngle;
    const next = i === items.length - 1
      ? items[0].normalizedAngle + TAU
      : items[i + 1].normalizedAngle;
    const gap = next - current;
    if (gap > largestGap) {
      largestGap = gap;
      breakAt = (i + 1) % items.length;
    }
  }

  const rotated = [...items.slice(breakAt), ...items.slice(0, breakAt)].map((item, index, arr) => {
    let unwrappedAngle = item.normalizedAngle;
    if (index > 0) {
      while (unwrappedAngle < arr[index - 1].normalizedAngle) {
        unwrappedAngle += TAU;
      }
    }
    return {
      ...item,
      unwrappedAngle,
    };
  });

  for (let i = 1; i < rotated.length; i++) {
    while (rotated[i].unwrappedAngle < rotated[i - 1].unwrappedAngle) {
      rotated[i].unwrappedAngle += TAU;
    }
  }

  const separations = rotated.slice(0, -1).map((item, index) => {
    const next = rotated[index + 1];
    const radius = Math.max(48, (item.radius + next.radius) / 2);
    return ((item.width + next.width) / 2 + FLOAT_LABEL_GAP_PX) / radius;
  });

  const forward = new Array<number>(rotated.length);
  forward[0] = rotated[0].unwrappedAngle;
  for (let i = 1; i < rotated.length; i++) {
    forward[i] = Math.max(
      rotated[i].unwrappedAngle,
      forward[i - 1] + separations[i - 1],
    );
  }

  const backward = new Array<number>(rotated.length);
  backward[rotated.length - 1] = rotated[rotated.length - 1].unwrappedAngle;
  for (let i = rotated.length - 2; i >= 0; i--) {
    backward[i] = Math.min(
      rotated[i].unwrappedAngle,
      backward[i + 1] - separations[i],
    );
  }

  const offsets: Record<string, FloatLabelOffset> = {};
  for (let i = 0; i < rotated.length; i++) {
    const item = rotated[i];
    const placedAngle = (forward[i] + backward[i]) / 2;
    const angleDelta = placedAngle - item.unwrappedAngle;
    const tangentShift = angleDelta * item.radius;
    const prevGap = i > 0 ? item.unwrappedAngle - rotated[i - 1].unwrappedAngle : Number.POSITIVE_INFINITY;
    const nextGap = i < rotated.length - 1
      ? rotated[i + 1].unwrappedAngle - item.unwrappedAngle
      : Number.POSITIVE_INFINITY;
    const prevCrowd = i > 0 ? Math.max(0, separations[i - 1] - prevGap) * item.radius : 0;
    const nextCrowd = i < separations.length ? Math.max(0, separations[i] - nextGap) * item.radius : 0;
    const crowdPx = Math.max(prevCrowd, nextCrowd);
    const emphasis = Math.max(0, item.share - 0.34);
    const rawRadial = crowdPx > 0
      ? crowdPx * 0.24 + Math.abs(tangentShift) * 0.1 - emphasis * 7 - FLOAT_LABEL_CENTER_BIAS_PX
      : -FLOAT_LABEL_CENTER_BIAS_PX;
    const radialShift = Math.max(
      -FLOAT_LABEL_MAX_INSET_PX,
      Math.min(FLOAT_LABEL_MAX_OUTSET_PX, rawRadial),
    );
    const tangentX = -Math.sin(item.angle);
    const tangentY = Math.cos(item.angle);
    const radialX = Math.cos(item.angle);
    const radialY = Math.sin(item.angle);

    offsets[item.key] = {
      dx: roundOffset(tangentX * tangentShift + radialX * radialShift),
      dy: roundOffset(tangentY * tangentShift + radialY * radialShift),
    };
  }

  return offsets;
}

/**
 * Speaker breakdown — multi-segment dot ring where each speaker's
 * arc length is proportional to their dialogue share. Matches the
 * Apple-Watch reference's segmented-ring language exactly: each
 * tinted segment encodes one quantity (turns × speaker), and the
 * centre cell holds the focal numeric (total turns).
 *
 * Below the dial: a compact legend row per speaker — colour dot,
 * name, share %, raw turn count, optional role tag (from
 * highMode characterInfluence). Every visible token is data; no
 * decorative pips.
 */

export function CastWidget({ analysis }: { analysis: ChapterAnalysis }) {
  const { speakerCounts, highModeAnalysis } = analysis;
  if (speakerCounts.length === 0) return null;

  const totalTurns = speakerCounts.reduce((s, sp) => s + sp.turns, 0);
  if (totalTurns === 0) return null;

  const influence = highModeAnalysis?.characterInfluence ?? [];
  const bouquetRef = useRef<HTMLDivElement | null>(null);
  const labelRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const [labelOffsets, setLabelOffsets] = useState<Record<string, FloatLabelOffset>>({});
  const [layoutVersion, setLayoutVersion] = useState(0);

  const palette = useMemo(
    () => buildSpeakerPalette(speakerCounts.map((s) => s.name)),
    [speakerCounts],
  );

  const top = useMemo(() => speakerCounts.slice(0, TOP_N), [speakerCounts]);
  const remainderTurns = useMemo(
    () => speakerCounts.slice(TOP_N).reduce((sum, sp) => sum + sp.turns, 0),
    [speakerCounts],
  );

  const arcSegments = useMemo(() => {
    const segments: ArcSegment[] = [];
    let cursor = 0;
    for (let i = 0; i < top.length; i++) {
      const sp = top[i];
      const share = sp.turns / totalTurns;
      segments.push({
        from: cursor,
        to: cursor + share,
        color: getSpeakerColor(palette, sp.name).text,
      });
      cursor += share;
    }
    if (remainderTurns > 0) {
      segments.push({
        from: cursor,
        to: 1,
        color: "rgba(255, 255, 255, 0.32)",
      });
    }
    return segments;
  }, [palette, remainderTurns, top, totalTurns]);

  const rows = useMemo(
    () => top.map((sp) => {
      const ci = influence.find((c) => c.name.toLowerCase() === sp.name.toLowerCase());
      return { ...sp, ci };
    }),
    [influence, top],
  );

  const labelSeeds = useMemo<FloatLabelSeed[]>(() => top.map((sp, i) => {
    const seg = arcSegments[i];
    if (!seg) {
      return null;
    }
    const midFrac = (seg.from + seg.to) / 2;
    const angleDeg = -90 + midFrac * 360;
    const angle = (angleDeg * Math.PI) / 180;
    const orbitRadius = 84;
    const leftPct = 50 + (orbitRadius * Math.cos(angle)) / 2.6;
    const topPct = 50 + (orbitRadius * Math.sin(angle)) / 2.6;
    const share = sp.turns / totalTurns;
    const fontSize = 11 + Math.sqrt(share) * 11;
    const horizontal = Math.cos(angle);
    const side: FloatLabelSide = Math.abs(horizontal) < 0.28
      ? "center"
      : horizontal > 0
      ? "right"
      : "left";

    return {
      key: sp.name,
      angle,
      leftPct,
      topPct,
      share,
      fontSize,
      color: getSpeakerColor(palette, sp.name).text,
      side,
    };
  }).filter((seed): seed is FloatLabelSeed => seed !== null), [arcSegments, palette, top, totalTurns]);

  useLayoutEffect(() => {
    const bouquet = bouquetRef.current;
    if (!bouquet || typeof ResizeObserver === "undefined") return;

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setLayoutVersion((version) => version + 1);
      });
    });
    observer.observe(bouquet);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    if (labelSeeds.length === 0) {
      setLabelOffsets((current) => (Object.keys(current).length === 0 ? current : {}));
      return;
    }

    const bouquet = bouquetRef.current;
    if (!bouquet) return;

    const measurements: Record<string, { width: number; height: number }> = {};
    for (const seed of labelSeeds) {
      const node = labelRefs.current[seed.key];
      if (!node) return;
      measurements[seed.key] = {
        width: node.offsetWidth,
        height: node.offsetHeight,
      };
    }

    const nextOffsets = solveFloatLabelOffsets(
      labelSeeds,
      measurements,
      bouquet.clientWidth,
      bouquet.clientHeight,
    );

    setLabelOffsets((current) => (areOffsetsEqual(current, nextOffsets) ? current : nextOffsets));
  }, [labelSeeds, layoutVersion]);

  return (
    <WidgetCard
      bg="#0d1117"
      accent="#38bdf8"
      heroAlign="start"
      topLeft="CAST"
      topRight={`${speakerCounts.length} SPEAKERS`}
    >
      <div className="wg-content"
        style={{
          marginTop: "-20px"
        }}
      >
        {/* Dial + floating proportional name bouquet. The labels float
            around the ring at the angular midpoint of each speaker's
            segment, sized by their dialogue share (loudest = largest)
            — fills the empty corners without filler imagery. */}
        <div className="wg-cast-dial-bouquet" ref={bouquetRef}>
          <ArcRing
            size={138}
            thickness={9}
            startAngle={-90}
            sweep={360}
            segments={arcSegments}
            gap={10}
            rounded
          >
            <span className="wg-dial-num" style={{ color: "#fff" }}>
              {totalTurns}
            </span>
            <span className="wg-dial-unit" style={{ color: "rgba(255,255,255,0.6)" }}>
              turns
            </span>
          </ArcRing>
          {labelSeeds.map((seed, i) => {
            const offset = labelOffsets[seed.key] ?? { dx: 0, dy: 0 };
            const labelStyle = {
              left: `${seed.leftPct}%`,
              top: `${seed.topPct}%`,
              fontSize: `${seed.fontSize.toFixed(1)}px`,
              color: seed.color,
              animationDelay: `${i * 60}ms`,
              "--cast-label-dx": `${offset.dx}px`,
              "--cast-label-dy": `${offset.dy}px`,
            } as CSSProperties;
            return (
              <span
                key={seed.key}
                ref={(node) => {
                  labelRefs.current[seed.key] = node;
                }}
                className={`wg-cast-float-label wg-cast-float-label--${seed.side}`}
                style={labelStyle}
              >
                {seed.key}
              </span>
            );
          })}
        </div>

        <div className="wg-section">
          {rows.map((row) => {
            const dotColor = getSpeakerColor(palette, row.name).text;
            const sharePct = Math.round((row.turns / totalTurns) * 100);
            return (
              <div key={row.name} className="wg-cast-row-compact">
                <span className="wg-cast-dot" style={{ background: dotColor }} />
                <span className="wg-cast-name">{row.name}</span>
                {row.ci?.role && (
                  <span className={`wg-cast-role wg-cast-role--${row.ci.role}`}>
                    {row.ci.role}
                  </span>
                )}
                <span className="wg-cast-share">{sharePct}%</span>
                <span className="wg-cast-turns">{row.turns}t</span>
              </div>
            );
          })}
          {remainderTurns > 0 && (
            <div className="wg-cast-row-compact">
              <span
                className="wg-cast-dot"
                style={{ background: "rgba(255, 255, 255, 0.32)" }}
              />
              <span className="wg-cast-name" style={{ opacity: 0.6 }}>
                {speakerCounts.length - TOP_N} other{speakerCounts.length - TOP_N === 1 ? "" : "s"}
              </span>
              <span className="wg-cast-share">
                {Math.round((remainderTurns / totalTurns) * 100)}%
              </span>
              <span className="wg-cast-turns">{remainderTurns}t</span>
            </div>
          )}
        </div>
      </div>
    </WidgetCard>
  );
}
