import type { IntelligenceLevel } from "./speech-detect";

/**
 * Heuristic prescan to pick an appropriate intelligence level from a chapter's
 * paragraphs. Lighter than 'fast' mode — pure pattern-counting, no detection
 * pipeline. Typically <1ms for chapters up to 400 paragraphs.
 *
 * Thresholds:
 *   dialogue density ≥ 0.50,  OR  (≥ 0.35 AND ≥ 4 speakers)  →  'high'
 *   dialogue density ≥ 0.20,  OR  ≥ 2 speakers                →  'default'
 *   otherwise                                                  →  'fast'
 */
export function lightweightPrescan(paragraphs: string[]): IntelligenceLevel {
  if (paragraphs.length === 0) return "default";

  const OPEN_QUOTE_RE = /["“‘]/;
  const SAID_RE =
    /(?:said|asked|replied|whispered|shouted|called|answered|cried|muttered|snapped|began)\s+([A-Z][a-z]{1,20})/g;

  let dialogueParas = 0;
  const speakerSet = new Set<string>();

  for (const para of paragraphs) {
    if (OPEN_QUOTE_RE.test(para)) dialogueParas++;
    SAID_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SAID_RE.exec(para)) !== null) speakerSet.add(m[1]);
  }

  const density = dialogueParas / paragraphs.length;
  const speakers = speakerSet.size;

  if (density >= 0.5 || (density >= 0.35 && speakers >= 4)) return "high";
  if (density >= 0.2 || speakers >= 2) return "default";
  return "fast";
}
