/// <reference types="node" />

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import type { Chapter, Novel } from "../src/types";
import type { IntelligenceLevel } from "../src/lib/speech-detect";
import { parseNovel } from "../src/lib/parser";
import { resolveKnownNames, resolveLiveKnownNames } from "../src/lib/world-data";
import { computeChapterStats } from "../src/lib/chapter-analysis";
import { runChapterAnalysis } from "../src/lib/chapter-analysis-runner";

type BenchSource = {
  name: string;
  novelPath: string;
  chapterNumber: number;
};

type TimingSummary = {
  avgMs: number;
  minMs: number;
  p95Ms: number;
  maxMs: number;
};

type LightBenchRow = {
  source: string;
  chapterNumber: number;
  chapterChars: number;
  paragraphChars: number;
  chapterScan: TimingSummary;
  paragraphScan: TimingSummary;
  speedup: number;
};

type HeavyBenchRow = {
  source: string;
  chapterNumber: number;
  fast: TimingSummary;
  default: TimingSummary;
  high: TimingSummary;
  fastVsDefault: number;
  fastVsHigh: number;
};

type CrossContextRow = {
  source: string;
  chapterNumber: number;
  prevChapterNumber: number;
  nextChapterNumber: number;
  currentReceivedPrevContext: boolean;
  nextReceivedCurrentContext: boolean;
  prevParagraphs: number;
  currentParagraphs: number;
  nextParagraphs: number;
};

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = path.resolve(repoRoot, "..");

const SOURCES: BenchSource[] = [
  {
    name: "Hollow Iris",
    novelPath: path.join(workspaceRoot, "novel-reader", "public", "novels", "hollow-iris.txt"),
    chapterNumber: 22,
  },
  {
    name: "Root Crown",
    novelPath: path.join(workspaceRoot, "novel-reader", "public", "novels", "root-crown.txt"),
    chapterNumber: 16,
  },
  {
    name: "Last Wanderer",
    novelPath: path.join(workspaceRoot, "novel-reader", "public", "novels", "sample-novel.txt"),
    chapterNumber: 2,
  },
];

async function main() {
  const lightRows: LightBenchRow[] = [];
  const heavyRows: HeavyBenchRow[] = [];
  const crossRows: CrossContextRow[] = [];

  for (const source of SOURCES) {
    const novel = await loadNovel(source.novelPath);
    const knownNames = resolveKnownNames(novel);
    const chapterIndex = novel.chapters.findIndex((chapter) => chapter.number === source.chapterNumber);
    if (chapterIndex <= 0 || chapterIndex >= novel.chapters.length - 1) continue;

    const chapter = novel.chapters[chapterIndex];
    const prevChapter = novel.chapters[chapterIndex - 1];
    const nextChapter = novel.chapters[chapterIndex + 1];
    const activeParagraph = pickActiveParagraph(chapter, knownNames);

    const chapterScan = benchSync(70, () => {
      resolveLiveKnownNames(chapter.content, knownNames);
    });
    const paragraphScan = benchSync(240, () => {
      resolveLiveKnownNames(activeParagraph.text, knownNames);
    });
    lightRows.push({
      source: source.name,
      chapterNumber: chapter.number,
      chapterChars: chapter.content.length,
      paragraphChars: activeParagraph.text.length,
      chapterScan,
      paragraphScan,
      speedup: chapterScan.avgMs / Math.max(paragraphScan.avgMs, 0.0001),
    });

    const heavyTimings = benchmarkHeavyModes(novel, chapterIndex, knownNames);
    heavyRows.push({
      source: source.name,
      chapterNumber: chapter.number,
      ...heavyTimings,
      fastVsDefault: heavyTimings.default.avgMs / Math.max(heavyTimings.fast.avgMs, 0.0001),
      fastVsHigh: heavyTimings.high.avgMs / Math.max(heavyTimings.fast.avgMs, 0.0001),
    });

    const prevHigh = runChapterAnalysis({
      chapter: prevChapter,
      prevContext: null,
      siblingStats: [],
      knownNames,
      level: "high",
    });
    const currentHigh = runChapterAnalysis({
      chapter,
      prevContext: prevHigh.endContext,
      siblingStats: [computeChapterStats(prevHigh.paragraphs, prevHigh.speechResults)],
      knownNames,
      level: "high",
    });
    const nextHigh = runChapterAnalysis({
      chapter: nextChapter,
      prevContext: currentHigh.endContext,
      siblingStats: [computeChapterStats(currentHigh.paragraphs, currentHigh.speechResults)],
      knownNames,
      level: "high",
    });

    crossRows.push({
      source: source.name,
      chapterNumber: chapter.number,
      prevChapterNumber: prevChapter.number,
      nextChapterNumber: nextChapter.number,
      currentReceivedPrevContext: !!prevHigh.endContext,
      nextReceivedCurrentContext: !!currentHigh.endContext,
      prevParagraphs: prevHigh.paragraphs.length,
      currentParagraphs: currentHigh.paragraphs.length,
      nextParagraphs: nextHigh.paragraphs.length,
    });
  }

  printLightReport(lightRows);
  const heavyPassed = printHeavyReport(heavyRows);
  printCrossContextReport(crossRows);
  if (!heavyPassed) process.exit(1);
}

async function loadNovel(filePath: string): Promise<Novel> {
  const raw = await readFile(filePath, "utf8");
  return parseNovel(raw);
}

function resolveParagraphSlice(content: string, caret: number) {
  if (!content) return { start: 0, end: 0, text: "" };

  const clampedCaret = Math.max(0, Math.min(caret, content.length));
  let start = clampedCaret;
  while (start > 0 && content[start - 1] !== "\n") start--;

  let end = clampedCaret;
  while (end < content.length && content[end] !== "\n") end++;

  return {
    start,
    end,
    text: content.slice(start, end),
  };
}

function pickActiveParagraph(chapter: Chapter, knownNames: string[]) {
  const slices: Array<{ start: number; end: number; text: string }> = [];
  let start = 0;
  for (let index = 0; index <= chapter.content.length; index += 1) {
    if (index < chapter.content.length && chapter.content[index] !== "\n") continue;
    const slice = resolveParagraphSlice(chapter.content, start);
    if (slice.text.trim()) slices.push(slice);
    start = index + 1;
  }

  const containsKnownName = (text: string) => {
    const lower = text.toLowerCase();
    return knownNames.some((name) => lower.includes(name.toLowerCase()));
  };

  const withNames = slices
    .filter((slice) => containsKnownName(slice.text))
    .sort((left, right) => right.text.length - left.text.length);
  if (withNames[0]) return withNames[0];

  const midpoint = slices[Math.floor(slices.length / 2)];
  return midpoint ?? { start: 0, end: 0, text: "" };
}

function benchmarkHeavyModes(novel: Novel, chapterIndex: number, knownNames: string[]) {
  const chapter = novel.chapters[chapterIndex];
  const prevChapter = novel.chapters[chapterIndex - 1];
  const levels: IntelligenceLevel[] = ["fast", "default", "high"];
  const summaries = new Map<IntelligenceLevel, TimingSummary>();

  for (const level of levels) {
    const prevSeed = runChapterAnalysis({
      chapter: prevChapter,
      prevContext: null,
      siblingStats: [],
      knownNames,
      level,
    });
    const prevStats = computeChapterStats(prevSeed.paragraphs, prevSeed.speechResults);

    summaries.set(level, benchSync(10, () => {
      runChapterAnalysis({
        chapter,
        prevContext: prevSeed.endContext,
        siblingStats: [prevStats],
        knownNames,
        level,
      });
    }));
  }

  return {
    fast: summaries.get("fast")!,
    default: summaries.get("default")!,
    high: summaries.get("high")!,
  };
}

function benchSync(iterations: number, fn: () => void): TimingSummary {
  for (let index = 0; index < 4; index += 1) fn();

  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    fn();
    samples.push(performance.now() - startedAt);
  }

  return summarize(samples);
}

function summarize(samples: number[]): TimingSummary {
  const sorted = [...samples].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const p95Index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * 0.95) - 1));
  return {
    avgMs: total / sorted.length,
    minMs: sorted[0],
    p95Ms: sorted[p95Index],
    maxMs: sorted[sorted.length - 1],
  };
}

function printLightReport(rows: LightBenchRow[]) {
  console.log("## Light Path");
  for (const row of rows) {
    console.log(
      `${row.source} ch${row.chapterNumber}: whole=${formatMs(row.chapterScan.avgMs)} avg (${row.chapterChars} chars), ` +
      `paragraph=${formatMs(row.paragraphScan.avgMs)} avg (${row.paragraphChars} chars), speedup=${row.speedup.toFixed(1)}x`,
    );
  }
  const avgSpeedup = rows.reduce((sum, row) => sum + row.speedup, 0) / Math.max(rows.length, 1);
  console.log(`Average paragraph speedup: ${avgSpeedup.toFixed(1)}x`);
  console.log("");
}

// Fast mode must run in ≤50% of the original 'low' baseline (41.46ms avg).
const FAST_MAX_AVG_MS = 21;

function printHeavyReport(rows: HeavyBenchRow[]): boolean {
  console.log("## Heavy Path");
  for (const row of rows) {
    console.log(
      `${row.source} ch${row.chapterNumber}: fast=${formatMs(row.fast.avgMs)} avg, ` +
      `default=${formatMs(row.default.avgMs)} avg, high=${formatMs(row.high.avgMs)} avg ` +
      `(default/fast=${row.fastVsDefault.toFixed(2)}x, high/fast=${row.fastVsHigh.toFixed(2)}x)`,
    );
  }

  const avgFast = average(rows.map((row) => row.fast.avgMs));
  const avgDefault = average(rows.map((row) => row.default.avgMs));
  const avgHigh = average(rows.map((row) => row.high.avgMs));
  console.log(
    `Averages: fast=${formatMs(avgFast)}, default=${formatMs(avgDefault)}, high=${formatMs(avgHigh)} ` +
    `(default/fast=${(avgDefault / Math.max(avgFast, 0.0001)).toFixed(2)}x, high/fast=${(avgHigh / Math.max(avgFast, 0.0001)).toFixed(2)}x)`,
  );
  const passed = avgFast <= FAST_MAX_AVG_MS;
  console.log(`Fast mode latency: ${formatMs(avgFast)} avg — target ≤${FAST_MAX_AVG_MS}ms — ${passed ? "✓ PASS" : "✗ FAIL"}`);
  console.log("");
  return passed;
}

function printCrossContextReport(rows: CrossContextRow[]) {
  console.log("## Cross-Chapter Context");
  for (const row of rows) {
    console.log(
      `${row.source} ch${row.chapterNumber}: prev=ch${row.prevChapterNumber} (${row.prevParagraphs} paras), ` +
      `current=${row.currentParagraphs} paras, next=ch${row.nextChapterNumber} (${row.nextParagraphs} paras), ` +
      `currentReceivedPrev=${row.currentReceivedPrevContext}, nextReceivedCurrent=${row.nextReceivedCurrentContext}`,
    );
  }
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function formatMs(value: number): string {
  return `${value.toFixed(2)}ms`;
}

void main();