/**
 * capture-app-shots.cjs — the REAL app, booted through its real main
 * process, photographed for the onboarding accuracy audit.
 *
 * Seeds a scratch userData + a real on-disk project (sample novel in the
 * shipping serialization at <project>/novel.txt), then requires
 * electron/main.cjs so every IPC surface is the production one. Captures:
 * the true first-run (onboarding over the app), each tour page, the
 * populated editor after the tour, and the panels/popovers the tour
 * depicts. Shots land in bench-results/shots-app/.
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

const { app, BrowserWindow } = require('electron');

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
  await shot(w, '01-first-run');

  // Walk the tour: click the primary button up to 8 times, shooting each page.
  for (let i = 2; i <= 9; i++) {
    const advanced = await js(w, `(() => {
      const byText = (sel, texts) => [...document.querySelectorAll(sel)]
        .find((b) => texts.some((t) => b.textContent.trim().startsWith(t)));
      const next = byText('button', ['Next', 'Continue', 'Get started', 'Start', 'Begin', 'Done', 'Finish'])
        || document.querySelector('.onb-next, .onb-cta');
      if (!next) return false;
      next.click();
      return true;
    })()`);
    await sleep(700);
    if (!advanced) { console.log(`tour walk stopped before shot ${i}`); break; }
    await shot(w, `0${i}-tour`);
    const stillOpen = await js(w, `!!document.querySelector('.onb-card, .onb-root, [class*="onb-"]')`);
    if (!stillOpen) { console.log('tour closed'); break; }
  }

  // Ensure the tour is closed, then the populated editor.
  await js(w, `(() => {
    const skip = [...document.querySelectorAll('button')]
      .find((b) => /skip|close|done|finish|start writing/i.test(b.textContent));
    if (skip) skip.click();
  })()`);
  await sleep(1200);
  // The cast-confirm dialog fires right after the tour (the pile-up the
  // audit found); answer it so the surfaces underneath can be shot.
  await js(w, `(() => {
    const yes = [...document.querySelectorAll('button')]
      .find((b) => /yes, that’s my cast|yes, that's my cast/i.test(b.textContent));
    if (yes) yes.click();
  })()`);
  await sleep(3000);
  await shot(w, '10-editor');

  // The World panel, via its toolbar button.
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
