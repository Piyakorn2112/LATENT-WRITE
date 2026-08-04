/**
 * capture-toolbar-bend.cjs — see the artifact, on the real toolbar, over real
 * prose.
 *
 * Every earlier attempt to photograph this failed the same way: the harness
 * seeded a chapter, scrolled something, and captured a toolbar with NOTHING
 * BEHIND IT — so the shot showed clean glass over flat page colour and the
 * measurement agreed. The setup was broken, not the render.
 *
 * ★ SO THE SETUP IS ASSERTED BEFORE ANYTHING IS CAPTURED. It enumerates every
 * scrollable container, scrolls the one that actually holds the prose, and then
 * checks with elementsFromPoint that text is genuinely under the toolbar's
 * midline. If it is not, it says so and exits non-zero instead of writing a
 * misleading picture.
 *
 * Writes, into .glass-shots/bend/:
 *   plain.png  — the same crop with the glass removed (the undisturbed text)
 *   glass.png  — as it ships
 *   diff.png   — 6x amplified difference, which is where the bend shows
 *
 *   npm run dev
 *   electron scripts/capture-toolbar-bend.cjs
 */
const { app, BrowserWindow, nativeImage, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.GLASS_PROBE_URL || "http://localhost:5173/";
const OUT = path.join(__dirname, "..", ".glass-shots", "bend");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch("force-device-scale-factor", "2");
if (process.env.THEME) nativeTheme.themeSource = process.env.THEME;
app.commandLine.appendSwitch("disable-renderer-backgrounding");

// ★ VARIED prose, deliberately. The first version repeated an identical
// sentence every paragraph, which gives a cross-correlation many equally good
// matches — it then locks onto the wrong line and reports a horizontal offset
// that is an artifact of the seed, not of the glass. Every line here is
// distinct so a match is unambiguous.
const WORDS = ("harbour lantern gravel thistle compass verdict marrow tallow bracken " +
  "quarry sable furrow cinder plover mantel ridge kestrel bramble hollow " +
  "shale drover cairn wexford tallith murrain sedge lintel pallor gorse " +
  "warren spindle chandler lattice pewter osier thatch clover brindle stoat").split(" ");
const PARA = Array.from({ length: 70 }, (_, i) => {
  const pick = (k) => WORDS[(i * 7 + k * 13) % WORDS.length];
  return `The ${pick(0)} at ${pick(1)} kept its ${pick(2)} through the ${pick(3)}, ` +
    `and no ${pick(4)} came near the ${pick(5)} until the ${pick(6)} had turned ` +
    `the ${pick(7)} toward ${pick(8)} and left the ${pick(9)} standing.`;
}).join("\n\n");

const NOVEL = {
  meta: { title: "Bend", author: "harness", description: "" },
  chapters: [{ id: "b1", number: 1, title: "The Brother Marries", content: PARA }],
};
const PREFS = {
  hasSeenOnboarding: true,
  typography: { fontFamily: "georgia", fontSize: 18, lineHeight: 1.7, measure: 70 },
  goals: { dailyWords: 0 }, funMode: false, debugPanel: false,
  storyNlpEnabled: true, splitView: false, intelMode: "auto",
};

/** Scroll whichever container actually holds the prose, then PROVE it worked. */
const SCROLL_AND_VERIFY = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bar = document.querySelector(".toolbar.liquid-glass");
  if (!bar) return { ok: false, why: "no .toolbar.liquid-glass" };
  const br = bar.getBoundingClientRect();

  // Every scrollable box, largest first — the editor is the big one.
  const boxes = [...document.querySelectorAll("*")].filter((e) => {
    const cs = getComputedStyle(e);
    return e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(cs.overflowY);
  }).sort((a, b) => b.clientHeight - a.clientHeight);
  const candidates = boxes.map((e) => ({
    cls: (e.className || "").toString().split(/\\s+/).filter(Boolean).slice(0, 2).join("."),
    ch: e.clientHeight, sh: e.scrollHeight,
  }));

  // What is under the toolbar's midline right now?
  const probe = () => {
    const hits = new Set();
    for (let i = 1; i < 8; i++) {
      const x = br.left + (i / 8) * br.width;
      for (const el of document.elementsFromPoint(x, br.top + br.height / 2)) {
        if (el === bar || bar.contains(el)) continue;
        hits.add(el);
      }
    }
    let chars = 0;
    const names = [];
    for (const el of hits) {
      names.push(el.tagName.toLowerCase() + "." +
        (el.className || "").toString().split(/\\s+/).filter(Boolean).slice(0, 2).join("."));
      for (const n of el.childNodes) {
        if (n.nodeType === 3) chars += (n.textContent || "").trim().length;
      }
    }
    return { chars, names };
  };

  // Try each container, scrolling in steps, until text lands under the bar.
  for (const box of boxes.length ? boxes : [document.scrollingElement]) {
    for (const top of [200, 400, 700, 1100, 1600]) {
      box.scrollTop = top;
      await sleep(220);
      const p = probe();
      if (p.chars > 0) {
        return { ok: true, container: (box.className || "").toString().slice(0, 40),
                 scrollTop: box.scrollTop, chars: p.chars, under: p.names, candidates,
                 bar: { x: br.left, y: br.top, w: br.width, h: br.height } };
      }
    }
    box.scrollTop = 0;
  }
  return { ok: false, why: "scrolled every container; no text ever landed under the toolbar",
           candidates, bar: { x: br.left, y: br.top, w: br.width, h: br.height } };
})()`;

function amplify(a, b, w, h, gain) {
  const A = a.toBitmap(), B = b.toBitmap();
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h * 4; i += 4) {
    const d = Math.min(255, gain * Math.max(
      Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2])));
    out[i] = d; out[i + 1] = d; out[i + 2] = d; out[i + 3] = 255;
  }
  return nativeImage.createFromBitmap(out, { width: w, height: h }).toPNG();
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1512, height: 950, show: true,
    webPreferences: { backgroundThrottling: false },
  });
  await win.loadURL(BASE);
  await wait(2500);
  await win.webContents.executeJavaScript(`(() => {
    localStorage.setItem("glass-editor:novel-v1", ${JSON.stringify(JSON.stringify(NOVEL))});
    localStorage.setItem("glass-editor:current-chapter-v1", "b1");
    localStorage.setItem("latentwrite:prefs-v1", ${JSON.stringify(JSON.stringify(PREFS))});
    return true;
  })()`);
  await win.loadURL(BASE);
  win.focus();
  await wait(9000);

  const setup = await win.webContents.executeJavaScript(SCROLL_AND_VERIFY);
  if (!setup.ok) {
    console.error(`\n✗ SETUP FAILED — ${setup.why}`);
    console.error(`  toolbar at [${Object.values(setup.bar).map(Math.round).join(", ")}]`);
    console.error(`  scrollable containers found:`);
    for (const c of setup.candidates) console.error(`    ${c.cls || "(unnamed)"}  client ${c.ch}  scroll ${c.sh}`);
    console.error(`\n  Nothing was captured — a shot of an empty toolbar would say the`);
    console.error(`  artifact is absent when the setup simply never produced it.`);
    app.exit(2);
    return;
  }

  console.log(`\n✓ setup verified`);
  console.log(`  container "${setup.container}" scrolled to ${setup.scrollTop}`);
  console.log(`  ${setup.chars} characters under the toolbar midline`);
  console.log(`  stack: ${setup.under.join(" | ")}`);

  // ★ WAIT FOR THE SCROLL-EDGE BLUR TO FADE. `.scroll-edge-top-strip` stacks
  //   seven of its own backdrop-filters over exactly this region and ramps them
  //   up during a scroll. Capturing straight after scrolling photographs THEIR
  //   blur — the earlier shots came back as featureless mush for this reason,
  //   and read as "no artifact" when nothing had been photographed at all.
  await wait(3000);

  // ★ CLEAR EVERYTHING THAT IS NOT THE TOOLBAR'S GLASS, before BOTH captures.
  //   `.scroll-edge-top-strip` stacks seven of its own backdrop-filters over
  //   exactly this band, and the world-data warning overlay floats above it —
  //   earlier shots photographed those and came back as featureless mush, then
  //   got read as "no artifact". The two captures must differ ONLY by the glass.
  await win.webContents.executeJavaScript(`(() => {
    const s = document.createElement("style");
    s.textContent = [
      "*,*::before,*::after{animation:none!important;transition:none!important}",
      ".scroll-edge-top,.scroll-edge-top-strip,.scroll-edge-top-overlay{display:none!important}",
      ".wc-overlay,.status-pill,.chapter-observation{display:none!important}",
      ".toolbar.liquid-glass > *{visibility:hidden!important}",
    ].join("");
    document.head.appendChild(s); return true;
  })()`);
  await wait(1200);

  fs.mkdirSync(OUT, { recursive: true });
  const b = setup.bar;
  const PAD = 26;
  const crop = {
    x: Math.max(0, Math.round(b.x + 8)),
    y: Math.max(0, Math.round(b.y - PAD)),
    width: Math.round(Math.min(b.w - 16, 300)),
    height: Math.round(b.h + PAD * 2),
  };

  const glass = await win.capturePage(crop);
  fs.writeFileSync(path.join(OUT, "glass.png"), glass.toPNG());

  // Strip the glass entirely — background, both pseudo-elements, its content —
  // so what remains is the undisturbed backdrop in the identical crop.
  await win.webContents.executeJavaScript(`(() => {
    const s = document.createElement("style");
    s.textContent = ".toolbar.liquid-glass{backdrop-filter:none!important;" +
      "-webkit-backdrop-filter:none!important;background:transparent!important;" +
      "box-shadow:none!important}" +
      ".toolbar.liquid-glass::before,.toolbar.liquid-glass::after{display:none!important}" +
      ".toolbar.liquid-glass > *{visibility:hidden!important}" +
      ".lqg-edge-color,.lqg-edge-rim{display:none!important}";
    document.head.appendChild(s); return true;
  })()`);
  await wait(700);
  const plain = await win.capturePage(crop);
  fs.writeFileSync(path.join(OUT, "plain.png"), plain.toPNG());

  const size = glass.getSize();
  fs.writeFileSync(path.join(OUT, "diff.png"),
    amplify(glass, plain, size.width, size.height, 6));

  console.log(`\ncrop [${crop.x}, ${crop.y}, ${crop.width}, ${crop.height}] @ ${size.width}x${size.height}`);
  console.log(`shots: ${OUT}/{plain,glass,diff}.png`);
  app.exit(0);
});
