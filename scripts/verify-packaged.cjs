/**
 * verify-packaged.cjs — the PACKAGED app, really launched, really driven.
 *
 * Everything else in scripts/ tests source or the dev dist through the dev
 * electron binary. This drives the artifact electron-builder actually
 * produced (release/mac-arm64/Latent Write.app): launches the binary with a
 * scratch userData and a remote-debugging port, connects over CDP with
 * playwright-core, walks the first-run (welcome → sample door → editor →
 * World panel), asserts each surface, and screenshots them. No macOS screen
 * permissions needed — pixels come from the page itself.
 *
 *   /opt/homebrew/bin/node scripts/verify-packaged.cjs
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'release', 'mac-arm64', 'Latent Write.app', 'Contents', 'MacOS', 'Latent Write');
const OUT = path.join(ROOT, 'bench-results', 'shots-app');
const DATA = '/tmp/lw-pack-data';
const PORT = 9333;

let pass = 0, fail = 0;
const gate = (ok, label, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  gate(fs.existsSync(APP), 'packaged binary exists (run electron:build first)');
  if (!fs.existsSync(APP)) process.exit(1);

  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  const child = spawn(APP, [`--remote-debugging-port=${PORT}`], {
    env: { ...process.env, LW_USER_DATA: DATA },
    stdio: 'ignore',
    detached: false,
  });
  const kill = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
  process.on('exit', kill);

  // The debugger endpoint comes up with the first window.
  let browser = null;
  for (let i = 0; i < 40 && !browser; i++) {
    await wait(500);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch { /* not up yet */ }
  }
  gate(!!browser, 'CDP endpoint reachable (the packaged main process booted)');
  if (!browser) { kill(); process.exit(1); }

  const context = browser.contexts()[0];
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    page = context.pages().find((p) => !p.url().startsWith('devtools')) ?? null;
    if (!page) await wait(400);
  }
  gate(!!page, 'renderer page attached');
  if (!page) { kill(); process.exit(1); }

  // First run: the welcome screen over the app.
  await page.waitForSelector('.onb-card', { timeout: 20000 }).catch(() => {});
  await wait(2500); // fonts, glass, orb
  const welcome = await page.evaluate(() => ({
    doors: document.querySelectorAll('.onb-door').length,
    title: (document.querySelector('.onb-title')?.textContent ?? '').trim(),
  }));
  gate(welcome.doors === 2, `welcome shows two doors (${welcome.doors})`);
  gate(welcome.title === 'Write. It reads along.', `welcome title (${JSON.stringify(welcome.title)})`);
  await page.screenshot({ path: path.join(OUT, '20-pack-welcome.png') });

  // Door 1 → the sample sandbox.
  await page.click('.onb-door--primary');
  await wait(3500); // sample parse + first analysis pass
  const editor = await page.evaluate(() => ({
    chapterTitle: (document.querySelector('.toolbar-chapter-title, input[aria-label*="hapter"], .chapter-title-input') ?? { value: '' }).value
      || (document.querySelector('.document-chapter-title')?.textContent ?? '').trim(),
    hasDock: !!document.querySelector('.gs-dock'),
    hasBadge: !!document.querySelector('.gs-sample'),
    hasChecklist: !!document.querySelector('.gs-card'),
    prose: (document.querySelector('.document-editor')?.value ?? '').slice(0, 60),
  }));
  gate(/The Keeper/.test(editor.chapterTitle) || /light turned/i.test(editor.prose),
    `the sample opened (chapter: ${JSON.stringify(editor.chapterTitle)})`);
  gate(editor.hasDock && editor.hasBadge && editor.hasChecklist,
    'the getting-started dock + sample badge are up');
  await page.screenshot({ path: path.join(OUT, '21-pack-editor.png') });

  // World panel via the toolbar button — the sample ships castReviewed, so
  // the panel must open POPULATED with no dialog in between.
  await page.click('button[aria-label="World data"]').catch(async () => {
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')]
        .find((b) => /world/i.test(b.getAttribute('aria-label') || b.getAttribute('title') || ''));
      btn?.click();
    });
  });
  await wait(1500);
  const world = await page.evaluate(() => ({
    castDialog: !!document.querySelector('.wc-overlay'),
    rows: document.querySelectorAll('.world-row').length,
    names: [...document.querySelectorAll('.world-row-name')].map((n) => n.textContent?.trim()),
  }));
  gate(!world.castDialog, 'no cast dialog stacked on World open (sample is pre-reviewed)');
  gate(world.rows >= 7, `World panel populated (${world.rows} rows: ${world.names.slice(0, 3).join(', ')}…)`);
  await page.screenshot({ path: path.join(OUT, '22-pack-world.png') });

  console.log(`\n  shots: ${OUT}/2*-pack-*.png`);
  console.log(`\n${pass} passed, ${fail} failed\n`);
  kill();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
