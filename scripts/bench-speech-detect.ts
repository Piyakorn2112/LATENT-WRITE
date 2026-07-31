/**
 * bench-speech-detect.ts — how long does a chapter scan actually take?
 *
 * FAST mode is what drives the live highlight layer, so its cost is felt as
 * typing latency, not as a background number. This measures the real thing: the
 * whole 15-book corpus, chapter by chapter, with the cast each book actually
 * resolves to.
 *
 * Reports ms per chapter and ms per 1000 words — the second is the one to
 * compare across books, since chapter length varies by an order of magnitude
 * between manuscripts and a per-chapter mean silently reports "which books are
 * in the corpus" instead of "how fast is the engine".
 *
 * Also reports the P95, because a highlight layer is judged by its worst
 * chapters and a mean hides them.
 *
 * REPEATS= raises the repeat count for a stabler number (default 3, best-of).
 * Best-of rather than mean: this is a CPU-bound pure function, so the minimum is
 * the least noisy estimator of its cost — a slow run only ever means the
 * machine was busy elsewhere.
 */

import { BOOKS, CORPUS_BOOKS, loadBook, splitParagraphs } from "./print-chapter";
import { resolveKnownNames, filterSpeakerCandidates } from "../src/lib/world-data";
import { detectSpeechInChapter, type IntelligenceLevel } from "../src/lib/speech-detect";

const ALL_BOOK_KEYS = [...Object.keys(BOOKS), ...Object.keys(CORPUS_BOOKS)].filter((k) => k !== "sample");
const REPEATS = Number(process.env.REPEATS ?? 3);
const MODES = (process.env.MODES ?? "fast,default,high").split(",") as IntelligenceLevel[];

interface Row { book: string; chapters: number; words: number; ms: number; perK: number; }

async function main() {
  console.log(`\n═══ SPEECH-DETECT COST (best of ${REPEATS}) ═══\n`);

  for (const mode of MODES) {
    const rows: Row[] = [];
    const perChapterMs: number[] = [];
    let totalMs = 0, totalWords = 0, totalChapters = 0;

    for (const key of ALL_BOOK_KEYS) {
      let novel;
      try { novel = await loadBook(key); } catch { continue; }
      const knownNames = resolveKnownNames(novel);
      const speakerCandidates = filterSpeakerCandidates(
        knownNames, novel.chapters.map((c) => c.content).join("\n"));

      let bookMs = 0, bookWords = 0, bookChapters = 0;
      for (const chapter of novel.chapters) {
        const paragraphs = splitParagraphs(chapter.content);
        if (paragraphs.length < 2) continue;
        const words = chapter.content.split(/\s+/).length;
        let best = Infinity;
        for (let r = 0; r < REPEATS; r++) {
          const t0 = performance.now();
          detectSpeechInChapter(paragraphs, knownNames, { intelligenceLevel: mode, speakerCandidates });
          best = Math.min(best, performance.now() - t0);
        }
        bookMs += best; bookWords += words; bookChapters++;
        perChapterMs.push(best);
      }
      if (!bookChapters) continue;
      rows.push({ book: key, chapters: bookChapters, words: bookWords, ms: bookMs, perK: (bookMs / bookWords) * 1000 });
      totalMs += bookMs; totalWords += bookWords; totalChapters += bookChapters;
    }

    perChapterMs.sort((a, b) => a - b);
    const p95 = perChapterMs[Math.floor(perChapterMs.length * 0.95)] ?? 0;
    const worst = perChapterMs[perChapterMs.length - 1] ?? 0;

    console.log(`── ${mode.toUpperCase()} ──`);
    console.log(`  ${"book".padEnd(14)}${"chapters".padStart(9)}${"words".padStart(9)}${"total ms".padStart(10)}${"ms/1k words".padStart(13)}`);
    for (const r of rows.sort((a, b) => b.perK - a.perK)) {
      console.log(`  ${r.book.padEnd(14)}${String(r.chapters).padStart(9)}${String(r.words).padStart(9)}${r.ms.toFixed(0).padStart(10)}${r.perK.toFixed(3).padStart(13)}`);
    }
    console.log(`  ${"ALL".padEnd(14)}${String(totalChapters).padStart(9)}${String(totalWords).padStart(9)}${totalMs.toFixed(0).padStart(10)}${((totalMs / totalWords) * 1000).toFixed(3).padStart(13)}`);
    console.log(`  per chapter: mean ${(totalMs / totalChapters).toFixed(2)}ms   p95 ${p95.toFixed(2)}ms   worst ${worst.toFixed(2)}ms\n`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
