/**
 * shot-mode-lock.cjs — the PRO badge on the local-enhancement mode selector,
 * photographed in the booted app.
 *
 * The badge only exists on the max stop for a FREE licence, inside the
 * settings panel, on the desktop build — so an isolated harness would be
 * measuring a copy of the markup rather than the control. This boots the real
 * main process, opens the real panel, and crops the real track.
 *
 * It also prints the badge's measured box and its gaps to the track edge and
 * to the stop's own label, because "smaller with more margin" is a claim about
 * numbers that a screenshot alone cannot settle.
 *
 *   ./node_modules/.bin/electron scripts/shot-mode-lock.cjs [--tag before]
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'bench-results', 'shots-mode-lock');
const DATA = '/tmp/lw-modelock-data';
const TAG = (process.argv.find((a) => a.startsWith('--tag=')) || '--tag=shot').split('=')[1];

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
process.env.LW_USER_DATA = DATA;

const { app, BrowserWindow, nativeTheme } = require('electron');
if (process.env.THEME) nativeTheme.themeSource = process.env.THEME;
require(path.join(ROOT, 'electron', 'main.cjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (w, src) => w.webContents.executeJavaScript(src, true);

async function win() {
  for (let i = 0; i < 120; i++) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.webContents.isLoading()) return w;
    await sleep(250);
  }
  throw new Error('no window');
}

app.whenReady().then(async () => {
  const w = await win();
  w.setSize(1440, 900);
  await sleep(3500);

  // Past the welcome screen: any door will do, the panel is what matters.
  await js(w, `(() => {
    const skip = [...document.querySelectorAll('button')]
      .find((b) => /start your own book|back to your book/i.test(b.textContent || ''));
    if (skip) skip.click();
    return !!skip;
  })()`);
  await sleep(1500);

  const opened = await js(w, `(() => {
    const btn = [...document.querySelectorAll('button, [role="button"]')]
      .find((b) => /setting/i.test(b.getAttribute('title') || b.getAttribute('aria-label') || ''));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (!opened) { console.log('settings button not found'); app.exit(1); return; }
  await sleep(1400);

  const box = await js(w, `(() => {
    const track = document.querySelector('.glass-mode');
    const lock  = document.querySelector('.glass-mode-lock');
    if (!track || !lock) return { found: false, hasTrack: !!track, hasLock: !!lock };
    const t = track.getBoundingClientRect();
    const l = lock.getBoundingClientRect();
    const stop = lock.closest('.glass-mode-option').getBoundingClientRect();
    const label = lock.closest('.glass-mode-option').querySelector('.glass-mode-label').getBoundingClientRect();
    const cs = getComputedStyle(lock);
    return {
      found: true,
      track: { x: Math.round(t.x), y: Math.round(t.y), w: Math.round(t.width), h: Math.round(t.height) },
      badge: { w: +l.width.toFixed(1), h: +l.height.toFixed(1) },
      fontSize: cs.fontSize, padding: cs.padding,
      gapToTrackTop: +(l.top - t.top).toFixed(1),
      gapToTrackRight: +(t.right - l.right).toFixed(1),
      gapToStopTop: +(l.top - stop.top).toFixed(1),
      gapToLabelRight: +(l.left - label.right).toFixed(1),
      overlapsLabelVertically: l.bottom > label.top && l.top < label.bottom,
    };
  })()`);
  console.log(JSON.stringify(box, null, 2));
  if (!box.found) { app.exit(1); return; }

  // Crop generously around the track so the badge is judged in context.
  const pad = 26;
  const img = await w.webContents.capturePage({
    x: Math.max(0, box.track.x - pad), y: Math.max(0, box.track.y - pad),
    width: box.track.w + pad * 2, height: box.track.h + pad * 2,
  });
  const file = path.join(OUT, `${TAG}.png`);
  fs.writeFileSync(file, img.toPNG());
  const size = img.getSize();
  console.log(`shot: ${file} (${size.width}x${size.height})`);

  fs.writeFileSync(path.join(OUT, `${TAG}.json`), JSON.stringify(box, null, 2));
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
