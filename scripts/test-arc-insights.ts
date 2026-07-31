/**
 * test-arc-insights.ts — contract lock for the cross-chapter insight layer.
 *
 * Run:  npx tsx scripts/test-arc-insights.ts     (exit 1 on failure)
 *
 * The module is pure aggregation over persisted ChapterGraphEntry data, so
 * synthetic graphs test it fully: for every rule there is a FIRING case and a
 * NEAR-MISS that must stay silent, because the module's stated contract is
 * "silence is the default and a rule fires only on airtight premises". The
 * near-misses are the test — any aggregator can fire on the obvious case.
 *
 * Also locked here:
 *   · stale entries do not testify (a stale chapter breaks an eventless run)
 *   · every chapterId an insight cites exists in the book, in book order
 *   · the cap and the attention-before-note ordering
 *   · no em or en dashes in shipped copy (house rule)
 */

import { buildArcInsights, type ArcInsight } from "../src/lib/story-arc-insights";
import type { Chapter, ChapterGraphEntry, MajorEvent, StoryGraph } from "../src/types";
import type { TimelineCharacterTrack } from "../src/lib/story-graph-display";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, msg: string, detail?: string) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}${detail ? ` — ${detail}` : ""}`); }
};

// ─── Fixture builders ─────────────────────────────────────────────────────────

const hashOf = (content: string) => `${content.length}|${content.slice(0, 60)}`;

interface ChapterSpec {
  tension?: number;
  role?: string;
  words?: number;
  /** number of MAJOR events in the chapter (minor events never count) */
  majors?: number;
  minors?: number;
  /** entry.contentHash diverges from the text — a stale analysis */
  stale?: boolean;
  /** no entry at all */
  unanalyzed?: boolean;
}

function makeBook(specs: ChapterSpec[]): { chapters: Chapter[]; graph: StoryGraph } {
  const chapters: Chapter[] = specs.map((_, i) => ({
    id: `ch${i + 1}`,
    number: i + 1,
    title: `Chapter ${i + 1}`,
    content: `Prose for chapter ${i + 1}. `.repeat(30),
  }));
  const graph: StoryGraph = { version: 1, entries: {} };
  specs.forEach((spec, i) => {
    if (spec.unanalyzed) return;
    const ch = chapters[i];
    const mkEvent = (salience: "major" | "minor", k: number): MajorEvent => ({
      label: `${salience} event ${k}`,
      type: "revelation",
      tensionPosition: 0.5,
      confidence: 0.8,
      salience,
      paragraphIndex: k,
      sentence: `Something ${salience} happens in chapter ${i + 1}.`,
    });
    const entry: ChapterGraphEntry = {
      chapterId: ch.id,
      chapterNumber: ch.number,
      chapterTitle: ch.title,
      role: spec.role ?? "standard",
      tensionPeak: spec.tension ?? 0.5,
      tensionCurve: [0.2, 0.3, 0.4, spec.tension ?? 0.5, 0.4, 0.3, 0.2, 0.1],
      charactersPresent: [],
      wordCount: spec.words ?? 1200,
      proseRegister: "mixed",
      majorEvents: [
        ...Array.from({ length: spec.majors ?? 1 }, (_, k) => mkEvent("major", k)),
        ...Array.from({ length: spec.minors ?? 0 }, (_, k) => mkEvent("minor", k + 10)),
      ],
      lastUpdated: 1,
      contentHash: spec.stale ? "0|divergent" : hashOf(ch.content),
    };
    graph.entries[ch.id] = entry;
  });
  return { chapters, graph };
}

function makeTrack(name: string, presentChapters: number[], total: number): TimelineCharacterTrack {
  const ids = new Set(presentChapters.map((n) => `ch${n}`));
  void total;
  return { name, count: ids.size, color: "#8888ff", chapterIds: ids };
}

const kinds = (out: ArcInsight[]) => out.map((i) => i.kind);
const find = (out: ArcInsight[], kind: string) => out.find((i) => i.kind === kind);

// ─── cast-gap ─────────────────────────────────────────────────────────────────

console.log("\ncast-gap:");
{
  // 10 chapters, Mira present 1-2 and 9-10: a 6-chapter hole.
  const { chapters, graph } = makeBook(Array.from({ length: 10 }, () => ({})));
  const track = makeTrack("Mira", [1, 2, 9, 10], 10);
  const out = buildArcInsights(graph, chapters, [track]);
  const gap = find(out, "cast-gap");
  ok(!!gap, "6-chapter absence fires");
  ok(gap?.text.includes("Mira") === true && gap?.text.includes("6 chapters") === true,
    "names the character and the gap length", gap?.text);
  ok(gap?.chapterIds.length === 6 && gap?.chapterIds[0] === "ch3" && gap?.chapterIds[5] === "ch8",
    "cites exactly the absent chapters, in order");
}
{
  // Near-miss: a 2-chapter absence in a 10-chapter book stays quiet (min gap 3).
  const { chapters, graph } = makeBook(Array.from({ length: 10 }, () => ({})));
  const track = makeTrack("Mira", [1, 2, 3, 4, 7, 8, 9, 10], 10);
  const out = buildArcInsights(graph, chapters, [track]);
  ok(!find(out, "cast-gap"), "2-chapter absence stays silent");
}
{
  // Near-miss: a character seen ONCE has no between-appearances gap to report.
  const { chapters, graph } = makeBook(Array.from({ length: 10 }, () => ({})));
  const out = buildArcInsights(graph, chapters, [makeTrack("Mira", [4], 10)]);
  ok(!find(out, "cast-gap"), "single appearance stays silent");
}

// ─── eventless-run ────────────────────────────────────────────────────────────

console.log("\neventless-run:");
{
  const { chapters, graph } = makeBook([
    {}, { majors: 0, minors: 2 }, { majors: 0 }, {},
  ]);
  const out = buildArcInsights(graph, chapters, []);
  const run = find(out, "eventless-run");
  ok(!!run, "two turn-less chapters in a row fire");
  ok(run?.chapterIds.join(",") === "ch2,ch3", "cites the run, not its neighbours", run?.chapterIds.join(","));
  ok(run?.severity === "attention", "eventless run is attention-grade");
}
{
  // Near-miss: a single turn-less chapter is the per-chapter brief's job.
  const { chapters, graph } = makeBook([{}, { majors: 0 }, {}, {}]);
  ok(!find(buildArcInsights(graph, chapters, []), "eventless-run"), "single quiet chapter stays silent");
}
{
  // Near-miss: minor-only chapters count as turn-less, but a STALE chapter
  // between them breaks the run — stale entries do not testify.
  const { chapters, graph } = makeBook([
    { majors: 0 }, { majors: 0, stale: true }, { majors: 0 }, {},
  ]);
  ok(!find(buildArcInsights(graph, chapters, []), "eventless-run"), "stale chapter breaks the run");
}
{
  // Near-miss: sub-400-word chapters (sketches, placeholders) do not testify.
  const { chapters, graph } = makeBook([{ majors: 0, words: 200 }, { majors: 0, words: 200 }, {}]);
  ok(!find(buildArcInsights(graph, chapters, []), "eventless-run"), "sketch-length chapters stay silent");
}

// ─── tension-plateau ──────────────────────────────────────────────────────────

console.log("\ntension-plateau:");
{
  const { chapters, graph } = makeBook([
    { tension: 0.3 }, { tension: 0.8 }, { tension: 0.7 }, { tension: 0.9 }, { tension: 0.3 },
  ]);
  const plat = find(buildArcInsights(graph, chapters, []), "tension-plateau");
  ok(!!plat, "three high-tension chapters in a row fire");
  ok(plat?.chapterIds.join(",") === "ch2,ch3,ch4", "cites the plateau chapters", plat?.chapterIds.join(","));
}
{
  const { chapters, graph } = makeBook([
    { tension: 0.8 }, { tension: 0.9 }, { tension: 0.3 }, { tension: 0.8 }, { tension: 0.9 },
  ]);
  ok(!find(buildArcInsights(graph, chapters, []), "tension-plateau"), "two-chapter spikes stay silent");
}

// ─── sagging-middle ───────────────────────────────────────────────────────────

console.log("\nsagging-middle:");
{
  const { chapters, graph } = makeBook([
    { tension: 0.8 }, { tension: 0.7 }, { tension: 0.2 }, { tension: 0.2 }, { tension: 0.25 },
    { tension: 0.15 }, { tension: 0.7 }, { tension: 0.9 }, { tension: 0.8 },
  ]);
  const sag = find(buildArcInsights(graph, chapters, []), "sagging-middle");
  ok(!!sag, "low middle third under a tense book fires");
  ok(sag ? sag.chapterIds.every((id) => ["ch4", "ch5", "ch6"].includes(id)) : false,
    "cites only middle-third chapters", sag?.chapterIds.join(","));
}
{
  // Near-miss: a book that is quiet EVERYWHERE has no line to sag under.
  const { chapters, graph } = makeBook(
    Array.from({ length: 9 }, () => ({ tension: 0.2 })),
  );
  ok(!find(buildArcInsights(graph, chapters, []), "sagging-middle"), "uniformly quiet book stays silent");
}

// ─── climax placement ─────────────────────────────────────────────────────────

console.log("\nclimax placement:");
{
  const { chapters, graph } = makeBook(
    Array.from({ length: 10 }, () => ({ role: "standard" })),
  );
  const none = find(buildArcInsights(graph, chapters, []), "no-climax");
  ok(!!none, "10 analyzed chapters with no climax role fire");
}
{
  const specs: ChapterSpec[] = Array.from({ length: 10 }, () => ({ role: "standard" as const }));
  specs[1] = { role: "climax", tension: 0.9 };
  const { chapters, graph } = makeBook(specs);
  const out = buildArcInsights(graph, chapters, []);
  const early = find(out, "early-climax");
  ok(!!early, "climax at 11% of the book fires early-climax");
  ok(!find(out, "no-climax"), "no-climax and early-climax are mutually exclusive");
}
{
  const specs: ChapterSpec[] = Array.from({ length: 10 }, () => ({ role: "standard" as const }));
  specs[7] = { role: "climax", tension: 0.9 };
  const { chapters, graph } = makeBook(specs);
  const out = buildArcInsights(graph, chapters, []);
  ok(!find(out, "early-climax") && !find(out, "no-climax"), "climax at 78% stays silent");
}
{
  // Near-miss: only half the book analyzed — too little to claim "no climax".
  const specs: ChapterSpec[] = Array.from({ length: 10 }, (_, i) =>
    i < 5 ? { role: "standard" as const } : { unanalyzed: true });
  const { chapters, graph } = makeBook(specs);
  ok(!find(buildArcInsights(graph, chapters, []), "no-climax"), "half-analyzed book stays silent");
}

// ─── length-outlier ───────────────────────────────────────────────────────────

console.log("\nlength-outlier:");
{
  const { chapters, graph } = makeBook([
    { words: 1000 }, { words: 1100 }, { words: 900 }, { words: 1000 }, { words: 3400 },
  ]);
  const out = find(buildArcInsights(graph, chapters, []), "length-outlier");
  ok(!!out, "3.4x median chapter fires");
  ok(out?.chapterIds.join(",") === "ch5", "cites the outlier chapter");
}
{
  const { chapters, graph } = makeBook([
    { words: 1000 }, { words: 1100 }, { words: 900 }, { words: 1000 }, { words: 2000 },
  ]);
  ok(!find(buildArcInsights(graph, chapters, []), "length-outlier"), "2x median stays silent");
}

// ─── stale ────────────────────────────────────────────────────────────────────

console.log("\nstale:");
{
  const { chapters, graph } = makeBook([{}, { stale: true }, { stale: true }, {}]);
  const st = find(buildArcInsights(graph, chapters, []), "stale");
  ok(!!st, "changed-since-analysis chapters fire");
  ok(st?.text.includes("2 chapters") === true, "counts them", st?.text);
  ok(st?.chapterIds.join(",") === "ch2,ch3", "cites the stale chapters");
}
{
  const { chapters, graph } = makeBook([{}, {}, {}]);
  ok(!find(buildArcInsights(graph, chapters, []), "stale"), "fresh book stays silent");
}

// ─── Global contract ──────────────────────────────────────────────────────────

console.log("\nglobal contract:");
{
  // A book with everything wrong at once: cap, ordering, id validity.
  const specs: ChapterSpec[] = Array.from({ length: 12 }, (_, i) => ({
    tension: i >= 3 && i <= 6 ? 0.8 : 0.2,
    majors: i === 8 || i === 9 ? 0 : 1,
    words: i === 11 ? 4000 : 1000,
    stale: i === 0,
    role: "standard",
  }));
  const { chapters, graph } = makeBook(specs);
  const track = makeTrack("Kaelen", [1, 2, 11, 12], 12);
  const out = buildArcInsights(graph, chapters, [track]);

  ok(out.length <= 5, "caps at 5", `got ${out.length}: ${kinds(out).join(", ")}`);
  const sevs = out.map((i) => i.severity);
  const firstNote = sevs.indexOf("note");
  ok(firstNote === -1 || sevs.slice(firstNote).every((s) => s === "note"),
    "attention insights come first");
  const validIds = new Set(chapters.map((c) => c.id));
  ok(out.every((i) => i.chapterIds.every((id) => validIds.has(id))),
    "every cited chapterId exists in the book");
  const dashFree = out.every((i) => !/[—–]/.test(i.text) && !/[—–]/.test(i.chip));
  ok(dashFree, "no em or en dashes in shipped copy");
}
{
  const out = buildArcInsights({ version: 1, entries: {} }, [], []);
  ok(out.length === 0, "empty book yields nothing");
}
{
  // Nothing analyzed at all → silence (nothing to aggregate).
  const { chapters } = makeBook(Array.from({ length: 6 }, () => ({})));
  const out = buildArcInsights({ version: 1, entries: {} }, chapters, [makeTrack("Mira", [1, 6], 6)]);
  ok(out.length === 0, "unanalyzed book yields nothing, even with tracks");
}

console.log(`\narc-insights: ${pass}/${pass + fail}`);
if (fail) process.exitCode = 1;
