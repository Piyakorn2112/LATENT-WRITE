/**
 * probe-model-candidate.ts — put a candidate model on the app's own requests,
 * beside the models that already ship, and print numbers that separate the two
 * things a swap can trade against each other.
 *
 * ★★ THE ONLY HONEST COMPARISON IS THE SAME BYTES. A leaderboard says a model
 *    is better at a benchmark nobody in this app runs. What decides a tier here
 *    is: does it load at all on the pinned engine, does it hold a grammar, how
 *    fast does it prefill an 800-token system prompt, how fast does it write
 *    40 tokens of JSON, and what does the answer actually say. So every model
 *    gets the identical request built by the shipped modules
 *    (buildChipRequest / buildSummaryRequest over a committed fixture), the
 *    identical compact grammar, and temperature 0.
 *
 * ★ PREFILL AND GEN ARE REPORTED APART, always. A hybrid-attention model can
 *   win generation and lose prefill (or the reverse), and a single wall-clock
 *   number hides which one moved — the same split bench-assistant.cjs uses.
 *
 * ★ THE ANSWER IS PRINTED, NOT SCORED. This probe answers "can it, and how
 *   fast"; whether the answer is BETTER is the gold bench's job
 *   (bench:dossier-quality). A probe that quietly scores quality on two
 *   samples is how a worse model ships.
 *
 * Run:
 *   MODELS=Qwen3-1.7B-Q4_K_M.gguf,Qwen3.8-2B-Q4_K_M.gguf \
 *     ./node_modules/.bin/tsx scripts/probe-model-candidate.ts
 *
 * Env:
 *   MODELS  comma list of GGUF basenames (in the app's models dir) or paths
 *   CTX     context size for every model            (default 8192)
 *   KV      Q8_0 | f16                              (default f16 — see below)
 *   RUNS    timed repeats after the cold run        (default 2)
 *   OUT     JSON output path      (default bench-results/model-candidate.json)
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { getLlama, LlamaChatSession, LlamaText } from "node-llama-cpp";
// Internal on purpose: createGrammarForJsonSchema does not expose allowNewLines
// and the exports map blocks the subpath. Same dynamic-import escape hatch
// probe-decode-speed.ts uses, against the same pinned version.
const { getGbnfGrammarForGbnfJsonSchema } = await import(pathToFileURL(
  path.join(process.cwd(), "node_modules/node-llama-cpp/dist/utils/gbnfJson/getGbnfGrammarForGbnfJsonSchema.js"),
).href) as { getGbnfGrammarForGbnfJsonSchema: (schema: never, opts?: { allowNewLines?: boolean }) => string };
import { buildChipRequest } from "../src/lib/chip-picker";
import { buildSummaryRequest } from "../src/lib/chapter-summary";
import fixture from "./fixtures/assistant-tasks.json";
import type { ChapterGraphEntry } from "../src/types";

const MODELS_DIR = path.join(os.homedir(), "Library/Application Support/Latent Write/models");
const CTX = Number(process.env.CTX) || 8192;
/** ★ f16 KV BY DEFAULT, EVEN THOUGH THE MAX TIER SHIPS Q8_0. Q8_0 KV is an
 *  experimental binding option that a hybrid-attention model may refuse, and a
 *  silent fallback on ONE model in a comparison makes the comparison a lie.
 *  Q8_0 is measured separately, per model, once the shape is known. */
const KV = process.env.KV === "Q8_0" ? "Q8_0" : "f16";
const RUNS = Number(process.env.RUNS) || 2;
/** Warm-up rounds allowed before the prefill is called settled. Bounded so a
 *  model that never stabilises reports its real (bad) number instead of
 *  looping forever. */
const MAX_WARMUP = Number(process.env.MAX_WARMUP) || 4;
/** Both tiers ship flashAttention:true. A candidate on a new attention shape is
 *  exactly where that flag can stop being free, so it is a knob here. */
const FLASH = process.env.FLASH !== "off";
const OUT = process.env.OUT || path.join(process.cwd(), "bench-results", "model-candidate.json");

const MODELS = (process.env.MODELS || "").split(",").map((s) => s.trim()).filter(Boolean)
  .map((m) => (m.includes("/") ? m : path.join(MODELS_DIR, m)));
if (!MODELS.length) { console.error("MODELS=a.gguf,b.gguf is required"); process.exit(1); }

// ── the request set: the shipped builders over a committed fixture ──────────
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
    type: "action", channel: "action",
    tensionPosition: n > 1 ? i / (n - 1) : 0.5,
  })),
} as unknown as ChapterGraphEntry;

const REQUESTS = [
  { name: "chips", req: buildChipRequest(entry, { rich: true }) },
  { name: "summary", req: buildSummaryRequest(entry) },
];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const rssMb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

interface Row {
  model: string; bytes: number; loadMs: number; loadError?: string;
  arch?: string; trainCtx?: number; layers?: number; params?: number;
  contextError?: string;
  results: Array<{
    name: string; promptTokens: number; genTokens: number;
    coldPrefillMs: number; prefillMs: number; genMs: number; wallMs: number;
    prefillTps: number; genTps: number; cacheGain: number;
    jsonOk: boolean; answer: unknown; raw: string;
  }>;
  rssMb?: number;
}

async function main() {
  const llama = await getLlama({ build: "never", logLevel: "warn" });
  const rows: Row[] = [];

  for (const modelPath of MODELS) {
    const name = path.basename(modelPath);
    console.log(`\n══ ${name}`);
    if (!fs.existsSync(modelPath)) { console.log("   MISSING — skipped"); continue; }
    const bytes = fs.statSync(modelPath).size;
    const row: Row = { model: name, bytes, loadMs: 0, results: [] };

    // ── load. THE FIRST GATE: a new architecture either loads on the pinned
    //    engine or the whole idea needs an engine bump, and that is a different
    //    (and much more expensive) change.
    const t0 = Date.now();
    let model;
    try {
      model = await llama.loadModel({ modelPath, gpuLayers: "max", useMmap: true });
    } catch (e) {
      row.loadError = String((e as Error).message || e);
      console.log(`   LOAD FAILED — ${row.loadError.slice(0, 200)}`);
      rows.push(row);
      continue;
    }
    row.loadMs = Date.now() - t0;
    // Metadata read defensively: a candidate model is exactly the case where a
    // field the shipping models always carry turns out to be absent.
    const meta = (model as unknown as { fileInfo?: { metadata?: Record<string, unknown> } }).fileInfo?.metadata;
    const general = meta?.general as Record<string, unknown> | undefined;
    row.arch = general ? String(general.architecture ?? "") : undefined;
    row.trainCtx = model.trainContextSize;
    row.params = Number(model.size) || undefined;
    console.log(`   loaded in ${row.loadMs}ms · arch=${row.arch ?? "?"} · trainCtx=${row.trainCtx} · vram=${(Number(model.size) / 1e9).toFixed(2)}GB`);

    let context;
    try {
      context = await model.createContext({
        contextSize: CTX, sequences: 1, flashAttention: FLASH,
        ...(KV === "Q8_0"
          ? { experimentalKvCacheKeyType: "Q8_0", experimentalKvCacheValueType: "Q8_0" }
          : {}),
      } as Parameters<typeof model.createContext>[0]);
    } catch (e) {
      row.contextError = String((e as Error).message || e);
      console.log(`   CONTEXT FAILED — ${row.contextError.slice(0, 200)}`);
      await model.dispose();
      rows.push(row);
      continue;
    }
    const sequence = context.getSequence();

    for (const { name: reqName, req } of REQUESTS) {
      const grammar = await llama.createGrammar({
        grammar: getGbnfGrammarForGbnfJsonSchema(req.schema as never, { allowNewLines: false }),
        stopGenerationTriggers: [LlamaText(["\n".repeat(4)])],
        trimWhitespaceSuffix: true,
      });
      const once = async () => {
        const session = new LlamaChatSession({
          contextSequence: sequence,
          systemPrompt: `${req.systemPrompt}\n/no_think`,
          autoDisposeSequence: false,
        });
        let tokens = 0; let firstAt = 0;
        const start = Date.now();
        const out = await session.promptWithMeta(req.userText, {
          grammar: grammar as never,
          maxTokens: req.maxTokens ?? 256,
          temperature: 0,
          onToken: (t) => { if (!firstAt) firstAt = Date.now(); tokens += Array.isArray(t) ? t.length : 1; },
        });
        const done = Date.now();
        return {
          prefillMs: (firstAt || done) - start,
          genMs: firstAt ? done - firstAt : 0,
          wallMs: done - start,
          genTokens: tokens,
          raw: out.responseText,
        };
      };

      // ★★ COLD AND WARM PREFILL ARE BOTH REPORTED, and the gap between them
      //    IS the measurement. Every request in this app repeats a
      //    byte-identical system prompt, so the shipped speed is the WARM
      //    number.
      //
      // ★★ WARM UNTIL IT STOPS FALLING — DO NOT DISCARD A FIXED COUNT. This
      //    discarded exactly ONE cold run, which silently produced a WRONG
      //    ANSWER on qwen35: that architecture needs TWO OR THREE evaluations
      //    before the prefix cache engages (observed 2618ms, 2524ms, 24ms,
      //    32ms). Discarding one and taking a median over the next two
      //    averaged a still-cold run against a warm one and reported a "2.1x
      //    cache ceiling" that does not exist — the same model warms to 52ms
      //    on the same binding. A fixed warm-up count encodes an assumption
      //    about the model under test, which is the one thing a candidate
      //    probe must not do.
      const cold = await once();
      for (let i = 0; i < MAX_WARMUP; i++) {
        const a = await once();
        const b = await once();
        // Stable = the two agree within 35%. Two consecutive comparable runs
        // mean the cache has settled, whatever it took to get there.
        if (b.prefillMs <= Math.max(4, a.prefillMs * 1.35)) break;
      }
      const takes = [];
      for (let i = 0; i < RUNS; i++) takes.push(await once());
      const last = takes[takes.length - 1];
      const promptTokens = model.tokenize(`${req.systemPrompt}\n/no_think\n${req.userText}`).length;
      const prefillMs = median(takes.map((t) => t.prefillMs));
      const genMs = median(takes.map((t) => t.genMs));
      let answer: unknown = null; let jsonOk = false;
      try { answer = JSON.parse(last.raw); jsonOk = true; } catch { /* reported as false */ }
      const rec = {
        name: reqName, promptTokens, genTokens: last.genTokens,
        coldPrefillMs: cold.prefillMs,
        prefillMs, genMs, wallMs: median(takes.map((t) => t.wallMs)),
        prefillTps: prefillMs ? Math.round((promptTokens / prefillMs) * 1000) : 0,
        genTps: genMs ? Math.round((last.genTokens / genMs) * 10000) / 10 : 0,
        /** How much of the repeated prompt the cache actually saves. */
        cacheGain: cold.prefillMs && prefillMs ? Math.round((cold.prefillMs / prefillMs) * 10) / 10 : 0,
        jsonOk, answer, raw: last.raw,
      };
      row.results.push(rec);
      console.log(
        `   ${reqName.padEnd(8)} prefill cold ${String(cold.prefillMs).padStart(5)}ms → warm ${String(prefillMs).padStart(6)}ms `
        + `(${String(rec.cacheGain).padStart(6)}x cache, ${String(rec.prefillTps).padStart(5)} tok/s warm, ${promptTokens} tok)`
        + `  gen ${String(genMs).padStart(6)}ms (${String(rec.genTps).padStart(5)} tok/s, ${last.genTokens} tok)`
        + `  json ${jsonOk ? "ok" : "BROKEN"}`,
      );
    }

    row.rssMb = rssMb();
    sequence.dispose();
    await context.dispose();
    await model.dispose();
    rows.push(row);
  }

  console.log("\n── answers (temperature 0) ──────────────────────────────────");
  for (const row of rows) {
    console.log(`\n${row.model}`);
    if (row.loadError) { console.log(`  load failed: ${row.loadError.slice(0, 300)}`); continue; }
    if (row.contextError) { console.log(`  context failed: ${row.contextError.slice(0, 300)}`); continue; }
    for (const r of row.results) console.log(`  ${r.name}: ${r.raw.slice(0, 700)}`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify({ ctx: CTX, kv: KV, runs: RUNS, rows }, null, 2)}\n`);
  console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
}

await main();
