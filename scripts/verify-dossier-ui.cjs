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
  gate(p.rowCount === 2, `exactly 2 rows: the role and ONE description (got ${p.rowCount})`,
    "the pick-a-quote pile is gone; without rows every gate below is vacuous");
  gate(!p.waiting, "the wait row is gone when the card is ready");
  gate(p.texts.some((t) => /central character|major character/.test(t)),
    "the role row derives from counted facts", p.texts.join(" | "));
  gate(p.texts.some((t) => /tall, gaunt|weathered face/.test(t)),
    "the description is composed from the manuscript's own phrases",
    p.texts.join(" | "));
  gate(p.texts.some((t) => /habit of counting/.test(t)),
    "…and reaches beyond looks into habits");
  gate(p.texts.every((t) => !t.includes("“")),
    "…as a description, not quoted prose", p.texts.join(" | "));
  gate(p.texts.every((t) => !t.includes("murmured Marlow")),
    "the dialogue-tag sentence contributed nothing");
  gate(!p.buttons.includes("Regenerate"),
    "no Regenerate in the deterministic tier (one right answer)",
    p.buttons.join(", "));
  gate(p.overflowing === 0, "no row overflows its container",
    `${p.overflowing} overflow`);

  // Role "Use" writes the Role field.
  const roleBefore = p.roleValue;
  await js(`[...document.querySelectorAll(".world-dossier-row .world-alias-btn")][0]?.click()`);
  await wait(250);
  p = await probe();
  gate(roleBefore === "" && /character/.test(p.roleValue),
    `role "Use" wrote the Role field: "${p.roleValue}"`,
    `before "${roleBefore}" after "${p.roleValue}"`);

  // Description "Use" fills the empty Description with ONE block.
  const descBefore = p.descriptionValue;
  await js(`[...document.querySelectorAll(".world-dossier-desc .world-alias-btn")][0]?.click()`);
  await wait(250);
  p = await probe();
  gate(descBefore === "" && p.descriptionValue.length > 20 && !p.descriptionValue.includes("\n"),
    `description "Use" filled the field with one block`,
    `desc: "${p.descriptionValue.slice(0, 80)}"`);
  const descOnce = p.descriptionValue;
  await js(`[...document.querySelectorAll(".world-dossier-desc .world-alias-btn")][0]?.click()`);
  await wait(250);
  p = await probe();
  gate(p.descriptionValue.startsWith(descOnce) && p.descriptionValue.includes("\n"),
    "a second Use appends under the writer's text instead of overwriting it");

  // ── Osric: the never-described character ────────────────────────────────
  await js(`[...document.querySelectorAll(".world-row")].find((r) => r.textContent.includes("Osric"))?.click()`);
  await wait(400);
  await js(`[...document.querySelectorAll(".world-alias-btn")].find((b) => b.textContent === "Read from manuscript")?.click()`);
  // The manuscript read is cached from Marlow's run, so this is near-instant.
  await wait(900);
  p = await probe();
  console.log(`\n  Osric: ${p.rowCount} rows · note "${p.noteText.slice(0, 80)}"`);
  // ★ CONTRACT UPDATED 2026-08-13. The never-DESCRIBED character used to get
  //   an empty description; the counted lines (voice, company) then joined
  //   the composition, and they are measured facts, not inventions — Osric
  //   really does speak those lines beside those people. What the gate must
  //   still hold is the original point: nothing extracted-descriptive and
  //   nothing model-written may appear for him. A description row for Osric
  //   is legal ONLY when built entirely from the counted templates.
  const osricDesc = p.hasDescRow ? (p.texts.find((t) => /speaks?|page with/.test(t)) ?? "") : "";
  const countedOnly = !p.hasDescRow || (osricDesc !== "" && osricDesc
    .split(/(?<=[.!?])\s+/)
    .every((s) => /^(?:He|She|They)\s+(?:speaks?|never)\b|^Most often on the page with/.test(s.trim())));
  gate(countedOnly, "Osric's description, if any, is counted lines only (no extraction, no model)",
    `rows ${p.rowCount} desc ${p.hasDescRow} text "${osricDesc.slice(0, 90)}"`);
  gate(p.hasDescRow ? true : /does not describe Osric/.test(p.noteText),
    "…and with no counted lines either, the honest empty state");
  gate(p.texts.some((t) => /minor|recurring|major|central/.test(t)),
    "the deterministic role still shows (counted facts always exist)");

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
  app.exit(fail === 0 ? 0 : 1);
});
