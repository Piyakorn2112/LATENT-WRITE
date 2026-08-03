/**
 * probe-assist-funnels.ts — is there work here, before anything is built?
 *
 * Three proposed assistant consumers, measured the way the knowledge ledger
 * was: count the funnel, do not hypothesise. Both failure modes kill a feature
 * before it ships, so both are reported per chapter:
 *
 *   ~0 per chapter    nothing to adjudicate — the deterministic layer already
 *                     answers, and a model call would be theatre
 *   ~dozens           every chapter lights up; the writer turns it off, or the
 *                     background sweep never drains
 *
 * 1. ATTRIBUTION TIE-BREAKS  spans the engine itself flagged `needsReview`, or
 *    whose top-two candidates are within a hair. These are the app's core
 *    metric: every widget downstream consumes attribution.
 * 2. CONTINUITY  Chekhov candidates (introduced, never recurs) and time/place
 *    hand-off drift. Regex heuristics today, same generator/adjudicator shape
 *    as the ledger.
 * 3. SCENE FUNCTION  scenes where `classifyScene` ABSTAINED. It abstains by
 *    design (gate → floor → margin), so its silences are a ready-made queue,
 *    and the near-ties are the ones worth a second opinion.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/probe-assist-funnels.ts
 */
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { classifyScene } from "../src/lib/scene-function";
import { summarizeContinuity } from "../src/lib/continuity";
import { resolveSpeakerCandidates, resolveEntityNameMap } from "../src/lib/world-data";
import { loadBook, splitParagraphs } from "./print-chapter";

const DEV_BOOKS = ["pride", "sherlock", "anne", "dracula", "carol", "webnovel"];
const MAX_CHAPTERS = 16;
/** Below this gap the engine's top two speakers are effectively tied. */
const TIE_GAP = 0.12;
/** The band where attribution is neither confident nor absent. */
const UNSURE_LO = 0.25;
const UNSURE_HI = 0.78;

interface Row {
  book: string;
  chapters: number;
  ties: number;       // attribution spans worth a second opinion
  chekhov: number;    // introduced-never-recurs phrases
  handoff: number;    // chapters with a time/place drift
  abstained: number;  // scenes classifyScene declined to label
  scenes: number;
}

const pad = (v: string | number, n: number) => String(v).padStart(n);

async function run(book: string): Promise<Row | null> {
  const novel = await loadBook(book);
  const names = resolveSpeakerCandidates(novel);
  if (names.length < 3) return null;
  const entityMap = resolveEntityNameMap(novel);
  const chapters = novel.chapters.slice(0, MAX_CHAPTERS);

  let ties = 0, chekhov = 0, handoff = 0, abstained = 0, scenes = 0;

  chapters.forEach((chapter, index) => {
    const paragraphs = splitParagraphs(chapter.content);
    const results = detectSpeechInChapter(paragraphs, names, { intelligenceLevel: "high" });

    // 1 — attribution. An UNATTRIBUTED span (confidence 0) is a different
    //     problem: there is no candidate to choose between, so it is not a
    //     tie-break. Count only spans the engine half-answered.
    for (const result of results) {
      for (const segment of result.segments) {
        if (segment.type !== "speech") continue;
        const c = segment.confidence;
        if (segment.speaker && c > UNSURE_LO && c < UNSURE_HI) ties++;
      }
    }

    // 3 — scene function. Re-derive the same scene grouping the engine uses by
    //     asking classifyScene over each run of paragraphs between sceneStarts.
    let start = 0;
    const flush = (end: number) => {
      if (end <= start) return;
      scenes++;
      const slice = paragraphs.slice(start, end);
      const density = results.slice(start, end).map((r) => r.meta.dialogueDensity);
      const tension = results[start]?.meta.tension ?? "calm";
      if (!classifyScene({ paragraphs: slice, dialogueDensity: density, tension })) abstained++;
    };
    results.forEach((result, i) => {
      if (i > 0 && result.meta.sceneStart) { flush(i); start = i; }
    });
    flush(results.length);

    // 2 — continuity, exactly as the widget computes it.
    const summary = summarizeContinuity(novel.chapters, novel.worldData, index);
    chekhov += summary.chekhov.length;
    if (summary.handoff?.drift) handoff++;
  });

  void entityMap;
  return { book, chapters: chapters.length, ties, chekhov, handoff, abstained, scenes };
}

async function main() {
  console.log("═".repeat(78));
  console.log("assistant funnels — is there work here? (DEV books, per chapter)");
  console.log("═".repeat(78));
  console.log(`\n  ${"book".padEnd(10)} ${pad("ch", 3)} ${pad("ties", 6)} ${pad("/ch", 6)} ${pad("chekhov", 8)} ${pad("/ch", 5)} ${pad("drift", 6)} ${pad("scenes", 7)} ${pad("abstain", 8)} ${pad("%", 5)}`);

  const totals = { chapters: 0, ties: 0, chekhov: 0, handoff: 0, abstained: 0, scenes: 0 };
  for (const book of DEV_BOOKS) {
    const row = await run(book);
    if (!row) { console.log(`  ${book.padEnd(10)} (cast too small)`); continue; }
    totals.chapters += row.chapters; totals.ties += row.ties;
    totals.chekhov += row.chekhov; totals.handoff += row.handoff;
    totals.abstained += row.abstained; totals.scenes += row.scenes;
    console.log(
      `  ${row.book.padEnd(10)} ${pad(row.chapters, 3)} ${pad(row.ties, 6)} ${pad((row.ties / row.chapters).toFixed(1), 6)} ` +
      `${pad(row.chekhov, 8)} ${pad((row.chekhov / row.chapters).toFixed(1), 5)} ${pad(row.handoff, 6)} ` +
      `${pad(row.scenes, 7)} ${pad(row.abstained, 8)} ${pad(row.scenes ? `${Math.round((row.abstained / row.scenes) * 100)}%` : "—", 5)}`,
    );
  }

  const per = (n: number) => (n / Math.max(1, totals.chapters)).toFixed(2);
  console.log(`\n  ── per chapter, across ${totals.chapters} chapters ──`);
  console.log(`  attribution tie-breaks   ${per(totals.ties)}`);
  console.log(`  chekhov candidates       ${per(totals.chekhov)}`);
  console.log(`  hand-off drift           ${per(totals.handoff)}`);
  console.log(`  scene abstentions        ${per(totals.abstained)}  (${totals.abstained}/${totals.scenes} scenes)`);

  const verdict = (label: string, n: number) => {
    const v = n / Math.max(1, totals.chapters);
    const call = v < 0.05 ? "TOO SPARSE — the engine already answers"
      : v > 12 ? "TOO NOISY — a sweep would never drain"
      : v > 4 ? "HIGH — needs a cut before it is a queue"
      : "IN BAND";
    console.log(`  ${label.padEnd(26)} ${v.toFixed(2)}/ch  ${call}`);
  };
  console.log(`\n  ── verdict ──`);
  verdict("attribution tie-breaks", totals.ties);
  verdict("chekhov", totals.chekhov);
  verdict("hand-off drift", totals.handoff);
  verdict("scene abstentions", totals.abstained);
  console.log("\n" + "═".repeat(78));
}

main().catch((e) => { console.error(e); process.exit(1); });
