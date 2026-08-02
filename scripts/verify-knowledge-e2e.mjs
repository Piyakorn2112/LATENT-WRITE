/**
 * verify-knowledge-e2e.mjs — does the WHOLE knowledge chain fire in the real
 * app? analysis worker → ledger facts → guarded candidate → idle sweep →
 * grammar-constrained local model → verdict persisted → surfaced.
 *
 * This is the "prove the fix fires" harness: every layer below is already
 * gated in isolation (test-knowledge-ledger, test-evidence-pack,
 * verify-assistant-tasks), so the only thing this asserts is the WIRING —
 * the App effects, the scheduler, and persistence, in the running Electron
 * app with the real model.
 *
 * Method: hermetic userData (LW_USER_DATA seam in main.cjs — a test run must
 * never touch the writer's real profile), a pre-seeded project whose chapter
 * 2 contains a PLANTED break (Doran claims knowledge of Vessa Kri, who is
 * not introduced until chapter 3 and never shares a scene with him before
 * the claim), assistant enabled via seeded prefs, real downloaded model via
 * ASSISTANT_MODEL_PATH. The assertion reads the PROJECT'S OWN LEDGER FILE
 * (.renderer/knowledge-ledger.json) — the app's persistence is the witness,
 * not a re-implementation of its selectors.
 *
 *   ./node_modules/.bin/electron is NOT the runner here — playwright-core
 *   drives the app:  /opt/homebrew/bin/node scripts/verify-knowledge-e2e.mjs
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
  console.log("[knowledge-e2e] SKIP — no model at", MODEL);
  process.exit(0);
}
if (!existsSync(path.join(repo, "dist/index.html"))) {
  console.error("[knowledge-e2e] ✗ dist/ missing — run `npm run build` first");
  process.exit(1);
}

// ── Seed a project with one planted break ─────────────────────────────────
const userData = mkdtempSync(path.join(tmpdir(), "lw-e2e-profile-"));
const project = mkdtempSync(path.join(tmpdir(), "lw-e2e-project-"));
mkdirSync(path.join(project, ".renderer"), { recursive: true });

const worldData = {
  characters: [
    { name: "Doran", aliases: [], role: "harbour clerk", description: "Keeps the ledgers at the quay." },
    { name: "Mira", aliases: [], role: "apprentice", description: "New to the harbour office." },
    { name: "Vessa Kri", aliases: [], role: "smuggler captain", description: "Runs the night routes." },
  ],
  places: [], factions: [], entities: [], castReviewed: true,
};

// Chapter 2 is the break: Doran claims familiarity with Vessa Kri, who is
// first introduced in chapter 3, in a scene Doran is not part of.
const novelTxt = `===TITLE===
E2E Planted Break
===WORLD-DATA===
${JSON.stringify(worldData)}
===CHAPTER 1: The Quay===
The harbour office smelled of wet rope and old ink. Doran counted the morning manifests twice, the way he always did, while gulls argued on the sill.

“The tide tables are wrong again,” said Doran. “Third time this month.”

“Maybe the moon changed its mind,” said Mira, not looking up from her ledger.

They worked until the lamps needed oil, and the fog came in off the water like a slow decision.

===CHAPTER 2: Manifest===
The morning brought a torn manifest and a name Doran did not expect to see written anywhere.

“I knew Vessa Kri would come back to haunt us,” said Doran, pressing the page flat.

“Who?” said Mira.

He did not answer. The fog had not lifted all day, and the manifests would not balance no matter how he carried the nine.

===CHAPTER 3: The Night Routes===
Vessa Kri stood at the end of the pier as if the fog had assembled her out of spite. Mira found her there at dusk, coiling a line that belonged to no boat in the registry.

“You are the new clerk,” said Vessa Kri. “Tell your office the night routes are none of its business.”

Mira wrote none of it down. Some names, she decided, were safer unrecorded.

===CHAPTER 4: Ledgers===
The week ended the way harbour weeks end, with salt in everything and the ledgers almost, almost square. Mira said nothing about the pier. Doran said nothing about the manifest. The fog kept its own accounts.
`;

writeFileSync(path.join(project, "novel.txt"), novelTxt, "utf8");
writeFileSync(path.join(project, ".renderer/project.json"),
  JSON.stringify({ version: 1, name: "E2E Planted Break", created: Date.now() }), "utf8");
writeFileSync(path.join(userData, "last-project.json"),
  JSON.stringify({ path: project, updated: Date.now() }), "utf8");

const ledgerPath = path.join(project, ".renderer/knowledge-ledger.json");
const cleanup = () => { rmSync(userData, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); };

// ── Drive the real app ─────────────────────────────────────────────────────
const app = await _electron.launch({
  args: ["."],
  cwd: repo,
  env: { ...process.env, LW_USER_DATA: userData, ASSISTANT_MODEL_PATH: MODEL },
});

let failed = null;
try {
  const page = await app.firstWindow();
  // Renderer failures are the difference between "the chain is slow" and "the
  // chain is broken" — surface them in the harness output.
  page.on("pageerror", (err) => console.log("[knowledge-e2e] pageerror:", String(err).slice(0, 400)));
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") console.log("[knowledge-e2e] console.error:", text.slice(0, 400));
    else if (text.includes("[DEBUG-")) console.log("[knowledge-e2e]", text.slice(0, 400));
  });
  await page.waitForLoadState("domcontentloaded");

  // Seed prefs (assistant ON, onboarding done) BEFORE any app script runs.
  // A plain evaluate-then-reload loses the race: the first-load app session
  // keeps saving prefs from ITS state (which has no assistant field) and
  // stomps the seeded value before the reload commits. An init script runs
  // ahead of the app on every navigation, so the app can only ever boot
  // seeing the seeded prefs.
  await app.context().addInitScript(() => {
    localStorage.setItem("latentwrite:prefs-v1", JSON.stringify({
      hasSeenOnboarding: true,
      assistant: { enabled: true },
    }));
  });
  await page.reload();

  console.log("[knowledge-e2e] app up, hermetic profile, waiting for the chain…");
  const t0 = Date.now();
  let last = "";
  let done = false;
  let lastPrinted = 0;
  while (Date.now() - t0 < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 2000));
    if (Date.now() - lastPrinted > 20_000) {
      lastPrinted = Date.now();
      console.log(`[knowledge-e2e] …${((Date.now() - t0) / 1000).toFixed(0)}s ${last}`);
    }
    if (!existsSync(ledgerPath)) { last = "no ledger file yet"; continue; }
    let store;
    try { store = JSON.parse(readFileSync(ledgerPath, "utf8")); } catch { last = "ledger mid-write"; continue; }
    const chapters = Object.keys(store.chapters ?? {}).length;
    const cands = store.candidates ?? [];
    const planted = cands.find((c) => c.key === "Doran→Vessa Kri");
    last = `chapters=${chapters} candidates=${cands.length} planted=${planted ? planted.status : "absent"}`;

    if (planted?.status === "adjudicated" && planted.verdict) {
      const v = planted.verdict;
      console.log(`[knowledge-e2e] verdict landed after ${((Date.now() - t0) / 1000).toFixed(0)}s:`,
        JSON.stringify(v));

      // ★ THIS HARNESS VERIFIES WIRING, NOT JUDGMENT. Whether this particular
      //   planted line is a break or plausible backstory is a model-judgment
      //   question owned by verify-assistant-tasks' frozen fixtures (and
      //   "come back to haunt us" genuinely asserts shared history, so
      //   plausible_offscreen is a defensible reading). Rewriting the story
      //   until the model flips would be tuning against our own test. What
      //   MUST hold here: a schema-valid verdict arrived through the real
      //   app, it was cache-keyed, its downstream effect landed, and nothing
      //   else was accused.
      if (!["break", "plausible_offscreen", "unsure"].includes(v.verdict)) {
        failed = `verdict outside the enum: ${v.verdict}`; break;
      }
      if (typeof v.confidence !== "number" || v.confidence < 0 || v.confidence > 1 || !v.reason) {
        failed = `malformed verdict: ${JSON.stringify(v)}`; break;
      }
      if (!planted.verdictKey) { failed = "no verdictKey — the cache key path did not run"; break; }
      if (v.verdict === "plausible_offscreen") {
        const implied = (store.facts ?? []).some((f) =>
          f.subject === "Doran" && f.entity === "Vessa Kri" && f.how === "reference-implied");
        if (!implied) { failed = "plausible_offscreen verdict without its reference-implied fact"; break; }
        console.log("[knowledge-e2e] reference-implied fact auto-written — the pair is settled evidence now");
      }
      const otherBreaks = cands.filter((c) => c.key !== "Doran→Vessa Kri" && c.verdict?.verdict === "break");
      if (otherBreaks.length > 0) { failed = `false alarms: ${otherBreaks.map((c) => c.key).join(", ")}`; break; }
      done = true;
      break;
    }
  }
  if (!done && !failed) failed = `timed out after ${TIMEOUT_MS / 1000}s (${last})`;
} catch (err) {
  failed = String(err);
} finally {
  await app.close().catch(() => {});
  cleanup();
}

if (failed) {
  console.error(`[knowledge-e2e] ✗ FAIL — ${failed}`);
  process.exit(1);
}
console.log("[knowledge-e2e] ✓ PASS — planted candidate generated, adjudicated by the local model through the real app, verdict + effects persisted, no false alarms");
