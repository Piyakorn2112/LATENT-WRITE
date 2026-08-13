/**
 * think-guides.ts — competing think-stage system prompts for the custom
 * rewrite A/B (plans/askrw-speed-quality-2026-08.md, hard-custom round).
 *
 * The think pass is free prose stopped at </think>; these prompts steer HOW
 * it reasons. GUIDED implements the best-evidenced structure from the
 * research sweep (instruction decomposition → affected vs preserved → edit
 * plan); FREE keeps only the drift guards. The main call's own system
 * prompt is unchanged either way — the notes ride the user turn.
 */

/**
 * (A) GUIDED CHECKLIST — the evidence-backed structure: decompose the
 * instruction into PARTS, bind each to SPANS, name concrete PRESERVE
 * items, land a word-level PLAN. Rationale: free reasoning measurably
 * drops simple sub-constraints while handling complex ones ("When
 * Thinking Fails", NeurIPS 2025); structural templates hold accuracy at a
 * fraction of the tokens (Sketch-of-Thought, Chain-of-Draft), which is
 * what makes a 256-320 budget land conclusions instead of truncating
 * mid-walk; vague preserve clauses leak register while explicit named
 * markers roughly halve drift ("Voice Under Revision").
 */
export const GUIDED_WRITING_THINK = `Plan the edit; do not write an essay, do not restate the instruction, do
not summarize the passage, do not give general writing advice.
PARTS: split the instruction into its separate demands, one per line.
  "Do X, keep Y, end on Z" is three parts, not one gist.
SPANS: for each part, name the exact sentence(s) or image(s) in the
  passage it acts on.
PRESERVE: for each part, name one concrete thing that stays untouched —
  a specific phrase, word, or order. Never just "the voice" or "the tone."
PLAN: one line per part naming the actual word, clause, or line that
  changes and what it becomes. No mood labels like "colder"; name the
  words that do it.
Stop after PLAN. Do not score, re-check, or hedge; a separate check runs
after you.`;

/** (B) FREE with drift guards only — the fallback if (A)'s labels get
 *  echoed back as boilerplate. */
export const FREE_WRITING_THINK = `Think through this edit briefly, in your own words. Not an essay, and do
not restate the instruction or describe the passage's themes.
If the instruction has more than one part, notice each part separately;
do not collapse it into a single vibe.
Notice exactly which words, sentences, or images in the passage the edit
touches. Name at least one specific thing that must NOT change — an exact
phrase, word, or order. "Keep the tone" alone tends to leak.
Land on the actual words or lines you would change, not a mood label like
"make it colder."
Do not grade or second-guess your own read. One pass is enough; a checker
runs after this. A finished short thought beats a half-finished long one.`;
