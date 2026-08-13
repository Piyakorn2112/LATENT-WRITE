/**
 * verify-onboarding.cjs — does the welcome screen (and the first session it
 * starts) describe THIS app?
 *
 * ★★ THE ONBOARDING IS DOCUMENTATION THAT SHIPS INSIDE THE PRODUCT, and it
 *    rots exactly like a README. The audit of the old 7-card tour found it
 *    promising `⌘⇧A` (a shortcut that existed nowhere), naming an
 *    "Intelligence panel" no surface is called, and illustrating an editor
 *    with macOS traffic dots the app does not have. The redesign retired the
 *    carousel for one welcome screen plus learning inside the real app — so
 *    the gates now hold THAT contract:
 *
 *    the screen's claims are source facts; the sample story really carries
 *    its planted teaching moments; the sandbox really cannot write; the cast
 *    dialog really cannot stack on the welcome; and the taught gestures
 *    really exist where they are taught.
 *
 * ★ EVERY NEGATIVE GATE IS PAIRED WITH A POSITIVE. "No carousel" alone would
 *   pass on an empty file; "two doors present" is what proves the screen is
 *   the redesign and not an accident.
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
 * ★★ STRIP THE COMMENTS BEFORE SCANNING THE SOURCE. The first version of
 *    this file failed its own "the phantom ⌘⇧A is gone" gate — because the
 *    comment explaining the removal contains the string. A gate that reads
 *    the note about the bug instead of the code is the wrong-element failure.
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const ONB = stripComments(read("src/components/Onboarding.tsx"));
const APP = stripComments(read("src/App.tsx"));
const PANEL = read("src/components/AnalysisPanel.tsx");
const SAMPLE = read("src/assets/sample-story.txt");
const LOG = stripComments(read("src/lib/onboarding-log.ts"));
const CHECK = stripComments(read("src/components/OnboardingChecklist.tsx"));
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
  gate(kbds.length > 0, `the welcome prints ${kbds.length} keyboard hint(s)`);
  const accelFor = (k) => k
    .replace(/⌘/g, "CmdOrCtrl+").replace(/⇧/g, "Shift+").replace(/⌥/g, "Alt+");
  for (const k of new Set(kbds)) {
    const letter = k.replace(/[⌘⇧⌥]/g, "");
    const inMenu = MENU.includes(accelFor(k)) || new RegExp(`accelerator:\\s*["'\`][^"'\`]*${letter}["'\`]`, "i").test(MENU);
    gate(inMenu, `${k} is a real accelerator`, `not found in the native menu`);
  }
  gate(!/⌘⇧A|⌘⇧a/.test(ONB), `the phantom ⌘⇧A shortcut is gone`);
  gate(!/Intelligence panel/i.test(ONB), `no "Intelligence panel" — no surface has that name`);

  // ── 2. Any download size quoted must match the settings row ─────────────
  const onbSizes = [...ONB.matchAll(/(\d+\.\d+) GB/g)].map((m) => m[1]);
  const panelSizes = [...PANEL.matchAll(/(\d+\.\d+) GB/g)].map((m) => m[1]);
  for (const s of new Set(onbSizes)) {
    gate(panelSizes.includes(s), `"${s} GB" matches the settings row`,
      `AnalysisPanel.tsx quotes: ${[...new Set(panelSizes)].join(", ")}`);
  }

  // ── 3. The carousel is retired AND the doors are real ───────────────────
  gate(!/onb-dot|onb-track|onb-page/.test(ONB), `no carousel remnants in the welcome`);
  gate(/Open the sample story/.test(ONB), `door 1: "Open the sample story"`);
  gate(/Start your own book/.test(ONB), `door 2: "Start your own book"`);
  gate(/Back to your book/.test(ONB), `door 2 flips for a writer with words`);

  // ── 4. The sample story carries its teaching plants ─────────────────────
  const chapterCount = (SAMPLE.match(/^===CHAPTER \d+:/gm) || []).length;
  gate(chapterCount === 4, `sample has 4 chapters (${chapterCount})`);
  gate(/pale green/.test(SAMPLE) && /dark brown, the colour of kelp/.test(SAMPLE),
    `the eye-colour contradiction is planted (green Ch2 vs brown Ch3)`);
  gate(/Lantern Bridge/.test(SAMPLE) && /Lamplight Bridge/.test(SAMPLE),
    `the renamed bridge is planted (Lantern vs Lamplight)`);
  gate(/percision that would of/.test(SAMPLE),
    `the proofread sentence is planted (percision / would of)`);
  gate(/three days on his feet/.test(SAMPLE) && /two nights ago/.test(SAMPLE),
    `the timeline slip is planted`);
  gate(/"castReviewed": true/.test(SAMPLE),
    `sample ships castReviewed — the scan dialog never interrogates a book the writer didn't write`);
  gate(/safe to break/i.test(SAMPLE) && /reset/i.test(SAMPLE),
    `the sandbox safety is ADVERTISED in the sample's own description`);
  const castNames = (SAMPLE.match(/"name": "/g) || []).length;
  gate(castNames >= 10, `a rich cast+places ships confirmed (${castNames} named entries)`);

  // ── 5. Modal sequencing is owned ────────────────────────────────────────
  gate(!/\[onboardingOpen\]\);/.test(APP),
    `no effect keyed on [onboardingOpen] — the welcome-close modal pile-up cannot come back`);
  gate(/openWorldPanel/.test(APP) && /castPromptNeeded\(novel\)/.test(APP),
    `the cast question fires at World-panel open (its payoff moment)`);
  gate(/worldAfterCastRef/.test(APP),
    `answering the cast question opens the panel it feeds`);

  // ── 6. The sandbox really cannot write ──────────────────────────────────
  const latched = [
    "src/lib/storage.ts",
    "src/lib/story-graph.ts",
    "src/lib/annotation-store.ts",
    "src/lib/adaptive-store.ts",
    "src/lib/knowledge-store.ts",
    "src/lib/review-store.ts",
    "src/lib/renderer-review.ts",
  ];
  for (const f of latched) {
    gate(/isSampleModeActive/.test(read(f)), `${path.basename(f)} carries the sample-mode latch`);
  }
  gate(/reset: \(\) => void|reset\(\)/.test(read("src/lib/use-undo-redo.ts")),
    `undo history resets at the sandbox boundary`);
  gate(/isSampleModeActive\(\)/.test(APP),
    `App consults the latch (daily words, first-edit attribution)`);

  // ── 7. Gestures are taught only where they exist ────────────────────────
  // (The rail "ask" button was removed by the owner — the checklist's
  //  one-time hint is the teaching surface; no gate mourns the button.)
  gate(/maxReady=\{maxAskAvailable\}/.test(APP),
    `the gesture hint is gated on maxAskAvailable, not isElectron`);
  gate(!/onAskAtCaret/.test(PANEL) && !/onAskAtCaret/.test(APP),
    `the retired rail ask button stays retired`);
  gate(/max-hint|ask-used/.test(CHECK),
    `the hint tracks whether the gesture was actually tried`);

  // ── 8. The checklist is four items, one pre-credited ────────────────────
  const items = (LOG.match(/label: "/g) || []).length;
  gate(items === 4, `checklist has exactly 4 items (${items}) — five is the completion cliff`);
  gate(/door-sample", "door-own", "door-import/.test(LOG),
    `item 1 is credited by choosing any door (endowed progress on real work)`);
  gate(/never transmitted|local only/i.test(read("src/lib/onboarding-log.ts")),
    `the funnel record declares itself local-only`);

  // ── 9. Look at it ───────────────────────────────────────────────────────
  const win = new BrowserWindow({ width: 1180, height: 900, show: false });
  const errors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 3) errors.push(message);
  });
  const BUILD = process.env.BROWSER === "1" ? "?browser=1" : "";
  await win.loadURL(`${BASE}/onboarding-verify.html${BUILD}`);
  await wait(2600);
  const js = (src) => win.webContents.executeJavaScript(src, true);

  const present = await js(`!!document.querySelector(".onb-card")`);
  gate(present, `the welcome mounts${BUILD ? " (browser build)" : " (desktop build)"}`);
  if (!present) { console.log(`\n${pass} passed, ${fail} failed\n`); win.destroy(); app.exit(1); return; }

  const shape = await js(`(() => {
    const doors = [...document.querySelectorAll(".onb-door")];
    const welcome = document.querySelector(".onb-welcome");
    return {
      doors: doors.length,
      primaryFirst: doors[0]?.classList.contains("onb-door--primary") ?? false,
      doorLabels: doors.map((d) => (d.querySelector(".onb-door-label")?.textContent ?? "").trim()),
      title: (document.querySelector(".onb-title")?.textContent ?? "").trim(),
      words: (document.querySelector(".onb-subtitle")?.textContent ?? "").trim().split(/\\s+/).length,
      dots: document.querySelectorAll(".onb-dot").length,
      overflowing: welcome ? welcome.scrollHeight > welcome.clientHeight + 2 : true,
      orb: !!document.querySelector(".onb-orb canvas, .onb-orb"),
    };
  })()`);

  gate(shape.dots === 0, `one screen, no page dots (${shape.dots})`);
  gate(shape.doors === 2, `exactly two doors (${shape.doors})`);
  gate(shape.primaryFirst, `the sample door carries the recommendation accent, first`);
  gate(shape.doorLabels.every((l) => l.length > 0), `both doors are labelled (${shape.doorLabels.join(" · ")})`);
  gate(shape.title === "Write. It reads along.", `the title is the mental model (${JSON.stringify(shape.title)})`);
  gate(shape.words >= 18 && shape.words <= 62,
    `the philosophy paragraph is readable, not a wall (${shape.words} words, 18..62)`);
  gate(!shape.overflowing, `the screen fits without scrolling`);
  gate(shape.orb, `the orb hero is present`);
  gate(errors.length === 0, `no console errors`, errors.slice(0, 2).join(" | "));

  fs.mkdirSync(OUT, { recursive: true });
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `welcome${BUILD ? "-browser" : ""}.png`), img.toPNG());
  console.log(`\n  shot: ${OUT}/welcome${BUILD ? "-browser" : ""}.png`);
  console.log(`\n${pass} passed, ${fail} failed\n`);
  win.destroy();
  app.exit(fail === 0 ? 0 : 1);
}).catch((err) => { console.error(err); app.exit(1); });
