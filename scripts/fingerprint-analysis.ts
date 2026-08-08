/**
 * fingerprint-analysis.ts — a byte-exact signature of what the analysis
 * pipeline produces across the corpus.
 *
 * ★ THIS EXISTS SO "TIDY-UP" CAN BE PROVEN, NOT ASSERTED. A refactor that is
 *   supposed to change nothing must produce an IDENTICAL hash. Accuracy
 *   suites tell you the score did not move; they do not tell you the output
 *   did not move, and a cleanup that trades two errors for two different
 *   errors keeps the score and breaks a book.
 *
 * Covers every consumer-visible field of a chapter analysis: speech segments
 * (span, type, speaker, confidence), action predictions (span, actor),
 * narrative events, pronoun owners and the chapter stats the timeline reads.
 *
 *   ./node_modules/.bin/tsx scripts/fingerprint-analysis.ts            # print
 *   ./node_modules/.bin/tsx scripts/fingerprint-analysis.ts --save     # baseline
 *   ./node_modules/.bin/tsx scripts/fingerprint-analysis.ts --check    # compare
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadBook } from "./print-chapter";
import { resolveKnownNames } from "../src/lib/world-data";
import { runChapterAnalysis } from "../src/lib/chapter-analysis-runner";
import type { ChapterEndContext } from "../src/lib/speech-detect";

const BOOKS = ["pride", "sherlock", "expectations", "anne", "gatsby", "webnovel", "treasure"];
const LEVELS = ["fast", "default", "high"] as const;
const BASELINE = join(process.cwd(), "scripts", "fixtures", "analysis-fingerprint.json");

/** Everything a consumer can see, flattened deterministically. */
function signatureFor(book: string, level: (typeof LEVELS)[number], novel: Awaited<ReturnType<typeof loadBook>>, names: string[]) {
  const lines: string[] = [];
  let prev: ChapterEndContext | null = null;
  for (const [ci, chapter] of novel.chapters.entries()) {
    const r = runChapterAnalysis({
      chapter, prevContext: prev, siblingStats: [], knownNames: names,
      level, worldData: novel.worldData, collectPredictionDetails: true,
    });
    prev = r.endContext;
    r.speechResults.forEach((para, pi) => {
      para?.segments.forEach((s) => {
        lines.push(`S|${ci}|${pi}|${s.start}|${s.end}|${s.type}|${s.speaker ?? ""}|${(s.confidence ?? 0).toFixed(4)}`);
      });
    });
    r.actionPredictions.forEach((preds, pi) => {
      preds.forEach((a) => {
        lines.push(`A|${ci}|${pi}|${a.start}|${a.end}|${a.actor ?? ""}|${a.confidence.toFixed(4)}|${a.needsReview ? 1 : 0}`);
      });
    });
    for (const e of r.narrativeEvents ?? []) {
      lines.push(`E|${ci}|${e.paragraphIndex ?? ""}|${e.label ?? ""}|${(e.sentence ?? "").slice(0, 60)}`);
    }
    r.pronounOwners?.forEach((owners, pi) => {
      owners?.forEach((o) => lines.push(`P|${ci}|${pi}|${o.start}|${o.end}|${o.name ?? ""}`));
    });
    const an = r.analysis as unknown as Record<string, unknown>;
    for (const key of Object.keys(an).sort()) {
      const v = an[key];
      if (typeof v === "number") lines.push(`N|${ci}|${key}|${v.toFixed(4)}`);
      else if (typeof v === "string") lines.push(`T|${ci}|${key}|${v}`);
    }
  }
  return lines;
}

async function main() {
  const mode = process.argv[2] ?? "--print";
  const out: Record<string, { hash: string; lines: number }> = {};
  const detail: Record<string, string[]> = {};

  for (const key of BOOKS) {
    let novel;
    try { novel = await loadBook(key); } catch { console.log(`  ${key}: unavailable, skipped`); continue; }
    const names = resolveKnownNames(novel);
    for (const level of LEVELS) {
      const lines = signatureFor(key, level, novel, names);
      const hash = createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
      out[`${key}/${level}`] = { hash, lines: lines.length };
      detail[`${key}/${level}`] = lines;
    }
  }

  if (mode === "--save") {
    writeFileSync(BASELINE, JSON.stringify(out, null, 1));
    console.log(`baseline written: ${Object.keys(out).length} signatures → ${BASELINE}`);
    for (const [k, v] of Object.entries(out)) console.log(`  ${k.padEnd(24)} ${v.hash}  ${v.lines} facts`);
    return;
  }

  if (mode === "--check") {
    if (!existsSync(BASELINE)) { console.error("no baseline; run --save first"); process.exit(1); }
    const base = JSON.parse(readFileSync(BASELINE, "utf8")) as typeof out;
    let bad = 0;
    for (const k of new Set([...Object.keys(base), ...Object.keys(out)])) {
      const b = base[k], n = out[k];
      if (!b || !n) { console.log(`  ✗ ${k.padEnd(24)} ${!b ? "NEW" : "MISSING"}`); bad++; continue; }
      if (b.hash !== n.hash) {
        bad++;
        console.log(`  ✗ ${k.padEnd(24)} ${b.hash} → ${n.hash}  (${b.lines} → ${n.lines} facts)`);
        // Show the first few differing facts so a drift is diagnosable, not just red.
        const now = detail[k];
        console.log(`      first differences need the old run; fact count delta ${n.lines - b.lines}`);
        void now;
      } else {
        console.log(`  ✓ ${k.padEnd(24)} ${n.hash}  ${n.lines} facts`);
      }
    }
    console.log(`\n${bad === 0 ? "IDENTICAL — behaviour preserved" : `${bad} SIGNATURE(S) CHANGED`}`);
    if (bad) process.exit(1);
    return;
  }

  for (const [k, v] of Object.entries(out)) console.log(`  ${k.padEnd(24)} ${v.hash}  ${v.lines} facts`);
}

main().catch((e) => { console.error(e); process.exit(1); });
