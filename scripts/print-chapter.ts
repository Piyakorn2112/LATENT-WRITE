/**
 * print-chapter.ts — dump one chapter with paragraph numbers that MATCH the engine.
 *
 * Every gold annotation anchors to a paragraph index, so the numbering a human
 * (or an annotating agent) reads has to be the same numbering the detector uses.
 * That split is `/\n{2,}|\n/` + trim + drop-empties, and it is duplicated in
 * story-graph.ts, event-detect.ts and App.tsx. Getting it wrong here would
 * shift every anchor by a silent, variable offset — the gold set would look
 * plausible and score everything as a near-miss.
 *
 * Usage:
 *   tsx scripts/print-chapter.ts hollow-iris 45
 *   tsx scripts/print-chapter.ts root-crown 16 --raw     # no width clipping
 */

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { parseNovel } from "../src/lib/parser";

const NOVELS_DIR = "/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels";
const CORPUS_DIR = path.resolve(fileURLToPath(new URL("./fixtures/corpus/", import.meta.url)));

/**
 * The in-house manuscripts, plus three published novels by other authors.
 *
 * The Gutenberg imports exist because the whole gold set was one author's voice,
 * and a detector measured only on the voice it was built against cannot be said
 * to work. See scripts/import-gutenberg.ts for the licence reasoning, which is
 * the reason this route was chosen over BookSum and Shmoop.
 */
export const BOOKS: Record<string, string> = {
  "hollow-iris": "hollow-iris.txt",
  "root-crown": "root-crown.txt",
  sample: "sample-novel.txt",
};

/** Imported public-domain books, resolved from the committed corpus directory. */
export const CORPUS_BOOKS: Record<string, string> = {
  sherlock: "sherlock.txt",
  pride: "pride.txt",
  worlds: "worlds.txt",
  dracula: "dracula.txt",
  carol: "carol.txt",
  frankenstein: "frankenstein.txt",
  expectations: "expectations.txt",
  // ★ Added to fix a measured representativeness problem: 84% of the gold set was
  // 19th-century BRITISH prose. These bring American and Canadian voices, 20th
  // century, YA, adventure and close-interior registers.
  gatsby: "gatsby.txt",
  anne: "anne.txt",
  antonia: "antonia.txt",
  treasure: "treasure.txt",
  awakening: "awakening.txt",
};

/** The engine's paragraph split. Single source of truth for the harness. */
export function splitParagraphs(content: string): string[] {
  return content
    .split(/\n{2,}|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function loadBook(key: string) {
  if (CORPUS_BOOKS[key]) {
    return parseNovel(await readFile(path.join(CORPUS_DIR, CORPUS_BOOKS[key]), "utf8"));
  }
  const file = BOOKS[key];
  if (!file) {
    const all = [...Object.keys(BOOKS), ...Object.keys(CORPUS_BOOKS)].join(", ");
    throw new Error(`unknown book "${key}" — one of: ${all}`);
  }
  return parseNovel(await readFile(path.join(NOVELS_DIR, file), "utf8"));
}

async function main() {
  const [bookKey, chapterArg, ...flags] = process.argv.slice(2);
  if (!bookKey || !chapterArg) {
    console.error("usage: tsx scripts/print-chapter.ts <book> <chapterNumber> [--raw]");
    process.exitCode = 1;
    return;
  }
  const raw = flags.includes("--raw");
  const novel = await loadBook(bookKey);
  const number = Number.parseInt(chapterArg, 10);
  const chapter = novel.chapters.find((c) => c.number === number);
  if (!chapter) {
    console.error(`chapter ${number} not found (book has ${novel.chapters.length})`);
    process.exitCode = 1;
    return;
  }

  const paragraphs = splitParagraphs(chapter.content);
  console.log(`# ${bookKey} — Chapter ${chapter.number}: ${chapter.title}`);
  console.log(`# ${paragraphs.length} paragraphs, ${chapter.content.trim().split(/\s+/).length} words`);
  console.log(`# Paragraph numbers below are 1-BASED and match the engine's split.`);
  console.log("");
  paragraphs.forEach((p, i) => {
    const body = raw ? p : p.replace(/\s+/g, " ");
    console.log(`[${i + 1}] ${body}`);
    console.log("");
  });
}

// Only run the CLI when invoked directly, so the exports above stay importable.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
