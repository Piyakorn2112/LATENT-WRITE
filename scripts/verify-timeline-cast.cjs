/**
 * verify-timeline-cast.cjs — the cast ledger, on the REAL TimelineGraphFull.
 *
 * Mounts /timeline-verify.html (the shipping component + synthetic novel) and
 * asserts the redesign's load-bearing properties in the rendered SVG: the
 * section header, full names (the old tracks truncated everything to 7
 * uppercase chars), bars with real height VARIATION (presence weight), the
 * drives diamonds, dashed absence bridges, and the per-character stat lines.
 *
 *   VITE_URL=http://localhost:5178 electron scripts/verify-timeline-cast.cjs
 */
const { app, BrowserWindow, nativeTheme } = require("electron");
// THEME=light|dark forces the scheme — the ledger must read in both.
if (process.env.THEME) nativeTheme.themeSource = process.env.THEME;
const fs = require("node:fs");
const path = require("node:path");
const BASE = process.env.VITE_URL || "http://localhost:5178";
const OUT = path.join(__dirname, "..", ".glass-shots");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch("force-device-scale-factor", "1");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 950, show: false });
  await win.loadURL(`${BASE}/timeline-verify.html`);
  await wait(2500);
  const p = await win.webContents.executeJavaScript("window.__probe && window.__probe()");
  if (!p || p.error) { console.error("probe failed:", p && p.error); app.exit(2); return; }

  fs.mkdirSync(OUT, { recursive: true });
  const img = await win.capturePage();
  fs.writeFileSync(path.join(OUT, `timeline-cast-ledger${process.env.THEME ? "-" + process.env.THEME : ""}.png`), img.toPNG());

  const results = [];
  const ok = (label, cond, detail) => results.push({ label, cond, detail });
  ok("CAST section header renders", p.castHeader === true, JSON.stringify(p.castHeader));
  ok("full names, not 7-char stubs", p.names.length >= 4, `found: ${p.names.join(", ")}`);
  ok("an over-long name is ellipsised", !!p.ellipsised, String(p.ellipsised));
  ok("presence bars render", p.barCount >= 30, `bars: ${p.barCount}`);
  ok("bar heights VARY with presence weight", p.distinctHeights >= 5, `distinct heights: ${p.distinctHeights}`);
  ok("drives diamonds render", p.diamondCount >= 5, `diamonds: ${p.diamondCount}`);
  ok("dashed bridges span absences", p.bridgeCount >= 2, `bridges: ${p.bridgeCount}`);
  ok("stat lines carry drives/away/enters", p.statLines.length >= 4, `${p.statLines.length}: ${p.statLines.slice(0, 3).join(" | ")}`);

  console.log("\ncast ledger, real component:");
  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.cond ? "✓" : "✗"} ${r.label}${r.cond ? "" : ` — ${r.detail}`}`);
    if (!r.cond) failed++;
  }
  console.log(`\nshot: ${OUT}/timeline-cast-ledger.png`);
  console.log(failed ? `FAILED ${failed}/${results.length}` : `PASS ${results.length}/${results.length}`);
  app.exit(failed ? 1 : 0);
});
