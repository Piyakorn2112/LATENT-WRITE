/// <reference types="node" />

/**
 * test-bucket-gold.ts — whole-book bucket accuracy against a hand-labelled gold.
 *
 * The synthetic groups in test-name-bucket-accuracy.ts each isolate one
 * mechanism. This measures what a writer actually gets: run the real scan over
 * a real 660KB manuscript and score every bucket against prose-verified labels.
 *
 * ★ THREE INDEPENDENT NUMBERS, because one number hides the trade. Bucketing
 *   accuracy can be bought with recall (drop everything hard) and recall can be
 *   bought with precision (admit everything), so junk-rate and recall are gated
 *   separately and a fix has to move one without spending the others.
 *
 * ★ UNLABELLED NAMES FAIL THE RUN. A fix that invents a new name the gold has
 *   never seen is a change nobody measured. Label it in the fixture (after
 *   reading its prose) or the harness stays red.
 *
 * Run:  ./node_modules/.bin/tsx scripts/test-bucket-gold.ts [--verbose]
 */

import { readFile } from "fs/promises";
import { scanAndClassify } from "../src/lib/world-data";
import {
  ROOT_CROWN_GOLD,
  THIN_NAMES,
  MUST_FIND,
  type GoldLabel,
} from "./fixtures/root-crown-buckets";

const BOOK = "/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels/root-crown.txt";

// Floors. Raised only after a measured improvement holds, never to accommodate one.
const MIN_BUCKET_ACCURACY = 0.95;
const MAX_JUNK_NAMES = 2;
const MIN_GOLD_RECALL = 0.95;

export function splitBookChapters(raw: string): string[] {
  return raw.split(/^===CHAPTER [^=]*===$/m).slice(1).map((p) => p.trim()).filter(Boolean);
}

function bucketMap(r: { characters: string[]; places: string[]; factions: string[]; entities: string[] }) {
  const out = new Map<string, GoldLabel>();
  for (const n of r.characters) out.set(n, "character");
  for (const n of r.places)     out.set(n, "place");
  for (const n of r.factions)   out.set(n, "faction");
  for (const n of r.entities)   out.set(n, "entity");
  return out;
}

async function main() {
  const verbose = process.argv.includes("--verbose");
  const raw = await readFile(BOOK, "utf8");
  const chapters = splitBookChapters(raw);

  const t0 = Date.now();
  const scan = await scanAndClassify(chapters, undefined, 2);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const got = bucketMap(scan);
  const thin = new Set(THIN_NAMES);

  const correct: string[] = [];
  const wrong: Array<{ name: string; got: GoldLabel; want: GoldLabel[]; why?: string }> = [];
  const junk: Array<{ name: string; got: GoldLabel; why?: string }> = [];
  const missing: Array<{ name: string; want: GoldLabel[] }> = [];
  const unlabelled: Array<{ name: string; got: GoldLabel }> = [];
  const thinSeen: string[] = [];

  for (const [name, label] of got) {
    if (thin.has(name)) { thinSeen.push(name); continue; }
    const gold = ROOT_CROWN_GOLD[name];
    if (!gold) { unlabelled.push({ name, got: label }); continue; }
    if (gold.accept.includes(label)) { correct.push(name); continue; }
    if (gold.accept.includes("drop")) junk.push({ name, got: label, why: gold.why });
    else wrong.push({ name, got: label, want: gold.accept, why: gold.why });
  }

  for (const [name, gold] of Object.entries(ROOT_CROWN_GOLD)) {
    if (gold.accept.includes("drop") && gold.accept.length === 1) continue;
    if (!got.has(name)) missing.push({ name, want: gold.accept });
  }

  // A name the gold says to drop is scored as junk, never as a bucketing miss:
  // it is a detection failure and mixing the two hides which one a fix moved.
  const scored = correct.length + wrong.length;
  const accuracy = scored === 0 ? 0 : correct.length / scored;
  const goldNames = Object.entries(ROOT_CROWN_GOLD)
    .filter(([, g]) => !(g.accept.length === 1 && g.accept[0] === "drop")).length;
  const recall = (goldNames - missing.length) / goldNames;

  console.log(`\nThe Root Crown — ${chapters.length} chapters, ${got.size} names, ${elapsed}s\n`);

  if (wrong.length) {
    console.log(`WRONG BUCKET (${wrong.length})`);
    for (const w of wrong) {
      console.log(`  ${w.name.padEnd(26)} got ${w.got.padEnd(10)} want ${w.want.join("|")}`);
      if (w.why && verbose) console.log(`      ${w.why}`);
    }
    console.log("");
  }
  if (junk.length) {
    console.log(`SHOULD NOT BE A NAME (${junk.length})`);
    for (const j of junk) console.log(`  ${j.name.padEnd(26)} in ${j.got}${j.why ? `  — ${j.why}` : ""}`);
    console.log("");
  }
  if (missing.length) {
    console.log(`NOT FOUND (${missing.length})`);
    for (const m of missing) console.log(`  ${m.name.padEnd(26)} want ${m.want.join("|")}`);
    console.log("");
  }
  if (unlabelled.length) {
    console.log(`UNLABELLED — read the prose and add these to the gold (${unlabelled.length})`);
    for (const u of unlabelled) console.log(`  ${u.name.padEnd(26)} scan says ${u.got}`);
    console.log("");
  }
  if (verbose && thinSeen.length) console.log(`thin, not scored (${thinSeen.length}): ${thinSeen.join(", ")}\n`);

  const missedMust = MUST_FIND.filter((n) => !got.has(n));

  const gates: Array<[string, boolean, string]> = [
    ["bucket accuracy", accuracy >= MIN_BUCKET_ACCURACY,
      `${(accuracy * 100).toFixed(1)}% (${correct.length}/${scored}), floor ${(MIN_BUCKET_ACCURACY * 100).toFixed(0)}%`],
    ["junk names", junk.length <= MAX_JUNK_NAMES, `${junk.length}, cap ${MAX_JUNK_NAMES}`],
    ["gold recall", recall >= MIN_GOLD_RECALL,
      `${(recall * 100).toFixed(1)}% (${goldNames - missing.length}/${goldNames}), floor ${(MIN_GOLD_RECALL * 100).toFixed(0)}%`],
    ["every must-find present", missedMust.length === 0, missedMust.length ? `missing ${missedMust.join(", ")}` : "all present"],
    ["gold covers every scanned name", unlabelled.length === 0, `${unlabelled.length} unlabelled`],
  ];

  console.log("─".repeat(64));
  let failed = 0;
  for (const [label, ok, detail] of gates) {
    if (!ok) failed++;
    console.log(`${ok ? "✓" : "✗"} ${label.padEnd(32)} ${detail}`);
  }
  console.log("─".repeat(64));
  console.log(failed === 0 ? "\nAll gates pass.\n" : `\n${failed} gate(s) failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
