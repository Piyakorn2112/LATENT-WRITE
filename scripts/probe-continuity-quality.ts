/**
 * probe-continuity-quality.ts — what does the continuity engine actually say?
 *
 * "Continuity is still not that great" is a verdict about OUTPUT, so this
 * prints the output. Three signals, over DEV books, with the counts that decide
 * whether each one is a finding or noise:
 *
 *   OUT-OF-ORDER  a character mentioned here whose "first" chapter is later.
 *   CHEKHOV       a specific thing introduced here that never recurs.
 *   HAND-OFF      time/place drift across the chapter boundary.
 *
 * ★ COUNT THE FUNNEL, DO NOT HYPOTHESISE. Two failure modes kill a signal, and
 *   both are per-chapter rates: ~0 means the check never fires and is dead
 *   weight; a dozen a chapter means the writer stops opening the widget. What
 *   the rate cannot show is whether the individual findings are ANY GOOD, so
 *   every one is printed verbatim for reading.
 *
 *   /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs scripts/probe-continuity-quality.ts
 */
import { summarizeContinuity } from "../src/lib/continuity";
import { loadBook } from "./print-chapter";

const DEV_BOOKS = ["pride", "sherlock", "anne", "dracula", "carol", "webnovel"];
const MAX_CHAPTERS = 12;

const pad = (v: string | number, n: number) => String(v).padStart(n);

async function main() {
  console.log("═".repeat(78));
  console.log("continuity engine — what it says today");
  console.log("═".repeat(78));

  const totals = { chapters: 0, ooo: 0, chekhov: 0, handoff: 0, silent: 0 };
  const allPhrases: string[] = [];

  for (const book of DEV_BOOKS) {
    const novel = await loadBook(book);
    const chapters = novel.chapters.slice(0, MAX_CHAPTERS);
    console.log(`\n── ${book} ${"─".repeat(66 - book.length)}`);

    chapters.forEach((chapter, index) => {
      const s = summarizeContinuity(novel.chapters, novel.worldData, index);
      totals.chapters++;
      totals.ooo += s.outOfOrder.length;
      totals.chekhov += s.chekhov.length;
      if (s.handoff) totals.handoff++;
      if (!s.hasAnything) { totals.silent++; return; }

      const bits: string[] = [];
      if (s.outOfOrder.length) {
        bits.push(`ooo: ${s.outOfOrder.map((h) => `${h.character}→ch${h.firstChapter}`).join(", ")}`);
      }
      if (s.handoff) {
        bits.push(`handoff(${s.handoff.drift}): ${s.handoff.prevTime ?? "—"}/${s.handoff.prevPlace ?? "—"}` +
          ` → ${s.handoff.thisTime ?? "—"}/${s.handoff.thisPlace ?? "—"}`);
      }
      if (s.chekhov.length) {
        allPhrases.push(...s.chekhov.map((c) => c.phrase));
        bits.push(`chekhov: ${s.chekhov.map((c) => `"${c.phrase}"×${c.mentions}`).join(", ")}`);
      }
      console.log(`  ch${pad(index + 1, 2)}  ${bits.join("\n        ")}`);
    });
  }

  const per = (n: number) => (n / Math.max(1, totals.chapters)).toFixed(2);
  console.log(`\n${"═".repeat(78)}`);
  console.log(`per chapter, across ${totals.chapters} chapters`);
  console.log(`  out-of-order      ${pad(per(totals.ooo), 6)}`);
  console.log(`  chekhov           ${pad(per(totals.chekhov), 6)}`);
  console.log(`  hand-off          ${pad(per(totals.handoff), 6)}`);
  console.log(`  SILENT chapters   ${pad(totals.silent, 6)}  (${Math.round((totals.silent / totals.chapters) * 100)}% show nothing at all)`);

  // ── the quality question the rates cannot answer ────────────────────────
  // A Chekhov "thing" ought to be a concrete object. Count how many of the
  // phrases are built from an -ed/-ing word or an abstract head, which is what
  // an adjective+noun bigram extractor produces when it lands on a verb phrase.
  const VERBY = /\b\w+(?:ed|ing)\b/;
  const verby = allPhrases.filter((p) => VERBY.test(p));
  console.log(`\nchekhov phrase quality (${allPhrases.length} phrases)`);
  console.log(`  containing an -ed/-ing word  ${pad(verby.length, 4)}  ${pad(`${Math.round((verby.length / Math.max(1, allPhrases.length)) * 100)}%`, 5)}`);
  console.log(`  sample: ${allPhrases.slice(0, 14).map((p) => `"${p}"`).join(", ")}`);
  console.log("═".repeat(78));
}

main().catch((e) => { console.error(e); process.exit(1); });
