/**
 * probe-lm-blend.ts — does the LM's confidence blend actually re-rank anything?
 *
 * Measured finding that prompted this: precision@3 is IDENTICAL (43.9%) whether
 * the blend runs with the shipped weights, with centrality only, with salience
 * only, or with both weights set to zero. A term that cannot be distinguished
 * from not existing is either inert or being destroyed downstream, and those need
 * different fixes.
 *
 * The suspect is the clamp in refineEventSalience:
 *     blended = max(0, min(1, confidence + weight*s + centralityWeight*c))
 * Confidence is a within-chapter logistic already sitting around 0.5-0.9, and
 * centrality is a cosine to the chapter mean, which is high AND fairly uniform
 * for every sentence in the chapter. Adding ~0.3 to everything pins the top of
 * the distribution at 1.000, where a stable sort simply preserves the incoming
 * order.
 */

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { installNodeEmbedder } from "./lm-node-backend";
import { analyzeChapter } from "../src/lib/chapter-analysis";
import { detectNarrativeEvents, refineEventSalience } from "../src/lib/narrative-events";
import { chapterCentrality, eventSalienceBatch } from "../src/lib/narrative-lm";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { resolveKnownNames } from "../src/lib/world-data";
import { loadBook, splitParagraphs } from "./print-chapter";
import type { Novel } from "../src/types";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function main() {
  const info = await installNodeEmbedder();
  if (!info) { console.error("no embedder"); process.exitCode = 1; return; }

  const gold = JSON.parse(
    await readFile(path.join(REPO_ROOT, "scripts", "fixtures", "event-gold.json"), "utf8"),
  ) as { chapters: Array<{ book: string; chapter: number }> };

  const cache = new Map<string, Novel>();
  let atCeiling = 0, total = 0, top3Ceiling = 0, top3 = 0;
  let rankChanged = 0, chapters = 0;

  for (const gc of gold.chapters) {
    let novel = cache.get(gc.book);
    if (!novel) { novel = await loadBook(gc.book); cache.set(gc.book, novel); }
    const chapter = novel.chapters.find((c) => c.number === gc.chapter);
    if (!chapter) continue;
    const paragraphs = splitParagraphs(chapter.content);
    const knownNames = resolveKnownNames(novel);
    const speech = detectSpeechInChapter(paragraphs, knownNames, { intelligenceLevel: "default" });
    analyzeChapter(paragraphs, speech, []);
    const before = detectNarrativeEvents(paragraphs, speech, {
      knownNames, worldData: novel.worldData,
      tensionByParagraph: speech.map((r) =>
        r.meta.tension === "high" ? 1 : r.meta.tension === "rising" ? 0.5 : 0),
    });
    if (!before.length) continue;
    chapters++;

    const after = await refineEventSalience(before, {
      scorer: eventSalienceBatch,
      minSalience: -Infinity,           // re-rank ONLY, so pruning cannot confound
      weight: 0.5,
      centrality: (cl) => chapterCentrality(cl, paragraphs),
      centralityWeight: 0.45,
    });

    for (const e of after) {
      total++;
      if (e.confidence >= 0.9995) atCeiling++;
    }
    const idBefore = [...before].sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3).map((e) => `${e.paragraphIndex}:${e.sentenceIndex}`).join(",");
    const rankedAfter = [...after].sort((a, b) => b.confidence - a.confidence);
    const idAfter = rankedAfter.slice(0, 3).map((e) => `${e.paragraphIndex}:${e.sentenceIndex}`).join(",");
    if (idBefore !== idAfter) rankChanged++;
    for (const e of rankedAfter.slice(0, 3)) { top3++; if (e.confidence >= 0.9995) top3Ceiling++; }
  }

  const pc = (n: number, d: number) => `${((n / d) * 100).toFixed(1)}%`;
  console.log(`\n${chapters} chapters, ${total} events, blend applied with NO pruning\n`);
  console.log(`  confidence pinned at the 1.000 ceiling      ${atCeiling}/${total}  (${pc(atCeiling, total)})`);
  console.log(`  ...among the top 3 that actually render     ${top3Ceiling}/${top3}  (${pc(top3Ceiling, top3)})`);
  console.log(`  chapters whose TOP 3 the blend changed      ${rankChanged}/${chapters}  (${pc(rankChanged, chapters)})`);
  if (top3Ceiling / top3 > 0.5) {
    console.log(`\n  → the blend saturates. Above the clamp every event scores 1.000, the sort`);
    console.log(`    becomes a tie, and the incoming order survives untouched. The LM is not`);
    console.log(`    failing to discriminate; its output is being thrown away by the clamp.`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
