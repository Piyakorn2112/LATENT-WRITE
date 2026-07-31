/**
 * probe-stage-direction.ts — when a narrative paragraph is followed by a bare
 * quote, who speaks?
 *
 * Reading failures with context showed one shape over and over:
 *
 *     At the edge of the plaza, Iris stopped. She turned to Nora.
 *     "Thank you for coming."              gold Iris, engine answered Nora
 *
 * A paragraph of stage direction sets up an actor and that actor speaks. It is
 * the commonest staging convention in fiction, and the engine loses it because
 * the chapter-wide mention prior is dominated by the point-of-view character,
 * who drowns the LOCAL subject every time.
 *
 * It is also the biggest bucket there is: measured by depth into a run of
 * consecutive dialogue paragraphs, runPos 0 — the first quote after narrative —
 * is 369 of 798 masked lines and the WEAKEST at 39.3%, while every deeper
 * position sits between 49% and 62%.
 *
 * Before writing a rule, measure which local cue actually predicts the speaker.
 * Each candidate below is scored ONLY on runPos-0 lines, as
 * coverage (how often the cue fires) and accuracy-when-fired.
 * A cue that fires rarely is not worth a branch in the hot path; a cue that
 * fires often and is wrong is worse than nothing.
 */

import { BOOKS, CORPUS_BOOKS, loadBook, splitParagraphs } from "./print-chapter";
import { resolveKnownNames, filterSpeakerCandidates } from "../src/lib/world-data";
import { detectSpeechInChapter, type IntelligenceLevel } from "../src/lib/speech-detect";

const ALL_BOOK_KEYS = [...Object.keys(BOOKS), ...Object.keys(CORPUS_BOOKS)].filter((k) => k !== "sample");

const HONORIFIC_ALT = [
  "Mr", "Mrs", "Ms", "Dr", "Miss", "Sir", "Lord", "Lady", "Captain", "Colonel",
  "Professor", "Aunt", "Uncle", "Madame", "Monsieur", "Mademoiselle",
].join("|");
const VERBS = "said|asked|replied|answered|cried|exclaimed|murmured|whispered|shouted|added|returned";
const NAME = `(?:(?:${HONORIFIC_ALT})\\.?\\s+)?[A-Z][A-Za-z'’-]+`;
const TAG_RE = new RegExp(
  `[”"]\\s*,?\\s*(?:(?:${VERBS})\\s+(${NAME})|(${NAME})\\s+(?:\\w+\\s+){0,1}(?:${VERBS}))\\s*[.!?]`);

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
  const m = TAG_RE.exec(p);
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
function esc(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Non-possessive mentions of `names` in `text`, in order of appearance. */
function mentions(text: string, names: readonly string[]): Array<{ name: string; at: number; poss: boolean }> {
  const out: Array<{ name: string; at: number; poss: boolean }> = [];
  for (const n of names) {
    const re = new RegExp(`\\b${esc(n)}\\b(['’]s)?`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push({ name: n, at: m.index, poss: !!m[1] });
  }
  return out.sort((a, b) => a.at - b.at);
}
/** The last sentence of a paragraph. */
function lastSentence(p: string): string {
  const parts = p.split(/(?<=[.!?…])\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
const isDialogue = (p: string) => quotePairCount(p) >= 1;

interface Cue { name: string; fn: (prev: string, names: readonly string[]) => string | undefined; }

const CUES: Cue[] = [
  {
    name: "first non-possessive mention",
    fn: (prev, names) => mentions(prev, names).find((m) => !m.poss)?.name,
  },
  {
    name: "last non-possessive mention",
    fn: (prev, names) => [...mentions(prev, names)].reverse().find((m) => !m.poss)?.name,
  },
  {
    name: "subject of LAST sentence",
    fn: (prev, names) => mentions(lastSentence(prev), names).find((m) => !m.poss)?.name,
  },
  {
    name: "most-mentioned in paragraph",
    fn: (prev, names) => {
      const c = new Map<string, number>();
      for (const m of mentions(prev, names)) if (!m.poss) c.set(m.name, (c.get(m.name) ?? 0) + 1);
      return [...c].sort((a, b) => b[1] - a[1])[0]?.[0];
    },
  },
  {
    name: "ONLY name in paragraph (unique)",
    fn: (prev, names) => {
      const uniq = new Set(mentions(prev, names).filter((m) => !m.poss).map((m) => m.name));
      return uniq.size === 1 ? [...uniq][0] : undefined;
    },
  },
  {
    name: "ONLY name in LAST sentence",
    fn: (prev, names) => {
      const uniq = new Set(mentions(lastSentence(prev), names).filter((m) => !m.poss).map((m) => m.name));
      return uniq.size === 1 ? [...uniq][0] : undefined;
    },
  },
];

const MODE = (process.env.MODE ?? "fast") as IntelligenceLevel;
const STRIDE = Number(process.env.STRIDE ?? 6);

async function main() {
  // For each cue, scored ONLY where it fires, head to head with the engine.
  const stats = CUES.map(() => ({ fired: 0, right: 0, engineRight: 0, cueWinsAlone: 0, engineWinsAlone: 0 }));
  let n = 0, engineAll = 0;

  for (const key of ALL_BOOK_KEYS) {
    let novel;
    try { novel = await loadBook(key); } catch { continue; }
    const all = resolveKnownNames(novel);
    const names = filterSpeakerCandidates(all, novel.chapters.map((c) => c.content).join("\n"));

    for (const chapter of novel.chapters) {
      const paragraphs = splitParagraphs(chapter.content);
      if (paragraphs.length < 4) continue;
      const eligible: Array<{ i: number; masked: string; gold: string }> = [];
      for (let i = 1; i < paragraphs.length; i++) {
        const r = maskParagraph(paragraphs[i]);
        if (r) eligible.push({ i, masked: r.masked, gold: r.gold });
      }
      if (!eligible.length) continue;

      for (let off = 0; off < STRIDE; off++) {
        const batch = eligible.filter((_, k) => k % STRIDE === off);
        if (!batch.length) continue;
        const text = [...paragraphs];
        for (const b of batch) text[b.i] = b.masked;
        const res = detectSpeechInChapter(text, names, { intelligenceLevel: MODE });

        for (const b of batch) {
          // runPos 0 only: the preceding paragraph must be NARRATIVE.
          if (b.i === 0 || isDialogue(text[b.i - 1])) continue;
          n++;
          const prev = text[b.i - 1];
          const got = res[b.i]?.segments?.find((s) => s.type === "speech")?.speaker;
          const engineOk = !!got && bareSurname(got).toLowerCase() === b.gold.toLowerCase();
          if (engineOk) engineAll++;

          CUES.forEach((c, k) => {
            const guess = c.fn(prev, names);
            if (!guess) return;
            const s = stats[k];
            s.fired++;
            const cueOk = bareSurname(guess).toLowerCase() === b.gold.toLowerCase();
            if (cueOk) s.right++;
            if (engineOk) s.engineRight++;
            if (cueOk && !engineOk) s.cueWinsAlone++;
            if (!cueOk && engineOk) s.engineWinsAlone++;
          });
        }
      }
    }
  }

  console.log(`\n═══ WHO SPEAKS AFTER A NARRATIVE PARAGRAPH?  (${n} runPos-0 masked lines, mode=${MODE}) ═══`);
  console.log(`  The engine gets ${((engineAll / n) * 100).toFixed(1)}% of these today.\n`);
  console.log(`  ${"cue".padEnd(32)}${"fires".padStart(7)}${"cue".padStart(8)}${"engine".padStart(8)}   ${"cue-only"}  ${"eng-only"}   max gain`);
  CUES.forEach((c, k) => {
    const s = stats[k];
    const cue = s.fired ? (s.right / s.fired) * 100 : 0;
    const eng = s.fired ? (s.engineRight / s.fired) * 100 : 0;
    console.log(
      `  ${c.name.padEnd(32)}${String(s.fired).padStart(7)}` +
      `${cue.toFixed(1).padStart(7)}%${eng.toFixed(1).padStart(7)}%` +
      `${String(s.cueWinsAlone).padStart(11)}${String(s.engineWinsAlone).padStart(10)}` +
      `${`+${((s.cueWinsAlone / n) * 100).toFixed(1)}pp`.padStart(11)}`);
  });
  console.log(`\n  "cue"/"engine" are both scored on the SAME subset — where that cue fires.`);
  console.log(`  cue-only = cue right where engine wrong (the win). eng-only = the cost of`);
  console.log(`  overriding blindly. "max gain" assumes the cue overrides only when it wins,`);
  console.log(`  which is an upper bound no real rule reaches.\n`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
