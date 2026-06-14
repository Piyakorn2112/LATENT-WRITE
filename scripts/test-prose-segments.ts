/**
 * test-prose-segments.ts
 *
 * TDD accuracy for the shared prose-segmentation primitives in
 * src/lib/prose-segments.ts (sentence tokenizer, quote analyzer, marker
 * taxonomy). These primitives back auto-paragraph.ts and auto-scene-break.ts.
 *
 * Run:  npx tsx scripts/test-prose-segments.ts
 * Gate: ≥95% — primitives are foundational; correctness must be near-total.
 */

import { splitSentences, analyzeQuotes, classifyOpener, stripQuotes, isSceneBreakLine } from "../src/lib/prose-segments";

let passed = 0,
  failed = 0;
function expect(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? " — " + detail : ""}`);
  }
}
function sents(text: string): string[] {
  return splitSentences(text).map((s) => s.text);
}
function eqArr(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ─── Tokenizer ─────────────────────────────────────────────────────────────

console.log("\n══ Sentence tokenizer ══");

{
  const got = sents("She left. He stayed.");
  expect("plain two sentences", eqArr(got, ["She left.", "He stayed."]), JSON.stringify(got));
}
{
  const got = sents("Dr. Finch arrived. He nodded once.");
  expect("title 'Dr.' does not split", eqArr(got, ["Dr. Finch arrived.", "He nodded once."]), JSON.stringify(got));
}
{
  const got = sents("Mrs. Vale greeted Mr. Poole warmly.");
  expect("two titles, one sentence", eqArr(got, ["Mrs. Vale greeted Mr. Poole warmly."]), JSON.stringify(got));
}
{
  const got = sents("J. R. R. Tolkien wrote it.");
  expect("initials stay together", eqArr(got, ["J. R. R. Tolkien wrote it."]), JSON.stringify(got));
}
{
  const got = sents("It cost 3.14 dollars exactly.");
  expect("decimal does not split", eqArr(got, ["It cost 3.14 dollars exactly."]), JSON.stringify(got));
}
{
  const got = sents("She moved to the U.S. last spring.");
  expect("acronym U.S. + lowercase continuation", eqArr(got, ["She moved to the U.S. last spring."]), JSON.stringify(got));
}
{
  const got = sents("Run! Why? Because.");
  expect("! and ? split", eqArr(got, ["Run!", "Why?", "Because."]), JSON.stringify(got));
}
{
  // Terminal inside quote + lowercase attribution → ONE sentence.
  const got = sents('"Stop!" she cried.');
  expect("dialogue + lowercase attribution stays one sentence", eqArr(got, ['"Stop!" she cried.']), JSON.stringify(got));
}
{
  // Terminal inside quote + capital action beat → TWO sentences.
  const got = sents('"Stop!" She ran for the door.');
  expect("dialogue + capital beat splits", eqArr(got, ['"Stop!"', "She ran for the door."]), JSON.stringify(got));
}
{
  const got = sents("She paused... then walked away.");
  expect("ellipsis + lowercase = one sentence", eqArr(got, ["She paused... then walked away."]), JSON.stringify(got));
}
{
  const got = sents("e.g. this is fine.");
  expect("'e.g.' does not split", eqArr(got, ["e.g. this is fine."]), JSON.stringify(got));
}
{
  const got = sents("I saw Mr. Poole today. He waved.");
  expect("title mid-text + real boundary", eqArr(got, ["I saw Mr. Poole today.", "He waved."]), JSON.stringify(got));
}
{
  // offset check: second sentence start maps into source
  const src = "Alpha. Beta.";
  const ss = splitSentences(src);
  expect("offsets map to source", ss.length === 2 && src.slice(ss[1].start, ss[1].end) === "Beta.", JSON.stringify(ss));
}

// ─── Quote / dialogue analyzer ───────────────────────────────────────────

console.log("\n══ Quote analyzer (apostrophe-safe) ══");

{
  // THE regression: apostrophes must not corrupt the in-quote ratio.
  const q = analyzeQuotes('"That\'s not an answer."');
  expect("contraction inside quote → still mostly-quote", q.isMostlyQuote, `ratio=${q.inQuoteRatio.toFixed(2)}`);
  expect("contraction inside quote → hasQuote", q.hasQuote);
}
{
  const q = analyzeQuotes("She didn't know what it's about anymore.");
  expect("contractions, no real quote → hasQuote false", !q.hasQuote, `ratio=${q.inQuoteRatio.toFixed(2)}`);
  expect("contractions, no real quote → not mostly-quote", !q.isMostlyQuote);
}
{
  const q = analyzeQuotes("The dogs' bowls were empty by noon.");
  expect("possessive apostrophe → hasQuote false", !q.hasQuote);
}
{
  const q = analyzeQuotes("The rain fell all night without pause.");
  expect("pure narration → hasQuote false", !q.hasQuote);
  expect("pure narration → not mostly-quote", !q.isMostlyQuote);
}
{
  const q = analyzeQuotes('"Run," he said.');
  expect("tagged dialogue → hasQuote", q.hasQuote);
  expect("tagged dialogue → startsWithOpenQuote", q.startsWithOpenQuote);
}
{
  const q = analyzeQuotes('"Get out of here now."');
  expect("pure quote line → mostly-quote", q.isMostlyQuote, `ratio=${q.inQuoteRatio.toFixed(2)}`);
  expect("pure quote line → endsWithCloseQuote", q.endsWithCloseQuote);
}
{
  const q = analyzeQuotes("He said it was over.");
  expect("narration → not startsWithOpenQuote", !q.startsWithOpenQuote);
}
{
  const q = analyzeQuotes("“What now?” she asked.");
  expect("curly double quotes → hasQuote", q.hasQuote);
}
{
  const q = analyzeQuotes("«Bonjour,» il a dit.");
  expect("guillemets → hasQuote", q.hasQuote);
}
{
  const q = analyzeQuotes("‘Hello,’ she said softly.");
  expect("british single quotes → hasQuote", q.hasQuote);
}

// ─── Discourse-marker taxonomy ───────────────────────────────────────────

console.log("\n══ Opener classification ══");

const markerCases: [string, ReturnType<typeof classifyOpener>][] = [
  ["The next morning, the spores had spread.", "time-major"],
  ["Three days later, she returned.", "time-major"],
  ["Years passed before he spoke of it.", "time-major"],
  ["That evening, the lamps were lit.", "time-major"],
  ["By nightfall they had gone.", "time-major"],
  ["Then footsteps sounded on the stair.", "time-minor"],
  ["A moment later she looked up.", "time-minor"],
  ["Soon the rain began.", "time-minor"],
  ["Meanwhile, across the harbour, Vale waited.", "place-shift"],
  ["Across the city a bell rang.", "place-shift"],
  ["Back at the house, nothing had changed.", "place-shift"],
  ["Suddenly the floor gave way.", "abrupt"],
  ["Without warning the lights died.", "abrupt"],
  ["She walked to the window and looked out.", null],
  ["He had never seen anything like it.", null],
];
for (const [text, want] of markerCases) {
  const got = classifyOpener(text);
  expect(`"${text.slice(0, 32)}…" → ${want}`, got === want, `got=${got}`);
}

// ─── stripQuotes + scene-break ───────────────────────────────────────────

console.log("\n══ stripQuotes / scene-break ══");

{
  const narr = stripQuotes('"I\'ll go," she said.').replace(/\s+/g, " ").trim();
  expect("stripQuotes leaves attribution, drops quote-internal 'I'", narr === "she said.", `got="${narr}"`);
}
{
  const narr = stripQuotes("Aldous didn't move.").replace(/\s+/g, " ").trim();
  expect("stripQuotes keeps contraction-only narration", narr === "Aldous didn't move.", `got="${narr}"`);
}
{
  expect("'* * *' is a scene break", isSceneBreakLine("* * *"));
  expect("'---' is a scene break", isSceneBreakLine("---"));
  expect("prose is not a scene break", !isSceneBreakLine("She left."));
}

// ─── Summary ─────────────────────────────────────────────────────────────

const total = passed + failed;
const pct = total ? Math.round((passed / total) * 100) : 100;
console.log(`\n${"=".repeat(60)}`);
console.log(`prose-segments accuracy: ${passed}/${total} (${pct}%)`);
console.log(`Target: ≥95% (foundational primitives)`);
console.log("=".repeat(60));
if (failed > 0 || pct < 95) {
  console.log("Below target.\n");
  process.exit(1);
} else {
  console.log("All assertions passed.\n");
}
