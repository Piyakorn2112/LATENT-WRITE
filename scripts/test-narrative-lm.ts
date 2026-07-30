/**
 * test-narrative-lm.ts — the LM path, actually tested.
 *
 * Run:  npx tsx scripts/test-narrative-lm.ts      (exit 1 on failure)
 *
 * ─── WHY THIS FILE IS THE MOST IMPORTANT REGRESSION LOCK IN scripts/ ─────────
 *
 * Until it existed, NO test had ever executed a single embedding.
 *
 * `@xenova/transformers` v2 statically imports `sharp`, whose native binary is
 * not built in this pnpm store. Electron's main process installs a `Module._load`
 * stub for it; no script did. So importing `src/lib/narrative-lm.ts` under `tsx`
 * threw at import time — and `enrichChapterEntryWithLM` wraps the entire LM pass
 * in `catch { return entry }`.
 *
 * The consequence was a number that looked like a result:
 *
 *     relabeled events: 0/6 (0%)
 *
 * read for months as "the LM agrees with the dictionary". It meant "the LM was
 * never loaded". Nothing logged. Nothing failed. The engine's whole semantic
 * layer was dead and every dashboard said it was fine.
 *
 * So the FIRST assertion here is a hard gate on the backend actually loading, and
 * it must never be softened into a skip. A suite that quietly passes when the
 * model is missing reproduces the original bug in a new place.
 *
 * ─── WHAT ELSE IT MEASURES ───────────────────────────────────────────────────
 *
 * Whether anchor-cosine classification WORKS, against the same gold clauses the
 * event suite uses, and how much each half of the calibration is worth. The
 * received wisdom that "embedding similarity is weak" is not well supported —
 * modern sentence embeddings beat NLI zero-shot on most datasets in published
 * comparisons. The narrower, better-supported diagnosis is one hand-written
 * anchor per class and no calibration. This suite prints all three variants side
 * by side so that stays a measurement rather than an opinion.
 */

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { installNodeEmbedder, reportBackend } from "./lm-node-backend";
import {
  classifyNarrativeType,
  hasEmbedder,
  semanticSimilarity,
  type NarrativeTypeName,
} from "../src/lib/narrative-lm";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

let passed = 0;
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
};

/** Type accuracy target. Deliberately modest: a trained-literary-scholar event
 *  typology reached Krippendorff's α of only 0.57–0.75 on a COARSER scheme than
 *  this eight-way one, so ceiling agreement here is well under 100%. This gates
 *  against the classifier silently degrading, not against imperfection. */
const TYPE_ACCURACY_TARGET = 0.4;
/** A paraphrase must beat an unrelated sentence by at least this much, or the
 *  embedding space is not carrying usable signal for dedup. */
const DISCRIMINATION_MARGIN = 0.15;

interface GoldEvent { type: string; evidence: string; summary: string }
interface Gold { chapters: Array<{ book: string; chapter: number; events: GoldEvent[] }> }

async function main() {
  console.log("\n══ The backend loads (HARD GATE — never soften this) ══");
  const info = await installNodeEmbedder();
  reportBackend(info);
  ok(info !== null, "a MiniLM model is present in public/models and loaded");
  ok(hasEmbedder(), "hasEmbedder() reports a reachable backend");
  if (!info) {
    console.error(
      "\nNo embedding backend. Everything below would be vacuous, so the suite stops here.\n" +
      "This is the failure that hid for months behind a bare catch. It must be loud.",
    );
    process.exitCode = 1;
    return;
  }
  ok(info.loadMs < 5000, `model loads in under 5s (${info.loadMs}ms)`);

  console.log("\n══ Embeddings behave like embeddings ══");
  {
    const a = await semanticSimilarity("She refused to sign.", "She refused to sign.");
    ok(a > 0.999, `a sentence is identical to itself (${a.toFixed(4)})`);
    const b = await semanticSimilarity("She refused to sign.", "She refused to sign.");
    ok(Math.abs(a - b) < 1e-6, "the same pair scores identically twice (deterministic)");
  }

  console.log("\n══ Similarity discriminates (this is what dedup relies on) ══");
  {
    const pairs: Array<[string, string, string]> = [
      ["She refused to sign the record.", "She would not put her name to the document.", "refusal"],
      ["Tessa admitted she had known for years.", "Tessa confessed to a long silence.", "admission"],
      ["The ship departed its orbit.", "The vessel left orbit that morning.", "departure"],
      ["He signed the transfer order.", "He put his signature on the transfer.", "signing"],
    ];
    const unrelated = "The kerosene lamp on the window ledge burned steadily.";
    let worst = 1;
    for (const [x, y, name] of pairs) {
      const near = await semanticSimilarity(x, y);
      const far = await semanticSimilarity(x, unrelated);
      const margin = near - far;
      worst = Math.min(worst, margin);
      ok(margin >= DISCRIMINATION_MARGIN,
        `${name}: paraphrase ${near.toFixed(2)} beats unrelated ${far.toFixed(2)} by ${margin.toFixed(2)}`);
    }
    console.log(`    smallest margin across the set: ${worst.toFixed(3)}`);
  }

  console.log("\n══ The dedup threshold is in the right place ══");
  {
    // story-graph.ts drops one of two events whose labels score above 0.72.
    const dupe = await semanticSimilarity("Helia writes audit report", "Helia writes the audit report");
    const distinct = await semanticSimilarity("Helia writes audit report", "Nora returns bathroom");
    ok(dupe > 0.72, `a near-duplicate label clears 0.72 (${dupe.toFixed(2)})`);
    ok(distinct < 0.72, `two different events stay below 0.72 (${distinct.toFixed(2)})`);
  }

  console.log("\n══ Type classification, measured against the gold clauses ══");
  {
    const gold: Gold = JSON.parse(
      await readFile(path.join(REPO_ROOT, "scripts", "fixtures", "event-gold.json"), "utf8"),
    );
    const cases = gold.chapters.flatMap((c) =>
      c.events
        .filter((e) => e.type !== "shift") // no gold examples of `shift` yet
        .map((e) => ({ clause: e.evidence, expected: e.type as NarrativeTypeName, summary: e.summary })),
    );
    ok(cases.length >= 15, `${cases.length} labelled clauses available from the gold set`);

    // Three variants, so the value of each half of the calibration is visible.
    const variants: Array<[string, { calibrate: boolean; singleAnchor: boolean }]> = [
      ["single anchor, uncalibrated (the old shape)", { calibrate: false, singleAnchor: true }],
      ["five anchors, uncalibrated", { calibrate: false, singleAnchor: false }],
      ["five anchors + null calibration", { calibrate: true, singleAnchor: false }],
    ];

    const results: Array<{ name: string; acc: number; top2: number }> = [];
    for (const [name, opts] of variants) {
      let correct = 0;
      let inTop2 = 0;
      const confusion: string[] = [];
      for (const c of cases) {
        const p = await classifyNarrativeType(c.clause, opts);
        if (!p) continue;
        if (p.type === c.expected) correct++;
        else if (p.ranked[1]?.type === c.expected) { inTop2++; confusion.push(`${c.expected}→${p.type}`); }
        else confusion.push(`${c.expected}→${p.type}`);
      }
      const acc = correct / cases.length;
      const top2 = (correct + inTop2) / cases.length;
      results.push({ name, acc, top2 });
      console.log(`    ${name.padEnd(44)} top-1 ${(acc * 100).toFixed(1).padStart(5)}%   top-2 ${(top2 * 100).toFixed(1).padStart(5)}%`);
      if (opts.calibrate && !opts.singleAnchor) {
        const counts = new Map<string, number>();
        for (const c of confusion) counts.set(c, (counts.get(c) ?? 0) + 1);
        const worst = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5);
        console.log(`      most common confusions: ${worst.map(([k, v]) => `${k} ×${v}`).join(", ")}`);
      }
    }

    // ★ Gate on the SHIPPED configuration, which is five anchors UNCALIBRATED.
    // This used to gate on the calibrated variant, and once `calibrate` was
    // defaulted to false that became a gate on code nobody runs: the suite went
    // red while the shipped path was fine. Exactly the mistake already fixed in
    // test-event-detect.ts, made again one file over. A suite must measure what
    // ships.
    const shipped = results[1];
    const baseline = results[0];
    ok(shipped.acc >= TYPE_ACCURACY_TARGET,
      `shipped top-1 accuracy ${(shipped.acc * 100).toFixed(1)}% meets the ${(TYPE_ACCURACY_TARGET * 100).toFixed(0)}% floor`);
    // Calibration is measured every run and reported, never gated. On 44 clauses
    // from one author it cost 2 points; on 64 clauses from four authors it costs
    // 8. Consistently negative, which is why the default is off.
    const calibrated = results[2];
    console.log(`    null calibration is worth ${((calibrated.acc - shipped.acc) * 100).toFixed(1)} points — it is OFF by default for this reason`);
    // Not a pass/fail — the honest question is whether the extra work earns
    // anything, and the answer belongs in the log either way.
    const delta = (shipped.acc - baseline.acc) * 100;
    console.log(`    calibration + multi-anchor is worth ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} points over the old shape`);
  }

  console.log("\n══ Performance budget ══");
  {
    // A p90 chapter is ~99 paragraphs / ~270 sentences. Detection is per-clause,
    // so a per-embed cost above a few ms makes a whole-chapter LM pass untenable
    // on a weak machine — which is the constraint that rules out a generative
    // model here for now.
    const clause = "She refused the contract and walked out of the Assembly hall.";
    const t0 = Date.now();
    const N = 40;
    for (let i = 0; i < N; i++) await semanticSimilarity(`${clause} ${i}`, "A character refuses.");
    const per = (Date.now() - t0) / N;
    console.log(`    ${per.toFixed(1)}ms per embed (cold cache, ${N} distinct inputs)`);
    ok(per < 60, `per-embed cost stays under 60ms (${per.toFixed(1)}ms)`);
    const budget = per * 270;
    console.log(`    a p90 chapter (270 sentences) would cost ~${(budget / 1000).toFixed(1)}s of embedding`);
  }

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(`narrative-lm: ${passed}/${passed + failed}`);
  console.log("════════════════════════════════════════════════════════════\n");
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
