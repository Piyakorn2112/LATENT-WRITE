/// <reference types="node" />

/**
 * bench-world-panel.ts — what does opening the World panel actually cost?
 *
 * ★ THE PANEL CANNOT PAINT UNTIL THIS FINISHES. WorldDataView's `aliasResult`
 *   is a `useMemo`, which means React runs it DURING RENDER, synchronously, on
 *   the main thread, before a single pixel of the overlay exists. Everything
 *   this file measures is time the writer spends looking at the old screen
 *   after clicking a button.
 *
 * ★★ AND IT RE-RUNS ON THE CAST, NOT ONCE. The memo's key is `castKey` — every
 *    character name and alias joined — so typing one letter into a Name field
 *    pays the whole bill again, and so does switching to the Characters tab.
 *    That is the "updating character info is slow" half of the report.
 *
 * ★ THE SHAPE IS THE POINT, NOT THE TOTAL. A single number on one book tells
 *   you nothing about a writer with eighty characters, so this sweeps the cast
 *   and prints cost per character. Flat = linear and fine. Climbing = the cost
 *   is super-linear and the book gets slower the more the writer works on it,
 *   which is the complaint.
 *
 * Run: ./node_modules/.bin/tsx scripts/bench-world-panel.ts
 *      ./node_modules/.bin/tsx scripts/bench-world-panel.ts --book root-crown
 */

import { readFile } from "fs/promises";
import { parseNovel } from "../src/lib/parser";
import type { Novel } from "../src/types";
import {
  ensureWorldData,
  resolveSpeakerCandidates,
  extractNameCandidatesFast,
} from "../src/lib/world-data";
import { proposeAliases } from "../src/lib/alias-propose";

const NOVELS_DIR = "/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels";

const BOOKS: Record<string, string> = {
  "hollow-iris": `${NOVELS_DIR}/hollow-iris.txt`,
  "root-crown": `${NOVELS_DIR}/root-crown.txt`,
};

const arg = (flag: string, fallback: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const bookKey = arg("--book", "hollow-iris");

/** Wall clock around one thunk, in ms, to one decimal. */
function timed<T>(fn: () => T): { ms: number; value: T } {
  const t0 = performance.now();
  const value = fn();
  return { ms: performance.now() - t0, value };
}

/**
 * The cast a writer would actually have at size N.
 *
 * ★ REAL NAMES OUT OF THE BOOK, not `Character 1..N`. Synthetic names match no
 *   morphology rule, hit nothing in the text, and would make every full-text
 *   scan return immediately — a benchmark that measures the fast path only and
 *   reports the feature as free. The extracted list is also literally what the
 *   scan hands the writer to register, so this is the real distribution.
 */
function castOfSize(novel: Novel, n: number): { name: string; aliases: string[] }[] {
  const names = extractNameCandidatesFast(novel, 2, Math.max(n, 200));
  return names.slice(0, n).map((name) => ({ name, aliases: [] }));
}

/**
 * ★★ THE PANEL ALWAYS RUNS THE worldData PATH, AND THE FIRST DRAFT OF THIS
 *    BENCH DID NOT. `parseNovel` on a bare .txt leaves worldData empty, which
 *    sends resolveEntityNameMap down its cold-start branch — a FIXED ~30-name
 *    extraction that costs the same whether the writer has five characters or
 *    eighty. It measured 6.6s flat and made the cast look irrelevant.
 *
 *    A writer who opens this panel has a cast, so resolveKnownNames returns
 *    THEIR names and filterSpeakerCandidates scans the book once per name.
 *    That is the scenario in the report, and it is the one that scales.
 */
function novelWithCast(novel: Novel, cast: { name: string; aliases: string[] }[]): Novel {
  return {
    ...novel,
    worldData: {
      characters: cast.map((c) => ({ ...c, role: "", description: "" })),
      places: [], factions: [], entities: [],
    },
  } as Novel;
}

async function main() {
  const file = BOOKS[bookKey];
  if (!file) {
    console.error(`Unknown book "${bookKey}". Known: ${Object.keys(BOOKS).join(", ")}`);
    process.exit(1);
  }
  const raw = await readFile(file, "utf8");
  const novel = parseNovel(raw);
  const bookChars = novel.chapters.reduce((n, c) => n + c.content.length, 0);

  console.log(`\n${"═".repeat(78)}`);
  console.log(`WORLD PANEL OPEN COST — ${bookKey}`);
  console.log(`${(bookChars / 1000).toFixed(0)}k characters · ${novel.chapters.length} chapters`);
  console.log(`${"═".repeat(78)}\n`);

  // ── Stage breakdown at the real cast size ─────────────────────────────────
  const realWorld = ensureWorldData(novel);
  const realCast = realWorld.characters.length > 0
    ? realWorld.characters.map((c) => ({ name: c.name, aliases: [...(c.aliases ?? [])] }))
    : castOfSize(novel, 23);
  const realNovel = novelWithCast(novel, realCast);

  console.log(`STAGE BREAKDOWN — cast of ${realCast.length}\n`);

  const joinT = timed(() => novel.chapters.map((c) => c.content).join("\n"));
  console.log(`  join chapters into one string      ${joinT.ms.toFixed(1).padStart(8)} ms`);

  const speakersT = timed(() => resolveSpeakerCandidates(realNovel));
  console.log(`  resolveSpeakerCandidates           ${speakersT.ms.toFixed(1).padStart(8)} ms   -> ${speakersT.value.length} names`);

  const fastT = timed(() => extractNameCandidatesFast(novel, 3, 60));
  console.log(`  extractNameCandidatesFast          ${fastT.ms.toFixed(1).padStart(8)} ms   -> ${fastT.value.length} names`);

  const candidates = [...new Set([...speakersT.value, ...fastT.value])];
  const proposeT = timed(() => proposeAliases(realCast, candidates, joinT.value));
  console.log(`  proposeAliases                     ${proposeT.ms.toFixed(1).padStart(8)} ms   -> ${proposeT.value.proposals.length} proposals, ${proposeT.value.rejected.length} vetoed`);

  const total = joinT.ms + speakersT.ms + fastT.ms + proposeT.ms;
  console.log(`  ${"─".repeat(52)}`);
  console.log(`  TOTAL BLOCKING THE PANEL           ${total.toFixed(1).padStart(8)} ms\n`);

  // ── The scaling sweep ─────────────────────────────────────────────────────
  //
  // The question the report asks: does eighty characters cost four times
  // twenty, or sixteen times? Cost-per-character is the column that answers it.
  console.log(`SCALING — how the cast size moves the bill\n`);
  console.log(`  cast     join   speakers    fast   propose     TOTAL    per char`);
  console.log(`  ${"─".repeat(70)}`);

  const sizes = [5, 10, 20, 40, 80, 160];
  const rows: { n: number; total: number }[] = [];
  for (const n of sizes) {
    const cast = castOfSize(novel, n);
    if (cast.length < n) continue;

    const staged = novelWithCast(novel, cast);
    const j = timed(() => novel.chapters.map((c) => c.content).join("\n"));
    const s = timed(() => resolveSpeakerCandidates(staged));
    const f = timed(() => extractNameCandidatesFast(novel, 3, 60));
    const cands = [...new Set([...s.value, ...f.value])];
    const p = timed(() => proposeAliases(cast, cands, j.value));
    const t = j.ms + s.ms + f.ms + p.ms;
    rows.push({ n, total: t });

    console.log(
      `  ${String(n).padStart(4)}  ${j.ms.toFixed(0).padStart(7)}  ${s.ms.toFixed(0).padStart(9)}  `
      + `${f.ms.toFixed(0).padStart(6)}  ${p.ms.toFixed(0).padStart(8)}  ${t.toFixed(0).padStart(8)}  `
      + `${(t / n).toFixed(1).padStart(9)}`,
    );
  }

  // Growth exponent: total ~ n^k. k≈1 is linear, k≈2 is quadratic.
  if (rows.length >= 2) {
    const a = rows[0], b = rows[rows.length - 1];
    const k = Math.log(b.total / a.total) / Math.log(b.n / a.n);
    console.log(`\n  growth exponent over ${a.n} -> ${b.n} characters: n^${k.toFixed(2)}`);
    console.log(`  (1.0 = linear · 2.0 = quadratic · <0.3 = dominated by fixed cost)`);
  }
  console.log("");
}

main().catch((err) => { console.error(err); process.exit(1); });
