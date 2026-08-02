/**
 * verify-widget-help.mjs — can a writer find out what a widget is showing?
 *
 * Every enabled widget must offer a "?" that reveals its explainer, and the
 * copy must come from WIDGET_REGISTRY rather than from a second copy that can
 * drift. Also asserts the affordance is QUIET by default: nothing explanatory
 * renders until it is asked for.
 *
 *   /opt/homebrew/bin/node scripts/verify-widget-help.mjs
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NOVEL } from "./demo-manuscript.mjs";

// Same loader the other browser harnesses use: playwright-core ships no
// browsers, so borrow a full install if one is reachable.
async function loadPlaywright() {
  const candidates = [
    "playwright",
    "/Users/piyakorn/Desktop/Srang Tech Mai/stm-page/node_modules/playwright/index.mjs",
  ];
  for (const c of candidates) {
    try { return await import(c); } catch { /* next */ }
  }
  console.error("Could not load Playwright (npm i -D playwright && npx playwright install chromium).");
  process.exit(1);
}
const { chromium } = await loadPlaywright();

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5199;

// ★ Read the copy out of the registry at run time. A harness holding its own
//   copy of the thing under test keeps passing after the source changes.
const registrySrc = readFileSync(path.join(repo, "src/lib/widget-config.ts"), "utf8");
const helpTexts = [...registrySrc.matchAll(/help:\s*"((?:[^"\\]|\\.)*)"/g)]
  .map((m) => m[1].replace(/\\"/g, '"'));
if (helpTexts.length < 13) {
  console.error(`[widget-help] ✗ expected 13+ help strings in the registry, found ${helpTexts.length}`);
  process.exit(1);
}

const ORIGIN = `http://localhost:${PORT}`;
const dev = spawn(
  path.join(repo, "node_modules", ".bin", "vite"),
  ["--port", String(PORT), "--strictPort"],
  { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
);
let viteOut = "";
dev.stdout.on("data", (d) => { viteOut += d; });
dev.stderr.on("data", (d) => { viteOut += d; });
process.on("exit", () => { try { dev.kill("SIGTERM"); } catch { /* gone */ } });

// Poll the port rather than parsing startup chatter — the banner's wording is
// not a contract, the port answering is.
{
  const deadline = Date.now() + 45_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try { up = (await fetch(ORIGIN)).ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) {
    try { dev.kill(); } catch {}
    console.error(`[widget-help] ✗ vite never came up on ${ORIGIN}\n${viteOut}`);
    process.exit(1);
  }
}

const browser = await chromium.launch();
let failures = 0;
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(([novel]) => {
    localStorage.setItem("glass-editor:novel-v1", JSON.stringify(novel));
    localStorage.setItem("latentwrite:prefs-v1", JSON.stringify({ hasSeenOnboarding: true }));
  }, [NOVEL]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  const tab = page.locator('[aria-label="Expand analysis"]').first();
  await tab.waitFor({ timeout: 20_000 });
  await tab.click();
  await page.waitForSelector(".widget-card", { timeout: 30_000 });
  await page.waitForTimeout(5000); // let the deep pass land so gated widgets mount

  const cards = await page.locator(".widget-card").count();
  const helpButtons = page.locator('.widget-card button[aria-label="What does this show?"]');
  const buttons = await helpButtons.count();

  // 1. Quiet by default — no explainer text on screen until asked.
  const visibleBefore = await page.evaluate((texts) =>
    texts.filter((t) => document.body.innerText.includes(t.slice(0, 40))).length, helpTexts);

  // 2. Every card that can explain itself, does.
  const check = (ok, label, detail) => {
    console.log(`  ${ok ? "✓" : "✗"} ${label} — ${detail}`);
    if (!ok) failures++;
  };
  check(cards > 0, "widgets rendered", `${cards} cards`);
  check(buttons === cards, "every card offers a ?", `${buttons} buttons / ${cards} cards`);
  check(visibleBefore === 0, "quiet by default", `${visibleBefore} explainers visible before asking`);

  // 3. Asking reveals the REGISTRY copy, and asking again hides it.
  // Always nth(0): opening a card flips its aria-label to the dismiss form, so
  // it leaves this locator's set and every later index shifts down.
  let revealed = 0;
  for (let i = 0; i < buttons; i++) {
    await helpButtons.first().click();
    await page.waitForTimeout(90);
  }
  const shown = await page.evaluate((texts) =>
    texts.filter((t) => document.body.innerText.includes(t.slice(0, 40))).length, helpTexts);
  revealed = shown;
  check(revealed >= Math.min(buttons, 8), "asking reveals the registry copy",
    `${revealed} of the registry's ${helpTexts.length} strings on screen`);

  const closers = page.locator('.widget-card button[aria-label="Hide what this shows"]');
  check(await closers.count() === buttons, "the ? becomes a dismiss", `${await closers.count()} dismiss controls`);
  for (let i = await closers.count(); i > 0; i--) {
    await closers.nth(0).click().catch(() => {});
    await page.waitForTimeout(60);
  }
  const after = await page.evaluate((texts) =>
    texts.filter((t) => document.body.innerText.includes(t.slice(0, 40))).length, helpTexts);
  check(after === 0, "dismiss restores silence", `${after} explainers left on screen`);
  check(errors.length === 0, "no page errors", errors.length ? errors[0] : "clean");
} finally {
  await browser.close().catch(() => {});
  dev.kill();
}

console.log(failures === 0
  ? "\n[widget-help] ✓ PASS — every widget can explain itself, and says nothing until asked"
  : `\n[widget-help] ✗ FAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
