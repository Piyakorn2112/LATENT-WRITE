/**
 * validate-gold-batch.ts — check a proposed gold batch BEFORE it is merged.
 *
 *   npx tsx scripts/validate-gold-batch.ts <file.json> [--merge]
 *
 * The gold fixture is the ceiling on every number this project reports, so a bad
 * annotation is worse than a missing one: it silently converts a correct
 * detection into a scored miss and a wrong one into a scored hit. Anything
 * written by an agent — or by me — gets checked by machine before it counts.
 *
 * What is verified:
 *   1. `evidence` occurs EXACTLY in the paragraph it cites, under the engine's
 *      own paragraph split. This is the check that catches the classic failure:
 *      an annotator reading line numbers instead of paragraph numbers.
 *   2. Paragraph numbers are in range for the chapter.
 *   3. Required fields present, enum values legal.
 *   4. No duplicate (book, chapter) against the existing fixture.
 *   5. Salience discipline — flags chapters that mark almost everything major,
 *      because that is the failure mode the guide warns about and it is invisible
 *      to every other check.
 *
 * `--merge` appends to scripts/fixtures/event-gold.json ONLY if everything passes.
 */

import { readFile, writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { loadBook, splitParagraphs } from "./print-chapter";
import type { Novel } from "../src/types";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const GOLD = path.join(REPO_ROOT, "scripts", "fixtures", "event-gold.json");

const TYPES = new Set(["decision", "revelation", "confrontation", "arrival", "departure", "state-change", "action", "shift"]);
const LEGACY = new Set(["climax", "confrontation", "revelation", "introduction", "transition", "scene-break"]);
const SALIENCE = new Set(["major", "minor"]);

interface GoldEvent {
  paragraph: number; summary: string; salience: string; type: string; legacyType: string; evidence: string;
}
interface GoldChapter {
  book: string; chapter: number; eventfulness: string; whatHappens: string; events: GoldEvent[];
}

/** Same normalisation the eye uses: curly quotes, dashes and runs of space. */
function norm(s: string): string {
  return s
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const file = process.argv[2];
  const merge = process.argv.includes("--merge");
  if (!file) { console.error("usage: tsx scripts/validate-gold-batch.ts <file.json> [--merge]"); process.exitCode = 1; return; }

  const batch: GoldChapter[] = JSON.parse(await readFile(file, "utf8"));
  const existing: { chapters: GoldChapter[] } = JSON.parse(await readFile(GOLD, "utf8"));
  const seen = new Set(existing.chapters.map((c) => `${c.book}|${c.chapter}`));

  const cache = new Map<string, Novel>();
  const errors: string[] = [];
  const warnings: string[] = [];
  let events = 0, major = 0;

  for (const c of batch) {
    const key = `${c.book}|${c.chapter}`;
    if (seen.has(key)) { errors.push(`${key}: already in the fixture`); continue; }
    seen.add(key);

    let novel = cache.get(c.book);
    if (!novel) {
      try { novel = await loadBook(c.book); cache.set(c.book, novel); }
      catch { errors.push(`${key}: unknown book "${c.book}"`); continue; }
    }
    const chapter = novel.chapters.find((ch) => ch.number === c.chapter);
    if (!chapter) { errors.push(`${key}: chapter not found`); continue; }
    const paragraphs = splitParagraphs(chapter.content);
    if (!c.whatHappens?.trim()) errors.push(`${key}: missing whatHappens`);

    let chapterMajor = 0;
    let prev = 0;
    for (const [i, e] of c.events.entries()) {
      const at = `${key} #${i + 1} (¶${e.paragraph})`;
      events++;
      if (!SALIENCE.has(e.salience)) errors.push(`${at}: bad salience "${e.salience}"`);
      if (!TYPES.has(e.type)) errors.push(`${at}: bad type "${e.type}"`);
      if (!LEGACY.has(e.legacyType)) errors.push(`${at}: bad legacyType "${e.legacyType}"`);
      if (!e.summary?.trim()) errors.push(`${at}: missing summary`);
      if (e.salience === "major") { major++; chapterMajor++; }
      if (e.paragraph < prev) warnings.push(`${at}: events not in ascending paragraph order`);
      prev = e.paragraph;

      if (!Number.isInteger(e.paragraph) || e.paragraph < 1 || e.paragraph > paragraphs.length) {
        errors.push(`${at}: paragraph out of range (chapter has ${paragraphs.length})`);
        continue;
      }
      const para = norm(paragraphs[e.paragraph - 1]);
      const ev = norm(e.evidence ?? "");
      if (!ev) { errors.push(`${at}: empty evidence`); continue; }
      if (!para.includes(ev)) {
        // Where DID it come from? A near-miss elsewhere is the signature of an
        // off-by-N paragraph index, which is worth naming precisely.
        const found = paragraphs.findIndex((p) => norm(p).includes(ev));
        errors.push(
          `${at}: evidence not in ¶${e.paragraph}` +
          (found >= 0 ? ` — it is in ¶${found + 1} (off by ${found + 1 - e.paragraph})` : " — not found anywhere in the chapter") +
          `\n        "${e.evidence.slice(0, 70)}"`,
        );
      }
    }
    if (c.events.length >= 4 && chapterMajor / c.events.length > 0.7) {
      warnings.push(`${key}: ${chapterMajor}/${c.events.length} marked major — the guide asks for 2-5 per chapter`);
    }
  }

  console.log(`\n${batch.length} chapters, ${events} events, ${major} major (${((major / (events || 1)) * 100).toFixed(0)}%)`);
  for (const w of warnings) console.log(`  WARN  ${w}`);
  if (errors.length) {
    console.log(`\n${errors.length} ERROR(S):`);
    for (const e of errors) console.log(`  ✗ ${e}`);
    console.log(`\nNot merged.`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ✓ every evidence clause verified against the engine's own paragraph split`);

  if (merge) {
    existing.chapters.push(...batch);
    existing.chapters.sort((a, b) => a.book.localeCompare(b.book) || a.chapter - b.chapter);
    await writeFile(GOLD, `${JSON.stringify(existing, null, 2)}\n`);
    const total = existing.chapters.reduce((n, c) => n + c.events.length, 0);
    const totMajor = existing.chapters.reduce((n, c) => n + c.events.filter((e) => e.salience === "major").length, 0);
    console.log(`  ✓ merged — fixture now ${existing.chapters.length} chapters, ${total} events (${totMajor} major)`);
  } else {
    console.log(`  (dry run — pass --merge to write)`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
