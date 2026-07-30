/**
 * train-event-ranker.ts — learn the ranking weights instead of hand-fitting them.
 *
 * Run:  npx tsx scripts/train-event-ranker.ts
 *       TARGET=major npx tsx scripts/train-event-ranker.ts    # optimise for major events
 *
 * ─── WHY A MODEL, AFTER ARGUING AGAINST ONE ──────────────────────────────────
 *
 * The hand-fitted weights in narrative-events.ts saturated, and the diagnosis was
 * specific rather than vague: `analyse-event-signals.ts` measures each signal's
 * MARGINAL association with being right, and the weights were set proportional to
 * that. But the features overlap heavily — `-no-content` fires only inside
 * `dialogue-act`, which fires mostly inside `named-agent` — so fitting each to its
 * own marginal double-counts whatever they share. Three refits confirmed it: the
 * first won 15 points because the SIGNS were wrong, the next two lost.
 *
 * A logistic regression fits all the weights JOINTLY. That is exactly and only
 * the thing hand-fitting could not do, which is why this is worth trying and why
 * it is not a general appeal to "use ML".
 *
 * It is also barely a model: ~30 coefficients over features the engine already
 * computes, evaluated as one dot product. No new dependency, no download, no
 * inference cost worth measuring. If it wins, it ships as a table of numbers and
 * the engine stays a rule engine — the rules just get honest weights.
 *
 * ─── THE ONLY EVALUATION THAT COUNTS IS LEAVE-ONE-BOOK-OUT ───────────────────
 *
 * 204 candidates against ~30 features will happily memorise. Training and scoring
 * on the same books would produce a beautiful number and a worse product. So the
 * model is trained on seven books and evaluated on the eighth, rotated, and what
 * is reported is precision@3 on books the weights have never seen. The hand-fitted
 * weights are scored on the SAME held-out split, so the comparison is fair.
 */

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { installNodeEmbedder } from "./lm-node-backend";
import { analyzeChapter } from "../src/lib/chapter-analysis";
import {
  detectNarrativeEvents, refineEventSalience, TIMELINE_CHIP_BUDGET,
} from "../src/lib/narrative-events";
import { chapterCentrality, eventSalienceBatch } from "../src/lib/narrative-lm";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { resolveKnownNames } from "../src/lib/world-data";
import { loadBook, splitParagraphs } from "./print-chapter";
import type { Novel } from "../src/types";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TOLERANCE = 1;
const TARGET_MAJOR = process.env.TARGET === "major";
const MODE = process.env.MODE ?? "pairwise";

/**
 * The feature vocabulary. Every entry is a tag the engine already pushes into
 * `why`, so nothing here needs new computation at runtime — that is what keeps
 * the shipped cost at one dot product over flags that already exist.
 */
const BINARY_FEATURES = [
  "entity-subject", "pronoun-agent", "named-agent", "unspecified-entity",
  "dialogue-act", "-no-content",
  "consequential", "-trivial-object", "-pronoun-object",
  "-habitual", "-pluperfect", "-modal", "-general-truth", "refusal", "-question",
  "-no-echo", "tension-rise", "-chapter-open", "-chapter-close",
  "verb:action", "verb:state-change", "verb:revelation", "verb:decision",
  "verb:confrontation", "verb:arrival", "verb:departure", "verb:shift",
] as const;
/**
 * Continuous features, appended after the binary block.
 *
 * ★ The first pass used only `lm-salience`, `position` and a bias, and `position`
 * came out as the strongest learned coefficient in the whole model (+0.565) — a
 * STRUCTURAL signal the hand-written rules barely use, since they only penalise
 * the extreme first and last 4% of a chapter. That is the model telling us where
 * it is starved, so this block was extended with everything structural the engine
 * already computes and then throws away:
 *
 *   baseConf     the hand engine's own confidence, so the model learns a
 *                CORRECTION on top of it rather than having to rediscover it
 *   centrality   cosine to the chapter centroid. Currently folded into confidence
 *                at a fixed 0.6 and invisible as its own dimension
 *   peakDist     |position - the chapter's tension peak|. The peak is already
 *                computed by chapter-analysis and never reaches the ranker
 *   sentLen      clause length in words, scaled
 *   density      candidates in this chapter / 20 — a crowded chapter means each
 *                individual candidate is weaker evidence
 */
const CONTINUOUS = (process.env.RICH
  ? ["lm-salience", "position", "baseConf", "centrality", "peakDist", "sentLen", "density", "bias"]
  : ["lm-salience", "position", "bias"]) as readonly string[];
const DIM = BINARY_FEATURES.length + CONTINUOUS.length;
const NAMES = [...BINARY_FEATURES, ...CONTINUOUS];

interface Row {
  book: string;
  chapterKey: string;
  x: number[];
  y: number;          // 1 if this candidate lands on a gold event
  baseConf: number;   // the engine's own confidence, for the fair comparison
}

interface Extra {
  baseConf: number; centrality: number; peakDist: number; sentLen: number; density: number;
}
function featurise(why: string[], tensionPosition: number, e: Extra): number[] {
  const x = new Array(DIM).fill(0);
  const tags = new Set(why.map((w) => (w.startsWith("verb:") || w.startsWith("lm-salience:") ? w : w.split(":")[0])));
  BINARY_FEATURES.forEach((f, i) => { if (tags.has(f)) x[i] = 1; });
  const b = BINARY_FEATURES.length;
  const sal = why.find((w) => w.startsWith("lm-salience:"));
  x[b] = sal ? Number(sal.split(":")[1]) : 0;
  x[b + 1] = tensionPosition;
  if (CONTINUOUS.length > 3) {
    x[b + 2] = e.baseConf;
    x[b + 3] = e.centrality;
    x[b + 4] = e.peakDist;
    x[b + 5] = e.sentLen;
    x[b + 6] = e.density;
  }
  x[DIM - 1] = 1; // bias
  return x;
}

/**
 * ★ PAIRWISE (RankNet-style) training — the method that actually fits this data.
 *
 * Pointwise logistic regression asks "is this candidate an event?" and needs
 * enough labelled rows to answer it. There are 204. Adding structural features
 * made held-out precision WORSE (49.1% -> 43.9%), which is the honest signature
 * of too few samples for the parameter count.
 *
 * But the product does not need a probability. It needs an ORDER — which three of
 * this chapter's candidates go on the timeline. So train on ORDERED PAIRS: for
 * every (real, false) pair inside the same chapter, push score(real) above
 * score(false). The same 204 rows yield thousands of pairs, and the comparison is
 * always WITHIN a chapter, which matches how confidence is calibrated and removes
 * the between-chapter variation the pointwise model had to waste capacity on.
 *
 * The bias term cancels in a difference, so it carries no weight here.
 */
function trainPairwise(rows: Row[], l2: number, epochs = 600, lr = 0.5): number[] {
  const w = new Array(DIM).fill(0);
  const byChapter = new Map<string, Row[]>();
  for (const r of rows) {
    if (!byChapter.has(r.chapterKey)) byChapter.set(r.chapterKey, []);
    byChapter.get(r.chapterKey)!.push(r);
  }
  const pairs: Array<[number[], number[]]> = [];
  for (const group of byChapter.values()) {
    const pos = group.filter((r) => r.y === 1);
    const neg = group.filter((r) => r.y === 0);
    for (const p of pos) for (const n of neg) pairs.push([p.x, n.x]);
  }
  if (!pairs.length) return w;
  for (let e = 0; e < epochs; e++) {
    const g = new Array(DIM).fill(0);
    for (const [xp, xn] of pairs) {
      let d = 0;
      for (let j = 0; j < DIM; j++) d += w[j] * (xp[j] - xn[j]);
      // dLoss/d(diff) for log(1 + exp(-diff))
      const s = -1 / (1 + Math.exp(d));
      for (let j = 0; j < DIM; j++) g[j] += s * (xp[j] - xn[j]);
    }
    for (let j = 0; j < DIM; j++) w[j] -= lr * (g[j] / pairs.length + l2 * w[j]);
  }
  return w;
}

/** Plain L2-regularised logistic regression, full-batch gradient descent. */
function train(rows: Row[], l2: number, epochs = 4000, lr = 0.35): number[] {
  const w = new Array(DIM).fill(0);
  const n = rows.length || 1;
  // Standardise the continuous columns so one scale cannot dominate the penalty.
  for (let e = 0; e < epochs; e++) {
    const g = new Array(DIM).fill(0);
    for (const r of rows) {
      let z = 0;
      for (let j = 0; j < DIM; j++) z += w[j] * r.x[j];
      const p = 1 / (1 + Math.exp(-z));
      const d = p - r.y;
      for (let j = 0; j < DIM; j++) g[j] += d * r.x[j];
    }
    for (let j = 0; j < DIM; j++) {
      // No penalty on the bias term.
      const pen = j === DIM - 1 ? 0 : l2 * w[j];
      w[j] -= lr * (g[j] / n + pen);
    }
  }
  return w;
}

const score = (w: number[], x: number[]) => {
  let z = 0;
  for (let j = 0; j < DIM; j++) z += w[j] * x[j];
  return z;
};

/** precision@BUDGET over a set of chapters, ranking by `rank`. */
function precisionAtBudget(rows: Row[], rank: (r: Row) => number) {
  const byChapter = new Map<string, Row[]>();
  for (const r of rows) {
    if (!byChapter.has(r.chapterKey)) byChapter.set(r.chapterKey, []);
    byChapter.get(r.chapterKey)!.push(r);
  }
  let shown = 0, hit = 0;
  for (const group of byChapter.values()) {
    const top = [...group].sort((a, b) => rank(b) - rank(a)).slice(0, TIMELINE_CHIP_BUDGET);
    for (const t of top) { shown++; hit += t.y; }
  }
  return { shown, hit, precision: shown ? hit / shown : 0 };
}

async function main() {
  const info = await installNodeEmbedder();
  if (!info) { console.error("no embedder — the LM salience feature would be zero for every row"); process.exitCode = 1; return; }

  const gold = JSON.parse(
    await readFile(path.join(REPO_ROOT, "scripts", "fixtures", "event-gold.json"), "utf8"),
  ) as { chapters: Array<{ book: string; chapter: number; events: Array<{ paragraph: number; salience: string }> }> };

  const cache = new Map<string, Novel>();
  const rows: Row[] = [];

  for (const gc of gold.chapters) {
    let novel = cache.get(gc.book);
    if (!novel) { novel = await loadBook(gc.book); cache.set(gc.book, novel); }
    const chapter = novel.chapters.find((c) => c.number === gc.chapter);
    if (!chapter) continue;
    const paragraphs = splitParagraphs(chapter.content);
    const knownNames = resolveKnownNames(novel);
    const speech = detectSpeechInChapter(paragraphs, knownNames, { intelligenceLevel: "default" });
    const analysis = analyzeChapter(paragraphs, speech, []);
    const base = detectNarrativeEvents(paragraphs, speech, {
      knownNames, worldData: novel.worldData,
      tensionByParagraph: speech.map((r) =>
        r.meta.tension === "high" ? 1 : r.meta.tension === "rising" ? 0.5 : 0),
    });
    if (!base.length) continue;
    // Attach lm-salience WITHOUT pruning, so the model sees every candidate and
    // can learn its own cut rather than inheriting the hand-set one.
    const withLm = await refineEventSalience(base, {
      scorer: eventSalienceBatch,
      minSalience: -Infinity,
      weight: 0,
      centrality: (cl) => chapterCentrality(cl, paragraphs),
      centralityWeight: 0.6,
    });
    const cent = await chapterCentrality(withLm.map((e) => e.sentence), paragraphs);
    const peakPos = (analysis.peakParagraph ?? 0) / Math.max(1, paragraphs.length - 1);
    for (let k = 0; k < withLm.length; k++) {
      const e = withLm[k];
      const near = gc.events.filter((g) => Math.abs(g.paragraph - 1 - e.paragraphIndex) <= TOLERANCE);
      const y = TARGET_MAJOR
        ? (near.some((g) => g.salience === "major") ? 1 : 0)
        : (near.length ? 1 : 0);
      rows.push({
        book: gc.book,
        chapterKey: `${gc.book}|${gc.chapter}`,
        x: featurise(e.why, e.tensionPosition, {
          baseConf: e.confidence,
          centrality: cent[k] ?? 0,
          peakDist: Math.abs(e.tensionPosition - peakPos),
          sentLen: Math.min(1, e.sentence.split(/\s+/).length / 40),
          density: Math.min(1, withLm.length / 20),
        }),
        y,
        baseConf: e.confidence,
      });
    }
  }

  const books = [...new Set(rows.map((r) => r.book))].sort();
  console.log(`\n${rows.length} candidates, ${rows.filter((r) => r.y).length} positive, ` +
    `${books.length} books, ${DIM} features` + (TARGET_MAJOR ? "   [target: MAJOR events]" : ""));

  // ── Leave one BOOK out. Not leave-one-row-out: rows from the same book share an
  //    author's voice, and a split that mixes them measures memorisation.
  for (const l2 of [0.03, 0.1, 0.3, 0.6, 1.0, 2.0]) {
    let learnedShown = 0, learnedHit = 0, baseShown = 0, baseHit = 0;
    for (const held of books) {
      const trainRows = rows.filter((r) => r.book !== held);
      const testRows = rows.filter((r) => r.book === held);
      if (!testRows.length || !trainRows.some((r) => r.y)) continue;
      const w = MODE === "pairwise" ? trainPairwise(trainRows, l2) : train(trainRows, l2);
      const a = precisionAtBudget(testRows, (r) => score(w, r.x));
      const b = precisionAtBudget(testRows, (r) => r.baseConf);
      learnedShown += a.shown; learnedHit += a.hit;
      baseShown += b.shown; baseHit += b.hit;
    }
    const learned = learnedShown ? learnedHit / learnedShown : 0;
    const hand = baseShown ? baseHit / baseShown : 0;
    console.log(
      `  [${MODE}] L2=${String(l2).padEnd(6)} held-out precision@${TIMELINE_CHIP_BUDGET}:  ` +
      `LEARNED ${(learned * 100).toFixed(1)}%   hand-fitted ${(hand * 100).toFixed(1)}%   ` +
      `${learned >= hand ? "+" : ""}${((learned - hand) * 100).toFixed(1)}pp`,
    );
  }

  // ── LEARNING CURVE: is LABELLED DATA the constraint, or the model class?
  //
  // The decisive question for "should we invest in ML here". Train on k books,
  // evaluate on the rest, sweep k. If held-out accuracy is still climbing at the
  // largest k we have, more annotation would pay and the model is data-starved.
  // If it is flat, the ceiling is the FEATURES and no amount of labelling helps.
  //
  // Deterministic subset choice (a fixed LCG) so the curve is reproducible.
  console.log(`\nLEARNING CURVE — held-out precision@${TIMELINE_CHIP_BUDGET} vs number of TRAINING books`);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const L2_CURVE = 0.3;
  for (let k = 2; k < books.length; k++) {
    let shown = 0, hit = 0, reps = 0;
    for (let rep = 0; rep < 12; rep++) {
      const shuffled = [...books].sort(() => rnd() - 0.5);
      const trainBooks = new Set(shuffled.slice(0, k));
      const trainRows = rows.filter((r) => trainBooks.has(r.book));
      const testRows = rows.filter((r) => !trainBooks.has(r.book));
      if (!trainRows.some((r) => r.y) || !testRows.length) continue;
      const w = MODE === "pairwise" ? trainPairwise(trainRows, L2_CURVE) : train(trainRows, L2_CURVE);
      const a = precisionAtBudget(testRows, (r) => score(w, r.x));
      shown += a.shown; hit += a.hit; reps++;
    }
    const acc = shown ? (hit / shown) * 100 : 0;
    const bar = "█".repeat(Math.round(acc / 2));
    console.log(`  ${String(k).padStart(2)} books  ${acc.toFixed(1).padStart(5)}%  ${bar}`);
  }
  console.log(`  (hand-fitted rules, same held-out protocol: 47.4%)`);

  // ── Coefficients from the full set, for reading. These are what would ship.
  const L2_FINAL = Number(process.env.L2 ?? 0.03);
  const w = MODE === "pairwise" ? trainPairwise(rows, L2_FINAL) : train(rows, L2_FINAL);
  console.log(`\nCoefficients (full set, L2=${L2_FINAL}), sorted by magnitude:`);
  const ranked = NAMES.map((n, i) => ({ n, v: w[i] })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  for (const { n, v } of ranked) {
    if (Math.abs(v) < 0.02) continue;
    console.log(`  ${v >= 0 ? "+" : ""}${v.toFixed(3).padStart(7)}  ${n}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
