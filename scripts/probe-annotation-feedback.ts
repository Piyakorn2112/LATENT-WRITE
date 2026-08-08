/**
 * probe-annotation-feedback.ts — DOES CORRECTING THE ENGINE MAKE IT BETTER?
 *
 * The annotation loop's whole promise is that a correction teaches the
 * engine something. Nothing in the repo has ever measured that. This script
 * replays the loop the way a real user drives it, against auto-labelled gold
 * from the corpus, and reports accuracy on spans the user NEVER touched.
 *
 * ★ THE MEASUREMENT THAT MATTERS IS HELD-OUT. Corrected spans are trivially
 *   "fixed" only if something pins them (nothing currently does — the store
 *   feeds a global bias, not a pin). The user's actual complaint is about
 *   spillover: corrections in one place changing answers everywhere else. So
 *   gold is split into a CORRECTION pool and a disjoint EVAL pool, and only
 *   EVAL is scored. A healthy learner climbs; a biased one decays.
 *
 * ★ THE GOLD IS THE EASY CASE ON PURPOSE (same limitation as
 *   test-attribution-corpus.ts): `"…," said <Name>.` and the mirror
 *   `"…," <Name> said.` where <Name> is in the book's own cast. These are
 *   unambiguous, so a WRONG answer here is unambiguously wrong. A learner
 *   that degrades on the easy case is degrading, full stop.
 *
 * ★ THIS PROBE IS THE EVIDENCE FOR A DECISION ALREADY TAKEN. It calls
 *   computeLearnedBias and hands it to the detector directly, which the APP
 *   no longer does: corrections are applied as pins (src/lib/annotation-pins.ts)
 *   and detection runs at the untouched baseline. Keep the probe. It is what
 *   any future "let's make corrections teach the engine" proposal has to beat,
 *   and re-running it is how you check a new learner is not repeating this.
 *
 * Run: ./node_modules/.bin/tsx scripts/probe-annotation-feedback.ts
 */
import { loadBook, splitParagraphs } from "./print-chapter";
import { resolveKnownNames } from "../src/lib/world-data";
import {
  detectSpeechInChapter,
  type ChapterEndContext,
  type IntelligenceLevel,
} from "../src/lib/speech-detect";
import { computeLearnedBias } from "../src/lib/annotation-learn";
import type { AnnotationCorrection, AnnotationStore, LearnedBias } from "../src/types";

const BOOK_KEYS = ["pride", "sherlock", "expectations", "gatsby", "anne", "dracula"];
const LEVEL: IntelligenceLevel = "default";

// ── gold extraction (mirrors test-attribution-corpus.ts) ────────────────────
const HONORIFIC_TOKENS = [
  "Mr", "Mrs", "Ms", "Dr", "Miss", "Sir", "Lord", "Lady", "Captain", "Colonel",
  "Professor", "Aunt", "Uncle", "Madame", "Monsieur", "Mademoiselle",
];
const HONORIFIC_ALT = HONORIFIC_TOKENS.join("|");
const CLOSE_Q = `[”"]`;
const LEAD_VERB_ALT = "said|asked|replied|answered";

const nameTagRe = () => new RegExp(
  `${CLOSE_Q}\\s*,?\\s*said\\s+((?:(?:${HONORIFIC_ALT})\\.?\\s+)?[A-Z][A-Za-z'’-]*(?:\\s+[A-Z][A-Za-z'’-]*){0,2})\\s*[.,!?]`,
  "g",
);
const leadNameTagRe = () => new RegExp(
  `${CLOSE_Q}\\s*,?\\s*([A-Z][A-Za-z'’-]*(?:\\s+[A-Z][A-Za-z'’-]*){0,2})\\s+(?:\\w+\\s+){0,1}(?:${LEAD_VERB_ALT})\\s*[.,!?]`,
  "g",
);

function resolveAgainstCast(captured: string, lookup: Map<string, string>): string | undefined {
  const direct = lookup.get(captured.toLowerCase());
  if (direct) return direct;
  const words = captured.trim().split(/\s+/);
  if (words.length > 1) {
    const viaLast = lookup.get(words[words.length - 1].toLowerCase());
    if (viaLast) return viaLast;
  }
  return undefined;
}

interface GoldSpan {
  chapterId: string;
  chapterIndex: number;
  paragraphIndex: number;
  closeIdx: number;
  expected: string;
}

interface BookData {
  key: string;
  knownNames: string[];
  chapters: Array<{ id: string; paragraphs: string[] }>;
  gold: GoldSpan[];
}

async function loadBookData(key: string): Promise<BookData> {
  const novel = await loadBook(key);
  const knownNames = resolveKnownNames(novel);
  const lookup = new Map(knownNames.map((n) => [n.toLowerCase(), n]));
  const chapters = novel.chapters.map((c, i) => ({
    id: `${key}-ch${i}`,
    paragraphs: splitParagraphs(c.content),
  }));

  const gold: GoldSpan[] = [];
  for (const [chapterIndex, chapter] of chapters.entries()) {
    for (const [paragraphIndex, p] of chapter.paragraphs.entries()) {
      for (const re of [nameTagRe(), leadNameTagRe()]) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(p))) {
          const expected = resolveAgainstCast(m[1], lookup);
          if (!expected) continue;
          gold.push({
            chapterId: chapter.id, chapterIndex, paragraphIndex,
            closeIdx: m.index, expected,
          });
        }
      }
    }
  }
  return { key, knownNames, chapters, gold };
}

// ── one full detection pass over a book, scored against a gold subset ───────

interface Predicted { got: string | null; segIndex: number; spanText: string; before: string; after: string }

function runBook(book: BookData, bias: LearnedBias | null): Map<string, Predicted> {
  const out = new Map<string, Predicted>();
  let prevContext: ChapterEndContext | null = null;
  for (const chapter of book.chapters) {
    const contextOut: { value: ChapterEndContext | null } = { value: null };
    const results = detectSpeechInChapter(chapter.paragraphs, book.knownNames, {
      intelligenceLevel: LEVEL,
      prevChapterContext: prevContext ?? undefined,
      contextOut,
      ...(bias ? { learnedBias: bias } : {}),
    });
    prevContext = contextOut.value;
    for (const [paragraphIndex, p] of chapter.paragraphs.entries()) {
      const result = results[paragraphIndex];
      if (!result) continue;
      for (const [segIndex, s] of result.segments.entries()) {
        if (s.type !== "speech") continue;
        out.set(`${chapter.id}|${paragraphIndex}|${s.end - 1}`, {
          got: s.speaker ?? null,
          segIndex,
          spanText: p.slice(s.start, s.end),
          before: p.slice(Math.max(0, s.start - 80), s.start),
          after: p.slice(s.end, s.end + 80),
        });
      }
    }
  }
  return out;
}

function scoreOn(book: BookData, spans: GoldSpan[], preds: Map<string, Predicted>) {
  let correct = 0, wrong = 0, missing = 0;
  for (const g of spans) {
    const pred = preds.get(`${g.chapterId}|${g.paragraphIndex}|${g.closeIdx}`);
    if (!pred) { missing++; continue; }
    if (pred.got && pred.got.toLowerCase() === g.expected.toLowerCase()) correct++;
    else wrong++;
  }
  const scored = correct + wrong;
  return { correct, wrong, missing, scored, acc: scored > 0 ? correct / scored : 0 };
}

// ── the replay ──────────────────────────────────────────────────────────────

function makeCorrection(g: GoldSpan, pred: Predicted): AnnotationCorrection {
  return {
    id: `${g.chapterId}:${g.paragraphIndex}:${pred.segIndex}`,
    timestamp: Date.now(),
    chapterId: g.chapterId,
    paragraphIndex: g.paragraphIndex,
    spanIndex: pred.segIndex,
    spanType: "speech",
    originalSpeaker: pred.got,
    correctedSpeaker: g.expected,
    spanText: pred.spanText,
    contextBefore: pred.before,
    contextAfter: pred.after,
  };
}

async function main() {
  console.log(`\nANNOTATION FEEDBACK REPLAY  ·  level=${LEVEL}`);
  console.log("Held-out accuracy (spans the user never corrected) vs corrections made.\n");

  const rows: Array<{ book: string; round: number; corrections: number; acc: number; scored: number }> = [];

  for (const key of BOOK_KEYS) {
    const book = await loadBookData(key);
    if (book.gold.length < 40) { console.log(`  ${key}: only ${book.gold.length} gold spans, skipped`); continue; }

    // Deterministic disjoint split: alternate spans into correction / eval pools.
    const pool = book.gold.filter((_, i) => i % 2 === 0);
    const evalSpans = book.gold.filter((_, i) => i % 2 === 1);
    const chapterIds = book.chapters.map((c) => c.id);

    let store: AnnotationStore = { version: 1, corrections: [] };
    const base = runBook(book, null);
    const baseline = scoreOn(book, evalSpans, base);
    rows.push({ book: key, round: 0, corrections: 0, acc: baseline.acc, scored: baseline.scored });
    console.log(`  ${key.padEnd(13)} gold=${String(book.gold.length).padStart(4)}  eval=${String(evalSpans.length).padStart(4)}`);
    console.log(`    round 0   corrections=  0   held-out acc = ${(baseline.acc * 100).toFixed(1)}%  (n=${baseline.scored})`);

    // ★ THE HEAVY-ANNOTATION CASE, WHICH IS THE ONE THE OWNER REPORTED.
    //   Harvesting only engine errors on this easy gold yields 3-7
    //   corrections — under LEARN_THRESHOLD (10), so the bias returns null
    //   and nothing is exercised. A real user hits the threshold fast
    //   because most dialogue is the HARD kind this gold cannot label.
    //   So: record a correction for every pooled gold span, i.e. feed the
    //   system PERFECTLY TRUE labels. If held-out accuracy still falls, the
    //   defect is structural, not a data-quality problem.
    let preds = base;
    for (const budget of [10, 20, 40, 80, 160, 320]) {
      const take: AnnotationCorrection[] = [];
      for (const g of pool) {
        if (take.length >= budget) break;
        const pred = preds.get(`${g.chapterId}|${g.paragraphIndex}|${g.closeIdx}`);
        if (!pred) continue;
        take.push(makeCorrection(g, pred));
      }
      if (take.length < budget) break;
      store = { ...store, corrections: take };

      // The app computes the bias for the chapter being read; use the chapter
      // with the most corrections as the "current" one, the realistic case.
      const byChapter = new Map<string, number>();
      for (const c of take) byChapter.set(c.chapterId, (byChapter.get(c.chapterId) ?? 0) + 1);
      const currentChapterId = [...byChapter.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

      const bias = computeLearnedBias(store, undefined, { currentChapterId, chapterIds });
      preds = runBook(book, bias);
      const s = scoreOn(book, evalSpans, preds);
      rows.push({ book: key, round: budget, corrections: take.length, acc: s.acc, scored: s.scored });
      const delta = (s.acc - baseline.acc) * 100;
      const mark = delta < -0.05 ? " ← WORSE" : delta > 0.05 ? " ← better" : "";
      console.log(`    corrections=${String(take.length).padStart(3)}   held-out acc = ${(s.acc * 100).toFixed(1)}%  (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp)${mark}`);
    }
    console.log("");
  }

  // ── blast radius ──────────────────────────────────────────────────────────
  //
  // ★ THE GOLD IS BLIND TO THE DAMAGE, AND THAT IS THE FINDING. Explicit-tag
  //   spans resolve at an early tier, so the learned bias cannot move them —
  //   held-out accuracy above is flat to the decimal. The bias acts on the
  //   HARD majority instead, which this gold structurally cannot label. So
  //   measure the blast radius directly: how many attributions ANYWHERE in
  //   the book change when corrections accumulate. Benefit we cannot see,
  //   churn we can, is the whole complaint in one number.
  console.log("\nBLAST RADIUS (attributions changed book-wide by the learned bias)");
  for (const key of ["expectations", "anne"]) {
    const book = await loadBookData(key);
    if (book.gold.length < 40) continue;
    const chapterIds = book.chapters.map((c) => c.id);
    const base = runBook(book, null);
    const pool = book.gold.filter((_, i) => i % 2 === 0);
    for (const n of [10, 50, 100, 200]) {
      const take: AnnotationCorrection[] = [];
      for (const g of pool) {
        if (take.length >= n) break;
        const pred = base.get(`${g.chapterId}|${g.paragraphIndex}|${g.closeIdx}`);
        if (pred) take.push(makeCorrection(g, pred));
      }
      if (take.length < n) break;
      const byCh = new Map<string, number>();
      for (const c of take) byCh.set(c.chapterId, (byCh.get(c.chapterId) ?? 0) + 1);
      const currentChapterId = [...byCh.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const bias = computeLearnedBias({ version: 1, corrections: take }, undefined, { currentChapterId, chapterIds });
      if (!bias) { console.log(`  ${key} n=${n}: bias null`); continue; }
      const withBias = runBook(book, bias);
      let flips = 0;
      for (const [k, v] of base) if ((withBias.get(k)?.got ?? null) !== v.got) flips++;
      const top = Object.entries(bias.speakerPriors).sort((a, b) => b[1] - a[1]).slice(0, 3);
      console.log(`  ${key.padEnd(13)} n=${String(n).padStart(3)}  flips=${String(flips).padStart(4)} / ${base.size} segments (${(flips / base.size * 100).toFixed(1)}%)   topPriors=${top.map(([nm, v]) => `${nm}:${v.toFixed(2)}`).join(" ")}`);
    }
  }
  console.log("  (speakWeights natural max is 1.0 for 'just spoke', decaying x0.80/para;");
  console.log("   a prior of 5.00 outranks a live speaker for ~8 paragraphs.)\n");

  // ── verdict ───────────────────────────────────────────────────────────────
  console.log("SUMMARY (held-out accuracy change from baseline, by corrections made)");
  const books = [...new Set(rows.map((r) => r.book))];
  let worse = 0, better = 0, flat = 0;
  for (const b of books) {
    const rs = rows.filter((r) => r.book === b);
    const b0 = rs[0].acc;
    const last = rs[rs.length - 1];
    const delta = (last.acc - b0) * 100;
    if (delta < -0.05) worse++; else if (delta > 0.05) better++; else flat++;
    console.log(`  ${b.padEnd(13)} ${(b0 * 100).toFixed(1)}% → ${(last.acc * 100).toFixed(1)}%  (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp after ${last.corrections} corrections)`);
  }
  console.log(`\n  books degraded: ${worse}   improved: ${better}   unchanged: ${flat}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
