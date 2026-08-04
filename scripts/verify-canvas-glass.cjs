/**
 * verify-canvas-glass.cjs — the gate for the canvas glass path.
 *
 * The user's constraint on this work was explicit: the control knobs and the
 * edge-glow system keep the engine they have, and only the panel-class glass
 * surfaces move. So this asserts that shape rather than just "it renders":
 *
 *   · every claimed surface is a PANEL-class one, and no knob or lens is
 *   · every claimed surface has a canvas at z-index -1 with real pixels in it
 *   · ::before and ::after still paint on every claimed surface
 *   · the SVG engine and the canvas engine never both hold the same element
 *   · declined surfaces still carry a working backdrop-filter
 *
 * It also prints the claim/decline ledger, because "how many surfaces did this
 * actually take over" is the number that says whether the feature exists.
 *
 *   npm run dev                       # in another shell
 *   electron scripts/verify-canvas-glass.cjs
 */
const { app, BrowserWindow, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

if (process.env.THEME) nativeTheme.themeSource = process.env.THEME;
const URL_ = process.env.GLASS_PROBE_URL || "http://localhost:5173/";
const OUT = path.join(__dirname, "..", ".glass-shots");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch("force-device-scale-factor", "2");

/** Prose behind the glass — the case the engine exists for. */
const PARA = [
  "She had been thinking about it for a long time. She remembered what he had told her, and she wondered whether he had understood what he was saying. She considered it again, and believed now that she had understood nothing at all.",
  "“You will not go,” he said. “I forbid it.”",
  "“You have no right to forbid me anything,” she answered. She refused to look at him. He demanded to know who had helped her. She denied that anyone had. He accused her of lying, and she did not trouble to deny that either.",
  "He came upon the house at dusk. The light fell across the cold stone of the hall, and the air smelled of rain and of the sea beyond the wall. Nothing moved in the room at all, and the lamps had not been lit.",
  "She said nothing. She would not look at him, and she refused to explain herself. The silence stretched between them until it had a weight of its own, and still she turned away.",
].join("\n\n");

// ★ `meta` IS LOAD-BEARING. storage.ts's loadNovel() rejects anything without
//   it and silently returns an empty novel — which is how the first version of
//   this harness ran against "No chapter open" while reporting six happy
//   surfaces with nothing behind them.
const SEED_NOVEL = {
  meta: { title: "Verification", author: "harness", description: "" },
  chapters: [
    { id: "vch1", number: 1, title: "The Brother Marries", content: PARA },
    { id: "vch2", number: 2, title: "The Letter", content: PARA },
  ],
};
const SEED_PREFS = {
  hasSeenOnboarding: true,
  typography: { fontFamily: "georgia", fontSize: 18, lineHeight: 1.7, measure: 70 },
  goals: { dailyWords: 0 },
  funMode: false,
  debugPanel: false,
  storyNlpEnabled: true,
  splitView: false,
  intelMode: "auto",
};

const PANEL_SEL = ".liquid-glass, .analysis-tab, .analysis-action-group";
const NEVER_SEL = ".liquid-glass-control-knob, .liquid-glass-lens, .glass-toggle-knob, .glass-range-knob";

const PROBE = `(() => {
  const claimed = [...document.querySelectorAll("[data-lqg-canvas]")];
  const panels  = [...document.querySelectorAll(${JSON.stringify(PANEL_SEL)})].filter((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && cs.display !== "none" && Number(cs.opacity) > 0.02;
  });
  const never = [...document.querySelectorAll(${JSON.stringify(NEVER_SEL)})];

  const describe = (el) => {
    const r = el.getBoundingClientRect();
    return {
      cls: (el.className || "").toString().split(/\\s+/).filter(Boolean).slice(0, 3).join("."),
      w: Math.round(r.width), h: Math.round(r.height),
      backdrop: (getComputedStyle(el).backdropFilter || "none").slice(0, 24),
      isolation: getComputedStyle(el).isolation,
    };
  };

  // ★ DO NOT readPixels THE GL BUFFER. The context is created with
  //   preserveDrawingBuffer: false, so the drawing buffer is discarded after
  //   compositing and a later read returns all zeros — which is exactly what
  //   the first version of this gate reported for seven perfectly good
  //   surfaces. Structure is checked here; the INK is measured out of the
  //   composited screenshot by the harness, which is what the user sees.
  const canvasInfo = (el) => {
    const c = el.querySelector("canvas.lqg-canvas");
    if (!c) return { present: false };
    return {
      present: true,
      zIndex: getComputedStyle(c).zIndex,
      cw: c.width, ch: c.height,
    };
  };

  // ::before and ::after must still paint — they are the untouched half.
  const pseudo = (el) => {
    const b = getComputedStyle(el, "::before");
    const a = getComputedStyle(el, "::after");
    return {
      beforeContent: b.content, beforeZ: b.zIndex, beforeBg: b.background.slice(0, 20),
      afterContent: a.content, afterZ: a.zIndex, afterBlend: a.mixBlendMode,
    };
  };

  return {
    engine: typeof window.__lqgCanvas === "function" ? window.__lqgCanvas() : null,
    totals: typeof window.__lqgCanvasTotals === "function" ? window.__lqgCanvasTotals() : null,
    claimed: claimed.map((el) => ({
      ...describe(el),
      rect: (() => { const r = el.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height]; })(),
      ink: canvasInfo(el), pseudo: pseudo(el),
    })),
    panels: panels.map(describe),
    claimedCount: claimed.length,
    panelCount: panels.length,
    // A knob or lens must never be claimed, and must never have lost its filter.
    neverClaimed: never.filter((el) => el.hasAttribute("data-lqg-canvas"))
      .map((el) => (el.className || "").toString()),
    neverCount: never.length,
    // Both engines holding one element is the failure the handshake exists to
    // prevent: the SVG filter would raster a region the CSS then hides.
    doubleHeld: claimed.filter((el) => {
      const bf = getComputedStyle(el).backdropFilter || "";
      return bf.includes("url(");
    }).map((el) => (el.className || "").toString()),
    declinedStillFiltered: panels.filter((el) => !el.hasAttribute("data-lqg-canvas"))
      .map((el) => ({ ...describe(el) })),
  };
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1512, height: 950, show: false });
  const logs = [];
  win.webContents.on("console-message", (e) => {
    const m = typeof e === "object" && e.message ? e.message : String(e);
    if (m.includes("[glass-canvas]")) logs.push(m);
  });
  // ★ SEED A REAL CHAPTER, THEN RELOAD. An empty project puts every glass
  //   surface over a flat page: the reconstruction has nothing to draw, the
  //   render looks plausible, and the gate passes having tested nothing. Prose
  //   behind the glass is the case this engine exists for, so the harness has
  //   to create it — the same localStorage keys verify-cross-widgets.mjs uses.
  await win.loadURL(URL_);
  await wait(3000);
  await win.webContents.executeJavaScript(`(() => {
    localStorage.setItem("glass-editor:novel-v1", ${JSON.stringify(JSON.stringify(SEED_NOVEL))});
    localStorage.setItem("glass-editor:current-chapter-v1", ${JSON.stringify(SEED_NOVEL.chapters[0].id)});
    localStorage.setItem("latentwrite:prefs-v1", ${JSON.stringify(JSON.stringify(SEED_PREFS))});
    return true;
  })()`);
  await win.webContents.reload();
  await wait(9000);

  // ★ OPEN THE PANEL THAT ACTUALLY HOLDS THE TOGGLES — by its aria-label, the
  //   way scripts/probe-app-toggle.cjs does. `.analysis-tab--settings` matches
  //   three different tabs and the first of them has no toggles at all, which
  //   is why the "no knob was claimed" gate kept passing over an empty set.
  await win.webContents.executeJavaScript(`(() => {
    const tab = document.querySelector('button[aria-label="Analysis settings"]')
      || document.querySelector(".analysis-tab--settings");
    if (tab) tab.click();
    return true;
  })()`).catch(() => {});
  await wait(2500);

  const p = await win.webContents.executeJavaScript(PROBE);

  // ★ INK, FROM THE COMPOSITED OUTPUT. Screenshot each claimed surface and
  //   count how varied it is. A surface showing a reconstructed backdrop has
  //   many colours; a hole, or a flat fill where the reconstruction produced
  //   nothing, has one or two.
  for (const c of p.claimed) {
    const [x, y, w, h] = c.rect;
    if (w < 4 || h < 4 || x < 0 || y < 0) { c.shot = { colours: 0, skipped: true }; continue; }
    const img = await win.capturePage({
      x: Math.round(x), y: Math.round(y),
      width: Math.round(w), height: Math.round(h),
    });
    const b = img.toBitmap();
    const distinct = new Set();
    let sum = 0, n = 0;
    for (let i = 0; i < b.length; i += 4) {
      distinct.add((b[i] >> 3) + "," + (b[i + 1] >> 3) + "," + (b[i + 2] >> 3));
      sum += (b[i] + b[i + 1] + b[i + 2]) / 3; n++;
    }
    c.shot = { colours: distinct.size, meanLuma: sum / n };
  }
  fs.mkdirSync(OUT, { recursive: true });
  const suffix = process.env.THEME ? "-" + process.env.THEME : "";
  fs.writeFileSync(path.join(OUT, `canvas-glass${suffix}.png`), (await win.capturePage()).toPNG());

  console.log(`\n━━ CLAIM LEDGER ━━`);
  console.log(`${p.claimedCount} of ${p.panelCount} panel-class surfaces claimed by the canvas engine`);
  for (const c of p.claimed) {
    const st = (p.engine || []).find((e) => e.cls === c.cls);
    console.log(`  ✓ ${c.cls.slice(0, 38).padEnd(38)} ${(c.w + "x" + c.h).padEnd(10)} ` +
      `z=${c.ink.zIndex} buf ${c.ink.cw}x${c.ink.ch} ` +
      `colours ${String(c.shot?.colours ?? 0).padStart(5)} ` +
      (st?.stats
        ? `| ${st.stats.ms}ms rects ${st.stats.rects} glyphs ${st.stats.glyphs} ` +
          `blits ${st.stats.blits} paints ${st.paints}`
        : `| never painted`));
  }
  for (const d of p.declinedStillFiltered) {
    console.log(`  · ${d.cls.slice(0, 40).padEnd(40)} ${(d.w + "x" + d.h).padEnd(10)} ` +
      `declined → backdrop-filter: ${d.backdrop}`);
  }
  if (logs.length) {
    console.log(`\nwhy declined:`);
    for (const l of [...new Set(logs)]) console.log(`  ${l.replace(/^.*\[glass-canvas\] /, "")}`);
  }

  const results = [];
  const ok = (label, cond, detail) => results.push({ label, cond, detail });

  ok("the canvas engine claimed at least one panel surface",
    p.claimedCount > 0, `claimed ${p.claimedCount} of ${p.panelCount}`);
  ok("★ NO knob or lens was claimed",
    p.neverClaimed.length === 0,
    `claimed: ${p.neverClaimed.join(", ")} — the user's constraint is that these keep the SVG engine`);
  ok("…and knobs/lens exist to be checked at all",
    p.neverCount > 0, `found ${p.neverCount} — a vacuous pass otherwise`);
  ok("★ no element is held by BOTH engines",
    p.doubleHeld.length === 0, `double-held: ${p.doubleHeld.join(", ")}`);
  ok("every claimed surface has its canvas at z-index -1",
    p.claimed.every((c) => c.ink.present && c.ink.zIndex === "-1"),
    JSON.stringify(p.claimed.map((c) => c.ink.zIndex)));
  ok("★ every claimed surface actually painted at least once",
    (p.engine || []).length > 0 && (p.engine || []).every((e) => e.paints > 0),
    `paints: ${(p.engine || []).map((e) => e.paints).join(", ")}`);
  ok("★ …and the composited surface is not a flat fill",
    p.claimed.length > 0 && p.claimed.every((c) => (c.shot?.colours ?? 0) > 8),
    `colours: ${p.claimed.map((c) => c.shot?.colours ?? 0).join(", ")} ` +
    `— one or two means the reconstruction produced nothing and the surface is a slab`);
  ok("claimed surfaces form a stacking context (isolation)",
    p.claimed.every((c) => c.isolation === "isolate"),
    `isolation: ${p.claimed.map((c) => c.isolation).join(", ")} ` +
    `— without it the canvas escapes behind the element and ::after's blend changes`);
  ok("★ the specular ring (::before) still paints",
    p.claimed.every((c) => c.pseudo.beforeContent && c.pseudo.beforeContent !== "none"),
    JSON.stringify(p.claimed.map((c) => c.pseudo.beforeContent)));
  ok("★ the edge glow (::after) still paints, still plus-lighter",
    p.claimed.every((c) => c.pseudo.afterContent !== "none"
      && /plus-lighter|screen/.test(c.pseudo.afterBlend)),
    JSON.stringify(p.claimed.map((c) => [c.pseudo.afterContent, c.pseudo.afterBlend])));
  ok("claimed surfaces have no backdrop-filter left",
    p.claimed.every((c) => c.backdrop === "none"),
    `backdrop: ${p.claimed.map((c) => c.backdrop).join(" | ")}`);
  // ★ THIS GATE MEANS TWO DIFFERENT THINGS DEPENDING ON THE FALLBACK, and as an
  //   `every()` over a possibly-empty list it would pass vacuously in the case
  //   that matters. With the fallback OFF nothing can decline, so the assertion
  //   becomes "nothing declined" — a real check with a real failure mode.
  const fb = p.totals && p.totals.fallbackEnabled;
  if (fb) {
    ok("declined surfaces KEPT a backdrop-filter",
      p.declinedStillFiltered.length > 0
        ? p.declinedStillFiltered.every((d) => d.backdrop !== "none")
        : true,
      `${p.declinedStillFiltered.filter((d) => d.backdrop === "none").length} declined with no filter — ` +
      `those surfaces have no glass at all`);
  } else {
    ok("★ fallback is OFF, so nothing declined",
      p.declinedStillFiltered.length === 0,
      `${p.declinedStillFiltered.length} surfaces declined with the fallback disabled: ` +
      `${p.declinedStillFiltered.map((d) => d.cls).join(", ")} — with no fallback they have no glass`);
  }
  console.log(`\n  (fallback is ${fb ? "ON" : "OFF"} — ` +
    `${fb ? "unpaintable surfaces revert to backdrop-filter" : "every surface stays on the canvas path"})`);

  console.log(`\ncanvas glass, real app:`);
  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.cond ? "✓" : "✗"} ${r.label}${r.cond ? "" : ` — ${r.detail}`}`);
    if (!r.cond) failed++;
  }
  console.log(`\nshot: ${OUT}/canvas-glass${suffix}.png`);
  console.log(failed ? `FAILED ${failed}/${results.length}` : `PASS ${results.length}/${results.length}`);
  app.exit(failed ? 1 : 0);
});
