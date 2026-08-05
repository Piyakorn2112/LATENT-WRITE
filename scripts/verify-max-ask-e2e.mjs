/**
 * verify-max-ask-e2e.mjs — right-click → ask, on the REAL app with the REAL 4B.
 *
 * What only this can prove, in order of who breaks it:
 *   1. the caret assumption — Chromium moves the caret on the right-click's own
 *      mousedown, so the popover must preview the paragraph UNDER THE POINTER,
 *      not the last-edited one. If this assumption is wrong, everything else
 *      lies about which paragraph it is discussing.
 *   2. the gate — the handler only exists in max mode, from seeded prefs.
 *   3. the chain — Editor → App → context assembly → runner with tier:"max",
 *      noThink:false → registry resolves the 4B from userData → answer text
 *      lands in the popover.
 *
 * Hermetic profile; the REAL models directory is symlinked in rather than
 * copied (2.3 GB) or overridden via ASSISTANT_MODEL_PATH — the env override
 * would point EVERY tier at one file and unmeasure the very thing under test:
 * that the max tier resolves its own model.
 *
 *   /opt/homebrew/bin/node scripts/verify-max-ask-e2e.mjs
 */
import { _electron } from "playwright-core";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_MODELS = path.join(homedir(), "Library/Application Support/Latent Write/models");
if (!existsSync(path.join(REAL_MODELS, "Qwen3-4B-Thinking-2507-Q4_K_M.gguf"))) {
  console.log("SKIP — 4B not on disk.");
  process.exit(0);
}

const userData = mkdtempSync(path.join(tmpdir(), "lw-maxask-"));
const project = mkdtempSync(path.join(tmpdir(), "lw-maxask-proj-"));
mkdirSync(path.join(project, ".renderer"), { recursive: true });
symlinkSync(REAL_MODELS, path.join(userData, "models"));

const worldData = {
  characters: [
    { name: "Elena", aliases: ["Ash Marshal"], role: "Protagonist", description: "Clears the road. Wanted in three parishes." },
    { name: "Kestrel", aliases: ["Kes"], role: "", description: "Runs ahead. Does not explain herself." },
  ],
  places: [], factions: [], entities: [], castReviewed: true,
};

const PARA3 = "Kestrel came in from the yard with ash on both sleeves and did not bother to knock the worst of it off before she sat down.";

const novelTxt = `===TITLE===
Max Ask E2E
===WORLD-DATA===
${JSON.stringify(worldData)}
===CHAPTER 1: The Ash Road===
The fire had been out since midnight, but the smell of it stayed in the walls.

Elena Vasquez sat with her back to the cold stove and counted what was left in the tin.

${PARA3}

"You are going to get us both killed, Kes," Elena said, without looking up.
`;

writeFileSync(path.join(project, "novel.txt"), novelTxt, "utf8");
writeFileSync(path.join(project, ".renderer/project.json"),
  JSON.stringify({ version: 1, name: "Max Ask E2E", created: Date.now() }), "utf8");
writeFileSync(path.join(userData, "last-project.json"),
  JSON.stringify({ path: project, updated: Date.now() }), "utf8");

const cleanup = () => { rmSync(userData, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); };

const app = await _electron.launch({ args: ["."], cwd: repo, env: { ...process.env, LW_USER_DATA: userData } });

let failed = null;
try {
  const page = await app.firstWindow();
  page.on("pageerror", (err) => console.log("[max-ask-e2e] pageerror:", String(err).slice(0, 300)));
  page.on("console", (msg) => {
    if (msg.type() === "error" || /assistant|max-ask/i.test(msg.text())) {
      console.log(`[renderer:${msg.type()}]`, msg.text().slice(0, 240));
    }
  });
  await page.waitForLoadState("domcontentloaded");

  // Seeded BEFORE the app boots (init script, not evaluate+reload — the
  // running session would stomp the value). intelMode off keeps the analysis
  // chains quiet so the single-flight queue belongs to the ask.
  await app.context().addInitScript(() => {
    localStorage.setItem("latentwrite:prefs-v1", JSON.stringify({
      hasSeenOnboarding: true,
      intelMode: "off",
      assistant: { enabled: true, mode: "max", tier: "max" },
    }));
  });
  await page.reload();

  const ta = page.locator(".document-editor");
  await ta.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1200);

  // ── right-click ON PARAGRAPH 3 (engine index 2) ─────────────────────────
  //
  // ★ THE CLICK POINT IS MEASURED, NOT COMPUTED FROM LINE ARITHMETIC. The
  //   first version clicked padTop + lineHeight*4.5 and landed one visual line
  //   short (the blank line above the target) — which read as "the caret
  //   assumption is broken" when it was the harness's own pixel math. The
  //   standard mirror technique asks the textarea's own typography where the
  //   target offset actually renders.
  const box = await ta.boundingBox();
  const yWithin = await ta.evaluate((el, needle) => {
    const cs = getComputedStyle(el);
    const div = document.createElement("div");
    for (const prop of ["fontFamily", "fontSize", "lineHeight", "letterSpacing",
      "padding", "width", "boxSizing", "border"]) div.style[prop] = cs[prop];
    div.style.position = "absolute";
    div.style.visibility = "hidden";
    div.style.whiteSpace = "pre-wrap";
    div.style.wordBreak = "break-word";
    const at = el.value.indexOf(needle);
    div.textContent = el.value.slice(0, at + 10);
    const mark = document.createElement("span");
    mark.textContent = "X";
    div.appendChild(mark);
    document.body.appendChild(div);
    const y = mark.offsetTop + mark.offsetHeight / 2 - el.scrollTop;
    div.remove();
    return y;
  }, PARA3);
  const x = box.x + Math.min(200, box.width / 2);
  await page.mouse.click(x, box.y + yWithin, { button: "right" });

  const popover = page.locator(".max-ask");
  await popover.waitFor({ timeout: 5_000 });
  const preview = (await page.locator(".max-ask-context").textContent()) ?? "";
  const previewRight = PARA3.startsWith(preview.slice(0, 40));
  console.log(`[max-ask-e2e] popover preview: "${preview.slice(0, 60)}…"`);
  console.log(`[max-ask-e2e] ★ caret assumption ${previewRight ? "HOLDS" : "BROKEN"} — preview ${previewRight ? "is" : "IS NOT"} the paragraph under the pointer`);
  if (!previewRight) throw new Error("caret-from-right-click did not land on the clicked paragraph");

  // ── ask, against the real 4B ────────────────────────────────────────────
  await page.locator(".max-ask-item", { hasText: "What is this doing?" }).click();
  console.log("[max-ask-e2e] asked; waiting on the 4B (cold load can take ~40s)…");
  const t0 = Date.now();
  const answer = page.locator(".max-ask-answer-text");
  await answer.waitFor({ timeout: 180_000 });
  const text = (await answer.textContent()) ?? "";
  const basis = (await page.locator(".max-ask-basis").first().textContent().catch(() => "")) ?? "";
  console.log(`[max-ask-e2e] answered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`[max-ask-e2e] answer: ${text}`);
  console.log(`[max-ask-e2e] ${basis}`);
  if (!text.trim() || /No answer this time/.test(text)) {
    // Post-mortem: what does the runtime say about each tier?
    for (const tier of ["max", "small"]) {
      const st = await page.evaluate((t) => window.electronAPI.assistantStatus({ tier: t }), tier);
      console.log(`[max-ask-e2e] status ${tier}: state=${st.state} present=${st.model?.present} `
        + `loaded=${st.host?.loaded ? JSON.stringify({ ctx: st.host.loaded.contextSize, path: st.host.loaded.modelPath.split("/").pop() }) : null} `
        + `degraded=${JSON.stringify(st.degraded ?? null)}`);
    }
    throw new Error("no usable answer");
  }

  console.log("\n[max-ask-e2e] PASS — right-click → correct paragraph → 4B answer in the popover");
} catch (err) {
  failed = err;
} finally {
  await app.close().catch(() => {});
  cleanup();
}
if (failed) { console.error("[max-ask-e2e] FAIL:", failed.message || failed); process.exit(1); }
