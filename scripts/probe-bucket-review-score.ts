/// <reference types="node" />

/**
 * probe-bucket-review-score.ts — replay the collected model answers through the
 * REAL review pass, apply them through the REAL acceptance bars, and score the
 * before and after against the same gold the deterministic harness uses.
 *
 * ★ THE REPLAY IS THE TRANSPORT, NOT THE LOGIC. `reviewEntities` runs for real
 *   here: it re-selects, re-builds the prompts, normalises the answers and
 *   applies the two overturn bars. Its `run` hook simply returns the answer
 *   already collected for that name instead of calling the model again. If a
 *   name it asks for is missing from the replay, that is a drift between this
 *   probe's selection and the module's, and it fails loudly rather than
 *   silently scoring a shorter list.
 */

import { readFile } from "fs/promises";
import { scanAndClassify } from "../src/lib/world-data";
import {
  reviewEntities,
  applyProposalsToScanResult,
  type EntityReviewEntry,
  type EntityType,
} from "../src/lib/entity-review";
import { ROOT_CROWN_GOLD, THIN_OCCURRENCE_FLOOR } from "./fixtures/root-crown-buckets";
import { splitBookChapters } from "./probe-bucket-review-prep";
import type { AdaptivePredictionTrace } from "../src/types";

const BOOK = "/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels/root-crown.txt";

interface Buckets { characters: string[]; places: string[]; factions: string[]; entities: string[] }

function score(scan: Buckets, text: string) {
  const got = new Map<string, string>();
  for (const n of scan.characters) got.set(n, "character");
  for (const n of scan.places) got.set(n, "place");
  for (const n of scan.factions) got.set(n, "faction");
  for (const n of scan.entities) got.set(n, "entity");

  const occurrences = (name: string) =>
    (text.match(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g")) ?? []).length;

  let correct = 0, wrong = 0, junk = 0, thinRight = 0, thinWrong = 0;
  for (const [name, label] of got) {
    const gold = ROOT_CROWN_GOLD[name];
    if (!gold) continue;
    const ok = gold.accept.includes(label as never);
    if (occurrences(name) < THIN_OCCURRENCE_FLOOR) { ok ? thinRight++ : thinWrong++; continue; }
    if (ok) correct++;
    else if (gold.accept.includes("drop")) junk++;
    else wrong++;
  }
  return { correct, wrong, junk, thinRight, thinWrong, total: got.size };
}

async function main() {
  const answersFile = process.argv[2];
  const answers = JSON.parse(await readFile(answersFile, "utf8")) as Record<string, unknown>;
  const raw = await readFile(BOOK, "utf8");
  const chapters = splitBookChapters(raw);
  const text = chapters.join("\n");

  const traceOut: { value: AdaptivePredictionTrace[] } = { value: [] };
  const scan = await scanAndClassify(chapters, undefined, 2, { predictionTraceOut: traceOut });
  const entries: EntityReviewEntry[] = traceOut.value.map((t) => ({
    name: t.spanText,
    currentType: t.predictedLabel as EntityType,
    needsReview: t.needsReview,
    ambiguityGap: t.ambiguityGap,
  }));

  const missing: string[] = [];
  const proposals = await reviewEntities(
    { entries, text },
    {
      run: async (req) => {
        if (!(req.tag in answers)) { missing.push(req.tag); return { ok: false as const, error: "no replay" }; }
        const json = answers[req.tag];
        return json ? { ok: true as const, json } : { ok: false as const, error: "model declined" };
      },
    },
  );

  const applied = applyProposalsToScanResult(scan, proposals);
  const before = score(scan, text);
  const after = score(applied.scan, text);

  const pct = (s: ReturnType<typeof score>) => {
    const n = s.correct + s.wrong;
    return n === 0 ? "—" : `${((s.correct / n) * 100).toFixed(1)}% (${s.correct}/${n})`;
  };

  const lines: string[] = [];
  lines.push(`  ${proposals.length} proposals, ${applied.changes.length} accepted`);
  for (const c of applied.changes) {
    const gold = ROOT_CROWN_GOLD[c.name];
    // The gold calls a deletion "drop"; the proposal calls it "not-a-name".
    const want = c.to === "not-a-name" ? "drop" : c.to;
    const verdict = !gold ? "?" : gold.accept.includes(want as never) ? "RIGHT" : "WRONG";
    lines.push(`    ${verdict.padEnd(5)} ${c.name.padEnd(28)} ${c.from} -> ${c.to}  ${c.confidence.toFixed(2)}  ${c.reason}`);
  }
  lines.push("");
  lines.push(`  gated accuracy   ${pct(before)}  ->  ${pct(after)}`);
  lines.push(`  junk names       ${before.junk}  ->  ${after.junk}`);
  lines.push(`  thin correct     ${before.thinRight}/${before.thinRight + before.thinWrong}  ->  ${after.thinRight}/${after.thinRight + after.thinWrong}`);
  lines.push(`  names total      ${before.total}  ->  ${after.total}`);
  if (missing.length) lines.push(`  ✗ DRIFT — ${missing.length} name(s) asked for but not replayed: ${missing.join(", ")}`);

  console.log(JSON.stringify({ lines }));
}

main().catch((err) => { console.error(err); process.exit(1); });
