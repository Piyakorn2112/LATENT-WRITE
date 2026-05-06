/**
 * Auto-scene-break inserter.
 *
 * Walks the chapter's existing paragraph stream and inserts `* * *`
 * scene-break markers at strong tension transitions, time-shift
 * discourse markers, and POV switches.
 *
 * Reuses the existing speech-detect output (already produced by
 * `useAnalysis` / `detectSpeechInChapter`) so the tool doesn't run
 * any new analysis pass — it just reads the per-paragraph metadata
 * the system already has and emits breaks at the natural seams.
 *
 * The boundary rules (in order, first match wins per gap):
 *   • Tension transition: previous paragraph ended `calm`, current
 *     paragraph is `high` (or vice versa) — a hard scene boundary.
 *   • Time-shift opener: paragraph begins with "Later,", "The next
 *     morning", "Hours later", etc. (same regex as auto-paragraph).
 *   • Speaker continuity break: the first speaker of the current
 *     paragraph is different from the last speaker of the previous,
 *     AND there's an intervening narration gap > 200 chars (signals a
 *     scene change rather than a normal turn-taking dialogue swap).
 *
 * Conservative on inserts — under-segment rather than fragment.
 */

import type { ChapterParaResult } from "./speech-detect";

const TIME_SHIFT_RE = /^\s*(?:later|then|afterwards?|that\s+(?:morning|afternoon|evening|night|day)|the\s+next\s+\w+|hours?\s+later|days?\s+later|weeks?\s+later|months?\s+later|years?\s+later|moments?\s+later|much\s+later|meanwhile|elsewhere|outside|inside|across\s+the\s+(?:room|street|hall|table|city)|down\s+(?:the\s+\w+)|when\s+(?:the\s+)?(?:morning|night|sun|moon|day|evening|dawn|dusk)|by\s+(?:the\s+time|nightfall|morning|noon|dawn|dusk))\b/i;

const SCENE_BREAK_LINE = "* * *";
const SCENE_BREAK_RE = /^[\s\*\-—#~=|]{3,}$/;

export interface SceneBreakResult {
  /** New chapter content with scene breaks inserted. */
  content: string;
  /** How many breaks were added. */
  inserted: number;
  /** Paragraph indices where the break landed (0-based, refers to the
   *  paragraph the break sits BEFORE in the new layout). */
  positions: number[];
}

function firstSpeaker(p: ChapterParaResult | undefined): string | undefined {
  if (!p) return undefined;
  const seg = p.segments.find((s) => s.type === "speech" && s.speaker);
  return seg?.speaker;
}

function lastSpeaker(p: ChapterParaResult | undefined): string | undefined {
  if (!p) return undefined;
  for (let i = p.segments.length - 1; i >= 0; i--) {
    const s = p.segments[i];
    if (s.type === "speech" && s.speaker) return s.speaker;
  }
  return undefined;
}

/**
 * Decide whether to insert a break BEFORE paragraph index `i`. Returns
 * true on the first matching rule.
 */
function shouldBreakBefore(
  i: number,
  paragraphs: string[],
  speech: ChapterParaResult[],
): boolean {
  if (i === 0) return false;
  const prev = paragraphs[i - 1];
  const curr = paragraphs[i];
  if (!prev || !curr) return false;

  // Skip if either side already IS a scene-break marker (don't double-up).
  if (SCENE_BREAK_RE.test(prev.trim())) return false;
  if (SCENE_BREAK_RE.test(curr.trim())) return false;

  const prevMeta = speech[i - 1]?.meta;
  const currMeta = speech[i]?.meta;

  // Rule 1: Hard tension flip (calm → high or high → calm with a
  // narration gap). Soft transitions (calm → rising, rising → high)
  // are part of the same scene and shouldn't break.
  if (prevMeta && currMeta) {
    const flip =
      (prevMeta.tension === "calm" && currMeta.tension === "high") ||
      (prevMeta.tension === "high" && currMeta.tension === "calm");
    if (flip) return true;
  }

  // Rule 2: Time-shift discourse opener.
  if (TIME_SHIFT_RE.test(curr.trim())) return true;

  // Rule 3: Speaker change with no continuity. If prev's last speaker
  // and curr's first speaker differ, AND prev has substantial trailing
  // narration (signalling the dialogue closed before the break), treat
  // as a scene swap. Pure turn-taking inside dialogue won't trigger
  // this — the prev paragraph would end on a quote, not narration.
  const prevLast = lastSpeaker(speech[i - 1]);
  const currFirst = firstSpeaker(speech[i]);
  if (prevLast && currFirst && prevLast !== currFirst) {
    const prevSegs = speech[i - 1]?.segments ?? [];
    const lastSeg = prevSegs[prevSegs.length - 1];
    const trailingNarrationChars =
      lastSeg && lastSeg.type === "narrative"
        ? lastSeg.end - lastSeg.start
        : 0;
    if (trailingNarrationChars > 200) return true;
  }

  return false;
}

export function autoSceneBreaks(
  content: string,
  paragraphs: string[],
  speech: ChapterParaResult[],
): SceneBreakResult {
  if (paragraphs.length < 3) return { content, inserted: 0, positions: [] };

  // Decide insertion points.
  const breakBefore: number[] = [];
  for (let i = 1; i < paragraphs.length; i++) {
    if (shouldBreakBefore(i, paragraphs, speech)) breakBefore.push(i);
  }

  if (breakBefore.length === 0) return { content, inserted: 0, positions: [] };

  // Reassemble the chapter content with `* * *` markers placed before
  // the chosen paragraphs. We work off the original content rather than
  // joining `paragraphs` because the user may have intentional blank
  // lines or formatting we shouldn't flatten.
  const breakSet = new Set(breakBefore);
  const out: string[] = [];
  let cursor = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const idx = content.indexOf(p, cursor);
    if (idx < 0) {
      // Paragraph not found verbatim — fall back to writing it directly.
      if (breakSet.has(i)) out.push("\n\n" + SCENE_BREAK_LINE + "\n\n");
      else if (i > 0) out.push("\n\n");
      out.push(p);
      continue;
    }
    if (i === 0) {
      // Preserve any preamble before the first paragraph.
      out.push(content.slice(0, idx + p.length));
    } else {
      const between = content.slice(cursor, idx);
      if (breakSet.has(i)) {
        // Replace the inter-paragraph whitespace with a clean break.
        out.push("\n\n" + SCENE_BREAK_LINE + "\n\n" + p);
      } else {
        out.push(between + p);
      }
    }
    cursor = idx + p.length;
  }
  // Trailing content (after the last paragraph).
  if (cursor < content.length) out.push(content.slice(cursor));

  return {
    content: out.join(""),
    inserted: breakBefore.length,
    positions: breakBefore,
  };
}
