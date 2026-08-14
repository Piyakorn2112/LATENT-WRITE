/**
 * probe-timeline-lane.ts — the ONE number the timeline lane is judged against.
 *
 * The lane is two tasks and nothing else: the timeline CHIP picker and the
 * chapter SUMMARY shown in the widget panel. Both run in the background on the
 * small tier, in the drain order App.tsx uses (every stale chapter's chips,
 * then every stale chapter's summary), through the same session pattern the
 * host uses (ONE context sequence, a fresh LlamaChatSession per run, history
 * never cleared, so a byte-identical system prompt is prefix-cached).
 *
 * It measures what the goals are stated in:
 *   · lane wall time and its prefill/generation split
 *   · generated tokens (the decode work) and prompt tokens (the prefill work)
 *   · GPU-busy milliseconds, integrated from the Metal accelerator's own
 *     utilisation counter (ioreg, no sudo) — a knob that trades GPU time for
 *     wall time must not be able to hide
 *   · peak RSS of this process, which holds the weights and the KV cache
 *   · how often the chip REPAIR pass fires, because a repair carries a
 *     different system prompt and therefore evicts the cached chip prefix
 *
 * and it captures every normalised answer so a configuration that is faster by
 * saying something else is caught by the quality gate rather than shipped.
 *
 *   ./node_modules/.bin/tsx scripts/probe-timeline-lane.ts [--configs a,b]
 *   LANE_REPEATS=2 ./node_modules/.bin/tsx scripts/probe-timeline-lane.ts
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { getLlama, LlamaChatSession, LlamaText } from "node-llama-cpp";
import type { Llama, LlamaModel, LlamaGrammar } from "node-llama-cpp";
import {
  buildChipRequest, buildChipRepairRequest, normalizeChipPicks, applyChipRepairs,
  CHIP_LABEL_MAX, CHIP_PICK_CAP,
} from "../src/lib/chip-picker";
import type { ChipCandidate } from "../src/lib/chip-picker";
import { buildSummaryRequest, normalizeSummary } from "../src/lib/chapter-summary";
import fixture from "./fixtures/assistant-tasks.json";
import type { ChapterGraphEntry, TimelineChipPick } from "../src/types";

// The compact (no-pretty-print) grammar generator: the same internal the host
// reaches past the exports map for. Pinned; see the ★ in assistant-host.cjs.
const { getGbnfGrammarForGbnfJsonSchema } = (await import(pathToFileURL(
  path.join(process.cwd(), "node_modules/node-llama-cpp/dist/utils/gbnfJson/getGbnfGrammarForGbnfJsonSchema.js"),
).href)) as { getGbnfGrammarForGbnfJsonSchema: (schema: never, opts?: { allowNewLines?: boolean }) => string };

const MODEL_PATH = path.join(
  os.homedir(),
  "Library/Application Support/Latent Write/models/Qwen3-1.7B-Q4_K_M.gguf",
);
/** Mirrors MODEL_REGISTRY.small exactly: f16 KV (Q8_0 measured changing an
 *  answer on this tier), flash attention on, 4096 context. */
const CONTEXT_SIZE = Number(process.env.LANE_CONTEXT) || 4096;
const REPEATS = Number(process.env.LANE_REPEATS) || 1;
const OUT = path.join(process.cwd(), "bench-results", "timeline-lane.json");

// ── the four fixture chapters, as the entries the builders take ─────────────

interface ChipCase {
  id: string; chapterNumber: number; chapterTitle: string; cast: string[];
  candidates: Array<{ rank: number; label: string; sentence: string; agent?: string }>;
}
interface SumCase {
  id: string; chapterNumber: number; chapterTitle: string; cast: string[]; offered: string[];
  systemPrompt: string; userText: string; schema: object; maxTokens: number;
}
const chipCases = (fixture as unknown as { timelineChips: ChipCase[] }).timelineChips;
const sumCases = (fixture as unknown as { chapterSummaries: SumCase[] }).chapterSummaries;

/** The entry `buildChipRequest` takes, reconstructed from the frozen fixture so
 *  the prompt bytes are the product's, not a copy that drifts. */
function chipEntry(c: ChipCase): ChapterGraphEntry {
  const n = c.candidates.length;
  return {
    chapterId: `lane-${c.id}`, chapterNumber: c.chapterNumber, chapterTitle: c.chapterTitle,
    contentHash: `lane-${c.id}`, tensionPeak: 0.82, charactersPresent: c.cast,
    majorEvents: c.candidates.map((x, i) => ({
      rank: x.rank, label: x.label, sentence: x.sentence, agent: x.agent,
      type: "action", channel: "action", tensionPosition: n > 1 ? i / (n - 1) : 0.5,
    })),
  } as unknown as ChapterGraphEntry;
}

// ── the wire under test (small tier) ────────────────────────────────────────
//
// The rich (max-tier) chip answer already rides a tuple wire — measured 120 →
// 72 generated tokens on the 4B. The small tier still emits keyed objects, so
// every pick spends `"rank":` and `"label":` on scaffolding that can never be
// content. Same trick, same decoder shape, one fewer field.

const TUPLE_SCHEMA = {
  type: "object",
  properties: {
    p: {
      type: "array", maxItems: CHIP_PICK_CAP,
      items: {
        type: "array",
        prefixItems: [{ type: "integer" }, { type: "string", maxLength: 72 }],
        minItems: 2, maxItems: 2,
      },
    },
  },
} as const;
const TUPLE_WIRE = `\n\nWIRE FORMAT: answer as {"p":[[rank,"label"], ...]} — each pick is an array of
the rank number then the label. Same content as described above, this shape.`;
const decodeTuple = (raw: unknown): unknown => {
  const p = (raw as { p?: unknown }).p;
  if (!Array.isArray(p)) return raw;
  return { picks: p.map((x) => (Array.isArray(x) ? { rank: x[0], label: x[1] } : x)) };
};

/**
 * ★ THE GRAMMAR IS CHECKED AGAINST THE WHOLE VOCABULARY AT EVERY SAMPLING STEP
 *   (llama.cpp's own documented behaviour), and Qwen3's vocabulary is 151,936
 *   tokens. `none` is the DIAGNOSTIC arm that prices that tax: same prompts,
 *   same token budget, no constraint. Its answers are unusable by design — it
 *   exists to say how much of decode is the grammar rather than the model.
 */
type GrammarMode = "pretty" | "compact" | "none";

interface Config {
  name: string;
  grammar: GrammarMode;
  tuple: boolean;
  /** Defer every repair call to the end of the chip drain instead of firing it
   *  inside the drain, where its foreign system prompt evicts the chip prefix. */
  repairLast: boolean;
  /** Diagnostic arm: answers are not expected to parse. */
  diagnostic?: boolean;
}
const ALL: Config[] = [
  { name: "base", grammar: "pretty", tuple: false, repairLast: false },
  { name: "nogrammar", grammar: "none", tuple: false, repairLast: false, diagnostic: true },
  { name: "compact", grammar: "compact", tuple: false, repairLast: false },
  { name: "compact+tuple", grammar: "compact", tuple: true, repairLast: false },
  { name: "compact+tuple+repairlast", grammar: "compact", tuple: true, repairLast: true },
];

// ── GPU-busy sampler ────────────────────────────────────────────────────────
//
// The Metal accelerator publishes its own utilisation counter in the IO
// registry. Integrating it over the lane gives GPU-milliseconds without sudo
// and without powermetrics — enough to tell "less GPU work" from "the same GPU
// work spread thinner", which is the distinction the goal actually names.

class GpuSampler {
  private timer: NodeJS.Timeout | null = null;
  private last = 0;
  private busyMs = 0;
  private samples = 0;
  private peak = 0;
  start() {
    this.last = Date.now();
    this.timer = setInterval(() => {
      execFile("ioreg", ["-r", "-d", "1", "-w", "0", "-c", "AGXAccelerator"], (err, stdout) => {
        const now = Date.now();
        const dt = now - this.last;
        this.last = now;
        if (err) return;
        const m = stdout.match(/"Device Utilization %"=(\d+)/);
        if (!m) return;
        const util = Number(m[1]);
        this.busyMs += (util / 100) * dt;
        this.peak = Math.max(this.peak, util);
        this.samples++;
      });
    }, 150);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return { gpuBusyMs: Math.round(this.busyMs), gpuSamples: this.samples, gpuPeakPct: this.peak };
  }
}

// ── one lane ────────────────────────────────────────────────────────────────

interface CallStat { task: string; id: string; prefillMs: number; genMs: number; wallMs: number; genTokens: number; promptTokens: number }

async function runLane(llama: Llama, model: LlamaModel, cfg: Config, label: string) {
  const context = await model.createContext({
    contextSize: CONTEXT_SIZE, sequences: 1, flashAttention: true,
  } as Parameters<typeof model.createContext>[0]);
  const sequence = context.getSequence();

  const grammarCache = new Map<string, LlamaGrammar>();
  const mkGrammar = async (schema: object): Promise<LlamaGrammar | null> => {
    if (cfg.grammar === "none") return null;
    const key = cfg.grammar + "|" + JSON.stringify(schema);
    const hit = grammarCache.get(key);
    if (hit) return hit;
    const g = cfg.grammar === "compact"
      ? await llama.createGrammar({
          grammar: getGbnfGrammarForGbnfJsonSchema(schema as never, { allowNewLines: false }),
          stopGenerationTriggers: [LlamaText(["\n".repeat(4)])],
          trimWhitespaceSuffix: true,
        })
      : await llama.createGrammarForJsonSchema(schema as never);
    grammarCache.set(key, g);
    return g;
  };

  const calls: CallStat[] = [];
  const call = async (
    task: string, id: string,
    req: { systemPrompt: string; userText: string; schema: object; maxTokens: number },
  ): Promise<unknown | null> => {
    const grammar = await mkGrammar(req.schema);
    // The host appends /no_think for this tier and builds a fresh session per
    // run on the SAME sequence. Both are load-bearing; copied exactly.
    const systemPrompt = `${req.systemPrompt}\n/no_think`;
    const session = new LlamaChatSession({
      contextSequence: sequence, systemPrompt, autoDisposeSequence: false,
    });
    let genTokens = 0; let firstAt = 0;
    const t0 = Date.now();
    const meta = await session.promptWithMeta(req.userText, {
      ...(grammar ? { grammar: grammar as never } : {}),
      maxTokens: req.maxTokens, temperature: 0,
      onToken: (t) => { if (!firstAt) firstAt = Date.now(); genTokens += Array.isArray(t) ? t.length : 1; },
    });
    const done = Date.now();
    calls.push({
      task, id,
      prefillMs: (firstAt || done) - t0,
      genMs: firstAt ? done - firstAt : 0,
      wallMs: done - t0,
      genTokens,
      promptTokens: model.tokenize(systemPrompt + req.userText).length,
    });
    session.dispose({ disposeSequence: false });
    if (!grammar) return null; // diagnostic arm: nothing to parse
    try {
      return cfg.grammar === "compact"
        ? JSON.parse(meta.responseText)
        : (grammar as unknown as { parse: (t: string) => unknown }).parse(meta.responseText);
    } catch {
      return null;
    }
  };

  const gpu = new GpuSampler();
  gpu.start();
  const laneStart = Date.now();

  // ── chips drain ──────────────────────────────────────────────────────────
  const chipsOut: Record<string, TimelineChipPick[]> = {};
  const pending: Array<{ id: string; picks: TimelineChipPick[]; needing: ChipCandidate[]; candidates: ChipCandidate[]; cast: string[] }> = [];
  let repairCalls = 0;

  for (const c of chipCases) {
    const entry = chipEntry(c);
    const req = buildChipRequest(entry);
    const useReq = cfg.tuple
      ? { ...req, systemPrompt: req.systemPrompt + TUPLE_WIRE, schema: TUPLE_SCHEMA as unknown as object }
      : req;
    const raw = await call("chips", c.id, useReq);
    if (raw === null) { chipsOut[c.id] = []; continue; }
    const answer = cfg.tuple ? decodeTuple(raw) : raw;
    const fallbacks = new Set<number>();
    const picks = normalizeChipPicks(answer, req.candidates, c.cast, fallbacks);
    if (!picks) { chipsOut[c.id] = []; continue; }
    const needing = picks
      .map((p) => req.candidates.find((x) => x.rank === p.rank))
      .filter((x): x is ChipCandidate => !!x)
      .filter((x) => fallbacks.has(x.rank));
    if (needing.length === 0) { chipsOut[c.id] = picks; continue; }
    if (cfg.repairLast) {
      pending.push({ id: c.id, picks, needing, candidates: req.candidates, cast: c.cast });
      chipsOut[c.id] = picks;
    } else {
      const rr = buildChipRepairRequest(needing);
      repairCalls++;
      const rraw = await call("repair", c.id, rr);
      chipsOut[c.id] = rraw ? applyChipRepairs(picks, rraw, req.candidates, c.cast) : picks;
    }
  }
  for (const p of pending) {
    const rr = buildChipRepairRequest(p.needing);
    repairCalls++;
    const rraw = await call("repair", p.id, rr);
    if (rraw) chipsOut[p.id] = applyChipRepairs(p.picks, rraw, p.candidates, p.cast);
  }

  // ── summaries drain ──────────────────────────────────────────────────────
  const sumsOut: Record<string, { summary: string; throughline?: string } | null> = {};
  for (const s of sumCases) {
    const entry = chipEntry(chipCases.find((c) => c.id === s.id)!);
    const req = buildSummaryRequest(entry);
    // The summary prompt is built from the SUMMARY fixture's own offered
    // sentences, which is what the product sends; use the fixture bytes.
    const raw = await call("summary", s.id, {
      systemPrompt: s.systemPrompt, userText: s.userText,
      schema: req.schema as unknown as object, maxTokens: s.maxTokens,
    });
    sumsOut[s.id] = raw ? normalizeSummary(raw) : null;
  }

  const laneMs = Date.now() - laneStart;
  const g = gpu.stop();
  await new Promise((r) => setTimeout(r, 300)); // let the last sample land

  sequence.dispose();
  await context.dispose();

  const sum = (f: (c: CallStat) => number) => calls.reduce((a, c) => a + f(c), 0);
  const stats = {
    config: cfg.name, pass: label,
    laneMs,
    calls: calls.length,
    repairCalls,
    prefillMs: sum((c) => c.prefillMs),
    genMs: sum((c) => c.genMs),
    genTokens: sum((c) => c.genTokens),
    promptTokens: sum((c) => c.promptTokens),
    ...g,
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    perCall: calls,
  };
  return { stats, chips: chipsOut, sums: sumsOut };
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(MODEL_PATH)) { console.log("SKIP — small model not on disk."); return; }
  const only = (process.argv.find((a) => a.startsWith("--configs="))?.split("=")[1] ?? "").split(",").filter(Boolean);
  const configs = only.length ? ALL.filter((c) => only.includes(c.name)) : ALL;

  const llama = await getLlama({ build: "never", logLevel: "warn" });
  const model = await llama.loadModel({ modelPath: MODEL_PATH, gpuLayers: "max", useMmap: true });

  const results: Array<Record<string, unknown>> = [];
  const answers: Record<string, unknown> = {};
  for (const cfg of configs) {
    console.log(`\n═══ ${cfg.name}`);
    for (let i = 0; i < REPEATS + 1; i++) {
      const label = i === 0 ? "cold" : `warm${i}`;
      const r = await runLane(llama, model, cfg, label);
      const s = r.stats;
      console.log(
        `  ${label.padEnd(6)} lane=${(s.laneMs / 1000).toFixed(1)}s  calls=${s.calls} (repair ${s.repairCalls})  ` +
        `prefill=${s.prefillMs}ms gen=${s.genMs}ms  genTok=${s.genTokens} promptTok=${s.promptTokens}  ` +
        `gpuBusy=${s.gpuBusyMs}ms  rss=${s.rssMb}MB`,
      );
      results.push(s);
      if (label !== "cold") answers[`${cfg.name}|${label}`] = { chips: r.chips, sums: r.sums };
      else answers[`${cfg.name}|cold`] = { chips: r.chips, sums: r.sums };
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    model: path.basename(MODEL_PATH), contextSize: CONTEXT_SIZE,
    labelMax: CHIP_LABEL_MAX, results, answers,
  }, null, 2));
  console.log(`\nwrote ${OUT}`);

  await model.dispose();
}

await main();
