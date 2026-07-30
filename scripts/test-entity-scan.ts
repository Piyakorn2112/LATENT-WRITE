/// <reference types="node" />

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import type { Novel, WorldData } from "../src/types";
import { parseNovel } from "../src/lib/parser";
import { scanAndClassify, type ScanResult } from "../src/lib/world-data";
// ★ This suite DID NOT RUN. It exited 1 on an unhandled `sharp` import error,
// because world-data.ts lazily imports narrative-lm.ts for its semantic entity
// assist and @xenova/transformers v2 statically imports sharp, whose native
// binary is not built in this store. Installing the Node backend both stubs
// sharp and gives the semantic-assist path a real model, so the numbers below
// finally describe the pipeline the app actually runs. The same failure hid the
// event-label suite; see scripts/lm-node-backend.ts.
import { installNodeEmbedder, reportBackend } from "./lm-node-backend";

type SourceKey = "Hollow Iris" | "Root Crown" | "Last Wanderer";

type SourceSpec = {
  name: SourceKey;
  novelPath: string;
  referenceWorldPath?: string;
  preferredChapters: number[];
  novelIncludes: string[];
  novelExcludes: string[];
  chapterChecks: Array<{
    chapter: number;
    includes: string[];
    excludes: string[];
  }>;
};

type CliOptions = {
  sourceFilter?: string;
  summaryOnly: boolean;
  runStress: boolean;
  semanticAssist?: boolean;
};

type ManualCheckResult = {
  label: string;
  includesHit: string[];
  includesMissed: string[];
  excludesClean: string[];
  excludesTriggered: string[];
};

type ReferenceMetrics = {
  matched: string[];
  unmatched: string[];
  precision: number;
  typedMatches: number;
  typePrecision: number;
};

type EvaluationResult = {
  source: SourceKey;
  label: string;
  durationMs: number;
  result: ScanResult;
  allNames: string[];
  manual: ManualCheckResult;
  reference?: ReferenceMetrics;
};

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = path.resolve(repoRoot, "..");

const SOURCES: SourceSpec[] = [
  {
    name: "Hollow Iris",
    novelPath: path.join(workspaceRoot, "novel-reader", "public", "novels", "hollow-iris.txt"),
    referenceWorldPath: path.join(workspaceRoot, "novel-reader", "public", "novels", "hollow-iris-world.json"),
    preferredChapters: [1, 22, 151],
    novelIncludes: ["Nora", "Iris", "Ananke", "Kairon"],
    novelExcludes: ["Yes", "Morning", "Today", "Tomorrow", "Nora Iris", "Nora and Iris", "Helia and Iris", "Tuesdays and Thursdays"],
    chapterChecks: [
      { chapter: 2, includes: ["Nora", "Kairon"], excludes: ["Yes", "Morning"] },
      { chapter: 22, includes: ["Iris"], excludes: ["Yes", "Later"] },
    ],
  },
  {
    name: "Root Crown",
    novelPath: path.join(workspaceRoot, "novel-reader", "public", "novels", "root-crown.txt"),
    preferredChapters: [1, 16, 20],
    novelIncludes: ["Vey", "Myrhold", "Mira"],
    novelExcludes: ["Yes", "Morning", "Chapter", "Today", "Year", "Closed Thursday", "Gareth and Mira"],
    chapterChecks: [
      { chapter: 1, includes: ["Vey", "Myrhold"], excludes: ["Yes", "Morning"] },
      { chapter: 16, includes: ["Mira"], excludes: ["Yes", "Today"] },
    ],
  },
  {
    name: "Last Wanderer",
    novelPath: path.join(workspaceRoot, "novel-reader", "public", "novels", "sample-novel.txt"),
    referenceWorldPath: path.join(workspaceRoot, "novel-reader", "public", "novels", "the-last-wanderer-world.json"),
    preferredChapters: [1, 2, 3],
    novelIncludes: ["Marcus", "Kael", "The Spire of Echoes"],
    novelExcludes: ["Yes", "Morning", "Chapter"],
    chapterChecks: [
      { chapter: 3, includes: ["Marcus", "Kael"], excludes: ["Yes", "Morning"] },
    ],
  },
];

async function main() {
  reportBackend(await installNodeEmbedder());
  const options = parseArgs(process.argv.slice(2));
  const selectedSources = SOURCES.filter((source) =>
    !options.sourceFilter || source.name.toLowerCase().includes(options.sourceFilter),
  );

  if (selectedSources.length === 0) {
    console.error("No entity-scan sources matched the requested filters.");
    process.exitCode = 1;
    return;
  }

  const evaluations: EvaluationResult[] = [];
  for (const source of selectedSources) {
    const novel = await loadNovel(source.novelPath);
    const referenceWorld = source.referenceWorldPath ? await loadWorld(source.referenceWorldPath) : undefined;

    evaluations.push(await evaluateNovel(source, novel, referenceWorld, options.semanticAssist));
    for (const chapterCheck of source.chapterChecks) {
      const chapter = novel.chapters.find((item) => item.number === chapterCheck.chapter);
      if (!chapter) continue;
      evaluations.push(await evaluateChapter(source, chapter.number, chapter.content, chapterCheck, referenceWorld, options.semanticAssist));
    }
  }

  printReport(evaluations, options.summaryOnly, options.semanticAssist);

  if (options.runStress) {
    await runStressBenchmark(selectedSources[0], options.semanticAssist);
  }

  const hasFailures = evaluations.some((evaluation) => evaluation.manual.includesMissed.length > 0 || evaluation.manual.excludesTriggered.length > 0);
  if (hasFailures) process.exitCode = 1;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    summaryOnly: false,
    runStress: false,
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
    if (token === "--summary-only") {
      options.summaryOnly = true;
      continue;
    }
    if (token === "--stress") {
      options.runStress = true;
      continue;
    }
    if (token === "--semantic-assist") {
      const raw = argv[index + 1]?.trim().toLowerCase();
      if (raw === "on") options.semanticAssist = true;
      if (raw === "off") options.semanticAssist = false;
      if (raw === "on" || raw === "off") index += 1;
    }
  }

  return options;
}

async function loadNovel(filePath: string): Promise<Novel> {
  const raw = await readFile(filePath, "utf8");
  return parseNovel(raw);
}

async function loadWorld(filePath: string): Promise<WorldData> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as WorldData;
}

async function evaluateNovel(
  source: SourceSpec,
  novel: Novel,
  referenceWorld?: WorldData,
  semanticAssist?: boolean,
): Promise<EvaluationResult> {
  const start = performance.now();
  const result = await scanAndClassify(novel.chapters.map((chapter) => chapter.content), undefined, 2, {
    semanticEntityAssist: semanticAssist,
  });
  const durationMs = performance.now() - start;
  const allNames = flattenResult(result);

  return {
    source: source.name,
    label: "Novel",
    durationMs,
    result,
    allNames,
    manual: runManualChecks("Novel", allNames, source.novelIncludes, source.novelExcludes),
    reference: referenceWorld ? runReferenceMetrics(allNames, result, referenceWorld) : undefined,
  };
}

async function evaluateChapter(
  source: SourceSpec,
  chapterNumber: number,
  content: string,
  check: SourceSpec["chapterChecks"][number],
  referenceWorld?: WorldData,
  semanticAssist?: boolean,
): Promise<EvaluationResult> {
  const start = performance.now();
  const result = await scanAndClassify(content, undefined, 1, {
    semanticEntityAssist: semanticAssist,
  });
  const durationMs = performance.now() - start;
  const allNames = flattenResult(result);

  return {
    source: source.name,
    label: `Chapter ${chapterNumber}`,
    durationMs,
    result,
    allNames,
    manual: runManualChecks(`Chapter ${chapterNumber}`, allNames, check.includes, check.excludes),
    reference: referenceWorld ? runReferenceMetrics(allNames, result, referenceWorld) : undefined,
  };
}

function flattenResult(result: ScanResult): string[] {
  return [...result.characters, ...result.places, ...result.factions, ...result.entities];
}

function runManualChecks(label: string, allNames: string[], includes: string[], excludes: string[]): ManualCheckResult {
  const found = new Set(allNames.map((name) => name.toLowerCase()));
  return {
    label,
    includesHit: includes.filter((name) => found.has(name.toLowerCase())),
    includesMissed: includes.filter((name) => !found.has(name.toLowerCase())),
    excludesClean: excludes.filter((name) => !found.has(name.toLowerCase())),
    excludesTriggered: excludes.filter((name) => found.has(name.toLowerCase())),
  };
}

function runReferenceMetrics(allNames: string[], result: ScanResult, worldData: WorldData): ReferenceMetrics {
  const unionRef = new Set<string>();
  const typedRef = new Map<string, "characters" | "places" | "factions">();

  const add = (kind: "characters" | "places" | "factions", items: Array<{ name: string; aliases?: string[] }> | undefined) => {
    for (const item of items ?? []) {
      unionRef.add(item.name.toLowerCase());
      typedRef.set(item.name.toLowerCase(), kind);
      for (const alias of item.aliases ?? []) {
        unionRef.add(alias.toLowerCase());
        typedRef.set(alias.toLowerCase(), kind);
      }
    }
  };

  add("characters", worldData.characters);
  add("places", worldData.places);
  add("factions", worldData.factions);

  const referencedNames = [...result.characters, ...result.places, ...result.factions];
  const matched = referencedNames.filter((name) => unionRef.has(name.toLowerCase()));
  const unmatched = referencedNames.filter((name) => !unionRef.has(name.toLowerCase()));

  let typedMatches = 0;
  for (const name of result.characters) if (typedRef.get(name.toLowerCase()) === "characters") typedMatches += 1;
  for (const name of result.places) if (typedRef.get(name.toLowerCase()) === "places") typedMatches += 1;
  for (const name of result.factions) if (typedRef.get(name.toLowerCase()) === "factions") typedMatches += 1;

  return {
    matched,
    unmatched,
    precision: referencedNames.length ? matched.length / referencedNames.length : 1,
    typedMatches,
    typePrecision: referencedNames.length ? typedMatches / referencedNames.length : 1,
  };
}

function printReport(evaluations: EvaluationResult[], summaryOnly: boolean, semanticAssist?: boolean) {
  console.log(`# Entity Scan Report (${evaluations.length} checks)`);
  console.log(`semantic assist: ${semanticAssist === undefined ? "auto" : semanticAssist ? "on" : "off"}`);

  for (const evaluation of evaluations) {
    console.log(`\n## ${evaluation.source} — ${evaluation.label}`);
    console.log(`duration: ${evaluation.durationMs.toFixed(1)} ms`);
    console.log(`totals: ${evaluation.result.characters.length} chars, ${evaluation.result.places.length} places, ${evaluation.result.factions.length} factions, ${evaluation.result.entities.length} entities`);
    console.log(`manual: hit ${evaluation.manual.includesHit.length}/${evaluation.manual.includesHit.length + evaluation.manual.includesMissed.length}, false positives ${evaluation.manual.excludesTriggered.length}`);

    if (evaluation.reference) {
      console.log(`reference precision: ${(evaluation.reference.precision * 100).toFixed(1)}%`);
      console.log(`typed precision: ${(evaluation.reference.typePrecision * 100).toFixed(1)}%`);
    }

    if (summaryOnly) continue;

    if (evaluation.manual.includesMissed.length > 0) {
      console.log(`  missing expected: ${evaluation.manual.includesMissed.join(", ")}`);
    }
    if (evaluation.manual.excludesTriggered.length > 0) {
      console.log(`  false positives: ${evaluation.manual.excludesTriggered.join(", ")}`);
    }
    if (evaluation.reference && evaluation.reference.unmatched.length > 0) {
      console.log(`  unmatched sample: ${evaluation.reference.unmatched.slice(0, 12).join(", ")}`);
    }
    console.log(`  sample results: ${evaluation.allNames.slice(0, 14).join(", ")}`);
  }
}

async function runStressBenchmark(source: SourceSpec, semanticAssist?: boolean) {
  const novel = await loadNovel(source.novelPath);
  const base = novel.chapters.slice(0, Math.min(12, novel.chapters.length));
  if (base.length === 0) return;

  const expanded: string[] = [];
  let index = 0;
  while (expanded.length < 170) {
    expanded.push(base[index % base.length].content);
    index += 1;
  }

  const start = performance.now();
  const result = await scanAndClassify(expanded, undefined, 2, {
    semanticEntityAssist: semanticAssist,
  });
  const durationMs = performance.now() - start;
  console.log(`\n# Stress Benchmark`);
  console.log(`source: ${source.name}`);
  console.log(`chapters: ${expanded.length}`);
  console.log(`results: ${flattenResult(result).length}`);
  console.log(`duration: ${durationMs.toFixed(1)} ms`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});