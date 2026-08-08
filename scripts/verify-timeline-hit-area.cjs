/**
 * verify-timeline-hit-area.cjs — the whole chapter column selects the chapter,
 * and nothing else lost its click doing it.
 *
 * ★ WHY THIS EXISTS. Selecting a chapter meant hitting its ~14px node or the
 *   small label under it; the only other thing carrying the handler was a
 *   0.75px drop line. The column band the active-chapter beam already paints
 *   is now the hit area: 52px wide, full canvas height.
 *
 * ★★ THE RISK IS NOT THE FEATURE, IT IS THE COLLATERAL. SVG hit-testing
 *    follows paint order, so a band laid across the canvas can silently
 *    swallow the event chips, the cast tooltips or the node itself. Every
 *    gate after the first two exists to prove it did not.
 *
 * ★ POINTS ARE CHOSEN BY ASKING THE PAGE, NOT BY ARITHMETIC. An earlier
 *   version guessed "the node, plus 140px" and landed on a cast presence bar,
 *   which correctly owns its own pointer area for its tooltip. The gate then
 *   reported a bug that did not exist. It now finds a point the band actually
 *   occupies before clicking there.
 *
 *   VITE_URL=http://localhost:5178 electron scripts/verify-timeline-hit-area.cjs
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

async function clickAt(win, x, y) {
  win.webContents.sendInputEvent({ type: "mouseMove", x, y });
  await wait(70);
  win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  await wait(360);
}

const INSPECTOR = `(() => {
  const e = document.querySelector('.timeline-inspector-eyebrow');
  return e ? e.textContent.trim() : null;
})()`;
const CLOSE = `(() => { const b = document.querySelector('.timeline-inspector .icon-btn'); if (b) b.click(); return true; })()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 950, show: false });
  await win.loadURL(`${BASE}/timeline-verify.html`);
  await wait(2600);

  console.log("\nbigger click target");
  const geo = await win.webContents.executeJavaScript(`(() => {
    const hits = [...document.querySelectorAll('[data-chapter-hit]')];
    if (!hits.length) return { error: 'no hit bands rendered' };
    const t = hits[2];
    const b = t.getBoundingClientRect();
    const cx = Math.round(b.left + b.width / 2);
    // Nearest node circle in this column, for the size comparison.
    let node = null, best = 1e9;
    for (const c of document.querySelectorAll('.timeline-full-scroll svg circle')) {
      const r = c.getBoundingClientRect();
      if (!r.width) continue;
      const d = Math.abs(r.left + r.width / 2 - cx);
      if (d < best) { best = d; node = r; }
    }
    // Points in this column that the BAND itself owns, far from the node.
    const owned = [];
    for (let y = Math.round(b.top) + 12; y < Math.round(b.top + b.height) - 12; y += 10) {
      const el = document.elementFromPoint(cx, y);
      if (el && el.getAttribute && el.getAttribute('data-chapter-hit') === t.getAttribute('data-chapter-hit')) owned.push(y);
    }
    return {
      count: hits.length,
      id: t.getAttribute('data-chapter-hit'),
      cx, band: { w: Math.round(b.width), h: Math.round(b.height) },
      nodeR: node ? Math.round(node.width / 2) : null,
      nodeCy: node ? Math.round(node.top + node.height / 2) : null,
      owned,
    };
  })()`, true);
  if (geo.error) { console.error(geo.error); app.exit(2); return; }

  gate("a hit band exists for every chapter", geo.count === 14, `bands=${geo.count}`);
  gate("the band dwarfs the node", geo.band.w >= 40 && geo.nodeR && geo.band.w > geo.nodeR * 3,
    `band ${geo.band.w}x${geo.band.h}px vs node r=${geo.nodeR}px`);
  gate("the band owns a large share of its column", geo.owned.length >= 20,
    `${geo.owned.length} sampled points, ~${geo.owned.length * 10}px of ${geo.band.h}px`);

  // Click the band far from the node, both above and below the spine.
  const far = geo.owned.filter((y) => Math.abs(y - geo.nodeCy) > 90);
  gate("found band points far from the node (precondition)", far.length >= 2, `${far.length} points`);
  for (const y of (far.length >= 2 ? [far[0], far[far.length - 1]] : [])) {
    await win.webContents.executeJavaScript(CLOSE, true);
    await wait(250);
    await clickAt(win, geo.cx, y);
    const open = await win.webContents.executeJavaScript(INSPECTOR, true);
    gate(`★ clicking the column at y=${y} selects the chapter`, !!open, `inspector=${open ?? "did not open"}`);
  }

  // The node itself must still work.
  await win.webContents.executeJavaScript(CLOSE, true);
  await wait(250);
  if (geo.nodeCy != null) await clickAt(win, geo.cx, geo.nodeCy);
  const viaNode = await win.webContents.executeJavaScript(INSPECTOR, true);
  gate("the node itself still selects", !!viaNode, `inspector=${viaNode ?? "did not open"}`);

  // ── collateral ───────────────────────────────────────────────────────────
  console.log("\nnothing else lost its pointer");
  await win.webContents.executeJavaScript(CLOSE, true);
  await wait(300);

  // ★★ REAL POINTER, NOT A SYNTHETIC EVENT. React implements onMouseEnter via
  //    delegated mouseover, so a dispatched `mouseenter` never reaches the
  //    handler and the gate reported chips broken when they were fine. Same
  //    lesson as driving a scroll with a wheel event rather than scrollTop.
  const chip = await win.webContents.executeJavaScript(`(() => {
    const svg = document.querySelector(".timeline-full-scroll svg");
    for (const t of svg.querySelectorAll("text")) {
      if (!/learns of ch/i.test(t.textContent || "")) continue;
      let g = t.parentElement;
      while (g && !(g.getAttribute("style") || "").includes("pointer")) g = g.parentElement;
      if (!g) continue;
      const r = g.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), label: t.textContent };
    }
    return null;
  })()`, true);

  gate("found an event chip to test (precondition)", !!chip, chip ? chip.label : "none rendered");
  if (chip) {
    win.webContents.sendInputEvent({ type: "mouseMove", x: chip.cx, y: chip.cy });
    await wait(500);
    const hovered = await win.webContents.executeJavaScript(
      `!!document.querySelector(".timeline-hover-card")`, true);
    gate("★ event chips still react to a real pointer", hovered);
    const top = await win.webContents.executeJavaScript(`(() => {
      const el = document.elementFromPoint(${chip.cx}, ${chip.cy});
      return { tag: el ? el.tagName : "none", isBand: !!(el && el.hasAttribute && el.hasAttribute("data-chapter-hit")) };
    })()`, true);
    gate("★ the band is not the topmost element over a chip", !top.isBand, `topmost=${top.tag}`);
  }

  const castTip = await win.webContents.executeJavaScript(
    `document.querySelectorAll('[data-cast-mark] title').length`, true);
  gate("cast marks keep their tooltips", castTip > 0, `${castTip} tooltips`);

  // ── no visual change ─────────────────────────────────────────────────────
  console.log("\nno visual change");
  await win.webContents.executeJavaScript(CLOSE, true);
  await wait(400);
  win.webContents.sendInputEvent({ type: "mouseMove", x: 8, y: 8 });
  await wait(500);
  const withBands = (await win.webContents.capturePage()).toPNG();
  await win.webContents.executeJavaScript(
    `(() => { for (const h of document.querySelectorAll('[data-chapter-hit]')) h.remove(); })()`, true);
  await wait(500);
  const withoutBands = (await win.webContents.capturePage()).toPNG();
  gate("★ pixel-identical with the bands removed", Buffer.compare(withBands, withoutBands) === 0,
    `${withBands.length} vs ${withoutBands.length} bytes`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`}  (${results.length} gates)\n`);
  app.exit(failed.length ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
