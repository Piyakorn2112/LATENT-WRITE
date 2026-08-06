/**
 * bench-grammar-corpus.ts — the checker against the INDUSTRY ERROR TAXONOMY.
 *
 * Cases are organised by the CoNLL-2014 GEC error categories (the shared-task
 * taxonomy LanguageTool/GEC systems report against): Vt (verb tense/form),
 * SVA (subject-verb agreement), ArtOrDet (articles), Mec (spelling/
 * punctuation/capitalisation), Wform (word form/confusables), plus a clean
 * set for precision. Includes errors we DELIBERATELY do not chase (bare
 * their/there, affect/effect without parsing) so recall is honest, not
 * curated to flatter.
 *
 * The bar: PRECISION ≥ 95% on clean prose (a checker that cries wolf gates
 * the writing tool wrongly), recall reported per category. This is a
 * MEASUREMENT, not a training set — never tune a rule against a case here
 * without adding five neighbours it must not break.
 *
 * Run: ./node_modules/.bin/tsx scripts/bench-grammar-corpus.ts
 */
import { checkGrammar } from "../src/lib/grammar-check";

interface Case { text: string; hasError: boolean; cat: string; note?: string }

const CASES: Case[] = [
  // ── Vt: verb tense / form ──────────────────────────────────────────────
  { cat: "Vt", hasError: true, text: "She did went to the market early." },
  { cat: "Vt", hasError: true, text: "He has ran that route before." },
  { cat: "Vt", hasError: true, text: "They have began the harvest." },
  { cat: "Vt", hasError: true, text: "The rope was broke by the strain." },
  { cat: "Vt", hasError: true, text: "She should have wrote sooner." },
  { cat: "Vt", hasError: false, text: "She had gone before the rain began." },
  { cat: "Vt", hasError: false, text: "He has run that route for years." },
  // ── SVA: subject-verb agreement ────────────────────────────────────────
  { cat: "SVA", hasError: true, text: "They was already at the dock." },
  { cat: "SVA", hasError: true, text: "She don't want the money." },
  { cat: "SVA", hasError: true, text: "He have two brothers in town." },
  { cat: "SVA", hasError: true, text: "The children was asleep by nine." },
  { cat: "SVA", hasError: true, text: "Her hands shakes when she reads." },
  { cat: "SVA", hasError: true, text: "People rushes past the window." },
  { cat: "SVA", hasError: false, text: "The children were asleep by nine." },
  { cat: "SVA", hasError: false, text: "His kiss feels like a question." },
  { cat: "SVA", hasError: false, text: "Did he run when the bell rang?" },
  // ── ArtOrDet: articles ─────────────────────────────────────────────────
  { cat: "ArtOrDet", hasError: true, text: "He ate a apple on the walk home." },
  { cat: "ArtOrDet", hasError: true, text: "It took a hour to cross the bay." },
  { cat: "ArtOrDet", hasError: true, text: "She was an user of the old ferry." },
  { cat: "ArtOrDet", hasError: true, text: "It was a honest answer." },
  { cat: "ArtOrDet", hasError: false, text: "It was an honour to serve." },
  { cat: "ArtOrDet", hasError: false, text: "A European story about a ewe." },
  { cat: "ArtOrDet", hasError: false, text: "She has a unique way of laughing." },
  // ── Mec: spelling, punctuation, capitals, doubles ──────────────────────
  { cat: "Mec", hasError: true, text: "She walked to teh door quietly." },
  { cat: "Mec", hasError: true, text: "He stoped at the gate to listen." },
  { cat: "Mec", hasError: true, text: "It occured to her too late." },
  { cat: "Mec", hasError: true, text: "They will leave tommorow at dawn." },
  { cat: "Mec", hasError: true, text: "He opened and and closed the tin." },
  { cat: "Mec", hasError: true, text: "She waited , then knocked twice." },
  { cat: "Mec", hasError: true, text: "He left. the door swung shut." },
  { cat: "Mec", hasError: true, text: "She could not beleive the price." },
  { cat: "Mec", hasError: true, text: "It was definately his handwriting." },
  { cat: "Mec", hasError: false, text: "He left. The door swung shut behind him." },
  { cat: "Mec", hasError: false, text: "That that man said was true, in its way." },
  // ── Wform: confusables / word form ─────────────────────────────────────
  { cat: "Wform", hasError: true, text: "Your welcome to stay the night." },
  { cat: "Wform", hasError: true, text: "Its been a long winter here." },
  { cat: "Wform", hasError: true, text: "She could of said no at any time." },
  { cat: "Wform", hasError: true, text: "He was to tired to argue." },
  { cat: "Wform", hasError: true, text: "She liked him alot back then." },
  { cat: "Wform", hasError: true, text: "It was atleast a mile to the point." },
  { cat: "Wform", hasError: true, text: "Their coming tonight, all of them.", note: "guarded they're rule" },
  // Deliberately unchased (need parsing; LanguageTool territory):
  { cat: "Wform", hasError: true, text: "The news didn't really effect her.", note: "SKIPPED BY DESIGN" },
  { cat: "Wform", hasError: true, text: "He put the keys over their, by the lamp.", note: "SKIPPED BY DESIGN" },
  { cat: "Wform", hasError: true, text: "Don't loose the mooring key again.", note: "SKIPPED BY DESIGN" },
  { cat: "Wform", hasError: false, text: "It's been years since their wedding." },
  { cat: "Wform", hasError: false, text: "Their coming was foretold in the old song." },
  { cat: "Wform", hasError: false, text: "She bent to close the hatch against the spray." },
  // ── Clean literary prose (precision set) ───────────────────────────────
  { cat: "clean", hasError: false, text: "The harbour lay grey under first light, and Mara counted the boats twice before she trusted the number." },
  { cat: "clean", hasError: false, text: "Had he known, he would have said so; an hour was not too much to give." },
  { cat: "clean", hasError: false, text: "\"I ain't got nothin' for you,\" Teo said, and the gulls wheeled away." },
  { cat: "clean", hasError: false, text: "Once, a user of the old ferry told her about the winter it froze." },
  { cat: "clean", hasError: false, text: "The rhythm seems wrong tonight, and the tide tables agree." },
  { cat: "clean", hasError: false, text: "Let it be, she thought. Could she go with them, after everything?" },
  { cat: "clean", hasError: false, text: "He payed out the rope hand over hand.", note: "nautical 'payed' — accepted false positive, flagged" },
];

let tp = 0, fn = 0, fp = 0, tn = 0;
const byCat = new Map<string, { tp: number; fn: number; missNotes: string[] }>();

for (const c of CASES) {
  // errors AND warnings both surface to the writer, so both count as caught;
  // only the style tier (suggestions) is excluded from the benchmark.
  const errors = checkGrammar(c.text).filter((s) => s.severity !== "suggestion");
  const flagged = errors.length > 0;
  const rec = byCat.get(c.cat) ?? { tp: 0, fn: 0, missNotes: [] };
  if (c.hasError) {
    if (flagged) { tp++; rec.tp++; }
    else { fn++; rec.fn++; rec.missNotes.push(`${c.text}${c.note ? `  [${c.note}]` : ""}`); }
  } else {
    if (flagged) { fp++; console.log(`  FP: "${c.text}" → ${errors.map((e) => `${e.original}→${e.suggestion}`).join(", ")}${c.note ? `  [${c.note}]` : ""}`); }
    else tn++;
  }
  byCat.set(c.cat, rec);
}

console.log("\ncategory   recall   misses");
for (const [cat, r] of byCat) {
  const total = r.tp + r.fn;
  if (total === 0) continue;
  console.log(`${cat.padEnd(10)} ${r.tp}/${total}`);
  for (const m of r.missNotes) console.log(`             ✗ ${m}`);
}
const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
console.log(`\nprecision ${(precision * 100).toFixed(1)}% (${fp} false positives on ${fp + tn} clean)  ·  recall ${(recall * 100).toFixed(1)}% (${tp}/${tp + fn})`);
const cleanFp = fp;
if (cleanFp > 1) { console.log("✗ PRECISION BAR FAILED (max 1 accepted false positive)"); process.exit(1); }
console.log("✓ precision bar met");
