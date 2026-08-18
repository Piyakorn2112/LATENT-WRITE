/**
 * shot-onb-orb.cjs — the welcome screen's hero orb, photographed in the
 * booted app.
 *
 * The orb is a live canvas (OrbEngine at hero size), and the thing under
 * review is a CSS halo painted behind it. Neither survives a screenshot of
 * a copy of the markup, so this boots the real main process with a fresh
 * userData — which is what puts the welcome screen up in the first place —
 * and crops around the real element.
 *
 * It also prints the computed `filter`, because "the glow is gone" is a
 * claim about a computed value that a picture alone cannot settle, and
 * removing a filter also removes the stacking context it created, which is
 * a layering change worth seeing in the same shot.
 *
 *   ./node_modules/.bin/electron scripts/shot-onb-orb.cjs --tag=before
 *   THEME=light ./node_modules/.bin/electron scripts/shot-onb-orb.cjs --tag=before-light
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'bench-results', 'shots-onb-orb');
const DATA = '/tmp/lw-onborb-data';
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
  for (let i = 0; i < 160; i++) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.webContents.isLoading()) return w;
    await sleep(250);
  }
  throw new Error('no window');
}

app.whenReady().then(async () => {
  const w = await win();
  w.setSize(1440, 900);
  // The orb animates; give the engine time to reach its steady flow so two
  // shots are comparable rather than catching different frames of the same
  // petal rotation.
  await sleep(6000);

  const box = await js(w, `(() => {
    const orb = document.querySelector('.onb-orb');
    if (!orb) return { found: false };
    const r = orb.getBoundingClientRect();
    const cs = getComputedStyle(orb);
    const canvas = orb.querySelector('canvas');
    return {
      found: true,
      orb: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      filter: cs.filter,
      // A filter creates a stacking context; losing it is a layering change.
      createsStackingContext: cs.filter !== 'none' || cs.isolation === 'isolate' || cs.willChange.includes('filter'),
      zIndex: cs.zIndex, position: cs.position, isolation: cs.isolation,
      canvas: canvas ? { w: canvas.width, h: canvas.height, cssW: Math.round(canvas.getBoundingClientRect().width) } : null,
    };
  })()`);
  console.log(JSON.stringify(box, null, 2));
  if (!box.found) { app.exit(1); return; }

  // Crop wide: the halo extends well past the element box, so a tight crop
  // would cut off the very thing being judged.
  const pad = 120;
  const img = await w.webContents.capturePage({
    x: Math.max(0, box.orb.x - pad), y: Math.max(0, box.orb.y - pad),
    width: box.orb.w + pad * 2, height: box.orb.h + pad * 2,
  });
  const file = path.join(OUT, `${TAG}.png`);
  fs.writeFileSync(file, img.toPNG());
  const s = img.getSize();
  console.log(`shot: ${file} (${s.width}x${s.height})`);
  fs.writeFileSync(path.join(OUT, `${TAG}.json`), JSON.stringify(box, null, 2));
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
