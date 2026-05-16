/// <reference types="node" />

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import type { Chapter, MajorEvent, Novel } from "../src/types";
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
  detailLabel?: string;
  tensionPosition: number;
  confidence: number;
};

type SampleReport = {
  sample: SampleSpec;
  paragraphs: string[];
  baseline: EventView[];
  enriched: EventView[];
};

type SourceSummary = {
  chapters: number;
  totalEvents: number;
  relabeled: number;
  refinedTypes: number;
  detailed: number;
  detailCounts: Map<string, number>;
};

const DEFAULT_SAMPLE_CHAPTERS: Record<string, number[]> = {
  "Hollow Iris": [1, 22, 151],
  "The Root Crown": [1, 16, 20],
  "The Last Wanderer": [1, 2, 3],
};

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
    console.error("No LM event samples matched the requested filters.");
    process.exitCode = 1;
    return;
  }

  console.log(`# Event LM Report (${samples.length} sample${samples.length === 1 ? "" : "s"})`);
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
      baseline: baseEntry.majorEvents.map(viewEvent),
      enriched: enrichedEntry.majorEvents.map(viewEvent),
    };
    reports.push(report);

    if (options.summaryOnly) continue;

    console.log(`\n## ${sample.source} — Chapter ${sample.chapter.number}: ${sample.chapter.title}`);
    printChapterReport(report);
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
      DEFAULT_SAMPLE_CHAPTERS["Hollow Iris"],
      options,
    ),
    loadPublishedNovel(
      "The Root Crown",
      path.join(workspaceRoot, "novel-reader", "public", "novels", "root-crown.txt"),
      DEFAULT_SAMPLE_CHAPTERS["The Root Crown"],
      options,
    ),
    loadPublishedNovel(
      "The Last Wanderer",
      path.join(workspaceRoot, "novel-reader", "public", "novels", "sample-novel.txt"),
      DEFAULT_SAMPLE_CHAPTERS["The Last Wanderer"],
      options,
    ),
  ]);

  const combined = publishedBooks.flat();
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

  const fallbackPool = pool.length > 0 ? pool : pickSpread(novel.chapters);
  const selected = options.maxPerSource ? fallbackPool.slice(0, options.maxPerSource) : fallbackPool;

  for (const chapter of selected) {
    samples.push({ source, chapter, novel });
  }

  return samples;
}

function pickSpread(chapters: Chapter[]): Chapter[] {
  if (chapters.length <= 3) return [...chapters];
  return [
    chapters[0],
    chapters[Math.floor((chapters.length - 1) / 2)],
    chapters[chapters.length - 1],
  ];
}

function viewEvent(event: MajorEvent): EventView {
  return {
    label: event.label,
    type: event.type,
    detailLabel: event.detailLabel,
    tensionPosition: event.tensionPosition,
    confidence: event.confidence,
  };
}

function printChapterReport(report: SampleReport) {
  if (report.enriched.length === 0) {
    console.log("  (no events)");
    return;
  }

  const matches = matchEvents(report.baseline, report.enriched);
  for (const match of matches) {
    const paraIndex = Math.max(
      0,
      Math.min(report.paragraphs.length - 1, Math.round(match.after.tensionPosition * Math.max(1, report.paragraphs.length - 1))),
    );
    const excerpt = clip(report.paragraphs[paraIndex] ?? "", 150);
    const relabel = match.before.label === match.after.label ? "unchanged" : `relabel: ${match.before.label} -> ${match.after.label}`;
    const retype = match.before.type === match.after.type ? match.after.type : `${match.before.type} -> ${match.after.type}`;
    const detail = match.after.detailLabel ? ` | detail: ${match.after.detailLabel}` : "";
    console.log(`  - ${relabel}`);
    console.log(`    type : ${retype}${detail}`);
    console.log(`    para : ${excerpt}`);
  }
}

function printSummary(reports: SampleReport[]) {
  const bySource = new Map<string, SourceSummary>();

  for (const report of reports) {
    const current = bySource.get(report.sample.source) ?? {
      chapters: 0,
      totalEvents: 0,
      relabeled: 0,
      refinedTypes: 0,
      detailed: 0,
      detailCounts: new Map<string, number>(),
    };

    current.chapters += 1;
    const matches = matchEvents(report.baseline, report.enriched);
    for (const match of matches) {
      current.totalEvents += 1;
      if (match.before.label !== match.after.label) current.relabeled += 1;
      if (match.before.type !== match.after.type) current.refinedTypes += 1;
      if (match.after.detailLabel) {
        current.detailed += 1;
        current.detailCounts.set(match.after.detailLabel, (current.detailCounts.get(match.after.detailLabel) ?? 0) + 1);
      }
    }

    bySource.set(report.sample.source, current);
  }

  console.log("\n## Summary");
  for (const [source, summary] of bySource) {
    const relabelPct = summary.totalEvents > 0
      ? Math.round((summary.relabeled / summary.totalEvents) * 100)
      : 0;
    const detailPct = summary.totalEvents > 0
      ? Math.round((summary.detailed / summary.totalEvents) * 100)
      : 0;
    console.log(`\n${source}: ${summary.chapters} chapter${summary.chapters === 1 ? "" : "s"}`);
    console.log(`  events: ${summary.totalEvents}`);
    console.log(`  relabeled by LM: ${summary.relabeled} (${relabelPct}%)`);
    console.log(`  type refinements: ${summary.refinedTypes}`);
    console.log(`  detail-tagged: ${summary.detailed} (${detailPct}%)`);
    const topDetails = [...summary.detailCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (topDetails.length > 0) {
      console.log(`  detail tags: ${topDetails.map(([label, count]) => `${label}×${count}`).join(", ")}`);
    }
  }
}

function matchEvents(before: EventView[], after: EventView[]) {
  const matches: Array<{ before: EventView; after: EventView }> = [];
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

    if (bestIndex < 0 || bestDistance > 0.12) continue;
    used.add(bestIndex);
    matches.push({ before: baseEvent, after: after[bestIndex] });
  }

  return matches;
}

function toParagraphs(content: string): string[] {
  return content
    .split(/\n{2,}|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
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