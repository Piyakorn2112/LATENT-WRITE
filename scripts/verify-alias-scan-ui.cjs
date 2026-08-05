/**
 * verify-alias-scan-ui.cjs — press the button, on the REAL WorldDataView.
 *
 * scripts/test-alias-scan.ts proves the ENGINE on the stress chapter. It
 * cannot prove that a button exists, that pressing it reaches the engine, that
 * the rows render, that the attested ones arrive ticked and the guesses do
 * not, or — the one that matters — that "Add" writes the names into the cast.
 * Only the running component makes those shapes.
 *
 * ★★ EVERY ASSERTION IS PAIRED WITH A COUNT. `every()` over an empty list is
 *    true and `0 === 0` is true; a verifier in this repo once read 4 of 7
 *    green on a list that rendered nothing. The first gate is the row count.
 *
 *   VITE_URL=http://localhost:5178 ./node_modules/.bin/electron scripts/verify-alias-scan-ui.cjs
 */
const { app, BrowserWindow, nativeTheme } = require("electron");
if (process.env.THEME) nativeTheme.themeSource = process.env.THEME;
const path = require("node:path");
const BASE = process.env.VITE_URL || "http://localhost:5178";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch("force-device-scale-factor", "1");

let pass = 0, fail = 0;
const gate = (ok, label, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ""}`); }
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 900, show: false });
  const consoleLines = [];
  win.webContents.on("console-message", (_e, _lvl, message) => consoleLines.push(message));

  await win.loadURL(`${BASE}/alias-verify.html?scan=1`);
  await wait(2200);

  const js = (src) => win.webContents.executeJavaScript(src, true);

  // No preload here, so window.electronAPI is absent and assistantAvailable()
  // is false — this exercises the DETERMINISTIC path, which is the path that
  // carries the feature and the only one that must work everywhere.
  // ★ COUNTED BEFORE THE SCAN OPENS, not after. The review panel REPLACES the
  //   cast list, so ".world-row" is 0 while it is up — reading it there and
  //   comparing to 4 afterwards reports "the scan added three characters".
  //   Measuring the right element at the wrong moment is the same bug as
  //   measuring the wrong element.
  const castBefore = await js(`document.querySelectorAll(".world-row").length`);

  const button = await js(
    `!!document.querySelector('[aria-label="Scan for other names these characters are called"]')`);
  gate(button, "the scan button is on the characters tab");
  if (!button) { console.log("\nno button — nothing else can be measured."); app.exit(1); return; }

  await js(`document.querySelector('[aria-label="Scan for other names these characters are called"]').click()`);
  await wait(3500);

  const p = await js("window.__scanProbe && window.__scanProbe()");
  if (!p) { console.error("probe missing"); app.exit(2); return; }

  console.log(`\n  phase: "${p.phaseTitle}"  ·  ${p.rowCount} rows  ·  ${p.ticked} ticked`);
  for (let i = 0; i < p.names.length; i++) console.log(`    [${i}] ${p.names[i]}  —  ${p.whys[i]}`);
  console.log("");

  gate(p.rowCount > 0, `${p.rowCount} rows rendered`,
    "without this every gate below is vacuous");
  gate(p.phaseTitle === "Other names", `the panel says "${p.phaseTitle}"`);
  gate(p.sections.length >= 2, `grouped under ${p.sections.length} characters: ${p.sections.join(", ")}`);
  gate(p.names.includes("Kes"), "the spoken nickname is offered",
    `offered: ${p.names.join(", ")}`);
  gate(p.names.includes("Ash Marshal"), "the declared epithet is offered");
  gate(p.names.includes("Vasquez"), "the absorbed surname is offered");
  gate(!p.names.includes("Then"), "and the sentence opener is not");
  gate(!p.names.includes("Okonkwo"), "and the family surname is not");

  gate(p.evidenceCount === p.rowCount,
    `all ${p.rowCount} rows carry a verbatim line from the manuscript`,
    `${p.evidenceCount} of ${p.rowCount} do`);
  gate(p.whys.every((w) => w.length > 0) && p.rowCount > 0,
    "…and the rule that produced them");
  gate(p.overflowing === 0, "no row overflows its pane",
    `${p.overflowing} rows overflow — a suggestion nobody can read is not one`);

  // ★ THE TICK POLICY IS THE SAFETY STORY, so it is measured on both sides.
  gate(p.ticked > 0, `${p.ticked} row(s) arrive ticked: ${p.tickedNames.join(", ")}`);
  gate(p.ticked < p.rowCount,
    `…and ${p.rowCount - p.ticked} arrive UNticked — an inference is a question`);
  gate(p.tickedNames.every((n) => n === "Ash Marshal"),
    "only the row the text states outright is pre-ticked",
    `ticked: ${p.tickedNames.join(", ")}`);
  gate(!p.registerDisabled, `the Add button is live: "${p.registerLabel.trim()}"`);

  // ── press Add, and prove the cast actually changed ────────────────────────
  // Tick "Kes" too, so the apply path is measured on an inferred row as well.
  await js(`(() => {
    const rows = [...document.querySelectorAll(".world-scan-row--alias")];
    const kes = rows.find((r) => r.querySelector(".world-scan-row-name")?.textContent === "Kes");
    kes?.querySelector("input")?.click();
  })()`);
  await wait(300);
  await js(`document.querySelector(".world-scan-register-btn").click()`);
  await wait(900);

  const after = await js(`(() => {
    const rows = [...document.querySelectorAll(".world-row")];
    const open = (name) => rows.find((r) => r.querySelector(".world-row-name")?.textContent === name);
    return { count: rows.length, hasPanel: !!document.querySelector(".world-scan-row--alias") };
  })()`);
  gate(!after.hasPanel, "the review panel closes after Add");
  gate(after.count === castBefore && castBefore > 0,
    `the cast still has ${after.count} entries — an alias joins an entry, it does not add one`,
    `was ${castBefore}, now ${after.count}`);

  // Open Elena and read the aliases field the scan wrote.
  const elena = await js(`(() => {
    const row = [...document.querySelectorAll(".world-row-name")]
      .find((n) => n.textContent === "Elena");
    row?.closest(".world-row")?.click();
    return !!row;
  })()`);
  await wait(600);
  const elenaAliases = elena ? await js(`(() => {
    const labels = [...document.querySelectorAll(".world-field-label")];
    const field = labels.find((l) => l.textContent === "Aliases");
    return field?.parentElement?.querySelector("input,textarea")?.value ?? "";
  })()`) : "";
  gate(/Ash Marshal/i.test(elenaAliases),
    `Elena's aliases now read "${elenaAliases}"`,
    "the tick did not reach worldData — the whole feature is the write");

  const kestrelAliases = await js(`(() => {
    const row = [...document.querySelectorAll(".world-row-name")].find((n) => n.textContent === "Kestrel");
    row?.closest(".world-row")?.click();
    return true;
  })()`) && (await wait(600), await js(`(() => {
    const labels = [...document.querySelectorAll(".world-field-label")];
    const field = labels.find((l) => l.textContent === "Aliases");
    return field?.parentElement?.querySelector("input,textarea")?.value ?? "";
  })()`));
  gate(/Kes/i.test(kestrelAliases),
    `Kestrel's aliases now read "${kestrelAliases}"`,
    "the inferred row did not apply");

  // Electron's own CSP notice fires on every unpackaged window and says nothing
  // about this feature; matching it made the gate red for a reason no change
  // here could ever fix, which is a gate that trains you to ignore it.
  const errors = consoleLines
    .filter((l) => !/Electron Security Warning|electronjs\.org\/docs/i.test(l))
    .filter((l) => /error|failed|\[WorldData\]/i.test(l));
  gate(errors.length === 0, "the page logged no errors",
    errors.slice(0, 3).join("\n         "));

  console.log(`\n${pass} passed, ${fail} failed`);
  app.exit(fail > 0 ? 1 : 0);
});
