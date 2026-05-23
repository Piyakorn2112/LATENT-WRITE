import type { CSSProperties } from "react";

const STRIP_COUNT = 3;
const MAX_BLUR    = 3;
const EXP_BASE    = 1.4;
const OVERLAP     = -220;

const STRIP_MASK =
  "linear-gradient(to left, transparent 0%, black 20%, black 80%, transparent 100%)";

const STRIPS: number[] = Array.from({ length: STRIP_COUNT }, (_, i) =>
  +(MAX_BLUR * ((STRIP_COUNT - i) / STRIP_COUNT) ** EXP_BASE).toFixed(2),
);

export function ScrollEdgeRight() {
  return (
    <div className="scroll-edge-right" aria-hidden="true">
      <div className="scroll-edge-right-strips" style={{ display: "flex", flexDirection: "row-reverse", height: "100%" }}>
        {STRIPS.map((blur, i) => (
          <div
            key={i}
            className="scroll-edge-right-strip"
            style={{
              flex: 1,
              "--ser-blur": `${blur}px`,
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
