/**
 * probe-rank-inversion.ts — is the engine's CONFIDENCE ranking pointed the
 * right way?
 *
 * Reading the writer-facing dump (probe-writer-view.ts) the highest-scoring
 * chips looked like the worst ones: "Green Gables builds" 91% major from a
 * clause describing a house, "Matthew walks jauntily away" 95% major from
 * stage business, while the actual turns of the chapter sat at 40-60%. That is
 * a hypothesis, and hypotheses about this engine have been wrong before, so it
 * gets counted rather than argued.
 *
 * Measures, over the whole gold set:
 *   · hit rate of the top-3 by confidence  (what ships)
 *   · hit rate of a RANDOM 3               (ranking worth nothing)
 *   · hit rate of the BOTTOM 3             (ranking actively inverted)
 *   · confidence of aligned vs unaligned events
 *   · hit rate by channel and by type, to find which class carries the damage
 *
 * If random beats the top-3, ranking is noise. If bottom beats top, it is
 * inverted, and no amount of better detection fixes that.
 */

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { detectNarrativeEvents, type NarrativeEvent } from "../src/lib/narrative-events";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { resolveKnownNames } from "../src/lib/world-data";
import { loadBook, splitParagraphs } from "./print-chapter";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

interface GoldEvent { paragraph: number; salience: string; type: string; summary: string }
interface GoldChapter { book: string; chapter: number; events: GoldEvent[] }

const gold = JSON.parse(
  await readFile(path.join(REPO_ROOT, "scripts/fixtures/event-gold.json"), "utf8"),
) as { chapters: GoldChapter[] };

// Deterministic PRNG so the random baseline is reproducible run to run.
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const bookCache = new Map<string, Awaited<ReturnType<typeof loadBook>>>();
async function book(key: string) {
  if (!bookCache.has(key)) bookCache.set(key, await loadBook(key));
  return bookCache.get(key)!;
}

const alignsAny = (e: NarrativeEvent, g: GoldChapter) =>
  g.events.some((x) => Math.abs(e.paragraphIndex + 1 - x.paragraph) <= 1);
const alignsMajor = (e: NarrativeEvent, g: GoldChapter) =>
  g.events.some((x) => x.salience === "major" && Math.abs(e.paragraphIndex + 1 - x.paragraph) <= 1);

type Bucket = "firstByPos" | "topByConf" | "rand" | "lastByPos";
const stat: Record<Bucket, number[]> = { firstByPos: [0, 0], topByConf: [0, 0], rand: [0, 0], lastByPos: [0, 0] };
const statMajor: Record<Bucket, number[]> = { firstByPos: [0, 0], topByConf: [0, 0], rand: [0, 0], lastByPos: [0, 0] };
const confAligned: number[] = [];
const confUnaligned: number[] = [];
const byChannel = new Map<string, [number, number]>();
const byType = new Map<string, [number, number]>();
const bySalience = new Map<string, [number, number]>();

const bump = (m: Map<string, [number, number]>, k: string, hit: boolean) => {
  const v = m.get(k) ?? [0, 0];
  v[1]++; if (hit) v[0]++;
  m.set(k, v);
};

const DEV = new Set(["webnovel","treasure","frankenstein","hollow-iris","sherlock","worlds","anne","root-crown"]);
const only = process.env.DEVONLY === "1" ? DEV : process.env.HOLDOUT === "1" ? null : null;
for (const gc of gold.chapters) {
  if (only && !only.has(gc.book)) continue;
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
  if (events.length === 0) continue;

  // ★ detectNarrativeEvents returns events in PARAGRAPH order, not confidence
  // order — the internal selection ranks by confidence and then re-sorts for
  // display. So `events.slice(0, 3)` (what every UI surface does) is "the
  // first three events in the chapter", NOT "the three best". Both are
  // measured here; conflating them is the thing under test.
  const byPosition = events.slice(0, 3);
  const byConfidence = [...events].sort((a, b) => b.confidence - a.confidence).slice(0, 3);
  const lastByPosition = events.slice(-3);
  const shuffled = [...events].sort(() => rnd() - 0.5);
  const rand = shuffled.slice(0, 3);

  for (const [key, set] of [
    ["firstByPos", byPosition], ["topByConf", byConfidence],
    ["rand", rand], ["lastByPos", lastByPosition],
  ] as const) {
    for (const e of set) {
      stat[key][1]++; if (alignsAny(e, gc)) stat[key][0]++;
      statMajor[key][1]++; if (alignsMajor(e, gc)) statMajor[key][0]++;
    }
  }

  for (const e of events) {
    (alignsAny(e, gc) ? confAligned : confUnaligned).push(e.confidence);
    bump(byChannel, e.channel, alignsAny(e, gc));
    bump(byType, e.type, alignsAny(e, gc));
    bump(bySalience, e.salience, alignsAny(e, gc));
  }
}

const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) + "%" : "n/a");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

console.log(`\ngold chapters scored: ${gold.chapters.length}\n`);
console.log("Which 3 should the timeline show? (hit = within ±1 ¶ of ANY gold event)");
console.log(`  first 3 by POSITION  ${pct(stat.firstByPos[0], stat.firstByPos[1])}  (${stat.firstByPos[0]}/${stat.firstByPos[1]})   <- WHAT SHIPS`);
console.log(`  random 3             ${pct(stat.rand[0], stat.rand[1])}  (${stat.rand[0]}/${stat.rand[1]})`);
console.log(`  top 3 by CONFIDENCE  ${pct(stat.topByConf[0], stat.topByConf[1])}  (${stat.topByConf[0]}/${stat.topByConf[1]})`);
console.log(`  last 3 by POSITION   ${pct(stat.lastByPos[0], stat.lastByPos[1])}  (${stat.lastByPos[0]}/${stat.lastByPos[1]})`);
console.log("\nSame, against MAJOR gold events only:");
console.log(`  first 3 by POSITION  ${pct(statMajor.firstByPos[0], statMajor.firstByPos[1])}   <- WHAT SHIPS`);
console.log(`  random 3             ${pct(statMajor.rand[0], statMajor.rand[1])}`);
console.log(`  top 3 by CONFIDENCE  ${pct(statMajor.topByConf[0], statMajor.topByConf[1])}`);
console.log(`  last 3 by POSITION   ${pct(statMajor.lastByPos[0], statMajor.lastByPos[1])}`);

console.log(`\nmean confidence — aligned ${mean(confAligned).toFixed(3)} (n=${confAligned.length})`);
console.log(`mean confidence — unaligned ${mean(confUnaligned).toFixed(3)} (n=${confUnaligned.length})`);

const table = (title: string, m: Map<string, [number, number]>) => {
  console.log(`\n${title}`);
  for (const [k, [h, n]] of [...m.entries()].sort((a, b) => b[1][1] - a[1][1])) {
    console.log(`  ${k.padEnd(16)} ${pct(h, n).padStart(6)}   n=${n}`);
  }
};
table("hit rate by channel:", byChannel);
table("hit rate by type:", byType);
table("hit rate by engine salience:", bySalience);
