/**
 * diff-canvas-glass.cjs — the canvas engine against the SVG engine, same app,
 * same content, same frame.
 *
 * The two engines are SUPPOSED to differ inside a glass surface — that is the
 * whole point of the change — so this is not an equality gate. It measures
 * where they differ and how much, and it draws a hard line around the one
 * region that must NOT move:
 *
 *   ★ THE EDGE-GLOW BAND. `.lqg-edge-color` is a sibling behind each surface
 *     and `::after` is a plus-lighter layer on top of it. The user's constraint
 *     was that this system keeps working exactly as it does today, so the ring
 *     just OUTSIDE each surface — where the glow spills past the rim and the
 *     canvas cannot reach — has to stay put. A large delta there means the
 *     stacking context changed and the blend is compositing against something
 *     new.
 *
 * Drives the app twice: once normally, once with the engine's kill switch
 * (`?lqg-canvas=0`) so the SVG path renders the identical DOM.
 *
 *   npm run dev                       # in another shell
 *   electron scripts/diff-canvas-glass.cjs
 */
const { app, BrowserWindow, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

if (process.env.THEME) nativeTheme.themeSource = process.env.THEME;
const BASE = process.env.GLASS_PROBE_URL || "http://localhost:5173/";
const OUT = path.join(__dirname, "..", ".glass-shots", "ab");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch("force-device-scale-factor", "2");

const PARA = [
  "She had been thinking about it for a long time. She remembered what he had told her, and she wondered whether he had understood what he was saying. She considered it again, and believed now that she had understood nothing at all.",
  "“You will not go,” he said. “I forbid it.”",
  "“You have no right to forbid me anything,” she answered. She refused to look at him. He demanded to know who had helped her. She denied that anyone had. He accused her of lying, and she did not trouble to deny that either.",
  "He came upon the house at dusk. The light fell across the cold stone of the hall, and the air smelled of rain and of the sea beyond the wall. Nothing moved in the room at all, and the lamps had not been lit.",
  "She said nothing. She would not look at him, and she refused to explain herself. The silence stretched between them until it had a weight of its own, and still she turned away.",
  "In the morning the house was full of people, and none of them spoke of what had happened. She went down to the shore alone and stood a long while where the water came in over the stones.",
].join("\n\n");

const NOVEL = {
  meta: { title: "Verification", author: "harness", description: "" },
  chapters: [{ id: "v1", number: 1, title: "The Brother Marries", content: PARA }],
};
const PREFS = {
  hasSeenOnboarding: true,
  typography: { fontFamily: "georgia", fontSize: 18, lineHeight: 1.7, measure: 70 },
  goals: { dailyWords: 0 }, funMode: false, debugPanel: false,
  storyNlpEnabled: true, splitView: false, intelMode: "auto",
};

/** Load the app in a known state, with the canvas engine on or off. */
async function render(win, canvasOn) {
  const url = canvasOn ? BASE : `${BASE}${BASE.includes("?") ? "&" : "?"}lqg-canvas=0`;
  await win.loadURL(url);
  await wait(2500);
  await win.webContents.executeJavaScript(`(() => {
    localStorage.setItem("glass-editor:novel-v1", ${JSON.stringify(JSON.stringify(NOVEL))});
    localStorage.setItem("glass-editor:current-chapter-v1", "v1");
    localStorage.setItem("latentwrite:prefs-v1", ${JSON.stringify(JSON.stringify(PREFS))});
    return true;
  })()`);
  await win.loadURL(url);
  await wait(9000);

  // ★ SCROLL, so prose sits UNDER the toolbar. A glass surface over a blank
  //   page tests neither engine — the interesting case is text behind glass,
  //   and at rest the editor starts below the toolbar.
  await win.webContents.executeJavaScript(`(() => {
    const sc = [...document.querySelectorAll("*")].find((e) => e.scrollHeight > e.clientHeight + 80
      && /auto|scroll/.test(getComputedStyle(e).overflowY));
    if (sc) { sc.scrollTop = 120; return sc.className; }
    window.scrollTo(0, 120);
    return "window";
  })()`).catch(() => {});
  await wait(1200);

  // Freeze the animated layers so the diff measures the engines, not the orb.
  await win.webContents.executeJavaScript(`(() => {
    const s = document.createElement("style");
    s.textContent = "*,*::before,*::after{animation:none!important;transition:none!important}";
    document.head.appendChild(s);
    return true;
  })()`).catch(() => {});
  await wait(900);

  const surfaces = await win.webContents.executeJavaScript(`
    [...document.querySelectorAll(".liquid-glass, .analysis-tab, .analysis-action-group")]
      .filter((el) => { const r = el.getBoundingClientRect();
        return r.width > 8 && r.height > 8 && getComputedStyle(el).display !== "none"; })
      .map((el) => { const r = el.getBoundingClientRect();
        return { cls: (el.className||"").toString().split(/\\s+/).filter(Boolean).slice(0,2).join("."),
                 x: r.left, y: r.top, w: r.width, h: r.height,
                 claimed: el.hasAttribute("data-lqg-canvas") }; })`);
  return surfaces;
}

/** MAE over a bitmap pair, optionally only counting pixels OUTSIDE an inset. */
function compare(a, b, w, h, ring) {
  const A = a.toBitmap(), B = b.toBitmap();
  let sum = 0, max = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (ring) {
        const inside = x >= ring && y >= ring && x < w - ring && y < h - ring;
        if (inside) continue;                    // ring mode: only the border band
      }
      const i = (y * w + x) * 4;
      if (i + 2 >= A.length || i + 2 >= B.length) continue;
      const d = Math.max(
        Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
      sum += d; n++; if (d > max) max = d;
    }
  }
  return { mae: n ? sum / n : 0, max, n };
}

/** An 8x-amplified greyscale difference, as a PNG. */
function diffImage(a, b, w, h) {
  const { nativeImage } = require("electron");
  const A = a.toBitmap(), B = b.toBitmap();
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h * 4; i += 4) {
    const d = Math.min(255, 8 * Math.max(
      Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2])));
    out[i] = d; out[i + 1] = d; out[i + 2] = d; out[i + 3] = 255;
  }
  return nativeImage.createFromBitmap(out, { width: w, height: h }).toPNG();
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ width: 1512, height: 950, show: false });
  const suffix = process.env.THEME ? "-" + process.env.THEME : "";

  const onSurfaces = await render(win, true);
  const onFull = await win.capturePage();
  const onCrops = [];
  const PAD = 14;
  for (const s of onSurfaces) {
    onCrops.push(await win.capturePage({
      x: Math.max(0, Math.round(s.x - PAD)), y: Math.max(0, Math.round(s.y - PAD)),
      width: Math.round(s.w + PAD * 2), height: Math.round(s.h + PAD * 2),
    }));
  }
  fs.writeFileSync(path.join(OUT, `app-canvas${suffix}.png`), onFull.toPNG());

  const offSurfaces = await render(win, false);
  const offFull = await win.capturePage();
  const offCrops = [];
  for (const s of onSurfaces) {
    offCrops.push(await win.capturePage({
      x: Math.max(0, Math.round(s.x - PAD)), y: Math.max(0, Math.round(s.y - PAD)),
      width: Math.round(s.w + PAD * 2), height: Math.round(s.h + PAD * 2),
    }));
  }
  fs.writeFileSync(path.join(OUT, `app-svg${suffix}.png`), offFull.toPNG());

  console.log(`\ncanvas engine claimed ${onSurfaces.filter((s) => s.claimed).length}` +
    ` of ${onSurfaces.length} surfaces; with the kill switch, ` +
    `${offSurfaces.filter((s) => s.claimed).length} (must be 0)\n`);

  console.log("surface                       size        INSIDE mae/max     EDGE BAND mae/max");
  const results = [];
  for (let i = 0; i < onSurfaces.length; i++) {
    const s = onSurfaces[i];
    const a = onCrops[i], b = offCrops[i];
    const sa = a.getSize(), sb = b.getSize();
    if (sa.width !== sb.width || sa.height !== sb.height) {
      console.log(`${s.cls.padEnd(30)} size mismatch — layout moved between runs`);
      continue;
    }
    const all = compare(a, b, sa.width, sa.height, 0);
    const ring = compare(a, b, sa.width, sa.height, Math.round(PAD * 2 * 0.9));
    results.push({ s, all, ring });
    fs.writeFileSync(path.join(OUT, `${i}-${s.cls.split(".")[0]}-canvas${suffix}.png`), a.toPNG());
    fs.writeFileSync(path.join(OUT, `${i}-${s.cls.split(".")[0]}-svg${suffix}.png`), b.toPNG());
    // ★ AND THE DIFFERENCE ITSELF, amplified. Two plausible renders side by
    //   side hide WHERE they disagree; the difference image does not, and a
    //   structured shape in it (an edge, a band, a seam) is a defect while an
    //   even wash is just the two engines doing their job differently.
    fs.writeFileSync(
      path.join(OUT, `${i}-${s.cls.split(".")[0]}-diff${suffix}.png`),
      diffImage(a, b, sa.width, sa.height));
    console.log(`${s.cls.slice(0, 29).padEnd(30)} ${(Math.round(s.w) + "x" + Math.round(s.h)).padEnd(11)} ` +
      `${all.mae.toFixed(1).padStart(6)}/${String(all.max).padStart(4)}       ` +
      `${ring.mae.toFixed(1).padStart(6)}/${String(ring.max).padStart(4)}` +
      `${s.claimed ? "" : "   (declined — should be ~0)"}`);
  }

  const claimed = results.filter((r) => r.s.claimed);
  const declined = results.filter((r) => !r.s.claimed);
  console.log("\n━━ GATES ━━");
  let failed = 0;
  const gate = (label, cond, detail) => {
    console.log(`  ${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${detail}`}`);
    if (!cond) failed++;
  };
  gate("the kill switch actually disables the engine",
    offSurfaces.every((s) => !s.claimed),
    `${offSurfaces.filter((s) => s.claimed).length} still claimed with ?lqg-canvas=0`);
  gate("★ claimed surfaces DID change inside (else the engine is doing nothing)",
    claimed.length > 0 && claimed.some((r) => r.all.mae > 1),
    `inside mae: ${claimed.map((r) => r.all.mae.toFixed(1)).join(", ")}`);
  gate("★ the edge-glow band did NOT move",
    claimed.every((r) => r.ring.mae < 6),
    `band mae: ${claimed.map((r) => `${r.s.cls}=${r.ring.mae.toFixed(1)}`).join(", ")} ` +
    `— a big delta here means the stacking context changed and ::after is ` +
    `blending against something new`);
  gate("declined surfaces are untouched",
    declined.every((r) => r.all.mae < 2),
    `${declined.map((r) => `${r.s.cls}=${r.all.mae.toFixed(1)}`).join(", ")}`);

  console.log(`\nshots: ${OUT}`);
  console.log(failed ? `FAILED ${failed}` : `PASS`);
  app.exit(failed ? 1 : 0);
});
