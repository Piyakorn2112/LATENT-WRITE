/// <reference types="node" />

/**
 * probe-bucket-audit.ts — what does the bucketer actually decide, and why?
 *
 * The scan's NAME detection is good; its TYPE assignment is what struggles.
 * This dumps every kept candidate with the evidence the classifier saw, so a
 * wrong bucket can be traced to the signal that produced it rather than
 * guessed at.
 *
 * Run:  ./node_modules/.bin/tsx scripts/probe-bucket-audit.ts [path-to-book.txt]
 */

import { readFile } from "fs/promises";
import { scanAndClassify, determinerUsage } from "../src/lib/world-data";
import type { AdaptivePredictionTrace } from "../src/types";

const DEFAULT_BOOK = "/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels/root-crown.txt";

export function splitBookChapters(raw: string): string[] {
  const parts = raw.split(/^===CHAPTER [^=]*===$/m);
  // parts[0] is front matter (title / index) — never manuscript prose.
  return parts.slice(1).map((p) => p.trim()).filter(Boolean);
}

async function main() {
  const file = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : DEFAULT_BOOK;
  const raw = await readFile(file, "utf8");
  const chapters = splitBookChapters(raw);
  const fullText = chapters.join("\n");
  console.log(`${file}\n${chapters.length} chapters, ${raw.length} chars\n`);

  const traceOut: { value: AdaptivePredictionTrace[] } = { value: [] };
  const t0 = Date.now();
  const result = await scanAndClassify(chapters, undefined, 2, { predictionTraceOut: traceOut });
  const ms = Date.now() - t0;
  const traceByName = new Map(traceOut.value.map((t) => [t.spanText, t]));

  const buckets: Array<[string, string[]]> = [
    ["CHARACTERS", result.characters],
    ["PLACES", result.places],
    ["FACTIONS", result.factions],
    ["ENTITIES", result.entities],
  ];

  for (const [label, names] of buckets) {
    console.log(`\n── ${label} (${names.length}) ──────────────────────────────`);
    for (const name of names) {
      const dr = determinerUsage(fullText, name);
      const flag = dr.occurrences >= 3 && dr.ratio >= 0.4 ? " [det]" : "";
      const f = traceByName.get(name)?.candidates?.[0]?.features ?? {};
      const s = (k: string) => (f[k] === undefined ? "  -" : String(Math.round(f[k] as number)).padStart(3));
      console.log(
        `  ${name.padEnd(32)} det ${String(dr.occurrences).padStart(3)}/${String(Math.round(dr.ratio * 100)).padStart(3)}%${flag.padEnd(6)}`
        + ` ch ${s("char_score")} pl ${s("place_score")} fa ${s("faction_score")} en ${s("entity_score")}`,
      );
    }
  }

  const total = result.characters.length + result.places.length + result.factions.length + result.entities.length;
  console.log(`\n${total} names in ${(ms / 1000).toFixed(1)}s`);
}

if (process.argv[1] && process.argv[1].endsWith("probe-bucket-audit.ts")) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
