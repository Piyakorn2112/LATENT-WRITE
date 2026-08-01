/**
 * test-action-assign.ts — action ASSIGNMENT, measured.
 *
 * The owner's brief: "serious action assignment accuracy in high mode —
 * smart segmentation for long sentences with multiple actors, verbs like
 * 'lit' get missed, this has to be real reliable precision." Precision that
 * is not a number is a mood, so this fixes gold cases for each failure class:
 *
 *   1. VERB COVERAGE — irregular pasts the suffix-shaped eye skips (lit,
 *      flung, hung, crept, tore, dove, sprang, seized...).
 *   2. SUBJECT-SIDE ATTRIBUTION — the actor is the name before the verb, not
 *      the longest name anywhere ("Anne watched Marilla" belongs to Anne).
 *   3. MULTI-ACTOR SEGMENTATION — a joint splits only when a connective, a
 *      different subject and verbs on both sides all agree; anything less
 *      stays whole (precision first).
 *   4. PRONOUN SUBJECTS AND CARRY — "She lit the lamp" continues whoever
 *      last acted or spoke; objects never steal ("threw it to Marilla").
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-action-assign.ts
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { findActionSentences, segmentActions, attributeActor, predictActionActor, inferGender } from "../src/lib/action-detect";
import { runChapterAnalysis } from "../src/lib/chapter-analysis-runner";

let failed = 0;
const ok = (label: string, cond: boolean, detail?: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failed++;
};

// ─── 1. Verb coverage ────────────────────────────────────────────────────────
console.log("verb coverage — each sentence must register as action:");
const VERB_CASES = [
  "She lit the lamp on the table.",
  "Matthew flung the door open.",
  "Her coat hung from the peg as she crept along the hall.",
  "Anne tore the letter in half.",
  "He dove into the cold water.",
  "Marilla sprang from her chair.",
  "The boy seized the rope and hauled it in.",
  "Diana slipped on the wet stone.",
  "He knelt by the fire and poured the tea.",
  "She swept the floor and folded the linen.",
  "Jem spun round and ducked behind the wall.",
  "The captain dragged his sea-chest up the hill.",
];
for (const text of VERB_CASES) {
  const spans = findActionSentences(text);
  ok(JSON.stringify(text), spans.length > 0);
}

// ─── 2–4. Assignment ─────────────────────────────────────────────────────────
interface Case {
  name: string;
  sentence: string;
  known: string[];
  carrying?: string | null;
  /** Expected [substring-of-segment, actor][] in order. */
  expect: Array<[string, string | null]>;
}

const CASES: Case[] = [
  {
    name: "subject wins over longer object name",
    sentence: "Anne watched Marilla cross the yard.",
    known: ["Anne", "Marilla"],
    expect: [["Anne watched", "Anne"]],
  },
  {
    name: "object after verb never steals",
    sentence: "Anne threw the book to Marilla.",
    known: ["Anne", "Marilla"],
    expect: [["Anne threw", "Anne"]],
  },
  {
    name: "two actors, two segments",
    sentence: "Anne flung the window open while Marilla lit the lamp downstairs.",
    known: ["Anne", "Marilla"],
    expect: [["Anne flung", "Anne"], ["Marilla lit", "Marilla"]],
  },
  {
    name: "three-clause chain keeps each actor",
    sentence: "Matthew carried the bags inside and Marilla poured the tea while Anne climbed the stairs.",
    known: ["Anne", "Marilla", "Matthew"],
    expect: [["Matthew carried", "Matthew"], ["Marilla poured", "Marilla"], ["Anne climbed", "Anne"]],
  },
  {
    name: "same actor coordination does NOT split",
    sentence: "Anne stood up and walked to the door.",
    known: ["Anne", "Marilla"],
    expect: [["Anne stood up and walked", "Anne"]],
  },
  {
    name: "pronoun subject continues the carry",
    sentence: "She lit the candle carefully.",
    known: ["Anne", "Marilla"],
    carrying: "Marilla",
    expect: [["She lit", "Marilla"]],
  },
  {
    name: "pronoun object does not trigger the pronoun rule",
    sentence: "Matthew handed her the parcel.",
    known: ["Anne", "Matthew"],
    carrying: "Anne",
    expect: [["Matthew handed", "Matthew"]],
  },
  {
    name: "second segment's actor becomes the carry for a trailing pronoun clause",
    sentence: "Anne opened the gate and Marilla stepped through, then she shut it behind them.",
    known: ["Anne", "Marilla"],
    expect: [["Anne opened", "Anne"], ["Marilla stepped", "Marilla"]],
  },
  {
    name: "no known name, carry holds",
    sentence: "The lamp lit the corner of the room as she sat down.",
    known: ["Anne", "Marilla"],
    carrying: "Anne",
    expect: [["lamp lit", "Anne"]],
  },
  {
    name: "connective without a new subject stays whole",
    sentence: "Marilla crossed the room and opened the window and looked out at the orchard.",
    known: ["Anne", "Marilla"],
    expect: [["Marilla crossed", "Marilla"]],
  },
];

console.log("\nassignment — segments and actors:");
for (const c of CASES) {
  const segs = segmentActions(c.sentence, c.known, c.carrying ?? null);
  const rendered = segs.map((s) => `"${c.sentence.slice(s.start, s.end).trim().slice(0, 28)}"→${s.actor}`).join("  ");
  let pass = segs.length === c.expect.length;
  if (pass) {
    for (let i = 0; i < c.expect.length; i++) {
      const [substr, actor] = c.expect[i];
      const text = c.sentence.slice(segs[i].start, segs[i].end);
      if (!text.includes(substr) || segs[i].actor !== actor) { pass = false; break; }
    }
  }
  ok(c.name, pass, `got ${segs.length} segment(s): ${rendered}`);
}

// ─── The cheap live path must be no worse than before ───────────────────────
console.log("\nlive path (attributeActor) — unchanged contract:");
ok("explicit name still wins",
  attributeActor("Anne crossed the room.", ["Anne", "Marilla"], "Marilla") === "Anne");
ok("carry still fills a nameless sentence",
  attributeActor("She crossed the room.", ["Anne", "Marilla"], "Marilla") === "Marilla");

// ─── The full prediction path honours the grammar hint ──────────────────────
console.log("\nprediction path — subject hint beats a bare explicit match:");
const p1 = predictActionActor("Anne threw the book to Marilla.", ["Anne", "Marilla"], null,
  undefined, undefined, "", "", "Anne");
ok("subject-side actor wins over object name", p1.actor === "Anne", `got ${p1.actor}`);
const p2 = predictActionActor("Anne threw the book to Marilla.", ["Anne", "Marilla"], null);
ok("without the hint the ranker records candidates for both",
  p2.candidates.filter((c) => c.label).length >= 2, `${p2.candidates.length} candidates`);

// ─── Real prose: the owner's stress story, full high-mode pipeline ──────────
//
// "The Lantern at Half Moon Cove" — six characters, cleft sentences,
// participle lists, pronoun chains, a name that is also an adjective
// ("frank curiosity"). Every case below was WRONG before the carry walk,
// case-exact matching, the dominant subject hint, participle joints and the
// collective guard landed. Gold is hand-labelled from reading the story.
console.log("\nreal prose — the Lantern stress story (full high-mode pipeline):");
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const story = readFileSync(path.join(ROOT, "scripts", "fixtures", "lantern-cove.txt"), "utf8");
const storyResult = runChapterAnalysis({
  chapter: { id: "story", number: 1, title: "The Lantern at Half Moon Cove", content: story },
  knownNames: ["Mira", "Thomas", "Elena", "Adrian", "Frank", "Lio"],
  level: "high",
});
const allPreds: Array<{ text: string; actor: string | null }> = [];
for (let pi = 0; pi < storyResult.paragraphs.length; pi++) {
  for (const pr of storyResult.actionPredictions[pi] ?? []) {
    allPreds.push({ text: storyResult.paragraphs[pi].slice(pr.start, pr.end), actor: pr.actor });
  }
}
const actorOf = (substr: string) => allPreds.find((pr) => pr.text.includes(substr));

const STORY_GOLD: Array<[string, string | null]> = [
  ["She had run this place", "Mira"],          // pronoun chain after a named subject
  ["She banked the fire", "Mira"],
  ["He nodded once at Mira", "Thomas"],        // object must not steal from the carry
  ["He set the case down", "Adrian"],          // "frank curiosity" must not match Frank
  ["Mira gave him the whiskey", "Mira"],       // gave: verb the registry missed
  ["He dropped his sample case", "Frank"],
  ["He came back in carrying", "Thomas"],
  ["Adrian tuning his violin", "Adrian"],      // participle list, ¶6
  ["Elena watching the black glass", "Elena"],
  ["Thomas at the flue", "Thomas"],            // the six-actor chimney sentence
  ["Frank hauling", "Frank"],
  ["Mira flinging", "Mira"],
  ["Elena keeping", "Elena"],
  ["still holding his violin", "Adrian"],
  ["they stood for a moment", null],           // collective — a decision, not a gap
  ["tucked the barley sugar wrapper", "Elena"],// subordinate clause's object must not steal
  ["It was Elena who moved first", "Elena"],   // cleft
  // ★ WAS THE KNOWN MISS, now fixed by the gender-evidence model: the carry
  // says Mira acted last, but "He" cannot be her, so the resolver walks back
  // to the nearest actor whose gender agrees.
  ["He took the chair across from Thomas", "Frank"],
];
let storyHits = 0;
for (const [substr, gold] of STORY_GOLD) {
  const found = actorOf(substr);
  const pass = !!found && found.actor === gold;
  if (pass) storyHits++;
  ok(`"${substr}" → ${gold ?? "nobody"}`, pass, found ? `got ${found.actor ?? "—"}` : "span not found");
}
const storyRate = storyHits / STORY_GOLD.length;
ok(`story accuracy ${storyHits}/${STORY_GOLD.length} clears 90%`, storyRate >= 0.9, `${(storyRate * 100).toFixed(0)}%`);

// ─── The gender-evidence model itself ───────────────────────────────────────
//
// It exists to break the "Mira gave him the whiskey. He took the chair." tie,
// and it must be RIGHT or it moves actors rather than leaving them. Every
// character in the story is checked, including Mira, whose entry needed two
// separate object-vs-subject fixes to survive the confidence gate.
console.log("\ngender evidence — inferred from the story's own prose:");
const genderMap = inferGender(story, ["Mira", "Thomas", "Elena", "Adrian", "Frank", "Lio"]);
const GENDER_GOLD: Array<[string, string]> = [
  ["mira", "female"], ["elena", "female"],
  ["thomas", "male"], ["adrian", "male"], ["frank", "male"], ["lio", "male"],
];
for (const [name, want] of GENDER_GOLD) {
  ok(`${name} → ${want}`, genderMap.get(name) === want, `got ${genderMap.get(name) ?? "unknown"}`);
}
// A name with no evidence must stay ABSENT rather than default to a guess.
ok("an unmentioned name has no gender entry", !inferGender(story, ["Nobody"]).has("nobody"));

console.log(failed ? `\nFAILED ${failed}` : "\nPASS — all action-assignment cases hold");
process.exit(failed ? 1 : 0);
