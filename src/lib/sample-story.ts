import sampleRaw from "../assets/sample-story.txt?raw";
import { parseNovel } from "./parser";
import type { Novel } from "../types";

/**
 * The sample story is a sandbox, not a document: it exists in memory only,
 * every persistence path is suppressed while it is open (see sampleModeActive
 * in storage.ts and the guarded effects in App.tsx), and reopening it always
 * re-parses the shipped text. That is the Obsidian-sandbox contract the
 * onboarding advertises — safe to break, resets on reopen — and it is also
 * the data-safety guarantee: sample prose can never reach a real project's
 * novel.txt or the localStorage draft, because nothing in sample mode writes.
 *
 * The text itself is purpose-built for the surfaces the first session should
 * light up: seven characters and five places already confirmed in its
 * WORLD-DATA block (castReviewed: true — the scan dialog must never
 * interrogate a writer about a book they didn't write), dialogue density for
 * the speech marks, tension shaped low / rise / simmer / peak across the four
 * chapters, and four planted moments that double as story texture:
 *
 *   - Rees's eyes are pale green in Chapter 2 and dark brown in Chapter 3
 *   - the Lantern Bridge of Chapter 1 is called the Lamplight Bridge in 3
 *   - "three days on his feet" against "two nights ago" in the same scene
 *   - one ledger sentence misspelled for Proofread ("percision… would of")
 */
export const SAMPLE_STORY_TITLE = "The Ferrier Light";

/** Anchors for teaching moments — verbatim substrings of the shipped text,
 *  used to locate the planted spots in the live chapter content. If an edit
 *  removed one, the spot is simply gone (indexOf < 0), never stale. */
export const SAMPLE_SPOTS = {
  eyesContradiction: "dark brown, the colour of kelp",
  proofreadTypo: "percision that would of shamed",
  renamedBridge: "The Lamplight Bridge",
} as const;

/** A fresh parse every call: chapter ids are newly minted, so a reset can
 *  never collide with analysis state left by the previous visit. */
export function buildSampleNovel(): Novel {
  return parseNovel(sampleRaw);
}

/** True when the open novel is the (possibly edited) sample. Title check is
 *  enough — sample mode is also tracked as explicit state in App; this is
 *  for display copy only, never for the persistence guard. */
export function looksLikeSample(novel: Novel): boolean {
  return novel.meta.title === SAMPLE_STORY_TITLE;
}
