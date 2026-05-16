/// <reference types="node" />

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import type { Chapter, Novel } from "../src/types";
import { analyzeChapter } from "../src/lib/chapter-analysis";
import { parseNovel } from "../src/lib/parser";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { buildChapterEntry, enrichChapterEntryWithLM } from "../src/lib/story-graph";
import { resolveKnownNames } from "../src/lib/world-data";

type SampleSpec = {
  source: string;
  chapter: Chapter;
  novel: Novel;
};

type CliOptions = {
  limit?: number;
  sourceFilter?: string;
  allPublished?: boolean;
  maxPerSource?: number;
  stride?: number;
  summaryOnly?: boolean;
};

type EventView = {
  label: string;
  type: string;
  tensionPosition: number;
};

type SampleReport = {
  sample: SampleSpec;
  paragraphs: string[];
  baseline: EventView[];
  enriched: EventView[];
};

type QualityStats = {
  totalEvents: number;
  changedEvents: number;
  fragmentLabels: number;
  truncatedLabels: number;
  genericLabels: number;
};

const DEFAULT_PUBLISHED_CHAPTERS = {
  "Hollow Iris": [1, 22, 137],
  "The Root Crown": [1, 16, 20],
} as const;

const GENERIC_LABELS = new Set([
  "She watched people",
  "She paused",
  "She was hungry",
  "Nora enters",
  "Scene transition",
  "Narrative pivot",
  "Chapter climax",
]);

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = path.resolve(repoRoot, "..");

const browserWindow = {
  location: {
    href: pathToFileURL(path.join(repoRoot, "public", "index.html")).href,
  },
};

Object.assign(globalThis, { window: browserWindow });

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const samples = await loadSamples(options);

  if (samples.length === 0) {
    console.error("No event-label samples matched the requested filters.");
    process.exitCode = 1;
    return;
  }

  console.log(`# Event Label Report (${samples.length} sample${samples.length === 1 ? "" : "s"})`);
  const reports: SampleReport[] = [];
  for (const sample of samples) {
    const knownNames = resolveKnownNames(sample.novel);
    const paragraphs = toParagraphs(sample.chapter.content);
    const speechResults = detectSpeechInChapter(paragraphs, knownNames, {
      intelligenceLevel: "default",
    });
    const analysis = analyzeChapter(paragraphs, speechResults, []);
    const result = {
      paragraphs,
      speechResults,
      speechPredictions: [],
      actionPredictions: [],
      analysis,
      endContext: null,
    };

    const baseEntry = buildChapterEntry(sample.chapter, result, sample.novel.worldData);
    const enrichedEntry = await enrichChapterEntryWithLM(baseEntry, sample.chapter.content);

    const report: SampleReport = {
      sample,
      paragraphs,
      baseline: baseEntry.majorEvents.map((event) => ({
        label: event.label,
        type: event.type,
        tensionPosition: event.tensionPosition,
      })),
      enriched: enrichedEntry.majorEvents.map((event) => ({
        label: event.label,
        type: event.type,
        tensionPosition: event.tensionPosition,
      })),
    };
    reports.push(report);

    if (options.summaryOnly) continue;

    console.log(`\n## ${sample.source} — Chapter ${sample.chapter.number}: ${sample.chapter.title}`);
    printEvents("Baseline", baseEntry.majorEvents, paragraphs);
    printEvents("Enriched", enrichedEntry.majorEvents, paragraphs);
    printDiff(baseEntry.majorEvents, enrichedEntry.majorEvents);
  }

  printSummary(reports);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--limit") {
      const raw = argv[index + 1];
      if (raw) {
        options.limit = Math.max(1, Number.parseInt(raw, 10) || 0);
        index += 1;
      }
      continue;
    }
    if (token === "--source") {
      const raw = argv[index + 1];
      if (raw) {
        options.sourceFilter = raw.trim().toLowerCase();
        index += 1;
      }
      continue;
    }
    if (token === "--all-published") {
      options.allPublished = true;
      continue;
    }
    if (token === "--max-per-source") {
      const raw = argv[index + 1];
      if (raw) {
        options.maxPerSource = Math.max(1, Number.parseInt(raw, 10) || 0);
        index += 1;
      }
      continue;
    }
    if (token === "--stride") {
      const raw = argv[index + 1];
      if (raw) {
        options.stride = Math.max(1, Number.parseInt(raw, 10) || 0);
        index += 1;
      }
      continue;
    }
    if (token === "--summary-only") {
      options.summaryOnly = true;
    }
  }

  return options;
}

async function loadSamples(options: CliOptions): Promise<SampleSpec[]> {
  const publishedBooks = await Promise.all([
    loadPublishedNovel(
      "Hollow Iris",
      path.join(workspaceRoot, "novel-reader", "public", "novels", "hollow-iris.txt"),
      DEFAULT_PUBLISHED_CHAPTERS["Hollow Iris"],
      options,
    ),
    loadPublishedNovel(
      "The Root Crown",
      path.join(workspaceRoot, "novel-reader", "public", "novels", "root-crown.txt"),
      DEFAULT_PUBLISHED_CHAPTERS["The Root Crown"],
      options,
    ),
  ]);

  const syntheticSamples = buildSyntheticSamples();
  const combined = [...publishedBooks.flat(), ...syntheticSamples];

  const filtered = options.sourceFilter
    ? combined.filter((sample) => sample.source.toLowerCase().includes(options.sourceFilter ?? ""))
    : combined;

  return options.limit ? filtered.slice(0, options.limit) : filtered;
}

async function loadPublishedNovel(
  source: string,
  filePath: string,
  chapterNumbers: readonly number[],
  options: CliOptions,
): Promise<SampleSpec[]> {
  const raw = await readFile(filePath, "utf8");
  const novel = parseNovel(raw);
  const samples: SampleSpec[] = [];

  const stride = options.stride ?? 1;
  const pool = options.allPublished
    ? novel.chapters.filter((_chapter, index) => index % stride === 0)
    : chapterNumbers
        .map((chapterNumber) => novel.chapters.find((item) => item.number === chapterNumber))
        .filter((chapter): chapter is Chapter => !!chapter);

  const selected = options.maxPerSource ? pool.slice(0, options.maxPerSource) : pool;

  for (const chapter of selected) {
    samples.push({ source, chapter, novel });
  }

  return samples;
}

function buildSyntheticSamples(): SampleSpec[] {
  const raw = [
    "===TITLE===",
    "Synthetic Labels",
    "",
    "===CHAPTER 1: The Public Refusal===",
    [
      "Mara kept the transcript open on the table until the paper curled at the corners.",
      "When the committee chair asked whether the omissions were accidental, she did not answer immediately. She let the room hear the gap.",
      "Then she said, \"The record was built to survive the institution, not to flatter it.\" Nobody interrupted her after that.",
      "By the time the meeting ended, every person in the chamber understood that the apology had failed.",
    ].join("\n\n"),
    "",
    "===CHAPTER 2: The Missing Return===",
    [
      "Jun touched the wall conduit the way he always did before sleeping, expecting the faint answering warmth.",
      "Tonight there was nothing. He waited long enough for waiting to become embarrassment and then longer, until it became fear.",
      "The house was unchanged except for that absence, which made the unchanged things feel staged around him.",
      "He understood, with a clarity that left no room for denial, that the network had chosen not to answer.",
    ].join("\n\n"),
    "",
  ].join("\n");
  const novel = parseNovel(raw);
  return novel.chapters.map((chapter) => ({ source: "Synthetic", chapter, novel }));
}

function toParagraphs(content: string): string[] {
  return content
    .split(/\n{2,}|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function printEvents(label: string, events: Array<{ label: string; type: string; tensionPosition: number }>, paragraphs: string[]) {
  console.log(`\n${label}:`);
  if (events.length === 0) {
    console.log("  (no events)");
    return;
  }

  for (const event of events) {
    const paragraphIndex = Math.max(
      0,
      Math.min(paragraphs.length - 1, Math.round(event.tensionPosition * Math.max(1, paragraphs.length - 1))),
    );
    const excerpt = clip(paragraphs[paragraphIndex] ?? "", 140);
    console.log(`  - ${event.type} @ ${Math.round(event.tensionPosition * 100)}%`);
    console.log(`    label: ${event.label}`);
    console.log(`    para : ${excerpt}`);
  }
}

function printSummary(reports: SampleReport[]) {
  const bySource = new Map<string, { baseline: QualityStats; enriched: QualityStats; chapters: number }>();

  for (const report of reports) {
    const current = bySource.get(report.sample.source) ?? {
      baseline: emptyStats(),
      enriched: emptyStats(),
      chapters: 0,
    };
    current.chapters += 1;
    accumulateStats(current.baseline, report.baseline);
    accumulateStats(current.enriched, report.enriched);
    current.baseline.changedEvents += countChanged(report.baseline, report.enriched);
    bySource.set(report.sample.source, current);
  }

  console.log("\n## Summary");
  for (const [source, summary] of bySource) {
    const changedPct = summary.baseline.totalEvents > 0
      ? Math.round((summary.baseline.changedEvents / summary.baseline.totalEvents) * 100)
      : 0;
    console.log(`\n${source}: ${summary.chapters} chapter${summary.chapters === 1 ? "" : "s"}`);
    console.log(`  baseline fragment-like: ${summary.baseline.fragmentLabels}/${summary.baseline.totalEvents}`);
    console.log(`  enriched fragment-like: ${summary.enriched.fragmentLabels}/${summary.enriched.totalEvents}`);
    console.log(`  baseline truncated: ${summary.baseline.truncatedLabels}/${summary.baseline.totalEvents}`);
    console.log(`  enriched truncated: ${summary.enriched.truncatedLabels}/${summary.enriched.totalEvents}`);
    console.log(`  baseline generic: ${summary.baseline.genericLabels}/${summary.baseline.totalEvents}`);
    console.log(`  enriched generic: ${summary.enriched.genericLabels}/${summary.enriched.totalEvents}`);
    console.log(`  relabeled events: ${summary.baseline.changedEvents}/${summary.baseline.totalEvents} (${changedPct}%)`);
  }
}

function emptyStats(): QualityStats {
  return {
    totalEvents: 0,
    changedEvents: 0,
    fragmentLabels: 0,
    truncatedLabels: 0,
    genericLabels: 0,
  };
}

function accumulateStats(target: QualityStats, events: EventView[]) {
  for (const event of events) {
    target.totalEvents += 1;
    if (isFragmentLikeLabel(event.label)) target.fragmentLabels += 1;
    if (isTruncatedLabel(event.label)) target.truncatedLabels += 1;
    if (isGenericLabel(event.label)) target.genericLabels += 1;
  }
}

function countChanged(before: EventView[], after: EventView[]): number {
  let changed = 0;
  const used = new Set<number>();

  for (const baseEvent of before) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < after.length; index += 1) {
      if (used.has(index)) continue;
      const distance = Math.abs(after[index].tensionPosition - baseEvent.tensionPosition);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    if (bestIndex < 0 || bestDistance > 0.1) continue;
    used.add(bestIndex);
    const next = after[bestIndex];
    if (next.label !== baseEvent.label || next.type !== baseEvent.type) changed += 1;
  }

  return changed;
}

function isFragmentLikeLabel(label: string): boolean {
  if (!label) return true;
  if (label.length < 10) return true;
  if (/\b(?:and|or|but|of|to|for|with|without|from|by|at|in|on|the|a|an|than|more|one|had|has|have)\b$/i.test(label)) return true;
  if (/^[a-z]/.test(label)) return true;
  return false;
}

function isTruncatedLabel(label: string): boolean {
  return label.endsWith("…");
}

function isGenericLabel(label: string): boolean {
  return GENERIC_LABELS.has(label) || label.split(/\s+/).length <= 3;
}

function printDiff(
  before: Array<{ label: string; type: string; tensionPosition: number }>,
  after: Array<{ label: string; type: string; tensionPosition: number }>,
) {
  console.log("\nDelta:");
  if (before.length === 0 && after.length === 0) {
    console.log("  (no changes)");
    return;
  }

  const used = new Set<number>();
  for (const baseEvent of before) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < after.length; index += 1) {
      if (used.has(index)) continue;
      const distance = Math.abs(after[index].tensionPosition - baseEvent.tensionPosition);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    if (bestIndex >= 0 && bestDistance <= 0.1) {
      used.add(bestIndex);
      const next = after[bestIndex];
      const changed = baseEvent.label === next.label && baseEvent.type === next.type ? "unchanged" : "updated";
      console.log(`  - ${changed}: ${baseEvent.label} -> ${next.label}`);
      continue;
    }

    console.log(`  - removed: ${baseEvent.label}`);
  }

  for (let index = 0; index < after.length; index += 1) {
    if (used.has(index)) continue;
    console.log(`  - added: ${after[index].label}`);
  }
}

function clip(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  const cut = singleLine.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});