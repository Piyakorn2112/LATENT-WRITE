/**
 * dump-masked-failures.ts — print bare-line attribution failures WITH CONTEXT.
 *
 * The funnel says what class each failure is in; it cannot say what the prose
 * looked like. Every high-yield fix in this engine so far came from reading the
 * actual text around a failure, not from a bucket count, so this prints the
 * preceding paragraphs the engine had available, what it answered, and what the
 * deleted tag said.
 *
 * BOOK= restricts to one register. ONLY=engine-picked-wrong hides unattributed.
 * RUNPOS=1 additionally reports accuracy by position within a run of
 * consecutive dialogue paragraphs, which is where turn-taking either holds or
 * drifts.
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
const isDialogue = (p: string) => quotePairCount(p) >= 1;

const MODE = (process.env.MODE ?? "fast") as IntelligenceLevel;
const STRIDE = Number(process.env.STRIDE ?? 6);
const LIMIT = Number(process.env.LIMIT ?? 25);
const BOOK = process.env.BOOK ?? "";
const ONLY = process.env.ONLY ?? "";

async function main() {
  let shown = 0;
  // accuracy by position in a run of consecutive dialogue paragraphs
  const byRunPos = new Map<number, { ok: number; n: number }>();

  for (const key of ALL_BOOK_KEYS) {
    if (BOOK && key !== BOOK) continue;
    let novel;
    try { novel = await loadBook(key); } catch { continue; }
    const knownNames = resolveKnownNames(novel);
    const speakerCandidates = filterSpeakerCandidates(knownNames, novel.chapters.map((c) => c.content).join("\n"));

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
        const batch = eligible.filter((_, k) => k % STRIDE === off);
        if (!batch.length) continue;
        const text = [...paragraphs];
        for (const b of batch) text[b.i] = b.masked;
        const res = detectSpeechInChapter(text, knownNames, { intelligenceLevel: MODE, speakerCandidates });

        for (const b of batch) {
          const seg = res[b.i]?.segments?.find((s) => s.type === "speech");
          const got = seg?.speaker?.trim();
          const ok = !!got && bareSurname(got).toLowerCase() === b.gold.toLowerCase();

          // how deep into a consecutive-dialogue run is this line?
          let runPos = 0;
          for (let j = b.i - 1; j >= 0 && isDialogue(text[j]); j--) runPos++;
          const slot = Math.min(runPos, 6);
          const cell = byRunPos.get(slot) ?? { ok: 0, n: 0 };
          cell.n++; if (ok) cell.ok++;
          byRunPos.set(slot, cell);

          if (ok || shown >= LIMIT) continue;
          if (ONLY === "engine-picked-wrong" && !got) continue;
          if (ONLY === "unattributed" && got) continue;
          shown++;
          console.log(`\n──── ${key} ch${chapter.number} para${b.i}  GOLD=${b.gold}  GOT=${got ?? "(none)"}  runPos=${runPos}`);
          for (let j = Math.max(0, b.i - 3); j < b.i; j++) {
            const spk = res[j]?.segments?.find((s) => s.type === "speech")?.speaker;
            console.log(`   ${String(j).padStart(4)}${spk ? ` [${spk}]` : "     "} ${text[j].slice(0, 128)}`);
          }
          console.log(`   ${String(b.i).padStart(4)} >>>  ${b.masked.slice(0, 128)}`);
        }
      }
    }
  }

  console.log(`\n\n═══ accuracy by depth into a consecutive-dialogue run (mode=${MODE}) ═══`);
  for (const [pos, c] of [...byRunPos].sort((a, b) => a[0] - b[0])) {
    console.log(`  runPos ${pos === 6 ? "6+" : pos}  ${((c.ok / c.n) * 100).toFixed(1).padStart(5)}%   n=${c.n}`);
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
