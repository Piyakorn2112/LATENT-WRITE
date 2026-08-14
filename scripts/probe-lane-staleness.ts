/**
 * probe-lane-staleness.ts — how much of the timeline lane's inference is work
 * that could not possibly change the answer?
 *
 * The lane is two tasks: the timeline CHIP picker and the chapter SUMMARY in
 * the widget panel. Both cache their answer under a key, and the key decides
 * how much inference the app does.
 *
 * The key USED to be `${content.length}|${first 60 chars}` plus a fingerprint
 * of the events' ranks and sentences. That moves on every keystroke which
 * changes the chapter's length — while the bytes the model is shown often do
 * not move at all. Every one of those is a whole inference re-deriving an
 * answer already on file, because temperature is 0 and an identical request
 * cannot produce a different answer.
 *
 * This drives real books through the real analysis pipeline and counts, for
 * both keys, how many inferences each would order. Two edit populations,
 * because a writing session is made of both:
 *   TYPING   the chapter written forward in small chunks (drafting — every
 *            pause rebuilds the graph)
 *   EDITING  local revisions to a finished chapter (typos, word swaps,
 *            punctuation, a rewritten line, a new sentence)
 *
 *   ./node_modules/.bin/tsx scripts/probe-lane-staleness.ts
 */
import { analyzeChapter } from "../src/lib/chapter-analysis";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { buildChapterEntry } from "../src/lib/story-graph";
import { resolveKnownNames } from "../src/lib/world-data";
import { buildChipRequest, chipKeyFor, eventFingerprint, CHIP_PROMPT_VERSION } from "../src/lib/chip-picker";
import { summaryKeyFor, SUMMARY_PROMPT_VERSION } from "../src/lib/chapter-summary";
import { fnv1a } from "../src/lib/evidence-pack";
import { loadBook, splitParagraphs } from "./print-chapter";
import type { Chapter, Novel, ChapterGraphEntry } from "../src/types";

const MODEL_ID = "qwen3-1.7b-q4_k_m";
const BOOKS = (process.env.LANE_BOOKS ?? "gatsby,sherlock,anne,dracula").split(",");
const CHAPTERS_PER_BOOK = Number(process.env.LANE_CHAPTERS) || 3;

/**
 * The key BEFORE this round, reproduced here so the probe keeps measuring the
 * change instead of becoming a tautology now that the shipped key is the new
 * one. Both tasks shared this recipe.
 */
const legacyKey = (entry: ChapterGraphEntry, version: number) =>
  fnv1a(`${entry.contentHash}|${eventFingerprint(entry.majorEvents)}|${MODEL_ID}|v${version}`);

function entryFor(chapter: Chapter, novel: Novel): ChapterGraphEntry {
  const paragraphs = splitParagraphs(chapter.content);
  const knownNames = resolveKnownNames(novel);
  const speechResults = detectSpeechInChapter(paragraphs, knownNames, { intelligenceLevel: "default" });
  const analysis = analyzeChapter(paragraphs, speechResults, []);
  return buildChapterEntry(
    chapter,
    { paragraphs, speechResults, speechPredictions: [], actionPredictions: [], analysis, endContext: null } as never,
    novel.worldData,
  );
}

interface Keys { oldChip: string; newChip: string; oldSum: string; newSum: string; chipWork: boolean; sumWork: boolean }
function keysFor(entry: ChapterGraphEntry): Keys {
  return {
    oldChip: legacyKey(entry, CHIP_PROMPT_VERSION), newChip: chipKeyFor(entry, MODEL_ID),
    oldSum: legacyKey(entry, SUMMARY_PROMPT_VERSION), newSum: summaryKeyFor(entry, MODEL_ID),
    chipWork: buildChipRequest(entry).candidates.length > 0,
    sumWork: entry.majorEvents.length > 0,
  };
}

interface Tally { rebuilds: number; old: number; now: number }
const empty = (): Tally => ({ rebuilds: 0, old: 0, now: 0 });

async function main() {
  const typing = new Map<string, Tally>();
  const editing = new Map<string, Tally>();
  const bump = (m: Map<string, Tally>, k: string) => m.get(k) ?? (m.set(k, empty()), m.get(k)!);
  const add = (t: Tally, movedOld: boolean, movedNow: boolean) => {
    t.rebuilds++; if (movedOld) t.old++; if (movedNow) t.now++;
  };

  for (const bookKey of BOOKS) {
    let novel: Novel;
    try { novel = await loadBook(bookKey); } catch { console.log(`  (skip ${bookKey})`); continue; }
    const chapters = novel.chapters.filter((c) => c.content.length > 3000).slice(0, CHAPTERS_PER_BOOK);

    for (const chapter of chapters) {
      // ── TYPING: the chapter written forward from 70% in 16 pauses ────────
      const full = chapter.content;
      const start = Math.floor(full.length * 0.7);
      const steps = 16;
      let prev: Keys | null = null;
      for (let i = 0; i <= steps; i++) {
        const cut = start + Math.floor(((full.length - start) * i) / steps);
        const k = keysFor(entryFor({ ...chapter, content: full.slice(0, cut) }, novel));
        if (prev) {
          if (k.chipWork) add(bump(typing, "chips"), k.oldChip !== prev.oldChip, k.newChip !== prev.newChip);
          if (k.sumWork) add(bump(typing, "summary"), k.oldSum !== prev.oldSum, k.newSum !== prev.newSum);
        }
        prev = k;
      }

      // ── EDITING: local revisions to the finished chapter ────────────────
      const base = keysFor(entryFor(chapter, novel));
      for (const edit of localEdits(chapter.content)) {
        const k = keysFor(entryFor({ ...chapter, content: edit.next }, novel));
        if (base.chipWork) {
          add(bump(editing, "chips"), k.oldChip !== base.oldChip, k.newChip !== base.newChip);
          add(bump(editing, `chips:${edit.kind}`), k.oldChip !== base.oldChip, k.newChip !== base.newChip);
        }
        if (base.sumWork) add(bump(editing, "summary"), k.oldSum !== base.oldSum, k.newSum !== base.newSum);
      }
    }
  }

  const report = (title: string, m: Map<string, Tally>) => {
    console.log(`\n── ${title}`);
    for (const [name, t] of [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (t.rebuilds === 0) continue;
      const cut = t.old ? (100 - (t.now / t.old) * 100) : 0;
      console.log(
        `   ${name.padEnd(24)} ${String(t.rebuilds).padStart(4)} rebuilds → ` +
        `${String(t.old).padStart(4)} inferences on the old key, ${String(t.now).padStart(4)} on the new ` +
        `(${cut >= 0 ? "-" : "+"}${Math.abs(cut).toFixed(0)}%)`,
      );
    }
  };
  report("TYPING FORWARD (a pause every few words)", typing);
  report("LOCAL EDITS to a finished chapter", editing);

  console.log("\n── COMBINED");
  let oldAll = 0, nowAll = 0;
  for (const k of ["chips", "summary"]) {
    const t = typing.get(k) ?? empty(), e = editing.get(k) ?? empty();
    const o = t.old + e.old, n = t.now + e.now;
    oldAll += o; nowAll += n;
    console.log(`   ${k.padEnd(8)} ${o} → ${n} inferences (${o ? (100 - (n / o) * 100).toFixed(0) : 0}% fewer)`);
  }
  console.log(`   ${"lane".padEnd(8)} ${oldAll} → ${nowAll} inferences ` +
    `(${oldAll ? (100 - (nowAll / oldAll) * 100).toFixed(0) : 0}% fewer)\n`);
}

/** Local revisions a writer actually makes to finished prose. */
function localEdits(content: string): Array<{ kind: string; next: string }> {
  const out: Array<{ kind: string; next: string }> = [];
  const paras = content.split(/\n\n+/);
  const mid = Math.floor(paras.length / 2);
  const pick = (i: number) => Math.min(paras.length - 1, Math.max(0, i));

  const swap = (i: number, from: RegExp, to: string, kind: string) => {
    const p = paras[pick(i)];
    if (!from.test(p)) return;
    const next = [...paras];
    next[pick(i)] = p.replace(from, to);
    out.push({ kind, next: next.join("\n\n") });
  };

  swap(mid, /\bthe\b/, "teh", "typo");
  swap(mid + 1, /\b(said|asked|replied)\b/, "$1 quietly", "word-added");
  swap(mid - 1, /\bvery\s+/, "", "word-removed");
  swap(mid, /,\s/, "; ", "punctuation");
  {
    const next = [...paras];
    next[pick(mid)] = `${next[pick(mid)]} The room was colder than it had been.`;
    out.push({ kind: "sentence-added", next: next.join("\n\n") });
  }
  {
    const next = [...paras];
    next.splice(pick(mid), 0, "She waited, and the light did not change.");
    out.push({ kind: "paragraph-added", next: next.join("\n\n") });
  }
  out.push({ kind: "whitespace", next: `${content} ` });
  return out;
}

await main();
