/**
 * verify-timeline-cast-scroll.cjs — the cast ledger must be REACHABLE, and
 * making it reachable must change nothing when it already fits.
 *
 * ★ WHY THIS EXISTS. The fullscreen timeline canvas grows downward with the
 *   cast (one track per character). Its scroller was `overflow-y: hidden`, so
 *   on a shorter display the ledger was not merely below the fold, it was
 *   unreachable: measured 121px lost at 1280x800 with five characters, and
 *   about 289px at the eight-track maximum.
 *
 * Two gates, and the second is the one that protects the rest of the UI:
 *   REACHABLE  at a small viewport, scrolling to the bottom brings the last
 *              cast row fully into view.
 *   UNCHANGED  at a viewport where the canvas fits, the rendering is
 *              PIXEL-IDENTICAL to the old `overflow-y: hidden` behaviour.
 *              A scrollbar that appears when it should not would show here.
 *
 *   VITE_URL=http://localhost:5178 electron scripts/verify-timeline-cast-scroll.cjs
 */
const { app, BrowserWindow } = require("electron");
const BASE = process.env.VITE_URL || "http://localhost:5178";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch("force-device-scale-factor", "1");

const results = [];
const gate = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
};

async function shot(win) {
  const img = await win.webContents.capturePage();
  return img.toPNG();
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 950, show: false });
  await win.loadURL(`${BASE}/timeline-verify.html`);
  await wait(2500);

  // ── 1. reachable at a short viewport ─────────────────────────────────────
  console.log("\ncast ledger reachability");
  win.setSize(1280, 800);
  await wait(700);
  const before = await win.webContents.executeJavaScript(`(() => {
    const sc = document.querySelector('.timeline-full-scroll');
    const svg = sc && sc.querySelector('svg');
    if (!sc || !svg) return { error: 'not mounted' };
    return {
      overflowY: getComputedStyle(sc).overflowY,
      clipped: Math.round(svg.getBoundingClientRect().height - sc.getBoundingClientRect().height),
      maxScroll: sc.scrollHeight - sc.clientHeight,
    };
  })()`, true);
  if (before.error) { console.error(before.error); app.exit(2); return; }
  gate("the canvas really does overflow at 1280x800", before.clipped > 0, `clipped=${before.clipped}px`);
  gate("the scroller allows vertical scrolling", before.overflowY === "auto", `overflow-y=${before.overflowY}`);
  gate("there is scrollable distance", before.maxScroll > 0, `maxScroll=${before.maxScroll}px`);

  // ★★ SCROLL IT THE WAY A USER WOULD. Setting scrollTop by script works even
  //    on overflow: hidden, so a scripted scroll passes against the very bug
  //    this file exists to catch. A real wheel event does not.
  for (let i = 0; i < 12; i++) {
    win.webContents.sendInputEvent({ type: "mouseWheel", x: 640, y: 500, deltaX: 0, deltaY: -40, canScroll: true });
    await wait(40);
  }
  await wait(400);

  const after = await win.webContents.executeJavaScript(`(() => {
    const sc = document.querySelector('.timeline-full-scroll');
    const svg = sc.querySelector('svg');
    const scr = sc.getBoundingClientRect();
    // The deepest painted thing in the canvas is the last cast row.
    let deepest = -Infinity;
    for (const el of svg.querySelectorAll('rect, text, circle, path')) {
      const b = el.getBoundingClientRect();
      if (b.height > 0) deepest = Math.max(deepest, b.bottom);
    }
    return { scrolled: sc.scrollTop, deepestBelowFold: Math.round(deepest - scr.bottom) };
  })()`, true);
  gate("★ a real wheel gesture scrolls the canvas", after.scrolled > 0, `scrollTop=${after.scrolled}px`);
  gate("★ the last cast row becomes fully visible", after.deepestBelowFold <= 1,
    `deepest is ${after.deepestBelowFold}px past the fold`);

  // ── 2. pixel-identical where the canvas already fits ─────────────────────
  console.log("\nno visual change where it already fitted");
  win.setSize(1500, 950);
  await wait(900);
  const fits = await win.webContents.executeJavaScript(`(() => {
    const sc = document.querySelector('.timeline-full-scroll');
    return { scrollable: sc.scrollHeight > sc.clientHeight + 1 };
  })()`, true);
  gate("canvas fits at 1500x950", !fits.scrollable);

  const withAuto = await shot(win);
  // Force the OLD behaviour and re-shoot. Identical bytes means the change is
  // invisible exactly where it should be.
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('.timeline-full-scroll').style.overflowY = 'hidden';
  })()`, true);
  await wait(500);
  const withHidden = await shot(win);
  gate("★ pixel-identical to the previous behaviour",
    Buffer.compare(withAuto, withHidden) === 0,
    `${withAuto.length} vs ${withHidden.length} bytes`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`}  (${results.length} gates)\n`);
  app.exit(failed.length ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
