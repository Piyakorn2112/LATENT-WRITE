/**
 * probe-assistant-renderer.mjs — is the assistant reachable from the REAL
 * renderer? Asks the live window directly instead of waiting on the sweep:
 * status via preload, then one tiny grammar-constrained run. Diagnostic only.
 *
 *   /opt/homebrew/bin/node scripts/probe-assistant-renderer.mjs
 */
import { _electron } from "playwright-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = path.join(homedir(), "Library/Application Support/Latent Write/models/Qwen3-1.7B-Q4_K_M.gguf");
const userData = mkdtempSync(path.join(tmpdir(), "lw-probe-profile-"));

const app = await _electron.launch({
  args: ["."], cwd: repo,
  env: { ...process.env, LW_USER_DATA: userData, ASSISTANT_MODEL_PATH: MODEL },
});
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 300)));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1500);

  const status = await page.evaluate(() => window.electronAPI?.assistantStatus?.());
  console.log("status:", JSON.stringify(status, null, 1)?.slice(0, 800));

  const run = await page.evaluate(async () => {
    if (!window.electronAPI?.assistantRun) return { err: "assistantRun missing on preload" };
    try {
      return await window.electronAPI.assistantRun({
        requestId: "probe-1",
        task: "probe",
        systemPrompt: "Classify the sentiment. Answer as JSON.",
        userText: "What a wonderful morning!",
        schema: { type: "object", properties: { label: { enum: ["positive", "negative"] } }, required: ["label"], additionalProperties: false },
        maxTokens: 24,
        timeoutMs: 90_000,
      });
    } catch (e) { return { err: String(e).slice(0, 400) }; }
  });
  console.log("run:", JSON.stringify(run)?.slice(0, 600));
} finally {
  await app.close().catch(() => {});
  rmSync(userData, { recursive: true, force: true });
}
