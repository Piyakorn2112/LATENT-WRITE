/**
 * print-shipped-chips.ts — second stage of the chip quality loop.
 *
 * The Electron probe captures what the MODEL said. This applies the REAL
 * `normalizeChipPicks` to it and prints what the WRITER actually sees, which is
 * the only output worth judging: the guards repair pronouns, reject softened
 * outcomes and ungrounded names, and backfill from the engine. A loop that
 * stops at the model's raw answer measures a draft nobody reads.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/print-shipped-chips.ts <raw.json>
 */
import { readFileSync } from "node:fs";
import { normalizeChipPicks, type ChipCandidate } from "../src/lib/chip-picker";

interface RawCase {
  id: string;
  chapterNumber: number;
  chapterTitle: string;
  cast: string[];
  labelMax: number;
  candidates: ChipCandidate[];
  raw: unknown;
}

const cases: RawCase[] = JSON.parse(readFileSync(process.argv[2], "utf8"));

const NEGATION = /\b(not|never|no longer|refused?|refuses|declined?|without|failed|fails|nothing)\b/i;
let changed = 0;
let modelKept = 0;
let total = 0;

console.log("\n═══ SHIPPED CHIPS (after the guards) ═══\n");
for (const c of cases) {
  const shipped = normalizeChipPicks(c.raw, c.candidates, c.cast) ?? [];
  console.log(`── ${c.id}  (ch.${c.chapterNumber} "${c.chapterTitle}")  ${shipped.length} chips`);
  for (const pick of shipped) {
    const cand = c.candidates.find((x) => x.rank === pick.rank);
    if (!cand) continue;
    total++;
    const fromModel = pick.label !== cand.label;
    if (fromModel) modelKept++;
    const rawPick = ((c.raw as { picks?: Array<{ rank: number; label: string }> }).picks ?? [])
      .find((p) => p.rank === pick.rank);
    const repaired = rawPick && rawPick.label !== pick.label;
    if (repaired) changed++;
    const note = repaired ? `  ⟵ guard replaced "${rawPick!.label}"` : fromModel ? "" : "  (engine)";
    const neg = NEGATION.test(cand.sentence) && !NEGATION.test(pick.label) ? "  ⚠ NEG" : "";
    console.log(`   "${pick.label}"${note}${neg}`);
  }
  console.log("");
}
console.log(
  `${total} chips shipped · ${modelKept} written by the model · ${changed} repaired by a guard`,
);
