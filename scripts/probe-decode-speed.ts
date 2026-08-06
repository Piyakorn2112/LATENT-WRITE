/**
 * probe-decode-speed.ts — can max-mode generation get 2x faster WITHOUT
 * changing what it says?
 *
 * Two lossless levers, measured independently and together on the real 4B
 * with the app's exact request bytes:
 *
 *   PREDICTOR — InputLookupTokenPredictor (prompt-lookup decoding): drafts the
 *   next tokens by finding them in the INPUT. Chip labels/details and summary
 *   sentences are copied spans from the prompt, which is the best case for
 *   lookup drafting. Output is validated by the model itself, so at
 *   temperature 0 the result is IDENTICAL by construction.
 *
 *   COMPACT — the JSON-schema grammar generated with allowNewLines:false. The
 *   default grammar lets the model pretty-print, and it always does: measured
 *   384 raw chars for ~55 chars of content. Whitespace tokens cost a full
 *   forward pass each and can never be lookup-drafted (the prompt contains no
 *   pretty JSON). Content is unchanged; only inter-token whitespace goes.
 *
 * Run: ./node_modules/.bin/tsx scripts/probe-decode-speed.ts
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { getLlama, LlamaChatSession, LlamaText, InputLookupTokenPredictor } from "node-llama-cpp";
// Internal on purpose: createGrammarForJsonSchema does not expose
// allowNewLines, and the package's exports map blocks the subpath — a file-URL
// dynamic import bypasses it. Pinned version; the HOST wraps this in a fallback.
const { getGbnfGrammarForGbnfJsonSchema } = await import(pathToFileURL(
  path.join(process.cwd(), "node_modules/node-llama-cpp/dist/utils/gbnfJson/getGbnfGrammarForGbnfJsonSchema.js"),
).href) as { getGbnfGrammarForGbnfJsonSchema: (schema: never, opts?: { allowNewLines?: boolean; scopePadSpaces?: number }) => string };
import { buildChipRequest } from "../src/lib/chip-picker";
import { buildSummaryRequest } from "../src/lib/chapter-summary";
import fixture from "./fixtures/assistant-tasks.json";
import type { ChapterGraphEntry } from "../src/types";

const MODEL_PATH = path.join(
  os.homedir(),
  "Library/Application Support/Latent Write/models/Qwen3-4B-Thinking-2507-Q4_K_M.gguf",
);

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

const chipReq = buildChipRequest(entry, { rich: true });
const sumReq = buildSummaryRequest(entry);

async function main() {
  if (!fs.existsSync(MODEL_PATH)) { console.log("SKIP — max model not on disk."); return; }
  const llama = await getLlama({ build: "never", logLevel: "warn" });
  const model = await llama.loadModel({ modelPath: MODEL_PATH, gpuLayers: "max", useMmap: true });

  // Wire-shrunk chip schemas: same content, fewer ceremony tokens. Keys are
  // renamed ON THE WIRE ONLY (decode maps them back); the tuple drops keys
  // entirely. Each carries a prompt line teaching the wire shape.
  const SHORT_SCHEMA = {
    type: "object",
    properties: {
      p: {
        type: "array", maxItems: 4,
        items: {
          type: "object",
          properties: {
            r: { type: "integer" },
            l: { type: "string", maxLength: 72 },
            d: { type: "string", maxLength: 96 },
          },
        },
      },
    },
  };
  const TUPLE_SCHEMA = {
    type: "object",
    properties: {
      p: {
        type: "array", maxItems: 4,
        items: {
          type: "array",
          prefixItems: [
            { type: "integer" },
            { type: "string", maxLength: 72 },
            { type: "string", maxLength: 96 },
          ],
          minItems: 2, maxItems: 3,
        },
      },
    },
  };
  const SHORT_SUFFIX = `\n\nWIRE FORMAT: answer as {"p":[{"r","l","d"}]} — r is the rank number, l is\nthe label, d is the detail. Same content as described above, this shape.`;
  const TUPLE_SUFFIX = `\n\nWIRE FORMAT: answer as {"p":[[rank,"label","detail"], ...]} — each pick is\nan array of the rank number, then the label, then the detail (omit the third\nentry instead of an empty detail). Same content as described above, this shape.`;

  interface Cfg {
    name: string; predictor: boolean; compact: boolean;
    schema?: object; suffix?: string; skipSummary?: boolean;
    decode?: (json: unknown) => unknown;
  }
  const asPicks = (arr: unknown[], f: (x: never) => { rank: unknown; label: unknown; detail?: unknown }) =>
    ({ picks: arr.map((x) => f(x as never)) });
  const CONFIGS: Cfg[] = [
    { name: "base", predictor: false, compact: false },
    { name: "predictor", predictor: true, compact: false },
    { name: "compact", predictor: false, compact: true },
    { name: "compact+predictor", predictor: true, compact: true },
    {
      name: "compact+shortkeys", predictor: false, compact: true,
      schema: SHORT_SCHEMA, suffix: SHORT_SUFFIX, skipSummary: true,
      decode: (j) => asPicks((j as { p: unknown[] }).p, (x: { r: number; l: string; d?: string }) =>
        ({ rank: x.r, label: x.l, ...(x.d ? { detail: x.d } : {}) })),
    },
    {
      name: "compact+tuple", predictor: false, compact: true,
      schema: TUPLE_SCHEMA, suffix: TUPLE_SUFFIX, skipSummary: true,
      decode: (j) => asPicks((j as { p: unknown[] }).p, (x: [number, string, string?]) =>
        ({ rank: x[0], label: x[1], ...(x[2] ? { detail: x[2] } : {}) })),
    },
  ];

  const outputs: Record<string, { chip: unknown; sum?: unknown }> = {};

  for (const cfg of CONFIGS) {
    const context = await model.createContext({
      contextSize: 8192, sequences: 1, flashAttention: true,
      // Mirror the registry's max-tier context exactly (Q8_0 KV).
      experimentalKvCacheKeyType: "Q8_0", experimentalKvCacheValueType: "Q8_0",
    } as Parameters<typeof model.createContext>[0]);
    const sequence = context.getSequence(
      cfg.predictor ? { tokenPredictor: new InputLookupTokenPredictor() } : {},
    );

    const mkGrammar = async (schema: object) =>
      cfg.compact
        ? await llama.createGrammar({
            grammar: getGbnfGrammarForGbnfJsonSchema(schema as never, { allowNewLines: false }),
            stopGenerationTriggers: [LlamaText(["\n".repeat(4)])],
            trimWhitespaceSuffix: true,
          })
        : await llama.createGrammarForJsonSchema(schema as never);

    const run = async (label: string, req: { systemPrompt: string; userText: string; schema: object; maxTokens: number }) => {
      const grammar = await mkGrammar(req.schema);
      const session = new LlamaChatSession({
        contextSequence: sequence, systemPrompt: req.systemPrompt + "\n/no_think",
        autoDisposeSequence: false,
      });
      let tokens = 0; let firstAt = 0;
      const t0 = Date.now();
      const meta = await session.promptWithMeta(req.userText, {
        grammar: grammar as never, maxTokens: req.maxTokens, temperature: 0,
        onToken: (t) => { if (!firstAt) firstAt = Date.now(); tokens += Array.isArray(t) ? t.length : 1; },
      });
      const done = Date.now();
      const genMs = firstAt ? done - firstAt : 0;
      console.log(`   ${label}: wall=${done - t0}ms prefill=${(firstAt || done) - t0}ms gen=${genMs}ms tokens=${tokens} raw=${meta.responseText.length}ch`);
      return JSON.parse(meta.responseText) as unknown;
    };

    console.log(`\n── ${cfg.name}`);
    const req = cfg.schema || cfg.suffix
      ? { ...chipReq, schema: cfg.schema ?? chipReq.schema, systemPrompt: chipReq.systemPrompt + (cfg.suffix ?? "") }
      : chipReq;
    await run("chip cold ", req);
    const rawChip = await run("chip warm ", req);
    const chip = cfg.decode ? cfg.decode(rawChip) : rawChip;
    outputs[cfg.name] = { chip };
    if (!cfg.skipSummary) outputs[cfg.name].sum = await run("summary   ", sumReq);

    sequence.dispose();
    await context.dispose();
  }

  // The predictor is lossless BY CONSTRUCTION (the model validates every
  // draft), so it must match base exactly. A format change legitimately moves
  // the token sequence at temperature 0, so for those the content is printed
  // for hand judgement instead of gated on equality.
  for (const cfg of CONFIGS) {
    const picks = (outputs[cfg.name].chip as { picks: Array<{ rank: number; label: string; detail?: string }> }).picks;
    console.log(`\n${cfg.name}:`);
    for (const p of picks) console.log(`   [${p.rank}] ${p.label}${p.detail ? `  ·  ${p.detail}` : ""}`);
  }
  const same = JSON.stringify(outputs["predictor"]) === JSON.stringify(outputs["base"]);
  console.log(`\n${same ? "✓" : "✗"} predictor output ${same ? "identical to" : "DIFFERS from"} base (must be identical)`);
  await model.dispose();
}

main().catch((e) => { console.error(e); process.exit(1); });
