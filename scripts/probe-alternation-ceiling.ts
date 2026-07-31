/**
 * probe-alternation-ceiling.ts — how much of bare-line attribution is just
 * TURN-TAKING, and how much does the engine already get from it?
 *
 * The failure funnel says 28.1% of masked lines are picked-a-speaker errors:
 * both names are real characters, so this is resolution, not cast pollution.
 * Before writing any rule, measure what the cheap structural rules would score
 * if their inputs were perfect. That sets the ceiling and says which rule is
 * worth implementing — a rule whose oracle ceiling is 30% is not worth shipping
 * however elegant it is.
 *
 * For each masked line at paragraph i, using the GOLD tags of the surrounding
 * paragraphs (i.e. assuming neighbour attribution were perfect):
 *
 *   alternate-2   gold == speaker of the previous TAGGED dialogue line but one
 *                 (strict A/B/A/B turn-taking)
 *   continue-1    gold == speaker of the immediately previous tagged line
 *   third-party   gold is neither — someone else entered the exchange
 *   no-context    no tagged line within the lookback window
 *
 * `alternate-2` is the interesting one: in a two-hander it is nearly always the
 * right answer, and it needs no name matching, no gender map and no scoring —
 * it is the cheapest possible signal, which matters because FAST mode is what
 * runs on the typing path.
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
const TAG_SRC = `${CLOSE_Q}\\s*,?\\s*(?:(?:${VERBS})\\s+(${NAME})|(${NAME})\\s+(?:\\w+\\s+){0,1}(?:${VERBS}))\\s*[.!?]`;
const TRAILING_TAG_RE = new RegExp(TAG_SRC);

function quotePairCount(p: string): number {
  const curly = (p.match(/[“”]/g) ?? []).length;
  if (curly > 0) return Math.floor(curly / 2);
  return Math.floor((p.match(/"/g) ?? []).length / 2);
}
function bareSurname(raw: string): string {
  const s = raw.replace(new RegExp(`^(?:${HONORIFIC_ALT})\\.?\\s+`), "");
  return s.trim().split(/\s+/).pop() ?? s;
}
/** The tagged speaker of a paragraph, if it carries one. */
function tagOf(p: string): string | undefined {
  const m = TRAILING_TAG_RE.exec(p);
  const raw = m?.[1] ?? m?.[2];
  return raw ? bareSurname(raw) : undefined;
}
function maskParagraph(p: string): { masked: string; gold: string } | undefined {
  if (quotePairCount(p) !== 1) return undefined;
  const m = TRAILING_TAG_RE.exec(p);
  if (!m || m.index < 0) return undefined;
  const raw = m[1] ?? m[2];
  if (!raw) return undefined;
  const gold = bareSurname(raw);
  if (gold.length < 3) return undefined;
  const before = p.slice(0, m.index);
  const after = p.slice(m.index + m[0].length);
  const beforeFixed = before.replace(/,\s*$/, ".");
  const inner = beforeFixed.replace(/^["“]/, "");
  if (!/[.!?…]["”]?\s*$/.test(inner) && !/[—–-]\s*$/.test(beforeFixed)) return undefined;
  const masked = (beforeFixed + p[m.index] + after).replace(/\s+/g, " ").trim();
  return masked ? { masked, gold } : undefined;
}

const MODE = (process.env.MODE ?? "fast") as IntelligenceLevel;
const STRIDE = Number(process.env.STRIDE ?? 6);
const LOOKBACK = Number(process.env.LOOKBACK ?? 6);

async function main() {
  const c = { alternate2: 0, continue1: 0, thirdParty: 0, noContext: 0 };
  // Cross-tab: does the ENGINE get the ones alternation would have got?
  const alt = { engineRight: 0, engineWrong: 0 };
  const cont = { engineRight: 0, engineWrong: 0 };
  let n = 0;

  for (const key of ALL_BOOK_KEYS) {
    let novel;
    try { novel = await loadBook(key); } catch { continue; }
    const knownNames = resolveKnownNames(novel);

    for (const chapter of novel.chapters) {
      const paragraphs = splitParagraphs(chapter.content);
      if (paragraphs.length < 4) continue;
      const tags = paragraphs.map(tagOf);

      const eligible: Array<{ i: number; masked: string; gold: string }> = [];
      for (let i = 0; i < paragraphs.length; i++) {
        const r = maskParagraph(paragraphs[i]);
        if (r) eligible.push({ i, masked: r.masked, gold: r.gold });
      }
      if (!eligible.length) continue;

      for (let off = 0; off < STRIDE; off++) {
        const batch = eligible.filter((_, k) => k % STRIDE === off);
        if (!batch.length) continue;
        const text = [...paragraphs];
        for (const b of batch) text[b.i] = b.masked;
        const res = detectSpeechInChapter(text, knownNames, { intelligenceLevel: MODE });

        for (const b of batch) {
          n++;
          // Walk back over the ORIGINAL tags, skipping this batch's masked lines
          // (their tags are not visible to the engine either).
          const masked = new Set(batch.map((x) => x.i));
          const prior: string[] = [];
          for (let j = b.i - 1; j >= 0 && b.i - j <= LOOKBACK && prior.length < 2; j--) {
            if (masked.has(j)) continue;
            const t = tags[j];
            if (t) prior.push(t);
          }
          const seg = res[b.i]?.segments?.find((s) => s.type === "speech");
          const got = seg?.speaker?.trim();
          const engineOk = !!got && bareSurname(got).toLowerCase() === b.gold.toLowerCase();

          const g = b.gold.toLowerCase();
          if (!prior.length) { c.noContext++; continue; }
          if (prior[0].toLowerCase() === g) {
            c.continue1++;
            if (engineOk) cont.engineRight++; else cont.engineWrong++;
          } else if (prior[1] && prior[1].toLowerCase() === g) {
            c.alternate2++;
            if (engineOk) alt.engineRight++; else alt.engineWrong++;
          } else c.thirdParty++;
        }
      }
    }
  }

  console.log(`\n═══ STRUCTURE OF BARE DIALOGUE LINES (mode=${MODE}, stride=${STRIDE}, N=${n}) ═══\n`);
  const row = (l: string, v: number) =>
    console.log(`  ${l.padEnd(28)} ${String(v).padStart(5)}  ${((v / n) * 100).toFixed(1).padStart(5)}%`);
  row("alternate-2 (A/B/A turn)", c.alternate2);
  row("continue-1 (same speaker)", c.continue1);
  row("third-party (someone else)", c.thirdParty);
  row("no tagged line in lookback", c.noContext);

  console.log(`\n  Does the engine already exploit these?`);
  console.log(`    of the ${c.alternate2} alternate-2 lines: engine right ${alt.engineRight} ` +
    `(${((alt.engineRight / Math.max(1, c.alternate2)) * 100).toFixed(1)}%), wrong ${alt.engineWrong}`);
  console.log(`    of the ${c.continue1} continue-1 lines:  engine right ${cont.engineRight} ` +
    `(${((cont.engineRight / Math.max(1, c.continue1)) * 100).toFixed(1)}%), wrong ${cont.engineWrong}`);
  console.log(`\n  Headroom if alternate-2 were resolved perfectly: ` +
    `+${((alt.engineWrong / n) * 100).toFixed(1)}pp`);
  console.log(`  Headroom if continue-1 were resolved perfectly:  ` +
    `+${((cont.engineWrong / n) * 100).toFixed(1)}pp\n`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
