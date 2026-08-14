/**
 * probe-lane-session.ts — a writing session, replayed through the real model.
 *
 * probe-lane-staleness counts the inferences each cache key ORDERS.
 * probe-timeline-lane measures what one lane pass COSTS. This joins them: it
 * builds the exact ordered call list a session produces under each key, then
 * replays both lists through the real 1.7B on one context sequence — the same
 * session pattern the host uses, so the prefix cache behaves as it does in the
 * app — and reports the wall time, the GPU-busy time and the token counts.
 *
 * ★ THE ORDER IS THE MEASUREMENT, not a detail of it. A request whose system
 *   prompt differs from the one before it diverges at token zero and pays a
 *   FULL re-prefill; the chip prompt is ~911 tokens, which is ~1.3s of it. The
 *   old key moved both tasks on every keystroke that changed the chapter's
 *   length, so the lane alternated chips/summary/chips/summary and paid that
 *   re-prefill on every single call. Counting calls alone would miss this
 *   entirely, and it is roughly half the win.
 *
 *   ./node_modules/.bin/tsx scripts/probe-lane-session.ts
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { getLlama, LlamaChatSession } from "node-llama-cpp";
import type { Llama, LlamaModel, LlamaGrammar } from "node-llama-cpp";
import { analyzeChapter } from "../src/lib/chapter-analysis";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { buildChapterEntry } from "../src/lib/story-graph";
import { resolveKnownNames } from "../src/lib/world-data";
import { buildChipRequest, chipKeyFor, eventFingerprint, CHIP_PROMPT_VERSION } from "../src/lib/chip-picker";
import { buildSummaryRequest, summaryKeyFor, SUMMARY_PROMPT_VERSION } from "../src/lib/chapter-summary";
import { fnv1a } from "../src/lib/evidence-pack";
import { loadBook, splitParagraphs } from "./print-chapter";
import type { Chapter, Novel, ChapterGraphEntry } from "../src/types";

void pathToFileURL;
const MODEL_PATH = path.join(
  os.homedir(), "Library/Application Support/Latent Write/models/Qwen3-1.7B-Q4_K_M.gguf",
);
const MODEL_ID = "qwen3-1.7b-q4_k_m";
const BOOK = process.env.LANE_BOOK ?? "gatsby";
const MAX_CALLS = Number(process.env.LANE_MAX_CALLS) || 40;
const OUT = path.join(process.cwd(), "bench-results", "timeline-lane-session.json");

const legacyKey = (entry: ChapterGraphEntry, version: number) =>
  fnv1a(`${entry.contentHash}|${eventFingerprint(entry.majorEvents)}|${MODEL_ID}|v${version}`);

function entryFor(chapter: Chapter, novel: Novel): ChapterGraphEntry {
  const paragraphs = splitParagraphs(chapter.content);
  const knownNames = resolveKnownNames(novel);
  const speechResults = detectSpeechInChapter(paragraphs, knownNames, { intelligenceLevel: "default" });
  const analysis = analyzeChapter(paragraphs, speechResults, []);
  return buildChapterEntry(
    chapter,
    { paragraphs, speechResults, speechPredictions: [], actionPredictions: [], analysis, endContext: null } as never,
    novel.worldData,
  );
}

interface Call { task: "chips" | "summary"; systemPrompt: string; userText: string; schema: object; maxTokens: number }

/** The ordered calls one key policy orders across a session. */
function callsFor(policy: "old" | "new", states: ChapterGraphEntry[]): Call[] {
  const out: Call[] = [];
  let chipKey: string | null = null;
  let sumKey: string | null = null;
  for (const entry of states) {
    const ck = policy === "old" ? legacyKey(entry, CHIP_PROMPT_VERSION) : chipKeyFor(entry, MODEL_ID);
    const sk = policy === "old" ? legacyKey(entry, SUMMARY_PROMPT_VERSION) : summaryKeyFor(entry, MODEL_ID);
    // App.tsx drains every stale CHIP before any summary, so within one
    // rebuild the chip call comes first.
    const chipReq = buildChipRequest(entry);
    if (chipReq.candidates.length > 0 && ck !== chipKey) {
      out.push({ task: "chips", systemPrompt: chipReq.systemPrompt, userText: chipReq.userText, schema: chipReq.schema, maxTokens: chipReq.maxTokens });
      chipKey = ck;
    }
    if (entry.majorEvents.length > 0 && sk !== sumKey) {
      const sumReq = buildSummaryRequest(entry);
      out.push({ task: "summary", systemPrompt: sumReq.systemPrompt, userText: sumReq.userText, schema: sumReq.schema, maxTokens: sumReq.maxTokens });
      sumKey = sk;
    }
  }
  return out;
}

class GpuSampler {
  private timer: NodeJS.Timeout | null = null;
  private last = 0;
  private busyMs = 0;
  start() {
    this.last = Date.now();
    this.timer = setInterval(() => {
      execFile("ioreg", ["-r", "-d", "1", "-w", "0", "-c", "AGXAccelerator"], (err, stdout) => {
        const now = Date.now();
        const dt = now - this.last;
        this.last = now;
        if (err) return;
        const m = stdout.match(/"Device Utilization %"=(\d+)/);
        if (m) this.busyMs += (Number(m[1]) / 100) * dt;
      });
    }, 150);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; return Math.round(this.busyMs); }
}

async function replay(llama: Llama, model: LlamaModel, calls: Call[], label: string) {
  const context = await model.createContext({
    contextSize: 4096, sequences: 1, flashAttention: true,
  } as Parameters<typeof model.createContext>[0]);
  const sequence = context.getSequence();
  const grammars = new Map<string, LlamaGrammar>();

  const gpu = new GpuSampler();
  gpu.start();
  const t0 = Date.now();
  let prefillMs = 0, genMs = 0, genTokens = 0, reprefills = 0;
  let lastSystem = "";

  for (const call of calls) {
    const gkey = JSON.stringify(call.schema);
    let grammar = grammars.get(gkey);
    if (!grammar) { grammar = await llama.createGrammarForJsonSchema(call.schema as never); grammars.set(gkey, grammar); }
    const systemPrompt = `${call.systemPrompt}\n/no_think`;
    if (systemPrompt !== lastSystem) reprefills++;
    lastSystem = systemPrompt;
    const session = new LlamaChatSession({ contextSequence: sequence, systemPrompt, autoDisposeSequence: false });
    let firstAt = 0;
    const c0 = Date.now();
    await session.promptWithMeta(call.userText, {
      grammar: grammar as never, maxTokens: call.maxTokens, temperature: 0,
      onToken: (t) => { if (!firstAt) firstAt = Date.now(); genTokens += Array.isArray(t) ? t.length : 1; },
    });
    const done = Date.now();
    prefillMs += (firstAt || done) - c0;
    genMs += firstAt ? done - firstAt : 0;
    session.dispose({ disposeSequence: false });
  }

  const wallMs = Date.now() - t0;
  const gpuBusyMs = gpu.stop();
  await new Promise((r) => setTimeout(r, 300));
  sequence.dispose();
  await context.dispose();

  const stats = { label, calls: calls.length, systemPromptReprefills: reprefills, wallMs, prefillMs, genMs, genTokens, gpuBusyMs };
  console.log(
    `  ${label.padEnd(4)} calls=${String(stats.calls).padStart(3)}  ` +
    `full re-prefills=${String(reprefills).padStart(3)}  ` +
    `wall=${(wallMs / 1000).toFixed(1)}s  prefill=${(prefillMs / 1000).toFixed(1)}s  gen=${(genMs / 1000).toFixed(1)}s  ` +
    `genTok=${genTokens}  gpuBusy=${(gpuBusyMs / 1000).toFixed(1)}s`,
  );
  return stats;
}

async function main() {
  if (!fs.existsSync(MODEL_PATH)) { console.log("SKIP — small model not on disk."); return; }
  const novel = await loadBook(BOOK);
  const chapter = novel.chapters.filter((c) => c.content.length > 3000)[0];
  console.log(`\nsession: ${BOOK} ch.${chapter.number} — drafting forward, then revising\n`);

  // The states a session walks through: written forward from 70%, then a run
  // of local revisions on the finished chapter.
  const states: ChapterGraphEntry[] = [];
  const full = chapter.content;
  const start = Math.floor(full.length * 0.7);
  for (let i = 0; i <= 10; i++) {
    const cut = start + Math.floor(((full.length - start) * i) / 10);
    states.push(entryFor({ ...chapter, content: full.slice(0, cut) }, novel));
  }
  const paras = full.split(/\n\n+/);
  const mid = Math.floor(paras.length / 2);
  const revisions = [
    () => { const p = [...paras]; p[mid] = `${p[mid]} The room was colder than it had been.`; return p.join("\n\n"); },
    () => `${full} `,
    () => { const p = [...paras]; p[mid] = p[mid].replace(/\bthe\b/, "teh"); return p.join("\n\n"); },
    () => { const p = [...paras]; p[mid + 1] = p[mid + 1]?.replace(/\b(said|asked|replied)\b/, "$1 quietly") ?? p[mid + 1]; return p.join("\n\n"); },
    () => { const p = [...paras]; p.splice(mid, 0, "She waited, and the light did not change."); return p.join("\n\n"); },
  ];
  for (const make of revisions) states.push(entryFor({ ...chapter, content: make() }, novel));

  const oldCalls = callsFor("old", states).slice(0, MAX_CALLS);
  const newCalls = callsFor("new", states).slice(0, MAX_CALLS);
  console.log(`  ${states.length} rebuilds → old key orders ${callsFor("old", states).length} calls, new key orders ${callsFor("new", states).length}`);
  console.log(`  replaying the first ${MAX_CALLS} of each\n`);

  const llama = await getLlama({ build: "never", logLevel: "warn" });
  const model = await llama.loadModel({ modelPath: MODEL_PATH, gpuLayers: "max", useMmap: true });

  // Old first, then new, then old again: the machine's thermal and page-cache
  // state drifts over a run, and a single A/B cannot tell that from the change.
  const a = await replay(llama, model, oldCalls, "old");
  const b = await replay(llama, model, newCalls, "new");
  const c = await replay(llama, model, oldCalls, "old");
  await model.dispose();

  const oldWall = (a.wallMs + c.wallMs) / 2;
  const oldGpu = (a.gpuBusyMs + c.gpuBusyMs) / 2;
  const pct = (from: number, to: number) => `${(100 - (to / from) * 100).toFixed(0)}%`;
  console.log(`\n  ── bracketed (old runs either side of new)`);
  console.log(`     wall     ${(oldWall / 1000).toFixed(1)}s → ${(b.wallMs / 1000).toFixed(1)}s   -${pct(oldWall, b.wallMs)}`);
  console.log(`     gpu busy ${(oldGpu / 1000).toFixed(1)}s → ${(b.gpuBusyMs / 1000).toFixed(1)}s   -${pct(oldGpu, b.gpuBusyMs)}`);
  console.log(`     per call ${(oldWall / a.calls).toFixed(0)}ms → ${(b.wallMs / b.calls).toFixed(0)}ms   -${pct(oldWall / a.calls, b.wallMs / b.calls)}\n`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ book: BOOK, chapter: chapter.number, states: states.length, runs: [a, b, c] }, null, 2));
  console.log(`  wrote ${OUT}\n`);
}

await main();
