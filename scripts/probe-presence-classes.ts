/**
 * probe-presence-classes.ts — is a name in a chapter the same thing as a
 * character IN that chapter?
 *
 * The timeline's cast ledger drew a bar whenever a character's name matched
 * anywhere in a chapter (`buildTimelineCharacterTracks`, countMatchers), and
 * `charactersPresent` came from a bare `chapter.content.includes(c.name)`. Both
 * said PRESENT for a woman three counties away whose sister mentions her.
 *
 * The literature has a name for the distinction and pointedly does NOT solve
 * it: the Corpus Novelties NER guidelines annotate presence and evocation
 * IDENTICALLY and say "we assume that distinguishing both types of entity
 * mentions (presence vs. evocation) can be done in a later step". So there is
 * no gold set to borrow and no off-the-shelf classifier.
 *
 * ★ THIS RUNS THE SHIPPED MODULE, NOT A COPY OF ITS REGEXES. An earlier probe
 *   in this repo re-implemented the pattern it was measuring and so scored
 *   prose the shipped filters already rejected, which made every filter look
 *   useless. Only `dialogueTagCount` below is local, and it is scaffolding —
 *   it picks the cast, it is not under test.
 *
 *   /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs scripts/probe-presence-classes.ts
 */
import { loadBook } from "./print-chapter";
import { resolveSpeakerCandidates } from "../src/lib/world-data";
import { classifyChapterPresence, type CharacterPresence } from "../src/lib/character-presence";

// ★ DEV half of the fixed split, INLINED. Importing it from
//   test-masked-attribution runs that module's main() — 786 masked lines and
//   45s of attribution — as a side effect of asking for a constant.
const BOOKS = ["sherlock", "pride", "dracula", "carol", "expectations", "webnovel"];
const MAX_CHAPTERS = 14;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TAG_VERB =
  "(?:said|says|asked|asks|replied|answered|cried|whispered|shouted|murmured|" +
  "added|told|muttered|observed|remarked|exclaimed|repeated|returned|called)";

/**
 * How many times the whole book tags this name as a speaker — the CAST FILTER,
 * and it is part of the measurement rather than setup. resolveSpeakerCandidates
 * returns speaker CANDIDATES; on Sherlock that list holds "London", "Baker
 * Street" and "Let". Two tags means a person. The quote adjacency is what
 * disambiguates "he returned to England" from "'Yes,' he returned".
 */
function dialogueTagCount(text: string, name: string): number {
  const n = esc(name);
  const g = (src: string) => (text.match(new RegExp(src, "g")) ?? []).length;
  return (
    g(`["”]\\s*[,.]?\\s*(?:${TAG_VERB}\\s+${n}|${n}\\s+(?:\\w+\\s+){0,2}${TAG_VERB})\\b`) +
    g(`\\b(?:${TAG_VERB}\\s+${n}|${n}\\s+(?:\\w+\\s+){0,2}${TAG_VERB})\\b\\s*[,:]?\\s*["“]`)
  );
}

const CLASSES = ["speaking", "present", "mentioned"] as const;

async function main() {
  console.log("═".repeat(78));
  console.log("presence vs evocation — what the ledger's bars actually mean");
  console.log("═".repeat(78));

  let marks = 0, chapters = 0, uncertain = 0;
  const byClass = new Map<string, number>();
  const samples = new Map<string, string[]>();
  const bump = (k: string, s?: string) => {
    byClass.set(k, (byClass.get(k) ?? 0) + 1);
    if (!s) return;
    const list = samples.get(k) ?? [];
    if (list.length < 7) { list.push(s); samples.set(k, list); }
  };

  for (const book of BOOKS) {
    const novel = await loadBook(book);
    const whole = novel.chapters.map((c) => c.content).join("\n");
    const candidates = resolveSpeakerCandidates(novel);
    const cast = candidates
      .filter((n) => dialogueTagCount(whole, n) >= 2)
      .slice(0, 12)
      .map((name) => ({ name, variants: [] as string[] }));
    if (cast.length < 3) { console.log(`  (${book}: cast too small — ${cast.length})`); continue; }

    let bookMarks = 0, bookMentioned = 0;
    for (const chapter of novel.chapters.slice(0, MAX_CHAPTERS)) {
      chapters++;
      const results: CharacterPresence[] = classifyChapterPresence(chapter.content, cast);
      for (const p of results) {
        if (p.klass === "absent") continue;   // no mark drawn, nothing to judge
        marks++; bookMarks++;
        if (p.uncertain) uncertain++;
        if (p.klass === "mentioned") bookMentioned++;
        bump(p.uncertain ? `${p.klass} (uncertain)` : p.klass,
          `${book} ch${chapter.number} ${p.name}: ${p.cue.slice(0, 105)}`);
      }
    }
    console.log(`  ${book.padEnd(14)} ${String(bookMarks).padStart(4)} marks, ` +
      `${String(bookMentioned).padStart(3)} mentioned-only  ` +
      `${Math.round((bookMentioned / Math.max(1, bookMarks)) * 100)}%`);
  }

  const pct = (n: number) => `${Math.round((n / Math.max(1, marks)) * 100)}%`.padStart(4);
  console.log(`\nover ${chapters} chapters, ${marks} marks the OLD engine drew identically\n`);
  for (const base of CLASSES) {
    for (const key of [base, `${base} (uncertain)`]) {
      const n = byClass.get(key) ?? 0;
      if (n === 0) continue;
      console.log(`  ${key.padEnd(24)} ${String(n).padStart(5)}  ${pct(n)}`);
    }
  }
  console.log(`  ${"─".repeat(38)}`);
  console.log(`  ${"UNCERTAIN — the model's job".padEnd(24)} ${String(uncertain).padStart(5)}  ${pct(uncertain)}`);
  console.log(`  ${"decided deterministically".padEnd(24)} ${String(marks - uncertain).padStart(5)}  ${pct(marks - uncertain)}`);

  for (const base of CLASSES) {
    for (const key of [base, `${base} (uncertain)`]) {
      const list = samples.get(key);
      if (!list?.length) continue;
      console.log(`\n${key.toUpperCase()}`);
      for (const s of list) console.log(`  · ${s}`);
    }
  }
  console.log("═".repeat(78));
}

main().catch((e) => { console.error(e); process.exit(1); });
