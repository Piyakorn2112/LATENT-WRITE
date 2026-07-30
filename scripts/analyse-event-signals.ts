/**
 * analyse-event-signals.ts — which of the engine's signals actually predict that
 * a candidate is a real event?
 *
 * Run:  npx tsx scripts/analyse-event-signals.ts
 *
 * ─── WHY ─────────────────────────────────────────────────────────────────────
 *
 * The ranking does not work. The engine finds 40.7% of the gold set's major
 * events but only 22.0% of them reach the top four chips a writer actually sees,
 * so confidence is close to uninformative about correctness.
 *
 * Two fixes were tried by hand first and neither moved it: reweighting the LM
 * salience term (0.5 through 6.0, precision@4 moved 31.1% to 32.8% and back) and
 * raising or lowering the confidence floor (flat across its whole usable range).
 * That pattern says the problem is not the weighting of the signals. It is that
 * the signals themselves may not separate real events from false ones.
 *
 * So this stops guessing and measures it. Every scoring term in
 * narrative-events.ts records itself in the event's `why` array. This script runs
 * detection over the gold chapters, aligns each candidate against the gold with
 * the same +-1 paragraph tolerance the suite uses, and reports for each signal:
 *
 *   · how often it fires
 *   · the hit rate of candidates WHERE IT FIRED
 *   · the hit rate of candidates where it did not
 *   · the LIFT between those two
 *
 * A signal with lift near zero carries no information about correctness no matter
 * what weight it is given, and one with NEGATIVE lift is actively harmful and is
 * currently helping to bury real events. That is the list worth acting on.
 */

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { analyzeChapter } from "../src/lib/chapter-analysis";
import { detectNarrativeEvents, type NarrativeEvent } from "../src/lib/narrative-events";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { resolveKnownNames } from "../src/lib/world-data";
import { loadBook, splitParagraphs } from "./print-chapter";
import type { Novel } from "../src/types";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TOLERANCE = 1;

interface GoldChapter {
  book: string;
  chapter: number;
  events: Array<{ paragraph: number; salience: "major" | "minor" }>;
}

interface Sample {
  book: string;
  chapterKey: string;
  signals: string[];
  confidence: number;
  /** Did this candidate land on a gold event, within tolerance? */
  hit: boolean;
  hitMajor: boolean;
}

async function main() {
  const gold: { chapters: GoldChapter[] } = JSON.parse(
    await readFile(path.join(REPO_ROOT, "scripts", "fixtures", "event-gold.json"), "utf8"),
  );

  const cache = new Map<string, Novel>();
  const samples: Sample[] = [];

  for (const gc of gold.chapters) {
    let novel = cache.get(gc.book);
    if (!novel) { novel = await loadBook(gc.book); cache.set(gc.book, novel); }
    const chapter = novel.chapters.find((c) => c.number === gc.chapter);
    if (!chapter) continue;

    const paragraphs = splitParagraphs(chapter.content);
    const knownNames = resolveKnownNames(novel);
    const speech = detectSpeechInChapter(paragraphs, knownNames, { intelligenceLevel: "default" });
    analyzeChapter(paragraphs, speech, []);

    const events: NarrativeEvent[] = detectNarrativeEvents(paragraphs, speech, {
      knownNames,
      worldData: novel.worldData,
      tensionByParagraph: speech.map((r) => (r.meta.tension === "high" ? 1 : r.meta.tension === "rising" ? 0.5 : 0)),
    });

    for (const e of events) {
      const near = gc.events.filter((g) => Math.abs(g.paragraph - 1 - e.paragraphIndex) <= TOLERANCE);
      samples.push({
        book: gc.book,
        chapterKey: `${gc.book}|${gc.chapter}`,
        signals: e.why,
        confidence: e.confidence,
        hit: near.length > 0,
        hitMajor: near.some((g) => g.salience === "major"),
      });
    }
  }

  const total = samples.length;
  const hits = samples.filter((s) => s.hit).length;
  const base = hits / total;
  console.log(`${total} candidates over ${gold.chapters.length} gold chapters`);
  console.log(`base hit rate: ${(base * 100).toFixed(1)}%  (${hits} land on a gold event)\n`);

  const all = [...new Set(samples.flatMap((s) => s.signals.map((w) => w.split(":")[0])))].sort();

  console.log("signal                    fires   hit|fired  hit|absent      LIFT");
  console.log("─".repeat(70));
  const rows: Array<{ name: string; lift: number; fired: number; withRate: number }> = [];
  for (const sig of all) {
    const withSig = samples.filter((s) => s.signals.some((w) => w.split(":")[0] === sig));
    const without = samples.filter((s) => !s.signals.some((w) => w.split(":")[0] === sig));
    if (withSig.length < 4 || without.length < 4) continue;
    const a = withSig.filter((s) => s.hit).length / withSig.length;
    const b = without.filter((s) => s.hit).length / without.length;
    rows.push({ name: sig, lift: a - b, fired: withSig.length, withRate: a });
  }
  rows.sort((x, y) => y.lift - x.lift);
  for (const r of rows) {
    const flag = r.lift > 0.08 ? "  ← useful" : r.lift < -0.05 ? "  ← HARMFUL" : "";
    console.log(
      `${r.name.padEnd(24)} ${String(r.fired).padStart(5)}   ${(r.withRate * 100).toFixed(1).padStart(6)}%   ` +
      `${(((r.withRate - r.lift)) * 100).toFixed(1).padStart(6)}%   ${(r.lift * 100).toFixed(1).padStart(6)}pp${flag}`,
    );
  }

  // Does confidence rank? Compared WITHIN each chapter, because confidence is a
  // z-score calibrated inside the chapter and is therefore not comparable across
  // chapters at all. An earlier version of this check pooled every candidate
  // globally and reported a near-zero separation while precision@4 was climbing
  // fifteen points, which is the analyser being wrong rather than the engine.
  let firstHalfHits = 0, firstHalfN = 0, secondHalfHits = 0, secondHalfN = 0;
  const byChapter = new Map<string, Sample[]>();
  for (const s of samples) {
    const k = s.chapterKey;
    if (!byChapter.has(k)) byChapter.set(k, []);
    byChapter.get(k)!.push(s);
  }
  for (const group of byChapter.values()) {
    if (group.length < 4) continue;
    const ranked = [...group].sort((a, b) => b.confidence - a.confidence);
    const half = Math.floor(ranked.length / 2);
    for (let i = 0; i < ranked.length; i++) {
      const hit = ranked[i].hit ? 1 : 0;
      if (i < half) { firstHalfHits += hit; firstHalfN++; }
      else { secondHalfHits += hit; secondHalfN++; }
    }
  }
  const topRate = firstHalfN ? firstHalfHits / firstHalfN : 0;
  const botRate = secondHalfN ? secondHalfHits / secondHalfN : 0;
  console.log(`\nDoes confidence rank WITHIN a chapter? (the only comparison that means anything)`);
  console.log(`  hit rate, better-ranked half   ${(topRate * 100).toFixed(1)}%  (n=${firstHalfN})`);
  console.log(`  hit rate, worse-ranked half    ${(botRate * 100).toFixed(1)}%  (n=${secondHalfN})`);
  console.log(`  separation                     ${((topRate - botRate) * 100).toFixed(1)}pp`);
  if (topRate - botRate < 0.05) {
    console.log(`  → the ranking is not separating. Reweighting will not fix that;`);
    console.log(`    a signal that actually discriminates has to be added.`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
