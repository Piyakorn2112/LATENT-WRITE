/**
 * probe-alias-propose.ts — how badly is the cast fragmented, and does the
 * proposer put it back together without welding two people into one?
 *
 * The presence probe found "Holmes" and "Sherlock Holmes" scoring as two
 * separate characters on every DEV book, which inflates every count the ledger
 * draws. This sizes that problem and then measures the proposer against it.
 *
 * ★ THE NUMBER THAT MATTERS IS NOT COVERAGE. A proposer that links everything
 *   to everything scores perfectly on "aliases found" and destroys the cast. So
 *   this prints EVERY proposal for reading, and separately counts the vetoes —
 *   what a conservative engine REFUSES is the measurement, not an aside.
 *
 *   /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs scripts/probe-alias-propose.ts
 */
import { loadBook } from "./print-chapter";
import { resolveSpeakerCandidates } from "../src/lib/world-data";
import { proposeAliases, type AliasVeto } from "../src/lib/alias-propose";

const BOOKS = ["sherlock", "pride", "dracula", "carol", "expectations", "webnovel"];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TAG_VERB =
  "(?:said|says|asked|asks|replied|answered|cried|whispered|shouted|murmured|" +
  "added|told|muttered|observed|remarked|exclaimed|repeated|returned|called)";

/** A name tagged as a speaker twice in the book is a person, not a place. */
function dialogueTagCount(text: string, name: string): number {
  const n = esc(name);
  const g = (src: string) => (text.match(new RegExp(src, "g")) ?? []).length;
  return (
    g(`["”]\\s*[,.]?\\s*(?:${TAG_VERB}\\s+${n}|${n}\\s+(?:\\w+\\s+){0,2}${TAG_VERB})\\b`) +
    g(`\\b(?:${TAG_VERB}\\s+${n}|${n}\\s+(?:\\w+\\s+){0,2}${TAG_VERB})\\b\\s*[,:]?\\s*["“]`)
  );
}

async function main() {
  console.log("═".repeat(78));
  console.log("alias proposals — one person, how many strings?");
  console.log("═".repeat(78));

  const vetoTally = new Map<AliasVeto, number>();
  let totalProposals = 0, totalChars = 0, uncertainCount = 0, mergeCount = 0;
  const ruleTally = new Map<string, number>();

  for (const book of BOOKS) {
    const novel = await loadBook(book);
    const text = novel.chapters.map((c) => c.content).join("\n");
    const candidates = resolveSpeakerCandidates(novel);
    // The writer's worldData, simulated: the names the book tags as speakers.
    // That is roughly what the scan hands them, and it is deliberately NOT the
    // full candidate list — the proposer's job is to attach the leftovers.
    const cast = candidates.filter((n) => dialogueTagCount(text, n) >= 2).slice(0, 10);
    if (cast.length < 3) { console.log(`\n── ${book}: cast too small (${cast.length})`); continue; }

    const result = proposeAliases(cast.map((name) => ({ name })), candidates, text);
    totalChars += cast.length;
    totalProposals += result.proposals.length;
    uncertainCount += result.proposals.filter((p) => p.uncertain).length;
    mergeCount += result.proposals.filter((p) => p.kind === "merge").length;
    for (const r of result.rejected) vetoTally.set(r.veto, (vetoTally.get(r.veto) ?? 0) + 1);
    for (const p of result.proposals) ruleTally.set(p.rule, (ruleTally.get(p.rule) ?? 0) + 1);

    console.log(`\n── ${book} ${"─".repeat(64 - book.length)}`);
    console.log(`   cast (${cast.length}): ${cast.join(", ")}`);
    if (result.proposals.length === 0) {
      console.log("   (no proposals)");
    }
    for (const p of result.proposals) {
      console.log(`   ${p.kind === "merge" ? "⇔" : "+"} ${p.character.padEnd(18)} ← "${p.alias}"  [${p.rule}` +
        `${p.uncertain ? " · UNSURE" : ""}] ×${p.occurrences}`);
      console.log(`       ${p.evidence.slice(0, 96)}`);
    }
    const byVeto = new Map<AliasVeto, string[]>();
    for (const r of result.rejected) {
      const list = byVeto.get(r.veto) ?? [];
      if (list.length < 8) list.push(`${r.alias}→${r.character}`);
      byVeto.set(r.veto, list);
    }
    for (const [veto, list] of byVeto) {
      console.log(`   ✗ ${String(veto).padEnd(17)} ${list.join(", ")}`);
    }
  }

  console.log(`\n${"═".repeat(78)}`);
  console.log(`over ${totalChars} characters in ${BOOKS.length} books`);
  console.log(`  proposals            ${String(totalProposals).padStart(4)}` +
    `   (${(totalProposals / Math.max(1, totalChars)).toFixed(2)} per character)`);
  console.log(`  …flagged uncertain   ${String(uncertainCount).padStart(4)}`);
  console.log(`  …of which MERGES     ${String(mergeCount).padStart(4)}   (two cast entries, one person)`);
  console.log(`\n  by rule:`);
  for (const [rule, n] of [...ruleTally].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${rule.padEnd(16)} ${String(n).padStart(4)}`);
  }
  console.log(`\n  REFUSED — what a conservative engine declines is the measurement:`);
  for (const [veto, n] of [...vetoTally].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(veto).padEnd(16)} ${String(n).padStart(4)}`);
  }
  console.log("═".repeat(78));
}

main().catch((e) => { console.error(e); process.exit(1); });
