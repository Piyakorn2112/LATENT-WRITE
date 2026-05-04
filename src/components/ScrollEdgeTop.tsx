import type { CSSProperties } from "react";

// Each strip is its own backdrop-filter compositor layer. In Electron's
// Chromium the GPU cost stacks linearly, so we use far fewer strips than the
// novel reader (which runs in Safari with a more forgiving compositor).
const STRIP_COUNT = 9;
const MAX_BLUR    = 2;
const EXP_BASE    = 2;
const OVERLAP     = -16;

const STRIP_MASK =
  "linear-gradient(to bottom, transparent 0%, black 20%, black 80%, transparent 100%)";

// blur(i) = MAX_BLUR × ((STRIP_COUNT - i) / STRIP_COUNT) ^ EXP_BASE
// Strip 0 (top, anchored edge) gets MAX_BLUR; last strip → ~0.
const STRIPS: number[] = Array.from({ length: STRIP_COUNT }, (_, i) =>
  +(MAX_BLUR * ((STRIP_COUNT - i) / STRIP_COUNT) ** EXP_BASE).toFixed(2),
);

export function ScrollEdgeTop() {
  return (
    <div className="scroll-edge-top" aria-hidden="true">
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        {STRIPS.map((blur, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              backdropFilter: `blur(${blur}px)`,
              WebkitBackdropFilter: `blur(${blur}px)`,
              ...(i > 0 && {
                marginTop: `${OVERLAP}px`,
                WebkitMaskImage: STRIP_MASK,
                maskImage: STRIP_MASK,
              }),
            } as CSSProperties}
          />
        ))}
      </div>

      {/* Gradient overlay anchors the opaque bg-color at the very top so the
          transition reads as page-background → blur → transparent */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background:
            "linear-gradient(to bottom, var(--bg-scroll-edge) 0%, var(--bg-scroll-edge) 15%, transparent 95%)",
          opacity: 0.85,
        }}
      />
    </div>
  );
}
