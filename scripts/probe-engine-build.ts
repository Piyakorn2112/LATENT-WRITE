/**
 * probe-engine-build.ts — is a newer llama.cpp faster on OUR configuration,
 * and does it say the same thing?
 *
 * The engine is a PIN (assistant-sidecar.cjs ENGINE), and the version-pull
 * convention in plans/engine-speed-2026-08.md says a bump is a measurement,
 * not an upgrade. This is that measurement, one level below verify:engine:
 * it spawns each candidate llama-server directly with the SHIPPED argument
 * list, fires the product's own chip and summary requests through the
 * product's own compact grammars at temperature 0, and reports decode tok/s,
 * prefill tok/s and a sha256 of every answer.
 *
 * ★ BRACKETED A / B / A. The Metal GPU throttles and the page cache warms, so
 *   a straight A-then-B comparison cannot tell a faster kernel from a cooler
 *   machine. The old build runs again at the end; if the two A columns
 *   disagree by more than the A-B gap, the result is drift and nothing else.
 *
 * ★ TOK/S IS NOT THE VERDICT ON ITS OWN. Every answer's bytes are hashed and
 *   compared across builds. A build that is faster and says something else has
 *   changed the model's behaviour, which is the one thing this round may not
 *   do, so it is reported as a QUALITY DIFF and not as a win.
 *
 *   ./node_modules/.bin/tsx scripts/probe-engine-build.ts
 *   ENGINE_BUILDS=llama-b10298,llama-b10472 ... (dirs under the engine root)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { buildChipRequest, CHIP_RICH_GBNF } from "../src/lib/chip-picker";
import { buildSummaryRequest, SUMMARY_GBNF } from "../src/lib/chapter-summary";
import fixture from "./fixtures/assistant-tasks.json";
import type { ChapterGraphEntry } from "../src/types";

const SUPPORT = path.join(os.homedir(), "Library/Application Support/Latent Write");
const MODEL = path.join(SUPPORT, "models/Qwen3-4B-Thinking-2507-Q4_K_M.gguf");
const ENGINE_ROOT = path.join(SUPPORT, "engine");
const BUILDS = (process.env.ENGINE_BUILDS || "llama-b10298,llama-b10472").split(",");
const REPEATS = Number(process.env.ENGINE_REPEATS) || 2;
const OUT = path.join(process.cwd(), "bench-results", "engine-build.json");

// ── the request set: the product's builders on the frozen fixture ───────────

interface ChipCase {
  id: string; chapterNumber: number; chapterTitle: string; cast: string[];
  candidates: Array<{ rank: number; label: string; sentence: string; agent?: string }>;
}
interface SumCase {
  id: string; chapterNumber: number; chapterTitle: string; cast: string[]; offered: string[];
}
const chipCases = (fixture as unknown as { timelineChips: ChipCase[] }).timelineChips;
const sumCases = (fixture as unknown as { chapterSummaries: SumCase[] }).chapterSummaries;

function chipEntry(c: ChipCase): ChapterGraphEntry {
  const n = c.candidates.length;
  return {
    chapterId: `eb-${c.id}`, chapterNumber: c.chapterNumber, chapterTitle: c.chapterTitle,
    contentHash: `eb-${c.id}`, tensionPeak: 0.82, charactersPresent: c.cast,
    majorEvents: c.candidates.map((x, i) => ({
      rank: x.rank, label: x.label, sentence: x.sentence, agent: x.agent,
      type: "action", channel: "action", tensionPosition: n > 1 ? i / (n - 1) : 0.5,
    })),
  } as unknown as ChapterGraphEntry;
}
function sumEntry(c: SumCase): ChapterGraphEntry {
  const n = c.offered.length;
  return {
    chapterId: `eb-s-${c.id}`, chapterNumber: c.chapterNumber, chapterTitle: c.chapterTitle,
    contentHash: `eb-s-${c.id}`, tensionPeak: 0.8, charactersPresent: c.cast,
    majorEvents: c.offered.map((sentence, i) => ({
      rank: i, label: sentence.slice(0, 38), sentence,
      type: "action", channel: "action", tensionPosition: n > 1 ? i / (n - 1) : 0.5,
    })),
  } as unknown as ChapterGraphEntry;
}

interface Req { label: string; systemPrompt: string; userText: string; gbnf: string; maxTokens: number }
const REQS: Req[] = [
  ...chipCases.map((c) => {
    // rich: the max-tier wire, which is what the sidecar serves.
    const r = buildChipRequest(chipEntry(c), { rich: true });
    return { label: `chip/${c.id}`, systemPrompt: r.systemPrompt, userText: r.userText, gbnf: CHIP_RICH_GBNF, maxTokens: r.maxTokens };
  }),
  ...sumCases.map((c) => {
    const r = buildSummaryRequest(sumEntry(c));
    return { label: `summary/${c.id}`, systemPrompt: r.systemPrompt, userText: r.userText, gbnf: SUMMARY_GBNF, maxTokens: r.maxTokens };
  }),
];

// ── the engine, spawned exactly the way the sidecar spawns it ───────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The shipped argument list (assistant-sidecar.cjs), 4 slots x 2048. */
function serverArgs(port: number): string[] {
  return [
    "-m", MODEL,
    "-c", String(4 * 2048),
    "-np", "4",
    "-fa", "on",
    "-ctk", "q8_0",
    "-ctv", "q8_0",
    "-kvu",
    "-ub", "128",
    "--cache-ram", "512",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--no-webui",
  ];
}

async function startServer(buildDir: string, port: number): Promise<ChildProcess> {
  const bin = path.join(ENGINE_ROOT, buildDir, "llama-server");
  if (!fs.existsSync(bin)) throw new Error(`no binary: ${bin}`);
  const child = spawn(bin, serverArgs(port), { stdio: ["ignore", "ignore", "pipe"] });
  let tail = "";
  child.stderr.on("data", (d) => { tail = (tail + String(d)).slice(-4000); });
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}\n${tail}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return child;
    } catch { /* not up */ }
    await sleep(250);
  }
  child.kill("SIGKILL");
  throw new Error(`server never became healthy\n${tail}`);
}

/** The sidecar's own prompt template and body. */
const template = (systemPrompt: string, userText: string) =>
  `<|im_start|>system\n${systemPrompt}\n/no_think<|im_end|>\n` +
  `<|im_start|>user\n${userText}<|im_end|>\n` +
  `<|im_start|>assistant\n<think>\n\n</think>\n\n`;

interface Timing { promptN: number; promptMs: number; predN: number; predMs: number }
interface Answer { label: string; content: string; sha: string; t: Timing; wallMs: number }

async function ask(port: number, req: Req): Promise<Answer> {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/completion`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: template(req.systemPrompt, req.userText),
      grammar: req.gbnf,
      stop: ["\n\n\n\n"],
      temperature: 0,
      n_predict: req.maxTokens,
      cache_prompt: true,
      stream: false,
    }),
  });
  const payload = await res.json() as {
    content: string;
    timings: { prompt_n: number; prompt_ms: number; predicted_n: number; predicted_ms: number };
  };
  const content = String(payload.content ?? "");
  return {
    label: req.label,
    content,
    sha: crypto.createHash("sha256").update(content).digest("hex").slice(0, 16),
    t: {
      promptN: payload.timings.prompt_n, promptMs: payload.timings.prompt_ms,
      predN: payload.timings.predicted_n, predMs: payload.timings.predicted_ms,
    },
    wallMs: Date.now() - t0,
  };
}

interface RunResult {
  build: string; pass: number;
  answers: Answer[];
  decodeTokPerSec: number; prefillTokPerSec: number;
  serialWallMs: number; waveWallMs: number; waveTokPerSec: number;
}

async function measure(buildDir: string, pass: number): Promise<RunResult> {
  const port = 49000 + Math.floor(Math.random() * 900);
  const child = await startServer(buildDir, port);
  try {
    // Warm every prefix family once: the product never pays a cold prefix
    // twice for the same task type, so measuring one would measure a state
    // the app does not live in.
    for (const r of REQS) await ask(port, r);

    const answers: Answer[] = [];
    const serial0 = Date.now();
    for (let i = 0; i < REPEATS; i++) for (const r of REQS) answers.push(await ask(port, r));
    const serialWallMs = Date.now() - serial0;

    // Concurrency is the sidecar's headline win; a kernel change can move the
    // batched number without moving the single-stream one.
    const wave0 = Date.now();
    const wave = await Promise.all(REQS.slice(0, 4).map((r) => ask(port, r)));
    const waveWallMs = Date.now() - wave0;

    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    return {
      build: buildDir, pass, answers,
      decodeTokPerSec: (sum(answers.map((a) => a.t.predN)) / sum(answers.map((a) => a.t.predMs))) * 1000,
      prefillTokPerSec: (sum(answers.map((a) => a.t.promptN)) / Math.max(1, sum(answers.map((a) => a.t.promptMs)))) * 1000,
      serialWallMs,
      waveWallMs,
      waveTokPerSec: (sum(wave.map((a) => a.t.predN)) / waveWallMs) * 1000,
    };
  } finally {
    child.kill("SIGKILL");
    await sleep(1500); // let the port and the GPU settle before the next build
  }
}

// ── run: A, B, A ────────────────────────────────────────────────────────────

const order = [BUILDS[0], ...BUILDS.slice(1), BUILDS[0]];
console.log(`model : ${path.basename(MODEL)}`);
console.log(`builds: ${order.join(" → ")}   (${REQS.length} requests x ${REPEATS} repeats)\n`);

const results: RunResult[] = [];
for (let i = 0; i < order.length; i++) {
  process.stdout.write(`  ${order[i]} pass ${i + 1} … `);
  const r = await measure(order[i], i + 1);
  results.push(r);
  console.log(`decode ${r.decodeTokPerSec.toFixed(1)} tok/s  prefill ${r.prefillTokPerSec.toFixed(0)} tok/s  serial ${(r.serialWallMs / 1000).toFixed(1)}s  wave ${(r.waveWallMs / 1000).toFixed(1)}s`);
}

console.log("");
const head = ["build", "pass", "decode tok/s", "prefill tok/s", "serial s", "wave s", "wave tok/s"];
console.log(head.map((h, i) => h.padEnd(i === 0 ? 16 : 14)).join(""));
for (const r of results) {
  console.log([
    r.build, String(r.pass), r.decodeTokPerSec.toFixed(1), r.prefillTokPerSec.toFixed(0),
    (r.serialWallMs / 1000).toFixed(1), (r.waveWallMs / 1000).toFixed(1), r.waveTokPerSec.toFixed(1),
  ].map((v, i) => String(v).padEnd(i === 0 ? 16 : 14)).join(""));
}

// ── the two verdicts ────────────────────────────────────────────────────────

const a1 = results[0];
const a2 = results[results.length - 1];
const b = results[1];
const drift = Math.abs(a2.decodeTokPerSec - a1.decodeTokPerSec) / a1.decodeTokPerSec;
const gain = (b.decodeTokPerSec - (a1.decodeTokPerSec + a2.decodeTokPerSec) / 2) / ((a1.decodeTokPerSec + a2.decodeTokPerSec) / 2);
console.log(`\ndecode: ${b.build} is ${(gain * 100).toFixed(1)}% vs ${a1.build} (bracket drift ${(drift * 100).toFixed(1)}%)`);
console.log(gain > 0 && Math.abs(gain) > drift
  ? "  → the gap is larger than the drift: a real difference"
  : "  → the gap is inside the bracket drift: NOT a result");

// Byte identity, per request, old vs new.
const byLabel = (r: RunResult) => {
  const m = new Map<string, string>();
  for (const a of r.answers) if (!m.has(a.label)) m.set(a.label, a.sha);
  return m;
};
const oldSha = byLabel(a1);
const newSha = byLabel(b);
const diffs = [...oldSha.keys()].filter((k) => oldSha.get(k) !== newSha.get(k));
console.log(`\nquality: ${oldSha.size - diffs.length}/${oldSha.size} answers byte-identical across builds`);
if (diffs.length) {
  console.log(`  DIFFERS: ${diffs.join(", ")}`);
  for (const k of diffs.slice(0, 2)) {
    console.log(`\n  ${k}\n    ${a1.build}: ${a1.answers.find((x) => x.label === k)!.content.slice(0, 220)}`);
    console.log(`    ${b.build}: ${b.answers.find((x) => x.label === k)!.content.slice(0, 220)}`);
  }
}
// Self-consistency: the same build must repeat itself, or nothing above holds.
const selfStable = [...oldSha.keys()].every((k) => oldSha.get(k) === byLabel(a2).get(k));
console.log(`  determinism control: ${a1.build} repeated itself ${selfStable ? "exactly" : "NOT exactly — temp-0 is not deterministic here"}`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, order, results }, null, 2));
console.log(`\nwrote ${OUT}\n`);
