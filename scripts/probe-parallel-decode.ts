/**
 * probe-parallel-decode.ts — the throughput breakthrough: N sequences of ONE
 * context decode their tokens in ONE batched GPU pass.
 *
 * Per-call decode is at the binding's floor (tuple wire + compact grammar +
 * no-think + flash; both speculative families measured dead). What remains
 * is THROUGHPUT: llama.cpp's KV cache is a shared pool, and concurrent
 * sequences batch through the GPU together. This measures 4 chip requests
 * run sequentially vs concurrently on sequences of one context, and checks
 * the concurrent outputs are IDENTICAL to the sequential ones (temp 0).
 *
 * Run: ./node_modules/.bin/tsx scripts/probe-parallel-decode.ts
 *
 * ★★ VERDICT (measured 2026-08-07): REFUTED on this binding/hardware.
 *    sequential 4 chips 28.6s vs parallel 29.6s — node-llama-cpp does not
 *    deliver batched-decode throughput here (streams effectively serialize;
 *    JS-side token loops + grammar sampling are single-threaded), and
 *    parallel outputs DIFFER from sequential (batched attention reorders
 *    float math, so temp-0 determinism is lost too). Do not re-attempt
 *    without a binding-level change. The probe also showed the real
 *    per-chapter cost: ~1s prefill of NEW userText per chapter — which is
 *    what batchSize (per-tier) and call-merging actually address.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { getLlama, LlamaChatSession } from "node-llama-cpp";
import { buildChipRequest } from "../src/lib/chip-picker";
import { buildSummaryRequest } from "../src/lib/chapter-summary";
import fixture from "./fixtures/assistant-tasks.json";
import type { ChapterGraphEntry } from "../src/types";

const MODEL = path.join(os.homedir(), "Library/Application Support/Latent Write/models/Qwen3-4B-Thinking-2507-Q4_K_M.gguf");

const strong = (fixture as { timelineChips: Array<Record<string, unknown>> }).timelineChips
  .find((c) => c.id === "strong")! as {
    chapterNumber: number; chapterTitle: string; cast: string[];
    candidates: Array<{ rank: number; label: string; sentence: string; agent?: string }>;
  };

function mkEntry(seed: number): ChapterGraphEntry {
  const rotated = [...strong.candidates.slice(seed % 3), ...strong.candidates.slice(0, seed % 3)];
  const n = rotated.length;
  return {
    chapterId: `probe-${seed}`, chapterNumber: seed + 1,
    chapterTitle: `${strong.chapterTitle} ${seed + 1}`, contentHash: `p${seed}`,
    tensionPeak: 0.82, charactersPresent: strong.cast,
    majorEvents: rotated.map((c, i) => ({
      rank: c.rank, label: c.label, sentence: c.sentence, agent: c.agent,
      type: "action", channel: "action", tensionPosition: n > 1 ? i / (n - 1) : 0.5,
    })),
  } as unknown as ChapterGraphEntry;
}

const CHIP_REQS = [0, 1, 2, 3].map((i) => buildChipRequest(mkEntry(i), { rich: true }));
const SUM_REQ = buildSummaryRequest(mkEntry(0));

async function main() {
  if (!fs.existsSync(MODEL)) { console.log("SKIP — max model not on disk."); return; }
  const llama = await getLlama({ build: "never", logLevel: "warn" });
  const model = await llama.loadModel({ modelPath: MODEL, gpuLayers: "max", useMmap: true });
  const grammar = await llama.createGrammarForJsonSchema(CHIP_REQS[0].schema as never);
  const sumGrammar = await llama.createGrammarForJsonSchema(SUM_REQ.schema as never);

  const runOn = async (seq: ReturnType<Awaited<ReturnType<typeof model.createContext>>["getSequence"]>, req: { systemPrompt: string; userText: string; maxTokens: number }, g: unknown) => {
    const session = new LlamaChatSession({ contextSequence: seq, systemPrompt: req.systemPrompt + "\n/no_think", autoDisposeSequence: false });
    const meta = await session.promptWithMeta(req.userText, { grammar: g as never, maxTokens: req.maxTokens, temperature: 0 });
    return meta.responseText;
  };

  // ── sequential baseline: one context, one sequence, 4 runs back to back ──
  {
    const ctx = await model.createContext({ contextSize: 8192, sequences: 1, flashAttention: true });
    const seq = ctx.getSequence();
    await runOn(seq, CHIP_REQS[0], grammar); // warm the weights/prefill
    const t0 = Date.now();
    const outs: string[] = [];
    for (const r of CHIP_REQS) outs.push(await runOn(seq, r, grammar));
    console.log(`sequential 4 chips: ${Date.now() - t0}ms`);
    (globalThis as { seqOuts?: string[] }).seqOuts = outs;
    seq.dispose(); await ctx.dispose();
  }

  // ── parallel: one context, 4 sequences, 4 runs concurrently ─────────────
  {
    const ctx = await model.createContext({ contextSize: 8192, sequences: 4, flashAttention: true });
    const seqs = [0, 1, 2, 3].map(() => ctx.getSequence());
    await runOn(seqs[0], CHIP_REQS[0], grammar); // warm
    const t0 = Date.now();
    const outs = await Promise.all(CHIP_REQS.map((r, i) => runOn(seqs[i], r, grammar)));
    console.log(`parallel   4 chips: ${Date.now() - t0}ms`);
    const seqOuts = (globalThis as { seqOuts?: string[] }).seqOuts ?? [];
    const same = outs.every((o, i) => o === seqOuts[i]);
    console.log(same ? "✓ parallel outputs identical to sequential" : "✗ OUTPUTS DIFFER — investigate before shipping");

    // Mixed load: a summary rides alongside 3 chips (the real tick shape).
    const t1 = Date.now();
    await Promise.all([
      runOn(seqs[0], CHIP_REQS[1], grammar),
      runOn(seqs[1], CHIP_REQS[2], grammar),
      runOn(seqs[2], CHIP_REQS[3], grammar),
      runOn(seqs[3], SUM_REQ, sumGrammar),
    ]);
    console.log(`parallel 3 chips + summary: ${Date.now() - t1}ms`);
    for (const s of seqs) s.dispose();
    await ctx.dispose();
  }
  await model.dispose();
}
main().catch((e) => { console.error(e); process.exit(1); });
