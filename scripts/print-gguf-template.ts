/**
 * print-gguf-template.ts — what a GGUF actually declares about itself.
 *
 * ★ THE REGISTRY'S `template` FIELD IS A CLAIM ABOUT THE FILE. The sidecar
 *   hand-builds prompts (the closed-think trick) instead of using the server's
 *   auto-template, so a model whose real template differs from the family it is
 *   filed under would be prompted wrongly and answer plausible nonsense — the
 *   silent kind of wrong. This prints the file's own answer.
 *
 * Run: MODELS=a.gguf,b.gguf ./node_modules/.bin/tsx scripts/print-gguf-template.ts
 */
import os from "node:os";
import path from "node:path";
import { readGgufFileInfo } from "node-llama-cpp";

const DIR = path.join(os.homedir(), "Library/Application Support/Latent Write/models");
const MODELS = (process.env.MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!MODELS.length) { console.error("MODELS=a.gguf,b.gguf is required"); process.exit(1); }

async function main() {
  for (const f of MODELS) {
    const p = f.includes("/") ? f : path.join(DIR, f);
    const info = await readGgufFileInfo(p) as unknown as { metadata: Record<string, Record<string, unknown>> };
    const m = info.metadata;
    const arch = String(m.general?.architecture ?? "?");
    const a = (m[arch] ?? {}) as Record<string, unknown>;
    console.log(`\n══ ${path.basename(p)}`);
    console.log(`   arch        ${arch}`);
    console.log(`   name        ${String(m.general?.name ?? "?")}`);
    console.log(`   ctx_train   ${String(a.context_length ?? "?")}`);
    console.log(`   layers      ${String(a.block_count ?? "?")}`);
    console.log(`   heads       ${String(a.attention?.["head_count"] ?? a["attention.head_count"] ?? "?")}`);
    const t = String((m.tokenizer as Record<string, unknown> | undefined)?.chat_template ?? "");
    console.log(`   template    ${t ? `${t.length} chars` : "(none)"}`);
    const shown = process.env.FULL ? t : t.slice(0, 900);
    if (t) console.log(`${shown.split("\n").map((l) => `     │ ${l}`).join("\n")}`);
  }
}

await main();
