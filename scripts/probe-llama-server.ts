/**
 * probe-llama-server.ts — GO/NO-GO for the sidecar-server architecture.
 *
 * llama-server (llama.cpp native) claims what node-llama-cpp could not
 * deliver: TRUE continuous batching across parallel slots, per-request
 * JSON-schema constraints, per-slot prompt caching. This fires the app's
 * REAL chip requests (tuple wire) at it, sequential vs concurrent, and
 * checks the schema held.
 *
 * Server: llama-server -m <4B gguf> -np 4 -c 8192 --port 8873
 * Run:    ./node_modules/.bin/tsx scripts/probe-llama-server.ts
 *
 * ★★ VERDICT (measured 2026-08-07): GO. -np 4 -fa on, native /completion,
 *    hand-built Qwen3 template with a CLOSED think prefill (the chat
 *    endpoint's auto-template opened <think> and burned the budget - 0/4):
 *    sequential 4 chips 11.7s, parallel 6.7s = 1.75x TRUE batching, schema
 *    4/4, per-call also faster than the in-process binding. Architecture:
 *    llama-server as a registry-driven sidecar the host supervises; HTTP
 *    /completion with json_schema + cache_prompt; slot affinity by task
 *    type; memory guard unchanged (weights+KV arithmetic identical).
 */
import { buildChipRequest, decodeRichChipWire } from "../src/lib/chip-picker";
import fixture from "./fixtures/assistant-tasks.json";
import type { ChapterGraphEntry } from "../src/types";

const URL = "http://127.0.0.1:8873/v1/chat/completions";
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

async function ask(req: (typeof REQS)[number]) {
  // Native /completion with a hand-built Qwen3 template: the EMPTY prefilled
  // think block disables reasoning (the chat endpoint's auto-template opened
  // <think> and burned the whole budget thinking — 0/4 schema held).
  const prompt =
    `<|im_start|>system
${req.systemPrompt}
/no_think<|im_end|>
` +
    `<|im_start|>user
${req.userText}<|im_end|>
` +
    `<|im_start|>assistant
<think>

</think>

`;
  const res = await fetch('http://127.0.0.1:8873/completion', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt,
      json_schema: req.schema,
      temperature: 0,
      n_predict: req.maxTokens,
      cache_prompt: true,
    }),
  });
  const json = (await res.json()) as { content?: string };
  return json.content ?? '';
}

async function main() {
  await ask(REQS[0]); // warm
  let t0 = Date.now();
  const seqOuts: string[] = [];
  for (const r of REQS) seqOuts.push(await ask(r));
  const seqMs = Date.now() - t0;
  console.log(`sequential 4 chips: ${seqMs}ms`);

  t0 = Date.now();
  const parOuts = await Promise.all(REQS.map((r) => ask(r)));
  const parMs = Date.now() - t0;
  console.log(`parallel   4 chips: ${parMs}ms  (${(seqMs / parMs).toFixed(2)}x)`);

  let schemaOk = 0;
  for (const o of parOuts) {
    try {
      const decoded = decodeRichChipWire(JSON.parse(o)) as { picks?: unknown[] };
      if (Array.isArray(decoded.picks) && decoded.picks.length > 0) schemaOk++;
    } catch { /* count stays */ }
  }
  console.log(`schema held on ${schemaOk}/4 parallel answers`);
  console.log(`sample: ${parOuts[0].slice(0, 140)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
