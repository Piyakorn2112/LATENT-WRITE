/**
 * Auto-scene-break inserter — corroboration-based, high-precision.
 *
 * Inserts `* * *` markers ONLY at genuine scene discontinuities. The previous
 * implementation fired on any single weak signal — most damagingly a tension
 * flip (calm↔high), which shatters every tense scene, and a bare "Then…"/
 * "Later…" opener, which fragments within-scene time skips.
 *
 * This version requires CORROBORATION. A break needs an EXPLICIT discourse cue
 *   • time-major  — opening sentence states a real time jump ("The next
 *                   morning", "Three days later"); or
 *   • place-shift — opening clause relocates ("across the city", "meanwhile")
 * AND at least one corroborator:
 *   • the other discourse cue (time AND place together), or
 *   • pov-shift     — narrative viewpoint pronoun flips (he↔she↔they), or
 *   • tension reset — the chapter tension scanner reports a 2-level jump
 *                     (high↔calm) across the boundary, or
 *   • scene start   — the scanner's own `groupIntoScenes` marked a scene here.
 *
 * The explicit-cue gate is the high-precision guarantee: tension and POV
 * fluctuate within every scene, so they can corroborate but never trigger
 * alone. The old code fired on a lone tension flip (shattering tense scenes)
 * or a bare "Then…"/"Later…" opener — both are now impossible.
 *
 * Reuses the speech-detect output already produced for the chapter (for the
 * dialogue-density guard) and the shared `prose-segments` primitives; it runs
 * no new analysis pass and touches no other system.
 */

import type { ChapterParaResult } from "./speech-detect";
import { openerSignals, stripQuotes, isSceneBreakLine } from "./prose-segments";

const SCENE_BREAK_LINE = "* * *";

/** Minimum paragraphs between two breaks (and after an existing one). Scenes
 *  are not one paragraph long; this keeps inserts from clustering. */
const MIN_PARAS_BETWEEN_BREAKS = 2;

/** A paragraph this dialogue-dominated is a spoken line, not a scene opening. */
const DIALOGUE_PARA_THRESHOLD = 0.6;

export interface SceneBreakResult {
  /** New chapter content with scene breaks inserted. */
  content: string;
  /** How many breaks were added. */
  inserted: number;
  /** Paragraph indices the break was placed BEFORE (0-based, original layout). */
  positions: number[];
}

type Focus = "he" | "she" | "they" | undefined;

/**
 * The dominant narrative viewpoint of a paragraph, from its NARRATION (quotes
 * stripped so dialogue pronouns don't count). Counts subject/object/possessive
 * forms; returns a focus only when there's a clear winner.
 */
function narrationFocus(text: string): Focus {
  const narr = stripQuotes(text);
  let he = 0;
  let she = 0;
  let they = 0;
  const re = /\b(he|him|his|she|her|hers|they|them|their|theirs)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(narr)) !== null) {
    const w = m[1].toLowerCase();
    if (w === "he" || w === "him" || w === "his") he++;
    else if (w === "she" || w === "her" || w === "hers") she++;
    else they++;
  }
  const max = Math.max(he, she, they);
  if (max === 0) return undefined;
  if (he === max && she < max && they < max) return "he";
  if (she === max && he < max && they < max) return "she";
  if (they === max && he < max && she < max) return "they";
  return undefined; // tie → no confident focus
}

/**
 * Decide the scene-break insertion points (paragraph indices a break sits
 * before). Pure function over the inputs; the reassembly is separate so the
 * decision logic stays testable in isolation.
 */
const tLevel = (t: "calm" | "rising" | "high"): number => (t === "high" ? 2 : t === "rising" ? 1 : 0);

function decideBreaks(paragraphs: string[], speech: ChapterParaResult[]): number[] {
  const focus = paragraphs.map(narrationFocus);
  const breaks: number[] = [];
  let lastAnchor = -MIN_PARAS_BETWEEN_BREAKS; // start so the first break is allowed

  for (let i = 1; i < paragraphs.length; i++) {
    // Existing scene breaks are anchors: never double up, and keep distance.
    if (isSceneBreakLine(paragraphs[i])) {
      lastAnchor = i;
      continue;
    }
    if (isSceneBreakLine(paragraphs[i - 1])) continue;
    if (i - lastAnchor < MIN_PARAS_BETWEEN_BREAKS) continue;

    // A scene opening is establishing narration, not a raw spoken line.
    if ((speech[i]?.meta.dialogueDensity ?? 0) > DIALOGUE_PARA_THRESHOLD) continue;

    // A scene cut requires an EXPLICIT discourse cue (time jump or relocation).
    // This is the high-precision gate that keeps tension/POV — which fluctuate
    // within every scene — from ever firing on their own.
    const sig = openerSignals(paragraphs[i]);
    const strongCue = sig.timeMajor || sig.placeShift;
    if (!strongCue) continue;

    // Corroborators from the chapter tension scanner + viewpoint tracking.
    const bothCues = sig.timeMajor && sig.placeShift;
    const povShift = focus[i - 1] !== undefined && focus[i] !== undefined && focus[i - 1] !== focus[i];
    const tensionReset =
      Math.abs(tLevel(speech[i - 1]?.meta.tension ?? "calm") - tLevel(speech[i]?.meta.tension ?? "calm")) >= 2;
    const engineSceneStart = speech[i]?.meta.sceneStart === true;

    if (bothCues || povShift || tensionReset || engineSceneStart) {
      breaks.push(i);
      lastAnchor = i;
    }
  }
  return breaks;
}

export function autoSceneBreaks(
  content: string,
  paragraphs: string[],
  speech: ChapterParaResult[],
): SceneBreakResult {
  if (paragraphs.length < 3) return { content, inserted: 0, positions: [] };

  const breakBefore = decideBreaks(paragraphs, speech);
  if (breakBefore.length === 0) return { content, inserted: 0, positions: [] };

  // Reassemble: place `* * *` before the chosen paragraphs, working off the
  // original content so intentional whitespace/formatting is preserved.
  const breakSet = new Set(breakBefore);
  const out: string[] = [];
  let cursor = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const idx = content.indexOf(p, cursor);
    if (idx < 0) {
      if (breakSet.has(i)) out.push("\n\n" + SCENE_BREAK_LINE + "\n\n");
      else if (i > 0) out.push("\n\n");
      out.push(p);
      continue;
    }
    if (i === 0) {
      out.push(content.slice(0, idx + p.length));
    } else if (breakSet.has(i)) {
      out.push("\n\n" + SCENE_BREAK_LINE + "\n\n" + p);
    } else {
      out.push(content.slice(cursor, idx) + p);
    }
    cursor = idx + p.length;
  }
  if (cursor < content.length) out.push(content.slice(cursor));

  return { content: out.join(""), inserted: breakBefore.length, positions: breakBefore };
}
