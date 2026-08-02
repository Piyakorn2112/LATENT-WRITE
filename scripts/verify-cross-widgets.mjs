/* ─────────────────────────────────────────────────────────────────────────
   verify-cross-widgets — DOM-level check that the cross-chapter widgets
   actually reach the screen.

     node scripts/verify-cross-widgets.mjs

   WHY A DOM CHECK AND NOT A UNIT TEST. The bug this guards against was not
   in any widget's logic — CrossArcWidget rendered fine when handed data. It
   was a GATE three files upstream: the analysis runner never told
   analyzeChapter which intelligence level it ran at, so
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

   It now also guards the panel CONSOLIDATION, because the same "assembled
   app" argument applies to it:

     · cross-arc PRESENT with neighbour data (the original gate check)
     · shaping PRESENT — the surviving highModeAnalysis-gated sibling, so a
       regression of that gate is still diagnosed rather than hunted
     · the five retired widgets ABSENT from the DOM — structure, momentum,
       sensory, cross-pacing, titles. A registry entry is not the only way
       a widget can come back; a stale saved profile is another, which is
       exactly what the migration below has to prevent.
     · the DEFAULT READING ORDER of the leading cards. Order is a design
       decision that lives in one array and is trivially undone by an
       accidental re-sort, and no unit test would notice.
     · the v1 → v2 config MIGRATION, end to end: a hand-sorted v1 profile
       must come back re-based to the new registry order with the user's
       disabled widget still disabled, and must persist as version 2.

   Exits non-zero on anything but PRESENT for cross-arc, on ABSENT for
   shaping, on any retired widget reappearing, and on an order or migration
   mismatch.
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

/** Read the Edit Widgets overlay: row order plus each row's checked state. */
const READ_CONFIG_OVERLAY = () => {
  const rows = [...document.querySelectorAll(".wc-panel .wc-row")];
  return rows.map((r) => ({
    label: (r.querySelector(".wc-row-label")?.textContent || "").trim(),
    enabled: r.querySelector('[role="checkbox"]')?.getAttribute("aria-checked") === "true",
  }));
};

const LS_CONFIG_KEY = "latentwrite:widget-config-v1";

/* ── expectations ────────────────────────────────────────────────────────── */

/* The corner labels the retired widgets used to paint. Asserting on the
   LABEL, not the registry id, is deliberate: a widget can only fail this
   check by actually reaching the screen. */
const RETIRED_LABELS = ["STRUCTURE", "MOMENTUM", "SENSORY", "CROSS-PACING", "TITLES"];

/* Diagnostics gates on `writerDiagnostics.length > 0`, so it may legitimately
   not render for a given manuscript. Mirror that gate here — assert its
   POSITION when it appears, never its presence. */
const DIAGNOSTICS_LABEL = "WRITER NOTES";
const ORDER_HEAD = ["TENSION ARC", "CAST", "CONTINUITY"];

/* Registry order as the config overlay lists it. Tool-plugin widgets append
   after these, so only the prefix is compared. */
const REGISTRY_LABELS = [
  "Diagnostics", "Tension", "Cast", "Continuity", "Cross Arc", "Role", "Shaping",
  "Prose Profile", "Voice", "Rhythm", "Repetition", "Style Watch", "Character Voice",
];

function checkOrderHead(name, labels) {
  const expected = labels.includes(DIAGNOSTICS_LABEL)
    ? [DIAGNOSTICS_LABEL, ...ORDER_HEAD]
    : ORDER_HEAD;
  const actual = labels.slice(0, expected.length);
  if (actual.join("|") === expected.join("|")) return [];
  return [`${name}: leading widgets are [${actual.join(", ")}] (expected [${expected.join(", ")}])`];
}

/* ── seeded configs ──────────────────────────────────────────────────────── */

/* A widget config saved before the cross widgets were registered. New
   registry entries must be merged in, not hidden — see mergeWithDefaults in
   src/lib/widget-config.ts. */
const STALE_CONFIG = {
  version: 1,
  order: [
    "diagnostics", "shaping", "tension", "structure", "voice", "cast", "role",
  ].map((id) => ({ id, enabled: true })),
};

/* A v1 profile the user actually hand-sorted, carrying three now-retired ids
   and one widget they switched OFF. The migration must:
     · re-base it onto the v2 registry order (their sort predates the new
       default and has no opinion worth keeping about it),
     · keep `role` disabled (the enabled flags are theirs, not ours),
     · drop the retired ids,
     · come back out persisted as version 2.
   `role` is the disabled id on purpose: its render gate is an unconditional
   `true`, so its absence from the DOM can only mean the flag survived. */
const MIGRATION_DISABLED_ID = "role";
const MIGRATION_DISABLED_LABELS = { card: "CHAPTER ROLE", row: "Role" };
const V1_CUSTOM_CONFIG = {
  version: 1,
  order: [
    { id: "title-suggester", enabled: true },
    { id: MIGRATION_DISABLED_ID, enabled: false },
    { id: "sensory-balance", enabled: true },
    { id: "cast", enabled: true },
    { id: "cross-pacing", enabled: true },
    { id: "tension", enabled: true },
    { id: "diagnostics", enabled: true },
    { id: "continuity", enabled: true },
    { id: "cross-arc", enabled: true },
    { id: "voice", enabled: true },
    { id: "shaping", enabled: true },
  ],
};

async function probe(browser, { name, widgetConfig, migration = false }) {
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
  const failures = [];

  /* ── migration scenario: drive the real overlay, then read what it wrote ──
     The DOM order alone proves the re-base, but only a real Save proves the
     profile is rewritten as version 2 — that is the step which makes the
     migration one-time rather than recomputed on every load. */
  let overlayRows = null;
  let persistedVersion = null;
  if (migration) {
    await page.getByRole("button", { name: "Edit Widgets" }).first().click();
    await page.locator(".wc-panel .wc-row").first().waitFor({ timeout: 10000 });
    overlayRows = await page.evaluate(READ_CONFIG_OVERLAY);
    await page.locator(".wc-panel .wc-btn--primary").click();
    await page.locator(".wc-panel").waitFor({ state: "detached", timeout: 10000 });
    persistedVersion = await page.evaluate((key) => {
      try { return JSON.parse(localStorage.getItem(key) || "null")?.version ?? null; }
      catch { return null; }
    }, LS_CONFIG_KEY);
  }

  await ctx.close();

  const retired = RETIRED_LABELS.filter((l) => labels.includes(l));

  console.log(`\n── ${name} ──`);
  console.log(`widgets (${labels.length}): ${labels.join(", ") || "none"}`);
  console.log(`cross-arc     : ${cross.state}${cross.state === "PRESENT" ? `  empty-cells=${cross.emptyCells}  pattern=${cross.pattern ?? "—"}  tensions=[${cross.tensions.join(", ")}]` : ""}`);
  console.log(`shaping       : ${labels.includes("SHAPING") ? "PRESENT" : "ABSENT"}`);
  console.log(`retired       : ${retired.length ? `LEAKED → ${retired.join(", ")}` : "none on screen (correct)"}`);
  if (migration) {
    console.log(`overlay order : ${(overlayRows ?? []).map((r) => `${r.label}${r.enabled ? "" : " (off)"}`).join(", ") || "none"}`);
    console.log(`persisted ver : ${persistedVersion ?? "—"}`);
  }
  if (errors.length) console.log(`page errors   : ${errors.join(" | ")}`);

  if (cross.state !== "PRESENT") {
    failures.push(`${name}: cross-arc is ${cross.state} (expected PRESENT — both neighbours analysed)`);
  }
  if (cross.state === "PRESENT" && cross.emptyCells > 0) {
    failures.push(`${name}: cross-arc has ${cross.emptyCells} empty neighbour cell(s) — the sibling pre-scan did not populate the cache`);
  }

  /* Shaping is the last widget still gated on `highModeAnalysis` — the exact
     gate the original bug lived in. If it regresses, the gate regressed. */
  if (!labels.includes("SHAPING")) {
    failures.push(`${name}: SHAPING is ABSENT — the high-mode gate regressed`);
  }

  /* Consolidated-away widgets must not come back, by any route. */
  for (const l of retired) {
    failures.push(`${name}: retired widget ${l} is on screen — it was consolidated away`);
  }

  failures.push(...checkOrderHead(name, labels));

  if (migration) {
    if (labels.includes(MIGRATION_DISABLED_LABELS.card)) {
      failures.push(`${name}: ${MIGRATION_DISABLED_LABELS.card} rendered — the user's disabled flag was lost in the migration`);
    }
    const rows = overlayRows ?? [];
    const actualPrefix = rows.slice(0, REGISTRY_LABELS.length).map((r) => r.label);
    if (actualPrefix.join("|") !== REGISTRY_LABELS.join("|")) {
      failures.push(`${name}: config overlay order is [${actualPrefix.join(", ")}] (expected the v2 registry order [${REGISTRY_LABELS.join(", ")}])`);
    }
    const disabledRow = rows.find((r) => r.label === MIGRATION_DISABLED_LABELS.row);
    if (!disabledRow) {
      failures.push(`${name}: no "${MIGRATION_DISABLED_LABELS.row}" row in the config overlay`);
    } else if (disabledRow.enabled) {
      failures.push(`${name}: "${MIGRATION_DISABLED_LABELS.row}" came back ENABLED — the migration overwrote the user's flag`);
    }
    const offRows = rows.filter((r) => !r.enabled).map((r) => r.label);
    if (offRows.length !== 1) {
      failures.push(`${name}: ${offRows.length} widgets disabled [${offRows.join(", ")}] (expected exactly 1 — the migration must not disable anything of its own)`);
    }
    if (persistedVersion !== 2) {
      failures.push(`${name}: saved config is version ${persistedVersion} (expected 2 — the migration must persist forward)`);
    }
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
    ...await probe(browser, { name: "v1 → v2 migration (hand-sorted profile, one widget off)", widgetConfig: V1_CUSTOM_CONFIG, migration: true }),
  ];
  await browser.close();

  if (failures.length) {
    console.log(`\nFAIL\n  - ${failures.join("\n  - ")}\n`);
    process.exitCode = 1;
    return;
  }
  console.log("\nPASS — cross-arc has neighbour data, the high-mode gate holds, the retired widgets stay gone, the default order is intact, and a v1 profile migrates to v2\n");
}

try {
  await run();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  stopVite();
}
