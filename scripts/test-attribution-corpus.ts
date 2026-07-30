/**
 * test-attribution-corpus.ts — CORPUS-SCALE speaker-attribution measurement.
 *
 * `accuracy-suite.ts` scores 217 hand-written cases. This script scores
 * `detectSpeechInChapter` against several THOUSAND auto-extracted examples
 * across all books exposed by `print-chapter.ts`, using the real cold-start
 * name list (`resolveKnownNames`) instead of hand-fed `knownNames`.
 *
 * ★ WHAT THIS MEASURES, HONESTLY: a paragraph of the exact form
 *   `"<quote>," said <Name>.` where <Name> (after stripping an optional
 *   honorific) is a member of the book's own `resolveKnownNames()` cast is an
 *   UNAMBIGUOUS, auto-labelled example — but it is also the EASY case:
 *   explicit trailing tag, explicit proper name, no pronoun or context
 *   resolution required. A high score here says nothing about the harder
 *   majority of dialogue (bare alternation, pronouns, leading attribution,
 *   multi-turn exchanges) that this harness structurally CANNOT label without
 *   a human. `coverage.hardMajorityPct` reports how much of all dialogue this
 *   is — expect it to be large.
 *
 * Two other patterns are extracted and scored SEPARATELY, unfiltered by cast
 * membership, because they are known failure classes (see CLAUDE.md /
 * test-dialogue-events.ts KNOWN_GAPS) and the open question is whether they
 * are isolated hand-picked cases or fail at real scale:
 *   - HONORIFIC   : `said Mr. Wilson.` / `said Dr. Livesey.` / `said Mrs. Bennet.`
 *   - DEFINITE-DESC: `said the old man.` / `said the stranger.` / `said a woman.`
 *
 * Segment lookup is exact, not fuzzy: `extractQuotePairs` builds each
 * SpeechSegment as `{ start: openIdx, end: closeIdx + 1 }` (speech-detect.ts
 * line ~1602), and every regex below anchors its match to the CLOSING quote
 * character, so `m.index === closeIdx` and the segment is found by
 * `seg.end === m.index + 1` — no proximity heuristics, no ambiguity.
 *
 * Run:  npx tsx scripts/test-attribution-corpus.ts            (all books)
 *       npx tsx scripts/test-attribution-corpus.ts --book pride
 *       npx tsx scripts/test-attribution-corpus.ts --samples   (print example snippets)
 *
 * This is a MEASUREMENT harness, not a gate — there is no established target
 * for a first corpus-scale baseline, so it always exits 0. Record the numbers
 * it prints; do not tune against them without a second measurement.
 */

import { BOOKS, CORPUS_BOOKS, loadBook, splitParagraphs } from "./print-chapter";
import { resolveKnownNames } from "../src/lib/world-data";
import {
  detectSpeechInChapter,
  type ChapterEndContext,
  type ChapterParaResult,
  type IntelligenceLevel,
} from "../src/lib/speech-detect";

const ALL_BOOK_KEYS = [...Object.keys(BOOKS), ...Object.keys(CORPUS_BOOKS)];

// ── Ground-truth extraction patterns ───────────────────────────────────────

const HONORIFIC_TOKENS = [
  "Mr", "Mrs", "Ms", "Dr", "Miss", "Sir", "Lord", "Lady", "Captain", "Colonel",
  "Professor", "Aunt", "Uncle", "Madame", "Monsieur", "Mademoiselle",
];
const HONORIFIC_ALT = HONORIFIC_TOKENS.join("|");
const HONORIFIC_PREFIX_RE = new RegExp(`^(?:${HONORIFIC_ALT})\\.?\\s+`);

// Closing quote: curly ” or straight ". (Books in this corpus use one or the
// other; none mix per-quote, but the class covers both without a flag.)
const CLOSE_Q = `[”"]`;

// `"<quote>," said <Name>.`  Name = optional honorific + 1-3 Title-Case words.
// Anchored to start AT the closing quote char so m.index === closeIdx exactly.
function nameTagRe(): RegExp {
  return new RegExp(
    `${CLOSE_Q}\\s*,?\\s*said\\s+((?:(?:${HONORIFIC_ALT})\\.?\\s+)?[A-Z][A-Za-z'’-]*(?:\\s+[A-Z][A-Za-z'’-]*){0,2})\\s*[.,!?]`,
    "g",
  );
}

// `"<quote>," said the/a/an <common noun phrase>.`  — definite descriptions.
function descTagRe(): RegExp {
  return new RegExp(
    `${CLOSE_Q}\\s*,?\\s*said\\s+(?:the|a|an)\\s+([a-z][a-z'’-]*(?:\\s+[a-z][a-z'’-]*){0,2})\\s*[.,!?]`,
    "gi",
  );
}

// Independent (engine-free) dialogue-paragraph detector, for the coverage
// denominator: a paragraph containing at least one quoted span, by simple
// quote-character parity — does not reuse detectSpeechInChapter's own
// classification, so it can't be circular with what we're measuring.
function looksLikeDialogueParagraph(p: string): boolean {
  if (p.includes("“") || p.includes("”")) return true;
  const straight = p.match(/"/g);
  return !!straight && straight.length >= 2;
}

// ── Cast lookup with a one-word (surname) fallback ─────────────────────────

function buildLookup(knownNames: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of knownNames) m.set(n.toLowerCase(), n);
  return m;
}

/** Full-phrase match first; falls back to the LAST word (surname convention). */
function resolveAgainstCast(captured: string, lookup: Map<string, string>): string | undefined {
  const direct = lookup.get(captured.toLowerCase());
  if (direct) return direct;
  const words = captured.trim().split(/\s+/);
  if (words.length > 1) {
    const last = words[words.length - 1];
    const viaLast = lookup.get(last.toLowerCase());
    if (viaLast) return viaLast;
  }
  return undefined;
}

// ── Outcome bucket ──────────────────────────────────────────────────────────

interface Tally {
  total: number;
  correct: number;
  wrong: number;
  unattributed: number;
  noSegment: number;
}

function emptyTally(): Tally {
  return { total: 0, correct: 0, wrong: 0, unattributed: 0, noSegment: 0 };
}

function findSegment(result: ChapterParaResult, closeIdx: number) {
  return result.segments.find((s) => s.type === "speech" && s.end === closeIdx + 1);
}

// ── Per-book run ────────────────────────────────────────────────────────────

interface BookResult {
  key: string;
  words: number;
  chapters: number;
  knownNamesCount: number;
  knownNamesSample: string[];
  dialogueParagraphs: number;
  goldParagraphs: number;
  plain: Tally;
  plainOutOfCastCount: number;
  honorific: Tally;
  descriptive: Tally;
  descriptiveGenericHit: number;
  samples: { plain: string[]; honorific: string[]; descriptive: string[] };
}

async function runBook(key: string, level: IntelligenceLevel, collectSamples: boolean): Promise<BookResult> {
  const novel = await loadBook(key);
  const knownNames = resolveKnownNames(novel);
  const lookup = buildLookup(knownNames);
  const words = novel.chapters.reduce((a, c) => a + c.content.trim().split(/\s+/).length, 0);

  const plain = emptyTally();
  const honorific = emptyTally();
  const descriptive = emptyTally();
  let plainOutOfCastCount = 0;
  let descriptiveGenericHit = 0;
  let dialogueParagraphs = 0;
  let goldParagraphs = 0;
  const samples = { plain: [] as string[], honorific: [] as string[], descriptive: [] as string[] };

  let prevContext: ChapterEndContext | null = null;

  for (const chapter of novel.chapters) {
    const paragraphs = splitParagraphs(chapter.content);
    const contextOut: { value: ChapterEndContext | null } = { value: null };
    const results = detectSpeechInChapter(paragraphs, knownNames, {
      intelligenceLevel: level,
      prevChapterContext: prevContext ?? undefined,
      contextOut,
    });
    prevContext = contextOut.value;

    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      const result = results[i];
      if (looksLikeDialogueParagraph(p)) dialogueParagraphs++;
      let paraHasGold = false;

      const nameRe = nameTagRe();
      let m: RegExpExecArray | null;
      while ((m = nameRe.exec(p))) {
        const captured = m[1];
        const closeIdx = m.index;
        const isHonorific = HONORIFIC_PREFIX_RE.test(captured);
        const core = isHonorific ? captured.replace(HONORIFIC_PREFIX_RE, "") : captured;
        const expected = resolveAgainstCast(core, lookup);

        if (isHonorific) {
          const seg = findSegment(result, closeIdx);
          honorific.total++;
          if (!seg) honorific.noSegment++;
          else if (!seg.speaker) honorific.unattributed++;
          else if (expected && seg.speaker.toLowerCase() === expected.toLowerCase()) honorific.correct++;
          else honorific.wrong++; // includes "expected unknown" (surname never independently extracted) — still an objective non-match on this test's terms
          if (collectSamples && samples.honorific.length < 20) {
            samples.honorific.push(`[${key}] ...${p.slice(Math.max(0, closeIdx - 50), closeIdx + m[0].length)}  → seg.speaker=${seg?.speaker ?? "(none)"}  expected=${expected ?? "?"}`);
          }
        } else {
          if (!expected) { plainOutOfCastCount++; continue; }
          paraHasGold = true;
          const seg = findSegment(result, closeIdx);
          plain.total++;
          if (!seg) plain.noSegment++;
          else if (!seg.speaker) plain.unattributed++;
          else if (seg.speaker.toLowerCase() === expected.toLowerCase()) plain.correct++;
          else plain.wrong++;
          if (collectSamples && samples.plain.length < 20 && seg && seg.speaker?.toLowerCase() !== expected.toLowerCase()) {
            samples.plain.push(`[${key}] expected=${expected} got=${seg?.speaker ?? "(none)"} ...${p.slice(Math.max(0, closeIdx - 50), closeIdx + m[0].length)}`);
          }
        }
      }

      const descRe = descTagRe();
      while ((m = descRe.exec(p))) {
        const closeIdx = m.index;
        const descPhrase = m[1].toLowerCase();
        const seg = findSegment(result, closeIdx);
        descriptive.total++;
        if (!seg) descriptive.noSegment++;
        else if (!seg.speaker) descriptive.unattributed++;
        else {
          const words = descPhrase.split(/\s+/);
          if (words.includes(seg.speaker.toLowerCase())) { descriptive.correct++; descriptiveGenericHit++; }
          else descriptive.wrong++; // attributed to a specific named character instead of the anonymous description
          if (collectSamples && samples.descriptive.length < 20) {
            samples.descriptive.push(`[${key}] desc="${descPhrase}" seg.speaker=${seg.speaker ?? "(none)"} ...${p.slice(Math.max(0, closeIdx - 50), closeIdx + m[0].length)}`);
          }
        }
      }

      if (paraHasGold) goldParagraphs++;
    }
  }

  return {
    key,
    words,
    chapters: novel.chapters.length,
    knownNamesCount: knownNames.length,
    knownNamesSample: knownNames.slice(0, 8),
    dialogueParagraphs,
    goldParagraphs,
    plain,
    plainOutOfCastCount,
    honorific,
    descriptive,
    descriptiveGenericHit,
    samples,
  };
}

// ── Reporting ───────────────────────────────────────────────────────────────

const pct = (n: number, d: number) => (d === 0 ? 0 : (n / d) * 100);
const f1 = (n: number) => n.toFixed(1);

function tallyLine(label: string, t: Tally) {
  const attributed = t.correct + t.wrong;
  const precision = pct(t.correct, attributed);
  const recall = pct(t.correct, t.total);
  const unattr = pct(t.unattributed + t.noSegment, t.total);
  console.log(
    `    ${label.padEnd(11)} N=${String(t.total).padStart(5)}  precision=${f1(precision).padStart(5)}%  recall=${f1(recall).padStart(5)}%  unattributed=${f1(unattr).padStart(5)}%  (correct ${t.correct} / wrong ${t.wrong} / unattr ${t.unattributed} / no-seg ${t.noSegment})`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const bookFilterIdx = args.indexOf("--book");
  const bookFilter = bookFilterIdx >= 0 ? args[bookFilterIdx + 1] : undefined;
  const showSamples = args.includes("--samples");
  const level: IntelligenceLevel = "default";

  const keys = bookFilter ? [bookFilter] : ALL_BOOK_KEYS;

  console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  CORPUS-SCALE ATTRIBUTION HARNESS — auto-labelled 'said <Name>.' tags ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");
  console.log(`mode: ${level}   books: ${keys.join(", ")}`);

  const bookResults: BookResult[] = [];
  for (const key of keys) {
    process.stderr.write(`  running ${key}…\n`);
    const r = await runBook(key, level, showSamples);
    bookResults.push(r);
  }

  const grandPlain = emptyTally();
  const grandHonorific = emptyTally();
  const grandDescriptive = emptyTally();
  let grandDialogueParas = 0;
  let grandGoldParas = 0;
  let grandPlainOutOfCast = 0;
  let grandDescriptiveGenericHit = 0;

  for (const r of bookResults) {
    console.log(`\n── ${r.key} ── (${r.chapters} ch, ${r.words.toLocaleString()} words, ${r.knownNamesCount} known names)`);
    console.log(`   known-names sample: ${r.knownNamesSample.join(" | ")}`);
    console.log(`   dialogue paragraphs (quote-char detected): ${r.dialogueParagraphs}   gold-labelled paragraphs: ${r.goldParagraphs}   hard-majority: ${f1(pct(r.dialogueParagraphs - r.goldParagraphs, r.dialogueParagraphs))}%`);
    tallyLine("plain", r.plain);
    console.log(`      (+ ${r.plainOutOfCastCount} plain "said Name." tags where Name was NOT in the resolved cast — extraction-recall gap, not scored)`);
    tallyLine("honorific", r.honorific);
    tallyLine("descriptive", r.descriptive);
    if (r.descriptive.total > 0) console.log(`      (of attributed, ${r.descriptiveGenericHit} resolved to the generic word itself, e.g. "old man" → "Man")`);

    for (const k of ["total", "correct", "wrong", "unattributed", "noSegment"] as const) {
      grandPlain[k] += r.plain[k];
      grandHonorific[k] += r.honorific[k];
      grandDescriptive[k] += r.descriptive[k];
    }
    grandDialogueParas += r.dialogueParagraphs;
    grandGoldParas += r.goldParagraphs;
    grandPlainOutOfCast += r.plainOutOfCastCount;
    grandDescriptiveGenericHit += r.descriptiveGenericHit;

    if (showSamples) {
      if (r.samples.plain.length) { console.log("   plain MISSES:"); r.samples.plain.forEach((s) => console.log("     " + s)); }
      if (r.samples.honorific.length) { console.log("   honorific examples:"); r.samples.honorific.forEach((s) => console.log("     " + s)); }
      if (r.samples.descriptive.length) { console.log("   descriptive examples:"); r.samples.descriptive.forEach((s) => console.log("     " + s)); }
    }
  }

  console.log("\n" + "═".repeat(74));
  console.log("CORPUS TOTALS (all books, mode=" + level + ")\n");
  console.log(`  dialogue paragraphs: ${grandDialogueParas}   gold-labelled (easy-case) paragraphs: ${grandGoldParas}`);
  console.log(`  → hard-majority this harness CANNOT label: ${f1(pct(grandDialogueParas - grandGoldParas, grandDialogueParas))}% of dialogue paragraphs\n`);
  tallyLine("plain", grandPlain);
  console.log(`      (+ ${grandPlainOutOfCast} plain tags where Name fell outside the resolved cast — not scored, reported for context)`);
  console.log("\n  FAILURE CLASSES (unfiltered by cast membership — checking scale, not isolated cases):");
  tallyLine("honorific", grandHonorific);
  tallyLine("descriptive", grandDescriptive);
  console.log(`      (of descriptive attributions, ${grandDescriptiveGenericHit} resolved to the generic word itself; the rest were UNATTRIBUTED or misattributed to a named character)`);

  console.log("\n" + "═".repeat(74));
  console.log("Measurement only — not gated. Record these numbers; do not tune against them yet.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
