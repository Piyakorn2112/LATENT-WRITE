/// <reference types="node" />

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import type { Chapter, ReviewFlag } from "../src/types";
import { runLocalReview } from "../src/lib/local-review";
import { parseNovel } from "../src/lib/parser";

type SourceKey = "Hollow Iris" | "Root Crown" | "Last Wanderer";

type SourceSpec = {
  name: SourceKey;
  filePath: string;
  preferredChapters: number[];
};

type CliOptions = {
  sourceFilter?: string;
  chapterNumbers?: Set<number>;
  types: Set<string>;
  allChapters: boolean;
  summaryOnly: boolean;
  maxPerSource?: number;
};

type ChapterReview = {
  source: SourceKey;
  chapter: Chapter;
  flags: ReviewFlag[];
};

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = path.resolve(repoRoot, "..");

const SOURCES: SourceSpec[] = [
  {
    name: "Hollow Iris",
    filePath: path.join(workspaceRoot, "novel-reader", "public", "novels", "hollow-iris.txt"),
    preferredChapters: [1, 22, 151],
  },
  {
    name: "Root Crown",
    filePath: path.join(workspaceRoot, "novel-reader", "public", "novels", "root-crown.txt"),
    preferredChapters: [1, 16, 20],
  },
  {
    name: "Last Wanderer",
    filePath: path.join(workspaceRoot, "novel-reader", "public", "novels", "sample-novel.txt"),
    preferredChapters: [1, 2, 3],
  },
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const reports = await collectReports(options);

  if (reports.length === 0) {
    console.error("No review samples matched the requested filters.");
    process.exitCode = 1;
    return;
  }

  console.log(`# Local Review Report (${reports.length} chapter sample${reports.length === 1 ? "" : "s"})`);
  console.log(`types: ${[...options.types].join(", ")}`);

  for (const source of SOURCES) {
    const sourceReports = reports.filter((report) => report.source === source.name);
    if (sourceReports.length === 0) continue;
    printSourceSummary(source.name, sourceReports, options.types);

    if (options.summaryOnly) continue;

    for (const report of sourceReports) {
      console.log(`\n## ${report.source} — Chapter ${report.chapter.number}: ${report.chapter.title}`);
      if (report.flags.length === 0) {
        console.log("  no matching flags");
        continue;
      }
      for (const flag of report.flags) {
        const fullSentence = expandQuote(report.chapter.content, flag.quote ?? "");
        console.log(`  [${flag.type}] ${fullSentence}`);
        console.log(`    fix: ${flag.fix}`);
      }
    }
  }

  printGlobalSummary(reports, options.types);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    types: new Set(["over-explanation", "nia"]),
    allChapters: false,
    summaryOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--source") {
      const raw = argv[index + 1];
      if (raw) {
        options.sourceFilter = raw.trim().toLowerCase();
        index += 1;
      }
      continue;
    }
    if (token === "--types") {
      const raw = argv[index + 1];
      if (raw) {
        const nextTypes = raw.split(",").map((item) => item.trim()).filter(Boolean);
        if (nextTypes.length > 0) options.types = new Set(nextTypes);
        index += 1;
      }
      continue;
    }
    if (token === "--chapters") {
      const raw = argv[index + 1];
      if (raw) {
        const values = raw.split(",").map((item) => Number.parseInt(item.trim(), 10)).filter(Number.isFinite);
        if (values.length > 0) options.chapterNumbers = new Set(values);
        index += 1;
      }
      continue;
    }
    if (token === "--all") {
      options.allChapters = true;
      continue;
    }
    if (token === "--summary-only") {
      options.summaryOnly = true;
      continue;
    }
    if (token === "--max-per-source") {
      const raw = argv[index + 1];
      if (raw) {
        options.maxPerSource = Math.max(1, Number.parseInt(raw, 10) || 0);
        index += 1;
      }
    }
  }

  return options;
}

async function collectReports(options: CliOptions): Promise<ChapterReview[]> {
  const reports: ChapterReview[] = [];

  for (const source of SOURCES) {
    if (options.sourceFilter && !source.name.toLowerCase().includes(options.sourceFilter)) continue;

    const raw = await readFile(source.filePath, "utf8");
    const novel = parseNovel(raw);
    const chapters = selectChapters(source, novel.chapters, options);

    for (const chapter of chapters) {
      const result = await runLocalReview(chapter.id, chapter.content);
      reports.push({
        source: source.name,
        chapter,
        flags: result.flags.filter((flag) => options.types.has(flag.type)),
      });
    }
  }

  return reports;
}

function selectChapters(source: SourceSpec, chapters: Chapter[], options: CliOptions): Chapter[] {
  let selected: Chapter[];

  if (options.chapterNumbers && options.chapterNumbers.size > 0) {
    selected = chapters.filter((chapter) => options.chapterNumbers?.has(chapter.number));
  } else if (options.allChapters) {
    selected = [...chapters];
  } else {
    selected = source.preferredChapters
      .map((number) => chapters.find((chapter) => chapter.number === number))
      .filter((chapter): chapter is Chapter => !!chapter);

    if (selected.length === 0 && chapters.length > 0) {
      selected = pickSpread(chapters);
    }
  }

  const deduped = dedupeByNumber(selected);
  return options.maxPerSource ? deduped.slice(0, options.maxPerSource) : deduped;
}

function pickSpread(chapters: Chapter[]): Chapter[] {
  if (chapters.length <= 3) return [...chapters];
  return dedupeByNumber([
    chapters[0],
    chapters[Math.floor((chapters.length - 1) / 2)],
    chapters[chapters.length - 1],
  ]);
}

function dedupeByNumber(chapters: Chapter[]): Chapter[] {
  const seen = new Set<number>();
  const out: Chapter[] = [];
  for (const chapter of chapters) {
    if (seen.has(chapter.number)) continue;
    seen.add(chapter.number);
    out.push(chapter);
  }
  return out;
}

function expandQuote(chapterText: string, quote: string): string {
  const trimmed = quote.trim();
  if (!trimmed) return quote;
  const matches = splitSentences(chapterText).find((sentence) => sentence.startsWith(trimmed) || sentence.includes(trimmed));
  return matches ?? quote;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function printSourceSummary(source: SourceKey, reports: ChapterReview[], types: Set<string>) {
  const counts = countFlags(reports);
  console.log(`\n# ${source}`);
  console.log(`sampled chapters: ${reports.length}`);
  for (const type of types) {
    console.log(`  ${type}: ${counts.get(type) ?? 0}`);
  }
}

function printGlobalSummary(reports: ChapterReview[], types: Set<string>) {
  const counts = countFlags(reports);
  console.log("\n# Totals");
  for (const type of types) {
    console.log(`  ${type}: ${counts.get(type) ?? 0}`);
  }
}

function countFlags(reports: ChapterReview[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const report of reports) {
    for (const flag of report.flags) {
      counts.set(flag.type, (counts.get(flag.type) ?? 0) + 1);
    }
  }
  return counts;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});