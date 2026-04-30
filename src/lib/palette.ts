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

function hashName(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) & 0x7fffffff;
  return h;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Build a deterministic name → ColorPair map.
 *
 * Each name's colour is derived SOLELY from its own hash — adding or removing
 * names from the list never changes the colour of any other name. This is
 * crucial for editing: when a new entity gets detected mid-chapter, the
 * existing speakers' dialogue colours stay rock-stable instead of all shifting
 * one slot over.
 *
 * Two names can collide (hash to the same colour) — that's an acceptable
 * trade-off for absolute stability. Collisions are rare for short cast lists,
 * and the overflow HSL fallback adds 360 distinct hues.
 *
 * Pure function — no caching, no external state.
 */
export function buildSpeakerPalette(names: string[]): Map<string, ColorPair> {
  const map = new Map<string, ColorPair>();
  if (names.length === 0) return map;

  // Each name maps INDEPENDENTLY to a colour from its own hash. No probing,
  // no neighbour-aware allocation — adding/removing other names cannot
  // possibly change this name's colour. Two names can hash to the same
  // colour; that is an acceptable trade-off for absolute stability and is
  // visually disambiguated by the name itself appearing in the text.
  for (const name of new Set(names)) {
    const idx = hashName(name) % IOS_PALETTE.length;
    map.set(name, IOS_PALETTE[idx]);
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
