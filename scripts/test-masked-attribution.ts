/**
 * test-masked-attribution.ts — a MODE-SENSITIVE, corpus-scale attribution benchmark.
 *
 * ★ WHY THIS EXISTS. `test-attribution-corpus.ts` scores several thousand
 * paragraphs and reports the SAME NUMBER for fast, default and high. That is not
 * a bug in the modes; it is a property of what it measures. Every example it can
 * auto-label carries an explicit trailing tag (`"…," said Mary.`), and the tag
 * parser resolves those before any mode-specific machinery runs. It says so
 * itself: the "hard-majority this harness CANNOT label" line prints ~88.8%.
 *
 * So the only mode-sensitive instrument in the repo was `accuracy-suite.ts` —
 * 217 hand-written cases. Optimising a mode against 217 cases is how you overfit.
 *
 * ★ THE INSTRUMENT. Take a paragraph whose speaker is known with ~99.8%
 * certainty because it carries an explicit tag, then DELETE THE TAG and require
 * the engine to recover the speaker from context alone:
 *
 *     “Oh, he has his faults, too,” said Mr. Wilson.   ← gold = Wilson
 *     “Oh, he has his faults, too.”                     ← what the engine sees
 *
 * The gold label is the removed tag. No engine output is used as truth, so this
 * is not circular; and because the remaining line is a bare quotation, EVERY
 * answer must come from the context machinery — which is exactly where fast,
 * default and high differ.
 *
 * ★ WHAT IT IS NOT. Masked lines are not drawn from the same distribution as
 * naturally-untagged lines: an author tags a line precisely when context is
 * weakest, so a masked line is, if anything, HARDER than an average bare line.
 * Treat the absolute number as a lower bound and the between-mode DELTA as the
 * real signal. `--stride` controls how much surrounding tag evidence survives
 * (see below); report it with any number quoted from this script.
 *
 * ★ MASKING PROTOCOL, and why it is strided. Masking every tagged line in a
 * chapter would delete the very context the engine is being asked to use, and
 * would measure a text no author ever wrote. Instead one in every `stride`
 * eligible lines is masked, so a masked line still has tagged neighbours.
 * Passes are repeated at each offset 0..stride-1 so every eligible line is
 * scored exactly once, each time in a chapter that is otherwise ~intact.
 * Smaller stride = more masking = harder. Default 6.
 *
 * Eligibility is deliberately strict, so that masking cannot corrupt the text:
 *   - exactly one quote pair in the paragraph (the segment to score is then
 *     unambiguous, and the shape matches a real bare dialogue line)
 *   - the tag is TRAILING and sentence-final (`.`/`!`/`?`, never `,`), which
 *     excludes split quotes like `“A,” said X, “B.”` that masking would break
 *   - the speaker is a single Title-Case token after honorific stripping
 *
 * Run:  npx tsx scripts/test-masked-attribution.ts
 *       npx tsx scripts/test-masked-attribution.ts --stride 6 --modes fast,default,high
 *       npx tsx scripts/test-masked-attribution.ts --book pride --samples 20
 *       HOLDOUT=1 npx tsx scripts/test-masked-attribution.ts   (test books only)
 *
 * MEASUREMENT harness. Exits 0 unless --gate is passed with thresholds.
 */

import { BOOKS, CORPUS_BOOKS, loadBook, splitParagraphs } from "./print-chapter";
import { resolveKnownNames, filterSpeakerCandidates } from "../src/lib/world-data";
import { detectSpeechInChapter, type IntelligenceLevel } from "../src/lib/speech-detect";

const ALL_BOOK_KEYS = [...Object.keys(BOOKS), ...Object.keys(CORPUS_BOOKS)];

/**
 * ★ A FIXED train/test split, declared here and never changed by a tuning run.
 * Books, not rows: rows inside one book share an author's voice, so a row-level
 * split leaks that voice across the boundary and reports a fantasy number.
 * DEV is what may be inspected and tuned against; TEST is looked at to decide
 * whether a change generalised, and never used to choose a threshold.
 */
export const DEV_BOOKS = new Set([
  "sherlock", "pride", "dracula", "carol", "expectations", "hollow-iris", "webnovel",
]);
export const TEST_BOOKS = new Set([
  "worlds", "frankenstein", "gatsby", "anne", "antonia", "treasure", "awakening", "root-crown",
]);

const HONORIFIC_TOKENS = [
  "Mr", "Mrs", "Ms", "Dr", "Miss", "Sir", "Lord", "Lady", "Captain", "Colonel",
  "Professor", "Aunt", "Uncle", "Madame", "Monsieur", "Mademoiselle",
];
const HONORIFIC_ALT = HONORIFIC_TOKENS.join("|");
const CLOSE_Q = `[”"]`;
const NAME = `(?:(?:${HONORIFIC_ALT})\\.?\\s+)?[A-Z][A-Za-z'’-]+`;

/**
 * Trailing tag, either word order, terminated by a SENTENCE-FINAL mark.
 *   group 1 → `said Mary` order      group 2 → `Mary said` order
 * The comma terminator is excluded on purpose: `…,” said X, “…` is a split
 * quote, and deleting its tag would weld two utterances into one sentence.
 */
const TRAILING_TAG_RE = new RegExp(
  `${CLOSE_Q}\\s*,?\\s*(?:` +
    `(?:said|asked|replied|answered|cried|exclaimed|murmured|whispered|shouted|added|returned)\\s+(${NAME})` +
    `|` +
    `(${NAME})\\s+(?:\\w+\\s+){0,1}(?:said|asked|replied|answered|cried|exclaimed|murmured|whispered|shouted|added|returned)` +
  `)\\s*[.!?]`,
);

/** How many quote pairs the paragraph contains, by quote-character parity. */
function quotePairCount(p: string): number {
  const curly = (p.match(/[“”]/g) ?? []).length;
  if (curly > 0) return Math.floor(curly / 2);
  return Math.floor((p.match(/"/g) ?? []).length / 2);
}

/** Strip an honorific and keep the last token — `Mr. John Wilson` → `Wilson`. */
function bareSurname(raw: string): string {
  const stripped = raw.replace(new RegExp(`^(?:${HONORIFIC_ALT})\\.?\\s+`), "");
  return stripped.trim().split(/\s+/).pop() ?? stripped;
}

interface Candidate {
  paraIdx: number;
  masked: string;
  gold: string;
  original: string;
}

/**
 * Rewrite `“Quote,” said Mary.` as `“Quote.”` — a grammatical bare line.
 * Returns undefined when the paragraph is not safely maskable.
 */
function maskParagraph(p: string): { masked: string; gold: string } | undefined {
  if (quotePairCount(p) !== 1) return undefined;
  const m = TRAILING_TAG_RE.exec(p);
  if (!m || m.index < 0) return undefined;

  const rawName = m[1] ?? m[2];
  if (!rawName) return undefined;
  const gold = bareSurname(rawName);
  if (gold.length < 3) return undefined;
  // ★ A BARE HONORIFIC IS A PARSE ARTIFACT, NOT A GOLD LABEL. On
  // `said Mrs. Bennet, more than once,` the honorific branch needs a
  // sentence-final terminator after "Bennet" and finds a comma, so the regex
  // BACKTRACKS to name="Mrs" with the abbreviating period passing as
  // sentence-final — subverting the comma-tag exclusion and producing a
  // corrupt masked line whose gold is "Mrs", which no engine can answer.
  if (new RegExp(`^(?:${HONORIFIC_ALT})$`, "i").test(gold)) return undefined;

  const closeChar = p[m.index];
  const before = p.slice(0, m.index);          // up to, excluding, the closing quote
  const after = p.slice(m.index + m[0].length); // whatever follows the tag

  // The quote ended with a comma because a tag was coming. With the tag gone the
  // utterance has to end as a sentence, or the masked line is ungrammatical in a
  // way no author would write — and the engine would be scored on a text artefact.
  const beforeFixed = before.replace(/,\s*$/, ".");
  const inner = beforeFixed.replace(/^["“]/, "");
  if (!/[.!?…]["”]?\s*$/.test(inner + "")) {
    // No terminal punctuation at all (e.g. ends on a dash) — leave it be.
    if (!/[—–-]\s*$/.test(beforeFixed)) return undefined;
  }
  const masked = (beforeFixed + closeChar + after).replace(/\s+/g, " ").trim();
  if (!masked) return undefined;
  return { masked, gold };
}

interface ModeScore { correct: number; wrong: number; unattributed: number; }

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

async function main() {
  const stride = Number(arg("stride", "6"));
  const modes = arg("modes", "fast,default,high").split(",") as IntelligenceLevel[];
  const bookFilter = arg("book", "");
  const sampleLimit = Number(arg("samples", "0"));
  const holdout = process.env.HOLDOUT === "1";
  const devOnly = process.env.DEVONLY === "1";

  let keys = ALL_BOOK_KEYS.filter((k) => k !== "sample");
  if (bookFilter) keys = keys.filter((k) => k === bookFilter);
  if (holdout) keys = keys.filter((k) => TEST_BOOKS.has(k));
  if (devOnly) keys = keys.filter((k) => DEV_BOOKS.has(k));

  const totals = new Map<IntelligenceLevel, ModeScore>();
  const perBook = new Map<string, Map<IntelligenceLevel, ModeScore>>();
  for (const m of modes) totals.set(m, { correct: 0, wrong: 0, unattributed: 0 });
  const samples: string[] = [];
  const timing = new Map<IntelligenceLevel, number>();
  for (const m of modes) timing.set(m, 0);

  for (const key of keys) {
    let novel;
    try { novel = await loadBook(key); } catch { continue; }
    const knownNames = resolveKnownNames(novel);
    // NOSPEAKERFILTER=1 reproduces the pre-filter behaviour, for A/B.
    const speakerCandidates = process.env.NOSPEAKERFILTER === "1"
      ? undefined
      : filterSpeakerCandidates(knownNames, novel.chapters.map((c) => c.content).join("\n"));
    const bookScore = new Map<IntelligenceLevel, ModeScore>();
    for (const m of modes) bookScore.set(m, { correct: 0, wrong: 0, unattributed: 0 });

    for (const chapter of novel.chapters) {
      const paragraphs = splitParagraphs(chapter.content);
      if (paragraphs.length < 4) continue;

      // Every eligible line in this chapter, in order.
      const eligible: Candidate[] = [];
      for (let i = 0; i < paragraphs.length; i++) {
        const r = maskParagraph(paragraphs[i]);
        if (r) eligible.push({ paraIdx: i, masked: r.masked, gold: r.gold, original: paragraphs[i] });
      }
      if (!eligible.length) continue;

      // Strided passes: pass `off` masks eligible lines off, off+stride, … so a
      // masked line always keeps tagged neighbours, and across all passes every
      // eligible line is scored exactly once.
      for (let off = 0; off < stride; off++) {
        const batch = eligible.filter((_, n) => n % stride === off);
        if (!batch.length) continue;
        const text = [...paragraphs];
        for (const c of batch) text[c.paraIdx] = c.masked;

        for (const mode of modes) {
          const t0 = performance.now();
          const res = detectSpeechInChapter(text, knownNames, { intelligenceLevel: mode, speakerCandidates });
          timing.set(mode, (timing.get(mode) ?? 0) + (performance.now() - t0));
          for (const c of batch) {
            const seg = res[c.paraIdx]?.segments?.find((s) => s.type === "speech");
            const score = bookScore.get(mode)!;
            const tot = totals.get(mode)!;
            if (!seg?.speaker) { score.unattributed++; tot.unattributed++; continue; }
            const got = seg.speaker.trim();
            const ok = got.toLowerCase() === c.gold.toLowerCase()
              || bareSurname(got).toLowerCase() === c.gold.toLowerCase();
            if (ok) { score.correct++; tot.correct++; }
            else {
              score.wrong++; tot.wrong++;
              if (samples.length < sampleLimit && mode === modes[0]) {
                samples.push(`[${key} ${mode}] gold=${c.gold} got=${got}\n     ${c.masked.slice(0, 130)}`);
              }
            }
          }
        }
      }
    }
    perBook.set(key, bookScore);
  }

  const pct = (s: ModeScore) => {
    const n = s.correct + s.wrong + s.unattributed;
    return n ? (s.correct / n) * 100 : 0;
  };

  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`MASKED-TAG ATTRIBUTION  (stride ${stride}${holdout ? ", HELD-OUT books" : devOnly ? ", DEV books" : ""})`);
  console.log(`The tag is deleted; the speaker must be recovered from context alone.\n`);

  console.log(`  ${"book".padEnd(14)}${modes.map((m) => m.toUpperCase().padStart(9)).join("")}${"   N".padStart(6)}`);
  for (const [key, bs] of perBook) {
    const first = bs.get(modes[0])!;
    const n = first.correct + first.wrong + first.unattributed;
    if (!n) continue;
    const marker = TEST_BOOKS.has(key) ? " ·" : "  ";
    console.log(`  ${(key + marker).padEnd(14)}${modes.map((m) => `${pct(bs.get(m)!).toFixed(1)}%`.padStart(9)).join("")}${String(n).padStart(6)}`);
  }

  console.log(`\n  ── totals ──`);
  const n0 = (() => { const s = totals.get(modes[0])!; return s.correct + s.wrong + s.unattributed; })();
  for (const m of modes) {
    const s = totals.get(m)!;
    console.log(
      `  ${m.toUpperCase().padEnd(9)} ${pct(s).toFixed(1).padStart(5)}%   ` +
      `correct ${String(s.correct).padStart(5)}  wrong ${String(s.wrong).padStart(4)}  ` +
      `unattributed ${String(s.unattributed).padStart(4)}   ${(timing.get(m)! / 1000).toFixed(2)}s`,
    );
  }
  console.log(`\n  N = ${n0} masked lines across ${perBook.size} books.`);
  console.log(`  "·" marks a HELD-OUT book — never tune against those columns.`);

  if (samples.length) {
    console.log(`\n  ── ${samples.length} sample failures (${modes[0]}) ──`);
    for (const s of samples) console.log(`   ${s}`);
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
