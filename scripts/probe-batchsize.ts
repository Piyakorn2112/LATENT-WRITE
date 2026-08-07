/**
 * probe-batchsize.ts — per-tier batchSize for the 4B's cross-chapter prefill.
 *
 * The old batchSize measurement rejected 2048 for the SMALL tier (short
 * prompts got worse, memory cost on the 8GB floor). The MAX tier's chip
 * prompts are ~1500 tokens and every chapter pays fresh userText prefill —
 * the case bigger batches exist for. Measured per tier, decided per tier.
 *
 * Run: ./node_modules/.bin/tsx scripts/probe-batchsize.ts
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { getLlama, LlamaChatSession } from "node-llama-cpp";
import { buildChipRequest } from "../src/lib/chip-picker";
import fixture from "./fixtures/assistant-tasks.json";
import type { ChapterGraphEntry } from "../src/types";

const MODEL = path.join(os.homedir(), "Library/Application Support/Latent Write/models/Qwen3-4B-Thinking-2507-Q4_K_M.gguf");
const strong = (fixture as { timelineChips: Array<Record<string, unknown>> }).timelineChips
  .find((c) => c.id === "strong")! as {
    chapterNumber: number; chapterTitle: string; cast: string[];
    candidates: Array<{ rank: number; label: string; sentence: string; agent?: string }>;
  };

function mkEntry(seed: number): ChapterGraphEntry {
  const rot = [...strong.candidates.slice(seed % 3), ...strong.candidates.slice(0, seed % 3)];
  const n = rot.length;
  return {
    chapterId: `p${seed}`, chapterNumber: seed + 1, chapterTitle: `${strong.chapterTitle} ${seed}`,
    contentHash: `p${seed}`, tensionPeak: 0.82, charactersPresent: strong.cast,
    majorEvents: rot.map((c, i) => ({
      rank: c.rank, label: c.label, sentence: c.sentence, agent: c.agent,
      type: "action", channel: "action", tensionPosition: n > 1 ? i / (n - 1) : 0.5,
    })),
  } as unknown as ChapterGraphEntry;
}
const REQS = [0, 1, 2, 3].map((i) => buildChipRequest(mkEntry(i), { rich: true }));

async function main() {
  if (!fs.existsSync(MODEL)) { console.log("SKIP"); return; }
  const llama = await getLlama({ build: "never", logLevel: "warn" });
  const model = await llama.loadModel({ modelPath: MODEL, gpuLayers: "max", useMmap: true });
  const grammar = await llama.createGrammarForJsonSchema(REQS[0].schema as never);
  for (const batchSize of [512, 1024, 2048]) {
    const ctx = await model.createContext({ contextSize: 8192, sequences: 1, flashAttention: true, batchSize });
    const seq = ctx.getSequence();
    const run = async (r: (typeof REQS)[number]) => {
      const s = new LlamaChatSession({ contextSequence: seq, systemPrompt: r.systemPrompt + "\n/no_think", autoDisposeSequence: false });
      const t0 = Date.now();
      await s.promptWithMeta(r.userText, { grammar: grammar as never, maxTokens: r.maxTokens, temperature: 0 });
      return Date.now() - t0;
    };
    const cold = await run(REQS[0]);
    const cross: number[] = [];
    for (const r of REQS.slice(1)) cross.push(await run(r));
    console.log(`batchSize ${batchSize}: cold ${cold}ms · cross-chapter ${cross.join("/")}ms`);
    seq.dispose();
    await ctx.dispose();
  }
  await model.dispose();
}
main().catch((e) => { console.error(e); process.exit(1); });
