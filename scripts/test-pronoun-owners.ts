/**
 * test-pronoun-owners.ts — contract lock for the surfaced pronoun-owner layer.
 *
 * resolvePronounOwners exposes the engine's INTERNAL pronoun resolution to the
 * highlight layer. These assertions pin the contract, not the prose:
 *
 *   1. a TAG pronoun takes the segment's attributed speaker at high confidence
 *   2. a NARRATIVE pronoun takes the most recent gender-compatible antecedent
 *   3. pronouns INSIDE quotation marks are never resolved (speaker deixis)
 *   4. a tag whose speaker's gender is unknown is answered at reduced
 *      confidence, never at the gender-confirmed level
 *   5. identity goes through the alias map: an antecedent mentioned as an
 *      alias owns pronouns under its canonical name
 */

import { detectSpeechInChapter, resolvePronounOwners } from "../src/lib/speech-detect";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

// Gender evidence included so the map classifies: Kael F (her hip), Marcus M (his chest).
const paras = [
  "Kael tapped the vial at her hip. Marcus rubbed his chest and waited.",
  "“The forgetting isn’t natural,” she said.",
  "“I know he thinks it started here,” Marcus said.",
  "She unrolled the map across the table.",
];
const names = ["Kael", "Marcus"];
const results = detectSpeechInChapter(paras, names, { intelligenceLevel: "high" });
const owners = resolvePronounOwners(paras, results, names);

const at = (p: number, pron: string) =>
  owners[p].find((o) => o.pronoun.toLowerCase() === pron);

console.log("\npronoun-owner contract:");

// 1. tag pronoun → attributed speaker
const tag = at(1, "she");
check("tag pronoun takes the attributed speaker", tag?.owner === "Kael", `got ${tag?.owner}`);
check("tag source is 'tag'", tag?.source === "tag");

// 2. narrative pronouns → gender-compatible antecedent
check("narrative 'her' → Kael", at(0, "her")?.owner === "Kael", `got ${at(0, "her")?.owner}`);
check("narrative 'his' → Marcus", at(0, "his")?.owner === "Marcus", `got ${at(0, "his")?.owner}`);
check("cross-paragraph 'She' → Kael", at(3, "she")?.owner === "Kael", `got ${at(3, "she")?.owner}`);

// 3. in-quote pronouns are never resolved
check("in-quote 'he' is not resolved", at(2, "he") === undefined, `got ${at(2, "he")?.owner}`);

// 4. unknown-gender tag answers below the gender-confirmed level
const uParas = ["“Fine,” she said.", "Robin left the room."];
const uNames = ["Robin"];
const uRes = detectSpeechInChapter(uParas, uNames, { intelligenceLevel: "high" });
const uOwn = resolvePronounOwners(uParas, uRes, uNames);
const uTag = uOwn[0].find((o) => o.pronoun.toLowerCase() === "she");
check(
  "unknown-gender tag confidence < 0.9",
  uTag === undefined || uTag.confidence < 0.9,
  `got ${uTag?.confidence}`,
);

// 5. alias identity: antecedent mentioned as "Lizzy" owns as "Elizabeth"
const aParas = ["Lizzy laughed at the letter, and her sister frowned."];
const aNames = ["Elizabeth", "Lizzy"];
const aMap = new Map([["lizzy", "Elizabeth"], ["elizabeth", "Elizabeth"]]);
const aRes = detectSpeechInChapter(aParas, aNames, { intelligenceLevel: "high", aliasCanon: aMap });
const aOwn = resolvePronounOwners(aParas, aRes, aNames, aMap);
const aHer = aOwn[0].find((o) => o.pronoun.toLowerCase() === "her");
check("alias antecedent owns under canonical name", aHer?.owner === "Elizabeth", `got ${aHer?.owner}`);

console.log(`\npronoun-owners: ${pass}/${pass + fail}`);
if (fail) process.exitCode = 1;
