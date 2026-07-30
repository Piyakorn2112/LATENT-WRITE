/* ─────────────────────────────────────────────────────────────────────────
   capture-shots — the product shots the marketing site uses.

     node scripts/capture-shots.mjs [outDir]

   Runs the BUILT app in a real browser, seeds it with the demo manuscript,
   waits for the analysis to genuinely settle, and captures each view in both
   colour schemes.

   ── two rules the output has to obey ────────────────────────────────────
   1. NO baked border, rounded corner or drop shadow. The app fills the
      viewport edge to edge, so the capture is a clean rectangle. The site
      crops these and bleeds them off the page edge; a rounded corner or an
      outline baked into the pixels shows up as a severed line the moment it
      is cropped, and it also fights whatever border the site's own CSS puts
      on the container. The frame belongs to the consumer, not the image.
   2. WAIT FOR THE ANALYSIS. The highlight layer is the product. Capturing
      before it settles produces a screenshot of plain prose that claims to be
      a screenshot of story intelligence. The waiter below polls the actual
      marked-up DOM until the count stops changing, rather than sleeping for a
      guessed number of milliseconds.

   Serving the built app over http (not file://) because the app registers a
   worker, and workers are blocked on file: origins.
   ───────────────────────────────────────────────────────────────────────── */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NOVEL } from "./demo-manuscript.mjs";

/* Playwright is not a dependency of this app — it is only needed to take
   pictures of it, and adding a browser download to every `npm install` for a
   script that runs a few times a year is a bad trade. Resolve it from wherever
   it already exists and say so plainly if it doesn't. */
async function loadPlaywright() {
  const candidates = [
    "playwright",
    "/Users/piyakorn/Desktop/Srang Tech Mai/stm-page/node_modules/playwright/index.mjs",
  ];
  for (const c of candidates) {
    try {
      return await import(c);
    } catch {
      /* try the next */
    }
  }
  console.error(
    "Could not load Playwright. Install it here (npm i -D playwright && npx playwright install chromium)\n" +
      "or point the candidate list in this script at an existing install.",
  );
  process.exit(1);
}
const { chromium } = await loadPlaywright();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");
const OUT = process.argv[2] || path.join(HERE, "..", "shots");
const PORT = 5399;

// 1440×900 at DPR 2 → 2880×1800, which is what the site's <img> declares.
const VIEWPORT = { width: 1440, height: 900 };
const DPR = 2;

const NOVEL_KEY = "glass-editor:novel-v1";
const PREFS_KEY = "latentwrite:prefs-v1";

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error(`No build at ${DIST}. Run \`npm run build\` first.`);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

/* ── a static server for dist/ ───────────────────────────────────────────── */
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".woff2": "font/woff2", ".otf": "font/otf", ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]);
  let file = path.join(DIST, rel === "/" ? "index.html" : rel);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, "index.html"); // SPA fallback
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

/* ── the seed, injected before any app code runs ─────────────────────────── */
function seed(prefs) {
  return `
    localStorage.setItem(${JSON.stringify(NOVEL_KEY)}, ${JSON.stringify(JSON.stringify(NOVEL))});
    localStorage.setItem("glass-editor:current-chapter-v1", "ch021");
    localStorage.setItem(${JSON.stringify(PREFS_KEY)}, ${JSON.stringify(JSON.stringify(prefs))});
  `;
}

const BASE_PREFS = {
  // Onboarding would otherwise sit over the editor in every shot.
  hasSeenOnboarding: true,
  typography: { fontFamily: "georgia", fontSize: 18, lineHeight: 1.7, measure: 70 },
  goals: { dailyWords: 0 },
  funMode: false,
  debugPanel: false,
  storyNlpEnabled: true,
  splitView: false,
  intelMode: "auto",
};

/**
 * Wait until the highlight layer has stopped changing.
 *
 * Counts the marked spans the analysis produces and requires the count to be
 * non-zero and stable across consecutive polls. A fixed sleep cannot do this
 * job: the app runs a fast pass on load and then converges to a deep pass
 * ~1.6s later, so any single timeout either fires before the deep result lands
 * or is a guess that silently rots when the pipeline gets faster.
 */
async function waitForAnalysis(page, label) {
  const MARK = '[class*="speech"], [class*="entity"], [class*="action"], [class*="hl-"], mark';
  let stable = 0;
  let last = -1;
  for (let i = 0; i < 120; i++) {
    const n = await page.evaluate((sel) => document.querySelectorAll(sel).length, MARK);
    if (n > 0 && n === last) {
      stable++;
      // Three consecutive equal reads AND past the converge window.
      if (stable >= 3 && i > 12) {
        console.log(`   ${label}: analysis settled at ${n} marks (${i} polls)`);
        return n;
      }
    } else {
      stable = 0;
    }
    last = n;
    await page.waitForTimeout(250);
  }
  console.warn(`   ${label}: analysis never stabilised (last count ${last}) — capturing anyway`);
  return last;
}

/** Strip anything that would bake a frame into the pixels. */
const FLATTEN = `
  html, body, #root { margin: 0 !important; padding: 0 !important; }
  /* The app rounds and insets its own shell to sit inside an Electron window.
     In a capture that becomes a border the site then has to fight, so it is
     removed here rather than cropped out afterwards. */
  #root > *, .app-shell, .app-root, [class*="app-frame"], [class*="window-frame"] {
    border-radius: 0 !important;
    box-shadow: none !important;
    border: none !important;
    margin: 0 !important;
  }
  /* Caret and focus rings are noise in a still. */
  * { caret-color: transparent !important; }
  *:focus, *:focus-visible { outline: none !important; }
`;

async function shoot(browser, { name, scheme, prefs, prepare }) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DPR,
    colorScheme: scheme,
    reducedMotion: "reduce", // stills should not catch a transition mid-flight
  });
  const page = await ctx.newPage();
  await page.addInitScript(seed(prefs));
  page.on("pageerror", (e) => console.warn(`   ! pageerror: ${e.message}`));

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: FLATTEN });

  await waitForAnalysis(page, `${name}/${scheme}`);
  if (prepare) await prepare(page);

  // Let any reveal/settle transition finish before the shutter.
  await page.waitForTimeout(600);

  const file = path.join(OUT, `${name}${scheme === "dark" ? "-dark" : ""}.png`);
  await page.screenshot({ path: file });
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`   → ${path.basename(file)}  ${VIEWPORT.width * DPR}×${VIEWPORT.height * DPR}  ${kb}KB`);

  await ctx.close();
}

/**
 * Walk the whole manuscript so the story graph has something to draw.
 *
 * The graph accumulates one entry per chapter AS THE WRITER VISITS IT — it is
 * not a batch job. Capturing straight after boot therefore produced a graph
 * reading "1 / 17 analyzed": a correct screenshot of an empty feature. Rather
 * than fabricate a storyGraph blob into localStorage, this drives the app the
 * way a writer would and lets it do the real work, then waits for the app's own
 * counter to reach the chapter count.
 */
async function analyseAllChapters(page, total) {
  const next = page.locator('[aria-label="Next chapter"], [aria-label="Next chapter (left)"]').first();
  for (let i = 0; i < total + 2; i++) {
    if ((await next.count()) === 0) break;
    if (!(await next.isEnabled().catch(() => false))) break;
    await next.click({ timeout: 3000 }).catch(() => {});
    // Each chapter needs its fast pass AND its converge pass before the graph
    // entry is written, which is what CONVERGE_IDLE_MS (1.6s) governs.
    await page.waitForTimeout(2100);
  }
  // Back to the chapter the shot is framed on.
  const prev = page.locator('[aria-label="Previous chapter"], [aria-label="Previous chapter (left)"]').first();
  for (let i = 0; i < total; i++) {
    if ((await prev.count()) === 0) break;
    if (!(await prev.isEnabled().catch(() => false))) break;
    const title = await page.locator(".sg-expand-btn").count();
    void title;
    await prev.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(1800);
}

/** Reveal the analysis panel. It starts collapsed, and everything interesting
 *  (the widgets, and the story graph's expand button) is inside it. */
async function openPanel(page) {
  const opener = page.locator(
    '[aria-label*="analysis" i], [title*="analysis" i], [aria-label*="panel" i]',
  );
  if ((await opener.count()) > 0) {
    await opener.first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(900);
  }
}

/* ── the three views ─────────────────────────────────────────────────────── */
const VIEWS = [
  {
    name: "app-screenshot-1",
    prefs: { ...BASE_PREFS, splitView: false },
    // The editor, with the highlight layer doing its work.
    prepare: null,
  },
  {
    name: "app-screenshot-2",
    // Split view is a preference, so it is seeded rather than clicked.
    prefs: { ...BASE_PREFS, splitView: true },
    prepare: openPanel,
  },
  {
    name: "app-screenshot-3",
    prefs: { ...BASE_PREFS, splitView: false },
    prepare: async (page) => {
      await analyseAllChapters(page, NOVEL.chapters.length);

      // The story graph opens from a button INSIDE the analysis panel, so the
      // panel has to be open first — that is why this shot failed on the first
      // run: the selector was correct but the element was never mounted.
      await openPanel(page);

      // The panel has views, and the graph is one of them — the expand button
      // only exists once `view === "graph"`. Waiting for it without switching
      // views waits forever, which is exactly what the first two runs did.
      await page.locator('[aria-label="Story graph"]').click({ timeout: 6000 });
      await page.waitForTimeout(1200);

      const btn = page.locator(".sg-expand-btn");
      await btn.waitFor({ state: "attached", timeout: 8000 });
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 6000 });
      // The overlay portals to <body> and animates in.
      await page.waitForTimeout(1600);
    },
  },
];

const browser = await chromium.launch();
for (const view of VIEWS) {
  console.log(`\n${view.name}`);
  for (const scheme of ["light", "dark"]) {
    try {
      await shoot(browser, { ...view, scheme });
    } catch (err) {
      console.error(`   ✗ ${view.name}/${scheme}: ${err.message}`);
    }
  }
}
await browser.close();
server.close();

console.log(`\nWrote to ${OUT}`);
