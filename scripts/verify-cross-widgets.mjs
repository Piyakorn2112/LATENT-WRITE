/* ─────────────────────────────────────────────────────────────────────────
   verify-cross-widgets — DOM-level check that the cross-chapter widgets
   actually reach the screen.

     node scripts/verify-cross-widgets.mjs

   WHY A DOM CHECK AND NOT A UNIT TEST. The bug this guards against was not
   in any widget's logic — CrossArcWidget and CrossPacingWidget both render
   fine when handed data. It was a GATE three files upstream: the analysis
   runner never told analyzeChapter which intelligence level it ran at, so
   `analysis.highModeAnalysis` was always undefined, and AnalysisPanel's
   `showCrossArc = !!result.analysis.highModeAnalysis` was therefore always
   false. Every layer passed its own unit test; the assembled app showed
   nothing. Only a check that boots the real app, seeds a real multi-chapter
   manuscript, opens the real panel and reads the real DOM can catch that
   class of failure.

   The script distinguishes the three outcomes that look identical to a user
   but are different bugs:
     ABSENT  — the widget never mounted (a gate upstream said no)
     EMPTY   — it mounted but has no neighbour data (the sibling pre-scan
               never populated the cache)
     PRESENT — it mounted with prev/next arcs drawn (correct)

   Exits non-zero on anything but PRESENT for cross-arc, and on ABSENT for
   the high-mode widgets that share the same gate.
   ───────────────────────────────────────────────────────────────────────── */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NOVEL } from "./demo-manuscript.mjs";

async function loadPlaywright() {
  const candidates = [
    "playwright",
    "/Users/piyakorn/Desktop/Srang Tech Mai/stm-page/node_modules/playwright/index.mjs",
  ];
  for (const c of candidates) {
    try { return await import(c); } catch { /* next */ }
  }
  console.error(
    "Could not load Playwright. Install it here (npm i -D playwright && npx playwright install chromium)\n" +
      "or point the candidate list in this script at an existing install.",
  );
  process.exit(1);
}
const { chromium } = await loadPlaywright();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const PORT = Number(process.env.VERIFY_PORT || 5414);
const ORIGIN = `http://localhost:${PORT}`;

const NOVEL_KEY = "glass-editor:novel-v1";
const PREFS_KEY = "latentwrite:prefs-v1";
const CHAPTER_KEY = "glass-editor:current-chapter-v1";

const PREFS = {
  hasSeenOnboarding: true,
  typography: { fontFamily: "georgia", fontSize: 18, lineHeight: 1.7, measure: 70 },
  goals: { dailyWords: 0 },
  funMode: false,
  debugPanel: false,
  storyNlpEnabled: true,
  splitView: false,
  intelMode: "auto", // the DEFAULT mode — the bug must be caught here, not on "high"
};

/* Land on chapter 2 so both a previous and a next chapter exist. */
const MIDDLE = NOVEL.chapters[1]?.id ?? NOVEL.chapters[0].id;

/* ── dev server ──────────────────────────────────────────────────────────── */
const vite = spawn(
  path.join(ROOT, "node_modules", ".bin", "vite"),
  ["--port", String(PORT), "--strictPort"],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
);
let viteOut = "";
vite.stdout.on("data", (d) => { viteOut += d; });
vite.stderr.on("data", (d) => { viteOut += d; });

const stopVite = () => { try { vite.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", stopVite);

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(ORIGIN, { method: "GET" });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`vite never came up on ${ORIGIN}\n${viteOut}`);
}

/* ── the probe ───────────────────────────────────────────────────────────── */

/** Read every widget card's top-left label out of the live panel. */
const READ_WIDGETS = () => {
  const cards = [...document.querySelectorAll(".widget-card")];
  return cards.map((c) => {
    const label = c.querySelector(".widget-corner-label");
    return (label?.textContent || "").trim();
  }).filter(Boolean);
};

/**
 * Classify the cross-arc widget: ABSENT / EMPTY / PRESENT.
 *
 * EMPTY is the state where the card mounted but neither neighbour analysis
 * was in the cache — the widget renders its own hint text and both side
 * cells carry the `--empty` modifier.
 */
const READ_CROSS_ARC = () => {
  const card = [...document.querySelectorAll(".widget-card")].find((c) =>
    (c.querySelector(".widget-corner-label")?.textContent || "").trim() === "CROSS-ARC",
  );
  if (!card) return { state: "ABSENT" };
  const cells = [...card.querySelectorAll(".wg-cross-cell")];
  const emptyCells = cells.filter((c) => c.className.includes("wg-cross-cell--empty")).length;
  const hint = !!card.querySelector(".wg-cross-hint");
  const pattern = card.querySelector(".wg-cross-pattern-pill")?.textContent?.trim() || null;
  const tensions = [...card.querySelectorAll(".wg-cross-cell-tension")].map((n) => n.textContent.trim());
  return {
    state: hint && emptyCells === 2 ? "EMPTY" : "PRESENT",
    cells: cells.length,
    emptyCells,
    pattern,
    tensions,
  };
};

/* A widget config saved before the cross widgets were registered. New
   registry entries must be merged in, not hidden — see mergeWithDefaults in
   src/lib/widget-config.ts. */
const STALE_CONFIG = {
  version: 1,
  order: [
    "diagnostics", "shaping", "tension", "structure", "voice", "cast", "role",
  ].map((id) => ({ id, enabled: true })),
};

async function probe(browser, { name, widgetConfig }) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.addInitScript(`
    localStorage.setItem(${JSON.stringify(NOVEL_KEY)}, ${JSON.stringify(JSON.stringify(NOVEL))});
    localStorage.setItem(${JSON.stringify(CHAPTER_KEY)}, ${JSON.stringify(MIDDLE)});
    localStorage.setItem(${JSON.stringify(PREFS_KEY)}, ${JSON.stringify(JSON.stringify(PREFS))});
    ${widgetConfig
      ? `localStorage.setItem("latentwrite:widget-config-v1", ${JSON.stringify(JSON.stringify(widgetConfig))});`
      : `localStorage.removeItem("latentwrite:widget-config-v1");`}
  `);

  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });

  // Open the analysis drawer.
  const tab = page.locator('[aria-label="Expand analysis"]').first();
  await tab.waitFor({ timeout: 20000 });
  await tab.click();

  /* Poll until the widget list stops growing. The app runs a fast pass at
     ~1s, converges to the deep pass ~1.6s after that, then pre-scans the
     neighbours on idle — so the settle point is data-defined, not a guess. */
  let last = "";
  let stable = 0;
  let labels = [];
  for (let i = 0; i < 80; i++) {
    labels = await page.evaluate(READ_WIDGETS);
    const sig = labels.join("|");
    stable = sig === last && labels.length > 0 ? stable + 1 : 0;
    last = sig;
    if (stable >= 4 && i > 20) break;
    await page.waitForTimeout(250);
  }

  const cross = await page.evaluate(READ_CROSS_ARC);
  const crossPacing = labels.includes("CROSS-PACING");
  await ctx.close();

  console.log(`\n── ${name} ──`);
  console.log(`widgets (${labels.length}): ${labels.join(", ") || "none"}`);
  console.log(`cross-arc     : ${cross.state}${cross.state === "PRESENT" ? `  empty-cells=${cross.emptyCells}  pattern=${cross.pattern ?? "—"}  tensions=[${cross.tensions.join(", ")}]` : ""}`);
  console.log(`cross-pacing  : ${crossPacing ? "PRESENT" : "ABSENT"}`);
  if (errors.length) console.log(`page errors   : ${errors.join(" | ")}`);

  const failures = [];
  if (cross.state !== "PRESENT") {
    failures.push(`${name}: cross-arc is ${cross.state} (expected PRESENT — both neighbours analysed)`);
  }
  if (cross.state === "PRESENT" && cross.emptyCells > 0) {
    failures.push(`${name}: cross-arc has ${cross.emptyCells} empty neighbour cell(s) — the sibling pre-scan did not populate the cache`);
  }
  if (!crossPacing) failures.push(`${name}: cross-pacing is ABSENT`);

  /* These share the exact gate the bug lived in. If they regress, the gate
     regressed — assert them so the next break is diagnosed, not hunted. */
  for (const gated of ["SHAPING", "STRUCTURE", "MOMENTUM", "SENSORY"]) {
    if (!labels.includes(gated)) failures.push(`${name}: ${gated} is ABSENT — the high-mode gate regressed`);
  }
  if (errors.length) failures.push(`${name}: ${errors.length} page error(s)`);
  return failures;
}

async function run() {
  await waitForServer();
  const browser = await chromium.launch();
  const failures = [
    ...await probe(browser, { name: "default config", widgetConfig: null }),
    ...await probe(browser, { name: "stale saved config (predates the cross widgets)", widgetConfig: STALE_CONFIG }),
  ];
  await browser.close();

  if (failures.length) {
    console.log(`\nFAIL\n  - ${failures.join("\n  - ")}\n`);
    process.exitCode = 1;
    return;
  }
  console.log("\nPASS — cross-chapter widgets render with neighbour data in both configs\n");
}

try {
  await run();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  stopVite();
}
