/**
 * probe-masked-failures.ts — WHY does bare-line attribution fail?
 *
 * `test-masked-attribution.ts` says all three modes sit at ~45% on real prose
 * with the tag deleted, and that the wrong answers are frequently names like
 * `Council`, `Voice`, `Ananke` — which look less like a resolution mistake and
 * more like the CAST being polluted before speech-detect ever runs.
 *
 * Counting the funnel beats hypothesising about it, so this splits every failure
 * into causes that have different fixes and live in different modules:
 *
 *   gold-not-in-cast     the correct name was never extracted → world-data's
 *                        problem, and the engine could not win no matter what
 *   picked-a-non-speaker the predicted name never appears in ANY explicit speech
 *                        tag in the whole book → a distractor that cast
 *                        extraction should not have admitted
 *   picked-a-speaker     both names are real speaking characters → a genuine
 *                        resolution error, and the only class speech-detect owns
 *   unattributed         no answer offered
 *
 * Also reports the ORACLE-CAST ablation: rerun with knownNames restricted to
 * names that appear in at least one explicit tag somewhere in the book. That is
 * not a shippable configuration (it reads the whole book to decide), it is the
 * measurement that says how much headroom is locked behind cast quality.
 */

import { BOOKS, CORPUS_BOOKS, loadBook, splitParagraphs } from "./print-chapter";
import { resolveKnownNames } from "../src/lib/world-data";
import { detectSpeechInChapter, type IntelligenceLevel } from "../src/lib/speech-detect";

const ALL_BOOK_KEYS = [...Object.keys(BOOKS), ...Object.keys(CORPUS_BOOKS)].filter((k) => k !== "sample");

const HONORIFIC_ALT = [
  "Mr", "Mrs", "Ms", "Dr", "Miss", "Sir", "Lord", "Lady", "Captain", "Colonel",
  "Professor", "Aunt", "Uncle", "Madame", "Monsieur", "Mademoiselle",
].join("|");
const CLOSE_Q = `[”"]`;
const NAME = `(?:(?:${HONORIFIC_ALT})\\.?\\s+)?[A-Z][A-Za-z'’-]+`;
const VERBS = "said|asked|replied|answered|cried|exclaimed|murmured|whispered|shouted|added|returned";
const TRAILING_TAG_RE = new RegExp(
  `${CLOSE_Q}\\s*,?\\s*(?:(?:${VERBS})\\s+(${NAME})|(${NAME})\\s+(?:\\w+\\s+){0,1}(?:${VERBS}))\\s*[.!?]`,
);

function quotePairCount(p: string): number {
  const curly = (p.match(/[“”]/g) ?? []).length;
  if (curly > 0) return Math.floor(curly / 2);
  return Math.floor((p.match(/"/g) ?? []).length / 2);
}
function bareSurname(raw: string): string {
  const s = raw.replace(new RegExp(`^(?:${HONORIFIC_ALT})\\.?\\s+`), "");
  return s.trim().split(/\s+/).pop() ?? s;
}
function maskParagraph(p: string): { masked: string; gold: string } | undefined {
  if (quotePairCount(p) !== 1) return undefined;
  const m = TRAILING_TAG_RE.exec(p);
  if (!m || m.index < 0) return undefined;
  const rawName = m[1] ?? m[2];
  if (!rawName) return undefined;
  const gold = bareSurname(rawName);
  if (gold.length < 3) return undefined;
  const before = p.slice(0, m.index);
  const after = p.slice(m.index + m[0].length);
  const beforeFixed = before.replace(/,\s*$/, ".");
  const inner = beforeFixed.replace(/^["“]/, "");
  if (!/[.!?…]["”]?\s*$/.test(inner) && !/[—–-]\s*$/.test(beforeFixed)) return undefined;
  const masked = (beforeFixed + p[m.index] + after).replace(/\s+/g, " ").trim();
  return masked ? { masked, gold } : undefined;
}

/** Every name that carries an explicit speech tag anywhere in the book. */
function taggedSpeakers(paragraphs: string[]): Set<string> {
  const out = new Set<string>();
  const g = new RegExp(TRAILING_TAG_RE.source, "g");
  for (const p of paragraphs) {
    g.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = g.exec(p))) {
      const raw = m[1] ?? m[2];
      if (raw) out.add(bareSurname(raw).toLowerCase());
    }
  }
  return out;
}

const MODE = (process.env.MODE ?? "fast") as IntelligenceLevel;
const STRIDE = Number(process.env.STRIDE ?? 6);

async function main() {
  const causes = { goldNotInCast: 0, pickedNonSpeaker: 0, pickedSpeaker: 0, unattributed: 0, correct: 0 };
  let oracleCorrect = 0, oracleTotal = 0;
  const junkPicks = new Map<string, number>();
  let castSize = 0, castSpeakers = 0, books = 0;

  for (const key of ALL_BOOK_KEYS) {
    let novel;
    try { novel = await loadBook(key); } catch { continue; }
    const knownNames = resolveKnownNames(novel);

    // Book-wide tagged-speaker set, for the oracle cast and the junk test.
    const allParas: string[] = [];
    for (const c of novel.chapters) allParas.push(...splitParagraphs(c.content));
    const speakers = taggedSpeakers(allParas);
    const oracleCast = knownNames.filter((n) => speakers.has(bareSurname(n).toLowerCase()));
    castSize += knownNames.length; castSpeakers += oracleCast.length; books++;

    for (const chapter of novel.chapters) {
      const paragraphs = splitParagraphs(chapter.content);
      if (paragraphs.length < 4) continue;
      const eligible: Array<{ i: number; masked: string; gold: string }> = [];
      for (let i = 0; i < paragraphs.length; i++) {
        const r = maskParagraph(paragraphs[i]);
        if (r) eligible.push({ i, masked: r.masked, gold: r.gold });
      }
      if (!eligible.length) continue;

      for (let off = 0; off < STRIDE; off++) {
        const batch = eligible.filter((_, n) => n % STRIDE === off);
        if (!batch.length) continue;
        const text = [...paragraphs];
        for (const c of batch) text[c.i] = c.masked;

        const res = detectSpeechInChapter(text, knownNames, { intelligenceLevel: MODE });
        const ora = detectSpeechInChapter(text, oracleCast, { intelligenceLevel: MODE });

        for (const c of batch) {
          const inCast = knownNames.some((n) => bareSurname(n).toLowerCase() === c.gold.toLowerCase());
          const seg = res[c.i]?.segments?.find((s) => s.type === "speech");
          const got = seg?.speaker?.trim();
          const ok = !!got && (got.toLowerCase() === c.gold.toLowerCase()
            || bareSurname(got).toLowerCase() === c.gold.toLowerCase());

          if (ok) causes.correct++;
          else if (!got) causes.unattributed++;
          else if (!inCast) causes.goldNotInCast++;
          else if (!speakers.has(bareSurname(got).toLowerCase())) {
            causes.pickedNonSpeaker++;
            junkPicks.set(got, (junkPicks.get(got) ?? 0) + 1);
          } else causes.pickedSpeaker++;

          const osg = ora[c.i]?.segments?.find((s) => s.type === "speech");
          const ogot = osg?.speaker?.trim();
          oracleTotal++;
          if (ogot && (ogot.toLowerCase() === c.gold.toLowerCase()
            || bareSurname(ogot).toLowerCase() === c.gold.toLowerCase())) oracleCorrect++;
        }
      }
    }
  }

  const n = Object.values(causes).reduce((a, b) => a + b, 0);
  console.log(`\n═══ WHY BARE-LINE ATTRIBUTION FAILS  (mode=${MODE}, stride=${STRIDE}, N=${n}) ═══\n`);
  const row = (label: string, v: number) =>
    console.log(`  ${label.padEnd(22)} ${String(v).padStart(5)}  ${((v / n) * 100).toFixed(1).padStart(5)}%`);
  row("correct", causes.correct);
  row("gold-not-in-cast", causes.goldNotInCast);
  row("picked-a-non-speaker", causes.pickedNonSpeaker);
  row("picked-a-speaker", causes.pickedSpeaker);
  row("unattributed", causes.unattributed);

  console.log(`\n  ORACLE-CAST ABLATION (cast = names that carry a tag somewhere in the book)`);
  console.log(`    real cast   ${((causes.correct / n) * 100).toFixed(1)}%`);
  console.log(`    oracle cast ${((oracleCorrect / oracleTotal) * 100).toFixed(1)}%   ` +
    `(+${((oracleCorrect / oracleTotal - causes.correct / n) * 100).toFixed(1)}pp)`);
  console.log(`    cast size: ${castSize} names over ${books} books; only ${castSpeakers} ` +
    `(${((castSpeakers / castSize) * 100).toFixed(0)}%) ever carry a speech tag.`);

  console.log(`\n  most-picked non-speakers:`);
  for (const [nme, c] of [...junkPicks].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
    console.log(`    ${nme.padEnd(22)} ${c}`);
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
