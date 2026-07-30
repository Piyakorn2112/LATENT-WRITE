/**
 * probe-type-mix.ts — why does one type dominate on a given book?
 *
 * The out-of-distribution audit reports type entropy per corpus, which tells you
 * a collapse is happening but not what is causing it. This dumps the actual
 * events behind a chosen type so the responsible rule is visible.
 *
 *   npx tsx scripts/probe-type-mix.ts pride revelation
 */

import { analyzeChapter } from "../src/lib/chapter-analysis";
import { detectNarrativeEvents } from "../src/lib/narrative-events";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { resolveKnownNames } from "../src/lib/world-data";
import { loadBook, splitParagraphs } from "./print-chapter";

async function main() {
  const book = process.argv[2] ?? "pride";
  const want = process.argv[3];
  const limit = Number(process.env.LIMIT ?? 30);

  const novel = await loadBook(book);
  const counts = new Map<string, number>();
  const channels = new Map<string, number>();
  const shown: string[] = [];

  for (const chapter of novel.chapters.slice(0, 20)) {
    const paragraphs = splitParagraphs(chapter.content);
    const knownNames = resolveKnownNames(novel);
    const speech = detectSpeechInChapter(paragraphs, knownNames, { intelligenceLevel: "default" });
    analyzeChapter(paragraphs, speech, []);
    const events = detectNarrativeEvents(paragraphs, speech, {
      knownNames,
      worldData: novel.worldData,
      tensionByParagraph: speech.map((r) =>
        r.meta.tension === "high" ? 1 : r.meta.tension === "rising" ? 0.5 : 0),
    });
    for (const e of events) {
      counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
      channels.set(`${e.type}/${e.channel}`, (channels.get(`${e.type}/${e.channel}`) ?? 0) + 1);
      if (want && e.type === want && shown.length < limit) {
        shown.push(`  [${e.channel}] "${e.label}"   ⟨${e.sentence.slice(0, 100)}⟩`);
      }
    }
  }

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  console.log(`\n${book}: ${total} events over ${Math.min(20, novel.chapters.length)} chapters\n`);
  for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const narr = channels.get(`${t}/narration`) ?? 0;
    const dial = channels.get(`${t}/dialogue`) ?? 0;
    console.log(`  ${t.padEnd(14)} ${String(n).padStart(4)}  ${((n / total) * 100).toFixed(1).padStart(5)}%   narration ${String(narr).padStart(3)}  dialogue ${String(dial).padStart(3)}`);
  }
  if (shown.length) {
    console.log(`\n── ${shown.length} events typed "${want}" ──`);
    for (const s of shown) console.log(s);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
