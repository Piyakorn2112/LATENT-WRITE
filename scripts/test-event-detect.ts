/**
 * test-event-detect.ts — scores event detection against the hand-annotated gold set.
 *
 * Run:  npx tsx scripts/test-event-detect.ts            # both engines, summary
 *       npx tsx scripts/test-event-detect.ts --detail    # per-chapter alignment
 *       npx tsx scripts/test-event-detect.ts --engine new
 *
 * ─── WHY THE SCORING LOOKS LIKE THIS ─────────────────────────────────────────
 *
 * POSITIONAL TOLERANCE (±1 paragraph) is not a convenience, it is required for
 * the numbers to mean anything. RAMS measured agreement between its own trained
 * annotators at 55.3% on exact boundaries and 69.9% at ±1 unit — humans do not
 * agree on the exact anchor, so an exact-match metric would mostly be measuring
 * annotation noise. SoftED (Salles et al.) found soft-vs-hard scoring changed
 * which detector won in over 36% of evaluations, so this choice is load-bearing.
 *
 * TYPE ACCURACY IS HELD TO A LOWER BAR THAN POSITION. Gius & Vauth's literary
 * event typology reached Krippendorff's α of only 0.57–0.75 among trained
 * literary scholars on a COARSER four-way scheme than this one. Moderate type
 * agreement is a property of the domain. Position and salience are the gates;
 * type is reported.
 *
 * THE FIXTURE SELF-CHECKS FIRST. Every gold event carries an `evidence` clause
 * copied from the text, and this harness confirms it really occurs in the
 * paragraph it claims. Without that check a shifted paragraph split would turn
 * the whole gold set into plausible-looking near-misses and the suite would
 * report a confident, meaningless number. That failure mode has already cost
 * this project real time in a different guise, so the check runs every time and
 * a mismatch fails the suite outright.
 */

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { analyzeChapter } from "../src/lib/chapter-analysis";
import { detectMajorEvents } from "../src/lib/event-detect";
import { detectNarrativeEvents, type NarrativeEvent } from "../src/lib/narrative-events";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { resolveKnownNames } from "../src/lib/world-data";
import { BOOKS, loadBook, splitParagraphs } from "./print-chapter";
import type { Chapter, Novel } from "../src/types";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// ─── Targets ──────────────────────────────────────────────────────────────────
// Set from the measured baseline, not aspirationally. The engine being replaced
// scores well below all of these; see the printed comparison.
const TARGETS = {
  /** Of the events a chapter summary would mention, how many are found. */
  majorRecall: 0.55,
  /** Of what is emitted, how much corresponds to a real event. The timeline has
   *  room for ~4 chips, so a false chip is expensive. */
  precision: 0.5,
  /** Labels must fit the timeline's real budget without being cut mid-word. */
  labelFitRate: 0.95,
};

const PARAGRAPH_TOLERANCE = 1;
const LABEL_BUDGET = 28;

interface GoldEvent {
  paragraph: number;
  summary: string;
  salience: "major" | "minor";
  type: string;
  legacyType: string;
  evidence: string;
}
interface GoldChapter {
  book: string;
  chapter: number;
  eventfulness: string;
  whatHappens: string;
  events: GoldEvent[];
}
interface Gold {
  chapters: GoldChapter[];
}

interface Predicted {
  paragraph: number;
  label: string;
  type: string;
  legacyType: string;
  confidence: number;
  salience?: "major" | "minor";
}

// ─── Fixture integrity ────────────────────────────────────────────────────────

/** Normalise for comparison: the manuscripts use curly quotes and em dashes,
 *  and an annotator copying by eye may straighten them. */
function normalise(s: string): string {
  return s
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Gold `evidence` may span a sentence boundary that the annotator collapsed
 * ("She wrote the audit report. The report was classified."), so a whole-string
 * search can fail on a correct annotation. Fall back to requiring the first and
 * last few words to both be present in the paragraph.
 */
function evidencePresent(evidence: string, paragraph: string): boolean {
  const hay = normalise(paragraph);
  const needle = normalise(evidence);
  if (hay.includes(needle)) return true;
  const words = needle.split(" ");
  if (words.length < 4) return false;
  const head = words.slice(0, 3).join(" ");
  const tail = words.slice(-3).join(" ");
  return hay.includes(head) && hay.includes(tail);
}

// ─── Matching ─────────────────────────────────────────────────────────────────

interface Match {
  gold: GoldEvent;
  pred: Predicted | null;
  distance: number;
}

/**
 * One-to-one alignment, nearest first. Greedy over the globally smallest
 * distance so a single prediction sitting between two gold events is claimed by
 * the closer one rather than by whichever was iterated first.
 */
function align(gold: GoldEvent[], predicted: Predicted[]): { matches: Match[]; unmatched: Predicted[] } {
  const pairs: Array<{ gi: number; pi: number; d: number }> = [];
  gold.forEach((g, gi) =>
    predicted.forEach((p, pi) => {
      const d = Math.abs(p.paragraph - g.paragraph);
      if (d <= PARAGRAPH_TOLERANCE) pairs.push({ gi, pi, d });
    }),
  );
  pairs.sort((a, b) => a.d - b.d);

  const usedGold = new Set<number>();
  const usedPred = new Set<number>();
  const matches: Match[] = gold.map((g) => ({ gold: g, pred: null, distance: Infinity }));
  for (const { gi, pi, d } of pairs) {
    if (usedGold.has(gi) || usedPred.has(pi)) continue;
    usedGold.add(gi);
    usedPred.add(pi);
    matches[gi] = { gold: gold[gi], pred: predicted[pi], distance: d };
  }
  return { matches, unmatched: predicted.filter((_, pi) => !usedPred.has(pi)) };
}

// ─── Label quality ────────────────────────────────────────────────────────────

const LABEL_STOP = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "at", "for",
  "from", "with", "her", "his", "their", "its", "she", "he", "they", "it",
  "is", "was", "were", "are", "that", "this",
]);

function contentTokens(s: string): string[] {
  return (s.toLowerCase().match(/\b[a-z']{3,}\b/g) ?? []).filter((w) => !LABEL_STOP.has(w));
}

/** Token overlap between the predicted label and the gold summary. A proxy for
 *  "does the label say the same thing", not a substitute for reading them. */
function labelOverlap(label: string, goldSummary: string): number {
  const g = contentTokens(goldSummary);
  if (!g.length) return 0;
  const l = new Set(contentTokens(label));
  // Prefix match at 4 chars so "refuses"/"refused" and "arrives"/"arrival" count.
  let hit = 0;
  for (const gt of g) {
    for (const lt of l) {
      if (gt === lt || (gt.length >= 4 && lt.length >= 4 && (gt.startsWith(lt.slice(0, 4)) || lt.startsWith(gt.slice(0, 4))))) {
        hit++;
        break;
      }
    }
  }
  return hit / g.length;
}

function labelFits(label: string): boolean {
  return label.length <= LABEL_BUDGET && !label.endsWith("…") && !label.endsWith("...");
}

// ─── Engines ──────────────────────────────────────────────────────────────────

/** Per-paragraph tension, 0..1, from the ordinal speech-detect signal. The new
 *  engine reads the DERIVATIVE of this, so its coarseness matters less than its
 *  alignment: one value per paragraph, no subsampling. */
function tensionByParagraph(speech: ReturnType<typeof detectSpeechInChapter>): number[] {
  return speech.map((r) => (r.meta.tension === "high" ? 1 : r.meta.tension === "rising" ? 0.5 : 0));
}

interface Prepared {
  chapter: Chapter;
  novel: Novel;
  paragraphs: string[];
  speech: ReturnType<typeof detectSpeechInChapter>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  analysisResult: any;
  knownNames: string[];
}

async function prepare(gc: GoldChapter, cache: Map<string, Novel>): Promise<Prepared | null> {
  let novel = cache.get(gc.book);
  if (!novel) {
    novel = await loadBook(gc.book);
    cache.set(gc.book, novel);
  }
  const chapter = novel.chapters.find((c) => c.number === gc.chapter);
  if (!chapter) return null;

  const paragraphs = splitParagraphs(chapter.content);
  const knownNames = resolveKnownNames(novel);
  const speech = detectSpeechInChapter(paragraphs, knownNames, { intelligenceLevel: "default" });
  const analysis = analyzeChapter(paragraphs, speech, []);
  return {
    chapter,
    novel,
    paragraphs,
    speech,
    knownNames,
    analysisResult: {
      paragraphs,
      speechResults: speech,
      speechPredictions: [],
      actionPredictions: [],
      analysis,
      endContext: null,
    },
  };
}

function runOld(p: Prepared): Predicted[] {
  const events = detectMajorEvents(
    { content: p.chapter.content, number: p.chapter.number },
    p.analysisResult,
    p.novel.worldData,
  );
  const n = p.paragraphs.length;
  return events.map((e) => ({
    // The old engine only reports a fractional position, so recovering the
    // paragraph means inverting the same rounding it used. This is exactly the
    // information loss that made events un-clickable in the UI.
    paragraph: Math.round(e.tensionPosition * Math.max(1, n - 1)) + 1,
    label: e.label,
    type: e.type,
    legacyType: e.type,
    confidence: e.confidence,
  }));
}

function runNew(p: Prepared): Predicted[] {
  const events: NarrativeEvent[] = detectNarrativeEvents(p.paragraphs, p.speech, {
    knownNames: p.knownNames,
    worldData: p.novel.worldData,
    tensionByParagraph: tensionByParagraph(p.speech),
    confidenceFloor: process.env.FLOOR ? Number(process.env.FLOOR) : undefined,
    maxEvents: process.env.CAP ? Number(process.env.CAP) : undefined,
  });
  return events.map((e) => ({
    paragraph: e.paragraphIndex + 1, // gold is 1-based
    label: e.label,
    type: e.type,
    legacyType: e.legacyType,
    confidence: e.confidence,
    salience: e.salience,
  }));
}

// ─── Report ───────────────────────────────────────────────────────────────────

interface Totals {
  gold: number;
  goldMajor: number;
  predicted: number;
  matched: number;
  matchedMajor: number;
  typeCorrect: number;
  legacyCorrect: number;
  overlapSum: number;
  labelsFit: number;
  exactAnchor: number;
}

function emptyTotals(): Totals {
  return {
    gold: 0, goldMajor: 0, predicted: 0, matched: 0, matchedMajor: 0,
    typeCorrect: 0, legacyCorrect: 0, overlapSum: 0, labelsFit: 0, exactAnchor: 0,
  };
}

function pct(a: number, b: number): string {
  return b === 0 ? "  n/a" : `${((a / b) * 100).toFixed(1).padStart(5)}%`;
}

function report(name: string, t: Totals): { f1: number; majorRecall: number; precision: number; fit: number } {
  const precision = t.predicted ? t.matched / t.predicted : 0;
  const recall = t.gold ? t.matched / t.gold : 0;
  const majorRecall = t.goldMajor ? t.matchedMajor / t.goldMajor : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const fit = t.predicted ? t.labelsFit / t.predicted : 0;

  console.log(`\n── ${name} ─────────────────────────────────────────────`);
  console.log(`  gold events                ${String(t.gold).padStart(4)}   (${t.goldMajor} major)`);
  console.log(`  emitted                    ${String(t.predicted).padStart(4)}`);
  console.log(`  matched (±${PARAGRAPH_TOLERANCE} paragraph)     ${String(t.matched).padStart(4)}   exact anchor: ${t.exactAnchor}`);
  console.log(`  precision                 ${pct(t.matched, t.predicted)}`);
  console.log(`  recall                    ${pct(t.matched, t.gold)}`);
  console.log(`  recall on MAJOR events    ${pct(t.matchedMajor, t.goldMajor)}`);
  console.log(`  F1                        ${(f1 * 100).toFixed(1).padStart(5)}%`);
  console.log(`  type correct (of matched) ${pct(t.typeCorrect, t.matched)}`);
  console.log(`  legacy type (of matched)  ${pct(t.legacyCorrect, t.matched)}`);
  console.log(`  label↔gold token overlap  ${t.matched ? `${((t.overlapSum / t.matched) * 100).toFixed(1).padStart(5)}%` : "  n/a"}`);
  console.log(`  labels fit ≤${LABEL_BUDGET} chars, uncut ${pct(t.labelsFit, t.predicted)}`);
  return { f1, majorRecall, precision, fit };
}

async function main() {
  const detail = process.argv.includes("--detail");
  const engineArg = process.argv.includes("--engine")
    ? process.argv[process.argv.indexOf("--engine") + 1]
    : "both";

  const gold: Gold = JSON.parse(
    await readFile(path.join(REPO_ROOT, "scripts", "fixtures", "event-gold.json"), "utf8"),
  );

  const cache = new Map<string, Novel>();
  const engines: Array<{ name: string; run: (p: Prepared) => Predicted[]; totals: Totals }> = [];
  if (engineArg === "both" || engineArg === "old") {
    engines.push({ name: "OLD  event-detect.ts (dictionaries)", run: runOld, totals: emptyTotals() });
  }
  if (engineArg === "both" || engineArg === "new") {
    engines.push({ name: "NEW  narrative-events.ts (clause-level)", run: runNew, totals: emptyTotals() });
  }

  // ── Fixture integrity, before any scoring.
  let fixtureErrors = 0;
  for (const gc of gold.chapters) {
    const p = await prepare(gc, cache);
    if (!p) {
      console.error(`FIXTURE: ${gc.book} chapter ${gc.chapter} not found`);
      fixtureErrors++;
      continue;
    }
    for (const e of gc.events) {
      const para = p.paragraphs[e.paragraph - 1];
      if (!para) {
        console.error(`FIXTURE: ${gc.book} ch${gc.chapter} ¶${e.paragraph} out of range (${p.paragraphs.length} paragraphs)`);
        fixtureErrors++;
        continue;
      }
      // Allow the neighbours: an annotator may anchor a change that lands on a
      // sentence which the split placed in the adjacent paragraph.
      const near = [para, p.paragraphs[e.paragraph - 2] ?? "", p.paragraphs[e.paragraph] ?? ""];
      if (!near.some((t) => evidencePresent(e.evidence, t))) {
        console.error(`FIXTURE: ${gc.book} ch${gc.chapter} ¶${e.paragraph} evidence not found: "${e.evidence.slice(0, 60)}…"`);
        fixtureErrors++;
      }
    }
  }
  if (fixtureErrors > 0) {
    console.error(`\n${fixtureErrors} fixture problem(s). The gold set is wrong; scores would be meaningless.`);
    process.exitCode = 1;
    return;
  }
  console.log(`fixture OK — ${gold.chapters.length} chapters, ${gold.chapters.reduce((a, c) => a + c.events.length, 0)} gold events, every evidence clause located.`);

  // ── Score.
  for (const gc of gold.chapters) {
    const p = (await prepare(gc, cache))!;
    if (detail) {
      console.log(`\n═══ ${gc.book} ch${gc.chapter} (${gc.eventfulness}, ${p.paragraphs.length} paragraphs, ${gc.events.length} gold) ═══`);
    }
    for (const engine of engines) {
      const predicted = engine.run(p);
      const { matches, unmatched } = align(gc.events, predicted);
      const t = engine.totals;
      t.gold += gc.events.length;
      t.goldMajor += gc.events.filter((e) => e.salience === "major").length;
      t.predicted += predicted.length;
      for (const p2 of predicted) if (labelFits(p2.label)) t.labelsFit++;
      for (const m of matches) {
        if (!m.pred) continue;
        t.matched++;
        if (m.distance === 0) t.exactAnchor++;
        if (m.gold.salience === "major") t.matchedMajor++;
        if (m.pred.type === m.gold.type) t.typeCorrect++;
        if (m.pred.legacyType === m.gold.legacyType) t.legacyCorrect++;
        t.overlapSum += labelOverlap(m.pred.label, m.gold.summary);
      }
      if (detail) {
        console.log(`\n  ${engine.name}`);
        for (const m of matches) {
          if (m.pred) {
            const ov = Math.round(labelOverlap(m.pred.label, m.gold.summary) * 100);
            console.log(`    ✓ ¶${m.gold.paragraph} ${m.gold.salience.padEnd(5)} ${m.gold.type.padEnd(13)} | got ¶${m.pred.paragraph} ${m.pred.type.padEnd(13)} "${m.pred.label}"  overlap ${ov}%`);
            console.log(`        gold: ${m.gold.summary}`);
          } else {
            console.log(`    ✗ ¶${m.gold.paragraph} ${m.gold.salience.padEnd(5)} ${m.gold.type.padEnd(13)} | MISSED   gold: ${m.gold.summary}`);
          }
        }
        for (const u of unmatched) {
          console.log(`    + ¶${u.paragraph} FALSE     ${u.type.padEnd(13)} "${u.label}" (conf ${u.confidence.toFixed(2)})`);
        }
      }
    }
  }

  const results = engines.map((e) => ({ name: e.name, ...report(e.name, e.totals) }));

  // ── Gate on the NEW engine only. The old one is printed for comparison and is
  //    expected to fail; gating on it would make the suite unrunnable.
  const newEngine = results.find((r) => r.name.startsWith("NEW"));
  if (!newEngine) return;

  console.log(`\n── gate ────────────────────────────────────────────────`);
  const checks: Array<[string, number, number]> = [
    ["recall on major events", newEngine.majorRecall, TARGETS.majorRecall],
    ["precision", newEngine.precision, TARGETS.precision],
    ["label fit rate", newEngine.fit, TARGETS.labelFitRate],
  ];
  let failed = false;
  for (const [label, got, target] of checks) {
    const ok = got >= target;
    if (!ok) failed = true;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(24)} ${(got * 100).toFixed(1).padStart(5)}%  target ≥ ${(target * 100).toFixed(0)}%`);
  }
  if (failed) process.exitCode = 1;
}

// Keep the book list importable for other suites.
export { BOOKS };

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
