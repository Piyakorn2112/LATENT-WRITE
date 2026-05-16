/// <reference types="node" />

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { analyzeChapter, computeChapterStats, type ChapterRole, type ChapterStats } from "../src/lib/chapter-analysis";
import { parseNovel } from "../src/lib/parser";
import { detectSpeechInChapter, type ChapterEndContext } from "../src/lib/speech-detect";
import { resolveKnownNames } from "../src/lib/world-data";

type SourceKey = "Hollow Iris" | "Root Crown";

type ChapterPass = {
  number: number;
  title: string;
  paragraphs: string[];
  speechResults: ReturnType<typeof detectSpeechInChapter>;
  stats: ChapterStats;
};

type RoleSample = {
  number: number;
  title: string;
  role: ChapterRole;
  arcShape: string;
  peakTension: string;
  tensionVsAvg: number;
  avgTensionScore: number;
  dialogueVsAvg: number;
  avgDialogueDensity: number;
};

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = path.resolve(repoRoot, "..");
const SOURCE_FILES: Record<SourceKey, string> = {
  "Hollow Iris": path.join(workspaceRoot, "novel-reader", "public", "novels", "hollow-iris.txt"),
  "Root Crown": path.join(workspaceRoot, "novel-reader", "public", "novels", "root-crown.txt"),
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sources = options.source ? [options.source] : (["Hollow Iris", "Root Crown"] as const);

  for (const source of sources) {
    const report = await analyzeSource(source);
    printReport(source, report, options.limit);
  }
}

function parseArgs(argv: string[]): { source?: SourceKey; limit: number } {
  let source: SourceKey | undefined;
  let limit = 12;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--source") {
      const raw = argv[i + 1];
      if (raw && (raw.toLowerCase().includes("hollow") || raw.toLowerCase().includes("iris"))) {
        source = "Hollow Iris";
        i += 1;
      } else if (raw && raw.toLowerCase().includes("root")) {
        source = "Root Crown";
        i += 1;
      }
      continue;
    }
    if (token === "--limit") {
      const raw = argv[i + 1];
      if (raw) {
        limit = Math.max(1, Number.parseInt(raw, 10) || limit);
        i += 1;
      }
    }
  }

  return { source, limit };
}

async function analyzeSource(source: SourceKey) {
  const raw = await readFile(SOURCE_FILES[source], "utf8");
  const novel = parseNovel(raw);
  const knownNames = resolveKnownNames(novel);

  let prevContext: ChapterEndContext | null = null;
  const firstPass: ChapterPass[] = [];

  for (const chapter of novel.chapters) {
    const paragraphs = toParagraphs(chapter.content);
    const contextOut: { value: ChapterEndContext | null } = { value: null };
    const speechResults = detectSpeechInChapter(paragraphs, knownNames, {
      intelligenceLevel: "default",
      prevChapterContext: prevContext ?? undefined,
      contextOut,
    });
    firstPass.push({
      number: chapter.number,
      title: chapter.title,
      paragraphs,
      speechResults,
      stats: computeChapterStats(paragraphs, speechResults),
    });
    prevContext = contextOut.value;
  }

  const samples: RoleSample[] = firstPass.map((chapter, index) => {
    const siblingStats = firstPass
      .filter((_item, siblingIndex) => siblingIndex !== index)
      .map(item => item.stats);
    const analysis = analyzeChapter(
      chapter.paragraphs,
      chapter.speechResults,
      siblingStats,
      index,
      "default",
    );
    return {
      number: chapter.number,
      title: chapter.title,
      role: analysis.chapterRole,
      arcShape: analysis.arcShape,
      peakTension: analysis.peakTension,
      tensionVsAvg: analysis.comparative?.tensionVsAvg ?? 1,
      avgTensionScore: chapter.stats.avgTensionScore,
      dialogueVsAvg: analysis.comparative?.dialogueVsAvg ?? 1,
      avgDialogueDensity: chapter.stats.avgDialogueDensity,
    };
  });

  return samples;
}

function toParagraphs(content: string): string[] {
  return content
    .split(/\n{2,}|\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function printReport(source: SourceKey, samples: RoleSample[], limit: number) {
  const roleCounts = countBy(samples, sample => sample.role);
  const climaxes = samples
    .filter(sample => sample.role === "climax")
    .sort((a, b) => b.tensionVsAvg - a.tensionVsAvg);
  const climaxArcShapes = countBy(climaxes, sample => sample.arcShape);

  console.log(`\n# ${source}`);
  console.log(`chapters: ${samples.length}`);
  console.log("roles:");
  for (const role of ["climax", "pivot", "buildup", "resolution", "expository", "breather", "standard"] as ChapterRole[]) {
    const count = roleCounts.get(role) ?? 0;
    const pct = samples.length > 0 ? Math.round((count / samples.length) * 100) : 0;
    console.log(`  ${role}: ${count} (${pct}%)`);
  }

  console.log("climax arc shapes:");
  for (const [shape, count] of [...climaxArcShapes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${shape}: ${count}`);
  }

  console.log(`top ${Math.min(limit, climaxes.length)} climax chapters by tensionVsAvg:`);
  for (const sample of climaxes.slice(0, limit)) {
    console.log(
      `  Ch ${sample.number}: ${sample.title} | arc=${sample.arcShape} peak=${sample.peakTension} ` +
      `tensionVsAvg=${sample.tensionVsAvg.toFixed(2)} avgTension=${sample.avgTensionScore.toFixed(2)} ` +
      `dialogueVsAvg=${sample.dialogueVsAvg.toFixed(2)}`,
    );
  }
}

function countBy<T>(items: T[], getKey: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = getKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});