/**
 * probe-model-server-cache.ts — does the SIDECAR reuse a repeated prompt for a
 * given model?
 *
 * ★★ THIS IS THE QUESTION THAT DECIDES A HYBRID-ATTENTION CANDIDATE. Every
 *    batch task in this app sends a byte-identical 400-1400 token system
 *    prompt and asks for ~50 tokens back, so the shipped cost is the WARM
 *    prefill, not the cold one. probe-model-candidate.ts measured the
 *    in-process host: a pure-attention Qwen3 warms 64x, the Gated DeltaNet
 *    Qwen3.5 warms 2x. The sidecar is a different engine (b10298) with its own
 *    prompt cache, so it gets its own measurement rather than an assumption.
 *
 * Reads `timings.prompt_ms` and `tokens_cached` straight off llama-server, so
 * the number is the server's own accounting, not a wall-clock guess.
 *
 * Run:
 *   MODEL=Qwen3.8-2B-Q4_K_M.gguf ./node_modules/.bin/tsx scripts/probe-model-server-cache.ts
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";

const MODELS_DIR = path.join(os.homedir(), "Library/Application Support/Latent Write/models");
const ENGINE = path.join(os.homedir(), "Library/Application Support/Latent Write/engine/llama-b10298/llama-server");
const MODEL = process.env.MODEL || "Qwen3.8-2B-Q4_K_M.gguf";
const modelPath = MODEL.includes("/") ? MODEL : path.join(MODELS_DIR, MODEL);
const PORT = Number(process.env.PORT) || 8171;
const REPEATS = Number(process.env.REPEATS) || 3;

if (!fs.existsSync(modelPath)) { console.error(`missing ${modelPath}`); process.exit(1); }
if (!fs.existsSync(ENGINE)) { console.error(`missing ${ENGINE}`); process.exit(1); }

/** A prompt the shape of a real one: long fixed preamble, short varying tail.
 *  The preamble is what a cache has to recognise. */
const PREAMBLE = Array.from({ length: 120 }, (_, i) =>
  `Rule ${i + 1}: keep the label under twelve words and never invent a name that is not in the evidence.`).join("\n");

const post = async (body: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/completion`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json() as {
    timings: { prompt_n: number; prompt_ms: number; predicted_n: number; predicted_ms: number };
    tokens_cached?: number;
  };
};

async function main() {
  const child = spawn(ENGINE, [
    "-m", modelPath, "--port", String(PORT), "--host", "127.0.0.1",
    "-c", "8192", "-ngl", "999", "--slots", "--no-webui",
    // The sidecar's shipped cache settings.
    "--cache-ram", "512",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });

  // Wait for health rather than sleeping a guess.
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (Date.now() > deadline) { console.error(`server never became healthy\n${log.slice(-3000)}`); child.kill(); process.exit(1); }
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`\n${path.basename(modelPath)} on ${path.basename(path.dirname(ENGINE))}`);
  const rows: Array<{ i: number; promptN: number; promptMs: number; cached: number }> = [];
  for (let i = 0; i < REPEATS; i++) {
    const out = await post({
      prompt: `${PREAMBLE}\n\nEVIDENCE: the clerk refused to carry the ledger.\nANSWER:`,
      n_predict: 16, temperature: 0, cache_prompt: true,
    });
    rows.push({
      i, promptN: out.timings.prompt_n, promptMs: Math.round(out.timings.prompt_ms),
      cached: out.tokens_cached ?? -1,
    });
    console.log(
      `  run ${i}  prompt_n=${String(out.timings.prompt_n).padStart(5)}  `
      + `prompt_ms=${String(Math.round(out.timings.prompt_ms)).padStart(6)}  `
      + `tokens_cached=${out.tokens_cached ?? "?"}  `
      + `gen=${out.timings.predicted_n}tok in ${Math.round(out.timings.predicted_ms)}ms`,
    );
  }
  const first = rows[0].promptMs, last = rows[rows.length - 1].promptMs;
  console.log(`\n  cache gain: ${first}ms → ${last}ms = ${(first / Math.max(1, last)).toFixed(1)}x`);
  console.log(`  reprocessed tokens on the repeat: ${rows[rows.length - 1].promptN} of ${rows[0].promptN}`);

  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
}

await main();
