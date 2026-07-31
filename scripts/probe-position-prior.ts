/**
 * probe-position-prior.ts — where in a chapter do real events actually sit?
 *
 * The rank probe found that the LAST three detected events beat the first
 * three by 19 points. Two explanations fit that: (a) real events genuinely
 * cluster late in a chapter, or (b) the engine's candidates cluster early for
 * some unrelated reason and the tail is just less crowded. Only (a) justifies
 * a positional prior in the scorer, so it gets measured against the GOLD, not
 * against the engine's own output.
 *
 * Prints the density of gold events by decile of chapter position, major and
 * minor separately, plus the engine's candidate density on the same axis so
 * the two distributions can be compared directly.
 */

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { detectNarrativeEvents } from "../src/lib/narrative-events";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { resolveKnownNames } from "../src/lib/world-data";
import { loadBook, splitParagraphs } from "./print-chapter";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

interface GoldEvent { paragraph: number; salience: string }
interface GoldChapter { book: string; chapter: number; events: GoldEvent[] }

const gold = JSON.parse(
  await readFile(path.join(REPO_ROOT, "scripts/fixtures/event-gold.json"), "utf8"),
) as { chapters: GoldChapter[] };

const bookCache = new Map<string, Awaited<ReturnType<typeof loadBook>>>();
async function book(key: string) {
  if (!bookCache.has(key)) bookCache.set(key, await loadBook(key));
  return bookCache.get(key)!;
}

const D = 10;
const goldAll = new Array(D).fill(0);
const goldMajor = new Array(D).fill(0);
const engineAll = new Array(D).fill(0);
// P(gold | engine fired here), by decile — the number a prior would exploit.
const engineHit = new Array(D).fill(0);

const decile = (pos: number) => Math.min(D - 1, Math.max(0, Math.floor(pos * D)));

for (const gc of gold.chapters) {
  const novel = await book(gc.book);
  const chapter = novel.chapters.find((c) => c.number === gc.chapter);
  if (!chapter) continue;
  const paragraphs = splitParagraphs(chapter.content);
  const n = Math.max(1, paragraphs.length - 1);

  for (const g of gc.events) {
    const d = decile((g.paragraph - 1) / n);
    goldAll[d]++;
    if (g.salience === "major") goldMajor[d]++;
  }

  const knownNames = resolveKnownNames(novel);
  const speech = detectSpeechInChapter(paragraphs, knownNames, { intelligenceLevel: "high" });
  const events = detectNarrativeEvents(paragraphs, speech, {
    knownNames,
    worldData: novel.worldData,
    tensionByParagraph: speech.map((r) =>
      r.meta.tension === "high" ? 1 : r.meta.tension === "rising" ? 0.5 : 0,
    ),
  });
  for (const e of events) {
    const d = decile(e.paragraphIndex / n);
    engineAll[d]++;
    if (gc.events.some((g) => Math.abs(g.paragraph - (e.paragraphIndex + 1)) <= 1)) engineHit[d]++;
  }
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const share = (a: number[]) => a.map((v) => (v / (sum(a) || 1)) * 100);
const gs = share(goldAll), gms = share(goldMajor), es = share(engineAll);

const bar = (v: number) => "█".repeat(Math.round(v / 1.2));

console.log(`\n${gold.chapters.length} chapters · ${sum(goldAll)} gold events (${sum(goldMajor)} major) · ${sum(engineAll)} engine events\n`);
console.log("decile   gold%   goldMajor%   engine%   P(real | engine fired)");
for (let d = 0; d < D; d++) {
  const p = engineAll[d] ? (engineHit[d] / engineAll[d]) * 100 : 0;
  console.log(
    `${`${d * 10}-${d * 10 + 10}%`.padEnd(9)}` +
    `${gs[d].toFixed(1).padStart(5)}   ${gms[d].toFixed(1).padStart(9)}   ` +
    `${es[d].toFixed(1).padStart(6)}    ${p.toFixed(1).padStart(5)}%  ${bar(p)}`,
  );
}

const firstHalfGold = sum(goldAll.slice(0, 5)), lastHalfGold = sum(goldAll.slice(5));
const firstHalfEng = sum(engineAll.slice(0, 5)), lastHalfEng = sum(engineAll.slice(5));
console.log(`\ngold   first half ${firstHalfGold}  vs last half ${lastHalfGold}  (ratio ${(lastHalfGold / (firstHalfGold || 1)).toFixed(2)}x)`);
console.log(`engine first half ${firstHalfEng}  vs last half ${lastHalfEng}  (ratio ${(lastHalfEng / (firstHalfEng || 1)).toFixed(2)}x)`);
