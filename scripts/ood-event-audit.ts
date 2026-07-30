/**
 * ood-event-audit.ts — LABEL-FREE health check for event detection over two
 * complete manuscripts.
 *
 * Run: npx tsx scripts/ood-event-audit.ts          (LIMIT=n, STRIDE=n, ENGINE=old|new|both)
 *
 * ─── WHY THIS EXISTS ALONGSIDE test-event-detect.ts ──────────────────────────
 *
 * The gold suite scores 22 hand-annotated events across 5 chapters. That is
 * enough to catch a broken engine and nowhere near enough to prove the engine
 * generalises, and the gold chapters are drawn from the two books the OLD
 * engine's phrase dictionaries were tuned on. This file follows the doctrine
 * already established for speech detection in ood-language-audit.ts: run the
 * REAL pipeline over entire manuscripts and report metrics that need no labels.
 *
 *   Hollow Iris    — IN-DISTRIBUTION for the old engine (87% of its
 *                    INTELLECTUAL_DISCOURSE phrases occur here)
 *   The Root Crown — HELD OUT (24%)
 *
 * The point is the GAP between those two columns. An engine that has memorised
 * one book shows a large gap; an engine keyed off general structure shows a
 * small one. That comparison is available without annotating anything, which is
 * what makes it runnable over 200 chapters instead of 5.
 *
 * ─── THE METRICS, AND WHAT A BAD NUMBER LOOKS LIKE ───────────────────────────
 *
 * 1. TYPE ENTROPY — Shannon entropy over the type distribution, normalised so
 *    1.0 is a perfectly even spread. The old engine typed 36.3% of everything
 *    "confrontation" because that was the fall-through default in its
 *    classifier. A LOW entropy with one dominant type means the taxonomy is
 *    decorative.
 *
 * 2. CONFIDENCE SPREAD — distinct values, and the share sitting at the ceiling.
 *    The old engine reported exactly 1.00 for 95% of events and produced 3
 *    distinct values across 80 of them. A confidence channel the UI sorts and
 *    dedups by, carrying no information, is worse than none.
 *
 * 3. EDGE BIAS — share of events in the first 5% and last 5% of a chapter. A
 *    chapter's opening has no prior state to change and its closing cadence
 *    trips loss vocabulary, so both are where a lexical scorer hallucinates.
 *    13.8% of the old engine's events landed in the first 5%.
 *
 * 4. YIELD vs LENGTH — events per chapter, and the correlation with paragraph
 *    count. Event density genuinely varies; an engine that returns a fixed 2-4
 *    per chapter regardless is not measuring the prose. The old engine averaged
 *    2.67 with almost no variance.
 *
 * 5. LABEL HEALTH — over budget, truncated, duplicated within a chapter. A
 *    label that does not fit gets cut mid-word by the timeline.
 *
 * None of these needs a human. All of them fail loudly when the engine regresses.
 */

import { readFile } from "fs/promises";
import path from "path";

import { analyzeChapter } from "../src/lib/chapter-analysis";
import { detectMajorEvents } from "../src/lib/event-detect";
import { detectNarrativeEvents } from "../src/lib/narrative-events";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { resolveKnownNames } from "../src/lib/world-data";
import { parseNovel } from "../src/lib/parser";
import type { Novel } from "../src/types";

const NOVELS = "/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels";
const STRIDE = Number(process.env.STRIDE ?? 3);
const LIMIT = Number(process.env.LIMIT ?? 60);
const ENGINE = process.env.ENGINE ?? "both";
const LABEL_BUDGET = 28;

interface Row {
  type: string;
  confidence: number;
  position: number;
  label: string;
  chapterKey: string;
  paragraphs: number;
}

interface Corpus {
  label: string;
  file: string;
  distribution: "in-distribution" | "held-out";
}

const CORPORA: Corpus[] = [
  { label: "Hollow Iris", file: "hollow-iris.txt", distribution: "in-distribution" },
  { label: "The Root Crown", file: "root-crown.txt", distribution: "held-out" },
];

function splitParagraphs(content: string): string[] {
  return content.split(/\n{2,}|\n/).map((l) => l.trim()).filter(Boolean);
}

async function collect(corpus: Corpus, engine: "old" | "new"): Promise<Row[]> {
  const novel: Novel = parseNovel(await readFile(path.join(NOVELS, corpus.file), "utf8"));
  const knownNames = resolveKnownNames(novel);
  const rows: Row[] = [];
  const chapters = novel.chapters.filter((_, i) => i % STRIDE === 0).slice(0, LIMIT);

  for (const chapter of chapters) {
    const paragraphs = splitParagraphs(chapter.content);
    if (paragraphs.length < 3) continue;
    const speech = detectSpeechInChapter(paragraphs, knownNames, { intelligenceLevel: "default" });
    const analysis = analyzeChapter(paragraphs, speech, []);
    const chapterKey = `${corpus.label}|${chapter.number}`;

    if (engine === "new") {
      const events = detectNarrativeEvents(paragraphs, speech, {
        knownNames,
        worldData: novel.worldData,
        tensionByParagraph: speech.map((r) =>
          r.meta.tension === "high" ? 1 : r.meta.tension === "rising" ? 0.5 : 0,
        ),
      });
      for (const e of events) {
        rows.push({
          type: e.type,
          confidence: e.confidence,
          position: e.tensionPosition,
          label: e.label,
          chapterKey,
          paragraphs: paragraphs.length,
        });
      }
    } else {
      const result = {
        paragraphs,
        speechResults: speech,
        speechPredictions: [],
        actionPredictions: [],
        analysis,
        endContext: null,
      };
      const events = detectMajorEvents(
        { content: chapter.content, number: chapter.number },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result as any,
        novel.worldData,
      );
      for (const e of events) {
        rows.push({
          type: e.type,
          confidence: e.confidence,
          position: e.tensionPosition,
          label: e.label,
          chapterKey,
          paragraphs: paragraphs.length,
        });
      }
    }
    // Record chapters that produced nothing, so yield statistics are honest.
    if (!rows.some((r) => r.chapterKey === chapterKey)) {
      rows.push({ type: "(none)", confidence: 0, position: 0, label: "", chapterKey, paragraphs: paragraphs.length });
    }
  }
  return rows;
}

/** Shannon entropy over the type distribution, normalised by log(k) so 1.0 is
 *  an even spread across the types actually used. */
function normalisedEntropy(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0 || counts.length <= 1) return 0;
  let h = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / total;
    h -= p * Math.log(p);
  }
  return h / Math.log(counts.length);
}

/** Pearson correlation. Reported to answer one question: does yield track how
 *  much prose there is, or is it a constant the engine invented? */
function correlation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

interface Report {
  events: number;
  chapters: number;
  emptyChapters: number;
  typeEntropy: number;
  dominantType: string;
  dominantShare: number;
  distinctConfidences: number;
  atCeiling: number;
  firstFive: number;
  lastFive: number;
  eventsPerChapter: number;
  yieldStdDev: number;
  yieldLengthCorr: number;
  overBudget: number;
  truncated: number;
  duplicated: number;
}

function analyse(rows: Row[]): Report {
  const real = rows.filter((r) => r.type !== "(none)");
  const chapterKeys = new Set(rows.map((r) => r.chapterKey));

  const byType = new Map<string, number>();
  for (const r of real) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
  const sortedTypes = [...byType].sort((a, b) => b[1] - a[1]);

  const perChapter = new Map<string, number>();
  for (const k of chapterKeys) perChapter.set(k, 0);
  for (const r of real) perChapter.set(r.chapterKey, (perChapter.get(r.chapterKey) ?? 0) + 1);
  const counts = [...perChapter.values()];
  const meanYield = counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length);
  const sd = Math.sqrt(counts.reduce((s, v) => s + (v - meanYield) ** 2, 0) / Math.max(1, counts.length));

  const lengthByChapter = new Map<string, number>();
  for (const r of rows) lengthByChapter.set(r.chapterKey, r.paragraphs);
  const keys = [...perChapter.keys()];

  // A label repeated inside one chapter is the same beat reported twice.
  let duplicated = 0;
  const seenPerChapter = new Map<string, Set<string>>();
  for (const r of real) {
    const set = seenPerChapter.get(r.chapterKey) ?? new Set<string>();
    if (set.has(r.label)) duplicated++;
    set.add(r.label);
    seenPerChapter.set(r.chapterKey, set);
  }

  return {
    events: real.length,
    chapters: chapterKeys.size,
    emptyChapters: counts.filter((c) => c === 0).length,
    typeEntropy: normalisedEntropy(sortedTypes.map(([, c]) => c)),
    dominantType: sortedTypes[0]?.[0] ?? "-",
    dominantShare: real.length ? (sortedTypes[0]?.[1] ?? 0) / real.length : 0,
    distinctConfidences: new Set(real.map((r) => r.confidence.toFixed(3))).size,
    atCeiling: real.length ? real.filter((r) => r.confidence >= 0.999).length / real.length : 0,
    firstFive: real.length ? real.filter((r) => r.position <= 0.05).length / real.length : 0,
    lastFive: real.length ? real.filter((r) => r.position >= 0.95).length / real.length : 0,
    eventsPerChapter: meanYield,
    yieldStdDev: sd,
    yieldLengthCorr: correlation(
      keys.map((k) => lengthByChapter.get(k) ?? 0),
      keys.map((k) => perChapter.get(k) ?? 0),
    ),
    overBudget: real.length ? real.filter((r) => r.label.length > LABEL_BUDGET).length / real.length : 0,
    truncated: real.length ? real.filter((r) => r.label.endsWith("…")).length / real.length : 0,
    duplicated: real.length ? duplicated / real.length : 0,
  };
}

const pc = (x: number) => `${(x * 100).toFixed(1).padStart(6)}%`;
const num = (x: number, d = 2) => x.toFixed(d).padStart(7);

function print(engineName: string, byCorpus: Array<{ corpus: Corpus; report: Report }>) {
  console.log(`\n╔══ ${engineName} ${"═".repeat(Math.max(0, 56 - engineName.length))}`);
  const [a, b] = byCorpus;
  const head = byCorpus.map(({ corpus }) => corpus.label.padStart(15)).join("");
  console.log(`  ${"".padEnd(34)}${head}`);
  console.log(`  ${"".padEnd(34)}${byCorpus.map(({ corpus }) => (corpus.distribution === "held-out" ? "     (HELD OUT)" : "  (in-distrib)")).join("")}`);
  const line = (label: string, fmt: (r: Report) => string) =>
    console.log(`  ${label.padEnd(34)}${byCorpus.map(({ report }) => fmt(report).padStart(15)).join("")}`);

  line("chapters sampled", (r) => String(r.chapters));
  line("events found", (r) => String(r.events));
  line("chapters with none", (r) => String(r.emptyChapters));
  console.log("");
  line("type entropy (1.0 = even)", (r) => num(r.typeEntropy));
  line("dominant type", (r) => r.dominantType);
  line("  its share", (r) => pc(r.dominantShare));
  console.log("");
  line("distinct confidence values", (r) => String(r.distinctConfidences));
  line("confidence at the ceiling", (r) => pc(r.atCeiling));
  console.log("");
  line("events in the first 5%", (r) => pc(r.firstFive));
  line("events in the last 5%", (r) => pc(r.lastFive));
  console.log("");
  line("events per chapter", (r) => num(r.eventsPerChapter));
  line("  std dev", (r) => num(r.yieldStdDev));
  line("  correlation with length", (r) => num(r.yieldLengthCorr));
  console.log("");
  line("labels over budget", (r) => pc(r.overBudget));
  line("labels truncated", (r) => pc(r.truncated));
  line("labels duplicated in chapter", (r) => pc(r.duplicated));

  if (a && b) {
    // The headline number: how differently does the engine behave on a book it
    // was never tuned against?
    const gap = (f: (r: Report) => number) => Math.abs(f(a.report) - f(b.report));
    console.log("");
    console.log(`  in-distribution vs held-out GAP`);
    console.log(`    type entropy              ${num(gap((r) => r.typeEntropy))}`);
    console.log(`    events per chapter        ${num(gap((r) => r.eventsPerChapter))}`);
    console.log(`    edge bias (first 5%)      ${pc(gap((r) => r.firstFive))}`);
  }
}

async function main() {
  console.log(`# Out-of-distribution event audit`);
  console.log(`stride ${STRIDE}, up to ${LIMIT} chapters per book\n`);

  for (const engine of ENGINE === "both" ? (["old", "new"] as const) : ([ENGINE] as Array<"old" | "new">)) {
    const byCorpus = [];
    for (const corpus of CORPORA) {
      byCorpus.push({ corpus, report: analyse(await collect(corpus, engine)) });
    }
    print(
      engine === "old" ? "OLD  event-detect.ts (phrase dictionaries)" : "NEW  narrative-events.ts (clause-level)",
      byCorpus,
    );
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
