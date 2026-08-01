/**
 * test-label-quality.ts — direct cases for the label rules the corpus suite can
 * only see as rates, plus the one rule it cannot see at all.
 *
 * The corpus fixtures carry NO worldData, so the place-agent rejection —
 * "Green Gables builds" shipping as a 77% action chip because a place resolves
 * through the same path as a character — never fires there. This suite injects
 * the world data the app would have after an entity scan and asserts the chip
 * dies, using the REAL anne ch.1 text where the defect actually shipped.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-label-quality.ts
 */

import { buildLabel, labelDefect, detectNarrativeEvents, selectTimelineChips } from "../src/lib/narrative-events";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { resolveKnownNames } from "../src/lib/world-data";
import { loadBook, splitParagraphs } from "./print-chapter";

let failed = 0;
const ok = (label: string, cond: boolean, detail?: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failed++;
};

// ─── labelDefect: every class that has actually shipped ──────────────────────
console.log("labelDefect — defects that shipped, each must be caught:");
const BAD: [string, string][] = [
  ["Rachel demands What", "question shell as object"],
  ["Marilla asks How", "question shell as object"],
  ["Marilla commits I'm", "whole contraction as object"],
  ["Rachel tells don't", "whole contraction as object"],
  ["She pushes sash--it", "dash splice"],
  ["Bohemian confesses mine", "bare possessive object"],
  ["Fuchs tells ours", "bare possessive object"],
  ["Jake tells Once", "stranded adverb object"],
  ["Old man becomes somewhat", "stranded adverb object"],
  ["Fuchs remembers exactly how", "adverb + question shell"],
  ["Marilla accuses ll", "contraction remnant"],
  ["Marilla insists Marilla", "restated agent"],
];
for (const [label, why] of BAD) ok(`${JSON.stringify(label)} (${why})`, labelDefect(label) !== null);

console.log("\nlabelDefect — good labels, none may be flagged:");
const GOOD = [
  "Rachel presses Marilla",
  "Matthew tells Jerry Buote",
  "Robert kisses them",        // personal pronoun object is grammatical
  "Anne loses",                // objectless but not broken
  "Marilla accuses",
  "Matthew leaves Bright River",
  "Grandmother strikes Ambrosch",
];
for (const label of GOOD) ok(JSON.stringify(label), labelDefect(label) === null, labelDefect(label) ?? "");

// ─── buildLabel: the addressee fallback and its grammar ──────────────────────
console.log("\nbuildLabel — addressee fallback:");
ok('junk object + addressee -> "Rachel presses Marilla"',
  buildLabel("Rachel", "demands", "What", "Marilla") === "Rachel presses Marilla",
  buildLabel("Rachel", "demands", "What", "Marilla"));
ok('contraction object + addressee -> "Marilla insists to Rachel"',
  buildLabel("Marilla", "insists", "I'm", "Rachel") === "Marilla insists to Rachel",
  buildLabel("Marilla", "insists", "I'm", "Rachel"));
ok('anonymous pronoun object upgrades -> "Bohemian tells Antonia"',
  buildLabel("Bohemian", "tells", "him", "Antonia") === "Bohemian tells Antonia",
  buildLabel("Bohemian", "tells", "him", "Antonia"));
ok('junk object, NO addressee -> object dropped, "Marilla insists"',
  buildLabel("Marilla", "insists", "I'm") === "Marilla insists",
  buildLabel("Marilla", "insists", "I'm"));
ok("unmapped verb declines the fallback (no broken grammar)",
  buildLabel("Anne", "loses", null, "Marilla") === "Anne loses",
  buildLabel("Anne", "loses", null, "Marilla"));
ok("addressee equal to the agent is refused",
  buildLabel("Rachel", "demands", null, "Rachel") === "Rachel demands",
  buildLabel("Rachel", "demands", null, "Rachel"));
ok("a real object is never displaced by the addressee",
  buildLabel("Matthew", "tells", "Jerry Buote", "Marilla") === "Matthew tells Jerry Buote",
  buildLabel("Matthew", "tells", "Jerry Buote", "Marilla"));

// ─── Place-agent rejection, on the real text where it shipped ────────────────
async function main() {
  console.log("\nplace-agent rejection — anne ch.1, world data injected:");
  const novel = await loadBook("anne");
  const chapter = novel.chapters[0];
  const paragraphs = splitParagraphs(chapter.content);
  const knownNames = resolveKnownNames(novel);
  const speech = detectSpeechInChapter(paragraphs, knownNames, { intelligenceLevel: "default" });

  const run = (worldData?: Parameters<typeof detectNarrativeEvents>[2]["worldData"]) =>
    selectTimelineChips(detectNarrativeEvents(paragraphs, speech, { knownNames, worldData }));

  const without = run();
  const withPlaces = run({
    characters: [], factions: [],
    places: [{ name: "Green Gables" }, { name: "Avonlea" }, { name: "Bright River" }],
  });

  const isPlaceChip = (c: { label: string }) => /^green gables|^avonlea|^bright river/i.test(c.label);
  // The control makes the test meaningful: without world data the place chip
  // is expected to survive (that is the shipped defect). If the engine ever
  // learns to reject it without world data, this control tells us the test
  // has gone vacuous and needs a new fixture.
  ok("control: WITHOUT world data the place chip ships (the defect is real)",
    without.some(isPlaceChip), without.map((c) => c.label).join(" | "));
  ok("WITH world data no shown chip has a place as its agent",
    !withPlaces.some(isPlaceChip), withPlaces.map((c) => c.label).join(" | "));
  ok("the budget refills with a different event (places are filtered, not blanked)",
    withPlaces.length >= without.length - (without.filter(isPlaceChip).length ? 0 : 1)
      && withPlaces.length > 0,
    `without: ${without.length}, with: ${withPlaces.length}`);

  console.log(failed ? `\nFAILED ${failed}` : "\nPASS — all label-quality cases hold");
  process.exit(failed ? 1 : 0);
}
main();
