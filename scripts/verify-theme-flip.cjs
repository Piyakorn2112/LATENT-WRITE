/**
 * verify-theme-flip.cjs — the glass filter must follow a light↔dark flip.
 *
 * The chroma flatten fades neutral backdrop content toward the PAGE's tone
 * (--lqg-flatten-target), which is the one filter input that changes with the
 * colour scheme. That target is part of the filter id, so the id alone is a
 * sharp pass/fail signal: an element still bound to `…@0.94` while the page is
 * dark is a stale filter, no pixels or timing guesswork required.
 *
 *   npm run dev                       # in another shell
 *   node scripts/verify-theme-flip.cjs
 *
 * Covers three paths, because the first one hides the bug:
 *   · UNFOCUSED flip — you left the app to change the OS theme. The engine
 *     pauses on body.electron-window-unfocused and resumeAllGlassWork()
 *     reschedules everything on the way back, so surfaces rebuild for free.
 *   · FOCUSED flip, both directions — macOS auto light/dark at sunset, or any
 *     flip while the window keeps focus. No pause cycle, so the scheme
 *     listener is the ONLY thing that can refresh the filters. This is the
 *     case that regressed: the listener called applyTo(), which early-returns
 *     on an already-tracked element, so it refreshed nothing at all.
 */

const { app, BrowserWindow, nativeTheme } = require("electron");

const URL_ = process.env.THEME_FLIP_URL || "http://localhost:5173/prose-glass.html";

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.disableHardwareAcceleration();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const READ = `(() => {
  const out = [];
  document.querySelectorAll('.spec').forEach((el) => {
    // ★ Serialises WITH QUOTES — url("#id") — so a naive /url\\(#/ matches
    // nothing and the harness reports a clean null for every element.
    const f = getComputedStyle(el).backdropFilter || '';
    const m = f.match(/url\\(["']?#([^"')]+)/);
    out.push({ cls: el.className.split(' ').filter((c) => c !== 'spec')[0], id: m ? m[1] : null });
  });
  return {
    target: getComputedStyle(document.documentElement).getPropertyValue('--lqg-flatten-target').trim(),
    els: out,
  };
})()`;

let failures = 0;

async function check(win, label) {
  const s = await win.webContents.executeJavaScript(READ);
  const want = `@${s.target}`;
  const stale = s.els.filter((e) => !e.id || !e.id.includes(want));
  if (!s.els.length) {
    console.log(`  ✗ ${label}: no glass elements found — is the page right?`);
    failures++;
    return;
  }
  if (stale.length) {
    failures++;
    console.log(`  ✗ ${label}: ${stale.length}/${s.els.length} stale (page target ${s.target})`);
    for (const e of stale) console.log(`        ${String(e.cls).padEnd(18)} ${e.id}`);
  } else {
    console.log(`  ✓ ${label}: all ${s.els.length} bound to ${want}`);
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1000, height: 440, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });

  try {
    nativeTheme.themeSource = "light";
    await win.loadURL(URL_);
    await win.webContents.executeJavaScript(`
      new Promise((res) => { const t0 = Date.now();
        const iv = setInterval(() => {
          if (window.__glassReady || Date.now() - t0 > 20000) { clearInterval(iv); res(1); }
        }, 100); })`);
    await check(win, "initial light");

    // ── focused flips, both directions ──────────────────────────────────
    nativeTheme.themeSource = "dark";
    await wait(2500);
    await check(win, "focused light→dark");

    nativeTheme.themeSource = "light";
    await wait(2500);
    await check(win, "focused dark→light");

    // ── unfocused flip (the path that self-heals via resume) ────────────
    await win.webContents.executeJavaScript(
      `document.body.classList.add('electron-window-unfocused'); 1`);
    nativeTheme.themeSource = "dark";
    await wait(1200);
    await win.webContents.executeJavaScript(
      `document.body.classList.remove('electron-window-unfocused'); 1`);
    await wait(2500);
    await check(win, "unfocused flip + refocus");
  } catch (err) {
    console.error("✗ harness error:", err);
    failures++;
  }

  console.log(failures ? `\n✗ FAIL — ${failures} check(s) stale` : "\n✓ PASS — glass follows the scheme on every path");
  app.exit(failures ? 1 : 0);
});
