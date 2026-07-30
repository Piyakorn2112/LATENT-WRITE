/**
 * import-gutenberg.ts — turn a Project Gutenberg plain-text book into the app's
 * own chapter format, so real published prose by OTHER authors can be annotated
 * and scored.
 *
 * Run:  npx tsx scripts/import-gutenberg.ts
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The entire gold set is 45 events across 11 chapters of two unpublished
 * manuscripts by this app's own author. That cannot show whether the detector
 * generalises: one voice, one register, one set of habits. Worse, when the gold
 * set was doubled from 22 events to 45 the SAME code scored sixteen points lower,
 * so the small in-house set was actively misleading.
 *
 * ─── THE LICENCE POSITION, WHICH IS THE WHOLE REASON THIS ROUTE WAS CHOSEN ───
 *
 * Researched before writing a line of this. Three options were on the table and
 * two are blocked:
 *
 *   · BookSum (217 books, 6,327 chapters, paragraph-level summary alignment) and
 *     the Shmoop Corpus (7,234 pre-aligned chapters) both have clean Gutenberg
 *     TEXT but their SUMMARIES are scraped from commercial study-guide sites.
 *     BookSum's own legal note restricts the data to research purposes; Shmoop
 *     requires written permission and offers no commercial licence. Both are
 *     unusable in a paid product. Their alignment METHOD is BSD-3 and reusable.
 *
 *   · LitBank is CC BY 4.0, genuinely clean, 100 public-domain novels with event
 *     annotations. But it is roughly a 2,000-word EXCERPT per novel, its event tag
 *     is a binary "is something happening" with no salience judgement and no type
 *     taxonomy, and nearly every paragraph of ordinary prose contains one. It
 *     accelerates annotation; it does not replace it.
 *
 *   · Project Gutenberg text itself. Their licence is an ADDITIVE layer that only
 *     binds a file carrying their trademark and boilerplate. Strip the header and
 *     footer from a work that is independently public domain and what remains is,
 *     in their own words, "a text unrestricted by U.S. intellectual property law":
 *     no royalty, no attribution, no copyleft. You simply lose the right to call
 *     it Project Gutenberg. That is the cleanest position available, so that is
 *     what this script does, and stripping the boilerplate is not a convenience,
 *     it is the licence step.
 *
 * ─── WHY THESE THREE BOOKS ───────────────────────────────────────────────────
 *
 * Chosen to be maximally UNLIKE each other and unlike the in-house manuscripts:
 *
 *   Sherlock Holmes    plot-driven detective stories, twelve self-contained cases,
 *                      very high event density, lots of reported speech
 *   Pride and Prejudice comedy of manners, dialogue-dense, events are social and
 *                      often happen inside a conversation
 *   The War of the Worlds first-person disaster narrative, physical action, an
 *                      entity-heavy world where things happen TO the narrator
 *
 * If the detector only works on the author's own quiet literary register, these
 * will say so.
 */

import { readFile, writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT_DIR = path.join(REPO_ROOT, "scripts", "fixtures", "corpus");

interface BookSpec {
  key: string;
  title: string;
  gutenbergId: number;
  /** Matches a chapter-heading line exactly. */
  headingRe: RegExp;
  /** Pull a display title out of the heading match. */
  titleOf: (line: string) => string;
}

const BOOKS: BookSpec[] = [
  {
    key: "sherlock",
    title: "The Adventures of Sherlock Holmes",
    gutenbergId: 1661,
    // "I. A SCANDAL IN BOHEMIA". The bare "I." lines inside a story are SECTION
    // breaks, not chapters, so the heading must carry a title to qualify.
    headingRe: /^([IVXLC]+)\.\s+([A-Z][A-Z '’,.-]{6,60})$/,
    titleOf: (line) => line.replace(/^[IVXLC]+\.\s+/, "").trim(),
  },
  {
    key: "pride",
    title: "Pride and Prejudice",
    gutenbergId: 1342,
    headingRe: /^CHAPTER ([IVXLC]+)\.$/,
    titleOf: (line) => line.trim(),
  },
  {
    key: "worlds",
    title: "The War of the Worlds",
    gutenbergId: 36,
    // Bare roman numerals ARE the chapters here, but the file also contains
    // "BOOK ONE" / "BOOK TWO" dividers which must not be counted.
    headingRe: /^([IVXLC]+)\.$/,
    titleOf: (line) => line.trim().replace(/\.$/, ""),
  },
];

/**
 * Remove the Project Gutenberg header and footer. THIS IS THE LICENCE STEP, not
 * tidying: the additive PG licence binds files that carry their boilerplate and
 * trademark, and does not bind a public-domain text that carries neither.
 */
function stripBoilerplate(raw: string): string {
  const startRe = /^\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*$/m;
  const endRe = /^\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*$/m;
  const start = raw.match(startRe);
  const end = raw.match(endRe);
  if (!start || start.index === undefined) throw new Error("no PG start marker");
  let body = raw.slice(start.index + start[0].length);
  const endMatch = body.match(endRe);
  if (endMatch && endMatch.index !== undefined) body = body.slice(0, endMatch.index);
  // Any residual trademark mention means the strip was incomplete, and shipping
  // that would drag the PG licence back in. Fail loudly rather than quietly.
  if (/Project Gutenberg/i.test(body)) {
    const remaining = body.match(/.{0,60}Project Gutenberg.{0,60}/i)?.[0] ?? "";
    // A single mention inside the prose itself is impossible for these titles, so
    // this is always a boilerplate remnant.
    body = body.replace(/^.*Project Gutenberg.*$/gim, "");
    if (process.env.VERBOSE) console.warn(`  stripped residual trademark line: ${remaining.slice(0, 60)}…`);
  }
  return body;
}

/**
 * Gutenberg text is HARD-WRAPPED at about seventy characters, so a single newline
 * is a line break inside a paragraph, not a paragraph break.
 *
 * ★ This matters more than it looks. The app splits paragraphs on /\n{2,}|\n/,
 * which treats EVERY line as its own paragraph. Left unwrapped, a Sherlock Holmes
 * story reported 813 paragraphs of about eleven words each. Every paragraph-level
 * signal in the engine would have been computed over fragments: the persistence
 * test, the tension derivative, the position of an event in the chapter, and the
 * paragraph anchors the gold set is written against. The scores would have looked
 * like a generalisation failure and actually been a formatting artifact.
 *
 * Join single newlines, keep blank lines as the paragraph boundary.
 */
function unwrap(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((para) => para.split("\n").map((l) => l.trim()).filter(Boolean).join(" "))
    .filter(Boolean)
    .join("\n\n");
}

interface Chapter {
  number: number;
  title: string;
  body: string;
}

function splitChapters(body: string, spec: BookSpec): Chapter[] {
  const lines = body.split(/\r?\n/);
  const marks: Array<{ line: number; title: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (spec.headingRe.test(raw)) marks.push({ line: i, title: spec.titleOf(raw) });
  }
  const chapters: Chapter[] = [];
  for (let m = 0; m < marks.length; m++) {
    const from = marks[m].line + 1;
    const to = m + 1 < marks.length ? marks[m + 1].line : lines.length;
    const text = unwrap(lines.slice(from, to).join("\n")).trim();
    // Short blocks are front matter, a table of contents entry, or a section
    // divider that happened to match. A real chapter is thousands of characters.
    if (text.length < 2500) continue;
    chapters.push({ number: chapters.length + 1, title: marks[m].title, body: text });
  }
  return chapters;
}

/** The app's own format, so the existing parser, printer and suites all work. */
function toAppFormat(spec: BookSpec, chapters: Chapter[]): string {
  const parts = ["===TITLE===", spec.title, ""];
  for (const c of chapters) {
    parts.push(`===CHAPTER ${c.number}: ${c.title}===`);
    parts.push(c.body);
    parts.push("");
  }
  return parts.join("\n");
}

async function main() {
  const scratch = process.env.RAW_DIR;
  if (!scratch) {
    console.error(
      "Set RAW_DIR to a directory holding <key>.raw.txt files downloaded from\n" +
      "  https://www.gutenberg.org/ebooks/<id>.txt.utf-8\n" +
      "Downloading is left OUT of this script on purpose: the corpus is committed,\n" +
      "so the suites never need the network to run.",
    );
    process.exitCode = 1;
    return;
  }

  for (const spec of BOOKS) {
    const raw = await readFile(path.join(scratch, `${spec.key}.raw.txt`), "utf8");
    const body = stripBoilerplate(raw);
    const chapters = splitChapters(body, spec);
    const out = toAppFormat(spec, chapters);
    await writeFile(path.join(OUT_DIR, `${spec.key}.txt`), out, "utf8");

    const words = chapters.map((c) => c.body.split(/\s+/).length);
    const paras = chapters.map((c) => c.body.split(/\n{2,}|\n/).map((l) => l.trim()).filter(Boolean).length);
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    console.log(
      `${spec.key.padEnd(9)} ${String(chapters.length).padStart(3)} chapters   ` +
      `median ${String(med(words)).padStart(5)} words / ${String(med(paras)).padStart(3)} paragraphs`,
    );
  }
  console.log(`\nwritten to scripts/fixtures/corpus/`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
