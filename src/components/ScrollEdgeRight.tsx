import type { CSSProperties } from "react";

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
const STRIP_COUNT = 10;
const MAX_BLUR    = 14;
const EXP_BASE    = 1.4;
const OVERLAP     = -16;

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

export function ScrollEdgeRight() {
  return (
    <div className="scroll-edge-right" aria-hidden="true">
      <div style={{ display: "flex", flexDirection: "row-reverse", height: "100%" }}>
        {STRIPS.map((blur, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              backdropFilter: `blur(${blur}px)`,
              WebkitBackdropFilter: `blur(${blur}px)`,
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
