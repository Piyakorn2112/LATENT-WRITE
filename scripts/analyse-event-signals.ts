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

  // ★ Keep `verb:<type>` whole. Splitting on ":" collapsed all eight narrative
  // types into one "verb" signal, which is why the type channel has always
  // measured as carrying no ranking information — the measurement could not see
  // the types apart. Since then the dialogue classifier gained eight specific
  // speech acts (declaration, threat, revocation, self-identification…), and
  // whether THOSE predict a real event is a different and much sharper question.
  const key = (w: string) => (w.startsWith("verb:") ? w : w.split(":")[0]);
  const all = [...new Set(samples.flatMap((s) => s.signals.map(key)))].sort();

  console.log("signal                    fires   hit|fired  hit|absent      LIFT");
  console.log("─".repeat(70));
  const rows: Array<{ name: string; lift: number; fired: number; withRate: number }> = [];
  for (const sig of all) {
    const withSig = samples.filter((s) => s.signals.some((w) => key(w) === sig));
    const without = samples.filter((s) => !s.signals.some((w) => key(w) === sig));
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

  // ── Which signals predict hitting a MAJOR event specifically?
  //
  // A different question from the one above, and the one that matters most for
  // the product: the engine finds 39.0% of major events but only 25.4% of them
  // reach the top four chips. Closing that needs a signal that separates major
  // from minor, not just real from false.
  console.log("\nsignal                    fires   MAJOR|fired  MAJOR|absent    LIFT");
  console.log("─".repeat(70));
  const majRows: Array<{ name: string; lift: number; fired: number; withRate: number }> = [];
  for (const sig of all) {
    const withSig = samples.filter((s) => s.signals.some((w) => key(w) === sig));
    const without = samples.filter((s) => !s.signals.some((w) => key(w) === sig));
    if (withSig.length < 4 || without.length < 4) continue;
    const a = withSig.filter((s) => s.hitMajor).length / withSig.length;
    const b = without.filter((s) => s.hitMajor).length / without.length;
    majRows.push({ name: sig, lift: a - b, fired: withSig.length, withRate: a });
  }
  majRows.sort((x, y) => y.lift - x.lift);
  for (const r of majRows) {
    const flag = r.lift > 0.08 ? "  ← ranks MAJORS up" : r.lift < -0.05 ? "  ← ranks MAJORS down" : "";
    console.log(
      `${r.name.padEnd(24)} ${String(r.fired).padStart(5)}   ${(r.withRate * 100).toFixed(1).padStart(6)}%   ` +
      `${(((r.withRate - r.lift)) * 100).toFixed(1).padStart(6)}%   ${(r.lift * 100).toFixed(1).padStart(6)}pp${flag}`,
    );
  }
  const majBase = samples.filter((s) => s.hitMajor).length / total;
  console.log(`base MAJOR hit rate: ${(majBase * 100).toFixed(1)}%`);

  // ── Nested signals, whose raw lift above is CONFOUNDED.
  //
  // `unspecified-entity` can only fire on a candidate that already has
  // `entity-subject`, so its raw lift mostly re-reports how good entity subjects
  // are, and reading it as its own effect would double-count: an unspecified
  // entity would score higher than a specified one, which is backwards.
  //
  // Detected automatically rather than special-cased, because "signal X only
  // fires inside subgroup Y" is a shape that recurs every time a gate is turned
  // into a scored feature. Any signal whose firings are ≥90% contained in
  // another signal's is re-measured WITHIN that parent only.
  const containment: Array<{ child: string; parent: string; lift: number; majLift: number; n: number }> = [];
  for (const child of all) {
    const kids = samples.filter((s) => s.signals.some((w) => key(w) === child));
    if (kids.length < 6) continue;
    for (const parent of all) {
      if (parent === child) continue;
      const inParent = kids.filter((s) => s.signals.some((w) => key(w) === parent));
      if (inParent.length / kids.length < 0.9) continue;
      const family = samples.filter((s) => s.signals.some((w) => key(w) === parent));
      const siblings = family.filter((s) => !s.signals.some((w) => key(w) === child));
      if (siblings.length < 4) continue;
      const rate = (xs: Sample[], f: (s: Sample) => boolean) => (xs.length ? xs.filter(f).length / xs.length : 0);
      containment.push({
        child, parent, n: inParent.length,
        lift: rate(inParent, (s) => s.hit) - rate(siblings, (s) => s.hit),
        majLift: rate(inParent, (s) => s.hitMajor) - rate(siblings, (s) => s.hitMajor),
      });
      break;
    }
  }
  if (containment.length) {
    console.log(`\nNESTED signals — raw lift above is confounded; weight on THESE numbers instead`);
    console.log("─".repeat(70));
    for (const c of containment) {
      console.log(
        `  ${c.child} within ${c.parent} (n=${c.n}):  ` +
        `any ${(c.lift * 100).toFixed(1)}pp   major ${(c.majLift * 100).toFixed(1)}pp`,
      );
    }
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
  // ── The cut that matters is TOP FOUR, not the median.
  //
  // The timeline renders four chips, so the product only ever asks the ranking
  // one question: are the best four better than the rest? A median split answers
  // a different question, and the two came apart sharply once the weights were
  // refitted — precision@4 went 47.5% -> 50.0% while the median separation stayed
  // flat at ~1.8pp. Both numbers were right. A ranking can be sharp at the very
  // top and noisy through the middle, and only one of those costs a writer
  // anything. Reporting the median split alone would have read as "no change"
  // on the single change that mattered most.
  let topHits = 0, topN = 0, restHits = 0, restN = 0;
  let topMaj = 0, restMaj = 0;
  for (const group of byChapter.values()) {
    const ranked = [...group].sort((a, b) => b.confidence - a.confidence);
    for (let i = 0; i < ranked.length; i++) {
      const inTop = i < 4;
      if (inTop) { topN++; topHits += ranked[i].hit ? 1 : 0; topMaj += ranked[i].hitMajor ? 1 : 0; }
      else { restN++; restHits += ranked[i].hit ? 1 : 0; restMaj += ranked[i].hitMajor ? 1 : 0; }
    }
  }
  const t = topN ? topHits / topN : 0, r = restN ? restHits / restN : 0;
  const tm = topN ? topMaj / topN : 0, rm = restN ? restMaj / restN : 0;
  console.log(`\nDoes confidence put the right things in the TOP FOUR? (what the product asks)`);
  console.log(`  hit rate, top 4 of each chapter   ${(t * 100).toFixed(1)}%  (n=${topN})`);
  console.log(`  hit rate, everything below        ${(r * 100).toFixed(1)}%  (n=${restN})`);
  console.log(`  separation                        ${((t - r) * 100).toFixed(1)}pp`);
  console.log(`  MAJOR rate, top 4                 ${(tm * 100).toFixed(1)}%`);
  console.log(`  MAJOR rate, below                 ${(rm * 100).toFixed(1)}%`);
  console.log(`  separation                        ${((tm - rm) * 100).toFixed(1)}pp`);
  if (t - r < 0.05) {
    console.log(`  → the ranking is not separating where it counts. Reweighting will not`);
    console.log(`    fix that; a signal that actually discriminates has to be added.`);
  }

  const topRate = firstHalfN ? firstHalfHits / firstHalfN : 0;
  const botRate = secondHalfN ? secondHalfHits / secondHalfN : 0;
  console.log(`\nMedian split, for reference (a blunter cut — see the note above)`);
  console.log(`  hit rate, better-ranked half   ${(topRate * 100).toFixed(1)}%  (n=${firstHalfN})`);
  console.log(`  hit rate, worse-ranked half    ${(botRate * 100).toFixed(1)}%  (n=${secondHalfN})`);
  console.log(`  separation                     ${((topRate - botRate) * 100).toFixed(1)}pp`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
