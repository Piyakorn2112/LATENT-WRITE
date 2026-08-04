/**
 * verify-timeline-cast.cjs — the cast ledger, on the REAL TimelineGraphFull.
 *
 * Mounts /timeline-verify.html (the shipping component + synthetic novel) and
 * asserts the redesign's load-bearing properties in the rendered SVG: the
 * section header, full names (the old tracks truncated everything to 7
 * uppercase chars), bars with real height VARIATION (presence weight), the
 * agency squares (colour = event type), the peak-chapter ring, dashed absence
 * bridges, and the per-character stat lines. It also asserts the OLD floating
 * diamond is gone: a redesign that leaves both is a redesign nobody finished.
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
  ok("★ the floating diamond is GONE", p.diamondCount === 0, `still drawing ${p.diamondCount}`);
  ok("agency squares render below the baseline", p.driveCount >= 5, `squares: ${p.driveCount}`);
  ok("★ …and are coloured BY EVENT TYPE", p.driveColorCount >= 3,
    `distinct colours: ${p.driveColorCount} — one colour means the type is not being read`);
  ok("the peak chapter is ringed", p.peakRingCount >= 4, `rings: ${p.peakRingCount}`);
  ok("the type key names the colours", p.legendTypes.length >= 4, `legend: ${p.legendTypes.join(", ")}`);
  ok("a track with counts but NO types still draws its squares",
    p.driveCount >= 6, "the legacy-graph path must not silently draw nothing");
  ok("dashed bridges span absences", p.bridgeCount >= 2, `bridges: ${p.bridgeCount}`);
  ok("stat lines carry peak/drives/away/enters", p.statLines.length >= 4, `${p.statLines.length}: ${p.statLines.slice(0, 3).join(" | ")}`);

  // ── presence vs evocation ────────────────────────────────────────────────
  ok("evoked chapters render as their own mark", p.ghostCount > 0, `ghosts: ${p.ghostCount}`);
  // The PAIR. "Everything is a ghost" would satisfy the gate above perfectly.
  ok("…and most chapters are still solid presence", p.solidCount > p.ghostCount * 3,
    `solid ${p.solidCount} vs ghost ${p.ghostCount}`);
  ok("★ a ghost is HOLLOW, not a fainter bar", p.ghostsHollow === true,
    "fill must be none — a shade is what this redesign removed");
  ok("…and a present chapter is filled", p.solidsFilled === true, "solid bars must not be hollow");
  ok("★ every ghost is the SAME height", p.ghostHeights === 1,
    `distinct ghost heights: ${p.ghostHeights} — being talked about is not a quantity of presence`);
  ok("★ a track with NO presence data draws solid, not ghosts", p.ghostCount === 6,
    `expected 6 (Darcy 2 + Jane 3 + Lady Catherine 1); got ${p.ghostCount}. ` +
    `10 means the no-data default flipped to "mentioned" and Wickham joined them`);
  ok("no bar renders unclassified", p.unclassified === 0, `unclassified: ${p.unclassified}`);
  ok("speaking chapters carry a voice cap", p.voiceCount > 0, `caps: ${p.voiceCount}`);
  ok("…but not every present chapter does", p.voiceCount < p.solidCount,
    `caps ${p.voiceCount} vs solid ${p.solidCount} — a cap on everything says nothing`);
  ok("★ \"enters\" is the walk-on, with the herald gap named",
    !!p.heraldLine && /enters 12/.test(p.heraldLine),
    `herald line: ${p.heraldLine} — Lady Catherine is named in 7 and arrives in 12`);
  ok("★ no stat line runs off the left edge", p.statOverflowCount === 0,
    `${p.statOverflowCount} overflowing — the line is right-anchored at the ` +
    `character's entry chapter, so every fact added to it grows into the margin`);
  ok("stat line counts speaking chapters", !!p.speaksLine, String(p.speaksLine));
  ok("stat line counts offstage chapters", !!p.offstageLine, String(p.offstageLine));
  ok("the legend explains the hollow mark", p.legendMentionsHollow === true,
    "a mark nobody can decode is decoration");

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
