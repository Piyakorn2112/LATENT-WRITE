/**
 * story-arc-insights.ts — what the story graph knows that no single chapter does.
 *
 * The per-chapter brief (chapter-observation.ts) answers "what happens in THIS
 * chapter". This module answers the questions that only exist across chapters:
 * who vanished, where the pressure never lets up, which stretch contains no
 * turn at all, whether the book has a climax and where it sits. Every one of
 * these is already implied by data the engine persists per chapter
 * (ChapterGraphEntry); nothing here runs NLP. It is pure aggregation, cheap
 * enough for a useMemo on every graph update.
 *
 * House rules, inherited from the engines this sits on:
 *
 *  · A rule fires only on airtight premises, and silence is the default.
 *    A wrong cross-chapter claim ("X disappears for six chapters" when X is
 *    there in chapter nine) is worse than no claim: the writer can check it.
 *  · STALE ENTRIES DO NOT TESTIFY. An entry whose contentHash no longer
 *    matches the chapter's text describes prose that no longer exists, so
 *    every graph-derived rule skips stale chapters, and staleness itself is
 *    surfaced as its own insight so the quiet is explained.
 *  · Plain sentences, chapter numbers the writer uses (ch.number, not index),
 *    no em or en dashes in shipped copy.
 */

import type { Chapter, ChapterGraphEntry, StoryGraph } from "../types";
import type { TimelineCharacterTrack } from "./story-graph-display";

// ─── Public shape ─────────────────────────────────────────────────────────────

export type ArcInsightKind =
  | "cast-gap"
  | "eventless-run"
  | "tension-plateau"
  | "sagging-middle"
  | "no-climax"
  | "early-climax"
  | "length-outlier"
  | "stale";

export interface ArcInsight {
  kind: ArcInsightKind;
  /** `attention` = probably worth acting on; `note` = worth knowing. */
  severity: "attention" | "note";
  /** One plain sentence. Chapter references use the chapter's own number. */
  text: string;
  /** Short label for a chip in the timeline strip, ≤ ~24 chars. */
  chip: string;
  /** The chapters the claim is about, in book order. First = focus target. */
  chapterIds: string[];
}

type ChapterLike = Pick<Chapter, "id" | "number" | "title" | "content">;

interface Row {
  id: string;
  number: number;
  hasContent: boolean;
  entry: ChapterGraphEntry | undefined;
  /** entry exists and still describes the current text. */
  fresh: boolean;
  stale: boolean;
}

// Same recipe as buildChapterEntry / App's dedup key. If that format changes,
// staleness here reports everything stale — loud, not silent, so it gets seen.
function contentHashOf(content: string): string {
  return `${content.length}|${content.slice(0, 60)}`;
}

function buildRows(storyGraph: StoryGraph, chapters: ChapterLike[]): Row[] {
  return chapters.map((ch) => {
    const entry = storyGraph.entries[ch.id];
    const hasContent = ch.content.trim().length > 0;
    const stale = !!entry && entry.contentHash !== contentHashOf(ch.content);
    return { id: ch.id, number: ch.number, hasContent, entry, fresh: !!entry && !stale, stale };
  });
}

/** "chapters 5-8" / "chapter 5". Hyphen, not a dash: house copy rule. */
function chapterRange(rows: Row[]): string {
  if (rows.length === 1) return `chapter ${rows[0].number}`;
  return `chapters ${rows[0].number}-${rows[rows.length - 1].number}`;
}

/** Consecutive runs of rows matching `test`, broken by rows that fail `eligible`.
 *  A chapter we know nothing about (unanalyzed, stale, empty) BREAKS a run
 *  rather than counting toward it — a claim spanning an unknown is a guess. */
function runsOf(rows: Row[], eligible: (r: Row) => boolean, test: (r: Row) => boolean): Row[][] {
  const runs: Row[][] = [];
  let current: Row[] = [];
  for (const row of rows) {
    if (eligible(row) && test(row)) {
      current.push(row);
    } else {
      if (current.length) runs.push(current);
      current = [];
    }
  }
  if (current.length) runs.push(current);
  return runs;
}

const isMajor = (e: { salience?: string }) => (e.salience ?? "major") === "major";

// ─── Rules ────────────────────────────────────────────────────────────────────

/** A named character with an unbroken absence between two appearances.
 *  Tracks come from content matching (story-graph-display), so presence is
 *  known even for unanalyzed chapters — this rule may span them. */
function castGaps(rows: Row[], tracks: TimelineCharacterTrack[]): ArcInsight[] {
  const withContent = rows.filter((r) => r.hasContent);
  if (withContent.length < 6) return [];
  const minGap = Math.max(3, Math.ceil(withContent.length * 0.15));

  const found: Array<{ insight: ArcInsight; gapLen: number }> = [];
  for (const track of tracks) {
    const presentIdx = withContent
      .map((r, i) => (track.chapterIds.has(r.id) ? i : -1))
      .filter((i) => i >= 0);
    if (presentIdx.length < 2) continue;

    let best: { start: number; end: number } | null = null;
    for (let k = 1; k < presentIdx.length; k++) {
      const gapLen = presentIdx[k] - presentIdx[k - 1] - 1;
      if (gapLen >= minGap && (!best || gapLen > best.end - best.start + 1)) {
        best = { start: presentIdx[k - 1] + 1, end: presentIdx[k] - 1 };
      }
    }
    if (!best) continue;

    const gapRows = withContent.slice(best.start, best.end + 1);
    found.push({
      gapLen: gapRows.length,
      insight: {
        kind: "cast-gap",
        severity: "attention",
        text: `${track.name} disappears for ${gapRows.length} chapters (${chapterRange(gapRows)}) between appearances.`,
        chip: `${track.name} absent ${gapRows.length} ch`,
        chapterIds: gapRows.map((r) => r.id),
      },
    });
  }
  // The two longest gaps at most — a strip full of absences reads as noise.
  return found.sort((a, b) => b.gapLen - a.gapLen).slice(0, 2).map((f) => f.insight);
}

/** Consecutive fresh chapters with real prose and not one major turn. */
function eventlessRuns(rows: Row[]): ArcInsight[] {
  const runs = runsOf(
    rows,
    (r) => r.fresh && (r.entry?.wordCount ?? 0) >= 400,
    (r) => !(r.entry?.majorEvents ?? []).some(isMajor),
  ).filter((run) => run.length >= 2);
  return runs.slice(0, 1).map((run) => ({
    kind: "eventless-run" as const,
    severity: "attention" as const,
    text: `No turn detected across ${chapterRange(run)}: nothing there reads as a decision, revelation or change of state.`,
    chip: `no turns ${run[0].number}-${run[run.length - 1].number}`,
    chapterIds: run.map((r) => r.id),
  }));
}

/** Three or more fresh chapters in a row near peak tension. */
function tensionPlateaus(rows: Row[]): ArcInsight[] {
  const runs = runsOf(
    rows,
    (r) => r.fresh,
    (r) => (r.entry?.tensionPeak ?? 0) >= 0.65,
  ).filter((run) => run.length >= 3);
  return runs.slice(0, 1).map((run) => ({
    kind: "tension-plateau" as const,
    severity: "note" as const,
    text: `${capitalize(chapterRange(run))} all run near peak tension. There is no breather in that stretch.`,
    chip: `no breather ${run[0].number}-${run[run.length - 1].number}`,
    chapterIds: run.map((r) => r.id),
  }));
}

/** The middle third sits well under the book's own tension line. */
function saggingMiddle(rows: Row[]): ArcInsight[] {
  const fresh = rows.filter((r) => r.fresh);
  if (fresh.length < 6) return [];
  const mean = fresh.reduce((s, r) => s + (r.entry?.tensionPeak ?? 0), 0) / fresh.length;
  if (mean < 0.45) return []; // a quiet book has no line to sag under
  const third = Math.floor(fresh.length / 3);
  const middle = fresh.slice(third, fresh.length - third);
  const low = runsOf(
    middle,
    () => true,
    (r) => (r.entry?.tensionPeak ?? 0) < Math.min(0.35, mean - 0.15),
  ).filter((run) => run.length >= 3);
  return low.slice(0, 1).map((run) => ({
    kind: "sagging-middle" as const,
    severity: "note" as const,
    text: `The middle sags: ${chapterRange(run)} sit well below the book's tension line.`,
    chip: `middle sags`,
    chapterIds: run.map((r) => r.id),
  }));
}

/** Climax placement — or its absence once enough of the book is analyzed. */
function climaxPlacement(rows: Row[]): ArcInsight[] {
  const withContent = rows.filter((r) => r.hasContent);
  const fresh = withContent.filter((r) => r.fresh);
  if (withContent.length < 8 || fresh.length / withContent.length < 0.7) return [];

  const climaxes = fresh.filter((r) => r.entry?.role === "climax");
  if (climaxes.length === 0) {
    return [{
      kind: "no-climax",
      severity: "note",
      text: `No chapter reads as a climax yet across ${fresh.length} analyzed chapters.`,
      chip: "no climax yet",
      chapterIds: [],
    }];
  }

  const biggest = climaxes.reduce((a, b) =>
    (b.entry?.tensionPeak ?? 0) > (a.entry?.tensionPeak ?? 0) ? b : a);
  const position = withContent.findIndex((r) => r.id === biggest.id) / (withContent.length - 1);
  if (position >= 0.4) return [];
  const pct = Math.round(position * 100);
  return [{
    kind: "early-climax",
    severity: "note",
    text: `The biggest climax lands at chapter ${biggest.number}, ${pct}% into the book.`,
    chip: `climax at ${pct}%`,
    chapterIds: [biggest.id],
  }];
}

/** One chapter far outside the book's own length register. */
function lengthOutliers(rows: Row[]): ArcInsight[] {
  const fresh = rows.filter((r) => r.fresh && (r.entry?.wordCount ?? 0) > 0);
  if (fresh.length < 5) return [];
  const sorted = fresh.map((r) => r.entry!.wordCount).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median < 300) return [];
  const outlier = fresh.reduce((a, b) => (b.entry!.wordCount > a.entry!.wordCount ? b : a));
  const ratio = outlier.entry!.wordCount / median;
  if (ratio < 2.5) return [];
  return [{
    kind: "length-outlier",
    severity: "note",
    text: `Chapter ${outlier.number} runs ${ratio.toFixed(1)}x your median chapter length.`,
    chip: `ch ${outlier.number} runs long`,
    chapterIds: [outlier.id],
  }];
}

/** Chapters whose analysis no longer matches their text. Explains the quiet. */
function staleness(rows: Row[]): ArcInsight[] {
  const stale = rows.filter((r) => r.stale);
  if (stale.length === 0) return [];
  return [{
    kind: "stale",
    severity: "note",
    text: stale.length === 1
      ? `Chapter ${stale[0].number} has changed since its last analysis. Revisit it to refresh the timeline.`
      : `${stale.length} chapters have changed since their last analysis. Revisit them to refresh the timeline.`,
    chip: `${stale.length} stale`,
    chapterIds: stale.map((r) => r.id),
  }];
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const INSIGHT_CAP = 5;

export function buildArcInsights(
  storyGraph: StoryGraph,
  chapters: ChapterLike[],
  tracks: TimelineCharacterTrack[],
): ArcInsight[] {
  if (chapters.length === 0) return [];
  const rows = buildRows(storyGraph, chapters);
  if (!rows.some((r) => r.fresh)) return [];

  const all = [
    ...castGaps(rows, tracks),
    ...eventlessRuns(rows),
    ...tensionPlateaus(rows),
    ...saggingMiddle(rows),
    ...climaxPlacement(rows),
    ...lengthOutliers(rows),
    ...staleness(rows),
  ];

  const firstNumber = (ins: ArcInsight): number => {
    const id = ins.chapterIds[0];
    if (!id) return Number.MAX_SAFE_INTEGER;
    return rows.find((r) => r.id === id)?.number ?? Number.MAX_SAFE_INTEGER;
  };
  return all
    .sort((a, b) =>
      (a.severity === b.severity ? 0 : a.severity === "attention" ? -1 : 1) ||
      firstNumber(a) - firstNumber(b))
    .slice(0, INSIGHT_CAP);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
