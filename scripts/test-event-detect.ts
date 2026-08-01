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
import {
  detectNarrativeEvents, refineEventSalience,
  LABEL_BUDGET, TIMELINE_CHIP_BUDGET, selectTimelineChips, labelDefect,
  type NarrativeEvent,
} from "../src/lib/narrative-events";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { resolveKnownNames } from "../src/lib/world-data";
import { BOOKS, loadBook, splitParagraphs } from "./print-chapter";
import type { Chapter, Novel } from "../src/types";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// ─── Targets ──────────────────────────────────────────────────────────────────
// Set from the measured baseline, not aspirationally. The engine being replaced
// scores well below all of these; see the printed comparison.
// ★ Set just BELOW current measured performance, so they are regression locks
// rather than aspirations. Raise them as the engine improves. NEVER lower them to
// turn a red suite green without recording why, right here.
//
// The full history of these numbers, because it is the most important thing this
// file has to say:
//
//   22 events,  5 chapters, 1 author    precision 57.1%  major recall 63.6%  F1 55.8%
//   45 events, 11 chapters, 1 author    precision 35.7%  major recall 60.0%  F1 39.6%
//   67 events, 15 chapters, 4 books     precision 35.6%  major recall 35.9%  F1 33.3%
//  103 events, 19 chapters, 8 BOOKS     precision 28.4%  major recall 27.1%  F1 26.2%
//  279 events, 41 chapters, 9 BOOKS     precision 33.1%  major recall 39.6%  F1 34.9%
//  410 events, 66 chapters, 14 BOOKS    precision 31.7%  major recall 44.3%  F1 35.7%
//
// The 14-book set is the first that changes the KIND of prose rather than adding
// more of the same: Fitzgerald 1925, Cather 1918, Chopin 1899, Montgomery 1908
// (Canadian YA) and Stevenson 1883 (adventure) against a set that had been 84%
// 19th-century BRITISH. precision@3 fell 53.8% -> 49.7% and major-events-SHOWN
// ROSE 20.9% -> 22.4%. Nothing regressed; the corpus stopped flattering.
//
// The 2026-07-31 expansion (2.7x, agent-annotated and machine-verified) moved
// precision@3 50.9% -> 46.1% and major-events-SHOWN 22.0% -> 17.2% WITHOUT ANY
// ENGINE CHANGE. Fifth time this has happened; the ruler keeps getting honest.
//
// Every expansion revealed the previous set had been flattering, and the slide is
// monotonic. That is not the engine getting worse; it is the measurement getting
// honest. The eight-book figure is the one to quote, because it is the only one
// that speaks to the actual product claim: that an arbitrary novelist can open
// this app and trust what the timeline tells them.
//
// The eight books span Austen (social comedy), Doyle (detective plot), Wells
// (first-person disaster), Dickens twice (novella with direct address, and
// retrospective first person), Shelley (nested narration inside a letter frame),
// Stoker (epistolary, multi-voice) and the two in-house literary manuscripts.
//
// For context on the same set, the dictionary engine this replaced scores
// precision 30.2%, major recall 13.6%, F1 20.5%, types 0.0% correct, and only 34%
// of its labels fit the timeline. So the rebuild is worth about 2x on finding the
// events that matter and is the difference between a usable type/label channel
// and none. It is still a long way from trustworthy.
// Targets are REGRESSION LOCKS set just under the measured value, not
// aspirations. They are raised whenever a change is banked, so that the next
// change has to keep the ground already taken.
//
// ★★ RE-BASELINED ONCE, and never lower a target for a weaker reason than this.
// The two "what the writer sees" metrics were measured at a hardcoded top-FOUR
// while the shipping timeline renders TIMELINE_CHIP_BUDGET = 3 — and the compact
// timeline rendered every event, uncapped. The gate described a view nobody had.
// Re-measured at the real budget:
//
//                              at 4 (wrong)   at 3 (real)
//   precision@budget              50.7%          49.1%
//   major events shown            30.5%          16.9%
//
// The first barely moved; the second nearly halved, because three slots cannot
// hold as many major events. NOTHING REGRESSED — it is the same engine measured
// against what actually ships. 30.5% had been reported to the owner and was
// wrong; 16.9% is honest, and the gap to the goal is wider than stated.
/**
 * ─── DEV / TEST SPLIT, BY BOOK ───────────────────────────────────────────────
 *
 * Added when the engine gained its first FITTED parameter (the narrative-position
 * prior). Every number in this file up to that point came from a rule written
 * from a principle and then measured, so the whole gold set could be the test
 * set. A fitted weight cannot be chosen that way: sweeping it against the set you
 * then quote is how you report a number that does not survive contact with a new
 * book, and this project has already learned that lesson twice in the attribution
 * engine.
 *
 * Split by BOOK, never by chapter: chapters of one novel share an author's voice,
 * a cast and a structural habit, so a chapter-level split leaks.
 *
 * DEV is the half you may sweep against. TEST is quoted and never tuned on.
 * The split is frozen: reshuffling it after seeing results is the same mistake
 * wearing a different hat.
 *
 *   HOLDOUT=1  score only TEST books
 *   DEVONLY=1  score only DEV books
 */
export const DEV_BOOKS = new Set([
  "webnovel", "treasure", "frankenstein", "hollow-iris", "sherlock",
  "worlds", "anne", "root-crown",
]);
export const TEST_BOOKS = new Set([
  "dracula", "expectations", "gatsby", "pride", "carol", "awakening", "antonia",
]);

const BOOK_FILTER: Set<string> | null =
  process.env.HOLDOUT === "1" ? TEST_BOOKS
  : process.env.DEVONLY === "1" ? DEV_BOOKS
  : null;

const TARGETS = {
  /**
   * ★ THE NUMBER THAT DESCRIBES THE PRODUCT: of the chips a writer actually
   * sees, how many are real. It went ungated for a long time while three lesser
   * numbers were gated, which meant the suite could stay green through a change
   * that made the visible output worse.
   */
  precisionAtBudget: 0.48,
  /** Of the events a chapter summary would mention, how many are actually SHOWN.
   *  The weakest number here by a distance, and the one the goal is about. */
  majorInBudget: 0.22,
  /** Of the events a chapter summary would mention, how many are found at all. */
  majorRecall: 0.40,
  /** Of everything emitted, how much corresponds to a real event. Still the
   *  weakest number here, and expected to be: the engine deliberately emits more
   *  than the timeline shows and lets the ranking do the selecting. */
  precision: 0.30,
  /** Labels must fit the timeline's real budget without being cut mid-word. */
  labelFitRate: 0.95,
  /** ★ NEW GATE, and the one that answers "would the writer understand this?".
   *  labelFitRate only ever measured LENGTH, so a label could be 100% fitting
   *  and still read "Marilla accuses ll" (from "You'll have to stay here") or
   *  "Marilla insists Marilla". Of the chips actually SHOWN, the share whose
   *  label is well formed: no contraction fragment, no restated agent, and
   *  something said about the agent. Measured 98.6% before the repair and
   *  100% after, so this is held at 100 — a fragment reaching the timeline is
   *  a defect, not a tuning question. */
  shownWellFormed: 1.0,
  /** ★ THE OWNER'S ASK, AS NUMBERS: "the quick short sentence that reminds the
   *  writer what happened... it should surface more specific name or action".
   *  Two floors over what is SHOWN, set just under the measured DEV values
   *  (83.3% / 75.8%) at the commit that introduced them — regression tripwires,
   *  not aspirations. NAMED agent: the label opens with a name, not a pronoun.
   *  With object: the label says something beyond agent+verb — an object, an
   *  addressee, a direction. */
  shownNamedAgent: 0.80,
  shownWithObject: 0.70,
};

/**
 * ★ THE MOST IMPORTANT NUMBER THIS SUITE PRINTS IS precision@BUDGET, because
 * the timeline renders TIMELINE_CHIP_BUDGET chips by confidence. It is gated.
 *
 * It was not always, and the history is the useful part. Measured when this
 * comment was first written (at the wrong budget of 4, see the note above):
 *
 *   precision over everything emitted   25.5%
 *   precision@4 (what a writer sees)    31.1%
 *   major events reaching the top 4     22.0%
 *   major events found ANYWHERE          40.7%
 *
 * Those last two read together said the ranking was actively BURYING real events:
 * major coverage in the top four was roughly half what the engine achieved across
 * its whole output. The signal analyser found why - every bonus in the scorer was
 * anti-predictive and confidence was anti-correlated with correctness.
 *
 * After fitting the weights to measured lift, adding chapter centrality, fixing
 * the noun-phrase walk, restricting utterances to performative verbs, and
 * deduplicating labels, measured at the REAL budget of 3:
 *
 *   precision over everything emitted   35.3%
 *   precision@3 (what a writer sees)    50.9%
 *   major events SHOWN                  22.0%
 *   major events found ANYWHERE         45.8%
 *
 * precision@3 is now well clear of overall precision, which is the shape it
 * should have had all along: the ranking concentrates real events at the top.
 *
 * The binding constraint has moved to RECALL AND TO THE BUDGET ITSELF. The engine
 * finds 27 of 59 major events; three slots per chapter then cap how many can be
 * shown at all. Raising `major events SHOWN` therefore needs either better recall
 * or more chips, and the second is a layout decision, not an accuracy one.
 */

const PARAGRAPH_TOLERANCE = 1;

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
  /** ★ Both fields exist so this projection can be fed to the ENGINE'S OWN
   *  chip selector. Without them selectTimelineChips falls back to array order,
   *  which is paragraph order, which silently reproduces the exact bug the
   *  selector was written to prevent — and the suite would score a view nobody
   *  has for the third time. */
  rank: number;
  tensionPosition: number;
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
  // The old engine has no rank of its own; it emits in confidence order, so
  // array position IS its selection order. Stamping it keeps the comparison
  // fair rather than handing the baseline the new engine's selector for free.
  return events.map((e, rank) => ({
    // The old engine only reports a fractional position, so recovering the
    // paragraph means inverting the same rounding it used. This is exactly the
    // information loss that made events un-clickable in the UI.
    paragraph: Math.round(e.tensionPosition * Math.max(1, n - 1)) + 1,
    label: e.label,
    type: e.type,
    legacyType: e.type,
    confidence: e.confidence,
    rank,
    tensionPosition: e.tensionPosition,
  }));
}

/**
 * The LM salience re-rank is ON by default, because story-graph.ts runs it in the
 * app and a suite that tests a configuration nobody ships is measuring fiction.
 *
 * `SALIENCE=off` disables it, which is how its contribution was measured:
 *   sync engine only          precision 32.8%  major recall 60.0%  F1 38.5%
 *   + LM salience re-rank     precision 41.7%  major recall 60.0%  F1 43.0%
 *
 * `SALIENCE=<number>` overrides the cut. The sweep that chose -0.05:
 *   -0.20  precision 31.7%   -0.10  38.5%   -0.05  41.7%   0.00  37.9%   0.05  33.3%
 */
const SALIENCE_MIN = process.env.SALIENCE === "off"
  ? null
  : process.env.SALIENCE ? Number(process.env.SALIENCE) : -0.05;

async function runNewAsync(p: Prepared): Promise<Predicted[]> {
  let events = detectNarrativeEventsFor(p);
  if (SALIENCE_MIN !== null) {
    const { eventSalienceBatch, chapterCentrality } = await import("../src/lib/narrative-lm");
    // Default matches what story-graph.ts ships. A suite testing a configuration
    // nobody runs is measuring fiction, which this file has already been caught
    // doing once.
    const cw = Number(process.env.CENTRALITY_W ?? 0.6);
    events = await refineEventSalience(events, {
      scorer: eventSalienceBatch,
      minSalience: SALIENCE_MIN,
      weight: Number(process.env.SALIENCE_W ?? 0),
      centrality: (clauses) => chapterCentrality(clauses, p.paragraphs),
      centralityWeight: cw,
    });
  }
  return events.map(toPredicted);
}

function detectNarrativeEventsFor(p: Prepared): NarrativeEvent[] {
  return detectNarrativeEvents(p.paragraphs, p.speech, {
    knownNames: p.knownNames,
    worldData: p.novel.worldData,
    tensionByParagraph: tensionByParagraph(p.speech),
    confidenceFloor: process.env.FLOOR ? Number(process.env.FLOOR) : undefined,
    maxEvents: process.env.CAP ? Number(process.env.CAP) : undefined,
    positionPriorWeight: process.env.POSW ? Number(process.env.POSW) : undefined,
    typePriorWeight: process.env.TYPEW ? Number(process.env.TYPEW) : undefined,
  });
}

function toPredicted(e: NarrativeEvent): Predicted {
  return {
    paragraph: e.paragraphIndex + 1,
    label: e.label,
    type: e.type,
    legacyType: e.legacyType,
    confidence: e.confidence,
    salience: e.salience,
    rank: e.rank,
    tensionPosition: e.tensionPosition,
  };
}

function runNew(p: Prepared): Predicted[] {
  // One projection, one detector call — the duplicate that used to live here
  // was how `rank` came to be missing from half the runs.
  return detectNarrativeEventsFor(p).map(toPredicted);
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
  /** Labels that are WELL FORMED, i.e. carry no contraction fragment and do not
   *  restate the agent. `labelsFit` only ever measured LENGTH, so a label could
   *  be 100% "fitting" and still read "Marilla accuses ll". */
  labelsWellFormed: number;
  /** Chips SHOWN whose label is well formed — the number the writer lives with. */
  topWellFormed: number;
  /** Chips SHOWN whose label opens with a NAME rather than a pronoun. "Anne
   *  refuses supper" places the writer instantly; "She refuses supper" makes
   *  them reconstruct who held the camera. */
  topNamedAgent: number;
  /** Chips SHOWN whose label says something beyond agent+verb — an object, an
   *  addressee, a direction. "Matthew tells Jerry Buote" reminds; "Matthew
   *  tells" does not. */
  topWithObject: number;
  exactAnchor: number;
  /** Emitted and matched counting ONLY the top 4 by confidence per chapter,
   *  which is what the timeline actually renders. */
  topEmitted: number;
  topMatched: number;
  topMajorMatched: number;
}

function emptyTotals(): Totals {
  return {
    gold: 0, goldMajor: 0, predicted: 0, matched: 0, matchedMajor: 0,
    typeCorrect: 0, legacyCorrect: 0, overlapSum: 0, labelsFit: 0,
    labelsWellFormed: 0, topWellFormed: 0, topNamedAgent: 0, topWithObject: 0, exactAnchor: 0,
    topEmitted: 0, topMatched: 0, topMajorMatched: 0,
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
  console.log(`  labels well formed        ${pct(t.labelsWellFormed, t.predicted)}`);
  console.log(`  ── what the timeline SHOWS (top ${TIMELINE_CHIP_BUDGET} per chapter) ──`);
  console.log(`  chips rendered              ${String(t.topEmitted).padStart(4)}`);
  console.log(`  precision@${TIMELINE_CHIP_BUDGET}               ${pct(t.topMatched, t.topEmitted)}`);
  console.log(`  major events SHOWN        ${pct(t.topMajorMatched, t.goldMajor)}`);
  console.log(`  shown labels well formed  ${pct(t.topWellFormed, t.topEmitted)}`);
  console.log(`  shown labels NAMED agent  ${pct(t.topNamedAgent, t.topEmitted)}`);
  console.log(`  shown labels with object  ${pct(t.topWithObject, t.topEmitted)}`);
  return {
    f1, majorRecall, precision, fit,
    precisionAtBudget: t.topEmitted ? t.topMatched / t.topEmitted : 0,
    majorInBudget: t.goldMajor ? t.topMajorMatched / t.goldMajor : 0,
    shownWellFormed: t.topEmitted ? t.topWellFormed / t.topEmitted : 0,
    shownNamedAgent: t.topEmitted ? t.topNamedAgent / t.topEmitted : 0,
    shownWithObject: t.topEmitted ? t.topWithObject / t.topEmitted : 0,
  };
}

async function main() {
  const detail = process.argv.includes("--detail");
  const engineArg = process.argv.includes("--engine")
    ? process.argv[process.argv.indexOf("--engine") + 1]
    : "both";

  const only = process.env.ONLY_BOOK;
  const gold: Gold = JSON.parse(
    await readFile(path.join(REPO_ROOT, "scripts", "fixtures", "event-gold.json"), "utf8"),
  );

  if (SALIENCE_MIN !== null) {
    const { installNodeEmbedder, reportBackend } = await import("./lm-node-backend");
    reportBackend(await installNodeEmbedder());
  }

  const cache = new Map<string, Novel>();
  const engines: Array<{ name: string; run: (p: Prepared) => Predicted[] | Promise<Predicted[]>; totals: Totals }> = [];
  if (engineArg === "both" || engineArg === "old") {
    engines.push({ name: "OLD  event-detect.ts (dictionaries)", run: runOld, totals: emptyTotals() });
  }
  if (engineArg === "both" || engineArg === "new") {
    engines.push({
      name: SALIENCE_MIN !== null
        ? "NEW  narrative-events.ts + LM salience re-rank"
        : "NEW  narrative-events.ts (clause-level)",
      run: SALIENCE_MIN !== null ? runNewAsync : runNew,
      totals: emptyTotals(),
    });
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
  // ONLY_BOOK=<key> scores ONE book, so a register can be measured on its own.
  // The corpus deliberately mixes Victorian literary, American modernist, YA,
  // adventure and web-novel prose; a single pooled number hides which of those
  // the engine is actually failing.
  const scored = gold.chapters.filter(
    (c) => (!only || c.book === only) && (!BOOK_FILTER || BOOK_FILTER.has(c.book)),
  );
  if (BOOK_FILTER) {
    console.log(`\n★ ${process.env.HOLDOUT === "1" ? "HELD-OUT TEST" : "DEV"} books only — ` +
      `${scored.length} chapters, ${scored.reduce((a, c) => a + c.events.length, 0)} gold events`);
  }
  for (const gc of scored) {
    const p = (await prepare(gc, cache))!;
    if (detail) {
      console.log(`\n═══ ${gc.book} ch${gc.chapter} (${gc.eventfulness}, ${p.paragraphs.length} paragraphs, ${gc.events.length} gold) ═══`);
    }
    for (const engine of engines) {
      const predicted = await engine.run(p);
      const { matches, unmatched } = align(gc.events, predicted);
      const t = engine.totals;

      // ── What the writer actually sees.
      //
      // ★ This has now been WRONG TWICE, in the same way both times: it scored a
      // view nobody had. First it was hardcoded to 4 while the timeline rendered
      // 3. Then it sorted by confidence — but the renderers sliced the array the
      // engine returns, which is in READING order, so the product was showing
      // the chapter's first three events while this gate scored its best three:
      //
      //     first 3 by position (what shipped)   36.1%
      //     top 3 by rank       (what this said) 47.0%
      //
      // Both are now the same call the renderers make. If the selection rule
      // ever changes again, it changes HERE, once, for all three.
      const top = selectTimelineChips(predicted, TIMELINE_CHIP_BUDGET);
      const topAligned = align(gc.events, top);
      t.topEmitted += top.length;
      for (const m of topAligned.matches) {
        if (!m.pred) continue;
        t.topMatched++;
        if (m.gold.salience === "major") t.topMajorMatched++;
      }
      t.gold += gc.events.length;
      t.goldMajor += gc.events.filter((e) => e.salience === "major").length;
      t.predicted += predicted.length;
      for (const p2 of predicted) {
        if (labelFits(p2.label)) t.labelsFit++;
        if (!labelDefect(p2.label)) t.labelsWellFormed++;
      }
      for (const c of top) {
        if (!labelDefect(c.label)) t.topWellFormed++;
        const words = c.label.split(/\s+/).filter(Boolean);
        if (!/^(?:she|he|they|i|we|it|you)$/i.test(words[0] ?? "")) t.topNamedAgent++;
        if (words.length >= 3) t.topWithObject++;
      }
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
    // ★ First, because it is the only one a writer experiences directly.
    [`precision@${TIMELINE_CHIP_BUDGET} (what is SHOWN)`, newEngine.precisionAtBudget, TARGETS.precisionAtBudget],
    ["shown labels well formed", newEngine.shownWellFormed, TARGETS.shownWellFormed],
    ["shown labels NAMED agent", newEngine.shownNamedAgent, TARGETS.shownNamedAgent],
    ["shown labels with object", newEngine.shownWithObject, TARGETS.shownWithObject],
    [`major events in the top ${TIMELINE_CHIP_BUDGET}`, newEngine.majorInBudget, TARGETS.majorInBudget],
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
