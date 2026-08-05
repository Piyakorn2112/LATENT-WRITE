/**
 * test-alias-scan.ts — the alias scan, measured on one adversarial chapter.
 *
 * ★★ EVERY FIND GATE IS PAIRED WITH A REFUSE GATE, and both are paired with a
 *    COUNT. A negative assertion is satisfied perfectly by an empty result —
 *    `every(x => !bad)` over nothing is true — and this repo has read green on
 *    exactly that shape more than once. So the first gate below is "the scan
 *    produced anything at all", and it prints the number.
 *
 *   /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs scripts/test-alias-scan.ts
 *   …--verbose   dump every candidate, rejection and unresolved form
 *   …--chapter   print the chapter itself, ready to paste into the app
 */
import { scanAliases, looksProperNoun, absorbNeighbours, complementaryScore } from "../src/lib/alias-scan";
import {
  CHAPTER, CHAPTER_TITLE, CAST, EXTRA_CANDIDATES,
  MUST_FIND, MUST_REFUSE, MUST_NOT_PAIR, MODEL_CASE,
} from "./fixtures/alias-stress-chapter";

const verbose = process.argv.includes("--verbose");

if (process.argv.includes("--chapter")) {
  console.log(`# ${CHAPTER_TITLE}\n`);
  console.log(CHAPTER);
  process.exit(0);
}

let pass = 0, fail = 0;
function gate(ok: boolean, label: string, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`); }
}

console.log("=".repeat(76));
console.log(`alias scan — "${CHAPTER_TITLE}"`);
console.log("=".repeat(76));

const result = scanAliases({
  characters: CAST,
  chapters: [{ content: CHAPTER }],
  extraCandidates: EXTRA_CANDIDATES,
});

const found = (character: string, alias: string) =>
  result.candidates.find((c) =>
    c.character.toLowerCase() === character.toLowerCase()
    && c.alias.toLowerCase() === alias.toLowerCase());
const surfaced = (alias: string) =>
  result.candidates.filter((c) => c.alias.toLowerCase() === alias.toLowerCase());
const vetoedAs = (alias: string) =>
  result.rejected.filter((r) => r.alias.toLowerCase() === alias.toLowerCase()).map((r) => r.veto);

if (verbose) {
  console.log("\nCANDIDATES");
  for (const c of result.candidates) {
    console.log(`  ${c.attested ? "●" : "○"} ${c.character.padEnd(16)} ← ${c.alias.padEnd(18)} `
      + `${c.source.padEnd(15)} ${c.confidence.toFixed(2)} ×${c.occurrences}  ${c.why}`);
  }
  console.log("\nREJECTED");
  for (const r of result.rejected) console.log(`  ${r.character.padEnd(16)} ✗ ${r.alias.padEnd(18)} ${r.veto}`);
  console.log("\nUNRESOLVED (the model layer's input)");
  for (const u of result.unresolved) {
    console.log(`  ${u.alias} ×${u.occurrences}${u.fromVocative ? " (vocative)" : ""} → `
      + u.shortlist.map((s) => `${s.character} ${s.complementary.toFixed(2)}`).join(", "));
    for (const s of u.snippets) console.log(`      …${s.slice(0, 150)}…`);
  }
  console.log("");
}

// ── 0 · the anti-vacuous gate ────────────────────────────────────────────
console.log("\nthe scan produced something");
{
  gate(result.candidates.length > 0,
    `${result.candidates.length} candidates — without this every refusal gate below is vacuous`);
  gate(result.stats.paragraphs > 10, `${result.stats.paragraphs} paragraphs read`);
  gate(result.stats.formsHarvested > 0, `${result.stats.formsHarvested} adjacent forms harvested`);
  gate(result.stats.capped === 0, "nothing was dropped by a cap",
    `${result.stats.capped} rows capped — a silent truncation reads as full coverage`);
}

// ── 1 · what it must find ─────────────────────────────────────────────────
console.log("\nnames the chapter uses that the cast does not have");
for (const e of MUST_FIND) {
  const hit = found(e.character, e.alias);
  gate(!!hit, `${e.character} ← "${e.alias}"  (${e.source})`,
    `missing. ${e.why}`);
  if (hit && hit.source !== e.source && verbose) {
    console.log(`      note: found via "${hit.source}", expected "${e.source}" — `
      + "a different layer got there first, which is a pass");
  }
}

// ── 2 · what it must refuse ────────────────────────────────────────────────
console.log("\nand the refusals that pay for them");
for (const r of MUST_REFUSE) {
  const rows = surfaced(r.alias);
  gate(rows.length === 0, `"${r.alias}" is never proposed`,
    `proposed for ${rows.map((x) => x.character).join(", ")}. ${r.why}`);
  const vetoes = vetoedAs(r.alias);
  // The named veto is the one that SHOULD fire; another firing first is still
  // a refusal, and saying which one fired is how a drift gets noticed.
  gate(vetoes.length > 0, `…and it is refused on the record, not by silence`,
    "no rejection recorded — the form may simply never have been harvested, " +
    "which is a refusal nobody can audit");
  if (vetoes.length > 0 && !vetoes.includes(r.veto)) {
    console.log(`      note: refused as "${vetoes.join(", ")}", expected "${r.veto}"`);
  }
}

for (const p of MUST_NOT_PAIR) {
  gate(!found(p.character, p.alias), `${p.character} is never given "${p.alias}"`, p.why);
}

// ── 3 · the two evidence tests, directly ────────────────────────────────────
console.log("\nthe common-word filter is evidence, not a stop-list");
{
  gate(looksProperNoun("Corin", CHAPTER),
    "\"Corin\" appears mid-clause somewhere — proper nouns do");
  gate(!looksProperNoun("Then", CHAPTER),
    "\"Then\" never does — a sentence opener is only ever capitalised at a start");
  // ★ THE PAIRED POSITIVE: a test that only ever says no is passed by a test
  //   that always says no.
  gate(looksProperNoun("Vasquez", CHAPTER) && looksProperNoun("Kestrel", CHAPTER),
    "…and it says yes to two more real names");
}

console.log("\nadjacency absorbs only across whitespace");
{
  const { right } = absorbNeighbours(CHAPTER, "Elena");
  gate((right.get("Vasquez") ?? 0) >= 2, `"Vasquez" absorbed ×${right.get("Vasquez") ?? 0}`);
  // "…and Elena was still standing…", "Elena said", "Elena kept walking" — all
  // lower-case, so nothing is absorbed. A comma or a full stop breaks it too.
  gate(![...right.keys()].some((k) => k === "Marshal"),
    "nothing is absorbed across a full stop or a quotation mark",
    `absorbed: ${[...right.keys()].join(", ")}`);
  const { left } = absorbNeighbours(CHAPTER, "Vale");
  gate((left.get("Corin") ?? 0) >= 2, `"Corin" absorbed ×${left.get("Corin") ?? 0}`);
  gate((left.get("Then") ?? 0) >= 2,
    `…and so is "Then" ×${left.get("Then") ?? 0} — absorption is deliberately blind; `
    + "the filters, not the harvester, do the judging");
}

// ── 4 · the model layer's input ─────────────────────────────────────────────
console.log("\nwhat reaches the local model");
{
  const sparrow = result.unresolved.find((u) => u.alias === MODEL_CASE.alias);
  gate(!!sparrow, `"${MODEL_CASE.alias}" is handed over unresolved`,
    "the deterministic pass either attached it or dropped it — both hide the case");
  if (sparrow) {
    gate(sparrow.shortlist.length > 0 && sparrow.shortlist.length <= 3,
      `shortlist of ${sparrow.shortlist.length}: `
      + sparrow.shortlist.map((s) => `${s.character} ${s.complementary.toFixed(2)}`).join(", "));
    gate(sparrow.shortlist.some((s) => s.character === MODEL_CASE.answer),
      `the true referent "${MODEL_CASE.answer}" is on the shortlist`,
      "the model cannot be right if the answer is not offered — this gate is " +
      "the difference between measuring a model and measuring a harness");
    // ★★ THE GATE THAT STOPS A RIGGED PROBE. A vocative paragraph alone says
    //    only that somebody was called Sparrow. If the passage handed over does
    //    not contain the reply, no model can answer and the probe reports a
    //    model failure that is really a harness failure.
    const answerInPassage = sparrow.snippets.some((s) => /Corin Vale/.test(s));
    gate(answerInPassage, "the passage handed over contains the answering turn",
      MODEL_CASE.why);
    gate(sparrow.fromVocative, "…and it is marked as coming from speech");
  }
}

console.log("\ncomplementary distribution ranks, and refuses to rank on nothing");
{
  const paras = CHAPTER.split(/\n{2,}|\n/).map((l) => l.trim()).filter(Boolean);
  const fake = paras.map(() => false);
  const stub = paras.map((text) => ({ text, present: new Set<string>(["Vale"]), speakers: new Set<string>(), quotes: [] }));
  gate(complementaryScore(stub, "Vale", fake) === 0,
    "★ a form that never occurs scores 0, not 1 — \"they never co-occur\" is " +
    "vacuously true of a name that is not there, and that is the empty-set trap");
}

// ── 5 · nothing silently mutates the cast ─────────────────────────────────
console.log("\nthe scan proposes and never applies");
{
  gate(CAST.every((c) => (c.aliases ?? []).length === 0),
    "the cast passed in is unchanged after a scan");
  gate(result.candidates.every((c) => c.kind === "alias" || c.kind === "merge"),
    "every row declares whether it removes a cast entry");
  const attestedRows = result.candidates.filter((c) => c.attested);
  gate(attestedRows.length > 0,
    `${attestedRows.length} row(s) are attested and arrive pre-ticked`);
  gate(result.candidates.filter((c) => !c.attested).length > 0,
    `${result.candidates.filter((c) => !c.attested).length} inferred rows arrive UNticked`);
  gate(result.candidates.every((c) => c.evidence.length > 0),
    "every row carries a verbatim line from the manuscript");
  gate(result.candidates.every((c) => c.why.length > 0),
    "…and the rule that produced it, in the writer's language");
}

console.log("\n" + "=".repeat(76));
console.log(`${pass} passed, ${fail} failed`);
console.log("=".repeat(76));
process.exitCode = fail > 0 ? 1 : 0;
