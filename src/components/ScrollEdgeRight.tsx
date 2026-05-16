import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";

// Mirrors ScrollEdgeTop, but rotated 90°: vertical strips stacked
// horizontally so blur fades smoothly from right (max) → left (zero)
// across the full window height. Sits underneath the analysis panel —
// when the panel is open it just deepens the panel's own blur; when
// the panel is closed it provides a soft right-edge fog into which
// the panel docks. Either state reads as crafted, never abrupt.

// Tuned for a ~600 px-wide right-edge fog:
//   • MAX_BLUR raised to 14 so the right-most slice reads as a definite
//     frosted band, even with light editor backgrounds where contrast
//     for blur is sparse.
//   • EXP_BASE relaxed from 2 → 1.4 so the falloff is more gradual —
//     the blur stays meaningful through the middle strips instead of
//     collapsing to ~0 by strip 4. This is what "extend the effect
//     further in" reads as visually: a longer travel distance for the
//     blur to fade out across.
const STRIP_COUNT = 3;
const MAX_BLUR    = 3;
const EXP_BASE    = 1.4;
const OVERLAP     = -220;
// Lower = cheaper live backdrop sampling, but softer / more diffuse blur.
// Keep this below 1 to downsample the filter's internal raster without
// freezing the backdrop behind the edge. User-tunable.
const FILTER_RESOLUTION_SCALE = 0.2;
const FILTER_RESOLUTION_MIN   = 80;
const FILTER_RESOLUTION_MAX   = 600;

// Mask each (non-rightmost) strip so it fades in on its right edge
// (where it overlaps the strip with stronger blur) and fades out on
// its left edge (where the next strip continues). The result is one
// continuous blur gradient instead of visible strip seams.
const STRIP_MASK =
  "linear-gradient(to left, transparent 0%, black 20%, black 80%, transparent 100%)";

// blur(i) = MAX_BLUR × ((STRIP_COUNT - i) / STRIP_COUNT) ^ EXP_BASE
// Strip 0 (rightmost, anchored edge) gets MAX_BLUR; last strip ~0.
const STRIPS: number[] = Array.from({ length: STRIP_COUNT }, (_, i) =>
  +(MAX_BLUR * ((STRIP_COUNT - i) / STRIP_COUNT) ** EXP_BASE).toFixed(2),
);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function ScrollEdgeRight() {
  const rootRef = useRef<HTMLDivElement>(null);
  const rawId = useId();
  const idPrefix = useMemo(
    () => `scroll-edge-right-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [rawId],
  );
  const [filterRes, setFilterRes] = useState({ x: 160, y: 320 });

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const update = () => {
      const rect = el.getBoundingClientRect();
      const stripWidth = rect.width / STRIP_COUNT;
      const next = {
        x: clamp(Math.round(stripWidth * FILTER_RESOLUTION_SCALE), FILTER_RESOLUTION_MIN, FILTER_RESOLUTION_MAX),
        y: clamp(Math.round(rect.height * FILTER_RESOLUTION_SCALE), FILTER_RESOLUTION_MIN, FILTER_RESOLUTION_MAX),
      };
      setFilterRes((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const stripFilters = useMemo(
    () => STRIPS.map((blur, i) => ({ blur, id: `${idPrefix}-${i}` })),
    [idPrefix],
  );

  return (
    <div ref={rootRef} className="scroll-edge-right" aria-hidden="true">
      <svg
        width="0"
        height="0"
        aria-hidden="true"
        focusable="false"
        style={{ position: "absolute", pointerEvents: "none", overflow: "hidden" }}
      >
        <defs>
          {stripFilters.map(({ blur, id }) => (
            <filter
              key={id}
              id={id}
              x="-20%"
              y="-12%"
              width="140%"
              height="124%"
              filterUnits="objectBoundingBox"
              colorInterpolationFilters="sRGB"
              filterRes={`${filterRes.x} ${filterRes.y}`}
            >
              <feGaussianBlur in="SourceGraphic" stdDeviation={blur} edgeMode="duplicate" />
            </filter>
          ))}
        </defs>
      </svg>
      <div style={{ display: "flex", flexDirection: "row-reverse", height: "100%" }}>
        {stripFilters.map(({ id }, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              // Live backdrop blur, but rasterized through a lower-resolution
              // SVG filter so scroll keeps moving behind the edge instead of
              // freezing to a cached snapshot.
              backdropFilter: `url(#${id})`,
              WebkitBackdropFilter: `url(#${id})`,
              ...(i > 0 && {
                marginRight: `${OVERLAP}px`,
                WebkitMaskImage: STRIP_MASK,
                maskImage: STRIP_MASK,
              }),
            } as CSSProperties}
          />
        ))}
      </div>
    </div>
  );
}
