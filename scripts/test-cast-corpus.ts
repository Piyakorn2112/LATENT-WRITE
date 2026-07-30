/**
 * test-cast-corpus.ts — CORPUS-SCALE character/entity extraction health check.
 *
 * Runs the real cold-start extraction path (`resolveKnownNames` → internally
 * `autoExtractKnownNamesFast`, the same function `speech-detect.ts` and the
 * highlight layer use when no world data is curated) over every whole book
 * exposed by `print-chapter.ts`.
 *
 * ★ THERE IS NO GOLD CAST LIST for 12 of the 16 books, so this script does
 * NOT invent an accuracy number for them. Instead it reports LABEL-FREE
 * health signals per book, computed without knowing the true cast:
 *
 *   - SINGLE-OCCURRENCE: the extracted name (exact phrase, word-bounded)
 *     appears 0-1 times in the whole book. A name that clears
 *     `autoExtractKnownNamesFast`'s minFreq=2 gate should not be able to
 *     score 0-1 by a plain count — when it does, the frequency the gate saw
 *     came from a different surface form (e.g. a substring/overlap quirk),
 *     which is itself worth knowing.
 *   - LOWERCASE-LEAK: the name's LAST word (surname / core identifier, not
 *     an honorific prefix — "Miss Bingley" is checked on "Bingley", not
 *     "Miss", or every honorific-prefixed name would false-flag on the
 *     honorific's ordinary lowercase use) also appears, verbatim, in
 *     all-lowercase elsewhere in the book. Proper names are essentially
 *     never also used as ordinary lowercase words in running prose — a hit
 *     here means the "name" is very likely a common word or interjection
 *     that slipped past the stoplist at a sentence start ("Come", "Pray",
 *     "Let", "Some", "Hallo" were all observed this way in this corpus).
 *   - BARE HONORIFIC: the name IS, exactly, an honorific abbreviation ("Mrs",
 *     "Mr", "Dr", "Ms" ...). These never leak lowercase ("Mrs." is always
 *     capitalized in real prose) so LOWERCASE-LEAK can't catch them, but
 *     they are titles, not names — the period in "Mrs. Bennet" stops the
 *     Title-Case token-matcher from fusing the two words, so "Mrs" alone
 *     clears the frequency/IDF gates as if it were a character. Confirmed at
 *     corpus scale: "Mrs" alone leaks into the top-30 for 9 of 16 books, and
 *     directly causes part of the HONORIFIC misattribution rate measured in
 *     test-attribution-corpus.ts ("said Mrs. Bennet." → speaker "Mrs").
 *
 * For FOUR books this agent knows well (pride, dracula, treasure, anne), a
 * short expected-cast list is hand-authored below and used to compute
 * RECALL against the extracted top-30 — clearly marked as hand-authored,
 * not exhaustive, and not a substitute for the label-free checks above.
 *
 * Run:  npx tsx scripts/test-cast-corpus.ts
 *       npx tsx scripts/test-cast-corpus.ts --book pride
 *
 * Measurement only — not gated, always exits 0. There is no established
 * target for a first corpus-scale cast-health baseline.
 */

import { BOOKS, CORPUS_BOOKS, loadBook } from "./print-chapter";
import { resolveKnownNames } from "../src/lib/world-data";

const ALL_BOOK_KEYS = [...Object.keys(BOOKS), ...Object.keys(CORPUS_BOOKS)];

// ── Hand-authored spot-check casts (clearly marked, NOT exhaustive) ────────
// Written from this agent's own knowledge of these public-domain novels,
// independent of anything the extractor produced. Recall-only: a name
// extracted but absent from this list may still be a real minor character,
// so it is not counted against precision.
const HAND_CAST: Record<string, string[]> = {
  pride: ["Elizabeth", "Darcy", "Jane", "Bingley", "Bennet", "Lydia", "Kitty", "Wickham", "Collins", "Charlotte", "Gardiner"],
  dracula: ["Harker", "Jonathan", "Mina", "Van Helsing", "Lucy", "Arthur", "Quincey", "Seward", "Renfield"],
  treasure: ["Jim", "Silver", "Trelawney", "Livesey", "Smollett", "Hands", "Ben Gunn", "Pew", "Flint"],
  anne: ["Anne", "Marilla", "Matthew", "Diana", "Gilbert", "Lynde", "Stacy", "Josie", "Ruby", "Jane"],
};

// ── Label-free health checks ────────────────────────────────────────────────

function countMentions(text: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "g");
  return (text.match(re) ?? []).length;
}

function hasLowercaseLeak(text: string, name: string): boolean {
  // Check the LAST word, not the first: honorific-prefixed candidates
  // ("Miss Bingley", "Lady Catherine", "Madame Ratignolle") legitimately have
  // a first word that's also an ordinary lowercase word elsewhere in the
  // prose (a real "lady", someone will "miss" someone) — that's not evidence
  // the EXTRACTION is wrong, since the surname still uniquely identifies the
  // character. The last word (surname / core identifier) leaking into plain
  // lowercase use is the actually diagnostic signal.
  const words = name.trim().split(/\s+/);
  const last = words[words.length - 1];
  if (!last || last.length < 2) return false;
  const lc = last.charAt(0).toLowerCase() + last.slice(1);
  if (lc === last) return false; // already lowercase (shouldn't happen for a Title-Case candidate)
  const re = new RegExp(`\\b${lc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  return re.test(text);
}

// A closed class of honorific/title ABBREVIATIONS that are near-universally
// capitalized in real prose ("Mrs.", never "mrs.") and therefore invisible to
// `hasLowercaseLeak` above — but are titles, not names, whenever they appear
// bare (i.e. the following surname was severed from the candidate, usually by
// the period: "Mrs. Bennet" never forms one Title-Case token because "Mrs."
// contains a period the token-matcher doesn't cross). Confirmed separately at
// corpus scale: "Mrs" alone leaks into the top-30 for 9 of 16 books. This is
// also the root cause of a chunk of the HONORIFIC failures measured in
// test-attribution-corpus.ts — "said Mrs. Bennet." resolves to "Mrs" itself.
const BARE_HONORIFICS = new Set(["mr", "mrs", "ms", "dr", "messrs", "mme", "mlle", "st"]);
function isBareHonorific(name: string): boolean {
  return BARE_HONORIFICS.has(name.trim().toLowerCase());
}

interface NameHealth {
  name: string;
  mentions: number;
  singleOccurrence: boolean;
  lowercaseLeak: boolean;
  bareHonorific: boolean;
}

interface BookHealth {
  key: string;
  words: number;
  names: string[];
  health: NameHealth[];
  obviouslyWrong: NameHealth[];
  handCastRecall?: { list: string[]; found: string[]; missing: string[]; pct: number };
}

async function runBook(key: string): Promise<BookHealth> {
  const novel = await loadBook(key);
  const fullText = novel.chapters.map((c) => c.content).join("\n\n");
  const words = fullText.trim().split(/\s+/).length;
  const names = resolveKnownNames(novel);

  const health: NameHealth[] = names.map((name) => {
    const mentions = countMentions(fullText, name);
    return {
      name,
      mentions,
      singleOccurrence: mentions <= 1,
      lowercaseLeak: hasLowercaseLeak(fullText, name),
      bareHonorific: isBareHonorific(name),
    };
  });

  const obviouslyWrong = health.filter((h) => h.singleOccurrence || h.lowercaseLeak || h.bareHonorific);

  let handCastRecall: BookHealth["handCastRecall"];
  const hand = HAND_CAST[key];
  if (hand) {
    const lower = new Set(names.map((n) => n.toLowerCase()));
    const found = hand.filter((n) => lower.has(n.toLowerCase()));
    const missing = hand.filter((n) => !lower.has(n.toLowerCase()));
    handCastRecall = { list: hand, found, missing, pct: (found.length / hand.length) * 100 };
  }

  return { key, words, names, health, obviouslyWrong, handCastRecall };
}

// ── Reporting ───────────────────────────────────────────────────────────────

const f1 = (n: number) => n.toFixed(1);

async function main() {
  const args = process.argv.slice(2);
  const bookFilterIdx = args.indexOf("--book");
  const bookFilter = bookFilterIdx >= 0 ? args[bookFilterIdx + 1] : undefined;
  const keys = bookFilter ? [bookFilter] : ALL_BOOK_KEYS;

  console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  CORPUS-SCALE CAST/ENTITY EXTRACTION HEALTH — resolveKnownNames()     ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");
  console.log("No gold cast list exists for most books — label-free health only.");
  console.log("Hand-authored recall spot-check runs for: " + Object.keys(HAND_CAST).join(", ") + "\n");

  let totalNames = 0;
  let totalWrong = 0;
  let booksWithBareHonorific = 0;

  for (const key of keys) {
    const r = await runBook(key);
    totalNames += r.names.length;
    totalWrong += r.obviouslyWrong.length;

    console.log(`\n── ${r.key} ── (${r.words.toLocaleString()} words, ${r.names.length} names extracted)`);
    console.log(`   top 20: ${r.names.slice(0, 20).join(" | ")}`);
    console.log(`   obviously-wrong (single-occurrence / lowercase-leak / bare honorific): ${r.obviouslyWrong.length}/${r.names.length}`);
    let bookHasBareHonorific = false;
    for (const h of r.obviouslyWrong) {
      const reasons = [
        h.singleOccurrence ? `${h.mentions} mention(s)` : undefined,
        h.lowercaseLeak ? "lowercase form also appears in prose" : undefined,
        h.bareHonorific ? "BARE HONORIFIC (title severed from the name it modified)" : undefined,
      ].filter(Boolean).join(", ");
      console.log(`     ✗ "${h.name}" — ${reasons}`);
      if (h.bareHonorific) bookHasBareHonorific = true;
    }
    if (r.obviouslyWrong.length === 0) console.log("     (none flagged)");
    if (bookHasBareHonorific) booksWithBareHonorific++;

    if (r.handCastRecall) {
      console.log(`   HAND-AUTHORED spot-check recall: ${f1(r.handCastRecall.pct)}% (${r.handCastRecall.found.length}/${r.handCastRecall.list.length})`);
      console.log(`     found:   ${r.handCastRecall.found.join(", ") || "(none)"}`);
      console.log(`     missing: ${r.handCastRecall.missing.join(", ") || "(none)"}`);
    }
  }

  console.log("\n" + "═".repeat(74));
  console.log("CORPUS TOTALS\n");
  console.log(`  total names extracted across ${keys.length} books: ${totalNames}`);
  console.log(`  total flagged obviously-wrong: ${totalWrong} (${f1((totalWrong / totalNames) * 100)}%)`);
  console.log(`  books with a BARE HONORIFIC ("Mrs" etc.) leaked in as a name: ${booksWithBareHonorific}/${keys.length}`);
  console.log("\nMeasurement only — not gated. No accuracy % is reported for books without a hand-authored cast.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
