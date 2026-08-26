/**
 * probe-model-kv-scaling.ts — how many bytes of memory does one token of
 * context cost this model?
 *
 * ★★ THE REGISTRY BUDGETS IN KV-BYTES-PER-TOKEN, AND THAT NUMBER IS MEASURED.
 *    `kvBytesPerToken` is what stops the memory guard thinking a long context
 *    is free — the 1.7B's 103 KB/token is MORE than its entire 1.06 GB weights
 *    file over the useful range. A candidate with a different attention shape
 *    has a different slope, and guessing it is how a tier gets sized wrong.
 *
 * ★★ ASK THE ENGINE, DO NOT INFER FROM RSS. The first version of this probe
 *    measured process RSS before and after filling a context and reported
 *    MINUS 39 MB for a 4096-token window — because the weights are mmapped and
 *    file-backed, so the pager evicted weight pages as the KV filled. RSS
 *    cannot separate the two. llama.cpp states its own KV allocation at load
 *    ("KV self size = ... MiB"), which is the engine's accounting rather than
 *    a guess about the pager's.
 *
 * ★  AND IT IS WHY A HYBRID MODEL HAS TO BE MEASURED, NOT ASSUMED. Gated
 *    DeltaNet layers hold a fixed-size recurrent state instead of a per-token
 *    KV cache, so the slope should be far below a pure-attention model of the
 *    same size — but "should" is not a budget.
 *
 * Run:
 *   MODELS=Qwen3-1.7B-Q4_K_M.gguf,Qwen3.8-2B-Q4_K_M.gguf \
 *     ./node_modules/.bin/tsx scripts/probe-model-kv-scaling.ts
 *
 * Env:
 *   MODELS   comma list of GGUF basenames or paths
 *   CTXS     comma list of context sizes    (default 2048,4096,8192,16384)
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";

const MODELS_DIR = path.join(os.homedir(), "Library/Application Support/Latent Write/models");
const ENGINE = process.env.ASSISTANT_LLAMA_SERVER
  || path.join(os.homedir(), "Library/Application Support/Latent Write/engine/llama-b10298/llama-server");
const MODELS = (process.env.MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);
const CTXS = (process.env.CTXS || "2048,4096,8192,16384").split(",").map(Number);
if (!MODELS.length) { console.error("MODELS=a.gguf,b.gguf is required"); process.exit(1); }
if (!fs.existsSync(ENGINE)) { console.error(`missing engine ${ENGINE}`); process.exit(1); }

/** Boot the server just far enough to read its own memory report, then stop.
 *  No request is ever sent — the number wanted is stated at load. */
function kvMbFor(modelPath: string, ctx: number): Promise<{ kvMb: number; modelMb: number; log: string }> {
  return new Promise((resolve) => {
    const child = spawn(ENGINE, [
      "-m", modelPath, "--port", "0", "-c", String(ctx), "-ngl", "999", "--no-webui",
      // ★ ONE SLOT. The server defaults to four, so the KV it reports would be
      //   the whole slot set and the per-token slope would come out 4x.
      "-np", "1",
      // ★ AND RAISE THE LOG LEVEL. b10298 ships at verbosity 3, which hides
      //   the allocation lines this probe exists to read — the first run
      //   reported "no KV line found" for exactly that reason.
      "-lv", "6",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    let settled = false;
    const done = (ok: boolean) => {
      if (settled || (!ok && !log)) return;
      settled = true;
      // "llama_kv_cache: Metal KV buffer size =  1024.00 MiB" and friends; also
      // the recurrent-state line hybrids emit instead.
      // ★★ NAME EVERY LINE THAT COUNTED. The first working version summed
      //    every "… size = N MiB" match and reported 1344 MiB for a 4096-token
      //    window on the 1.7B — 3x what 28 layers x 1024 KV dims x 2 x f16
      //    predicts, because llama.cpp prints the same allocation under more
      //    than one heading. A total with no itemisation cannot be checked
      //    against the geometry, so the lines are kept and printed.
      const kvLines = [...log.matchAll(/^.*?(?:kv[ _]?cache|KV (?:self|buffer))[^\n]*?=\s*([\d.]+)\s*MiB.*$/gim)]
        .map((m) => ({ text: m[0].trim().replace(/\s+/g, " "), mb: Number(m[1]) }));
      // De-duplicate by value: the same allocation reported twice is one
      // allocation. Distinct K and V lines legitimately differ, so equal
      // consecutive values collapse and unequal ones both count.
      const seen = new Set<string>();
      let kvMb = 0;
      for (const l of kvLines) {
        const key = `${l.mb}`;
        if (seen.has(key)) continue;
        seen.add(key);
        kvMb += l.mb;
      }
      if (process.env.DEBUG) {
        for (const l of kvLines) console.log(`      · ${l.text}`);
      }
      let modelMb = 0;
      const mm = /model buffer size\s*=\s*([\d.]+)\s*MiB/i.exec(log)
        || /model size\s*=\s*([\d.]+)\s*MiB/i.exec(log);
      if (mm) modelMb = Number(mm[1]);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve({ kvMb, modelMb, log });
    };
    const onData = (d: Buffer) => {
      log += d;
      // Everything wanted is printed before the server starts listening.
      if (/main: server is listening|starting the main loop|all slots are idle/i.test(log)) done(true);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", () => done(true));
    setTimeout(() => done(true), 90_000);
  });
}

async function main() {
  for (const m of MODELS) {
    const modelPath = m.includes("/") ? m : path.join(MODELS_DIR, m);
    if (!fs.existsSync(modelPath)) { console.log(`\n══ ${m} — MISSING`); continue; }
    console.log(`\n══ ${path.basename(modelPath)}`);
    const points: Array<{ ctx: number; kvMb: number }> = [];
    for (const ctx of CTXS) {
      const { kvMb, modelMb, log } = await kvMbFor(modelPath, ctx);
      if (!kvMb) {
        console.log(`   ctx ${String(ctx).padStart(6)}  — no KV line found`);
        if (process.env.DEBUG) console.log(log.slice(-2500));
        continue;
      }
      points.push({ ctx, kvMb });
      console.log(`   ctx ${String(ctx).padStart(6)}  KV ${kvMb.toFixed(1).padStart(8)} MiB   weights ${modelMb.toFixed(0)} MiB`);
    }
    if (points.length >= 2) {
      const a = points[0], b = points[points.length - 1];
      const kbPerToken = ((b.kvMb - a.kvMb) * 1024) / (b.ctx - a.ctx);
      console.log(`   ── slope: ${kbPerToken.toFixed(1)} KB per token of context`);
      console.log(`      (registry budgets: 1.7B 103 KB/tok f16, 4B 70 KB/tok at Q8_0)`);
    }
  }
}

await main();
