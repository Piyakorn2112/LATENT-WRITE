/**
 * probe-writer-view.ts — read the timeline the way a WRITER reads it.
 *
 * Every other harness scores the engine against the gold set. This one asks a
 * different question, the one the owner asked: looking at the three chips a
 * chapter actually shows, would the writer be reminded of what happens in that
 * chapter? So it prints, per chapter, the chips as rendered, next to the gold
 * events they were supposed to surface.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/probe-writer-view.ts [book] [--all]
 */

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { detectNarrativeEvents, selectTimelineChips, TIMELINE_CHIP_BUDGET } from "../src/lib/narrative-events";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { resolveKnownNames } from "../src/lib/world-data";
import { loadBook, splitParagraphs } from "./print-chapter";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

interface GoldEvent {
  paragraph: number;
  salience: string;
  type: string;
  summary: string;
  evidence: string;
}
interface GoldChapter {
  book: string;
  chapter: number;
  events: GoldEvent[];
}

const args = process.argv.slice(2);
const onlyBook = args.find((a) => !a.startsWith("--"));
const showAll = args.includes("--all");

const gold = JSON.parse(
  await readFile(path.join(REPO_ROOT, "scripts/fixtures/event-gold.json"), "utf8"),
) as { chapters: GoldChapter[] };

let chapters = gold.chapters;
if (onlyBook) chapters = chapters.filter((c) => c.book === onlyBook);
if (!showAll) chapters = chapters.slice(0, 12);

const bookCache = new Map<string, Awaited<ReturnType<typeof loadBook>>>();
async function book(key: string) {
  if (!bookCache.has(key)) bookCache.set(key, await loadBook(key));
  return bookCache.get(key)!;
}

for (const gc of chapters) {
  const novel = await book(gc.book);
  const chapter = novel.chapters.find((c) => c.number === gc.chapter);
  if (!chapter) continue;
  const paragraphs = splitParagraphs(chapter.content);
  const knownNames = resolveKnownNames(novel);
  const speech = detectSpeechInChapter(paragraphs, knownNames, { intelligenceLevel: "high" });
  const events = detectNarrativeEvents(paragraphs, speech, {
    knownNames,
    worldData: novel.worldData,
    tensionByParagraph: speech.map((r) =>
      r.meta.tension === "high" ? 1 : r.meta.tension === "rising" ? 0.5 : 0,
    ),
  });
  // The renderers' own selector, so this dump cannot drift from the product.
  const shown = selectTimelineChips(events);

  console.log(`\n${"═".repeat(78)}`);
  console.log(`${gc.book} ch.${gc.chapter} — ${paragraphs.length} paragraphs`);
  console.log(`${"─".repeat(78)}`);
  console.log(`WHAT THE WRITER SEES (top ${TIMELINE_CHIP_BUDGET}):`);
  if (shown.length === 0) console.log("   (nothing)");
  for (const e of shown) {
    console.log(`   • "${e.label}"  [${e.type}/${e.salience} ¶${e.paragraphIndex + 1} ${(e.confidence * 100).toFixed(0)}%]`);
    console.log(`     clause: ${e.sentence.replace(/\s+/g, " ").slice(0, 150)}`);
  }
  console.log(`\nWHAT ACTUALLY HAPPENS (gold, major first):`);
  const sortedGold = [...gc.events].sort((a, b) =>
    (a.salience === b.salience ? 0 : a.salience === "major" ? -1 : 1) || a.paragraph - b.paragraph);
  for (const g of sortedGold) {
    const hit = shown.some((e) => Math.abs(e.paragraphIndex + 1 - g.paragraph) <= 1);
    console.log(`   ${hit ? "✓" : " "} ¶${g.paragraph} [${g.salience}] ${g.summary}`);
  }
}
