/**
 * probe-spec-decode.ts — speculative decoding on the SIDECAR engine, where
 * the old refutation does not apply.
 *
 * ★ WHY THIS IS NOT A RE-LITIGATION. Both speculative families were recorded
 *   dead in plans/engine-speed-2026-08.md, and both verdicts were measured on
 *   node-llama-cpp: prompt-lookup at +18%, and a 1.7B drafting the 4B at 4x
 *   slower with the binding printing "pushed tokens are incompatible with the
 *   grammar evaluation state. The grammar will be ignored". That last line is
 *   a statement about THAT BINDING's draft predictor, not about llama.cpp.
 *   The sidecar arrived afterwards and inherited the verdict untested, and
 *   llama-server carries its own implementations behind --spec-type
 *   (ngram-simple, ngram-map-k, ngram-map-k4v, ngram-mod, ngram-cache, and
 *   draft-simple). The ngram family needs no second model and therefore no
 *   memory, which is the constraint that killed the draft idea before.
 *
 * ★ WHY IT SHOULD WORK HERE. Under greedy sampling the target model verifies
 *   every drafted token, so accepted output is identical by construction, and
 *   our lane runs at temperature 0. And the chip answers largely QUOTE the
 *   prompt: the labels the model picks are the candidate labels it was shown.
 *   Text that already exists in the context is exactly what an n-gram drafter
 *   predicts for free.
 *
 * ★ THE MEASUREMENT IS PAIRED, because the machine drifts. A bracketed
 *   A/B/A on this M1 Pro measured 8.4% decay across three passes of the SAME
 *   build — larger than most effects worth shipping. So every candidate runs
 *   adjacent to a fresh baseline pass and is judged on the within-pair delta,
 *   never on an absolute number from a different minute.
 *
 * ★★ EAGER SETTINGS ARE THE ONES THAT BREAK, AND THEY BREAK THE SAME WAY.
 *    Two configurations have now produced a changed answer: -n-min 24/-n-max
 *    32, and -n-match 20. Both are short/eager, both diverged on the SAME
 *    fixture (summary/trap), and both produced CHARACTER-FOR-CHARACTER the
 *    same wrong summary. That rules out noise: it is a deterministic wrong
 *    branch that eager copying takes. Greedy verification says this cannot
 *    happen, so the guarantee leaks in llama.cpp somewhere along that path.
 *    Treat any setting more eager than the shipped one as guilty until a
 *    byte comparison says otherwise.
 *
 * ★  SURFACES DIFFER, SO THE GATE RUNS BOTH (SPEC_SET=lane|writing). The
 *    timeline lane wants a LONG match (12→+24%, 20→+43%, 32→+111%,
 *    48→+139%, 64→+141%); the writing tools peak lower (20→+123%,
 *    48→+106%). Two conditions decide whether a request gains at all:
 *    the answer must genuinely repeat a long run from the context, AND the
 *    match threshold must be short enough to be met inside an answer that
 *    length. Proofreading CLEAN prose quotes everything and still gains
 *    nothing at match 48, because a 44-token answer cannot satisfy a
 *    48-token match; the rewrite op composes new prose and gains nothing at
 *    ANY setting. The lane's number wins the tie because match 20 is
 *    disqualified on correctness regardless.
 *
 *   ./node_modules/.bin/tsx scripts/probe-spec-decode.ts
 *   SPEC_CONFIGS=base,ngram-mod SPEC_ROUNDS=2 ... (paired confirmation)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { buildChipRequest, CHIP_RICH_GBNF } from "../src/lib/chip-picker";
import { buildSummaryRequest, SUMMARY_GBNF } from "../src/lib/chapter-summary";
import { buildWritingRequest, planWritingBatches } from "../src/lib/writing-tool";
import { REWRITE_CASES } from "./fixtures/ask-rewrite-reference";
import { pathToFileURL } from "node:url";
import fixture from "./fixtures/assistant-tasks.json";
import type { ChapterGraphEntry } from "../src/types";

const SUPPORT = path.join(os.homedir(), "Library/Application Support/Latent Write");
/** ★ THE SMALL TIER IS NOT JUST A SMALLER MODEL, IT IS A DIFFERENT KV POLICY.
 *  Q8_0 KV was measured CHANGING AN ANSWER on the 1.7B (probe:kv-cache), so
 *  the registry leaves it at f16 there while the 4B runs Q8_0. A probe that
 *  inherited the 4B's flags would be measuring a configuration the app is
 *  forbidden to ship. */
const SMALL = process.env.SPEC_MODEL === "small";
const MODEL = path.join(SUPPORT, SMALL
  ? "models/Qwen3-1.7B-Q4_K_M.gguf"
  : "models/Qwen3-4B-Thinking-2507-Q4_K_M.gguf");
const DRAFT = process.env.SPEC_DRAFT_MODEL || path.join(SUPPORT, "models/Qwen3-0.6B-Q4_K_M.gguf");
const ENGINE = path.join(SUPPORT, "engine", process.env.SPEC_BUILD || "llama-b10298", "llama-server");
const ROUNDS = Number(process.env.SPEC_ROUNDS) || 1;
const OUT = path.join(process.cwd(), "bench-results", "spec-decode.json");

/** Server-start flag sets. `base` is the shipped configuration, unchanged. */
const CONFIGS: Record<string, string[]> = {
  base: [],
  "ngram-simple": ["--spec-type", "ngram-simple"],
  "ngram-cache": ["--spec-type", "ngram-cache"],
  "ngram-map-k": ["--spec-type", "ngram-map-k"],
  "ngram-map-k4v": ["--spec-type", "ngram-map-k4v"],
  "ngram-mod": ["--spec-type", "ngram-mod"],
  // ngram-mod's own knobs: how long a match it needs, and how much it drafts.
  "mod-match6": ["--spec-type", "ngram-mod", "--spec-ngram-mod-n-match", "6"],
  "mod-match12": ["--spec-type", "ngram-mod", "--spec-ngram-mod-n-match", "12"],
  "mod-match20": ["--spec-type", "ngram-mod", "--spec-ngram-mod-n-match", "20"],
  // The configuration the sidecar actually ships. Named so --gate can ask
  // for it by name and the table reads the same as the shipped flags.
  shipped: ["--spec-type", "ngram-mod", "--spec-ngram-mod-n-match", "48"],
  "mod-match32": ["--spec-type", "ngram-mod", "--spec-ngram-mod-n-match", "32"],
  // ★ match32 beat the default by a wide margin, so the trend gets followed
  //   rather than assumed to stop where the first sweep happened to land.
  "mod-match40": ["--spec-type", "ngram-mod", "--spec-ngram-mod-n-match", "40"],
  "mod-match48": ["--spec-type", "ngram-mod", "--spec-ngram-mod-n-match", "48"],
  "mod-match64": ["--spec-type", "ngram-mod", "--spec-ngram-mod-n-match", "64"],
  // ★ THE SAFE DIRECTION. Every configuration that has corrupted an answer was
  //   EAGER (short match, short draft). If the leak is in the rejection path,
  //   a LESS eager setting drafts only where it is confident and should stop
  //   exercising it. Tested on the small tier, where the shipped 48 corrupts
  //   3 of 8.
  "mod-match96": ["--spec-type", "ngram-mod", "--spec-ngram-mod-n-match", "96"],
  "mod-match128": ["--spec-type", "ngram-mod", "--spec-ngram-mod-n-match", "128"],
  "mod-match192": ["--spec-type", "ngram-mod", "--spec-ngram-mod-n-match", "192"],
  "mod-n32": ["--spec-type", "ngram-mod", "--spec-ngram-mod-n-min", "24", "--spec-ngram-mod-n-max", "32"],
  "mod-n96": ["--spec-type", "ngram-mod", "--spec-ngram-mod-n-min", "64", "--spec-ngram-mod-n-max", "96"],
  "mod+simple": ["--spec-type", "ngram-mod,ngram-simple"],
  "draft-0.6b": ["--spec-type", "draft-simple", "-md", DRAFT, "-ngld", "99", "-ctkd", "q8_0", "-ctvd", "q8_0"],
};
/** The surface under test. The lane was measured first because it is the
 *  highest-volume path; the writing tools are the interesting one, because a
 *  proofread hands back the writer's own paragraph with a few fixes in it,
 *  which is the most quotable output the app produces. */
const SET = process.env.SPEC_SET || "lane";

// The compact grammar generator the host reaches past the exports map for.
// The sidecar autogenerates the same grammar for any jsonStyle:'compact' call
// without a hand-built gbnf, so a probe that skipped it would be measuring a
// different constraint than the app runs under.
const { getGbnfGrammarForGbnfJsonSchema } = (await import(pathToFileURL(
  path.join(process.cwd(), "node_modules/node-llama-cpp/dist/utils/gbnfJson/getGbnfGrammarForGbnfJsonSchema.js"),
).href)) as { getGbnfGrammarForGbnfJsonSchema: (schema: never, opts?: { allowNewLines?: boolean }) => string };
const gbnfFor = (schema: object) => getGbnfGrammarForGbnfJsonSchema(schema as never, { allowNewLines: false });

const WANT = (process.env.SPEC_CONFIGS || "base,ngram-simple,ngram-cache,ngram-map-k,ngram-map-k4v,ngram-mod").split(",");

// ── request set: the product's own builders on the frozen fixture ───────────

interface ChipCase {
  id: string; chapterNumber: number; chapterTitle: string; cast: string[];
  candidates: Array<{ rank: number; label: string; sentence: string; agent?: string }>;
}
interface SumCase { id: string; chapterNumber: number; chapterTitle: string; cast: string[]; offered: string[] }
const chipCases = (fixture as unknown as { timelineChips: ChipCase[] }).timelineChips;
const sumCases = (fixture as unknown as { chapterSummaries: SumCase[] }).chapterSummaries;

function chipEntry(c: ChipCase): ChapterGraphEntry {
  const n = c.candidates.length;
  return {
    chapterId: `sd-${c.id}`, chapterNumber: c.chapterNumber, chapterTitle: c.chapterTitle,
    contentHash: `sd-${c.id}`, tensionPeak: 0.82, charactersPresent: c.cast,
    majorEvents: c.candidates.map((x, i) => ({
      rank: x.rank, label: x.label, sentence: x.sentence, agent: x.agent,
      type: "action", channel: "action", tensionPosition: n > 1 ? i / (n - 1) : 0.5,
    })),
  } as unknown as ChapterGraphEntry;
}
function sumEntry(c: SumCase): ChapterGraphEntry {
  const n = c.offered.length;
  return {
    chapterId: `sd-s-${c.id}`, chapterNumber: c.chapterNumber, chapterTitle: c.chapterTitle,
    contentHash: `sd-s-${c.id}`, tensionPeak: 0.8, charactersPresent: c.cast,
    majorEvents: c.offered.map((sentence, i) => ({
      rank: i, label: sentence.slice(0, 38), sentence,
      type: "action", channel: "action", tensionPosition: n > 1 ? i / (n - 1) : 0.5,
    })),
  } as unknown as ChapterGraphEntry;
}

interface Req { label: string; systemPrompt: string; userText: string; gbnf: string; maxTokens: number }

/** The writing tools, through the real builder on the frozen reference cases. */
const WRITING_REQS: Req[] = REWRITE_CASES.map((c) => {
  const batch = planWritingBatches(c.text, undefined, c.op === "proofread")[0];
  const r = buildWritingRequest(c.op, batch, {
    before: c.before, revisedTail: "", instruction: c.instruction,
  });
  return {
    label: `${c.op}/${c.id}`,
    systemPrompt: r.systemPrompt, userText: r.userText,
    gbnf: gbnfFor(r.schema), maxTokens: r.maxTokens,
  };
});

const LANE_REQS: Req[] = [
  ...chipCases.map((c) => {
    // rich is the MAX-tier wire; the small tier still emits keyed objects.
    const r = buildChipRequest(chipEntry(c), { rich: !SMALL });
    return {
      label: `chip/${c.id}`, systemPrompt: r.systemPrompt, userText: r.userText,
      gbnf: SMALL ? gbnfFor(r.schema) : CHIP_RICH_GBNF, maxTokens: r.maxTokens,
    };
  }),
  ...sumCases.map((c) => {
    const r = buildSummaryRequest(sumEntry(c));
    return { label: `summary/${c.id}`, systemPrompt: r.systemPrompt, userText: r.userText, gbnf: SUMMARY_GBNF, maxTokens: r.maxTokens };
  }),
];

const REQS: Req[] = SET === "writing" ? WRITING_REQS : LANE_REQS;

// ── engine ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function baseArgs(port: number): string[] {
  return [
    "-m", MODEL, "-c", String(4 * 2048), "-np", "4", "-fa", "on",
    ...(SMALL ? [] : ["-ctk", "q8_0", "-ctv", "q8_0"]),
    "-kvu", "-ub", "128",
    "--cache-ram", "512", "--host", "127.0.0.1", "--port", String(port), "--no-webui",
  ];
}

async function startServer(extra: string[], port: number): Promise<{ child: ChildProcess; tail: () => string }> {
  const child = spawn(ENGINE, [...baseArgs(port), ...extra], { stdio: ["ignore", "ignore", "pipe"] });
  let tail = "";
  child.stderr.on("data", (d) => { tail = (tail + String(d)).slice(-6000); });
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}\n${tail}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { child, tail: () => tail }; } catch { /* not up */ }
    await sleep(250);
  }
  child.kill("SIGKILL");
  throw new Error(`server never healthy\n${tail}`);
}

const template = (systemPrompt: string, userText: string) =>
  `<|im_start|>system\n${systemPrompt}\n/no_think<|im_end|>\n` +
  `<|im_start|>user\n${userText}<|im_end|>\n` +
  `<|im_start|>assistant\n<think>\n\n</think>\n\n`;

interface Answer { label: string; sha: string; content: string; predN: number; predMs: number; promptN: number; promptMs: number }

async function ask(port: number, req: Req): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${port}/completion`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: template(req.systemPrompt, req.userText),
      grammar: req.gbnf, stop: ["\n\n\n\n"], temperature: 0,
      n_predict: req.maxTokens, cache_prompt: true, stream: false,
    }),
  });
  const p = await res.json() as {
    content: string;
    timings: { prompt_n: number; prompt_ms: number; predicted_n: number; predicted_ms: number };
  };
  const content = String(p.content ?? "");
  return {
    label: req.label, content,
    sha: crypto.createHash("sha256").update(content).digest("hex").slice(0, 16),
    predN: p.timings.predicted_n, predMs: p.timings.predicted_ms,
    promptN: p.timings.prompt_n, promptMs: p.timings.prompt_ms,
  };
}

interface Pass { config: string; round: number; decodeTps: number; waveTps: number; waveMs: number; answers: Answer[]; startupNote: string }

async function runPass(config: string, round: number): Promise<Pass> {
  const port = 49000 + Math.floor(Math.random() * 900);
  const { child, tail } = await startServer(CONFIGS[config], port);
  try {
    for (const r of REQS) await ask(port, r);            // warm every prefix family
    const answers: Answer[] = [];
    for (const r of REQS) answers.push(await ask(port, r));
    // ★ THE WAVE IS A SEPARATE QUESTION. Speculation trades extra compute for
    //   fewer weight passes; when four slots already saturate the GPU there is
    //   no spare compute to trade, so a single-stream win can be a batched
    //   loss. The sidecar serves both shapes, so both are measured.
    const wave0 = Date.now();
    const wave = await Promise.all(REQS.slice(0, 4).map((r) => ask(port, r)));
    const waveMs = Date.now() - wave0;
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const note = (tail().match(/speculative[^\n]*/gi) ?? []).slice(-1)[0] ?? "";
    return {
      config, round, answers, startupNote: note,
      decodeTps: (sum(answers.map((a) => a.predN)) / sum(answers.map((a) => a.predMs))) * 1000,
      waveTps: (sum(wave.map((a) => a.predN)) / waveMs) * 1000,
      waveMs,
    };
  } finally {
    child.kill("SIGKILL");
    await sleep(1200);
  }
}

// ── paired sweep ────────────────────────────────────────────────────────────

console.log(`engine: ${path.basename(path.dirname(ENGINE))}   model: ${path.basename(MODEL)}   kv: ${SMALL ? "f16" : "q8_0"}`);
console.log(`configs: ${WANT.join(", ")}   rounds: ${ROUNDS}   requests: ${REQS.length}\n`);

const passes: Pass[] = [];
const baseline: Record<number, number> = {};
for (let round = 1; round <= ROUNDS; round++) {
  for (const cfg of WANT) {
    if (!CONFIGS[cfg]) throw new Error(`unknown config ${cfg}`);
    process.stdout.write(`  r${round} ${cfg.padEnd(14)} … `);
    let p: Pass;
    try {
      p = await runPass(cfg, round);
    } catch (e) {
      console.log(`FAILED: ${(e as Error).message.split("\n")[0]}`);
      continue;
    }
    passes.push(p);
    if (cfg === "base") baseline[round] = p.decodeTps;
    const rel = baseline[round] ? ((p.decodeTps - baseline[round]) / baseline[round]) * 100 : 0;
    console.log(`decode ${p.decodeTps.toFixed(1)} tok/s${cfg === "base" ? "" : `  ${rel >= 0 ? "+" : ""}${rel.toFixed(1)}%`}   wave ${(p.waveMs / 1000).toFixed(1)}s / ${p.waveTps.toFixed(1)} tok/s`);
  }
}

// ── verdicts ────────────────────────────────────────────────────────────────

const basePasses = passes.filter((p) => p.config === "base");
const refSha = new Map<string, string>();
for (const a of basePasses[0]?.answers ?? []) refSha.set(a.label, a.sha);

console.log(`\n${"config".padEnd(16)}${"decode tok/s".padEnd(15)}${"vs base".padEnd(12)}${"wave tok/s".padEnd(13)}${"wave vs base".padEnd(15)}${"identical"}`);
for (const cfg of WANT) {
  const ps = passes.filter((p) => p.config === cfg);
  if (!ps.length) continue;
  const deltas = ps.map((p) => (p.decodeTps - baseline[p.round]) / baseline[p.round]).filter((x) => Number.isFinite(x));
  const meanTps = ps.reduce((a, p) => a + p.decodeTps, 0) / ps.length;
  const meanDelta = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
  const same = ps.every((p) => p.answers.every((a) => refSha.get(a.label) === a.sha));
  const nDiff = ps[0].answers.filter((a) => refSha.get(a.label) !== a.sha).length;
  const meanWave = ps.reduce((a, p) => a + p.waveTps, 0) / ps.length;
  const waveDeltas = ps.map((p) => {
    const b = passes.find((q) => q.config === "base" && q.round === p.round);
    return b ? (p.waveTps - b.waveTps) / b.waveTps : NaN;
  }).filter((x) => Number.isFinite(x));
  const meanWaveDelta = waveDeltas.reduce((a, b) => a + b, 0) / Math.max(1, waveDeltas.length);
  console.log(
    cfg.padEnd(16) +
    meanTps.toFixed(1).padEnd(15) +
    (cfg === "base" ? "—" : `${meanDelta >= 0 ? "+" : ""}${(meanDelta * 100).toFixed(1)}%`).padEnd(12) +
    meanWave.toFixed(1).padEnd(13) +
    (cfg === "base" ? "—" : `${meanWaveDelta >= 0 ? "+" : ""}${(meanWaveDelta * 100).toFixed(1)}%`).padEnd(15) +
    (same ? "yes" : `NO (${nDiff}/${ps[0].answers.length} differ)`),
  );
}

// Same-config repeatability is the noise floor every delta must clear.
if (basePasses.length > 1) {
  const xs = basePasses.map((p) => p.decodeTps);
  const spread = (Math.max(...xs) - Math.min(...xs)) / Math.min(...xs);
  console.log(`\nnoise floor: base repeated ${basePasses.length}x, spread ${(spread * 100).toFixed(1)}% (${xs.map((x) => x.toFixed(1)).join(", ")} tok/s)`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ engine: ENGINE, model: MODEL, passes }, null, 2));
console.log(`\nwrote ${OUT}\n`);

// ── gate mode ───────────────────────────────────────────────────────────────
//
// `npm run verify:spec-decode`. Two things have to hold, and the second one
// is the reason this exists at all.
//
//   IDENTICAL — every answer byte-for-byte the same with the copy step on as
//     with it off. This is the promise the whole change rests on, and it is
//     not theoretical: the --spec-ngram-mod-n-min 24 / -n-max 32 variant was
//     just as fast and rewrote a chapter summary into different events.
//   FASTER — the flag is actually engaging. A silently ignored flag after an
//     engine bump would leave every gate green while the app quietly halved
//     its own speed. The floor is +25%, an order of magnitude above the 2.5%
//     noise floor and far below the 141% measured, so it catches "stopped
//     working" without flaking on a warm afternoon.
//
// ★ THE GATE ALSO CHECKS THE FILE IT IS GUARDING. Measuring a config this
//   script defines proves nothing about the config assistant-sidecar.cjs
//   spawns, so the shipped defaults are read back out of that source. Change
//   the flag there and this fails until someone re-measures.
if (process.env.SPEC_GATE) {
  const src = fs.readFileSync(path.join(process.cwd(), "electron", "assistant-sidecar.cjs"), "utf8");
  const shipped = CONFIGS.shipped;
  const declaredType = /'--spec-type', process\.env\.ASSISTANT_SIDECAR_SPEC \|\| '([^']+)'/.exec(src)?.[1];
  const declaredMatch = /ASSISTANT_SIDECAR_SPEC_MATCH\) \|\| (\d+)/.exec(src)?.[1];
  let bad = 0;
  const g = (ok: boolean, label: string, detail = "") => {
    if (ok) console.log(`  ok   ${label}`);
    else { bad++; console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ""}`); }
  };
  console.log("\nshipped configuration");
  g(declaredType === shipped[1], `assistant-sidecar.cjs spawns --spec-type ${shipped[1]} (${declaredType})`);
  g(declaredMatch === shipped[3], `assistant-sidecar.cjs spawns match ${shipped[3]} (${declaredMatch})`);

  const shippedPasses = passes.filter((x) => x.config === "shipped");
  const identical = shippedPasses.every((x) => x.answers.every((a) => refSha.get(a.label) === a.sha));
  const nDiff = shippedPasses[0]?.answers.filter((a) => refSha.get(a.label) !== a.sha).length ?? -1;
  g(shippedPasses.length > 0, "the shipped config ran");
  g(identical, `IDENTICAL: every answer matches the copy-step-off baseline`, `${nDiff} differ`);

  const deltas = shippedPasses.map((x) => (x.decodeTps - baseline[x.round]) / baseline[x.round]);
  const mean = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
  g(mean > 0.25, `FASTER: decode +${(mean * 100).toFixed(1)}% over the floor of +25%`);

  console.log(`\n${bad === 0 ? "PASS" : "FAIL"} — ${bad} failed\n`);
  process.exit(bad === 0 ? 0 : 1);
}
