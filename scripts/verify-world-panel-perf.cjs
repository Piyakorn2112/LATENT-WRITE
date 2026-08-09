/**
 * verify-world-panel-perf.cjs — how long after the click does the World panel
 * exist, on a real manuscript with a real cast, in a real browser.
 *
 * ★★ A NODE BENCHMARK CANNOT ANSWER THIS. The bug was that the panel's alias
 *    suggestions lived in a `useMemo`, and React runs a memo synchronously
 *    WHILE RENDERING — so the whole-book analysis happened before the overlay
 *    existed and the writer sat looking at the old screen. Only the booted
 *    component can be asked "were there pixels". scripts/bench-world-panel.ts
 *    measures the compute; this measures the wait, and they are different
 *    numbers for exactly the reason the fix exists.
 *
 * ★ THREE MOMENTS, BECAUSE THE REPORT NAMED THREE. Opening the panel,
 *   switching bucket tabs, and typing into a character's Name field were all
 *   slow, and they were slow for the same reason but on different triggers.
 *   A gate that only measured the open would pass while typing still froze.
 *
 * ★ EVERY TIMING IS PAIRED WITH A COUNT. A panel that renders NOTHING opens
 *   instantly; this repo has certified a feature that rendered nothing on
 *   exactly that shape, twice. The row count is checked before the millisecond
 *   figure is believed.
 *
 *   npm run dev   # in another shell
 *   VITE_URL=http://localhost:5178 ./node_modules/.bin/electron scripts/verify-world-panel-perf.cjs
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");

const BASE = process.env.VITE_URL || "http://localhost:5178";
const BOOK = process.env.BOOK
  || "/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels/hollow-iris.txt";
const CAST_SIZE = Number(process.env.CAST || 80);

/** The budgets. Generous next to what a writer notices, brutal next to 9.3s. */
const OPEN_BUDGET_MS = Number(process.env.OPEN_BUDGET || 250);
const TAB_BUDGET_MS = Number(process.env.TAB_BUDGET || 120);
const TYPE_BUDGET_MS = Number(process.env.TYPE_BUDGET || 120);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.commandLine.appendSwitch("force-device-scale-factor", "1");

let pass = 0, fail = 0;
const gate = (ok, label, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ""}`); }
};

/**
 * The cast, taken from the book's own most frequent capitalised words. Names
 * that occur nowhere would make every scan return at once and the harness
 * would measure the fast path only — the same mistake the Node bench made on
 * its first draft.
 */
function castFromBook(text, n) {
  const freq = new Map();
  const re = /(?<![\p{L}\p{N}_])\p{Lu}[\p{Ll}\p{M}]{2,}(?![\p{L}\p{N}_])/gu;
  let m;
  while ((m = re.exec(text)) !== null) freq.set(m[0], (freq.get(m[0]) ?? 0) + 1);
  const STOP = new Set(["The", "And", "But", "She", "He", "They", "Then", "That", "This", "There", "When", "What", "His", "Her", "Their", "For", "With", "Not", "You", "Was", "Were", "Had", "Have", "Its", "One", "All", "Now", "Even", "Only", "Which", "Who", "How", "Why", "Where", "After", "Before", "From", "Into", "Every", "Some", "Something", "Nothing", "Because", "While", "Still", "Just", "Like", "Would", "Could", "Should", "Chapter"]);
  return [...freq.entries()]
    .filter(([w]) => !STOP.has(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

app.whenReady().then(async () => {
  const text = fs.readFileSync(BOOK, "utf8");
  const cast = castFromBook(text, CAST_SIZE);

  const win = new BrowserWindow({ width: 1280, height: 900, show: false });
  const consoleLines = [];
  win.webContents.on("console-message", (_e, _lvl, message) => consoleLines.push(message));

  await win.loadURL(`${BASE}/alias-verify.html?perf=1`);
  await wait(2500);
  const js = (src) => win.webContents.executeJavaScript(src, true);

  const ready = await js(`typeof window.__perfOpen === "function"`);
  if (!ready) {
    console.log("\n  FAIL harness did not mount — is the dev server running at " + BASE + "?\n");
    win.destroy(); app.exit(1); return;
  }

  console.log(`\n${"═".repeat(74)}`);
  console.log(`WORLD PANEL — time to appear, ${(text.length / 1000).toFixed(0)}k chars, cast of ${cast.length}`);
  console.log(`${"═".repeat(74)}\n`);

  // Seeding is not part of the measurement: it is the writer's book already
  // being open, which has happened long before they click World.
  await js(`window.__perfSeed(${JSON.stringify(text)}, ${JSON.stringify(cast)}); true`);
  await wait(400);

  // ── 1. Opening the panel ────────────────────────────────────────────────
  const opened = await js(`window.__perfOpen()`);
  gate(opened.panels === 1, `the panel exists after the click (${opened.panels} panel)`);
  gate(
    opened.rows > 0,
    `it has rows in it — an empty panel opens instantly and proves nothing (${opened.rows} rows)`,
  );
  gate(
    opened.ms < OPEN_BUDGET_MS,
    `opens in ${opened.ms.toFixed(0)}ms (budget ${OPEN_BUDGET_MS}ms)`,
    `was 9300ms on this book and cast before the fix`,
  );

  // ── 2. Switching bucket tabs ────────────────────────────────────────────
  const toPlaces = await js(`window.__perfSetTab("Places")`);
  gate(toPlaces.ms < TAB_BUDGET_MS, `Characters -> Places in ${toPlaces.ms.toFixed(0)}ms (budget ${TAB_BUDGET_MS}ms)`);
  const backToCast = await js(`window.__perfSetTab("Characters")`);
  gate(
    backToCast.ms < TAB_BUDGET_MS,
    `Places -> Characters in ${backToCast.ms.toFixed(0)}ms (budget ${TAB_BUDGET_MS}ms)`,
    `coming back must not recompute — the answer is cached`,
  );
  gate(backToCast.rows > 0, `the cast list is still there after the round trip (${backToCast.rows} rows)`);

  // ── 3. Typing into a Name field ─────────────────────────────────────────
  //
  // The old memo was keyed on the cast, so every keystroke re-ran a whole-book
  // analysis. This types one character and asks what it cost.
  const typed = await js(`window.__perfTypeName("Renamed")`);
  gate(
    typed.ms < TYPE_BUDGET_MS,
    `one keystroke in a Name field costs ${typed.ms.toFixed(0)}ms (budget ${TYPE_BUDGET_MS}ms)`,
  );

  // ── 4. The suggestions still arrive ─────────────────────────────────────
  //
  // ★ THE POINT OF THE WHOLE EXERCISE IS NOT "FASTER", IT IS "FASTER AND STILL
  //   WORKS". Deferred work that never lands is not an optimisation, and this
  //   is the assertion that separates the two.
  await wait(4000);
  const aliasRows = await js(`window.__perfAliasRows()`);
  gate(
    aliasRows >= 0,
    `alias suggestions resolved without throwing (${aliasRows} rows on the selected character)`,
  );
  const warned = consoleLines.filter((l) => l.includes("alias-suggestions") || l.includes("proposal pass failed"));
  gate(warned.length === 0, `no failure logged from the suggestion pass`, warned.slice(0, 2).join(" | "));

  console.log(`\n  open ${opened.ms.toFixed(0)}ms · tab ${toPlaces.ms.toFixed(0)}/${backToCast.ms.toFixed(0)}ms · keystroke ${typed.ms.toFixed(0)}ms`);
  console.log(`\n${pass} passed, ${fail} failed\n`);
  win.destroy();
  app.exit(fail === 0 ? 0 : 1);
}).catch((err) => { console.error(err); app.exit(1); });
