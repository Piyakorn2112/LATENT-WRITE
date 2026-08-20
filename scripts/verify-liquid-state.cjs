/**
 * verify-liquid-state.cjs — the indicator, in a real renderer.
 *
 * scripts/test-liquid-state.ts proves the CHOREOGRAPHY: continuity, containment, that
 * the neck is real. It runs in node against pure functions and it cannot see any of
 * the ways a React component that paints a canvas fails in a browser — a backing store
 * at the wrong density, a tint that silently fell back because a custom property did
 * not resolve, a rAF loop that never started, a pause path that pauses forever, a
 * state change that cuts instead of transitioning.
 *
 * So this bundles the real component with esbuild, mounts it in Electron, and reads
 * the pixels it actually painted.
 *
 * ★ THE TINT GATE IS A NEGATIVE CONTROL, not a formality. The page sets
 *   --control-value-fill to a colour the component would never choose on its own
 *   (a magenta), and the gate requires the painted pixels to BE that colour. If the
 *   custom property stopped resolving — a renamed token, a portalled surface that
 *   inherits nothing, a computed style read before the element is in the document —
 *   the component falls back to its hard-coded blue and everything still looks
 *   plausible. Only a colour nothing else in the app uses can tell those apart.
 *
 *   ./node_modules/.bin/electron scripts/verify-liquid-state.cjs [outDir]
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv.slice(2).find((a) => !a.startsWith('-')) || ROOT;
/* ★ THE SCRATCH BUILD LIVES INSIDE THE REPO, under node_modules/.cache. In the system
 *   temp directory node resolution finds no react at all, and the CLI has no flag for
 *   an extra module path (--node-paths is the JS API's `nodePaths`, not a build flag).
 *   Building where the app's own modules are reachable also means the component is
 *   bundled against the SAME react the app ships, which is the point. */
const WORK = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache', 'lw-liquid-'));

/* A colour nothing in the app uses, so a fallback cannot pass for a resolved token. */
const PROBE_RGB = [214, 41, 122];
const APP_TINT = 'rgba(59, 130, 246, 0.88)';

fs.writeFileSync(path.join(WORK, 'entry.tsx'), `
import { createRoot } from "react-dom/client";
import { useState, useEffect } from "react";
import { LiquidState, type LiquidStateName } from ${JSON.stringify(path.join(ROOT, 'src/components/liquid-state/LiquidState'))};

function Harness() {
  const [s, setS] = useState<LiquidStateName>("thinking");
  useEffect(() => { (window as any).__set = setS; }, []);
  return (
    <div style={{ display: "flex", gap: 24, alignItems: "center", padding: 16 }}>
      <span id="probe" style={{ ["--control-value-fill" as any]: "rgb(${PROBE_RGB.join(',')})" }}>
        <LiquidState state={s} size={18} />
      </span>
      <span id="app18"><LiquidState state={s} size={18} /></span>
      <span id="app40"><LiquidState state={s} size={40} /></span>
      <span id="app96"><LiquidState state={s} size={96} /></span>
      {/* Two idle marks, so the ORB layer's colour can be read off the screen: one on
          the app's token and one on a colour nothing in the app uses. */}
      <span id="orbapp"><LiquidState state="idle" size={64} /></span>
      <span id="orbprobe" style={{ ["--control-value-fill" as any]: "rgb(${PROBE_RGB.join(',')})" }}>
        <LiquidState state="idle" size={64} />
      </span>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);

/** Sample a live canvas into a strip, so the eyeball sheet is the REAL painted
 *  buffer rather than a re-render of the same maths in node. */
(window as any).__strip = (sel: string, ms: number, n: number) => new Promise((res) => {
  const src = document.querySelector(sel + " canvas.liquid-state") as HTMLCanvasElement;
  const w = src.width;
  const strip = document.createElement("canvas");
  strip.width = (w + 4) * n; strip.height = w + 8;
  const ctx = strip.getContext("2d")!;
  ctx.fillStyle = "#f4f4f3"; ctx.fillRect(0, 0, strip.width, strip.height);
  let i = 0;
  const t0 = performance.now();
  const step = () => {
    const due = (i * ms) / n;
    if (performance.now() - t0 >= due) {
      ctx.drawImage(src, i * (w + 4) + 2, 4);
      i++;
    }
    if (i < n) requestAnimationFrame(step); else res(strip.toDataURL("image/png"));
  };
  requestAnimationFrame(step);
});

/** Ink and mean colour of a canvas — everything the gates need, read off the buffer
 *  the component painted rather than off a screenshot of it. */
(window as any).__read = (sel: string) => {
  const c = document.querySelector(sel + " canvas.liquid-state") as HTMLCanvasElement;
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  let ink = 0, r = 0, g = 0, b = 0, n = 0, maxA = 0, mx = 0, my = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a) {
      const px = (i / 4) % c.width, py = Math.floor((i / 4) / c.width);
      ink += a; mx += a * px; my += a * py;
      if (a > maxA) maxA = a;
      if (a > 200) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    }
  }
  return { w: c.width, h: c.height, cssW: c.clientWidth, ink: ink / 255, maxA,
           cx: ink ? mx / ink : 0, cy: ink ? my / ink : 0,
           rgb: n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : null, solid: n };
};
`);

fs.writeFileSync(path.join(WORK, 'page.html'), `<!doctype html>
<meta charset="utf-8">
<style>
  :root { --control-value-fill: ${APP_TINT}; }
  body { margin: 0; background: #f4f4f3; font: 12px system-ui; }
  /* The component's own layout, which lives in the app's styles.css and has to be
     restated here — the two layers must be stacked or the orb sits beside the canvas
     and every measurement is of the wrong thing. */
  .liquid-state-host { position: relative; display: inline-block; flex-shrink: 0; }
  .liquid-state, .liquid-state-orb { position: absolute; inset: 0; display: block; transition: none; }
  .liquid-state-orb { transform-origin: 50% 50%; }
</style>
<style>/*ORBCSS*/</style>
<div id="root"></div>
<!-- ★ IIFE AND A CLASSIC SCRIPT TAG, NOT A MODULE. Chromium refuses to load an ES
     module over file:// (CORS applies to module scripts and file:// has no origin),
     and it fails SILENTLY as far as loadFile is concerned: the page resolves, the
     bundle never runs, and every executeJavaScript after it waits forever. -->
<script src="./bundle.js"></script>
`);

execFileSync(path.join(ROOT, 'node_modules/esbuild/bin/esbuild'), [
  path.join(WORK, 'entry.tsx'),
  '--bundle', '--format=iife', '--jsx=automatic', '--loader:.tsx=tsx',
  `--outfile=${path.join(WORK, 'bundle.js')}`,
], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });

/* ★ THE ORB ENGINE SHIPS ITS OWN STYLESHEET, which esbuild emits as a separate file.
 *   Leaving it out is not a cosmetic loss — the orb's canvas has no layout of its own
 *   without those rules, so it sits in the wrong place and every measurement of it is
 *   of the wrong pixels. */
const orbCss = fs.existsSync(path.join(WORK, 'bundle.css'))
  ? fs.readFileSync(path.join(WORK, 'bundle.css'), 'utf8')
  : '';
fs.writeFileSync(path.join(WORK, 'page.html'),
  fs.readFileSync(path.join(WORK, 'page.html'), 'utf8').replace('/*ORBCSS*/', orbCss));

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}${detail ? `  (${detail})` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Anything thrown past here would otherwise leave an Electron app running with no
 * output at all, which is indistinguishable from a slow test. */
process.on('unhandledRejection', (e) => { console.log('  UNHANDLED', e && e.stack || e); app.exit(1); });
process.on('uncaughtException', (e) => { console.log('  UNCAUGHT', e && e.stack || e); app.exit(1); });

/* ★ NO disableHardwareAcceleration() HERE. It was added to make the canvas timings
 *   deterministic, and it also switches WebGL off — which means the orb layer renders
 *   NOTHING, silently, and every gate that reads its pixels finds an empty rectangle.
 *   A harness that disables the thing under test is not measuring it. */
app.whenReady().then(async () => {
  console.log('electron ready');
  const win = new BrowserWindow({ width: 640, height: 200, show: false, webPreferences: { offscreen: false } });
  win.webContents.on('console-message', (_e, _l, msg) => console.log(`  [page] ${msg}`));
  win.webContents.on('render-process-gone', (_e, d) => { console.log('  [page] gone', d); app.exit(1); });
  /* A harness that can hang is a harness that reports nothing. */
  const bail = setTimeout(() => { console.log('  TIMED OUT'); app.exit(1); }, 60_000);
  await win.loadFile(path.join(WORK, 'page.html'));
  const js = (code) => win.webContents.executeJavaScript(code, true);
  await sleep(500);
  const mounted = await js('!!(window.__read && document.querySelector("#app18 canvas"))').catch(() => false);
  if (!mounted) { console.log('  FAIL the harness page never mounted'); clearTimeout(bail); app.exit(1); return; }

  console.log('\nit paints at all');
  /* Everything below drives working states, where the orb layer is unmounted and the
   * canvas owns the picture; the hand-over itself is gated in the headless suite,
   * which can read both layers' opacities. */
  await js('window.__set("thinking")');
  await sleep(1200);
  const a18 = await js('window.__read("#app18")');
  check('the 18px canvas has ink', a18.ink > 4, `${a18.ink.toFixed(1)} px² of coverage, peak alpha ${a18.maxA}`);
  check('the backing store is at device density',
    a18.w === Math.round(18 * (a18.w / 18)) && a18.w >= 18 && a18.w === a18.h,
    `${a18.w}×${a18.h} for ${a18.cssW} css px`);
  const a96 = await js('window.__read("#app96")');
  check('a larger instance scales its buffer', a96.w > a18.w * 4, `${a96.w} vs ${a18.w}`);

  console.log('\nthe tint comes from the token, not the fallback');
  const probe = await js('window.__read("#probe")');
  const near = (c, t) => c && c.every((v, i) => Math.abs(v - t[i]) <= 6);
  check('a scoped --control-value-fill is what gets painted', near(probe.rgb, PROBE_RGB),
    `painted rgb(${probe.rgb}) vs token rgb(${PROBE_RGB})`);
  check('and the unscoped instance paints the app blue', near(a18.rgb, [59, 130, 246]),
    `painted rgb(${a18.rgb})`);

  console.log('\nthe ORB layer is the app\'s blue orb, not its own palette');
  /* ★★ READ OFF THE SCREEN, NOT OFF THE CANVAS. The orb is WebGL, so getImageData
   *    cannot see it; capturePage can, and what it captures is what a person sees.
   *
   *    ★ AND THE MAGENTA IS THE WHOLE GATE. The orb falls back to its OWN palette
   *      whenever the tint property fails to resolve — a bright multi-tone blue that
   *      looks entirely plausible next to a blue app. That is exactly what shipped:
   *      the specimen page never defined --control-value-fill, getPropertyValue
   *      returned an empty string, and nothing anywhere reported a problem. A colour
   *      nothing else uses is the only way to tell "tinted" from "happens to be blue". */
  const orbColour = async (sel) => {
    const r = await js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }; })()`);
    const img = await win.webContents.capturePage(r);
    const bmp = img.toBitmap();
    const size = img.getSize();
    let rr = 0, gg = 0, bb = 0, n = 0;
    for (let i = 0; i < bmp.length; i += 4) {
      const b0 = bmp[i], g0 = bmp[i + 1], r0 = bmp[i + 2];
      /* Anything meaningfully away from the page's near-white ground is ink. */
      if (244 - r0 > 26 || 244 - g0 > 26 || 243 - b0 > 26) { rr += r0; gg += g0; bb += b0; n++; }
    }
    return { rgb: n ? [Math.round(rr / n), Math.round(gg / n), Math.round(bb / n)] : null, n, size };
  };
  const orbP = await orbColour('#orbprobe');
  const orbA = await orbColour('#orbapp');
  check('the orb layer paints something at all', orbP.n > 60 && orbA.n > 60,
    `${orbP.n} and ${orbA.n} ink pixels in ${orbP.size.width}×${orbP.size.height}`);
  /* The orb varies each petal's value around the tint, so the MEAN is the tint but no
   * single pixel is; a generous tolerance is correct here and the control is what
   * makes it strict. */
  const nearish = (c, t, tol) => c && c.every((v, i) => Math.abs(v - t[i]) <= tol);
  check('a scoped token colours the orb, not its own palette', nearish(orbP.rgb, PROBE_RGB, 60),
    `painted rgb(${orbP.rgb}) against token rgb(${PROBE_RGB})`);
  check('and the unscoped orb is the app blue', nearish(orbA.rgb, [59, 130, 246], 60),
    `painted rgb(${orbA.rgb})`);
  check('negative control — the two orbs are not the same colour',
    orbP.rgb && orbA.rgb && Math.abs(orbP.rgb[0] - orbA.rgb[0]) > 60,
    `probe R ${orbP.rgb?.[0]} against app R ${orbA.rgb?.[0]}`);

  console.log('\nit is actually animating, and a squash conserves area');
  /* ★ INK IS THE WRONG OBSERVABLE FOR "IS IT MOVING", and finding that out was worth
   *   the failed gate. Every squash in the thinking loop sets sx = 1/sy, so an ellipse
   *   that flattens gets exactly as much wider as it gets shorter and the painted area
   *   NEVER CHANGES — two samples 180ms apart read 5340.7 and 5340.7. That is not a
   *   dead animation, it is the taffy rule holding to a tenth of a percent. So motion
   *   is read off the CENTROID, which the jumps move, and the constant ink becomes a
   *   gate of its own: one measures that something happens, the other that the right
   *   thing does. */
  const samples = [];
  for (let i = 0; i < 8; i++) { samples.push(await js('window.__read("#app96")')); await sleep(60); }
  const dy = Math.max(...samples.map((s) => s.cy)) - Math.min(...samples.map((s) => s.cy));
  check('the picture moves', dy > 1, `centroid travels ${dy.toFixed(2)} device px over 480ms`);
  const inks = samples.map((s) => s.ink);
  const spread = (Math.max(...inks) - Math.min(...inks)) / Math.max(...inks);
  check('and every squash conserves area (sx = 1/sy, measured in pixels)', spread < 0.004,
    `ink varies by ${(spread * 100).toFixed(3)}% across the cycle`);

  console.log('\na state change transitions rather than cuts');
  await js('window.__set("thinking")');
  await sleep(900);
  const before = await js('window.__read("#app96")');
  await js('window.__set("writing")');
  await sleep(300);
  const during = await js('window.__read("#app96")');
  await sleep(900);
  const after = await js('window.__read("#app96")');
  /* ★ THE TEST IS "DIFFERENT FROM BOTH ENDS", NOT "BIGGER THAN BOTH". It used to
   *   assert more ink than either endpoint, which was true while writing was a round
   *   body and false the moment it became a pen — mid-merge the mass has shrunk to the
   *   nib and the pen has not grown yet, so the in-between frame is the SMALLEST of
   *   the three. What actually distinguishes a transition from a cut is that the
   *   middle is neither end, and a cut lands straight on `after`. */
  const apart = (a, b) => Math.abs(a - b) / Math.max(a, b);
  check('mid-transition is a shape neither end has',
    apart(during.ink, before.ink) > 0.2 && apart(during.ink, after.ink) > 0.2,
    `ink ${before.ink.toFixed(1)} → ${during.ink.toFixed(1)} → ${after.ink.toFixed(1)}`);
  check('and it settles on the target state', Math.abs(after.ink - before.ink) > 1,
    `settled ink ${after.ink.toFixed(1)}`);

  console.log('\nit stops when nobody is looking');
  await js('document.body.classList.add("electron-window-unfocused-orb-paused")');
  await sleep(120);
  const p1 = await js('window.__read("#app96")');
  await sleep(400);
  const p2 = await js('window.__read("#app96")');
  check('a paused window paints no new frames', Math.abs(p1.cy - p2.cy) < 0.01 && Math.abs(p1.ink - p2.ink) < 0.01,
    `centroid ${p1.cy.toFixed(3)} → ${p2.cy.toFixed(3)}`);
  await js('document.body.classList.remove("electron-window-unfocused-orb-paused")');
  await sleep(300);
  const p3 = await js('window.__read("#app96")');
  check('and it wakes again', Math.abs(p3.cy - p2.cy) > 0.3, `centroid ${p2.cy.toFixed(3)} → ${p3.cy.toFixed(3)}`);

  console.log('\nreduced motion keeps the meaning and stops the performance');
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await js('window.__set("thinking")');
  await sleep(400);
  const r1 = await js('window.__read("#app96")');
  await sleep(400);
  const r2 = await js('window.__read("#app96")');
  check('a reduced-motion viewer sees a still frame', Math.abs(r1.cy - r2.cy) < 0.01 && Math.abs(r1.ink - r2.ink) < 0.01,
    `centroid ${r1.cy.toFixed(3)} → ${r2.cy.toFixed(3)}`);
  await js('window.__set("writing")');
  await sleep(300);
  const r3 = await js('window.__read("#app96")');
  check('but the frame still changes with the STATE', Math.abs(r3.cx - r2.cx) > 0.5 || Math.abs(r3.ink - r2.ink) > 1,
    `thinking ink ${r2.ink.toFixed(1)} → writing ${r3.ink.toFixed(1)}`);
  await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [] });
  dbg.detach();

  /* The eyeball sheet: the real painted buffer, sampled live through a merge. */
  await js('window.__set("thinking")');
  await sleep(900);
  const strip = js('window.__strip("#app96", 1200, 24)');
  await sleep(260);
  await js('window.__set("writing")');
  const dataUrl = await strip;
  fs.writeFileSync(path.join(OUT, 'liquid-state-live.png'),
    Buffer.from(String(dataUrl).split(',')[1], 'base64'));
  console.log(`\nwrote ${path.join(OUT, 'liquid-state-live.png')} — live buffer, thinking → writing`);

  clearTimeout(bail);
  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(WORK, { recursive: true, force: true });
  app.exit(fail ? 1 : 0);
});
