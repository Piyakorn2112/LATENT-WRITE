/**
 * probe-missed-majors.ts — what do the major events the engine NEVER finds look like?
 *
 * Recall on major events is now the binding constraint: 27 of 59 found, and of
 * those, most already reach the timeline. So the question that matters is no
 * longer "is the ranking right" but "what class of event is the engine blind to".
 *
 * This prints the gold EVIDENCE CLAUSE for every missed major event, grouped so
 * the shape is visible, plus a coarse breakdown by grammatical form. The point is
 * to find a class, not to fix one book.
 */

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { analyzeChapter } from "../src/lib/chapter-analysis";
import { detectNarrativeEvents } from "../src/lib/narrative-events";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { resolveKnownNames } from "../src/lib/world-data";
import { loadBook, splitParagraphs } from "./print-chapter";
import type { Novel } from "../src/types";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TOLERANCE = 1;

interface GoldEvent {
  paragraph: number; summary: string; salience: string; type: string; evidence: string;
}

async function main() {
  const gold = JSON.parse(
    await readFile(path.join(REPO_ROOT, "scripts", "fixtures", "event-gold.json"), "utf8"),
  ) as { chapters: Array<{ book: string; chapter: number; events: GoldEvent[] }> };

  const cache = new Map<string, Novel>();
  const missed: Array<{ book: string; ch: number; g: GoldEvent }> = [];
  let totalMajor = 0;

  for (const gc of gold.chapters) {
    let novel = cache.get(gc.book);
    if (!novel) { novel = await loadBook(gc.book); cache.set(gc.book, novel); }
    const chapter = novel.chapters.find((c) => c.number === gc.chapter);
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
    for (const g of gc.events) {
      if (g.salience !== "major") continue;
      totalMajor++;
      const found = events.some((e) => Math.abs(g.paragraph - 1 - e.paragraphIndex) <= TOLERANCE);
      if (!found) missed.push({ book: gc.book, ch: gc.chapter, g });
    }
  }

  console.log(`\n${missed.length} of ${totalMajor} MAJOR events are never found.\n`);

  // Coarse grammatical buckets. Deliberately crude — the aim is to see whether
  // one CLASS dominates, not to classify precisely.
  const buckets: Record<string, GoldEvent[]> = {
    "first-person subject (I/we/my)": [],
    "inside quoted dialogue": [],
    "passive or existential": [],
    "third-person named subject": [],
    other: [],
  };
  for (const m of missed) {
    const e = m.g.evidence;
    if (/["“”]/.test(e)) buckets["inside quoted dialogue"].push(m.g);
    else if (/\b(?:I|we|my|our|me|us)\b/.test(e)) buckets["first-person subject (I/we/my)"].push(m.g);
    else if (/\b(?:was|were|been|is|are)\s+\w+(?:ed|en)\b/.test(e) || /^There\b/.test(e)) buckets["passive or existential"].push(m.g);
    else if (/^[A-Z][a-z]+\b/.test(e)) buckets["third-person named subject"].push(m.g);
    else buckets.other.push(m.g);
  }
  for (const [name, list] of Object.entries(buckets)) {
    if (!list.length) continue;
    console.log(`── ${name}: ${list.length} (${((list.length / missed.length) * 100).toFixed(0)}%)`);
    for (const g of list.slice(0, Number(process.env.LIMIT ?? 6))) {
      console.log(`     ${g.type.padEnd(13)} ${g.evidence.slice(0, 96)}`);
    }
    console.log("");
  }

  const byType = new Map<string, number>();
  for (const m of missed) byType.set(m.g.type, (byType.get(m.g.type) ?? 0) + 1);
  console.log(`missed by gold type: ${[...byType].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(", ")}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
