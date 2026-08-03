/**
 * verify-review-sweep-e2e.mjs — does the WAVE-2 sweep fire in the real app?
 * analysis worker → scene grouping → near-miss candidates + Chekhov phrases →
 * idle sweep → grammar-constrained local model → answers persisted.
 *
 * Sibling of verify-knowledge-e2e.mjs, and the same argument for existing:
 * every layer below is gated in isolation (test-assist-sweep for the sweep and
 * its selectors, verify-assistant-tasks for the model's answers), so the ONLY
 * thing this asserts is the WIRING — the App effect, its scheduler, and
 * persistence, in the running Electron app with the real model.
 *
 * ★★ THIS IS THE HARNESS THAT WOULD HAVE CAUGHT THE ONE THAT GOT THROUGH.
 *    `sceneStartParagraphs` returned [0] when no paragraph carried `sceneStart`
 *    — which is EVERY chapter analysed at the `fast` level, because
 *    detectSpeechInChapter skips groupIntoScenes there. tsc was clean and every
 *    pure gate was green, because every pure gate called it with grouped input.
 *    Only the running app produces ungrouped input.
 *
 * ★ IT ASSERTS WIRING, NOT JUDGMENT. Whether a particular phrase is a promise
 *   is owned by verify-assistant-tasks' fixtures. What must hold here: the
 *   sweep ran, it asked bounded questions, every answer is schema-shaped, it
 *   was cache-keyed, and it persisted to the project's own file. The witness is
 *   the app's persistence, never a re-implementation of its selectors.
 *
 *   /opt/homebrew/bin/node scripts/verify-review-sweep-e2e.mjs
 */
import { _electron } from "playwright-core";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = process.env.ASSISTANT_MODEL_PATH ??
  path.join(homedir(), "Library/Application Support/Latent Write/models/Qwen3-1.7B-Q4_K_M.gguf");
const TIMEOUT_MS = 240_000;

if (!existsSync(MODEL)) {
  console.log("[review-e2e] SKIP — no model at", MODEL);
  process.exit(0);
}
if (!existsSync(path.join(repo, "dist/index.html"))) {
  console.error("[review-e2e] ✗ dist/ missing — run `npx vite build` first");
  process.exit(1);
}

// ── Seed a project built to produce both kinds of candidate ────────────────
// Chapter 1 is long and swings in tension, so groupIntoScenes splits it and the
// scene engine has something to be uncertain about. It also plants concrete
// nouns that never recur, which is what findChekhovCandidates looks for.
const userData = mkdtempSync(path.join(tmpdir(), "lw-rev-profile-"));
const project = mkdtempSync(path.join(tmpdir(), "lw-rev-project-"));
mkdirSync(path.join(project, ".renderer"), { recursive: true });

const worldData = {
  characters: [
    { name: "Teva", aliases: [], role: "yard clerk", description: "Keeps the crate register." },
    { name: "Ansel", aliases: [], role: "foreman", description: "Runs the loading yard." },
  ],
  places: [], factions: [], entities: [], castReviewed: true,
};

const novelTxt = `===TITLE===
E2E Review Sweep
===WORLD-DATA===
${JSON.stringify(worldData)}
===CHAPTER 1: The Register===
The yard kept its register in a locked drawer, and Teva had the only key that turned it, which everyone treated as an administrative fact rather than a kind of power.

She went along the row of crates with the lamp held low, reading the chalk marks one after another, and none of them matched what the register in her other hand said they ought to.

The yard was quiet enough that she could hear the river working at the pilings. She counted to the end of the row twice before she let herself believe it, and then she counted a third time anyway.

Somebody had put a folded oilcloth over the last four crates, and she lifted it and put it back exactly as it had been, which took longer than lifting it had.

"You are out here late," said Ansel, from the office door. He did not pretend to be doing anything else.

"The count is wrong," said Teva.

"The count is always wrong in the spring."

"Not by forty crates it is not."

He came down the steps then, and the easy part of the evening was over for both of them. He asked her what she wanted him to do about it and she said she wanted him to look, and he said he had looked, and neither of them said the thing that was actually between them.

Afterwards she sat on the wall above the slipway and watched the water go by underneath, letting the cold get into her hands until they hurt, thinking about nothing much at all.

She did not go back in. The lamp burned itself down on the step where she had left it, and by the time the tide turned she had decided what she was going to do in the morning.

===CHAPTER 2: Morning===
Morning came the way mornings come to a river yard, grudgingly and all at once. Teva was at the gate before the foreman was, and she had the register with her, and she had not slept.

Ansel arrived at seven and saw her there and understood most of it before either of them spoke.

"You are going to the harbour office," he said.

"I am."

They stood in the cold a while longer. Then he unlocked the gate and let her past, which was, in its way, an answer.
`;

writeFileSync(path.join(project, "novel.txt"), novelTxt, "utf8");
writeFileSync(path.join(project, ".renderer/project.json"),
  JSON.stringify({ version: 1, name: "E2E Review Sweep", created: Date.now() }), "utf8");
writeFileSync(path.join(userData, "last-project.json"),
  JSON.stringify({ path: project, updated: Date.now() }), "utf8");

const reviewPath = path.join(project, ".renderer/assist-reviews.json");
const cleanup = () => {
  rmSync(userData, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
};

const app = await _electron.launch({
  args: ["."],
  cwd: repo,
  env: { ...process.env, LW_USER_DATA: userData, ASSISTANT_MODEL_PATH: MODEL },
});

let failed = null;
try {
  const page = await app.firstWindow();
  page.on("pageerror", (err) => console.log("[review-e2e] pageerror:", String(err).slice(0, 400)));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("[review-e2e] console.error:", msg.text().slice(0, 400));
  });
  await page.waitForLoadState("domcontentloaded");

  // Prefs seeded ahead of the app on every navigation — see the long note in
  // verify-knowledge-e2e.mjs about why evaluate-then-reload loses the race.
  await app.context().addInitScript(() => {
    localStorage.setItem("latentwrite:prefs-v1", JSON.stringify({
      hasSeenOnboarding: true,
      assistant: { enabled: true },
    }));
  });
  await page.reload();

  console.log("[review-e2e] app up, hermetic profile, waiting for the sweep…");
  const t0 = Date.now();
  let last = "";
  let done = false;
  let lastPrinted = 0;

  while (Date.now() - t0 < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 2000));
    if (Date.now() - lastPrinted > 20_000) {
      lastPrinted = Date.now();
      console.log(`[review-e2e] …${((Date.now() - t0) / 1000).toFixed(0)}s ${last}`);
    }
    if (!existsSync(reviewPath)) { last = "no review file yet"; continue; }
    let store;
    try { store = JSON.parse(readFileSync(reviewPath, "utf8")); } catch { last = "file mid-write"; continue; }

    const entries = Object.values(store.chapters ?? {});
    const asked = entries.reduce((n, e) => n + (e.asked?.length ?? 0), 0);
    const scenes = entries.reduce((n, e) => n + Object.keys(e.scenes ?? {}).length, 0);
    const chekhov = entries.reduce((n, e) => n + Object.keys(e.chekhov ?? {}).length, 0);
    last = `chapters=${entries.length} asked=${asked} scene-answers=${scenes} chekhov-answers=${chekhov}`;

    // The sweep is DONE for a chapter when it has asked everything it means to.
    // Answers are optional — abstention is a real outcome — so the completion
    // signal is `asked`, not the answer counts.
    if (asked === 0) continue;

    const entry = entries.find((e) => (e.asked?.length ?? 0) > 0);
    console.log(`[review-e2e] sweep landed after ${((Date.now() - t0) / 1000).toFixed(0)}s: ${last}`);

    // ── what MUST hold ────────────────────────────────────────────────────
    if (!entry.contentHash || !entry.modelId) {
      failed = `entry missing its staleness keys: ${JSON.stringify({ h: entry.contentHash, m: entry.modelId })}`;
      break;
    }
    // ★ THE CAP IS THE FEATURE. Three scene + two Chekhov questions per chapter
    //   per content hash. A sweep that exceeded it would be the "queue that
    //   never drains" the whole wave-2 design exists to avoid.
    if (entry.asked.length > 5) {
      failed = `budget blown: ${entry.asked.length} questions asked for one chapter (cap is 5)`;
      break;
    }
    if (new Set(entry.asked).size !== entry.asked.length) {
      failed = "the same question was asked twice — the cache key is not deduping";
      break;
    }
    // Every stored answer must be shaped and keyed the way its selector expects,
    // or it is stored where nothing will ever look it up.
    for (const [key, v] of Object.entries(entry.scenes ?? {})) {
      if (!entry.asked.includes(key)) { failed = `scene answer under a key never asked: ${key}`; break; }
      if (typeof v.label !== "string" || !v.label) { failed = `scene answer with no label: ${key}`; break; }
      if (!Array.isArray(v.offered) || v.offered.length === 0) {
        failed = `scene answer with no offered shortlist: ${key} — sceneLabelOverlay would drop it forever`; break;
      }
      if (!v.offered.includes(v.label)) { failed = `scene label "${v.label}" was not on its own shortlist`; break; }
      if (typeof v.confidence !== "number" || v.confidence < 0.7) {
        failed = `sub-floor scene label stored: ${v.confidence}`; break;
      }
      if (typeof v.sceneIndex !== "number") { failed = `scene answer with no sceneIndex: ${key}`; break; }
    }
    if (failed) break;
    for (const [key, v] of Object.entries(entry.chekhov ?? {})) {
      if (!entry.asked.includes(key)) { failed = `chekhov answer under a key never asked: ${key}`; break; }
      if (!["promise", "furniture", "unsure"].includes(v.verdict)) {
        failed = `chekhov verdict outside the enum: ${v.verdict}`; break;
      }
      if (!v.phrase || !v.reason) { failed = `malformed chekhov record: ${JSON.stringify(v)}`; break; }
    }
    if (failed) break;

    console.log("[review-e2e]   asked:", entry.asked.length, "question(s) for chapter", entry.chapterId);
    for (const v of Object.values(entry.scenes ?? {})) {
      console.log(`[review-e2e]   scene ${v.sceneIndex} → "${v.label}" @${v.confidence}  (of [${v.offered.join(", ")}])`);
      console.log(`[review-e2e]     ${v.reason}`);
    }
    for (const v of Object.values(entry.chekhov ?? {})) {
      console.log(`[review-e2e]   "${v.phrase}" → ${v.verdict} @${v.confidence}`);
      console.log(`[review-e2e]     ${v.reason}`);
    }

    // ★ AND THE SWEEP MUST SETTLE. Re-asking a chapter it has already answered
    //   is the failure mode `asked` exists to prevent, and it would burn the
    //   model continuously in the background for as long as the app is open.
    const before = entry.asked.length;
    await new Promise((r) => setTimeout(r, 20_000));
    const after = JSON.parse(readFileSync(reviewPath, "utf8"));
    const entryAfter = Object.values(after.chapters ?? {}).find((e) => e.chapterId === entry.chapterId);
    if ((entryAfter?.asked?.length ?? 0) > 5) {
      failed = `the sweep did not settle: ${before} → ${entryAfter.asked.length} questions on an unedited chapter`;
      break;
    }
    console.log(`[review-e2e]   settled: ${before} → ${entryAfter.asked.length} after 20s idle`);
    done = true;
    break;
  }
  if (!done && !failed) failed = `timed out after ${TIMEOUT_MS / 1000}s (${last})`;
} catch (err) {
  failed = String(err);
} finally {
  await app.close().catch(() => {});
  cleanup();
}

if (failed) {
  console.error(`[review-e2e] ✗ FAIL — ${failed}`);
  process.exit(1);
}
console.log("[review-e2e] ✓ PASS — the sweep ran in the real app, stayed inside its per-chapter budget, persisted well-formed cache-keyed answers, and settled");
