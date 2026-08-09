/// <reference types="node" />

/**
 * test-name-usage-scan.ts — the fast name-usage scan must answer EXACTLY what
 * the slow one did.
 *
 * ★ WHY THIS EXISTS. `determinerUsage` and `filterSpeakerCandidates` used a
 *   regex that CAPTURED the four characters in front of every name:
 *   `(.{0,4})(?<!\p{L})NAME(?!\p{L})`. A leading unanchored capture cannot use
 *   V8's literal-prefix search, so the engine attempts a match at every
 *   position in the book instead of jumping to the name. Measured on
 *   hollow-iris (3.37M chars): a flat 107ms per name whether the name occurs
 *   3074 times or ZERO times — and the zero case is the proof, because a
 *   scanner that skipped would return almost immediately. Slicing the prefix by
 *   index instead is 30.8x faster.
 *
 * ★★ AND THE OBVIOUS REWRITE IS WRONG, WHICH IS THE WHOLE REASON FOR A
 *    DIFFERENTIAL GATE. `.` does not match a newline, so `(.{0,4})` silently
 *    stops at a line break: for "…the\nAssembly" the OLD scanner captured ""
 *    and counted the name as bare. `text.slice(i - 4, i)` happily returns
 *    "the\n", the determiner test fires, and every hard-wrapped Gutenberg book
 *    shifts its determiner ratios — which is the threshold that decides who is
 *    allowed to speak. A 30x speedup that quietly re-labels the cast is not a
 *    speedup.
 *
 *    The reference implementation below is the OLD code verbatim. This is a
 *    differential loop, not a hand-written expectation: hand-written numbers
 *    would encode what I BELIEVED the old scanner did, and the newline case is
 *    precisely where that belief was wrong.
 *
 * Run: ./node_modules/.bin/tsx scripts/test-name-usage-scan.ts
 */

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { parseNovel } from "../src/lib/parser";
import {
  determinerUsage,
  filterSpeakerCandidates,
  extractNameCandidatesFast,
} from "../src/lib/world-data";
import { surnameSharedByFamily } from "../src/lib/alias-propose";

// ── The reference: the shipped implementation before the fix, verbatim ──────

const escapeForRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
const WORD_BEFORE = "(?<![\\p{L}\\p{N}_])";
const WORD_AFTER = "(?![\\p{L}\\p{N}_])";
const DETERMINER_BEFORE_RE = /\b(?:the|a|an)\s$/i;
const MAX_DETERMINER_RATIO = 0.10;

function refNamePrefixRe(name: string): RegExp {
  return new RegExp(`(.{0,4})${WORD_BEFORE}${escapeForRe(name)}${WORD_AFTER}`, "gu");
}

function refDeterminerUsage(text: string, name: string): { occurrences: number; ratio: number } {
  const re = refNamePrefixRe(name);
  let occurrences = 0;
  let determined = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    occurrences++;
    if (DETERMINER_BEFORE_RE.test(m[1])) determined++;
  }
  return { occurrences, ratio: occurrences === 0 ? 0 : determined / occurrences };
}

function refFilterSpeakerCandidates(names: readonly string[], text: string): string[] {
  if (!text) return [...names];
  return names.filter((name) => {
    const re = refNamePrefixRe(name);
    let occ = 0;
    let determined = 0;
    let bracketed = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      occ++;
      if (DETERMINER_BEFORE_RE.test(m[1])) determined++;
      if (/\[\s*$/.test(m[1])) bracketed++;
    }
    if (occ === 0) return true;
    if (bracketed / occ >= 0.5) return false;
    return determined / occ < MAX_DETERMINER_RATIO;
  });
}

/**
 * The second rewrite, and the one with real teeth: this decides whether a
 * surname belongs to a FAMILY, which is the rule that stops a sister being
 * merged into her brother. Getting it "nearly right" would silently merge
 * people.
 */
const REF_LB = "(?<![A-Za-z0-9])";
const REF_RB = "(?![A-Za-z0-9])";
const REF_MALE = ["mr", "sir", "lord", "master", "father", "brother", "uncle", "king", "prince", "duke", "baron", "count"];
const REF_FEMALE = ["mrs", "ms", "miss", "lady", "madam", "madame", "mademoiselle", "mother", "sister", "aunt", "queen", "princess", "duchess", "countess", "dame"];

function refSurnameSharedByFamily(text: string, bare: string): boolean {
  if (!bare || bare.includes(" ")) return false;
  const n = escapeForRe(bare);
  const has = (titles: readonly string[]) =>
    new RegExp(`${REF_LB}(?:${titles.join("|")})\\.?\\s+${n}${REF_RB}`, "i").test(text);
  return has(REF_MALE) && has(REF_FEMALE);
}

// ── Books ───────────────────────────────────────────────────────────────────

const NOVELS_DIR = "/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels";
const CORPUS_DIR = path.resolve(fileURLToPath(new URL("./fixtures/corpus/", import.meta.url)));

/** Hard-wrapped Gutenberg books FIRST — they carry the newline case. */
const BOOKS: Array<{ key: string; file: string }> = [
  { key: "pride",       file: path.join(CORPUS_DIR, "pride.txt") },
  { key: "dracula",     file: path.join(CORPUS_DIR, "dracula.txt") },
  { key: "antonia",     file: path.join(CORPUS_DIR, "antonia.txt") },
  { key: "awakening",   file: path.join(CORPUS_DIR, "awakening.txt") },
  { key: "expectations", file: path.join(CORPUS_DIR, "expectations.txt") },
  { key: "root-crown",  file: path.join(NOVELS_DIR, "root-crown.txt") },
  { key: "hollow-iris", file: path.join(NOVELS_DIR, "hollow-iris.txt") },
];

/**
 * Names that are not in any extraction but must still scan identically.
 * Accented, apostrophe, hyphen, regex metacharacter, multi-word, and one that
 * cannot occur at all — the zero-occurrence case is what proved the old
 * scanner never skipped.
 */
const EDGE_NAMES = [
  "Ántonia", "Alcée", "O'Brien", "Jean-Luc", "St. John", "Mrs. Bennet",
  "Quincey Morris", "A.", "Zzyzx Nevermore", "the", "The Assembly",
];

let failures = 0;
const fail = (msg: string) => { failures++; console.log(`  ✗ ${msg}`); };

async function main() {
  console.log(`\n${"═".repeat(78)}`);
  console.log("NAME-USAGE SCAN — fast path vs the implementation it replaced");
  console.log(`${"═".repeat(78)}\n`);

  let checked = 0;
  let refMs = 0;
  let newMs = 0;

  for (const { key, file } of BOOKS) {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      console.log(`  – ${key}: not on disk, skipped`);
      continue;
    }
    const novel = parseNovel(raw);
    const text = novel.chapters.map((c) => c.content).join("\n");
    const wrapped = /[^\n]{1,80}\n[^\n]/.test(text.slice(0, 200_000));

    // A wide, unhand-picked name set plus the edge cases.
    const names = [...new Set([...extractNameCandidatesFast(novel, 2, 120), ...EDGE_NAMES])];

    let mismatched = 0;
    for (const name of names) {
      const t0 = performance.now();
      const ref = refDeterminerUsage(text, name);
      refMs += performance.now() - t0;
      const t1 = performance.now();
      const got = determinerUsage(text, name);
      newMs += performance.now() - t1;
      checked++;

      if (ref.occurrences !== got.occurrences || Math.abs(ref.ratio - got.ratio) > 1e-12) {
        mismatched++;
        if (mismatched <= 3) {
          fail(
            `${key} · determinerUsage("${name}") — reference {occ ${ref.occurrences}, ratio ${ref.ratio.toFixed(4)}} `
            + `vs shipped {occ ${got.occurrences}, ratio ${got.ratio.toFixed(4)}}`,
          );
        }
      }
    }
    if (mismatched > 3) fail(`${key} · ${mismatched - 3} further determinerUsage mismatches not shown`);

    // The filter is the decision the ratio feeds; compare the SET, because
    // that is what speech attribution actually consumes.
    const refKept = refFilterSpeakerCandidates(names, text);
    const gotKept = filterSpeakerCandidates(names, text);
    const refSet = new Set(refKept);
    const gotSet = new Set(gotKept);
    const onlyRef = refKept.filter((n) => !gotSet.has(n));
    const onlyGot = gotKept.filter((n) => !refSet.has(n));
    if (onlyRef.length || onlyGot.length) {
      fail(
        `${key} · filterSpeakerCandidates disagrees — dropped by shipped only: [${onlyRef.slice(0, 6).join(", ")}] · `
        + `kept by shipped only: [${onlyGot.slice(0, 6).join(", ")}]`,
      );
    }

    // ── surnameSharedByFamily, same books, same names ──────────────────────
    let famMismatch = 0;
    let famTrue = 0;
    for (const name of names) {
      const t0 = performance.now();
      const ref = refSurnameSharedByFamily(text, name);
      refMs += performance.now() - t0;
      const t1 = performance.now();
      const got = surnameSharedByFamily(text, name);
      newMs += performance.now() - t1;
      if (ref) famTrue++;
      if (ref !== got) {
        famMismatch++;
        if (famMismatch <= 3) {
          fail(`${key} · surnameSharedByFamily("${name}") — reference ${ref}, shipped ${got}`);
        }
      }
    }
    if (famMismatch > 3) fail(`${key} · ${famMismatch - 3} further surname mismatches not shown`);

    const status = mismatched === 0 && famMismatch === 0 && !onlyRef.length && !onlyGot.length ? "✓" : "✗";
    console.log(
      `  ${status} ${key.padEnd(13)} ${String(names.length).padStart(4)} names · `
      + `${(text.length / 1000).toFixed(0).padStart(5)}k chars · ${wrapped ? "hard-wrapped" : "soft-wrapped"} · `
      + `${refKept.length} speakers · ${famTrue} family surnames`,
    );
  }

  console.log(`\n  ${checked} name scans compared`);
  console.log(`  reference ${(refMs / 1000).toFixed(2)}s · shipped ${(newMs / 1000).toFixed(2)}s · `
    + `${(refMs / Math.max(newMs, 0.001)).toFixed(1)}x faster`);

  // ── A directed test for the case the differential exists to protect ──────
  //
  // Stated as its own assertion so the rule survives even if every book on
  // disk happens to be soft-wrapped.
  const wrappedText = "He crossed to the\nAssembly and waited. The Assembly said nothing.";
  const refWrapped = refDeterminerUsage(wrappedText, "Assembly");
  const gotWrapped = determinerUsage(wrappedText, "Assembly");
  if (refWrapped.occurrences !== gotWrapped.occurrences || refWrapped.ratio !== gotWrapped.ratio) {
    fail(
      `line-break prefix — "the\\nAssembly" must NOT count as determined `
      + `(reference ${refWrapped.ratio.toFixed(4)}, shipped ${gotWrapped.ratio.toFixed(4)})`,
    );
  } else {
    console.log(`  ✓ line-break prefix — "the\\nAssembly" reads ${gotWrapped.ratio.toFixed(2)} in both`);
  }

  console.log("");
  if (failures > 0) {
    console.log(`FAILED — ${failures} disagreement${failures === 1 ? "" : "s"} with the reference implementation.\n`);
    process.exit(1);
  }
  console.log("PASS — the fast scan is indistinguishable from the one it replaced.\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
