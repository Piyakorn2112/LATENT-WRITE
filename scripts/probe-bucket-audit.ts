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
import {
  selectReviewable,
  reviewPriority,
  usageSignals,
  REVIEW_CAP,
  type EntityType,
} from "../src/lib/entity-review";

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

  // ── what the review pass would actually be asked ────────────────────────
  //
  // The scan's confidence is what `selectReviewable` ranks on, so this is
  // where an honest low confidence turns into a question the model gets to
  // answer. A name the scan guessed at and the queue never reaches is a name
  // nobody will ever fix.
  const entries = traceOut.value.map((t) => ({
    name: t.spanText,
    currentType: t.predictedLabel as EntityType,
    needsReview: t.needsReview,
    ambiguityGap: t.ambiguityGap,
  }));
  const selected = selectReviewable(entries, { text: fullText });
  console.log(`\n── review queue (cap ${REVIEW_CAP} of ${entries.length}) ──────────────────`);
  for (const [i, e] of selected.entries()) {
    const t = traceByName.get(e.name);
    const s = usageSignals(fullText, e.name);
    console.log(
      `  ${String(i + 1).padStart(2)}. ${e.name.padEnd(30)} ${e.currentType.padEnd(10)}`
      + ` conf ${(t?.confidence ?? 0).toFixed(2)}  prio ${reviewPriority(e, s).toFixed(2)}`
      + `  speaks ${s.spoken} to ${s.addressed} place ${s.placePrep} det ${s.determiner}`,
    );
  }
  const missed = entries.filter((e) => e.needsReview && !selected.some((s) => s.name === e.name));
  if (missed.length) {
    console.log(`\n  ${missed.length} name(s) the scan doubted but the cap excluded:`);
    for (const m of missed) console.log(`    ${m.name} (${m.currentType})`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("probe-bucket-audit.ts")) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
