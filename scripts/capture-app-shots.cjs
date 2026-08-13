/**
 * capture-app-shots.cjs — the REAL app, booted through its real main
 * process, photographed for the onboarding accuracy audit.
 *
 * Seeds a scratch userData + a real on-disk project (sample novel in the
 * shipping serialization at <project>/novel.txt), then requires
 * electron/main.cjs so every IPC surface is the production one. Captures:
 * the true first-run (the welcome screen over the app), the sample-story
 * sandbox after door 1, and the World/Index panels. Shots land in
 * bench-results/shots-app/.
 *
 *   ./node_modules/.bin/electron scripts/capture-app-shots.cjs
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'bench-results', 'shots-app');
const DATA = '/tmp/lw-shots-data';
const PROJECT = '/tmp/lw-shots-project';
const SAMPLE = '/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels/sample-novel.txt';

// ── seed BEFORE the app module loads ──
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(PROJECT, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
for (const d of ['.renderer', 'anchors', 'drafts', 'canon', 'scene_bank', 'review_logs', 'temp', 'tools']) {
  fs.mkdirSync(path.join(PROJECT, d), { recursive: true });
}
fs.writeFileSync(path.join(PROJECT, '.renderer', 'project.json'),
  JSON.stringify({ name: 'Sample Story', created: Date.now(), lastOpened: Date.now() }));
fs.copyFileSync(SAMPLE, path.join(PROJECT, 'novel.txt'));
fs.writeFileSync(path.join(DATA, 'last-project.json'),
  JSON.stringify({ path: PROJECT, updated: Date.now() }));
fs.mkdirSync(OUT, { recursive: true });
process.env.LW_USER_DATA = DATA;

const { app, BrowserWindow, nativeTheme } = require('electron');
if (process.env.THEME) nativeTheme.themeSource = process.env.THEME;

// The real main process, verbatim.
require(path.join(ROOT, 'electron', 'main.cjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function win() {
  for (let i = 0; i < 120; i++) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.webContents.isLoading()) return w;
    await sleep(250);
  }
  throw new Error('no window');
}

async function shot(w, name) {
  const img = await w.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  console.log(`shot: ${name}.png  (${img.getSize().width}x${img.getSize().height})`);
}

const js = (w, src) => w.webContents.executeJavaScript(src, true);

app.whenReady().then(async () => {
  const w = await win();
  w.setSize(1440, 900);
  await sleep(4000); // fonts, glass, first analysis pass
  await shot(w, '01-first-run'); // the welcome screen over the app

  // ── The redesigned first run: one welcome screen, two doors. ──
  // Door 1 enters the sample-story sandbox; there is no tour to walk and no
  // cast dialog to swat (the sample ships castReviewed, and the prompt for
  // real books now fires at World-panel open, its payoff moment).
  const openedSample = await js(w, `(() => {
    const door = [...document.querySelectorAll('button.onb-door')]
      .find((b) => /open the sample story/i.test(b.textContent));
    if (!door) return false;
    door.click();
    return true;
  })()`);
  if (!openedSample) console.log('sample door not found — welcome may have changed');
  await sleep(3500); // sample parse + first analysis pass over it
  await shot(w, '10-editor'); // sample open: marks, dock, badge

  // The World panel, via its toolbar button. For the sample it opens
  // directly and populated — the shipped WORLD-DATA block is the cast.
  const openedWorld = await js(w, `(() => {
    const btn = [...document.querySelectorAll('button, [role="button"]')]
      .find((b) => /world/i.test(b.getAttribute('title') || b.getAttribute('aria-label') || b.textContent || ''));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(1500);
  if (openedWorld) await shot(w, '11-world-panel');
  await js(w, `(() => { const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }); document.dispatchEvent(e); })()`);
  await sleep(600);

  // The Index panel likewise.
  const openedIndex = await js(w, `(() => {
    const btn = [...document.querySelectorAll('button, [role="button"]')]
      .find((b) => /index|chapters/i.test(b.getAttribute('title') || b.getAttribute('aria-label') || b.textContent || ''));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(1200);
  if (openedIndex) await shot(w, '12-index-panel');

  console.log(`done → ${OUT}`);
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
