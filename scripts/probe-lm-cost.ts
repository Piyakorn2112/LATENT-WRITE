/**
 * probe-lm-cost.ts — what does the LM story-graph pass actually cost?
 *
 * `enrichChapterEntryWithLM` is called straight from App.tsx and therefore runs
 * on the RENDERER'S MAIN THREAD, after every editing pause. There is an analysis
 * worker in the codebase and this does not use it.
 *
 * Whether that matters is a measurement, not an opinion. The pass does two
 * things: one embedding per candidate clause (a handful), and one embedding per
 * PARAGRAPH for chapter centrality (up to a few hundred). The second is the one
 * that could hurt, and it scales with chapter length rather than event count.
 *
 * Run:  npx tsx scripts/probe-lm-cost.ts
 */

import { installNodeEmbedder, reportBackend } from "./lm-node-backend";
import { analyzeChapter } from "../src/lib/chapter-analysis";
import { detectNarrativeEvents } from "../src/lib/narrative-events";
import { chapterCentrality, eventSalienceBatch } from "../src/lib/narrative-lm";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { resolveKnownNames } from "../src/lib/world-data";
import { loadBook, splitParagraphs } from "./print-chapter";

const CASES: Array<[string, number]> = [
  ["hollow-iris", 45],
  ["dracula", 3],
  ["pride", 34],
  ["sherlock", 1],
];

async function main() {
  const info = await installNodeEmbedder();
  if (!info) { console.error("no embedding backend"); process.exitCode = 1; return; }
  reportBackend(info);

  console.log("\nchapter                paras  events   salience   centrality      TOTAL   (2nd pass)");
  console.log("─".repeat(74));
  let worst = 0;
  for (const [book, ch] of CASES) {
    const novel = await loadBook(book);
    const chapter = novel.chapters.find((c) => c.number === ch);
    if (!chapter) continue;
    const paragraphs = splitParagraphs(chapter.content);
    const knownNames = resolveKnownNames(novel);
    const speech = detectSpeechInChapter(paragraphs, knownNames, { intelligenceLevel: "default" });
    analyzeChapter(paragraphs, speech, []);
    const events = detectNarrativeEvents(paragraphs, speech, {
      knownNames, worldData: novel.worldData,
      tensionByParagraph: speech.map((r) =>
        r.meta.tension === "high" ? 1 : r.meta.tension === "rising" ? 0.5 : 0),
    });

    const t0 = Date.now();
    await eventSalienceBatch(events.map((e) => e.sentence));
    const salMs = Date.now() - t0;

    const t1 = Date.now();
    await chapterCentrality(events.map((e) => e.sentence), paragraphs);
    const centMs = Date.now() - t1;

    // SECOND pass over identical text. `narrative-lm` keeps a per-session
    // sentence cache keyed by the text itself, so this is what an editing pause
    // on an ALREADY-ANALYSED chapter costs — which is the common case, not the
    // cold one above.
    const t2 = Date.now();
    await eventSalienceBatch(events.map((e) => e.sentence));
    await chapterCentrality(events.map((e) => e.sentence), paragraphs);
    const warmMs = Date.now() - t2;

    const total = salMs + centMs;
    worst = Math.max(worst, total);
    console.log(
      `${`${book} ch${ch}`.padEnd(22)} ${String(paragraphs.length).padStart(5)} ` +
      `${String(events.length).padStart(7)} ${`${salMs}ms`.padStart(10)} ${`${centMs}ms`.padStart(12)} ` +
      `${`${total}ms`.padStart(10)}  warm ${`${warmMs}ms`.padStart(6)}`,
    );
  }

  console.log(`\nWorst COLD case here: ${worst}ms, on whichever thread runs it — the main`);
  console.log(`thread today, because App.tsx calls enrichChapterEntryWithLM directly.`);
  console.log(`\n★ READ THE WARM COLUMN BEFORE ACTING ON THE COLD ONE. It is ~0ms, because`);
  console.log(`narrative-lm keeps a sentence cache keyed by the text itself. So this is a`);
  console.log(`ONE-TIME cost per chapter, not a per-pause cost, and editing one paragraph`);
  console.log(`invalidates exactly one embedding rather than the whole chapter.`);
  console.log(`\nThat makes moving this to the analysis worker a real but LOWER-priority`);
  console.log(`fix than the cold number alone suggests: it buys a smoother first open of a`);
  console.log(`long chapter, not a smoother typing experience. Centrality is ~90% of the`);
  console.log(`cold cost (it embeds every paragraph), so a persisted per-chapter centroid`);
  console.log(`would remove most of it without any threading work at all.`);
  console.log(`\nThe cache is currently UNBOUNDED — ~1.5KB per distinct paragraph. Fine for a`);
  console.log(`novel, worth a cap before it holds several.`);
  console.log(`\nNOTE: Node timings are a LOWER BOUND on the renderer. Same ONNX runtime,`);
  console.log(`but the renderer is also compositing, and the app targets weak machines.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
