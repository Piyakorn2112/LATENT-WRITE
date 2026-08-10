/**
 * verify-onboarding.cjs — does the welcome tour describe THIS app?
 *
 * ★★ THE ONBOARDING IS DOCUMENTATION THAT SHIPS INSIDE THE PRODUCT, and it
 *    rots exactly like a README. Auditing the old one found it promising
 *    `⌘⇧A` for the analysis panel, a shortcut that exists NOWHERE in the app,
 *    and naming an "Intelligence panel" that no surface is called. A writer
 *    who presses a key that does nothing on page four does not conclude the
 *    tour is out of date; they conclude the app is broken.
 *
 * ★ SO THE GATES ARE FACTS ABOUT THE SOURCE, NOT ABOUT THE WORDING. Every
 *   keystroke the tour prints must be a real accelerator in electron/menu.cjs,
 *   and every download size must match the settings row the writer will
 *   actually see. Wording is taste and is left alone; a claim is checkable.
 *
 * It also captures every page so the layout can be looked at rather than
 * assumed.
 *
 *   npm run dev
 *   VITE_URL=http://localhost:5178 ./node_modules/.bin/electron scripts/verify-onboarding.cjs
 */
const { app, BrowserWindow, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

if (process.env.THEME) nativeTheme.themeSource = process.env.THEME;
const BASE = process.env.VITE_URL || "http://localhost:5178";
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, ".glass-shots");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.commandLine.appendSwitch("force-device-scale-factor", "1");

let pass = 0, fail = 0;
const gate = (ok, label, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ""}`); }
};

/**
 * ★★ STRIP THE COMMENTS BEFORE SCANNING THE SOURCE. The first run of this
 *    file failed its own "the phantom ⌘⇧A is gone" gate — because the comment
 *    explaining that ⌘⇧A was removed contains the string ⌘⇧A. A gate that
 *    reads the note about the bug instead of the code is the wrong-element
 *    failure, and it fails in the safe direction only by luck.
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const ONB = stripComments(fs.readFileSync(path.join(ROOT, "src/components/Onboarding.tsx"), "utf8"));
const PANEL = fs.readFileSync(path.join(ROOT, "src/components/AnalysisPanel.tsx"), "utf8");
const MENU = (() => {
  for (const f of ["electron/menu.cjs", "electron/main.cjs"]) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  }
  return "";
})();

app.whenReady().then(async () => {
  console.log(`\n${"═".repeat(70)}\nONBOARDING — is it telling the truth?\n${"═".repeat(70)}\n`);

  // ── 1. Every keystroke printed must exist as an accelerator ─────────────
  const kbds = [...ONB.matchAll(/<Kbd[^>]*>([^<]+)<\/Kbd>/g)].map((m) => m[1].trim());
  gate(kbds.length > 0, `the tour prints ${kbds.length} keyboard hints`);
  const accelFor = (k) => k
    .replace(/⌘/g, "CmdOrCtrl+").replace(/⇧/g, "Shift+").replace(/⌥/g, "Alt+");
  for (const k of new Set(kbds)) {
    const letter = k.replace(/[⌘⇧⌥]/g, "");
    const inMenu = MENU.includes(accelFor(k)) || new RegExp(`accelerator:\\s*["'\`][^"'\`]*${letter}["'\`]`, "i").test(MENU);
    gate(inMenu, `${k} is a real accelerator`, `not found in the native menu — the old tour promised ⌘⇧A, which never existed`);
  }
  // The shortcut that started this audit must never come back.
  gate(!/⌘⇧A|⌘⇧a/.test(ONB), `the phantom ⌘⇧A shortcut is gone`);
  gate(!/Intelligence panel/i.test(ONB), `no "Intelligence panel" — no surface has that name`);

  // ── 2. Download sizes must match the settings row ───────────────────────
  const onbSizes = [...ONB.matchAll(/(\d+\.\d+) GB/g)].map((m) => m[1]);
  const panelSizes = [...PANEL.matchAll(/(\d+\.\d+) GB/g)].map((m) => m[1]);
  for (const s of new Set(onbSizes)) {
    gate(
      panelSizes.includes(s),
      `"${s} GB" matches the settings row the writer will see`,
      `AnalysisPanel.tsx quotes: ${[...new Set(panelSizes)].join(", ")}`,
    );
  }

  // ── 3. Look at it ───────────────────────────────────────────────────────
  const win = new BrowserWindow({ width: 1180, height: 900, show: false });
  const errors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    // level 3 = error. Level 2 is Electron's own CSP warning about the dev
    // server, which is not the page's doing and not a defect in the tour.
    if (level >= 3) errors.push(message);
  });
  const BUILD = process.env.BROWSER === "1" ? "?browser=1" : "";
  await win.loadURL(`${BASE}/onboarding-verify.html${BUILD}`);
  await wait(2600);
  const js = (src) => win.webContents.executeJavaScript(src, true);

  const present = await js(`!!document.querySelector(".onb-card")`);
  gate(present, `the tour mounts${BUILD ? " (browser build)" : " (desktop build)"}`);
  if (!present) { console.log(`\n${pass} passed, ${fail} failed\n`); win.destroy(); app.exit(1); return; }

  const dots = await js(`document.querySelectorAll(".onb-dot").length`);
  gate(dots === 6, `six pages (${dots})`);

  fs.mkdirSync(OUT, { recursive: true });
  const seen = [];
  for (let i = 0; i < dots; i++) {
    await js(`document.querySelectorAll(".onb-dot")[${i}].click()`);
    await wait(700);
    const page = await js(`(() => {
      const p = document.querySelector(".onb-page--active");
      if (!p) return null;
      return {
        title: (p.querySelector(".onb-title")?.textContent ?? "").trim(),
        words: (p.querySelector(".onb-subtitle")?.textContent ?? "").trim().split(/\\s+/).length,
        heroPixels: (p.querySelector(".onb-hero")?.getBoundingClientRect().height ?? 0),
        overflowing: p.scrollHeight > p.clientHeight + 2,
      };
    })()`);
    seen.push(page);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `onboarding${BUILD ? "-browser" : ""}-${i + 1}.png`), img.toPNG());
  }

  console.log("");
  for (const [i, p] of seen.entries()) {
    console.log(`  ${i + 1}. ${String(p.words).padStart(3)} words · hero ${String(Math.round(p.heroPixels)).padStart(3)}px · ${p.title}`);
  }
  console.log("");

  gate(seen.every((p) => p && p.title), `every page has a title`);
  gate(seen.every((p) => p && p.heroPixels > 40), `every page has a visible hero`);
  // ★ "More informative but not too much text" is the brief, so the length is
  //   a gate. Long enough to say something, short enough to be read.
  const longest = Math.max(...seen.map((p) => p.words));
  gate(longest <= 62, `no page runs long (worst is ${longest} words, cap 62)`);
  const shortest = Math.min(...seen.map((p) => p.words));
  gate(shortest >= 18, `no page is a stub (thinnest is ${shortest} words, floor 18)`);
  const overflow = seen.map((p, i) => (p.overflowing ? i + 1 : 0)).filter(Boolean);
  gate(overflow.length === 0, `no page scrolls its own content`, `overflowing: page ${overflow.join(", ")} — the body copy is below the fold there`);
  gate(errors.length === 0, `no console errors`, errors.slice(0, 2).join(" | "));

  console.log(`\n  shots: ${OUT}/onboarding${BUILD ? "-browser" : ""}-1..${dots}.png`);
  console.log(`\n${pass} passed, ${fail} failed\n`);
  win.destroy();
  app.exit(fail === 0 ? 0 : 1);
}).catch((err) => { console.error(err); app.exit(1); });
