// ─── iOS system colour palette ─────────────────────────────────────────────
// `text` — readable mid-tone, calibrated DOWN from the raw iOS spec so it
//          doesn't read "too bright" against the editor's white surface while
//          still staying vivid enough on dark backgrounds.
// `bg`   — darker companion used as the solid fill behind the white para-icon
//          glyph (must keep AA contrast against white).

export interface ColorPair {
  text: string;
  bg: string;
}

export const IOS_PALETTE: ColorPair[] = [
  { text: "#D6363B", bg: "#A8262A" }, // Red
  { text: "#DC7B19", bg: "#A55700" }, // Orange
  { text: "#B68B00", bg: "#8C6A00" }, // Yellow
  { text: "#2EA84A", bg: "#1E7E36" }, // Green
  { text: "#00A696", bg: "#007A6E" }, // Mint
  { text: "#00A1AB", bg: "#007480" }, // Teal
  { text: "#009ABC", bg: "#00748E" }, // Cyan
  { text: "#1071D8", bg: "#0058AA" }, // Blue
  { text: "#4F45D8", bg: "#3D34A8" }, // Indigo
  { text: "#A828B8", bg: "#811B91" }, // Purple
];

export const IOS_COLORS = {
  red:    IOS_PALETTE[0],
  orange: IOS_PALETTE[1],
  yellow: IOS_PALETTE[2],
  green:  IOS_PALETTE[3],
  mint:   IOS_PALETTE[4],
  teal:   IOS_PALETTE[5],
  cyan:   IOS_PALETTE[6],
  blue:   IOS_PALETTE[7],
  indigo: IOS_PALETTE[8],
  purple: IOS_PALETTE[9],
} as const;

// ─── HSL helpers (overflow generation) ─────────────────────────────────────

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sN * Math.min(lN, 1 - lN);
  const f = (n: number) =>
    lN - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) =>
    Math.round(255 * x).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`.toUpperCase();
}

function hashName(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) & 0x7fffffff;
  return h;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Build a deterministic name → ColorPair map for an arbitrary list of names.
 *
 * Strategy:
 *   1. Sort names by hash for stable ordering across runs.
 *   2. The first N (= IOS_PALETTE.length) names get the iOS palette in order,
 *      so distinct entities always pull from the canonical palette first.
 *   3. Beyond N, generate fresh hues via golden-angle distribution (≈137.508°)
 *      — this gives maximally-spread, non-clashing colours indefinitely while
 *      keeping saturation / lightness aligned with the iOS aesthetic.
 *
 * Pure function — no caching, no external state. Cheap to call per render.
 */
export function buildSpeakerPalette(names: string[]): Map<string, ColorPair> {
  const map = new Map<string, ColorPair>();
  if (names.length === 0) return map;

  // Dedupe + sort by hash (stable across runs of the same name set)
  const unique = Array.from(new Set(names));
  const sorted = unique.sort((a, b) => hashName(a) - hashName(b));

  const GOLDEN_ANGLE = 137.508;
  // Offset so the first generated hue doesn't coincide exactly with a palette hue
  const HUE_OFFSET = 19;

  for (let i = 0; i < sorted.length; i++) {
    const name = sorted[i];
    if (i < IOS_PALETTE.length) {
      map.set(name, IOS_PALETTE[i]);
    } else {
      const overflowIdx = i - IOS_PALETTE.length;
      const hue = (overflowIdx * GOLDEN_ANGLE + HUE_OFFSET) % 360;
      map.set(name, {
        text: hslToHex(hue, 78, 50),
        bg:   hslToHex(hue, 70, 30),
      });
    }
  }
  return map;
}

/** Lookup a single name's colour pair, falling back to a neutral grey if
 *  the palette doesn't contain it. Use buildSpeakerPalette() once per
 *  render for the full set, then read from the map. */
export function getSpeakerColor(
  palette: Map<string, ColorPair>,
  name: string,
): ColorPair {
  return palette.get(name) ?? { text: "#888888", bg: "#555555" };
}
