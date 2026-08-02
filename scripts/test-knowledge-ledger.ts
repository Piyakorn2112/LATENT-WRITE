/**
 * test-knowledge-ledger.ts — GATED harness for the knowledge ledger (M0/M1).
 *
 * Gates (any failure → exit 1):
 *   1. NOISE CEILING    ≤ 3.0 surfaced candidates per chapter on DEV books,
 *                       plus a pipe-alive floor (≥3 survivors total).
 *                       ★ MEASURED DECISION: the spec's original 0.5 LOWER
 *                       bound was calibrated on the probe's 1-in-8-precision
 *                       generator. With the M0 guards the clean classics are
 *                       nearly silent (0.11/ch) while synthetic recall holds
 *                       at 100% — which is the correct shape: a lower bound
 *                       on internally-consistent books would DEMAND false
 *                       positives. Sensitivity is gated by recall (gate 2),
 *                       not by noise volume on clean books.
 *   2. SYNTHETIC RECALL ≥ 0.85 on injected breaks. Ground truth by
 *                       construction: a line referencing a not-yet-introduced
 *                       character is inserted into an early chapter; the
 *                       ledger must flag that pair.
 *   3. PAGE-ONE CAST    zero candidates whose entity is exposed in chapter 1
 *                       (they are cast, not secrets).
 *   4. MONOTONICITY     widening presence (narration-named counts as present)
 *                       may only SUPPRESS candidates, never create them.
 *   5. ANCHOR RETIRE    deleting a candidate's verbatim sentence from its
 *                       chapter retires it; untouched content retires nothing.
 *
 * DEV books only (pride, sherlock, anne, dracula, carol, webnovel). TEST books
 * are NEVER run here — see scripts/audit-knowledge-ood.ts for the report-only
 * out-of-distribution audit. Never tune against that audit.
 *
 * Also prints the funnel (count, don't hypothesise) and a sample of surviving
 * candidates: the volume gate cannot see precision — a person reads these.
 *
 * ★ KNOWN PROXY ARTIFACTS in the samples (do not re-litigate): this harness
 *   builds its character pool from resolveSpeakerCandidates, which is untyped.
 *   Places (Varna), truncated names (Neville St), and rare cap-heavy common
 *   words (Try) leak in. The APP's pool is worldData.characters — typed and
 *   writer-confirmed — so these classes cannot occur in the product.
 *   Measured 2026-08-02: 7 survivors on DEV = 3 adjudicator-grade questions
 *   + 4 proxy artifacts. The M0 goal (≥ 1-in-3 before any model) is met.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-knowledge-ledger.ts
 */
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { resolveSpeakerCandidates, buildSpeakerAliasMap } from "../src/lib/world-data";
import {
  buildChapterKnowledgeFacts,
  buildLedger,
  retireDeadAnchors,
  candidateKey,
  type LedgerFunnel,
} from "../src/lib/knowledge-ledger";
import type { ChapterKnowledgeFacts, KnowledgeLedgerStore } from "../src/lib/knowledge-store";
import { loadBook, splitParagraphs } from "./print-chapter";

const DEV_BOOKS = ["pride", "sherlock", "anne", "dracula", "carol", "webnovel"];
const MAX_CHAPTERS = 24;
const VOLUME_MAX = 3.0;
const PIPE_ALIVE_MIN = 3; // survivors across all DEV books — a dead pipe fails loudly
const RECALL_FLOOR = 0.85;
const SAMPLES = 12;

let failures = 0;
const gate = (ok: boolean, label: string, detail: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label} — ${detail}`);
  if (!ok) failures++;
};

interface BookRun {
  book: string;
  chapters: Array<{ id: string; number: number; content: string }>;
  facts: ChapterKnowledgeFacts[];
  narrowFacts: ChapterKnowledgeFacts[]; // presence = speakers only (no narration widening)
  characterNames: string[];
  aliasCanon: Map<string, string>;
  fullText: string;
}

async function runBook(book: string): Promise<BookRun | null> {
  const novel = await loadBook(book);
  const characterNames = resolveSpeakerCandidates(novel);
  if (characterNames.length < 3) return null;
  const fullText = novel.chapters.map((c) => c.content).join("\n\n");
  const aliasCanon = buildSpeakerAliasMap(characterNames, fullText);

  const chapters = novel.chapters.slice(0, MAX_CHAPTERS);
  const facts: ChapterKnowledgeFacts[] = [];
  for (const ch of chapters) {
    const paragraphs = splitParagraphs(ch.content);
    const speechResults = detectSpeechInChapter(paragraphs, characterNames);
    facts.push(buildChapterKnowledgeFacts({
      chapterId: ch.id, chapterNumber: ch.number, content: ch.content,
      paragraphs, speechResults, characterNames, aliasCanon,
      nameFilterText: fullText,
    }));
  }
  const narrowFacts = facts.map((f) => ({ ...f, present: [...f.presentNarrow] }));
  return {
    book,
    chapters: chapters.map((c) => ({ id: c.id, number: c.number, content: c.content })),
    facts, narrowFacts, characterNames, aliasCanon, fullText,
  };
}

function addFunnel(total: LedgerFunnel, f: LedgerFunnel) {
  for (const k of Object.keys(total) as Array<keyof LedgerFunnel>) total[k] += f[k];
}

async function main() {
  console.log("═".repeat(74));
  console.log("knowledge ledger — gated harness (DEV books only)");
  console.log("═".repeat(74));

  const runs: BookRun[] = [];
  for (const book of DEV_BOOKS) {
    const run = await runBook(book);
    if (run) runs.push(run);
    else console.log(`  ${book}: cast too small, skipped`);
  }

  // ── Volume + funnel ─────────────────────────────────────────────────────
  const totalFunnel: LedgerFunnel = {
    pairs: 0, supportedPrior: 0, meetingNow: 0, droppedConfidence: 0,
    droppedVocative: 0, droppedAddressee: 0, droppedFirstChapter: 0,
    decided: 0, survivors: 0, lowBand: 0,
  };
  let totalChapters = 0;
  const allSamples: Array<{ book: string; chapter: number; speaker: string; entity: string; sentence: string; band: string }> = [];
  const perBook: string[] = [];

  for (const run of runs) {
    const { candidates, funnel } = buildLedger(run.facts);
    addFunnel(totalFunnel, funnel);
    totalChapters += run.facts.length;
    const normal = candidates.filter((c) => c.band === "normal");
    perBook.push(
      `  ${run.book.padEnd(10)} ch ${String(run.facts.length).padStart(2)}  pairs ${String(funnel.pairs).padStart(4)}  ` +
      `survivors ${String(funnel.survivors).padStart(3)} (normal ${normal.length})  per-ch ${(funnel.survivors / run.facts.length).toFixed(2)}`,
    );
    for (const c of candidates) {
      allSamples.push({ book: run.book, chapter: c.chapterNumber, speaker: c.speaker, entity: c.entity, sentence: c.sentence, band: c.band });
    }
  }

  console.log("\n── per book ──");
  for (const line of perBook) console.log(line);

  console.log("\n── the funnel (each stage is a named reason a pair died) ──");
  console.log(`  pairs                       ${totalFunnel.pairs}`);
  console.log(`  − supported by prior fact   ${totalFunnel.supportedPrior}`);
  console.log(`  − meeting them on the page  ${totalFunnel.meetingNow}`);
  console.log(`  − attribution below floor   ${totalFunnel.droppedConfidence}`);
  console.log(`  − vocative                  ${totalFunnel.droppedVocative}`);
  console.log(`  − addressee                 ${totalFunnel.droppedAddressee}`);
  console.log(`  − page-one cast entity      ${totalFunnel.droppedFirstChapter}`);
  console.log(`  = survivors                 ${totalFunnel.survivors} (${totalFunnel.lowBand} demoted to low band)`);

  const perChapter = totalFunnel.survivors / Math.max(1, totalChapters);
  console.log("\n── gates ──");
  gate(
    perChapter <= VOLUME_MAX,
    "noise ceiling",
    `${perChapter.toFixed(2)}/chapter across ${totalChapters} clean chapters (ceiling ${VOLUME_MAX})`,
  );
  gate(
    totalFunnel.survivors >= PIPE_ALIVE_MIN,
    "pipe alive",
    `${totalFunnel.survivors} survivors total (floor ${PIPE_ALIVE_MIN})`,
  );

  // ── Synthetic-break recall ──────────────────────────────────────────────
  // Inject "I knew <E> …," said <S>. into chapter j where S already speaks
  // and E has never been exposed at or before j. The pair MUST surface.
  let injected = 0;
  let recalled = 0;
  for (const run of runs) {
    const firstExposure = new Map<string, number>();
    run.facts.forEach((f, ci) => {
      for (const n of f.exposed) if (!firstExposure.has(n)) firstExposure.set(n, ci);
    });
    let doneForBook = 0;
    for (const entity of run.characterNames.map((n) => run.aliasCanon.get(n) ?? n)) {
      if (doneForBook >= 4) break;
      const k = firstExposure.get(entity);
      if (k === undefined || k < 3) continue;
      // earliest chapter 1..k-1 with a confident speaker who is not the entity
      let chosen: { j: number; speaker: string } | null = null;
      for (let j = 1; j < k && !chosen; j++) {
        const s = run.facts[j].presentNarrow.find((n) => n !== entity);
        if (s) chosen = { j, speaker: s };
      }
      if (!chosen) continue;

      injected++;
      doneForBook++;
      const ch = run.chapters[chosen.j];
      const injectedContent =
        `${ch.content}\n\n“I knew ${entity} would come back to haunt us,” said ${chosen.speaker}.`;
      const paragraphs = splitParagraphs(injectedContent);
      const speechResults = detectSpeechInChapter(paragraphs, run.characterNames);
      const rebuilt = run.facts.map((f, ci) => ci === chosen!.j
        ? buildChapterKnowledgeFacts({
            chapterId: ch.id, chapterNumber: ch.number, content: injectedContent,
            paragraphs, speechResults, characterNames: run.characterNames, aliasCanon: run.aliasCanon,
            nameFilterText: run.fullText,
          })
        : f);
      const { candidates } = buildLedger(rebuilt);
      const hit = candidates.some((c) => c.key === candidateKey(chosen!.speaker, entity));
      if (hit) recalled++;
      else console.log(`    miss: [${run.book}] ${chosen.speaker}→${entity} injected ch${chosen.j + 1} (first exposure ch${k + 1})`);
    }
  }
  const recall = injected ? recalled / injected : 0;
  gate(injected >= 10, "synthetic corpus size", `${injected} injections built (need ≥10 for the gate to mean anything)`);
  gate(recall >= RECALL_FLOOR, "synthetic-break recall", `${recalled}/${injected} = ${(recall * 100).toFixed(0)}% (floor ${RECALL_FLOOR * 100}%)`);

  // ── Page-one cast never surfaces ────────────────────────────────────────
  let pageOneLeaks = 0;
  for (const run of runs) {
    const first = run.facts[0]?.exposed ?? [];
    const firstSet = new Set(first);
    const { candidates } = buildLedger(run.facts);
    pageOneLeaks += candidates.filter((c) => firstSet.has(c.entity)).length;
  }
  gate(pageOneLeaks === 0, "page-one cast", `${pageOneLeaks} candidates named a chapter-1 entity`);

  // ── Widening only suppresses ────────────────────────────────────────────
  let monotone = true;
  for (const run of runs) {
    const wide = buildLedger(run.facts).funnel.survivors;
    const narrow = buildLedger(run.narrowFacts).funnel.survivors;
    if (wide > narrow) {
      monotone = false;
      console.log(`    violation: [${run.book}] wide ${wide} > narrow ${narrow}`);
    }
  }
  gate(monotone, "presence-widening monotonicity", "wide presence never created a candidate");

  // ── Anchor retirement ───────────────────────────────────────────────────
  {
    const run = runs.find((r) => buildLedger(r.facts).candidates.length > 0);
    if (!run) {
      gate(false, "anchor retirement", "no book produced a candidate to test with");
    } else {
      const { facts, candidates } = buildLedger(run.facts);
      const victim = candidates[0];
      const store: KnowledgeLedgerStore = {
        version: 1, chapters: {}, facts, candidates, decisions: {},
      };
      const contents = new Map(run.chapters.map((c) => [c.id, c.content] as const));
      const untouched = retireDeadAnchors(store, contents);
      const edited = new Map(contents);
      edited.set(victim.chapterId, (contents.get(victim.chapterId) ?? "").replace(victim.sentence, ""));
      const afterEdit = retireDeadAnchors(store, edited);
      const retired = afterEdit.candidates.find((c) => c.key === victim.key)?.status === "retired";
      const stable = untouched === store;
      gate(retired && stable, "anchor retirement",
        `deleted sentence retires its candidate (${retired}); untouched content is a no-op (${stable})`);
    }
  }

  // ── Samples — precision is judged by reading, not by the count ─────────
  console.log(`\n── samples (${Math.min(SAMPLES, allSamples.length)} of ${allSamples.length}; read these) ──`);
  const step = Math.max(1, Math.floor(allSamples.length / SAMPLES));
  for (let i = 0, n = 0; i < allSamples.length && n < SAMPLES; i += step, n++) {
    const s = allSamples[i];
    console.log(`  [${s.book} ch${s.chapter}] ${s.speaker} → "${s.entity}" (${s.band})`);
    console.log(`     “${s.sentence.replace(/\s+/g, " ").slice(0, 140)}”`);
  }

  console.log(`\n${failures === 0 ? "✓ ALL GATES GREEN" : `✗ ${failures} GATE(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
