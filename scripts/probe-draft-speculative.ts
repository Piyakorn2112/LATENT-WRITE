/**
 * probe-draft-speculative.ts — can the resident 1.7B DRAFT for the 4B?
 *
 * Prompt-lookup lost (18% slower — chip output isn't in the prompt). A real
 * draft MODEL is the other speculative family: same tokenizer, high
 * acceptance expected. Cost: the 1.7B resident alongside (+~1.3GB) — a
 * 16GB-machine option the memory guard would gate. This measures whether
 * it's worth wiring at all.
 *
 * Run: ./node_modules/.bin/tsx scripts/probe-draft-speculative.ts
 *
 * ★★ VERDICT (measured 2026-08-07): REJECTED, definitively. base gen ~2.2s;
 *    draft-spec gen 8.7–8.9s AND node-llama-cpp warns "pushed tokens are
 *    incompatible with the grammar evaluation state. The grammar will be
 *    ignored" — drafted tokens bypass the grammar state, so constrained
 *    JSON runs lose BOTH speed (4x slower) and the schema guarantee. Both
 *    speculative families are now measured dead for this workload
 *    (prompt-lookup was +18%). Per-call decode is at the binding's floor;
 *    further timeline speed is THROUGHPUT (parallel sequences), not
 *    per-call.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { getLlama, LlamaChatSession, DraftSequenceTokenPredictor } from "node-llama-cpp";
import { buildChipRequest } from "../src/lib/chip-picker";
import fixture from "./fixtures/assistant-tasks.json";
import type { ChapterGraphEntry } from "../src/types";

const DIR = path.join(os.homedir(), "Library/Application Support/Latent Write/models");
const MAIN = path.join(DIR, "Qwen3-4B-Thinking-2507-Q4_K_M.gguf");
const DRAFT = path.join(DIR, "Qwen3-1.7B-Q4_K_M.gguf");

const strong = (fixture as { timelineChips: Array<Record<string, unknown>> }).timelineChips
  .find((c) => c.id === "strong")! as {
    chapterNumber: number; chapterTitle: string; cast: string[];
    candidates: Array<{ rank: number; label: string; sentence: string; agent?: string }>;
  };
const n = strong.candidates.length;
const entry = {
  chapterId: "probe-ch", chapterNumber: strong.chapterNumber,
  chapterTitle: strong.chapterTitle, contentHash: "probe",
  tensionPeak: 0.82, charactersPresent: strong.cast,
  majorEvents: strong.candidates.map((c, i) => ({
    rank: c.rank, label: c.label, sentence: c.sentence, agent: c.agent,
    type: "action", channel: "action", tensionPosition: n > 1 ? i / (n - 1) : 0.5,
  })),
} as unknown as ChapterGraphEntry;
const req = buildChipRequest(entry, { rich: true });

async function main() {
  if (!fs.existsSync(MAIN) || !fs.existsSync(DRAFT)) { console.log("SKIP — models missing"); return; }
  const llama = await getLlama({ build: "never", logLevel: "warn" });
  const main = await llama.loadModel({ modelPath: MAIN, gpuLayers: "max", useMmap: true });

  const run = async (label: string, predictor?: DraftSequenceTokenPredictor) => {
    const ctx = await main.createContext({ contextSize: 8192, sequences: 1, flashAttention: true });
    const seq = ctx.getSequence(predictor ? { tokenPredictor: predictor } : {});
    const grammar = await llama.createGrammarForJsonSchema(req.schema as never);
    const results: number[] = [];
    for (let i = 0; i < 3; i++) {
      const session = new LlamaChatSession({ contextSequence: seq, systemPrompt: req.systemPrompt + "\n/no_think", autoDisposeSequence: false });
      let first = 0;
      const t0 = Date.now();
      await session.promptWithMeta(req.userText, {
        grammar: grammar as never, maxTokens: req.maxTokens, temperature: 0,
        onToken: () => { if (!first) first = Date.now(); },
      });
      results.push(Date.now() - first);
    }
    console.log(`${label}: gen ${results.map((x) => `${x}ms`).join(" · ")} (run 1 cold prefill excluded from gen)`);
    seq.dispose();
    await ctx.dispose();
  };

  await run("base       ");
  const draftModel = await llama.loadModel({ modelPath: DRAFT, gpuLayers: "max", useMmap: true });
  const draftCtx = await draftModel.createContext({ contextSize: 8192, sequences: 1, flashAttention: true });
  const draftSeq = draftCtx.getSequence();
  await run("draft-spec ", new DraftSequenceTokenPredictor(draftSeq));
  await draftCtx.dispose();
  await draftModel.dispose();
  await main.dispose();
}
main().catch((e) => { console.error(e); process.exit(1); });
