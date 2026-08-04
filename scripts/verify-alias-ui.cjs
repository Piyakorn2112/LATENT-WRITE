/**
 * verify-alias-ui.cjs — the alias suggestions, on the REAL WorldDataView.
 *
 * Mounts /alias-verify.html (the shipping component + a deliberately
 * fragmented cast) and asserts what the writer actually sees: the field
 * appears, a duplicate cast entry is offered as a MERGE and says so, each row
 * carries the rule and a verbatim line from the book, and — the negative that
 * matters — the sister who shares her brother's surname is NOT offered.
 *
 *   VITE_URL=http://localhost:5178 electron scripts/verify-alias-ui.cjs
 */
const { app, BrowserWindow, nativeTheme } = require("electron");
if (process.env.THEME) nativeTheme.themeSource = process.env.THEME;
const fs = require("node:fs");
const path = require("node:path");
const BASE = process.env.VITE_URL || "http://localhost:5178";
const OUT = path.join(__dirname, "..", ".glass-shots");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch("force-device-scale-factor", "1");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 880, show: false });
  const consoleLines = [];
  win.webContents.on("console-message", (_e, _lvl, message) => consoleLines.push(message));
  await win.loadURL(`${BASE}/alias-verify.html`);
  await wait(2200);
  // The detail pane only renders once a character is selected.
  await win.webContents.executeJavaScript(
    `document.querySelectorAll(".world-row")[0]?.click()`, true);
  await wait(900);
  const p = await win.webContents.executeJavaScript("window.__probe && window.__probe()");
  // ★★ THE SECOND CHARACTER IS NOT OPTIONAL. "Holmes" is the entry with the
  //    MERGE proposal, and every merge-specific gate below would pass
  //    vacuously on Elizabeth's row, which has none.
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll(".world-row-name")]
       .find((n) => n.textContent === "Holmes")?.closest(".world-row")?.click()`, true);
  await wait(700);
  const m = await win.webContents.executeJavaScript("window.__probe && window.__probe()");
  if (!p || p.error) { console.error("probe failed:", p && p.error); app.exit(2); return; }
  const warnings = consoleLines.filter((l) => /alias|error|Error/i.test(l));
  if (warnings.length) console.log(`page console:\n  ${warnings.slice(0, 5).join("\n  ")}\n`);

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, `alias-suggestions${process.env.THEME ? "-" + process.env.THEME : ""}.png`),
    (await win.capturePage()).toPNG());

  const results = [];
  const ok = (label, cond, detail) => results.push({ label, cond, detail });
  // ★★ EVERY "every(...)" GATE BELOW IS PAIRED WITH A COUNT. The first run of
  //    this verifier reported 4 of 7 green on an EMPTY list — `every` on an
  //    empty array is true, and `0 === 0` is true, so four gates certified a
  //    feature that rendered nothing at all. This repo has shipped that trap
  //    twice before; assume it.
  ok("the suggestions field renders", p.fieldPresent === true, JSON.stringify(p));
  ok("…and it actually has rows", p.rowCount > 0, `${p.rowCount} rows`);
  ok("Elizabeth is offered her nickname", p.names.includes("Lizzy"), p.names.join(", "));
  ok("each row says WHICH rule fired",
    p.whys.length === p.rowCount && p.rowCount > 0 && p.whys.every((w) => w.length > 0),
    p.whys.join(" | "));
  ok("each row carries verbatim evidence",
    p.rowCount > 0 && p.evidenceCount === p.rowCount,
    `${p.evidenceCount} evidence for ${p.rowCount} rows`);
  ok("the buttons say what they do", p.buttons.length > 0 && p.buttons.includes("No")
    && (p.buttons.includes("Add") || p.buttons.includes("Same person")), p.buttons.join(", "));
  ok("no row overflows its pane", p.rowCount > 0 && p.overflowing === 0, `${p.overflowing} overflowing`);

  // ── the duplicate cast entry ───────────────────────────────────────────
  ok("a duplicate entry is offered as a merge", m.rowCount > 0 && m.names.includes("Sherlock Holmes"),
    `Holmes rows: ${m.names.join(", ") || "(none)"}`);
  ok("★ …and it is LABELLED a duplicate before it is clicked",
    m.mergeBadges.length > 0 && m.mergeBadges.every((b) => /duplicate/i.test(b)),
    `badges: ${m.mergeBadges.join(", ") || "(none)"}`);
  ok("★ …with a button that says what it does, not \"Add\"",
    m.buttons.includes("Same person"), `buttons: ${m.buttons.join(", ")}`);
  // The pair: an ordinary alias must NOT wear the duplicate badge, or the
  // label means nothing.
  ok("…while an ordinary alias carries no duplicate badge",
    p.mergeBadges.length === 0, `Elizabeth badges: ${p.mergeBadges.join(", ")}`);
  // ★ THE NEGATIVE THAT MATTERS. Miss Darcy is Georgiana. If she ever appears
  //   in this list the engine is offering to delete a character.
  ok("★★ the sister is NEVER offered as an alias of her brother",
    !p.names.includes("Miss Darcy"), p.names.join(", "));

  console.log("\nalias suggestions, real component:");
  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.cond ? "✓" : "✗"} ${r.label}${r.cond ? "" : ` — ${r.detail}`}`);
    if (!r.cond) failed++;
  }
  console.log(`\nrows: ${p.names.join(", ") || "(none)"}`);
  console.log(`shot: ${OUT}/alias-suggestions.png`);
  console.log(failed ? `FAILED ${failed}/${results.length}` : `PASS ${results.length}/${results.length}`);
  app.exit(failed ? 1 : 0);
});
