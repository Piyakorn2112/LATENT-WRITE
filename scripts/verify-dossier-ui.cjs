/**
 * verify-dossier-ui.cjs — press the button, on the REAL WorldDataView.
 *
 * scripts/test-character-dossier.ts proves the ENGINE. It cannot prove that
 * the card exists under the Description field, that pressing it reads the
 * manuscript, that the rewrite orb appears while it does, that the rows
 * render with citations, that "Use" writes the Role field, that "Add" appends
 * to the Description, or that the never-described character gets the honest
 * empty state instead of an invented line. Only the running component makes
 * those shapes.
 *
 * ★★ EVERY ASSERTION IS PAIRED WITH A COUNT — `every()` over an empty list
 *    is true, and this repo has certified a feature that rendered nothing.
 *
 * Browser build: no electronAPI, so this is the DETERMINISTIC path (counted
 * facts + verbatim quotes), the one that must work everywhere. The max path's
 * behaviour is measured by probe-dossier-model.cjs against the real model.
 *
 *   VITE_URL=http://localhost:5178 ./node_modules/.bin/electron scripts/verify-dossier-ui.cjs
 */
const { app, BrowserWindow, nativeTheme } = require("electron");
if (process.env.THEME) nativeTheme.themeSource = process.env.THEME;
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
  await win.loadURL(`${BASE}/alias-verify.html?dossier=1`);
  await wait(2200);
  const js = (src) => win.webContents.executeJavaScript(src, true);
  const probe = () => js("window.__dossierProbe && window.__dossierProbe()");

  // ── Marlow: the described character ─────────────────────────────────────
  await js(`[...document.querySelectorAll(".world-row")].find((r) => r.textContent.includes("Marlow"))?.click()`);
  await wait(400);
  let p = await probe();
  gate(p.fieldPresent, `the card sits under the Description field ("From the manuscript")`);
  gate(p.buttons.includes("Read from manuscript"), "the offer button is there",
    `buttons: ${p.buttons.join(", ")}`);
  if (!p.buttons.includes("Read from manuscript")) { console.log("\nno button — nothing else can be measured."); app.exit(1); return; }

  await js(`[...document.querySelectorAll(".world-alias-btn")].find((b) => b.textContent === "Read from manuscript")?.click()`);
  // The harvest yields per chapter; catch it mid-flight for the orb gate.
  await wait(150);
  const mid = await probe();
  await wait(2500);
  p = await probe();

  console.log(`\n  mid-flight: waiting=${mid.waiting} label="${mid.waitLabel}"`);
  console.log(`  after: ${p.rowCount} rows — ${p.kinds.join(" · ")}`);
  p.texts.forEach((t, i) => console.log(`    [${i}] ${p.kinds[i] ?? ""}: ${t}`));
  console.log("");

  gate(mid.waiting && mid.orbMounted,
    "while reading, the rewrite tool's orb indicator is mounted",
    `waiting=${mid.waiting} orb=${mid.orbMounted}`);
  gate(p.rowCount >= 3, `${p.rowCount} rows rendered`,
    "without this every gate below is vacuous");
  gate(!p.waiting, "the wait row is gone when the card is ready");
  gate(p.texts.some((t) => /central character|major character/.test(t)),
    "the role row derives from counted facts", p.texts.join(" | "));
  gate(p.kinds.includes("looks"), "a LOOKS quote is offered", p.kinds.join(", "));
  gate(p.texts.some((t) => t.includes("tall, gaunt")),
    "…and it is the manuscript's own description");
  gate(p.texts.every((t) => !t.includes("murmured Marlow")),
    "the dialogue-tag sentence is not offered as description");
  gate(p.overflowing === 0, "no row overflows its container",
    `${p.overflowing} overflow`);

  // "Use" writes the Role field.
  const roleBefore = p.roleValue;
  await js(`[...document.querySelectorAll(".world-dossier-row .world-alias-btn")].find((b) => b.textContent === "Use")?.click()`);
  await wait(250);
  p = await probe();
  gate(roleBefore === "" && /character/.test(p.roleValue),
    `"Use" wrote the Role field: "${p.roleValue}"`,
    `before "${roleBefore}" after "${p.roleValue}"`);

  // "Add" appends a quote to the Description, quoted and cited.
  const descBefore = p.descriptionValue;
  await js(`[...document.querySelectorAll(".world-dossier-row .world-alias-btn")].find((b) => b.textContent === "Add")?.click()`);
  await wait(250);
  p = await probe();
  gate(descBefore === "" && p.descriptionValue.length > 0 && /\(ch \d\)/.test(p.descriptionValue),
    `"Add" appended a cited quote to the Description`,
    `desc: "${p.descriptionValue.slice(0, 80)}"`);

  // ── Osric: the never-described character ────────────────────────────────
  await js(`[...document.querySelectorAll(".world-row")].find((r) => r.textContent.includes("Osric"))?.click()`);
  await wait(400);
  await js(`[...document.querySelectorAll(".world-alias-btn")].find((b) => b.textContent === "Read from manuscript")?.click()`);
  // The manuscript read is cached from Marlow's run, so this is near-instant.
  await wait(900);
  p = await probe();
  console.log(`\n  Osric: ${p.rowCount} rows · note "${p.noteText.slice(0, 80)}"`);
  gate(p.kinds.every((k) => k === "(role)"), "Osric gets no description rows",
    p.kinds.join(", "));
  gate(/does not describe Osric/.test(p.noteText),
    "…and the honest empty state instead of an invention");
  gate(p.texts.some((t) => /minor|recurring|major|central/.test(t)),
    "the deterministic role still shows (counted facts always exist)");

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
  app.exit(fail === 0 ? 0 : 1);
});
