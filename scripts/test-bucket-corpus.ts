/// <reference types="node" />

/**
 * test-bucket-corpus.ts — does the bucketer generalise off the book it was
 * fixed on?
 *
 * ★ THIS IS THE POINT OF IT. Every threshold in the classifier was set while
 *   reading The Root Crown, so a 96% there proves the fixes FIT that book and
 *   nothing else. These four are published novels nobody tuned against, and
 *   the names are ones no reader would argue about: Elizabeth is a person and
 *   Netherfield is a place in any reading of Pride and Prejudice.
 *
 * ★ ONLY UNCONTROVERSIAL NAMES, AND DELIBERATELY FEW. A large hand-labelled
 *   cast for four books would be a second tuning target, which is the thing
 *   this exists to guard against. Every entry below is a protagonist, a named
 *   estate or a named institution — the cases where a wrong bucket is not a
 *   judgement call but a failure.
 *
 * Run:  ./node_modules/.bin/tsx scripts/test-bucket-corpus.ts
 */

import { scanAndClassify } from "../src/lib/world-data";
import { loadBook } from "./print-chapter";

type Bucket = "character" | "place" | "faction";

const EXPECTED: Record<string, Record<string, Bucket>> = {
  pride: {
    Elizabeth: "character", Darcy: "character", Bingley: "character",
    Jane: "character", Wickham: "character", Collins: "character",
    Netherfield: "place", Longbourn: "place", Pemberley: "place",
    Meryton: "place", Rosings: "place",
  },
  dracula: {
    Harker: "character", Lucy: "character", Mina: "character",
    Helsing: "character", Renfield: "character",
    Transylvania: "place", Whitby: "place", London: "place", Carfax: "place",
  },
  treasure: {
    Silver: "character", Livesey: "character", Trelawney: "character",
    Hawkins: "character", Flint: "character",
    Bristol: "place",
  },
  frankenstein: {
    Elizabeth: "character", Clerval: "character", Justine: "character",
    Geneva: "place", Ingolstadt: "place",
  },
};

function bucketOf(
  r: { characters: string[]; places: string[]; factions: string[]; entities: string[] },
  name: string,
): string | null {
  const lc = name.toLowerCase();
  const hit = (list: string[]) => list.some((n) => n.toLowerCase() === lc || n.toLowerCase() === `the ${lc}`);
  if (hit(r.characters)) return "character";
  if (hit(r.places)) return "place";
  if (hit(r.factions)) return "faction";
  if (hit(r.entities)) return "entity";
  return null;
}

// Recall is measured but not gated: these books name hundreds of things and
// the scan reports a top slice, so a missing minor name is a size decision,
// not a bucketing failure. A name that IS reported must be reported correctly.
const MIN_ACCURACY = 0.9;
const MIN_FOUND = 0.75;

async function main() {
  let found = 0;
  let total = 0;
  let correct = 0;
  const misses: string[] = [];

  for (const [book, expected] of Object.entries(EXPECTED)) {
    const novel = await loadBook(book);
    const scan = await scanAndClassify(novel.chapters.map((c) => c.content), undefined, 2);
    const seen: string[] = [];
    for (const [name, want] of Object.entries(expected)) {
      total += 1;
      const got = bucketOf(scan, name);
      if (got === null) { seen.push(`${name} —`); continue; }
      found += 1;
      if (got === want) { correct += 1; seen.push(`${name} ✓`); continue; }
      misses.push(`${book}: ${name} → ${got} (want ${want})`);
      seen.push(`${name} ✗${got}`);
    }
    console.log(`${book.padEnd(13)} ${seen.join("  ")}`);
  }

  const accuracy = found === 0 ? 0 : correct / found;
  const foundRate = total === 0 ? 0 : found / total;

  console.log("");
  if (misses.length) {
    console.log("WRONG BUCKET");
    for (const m of misses) console.log(`  ${m}`);
    console.log("");
  }

  const gates: Array<[string, boolean, string]> = [
    ["bucket accuracy on found names", accuracy >= MIN_ACCURACY,
      `${(accuracy * 100).toFixed(1)}% (${correct}/${found}), floor ${MIN_ACCURACY * 100}%`],
    ["names found at all", foundRate >= MIN_FOUND,
      `${(foundRate * 100).toFixed(1)}% (${found}/${total}), floor ${MIN_FOUND * 100}%`],
  ];
  let failed = 0;
  for (const [label, ok, detail] of gates) {
    if (!ok) failed++;
    console.log(`${ok ? "✓" : "✗"} ${label.padEnd(32)} ${detail}`);
  }
  console.log(failed === 0 ? "\nAll gates pass.\n" : `\n${failed} gate(s) failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
