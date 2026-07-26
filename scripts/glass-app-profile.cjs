/**
 * Real-GPU budget breakdown of the running app.
 *
 * Loads the actual editor (not a synthetic scene) in a visible,
 * hardware-accelerated window with vsync off, then measures steady-state frame
 * rate while switching individual effects off one at a time. The delta is that
 * effect's real share of the frame.
 *
 * Why ablate in the live app rather than benchmark a mock: the app never rests
 * (the intelligence orb, the toolbar ambient pulse and the mesh dots animate
 * continuously), so it repaints every frame on its own — and every effect is
 * layered over every other, which is exactly the interaction a mock loses. A
 * synthetic scene reported the edge-colour glow as free because 24 glass
 * backdrop-filters swamped it and run-to-run noise exceeded the effect.
 *
 *   npm run dev                        # in another shell
 *   node scripts/glass-app-profile.cjs
 *
 * Each row is measured by injecting CSS that disables one effect. Nothing is
 * written to disk and the app is untouched.
 */

const { app, BrowserWindow } = require("electron");

const URL_ = process.env.APP_PROFILE_URL || "http://localhost:5173/";

app.commandLine.appendSwitch("disable-gpu-vsync");
app.commandLine.appendSwitch("disable-frame-rate-limit");
app.commandLine.appendSwitch("force-device-scale-factor", "1");

// Extra ablations from the CLI, as "label=css" pairs, so a hypothesis can be
// tested without editing this file.
const CLI = process.argv.slice(2).filter((a) => a.includes("=")).map((a) => {
  const i = a.indexOf("=");
  return [a.slice(0, i), a.slice(i + 1)];
});

// [label, css]. "" = baseline (nothing disabled).
const ABLATIONS = CLI.length ? [["baseline (everything on)", ""], ...CLI] : [
  ["baseline (everything on)", ""],
  ["edge-colour glow off", ".lqg-edge-color,.lqg-edge-rim{display:none!important}"],
  ["  · glow BODY only off", ".lqg-edge-color{display:none!important}"],
  ["  · glow RIM only off", ".lqg-edge-rim{display:none!important}"],
  ["intel orb mesh blur off", ".intel-mesh-dot{filter:none!important}"],
  ["intel orb hidden", ".intel-orb-live{display:none!important}"],
  ["orb backglow off (all 3)", ".orb-backglow-bloom,.orb-backglow-spectral,.orb-backglow-orb{display:none!important}"],
  ["  · backglow BLOOM only", ".orb-backglow-bloom{display:none!important}"],
  ["  · backglow SPECTRAL only", ".orb-backglow-spectral{display:none!important}"],
  ["  · backglow ORB only", ".orb-backglow-orb{display:none!important}"],
  ["  · backglow: drop filters, keep", ".orb-backglow-bloom,.orb-backglow-spectral,.orb-backglow-orb{filter:none!important}"],
  ["toolbar ambient off", ".toolbar-ambient-orb{display:none!important}"],
  ["scroll-edge strips off", ".scroll-edge-top-strip,.scroll-edge-right-strip{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}"],
  ["glass backdrop-filter off", ".liquid-glass,.analysis-tab,.analysis-action-group,.liquid-glass-control-knob,.liquid-glass-lens{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}"],
  ["glass edge glow (::after) off", ".liquid-glass::after,.analysis-tab::after{display:none!important}"],
  ["ALL of the above off", [
    ".lqg-edge-color,.lqg-edge-rim{display:none!important}",
    ".intel-orb-live{display:none!important}",
    ".orb-backglow-bloom,.orb-backglow-spectral,.orb-backglow-orb{display:none!important}",
    ".toolbar-ambient-orb{display:none!important}",
    ".scroll-edge-top-strip,.scroll-edge-right-strip{backdrop-filter:none!important}",
    ".liquid-glass,.analysis-tab,.analysis-action-group,.liquid-glass-control-knob,.liquid-glass-lens{backdrop-filter:none!important}",
    ".liquid-glass::after,.analysis-tab::after{display:none!important}",
  ].join("")],
];

const MEASURE = `
  (css) => new Promise((res) => {
    let tag = document.getElementById("__ablate");
    if (!tag) { tag = document.createElement("style"); tag.id = "__ablate"; document.head.appendChild(tag); }
    tag.textContent = css;
    // Let the compositor re-layerise, then measure several windows and take the
    // median so a stray long frame does not set the result.
    setTimeout(() => {
      const wins = []; let n = 0; let t0 = performance.now(); let start = t0;
      function tick(now) {
        n++;
        if (now - t0 >= 400) { wins.push((n * 1000) / (now - t0)); n = 0; t0 = now; }
        if (wins.length >= 8) {
          const kept = wins.slice(1).sort((a, b) => a - b);
          res({ fps: kept[kept.length >> 1] });
          return;
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }, 700);
  })
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: true, useContentSize: true,
    backgroundColor: "#101014", webPreferences: { backgroundThrottling: false },
  });

  await win.loadURL("data:text/html,<html><body></body></html>");
  const gpu = app.getGPUFeatureStatus();
  if (String(gpu.gpu_compositing).includes("software")) {
    console.log("⚠ software compositing — refusing to report; these would not be GPU numbers");
    win.destroy(); app.exit(2); return;
  }
  console.log(`GPU compositing: ${gpu.gpu_compositing}`);

  // Skip onboarding so the profile covers the editor, which is what users look
  // at. localStorage is per-origin, so this must run ON the app's origin — the
  // blank data: URL above is a different origin and writing there does nothing.
  await win.loadURL(URL_);
  await win.webContents.executeJavaScript(`
    localStorage.setItem("latentwrite:prefs-v1", JSON.stringify({ hasSeenOnboarding: true }));
  `).catch(() => {});
  await win.reload();
  await new Promise((r) => setTimeout(r, 8000));

  const state = await win.webContents.executeJavaScript(`({
    onboarding: !!document.querySelector("[class*=onboard]"),
    glass: document.querySelectorAll(".liquid-glass,.analysis-tab").length,
    glowBody: document.querySelectorAll(".lqg-edge-color").length,
    glowRim: document.querySelectorAll(".lqg-edge-rim").length,
    blurred: [...document.querySelectorAll("*")].filter(e => (getComputedStyle(e).filter||"").includes("blur")).length,
    backdrops: [...document.querySelectorAll("*")].filter(e => { const b = getComputedStyle(e).backdropFilter; return b && b !== "none"; }).length,
  })`);
  console.log(`scene: onboarding=${state.onboarding} glass=${state.glass} ` +
              `glow=${state.glowBody}body+${state.glowRim}rim blurred=${state.blurred} backdrops=${state.backdrops}\n`);

  console.log("effect disabled                      fps    ms/frame   its cost   share");
  console.log("─".repeat(76));

  let baseMs = null;
  let floorMs = null;
  const rows = [];
  for (const [label, css] of ABLATIONS) {
    const r = await win.webContents.executeJavaScript(`(${MEASURE})(${JSON.stringify(css)})`);
    const ms = 1000 / r.fps;
    if (baseMs === null) baseMs = ms;
    if (label.startsWith("ALL")) floorMs = ms;
    const cost = baseMs - ms; // ms/frame this effect was costing
    rows.push({ label, ms, fps: r.fps, cost });
    console.log(
      `${label.padEnd(34)} ${r.fps.toFixed(0).padStart(5)} ${ms.toFixed(2).padStart(9)}ms ` +
      (label.includes("baseline") ? "        —          —" :
        `${cost.toFixed(2).padStart(9)}ms ${((cost / baseMs) * 100).toFixed(0).padStart(5)}%`),
    );
  }
  console.log("─".repeat(76));
  if (floorMs !== null) {
    console.log(`total effect budget: ${baseMs.toFixed(2)}ms -> ${floorMs.toFixed(2)}ms floor ` +
                `(${(baseMs - floorMs).toFixed(2)}ms, ${(((baseMs - floorMs) / baseMs) * 100).toFixed(0)}% of the frame)`);
  }
  console.log("'its cost' = ms/frame recovered by turning that one effect off.");
  win.destroy();
  app.exit(0);
});
