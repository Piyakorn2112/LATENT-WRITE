/**
 * probe-app-toggle.cjs — tap a REAL toggle in the REAL APP and watch the knob.
 *
 * The isolated component glides (verify-toggle-tap.cjs, 27 frames, mouse and
 * touch). The owner sees an instant left/right switch in the app. So the bug,
 * if it reproduces, lives in the APP CONTEXT — remount, prefs round-trip,
 * something above the component. This boots the full renderer, opens the
 * analysis panel's settings tab, taps the first toggle it finds with genuine
 * PointerEvents, and samples scale/left/node-identity every frame.
 *
 *   VITE_URL=http://localhost:5178 node_modules/electron/cli.js scripts/probe-app-toggle.cjs
 */

const { app, BrowserWindow } = require("electron");
const BASE = process.env.VITE_URL || "http://localhost:5178";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false });
  // Skip onboarding so the editor mounts directly.
  await win.loadURL(BASE);
  await win.webContents.executeJavaScript(
    `localStorage.setItem("latentwrite:prefs-v1", JSON.stringify({ hasSeenOnboarding: true }))`);
  await win.loadURL(BASE);
  await wait(3500);

  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // Open the settings view of the analysis panel.
    const tab = document.querySelector('button[aria-label="Analysis settings"]');
    if (!tab) return { error: "settings tab not found" };
    tab.click();
    await wait(800);

    const toggles = [...document.querySelectorAll('.glass-toggle')];
    if (!toggles.length) return { error: "no .glass-toggle in the app after opening settings" };
    const tg = toggles.find((t) => !t.classList.contains('glass-toggle--on')) || toggles[0];
    tg.scrollIntoView({ block: 'center' });
    await wait(300);

    const knob = () => tg.querySelector('.glass-toggle-knob');
    const k0 = knob(); k0.__tag = 1;
    const read = () => {
      const k = knob();
      const cs = getComputedStyle(k);
      const m = cs.transform.match(/matrix\\(([^)]+)\\)/);
      return {
        s: m ? parseFloat(m[1].split(',')[0]) : 1,
        l: parseFloat(cs.left) || 0,
        sameNode: k.__tag === 1,
        cls: tg.className,
      };
    };

    const r = tg.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
      button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const out = []; const t0 = performance.now();
    tg.dispatchEvent(new PointerEvent('pointerdown', opts));
    setTimeout(() => {
      tg.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
      tg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }, 60);
    await new Promise((res) => { const tick = () => {
      const t = performance.now() - t0;
      out.push({ t, ...read() });
      if (t < 900) requestAnimationFrame(tick); else res();
    }; requestAnimationFrame(tick); });
    return { label: tg.getAttribute('aria-label'), frames: out };
  })()`);

  if (result.error) { console.error("PROBE ERROR:", result.error); app.exit(2); return; }

  const s = result.frames;
  const lFrom = s[0].l, lTo = s[s.length - 1].l;
  const travel = Math.abs(lTo - lFrom);
  const gliding = s.filter((p) =>
    Math.abs(p.l - lFrom) > travel * 0.05 && Math.abs(p.l - lTo) > travel * 0.05).length;
  const peak = Math.max(...s.map((p) => p.s));
  const remount = s.find((p) => !p.sameNode);
  console.log(`\nreal app, toggle "${result.label}":`);
  console.log(`  slide ${lFrom.toFixed(0)} -> ${lTo.toFixed(0)}px  (travel ${travel.toFixed(0)}px)`);
  console.log(`  gliding frames: ${gliding}`);
  console.log(`  peak scale: ${peak.toFixed(3)}`);
  console.log(`  knob remounted: ${remount ? "YES at " + Math.round(remount.t) + "ms" : "no"}`);
  const firstMoved = s.find((p) => Math.abs(p.l - lFrom) > travel * 0.05);
  console.log(`  left first moved at: ${firstMoved ? Math.round(firstMoved.t) + "ms" : "-"}`);
  // Print a compact curve for eyeballing.
  const line = s.filter((_, i) => i % 4 === 0).map((p) => `${Math.round(p.t)}:${p.l.toFixed(0)}/${p.s.toFixed(2)}`).join("  ");
  console.log(`  t:left/scale  ${line}`);

  // ★ GATES — this is the harness that caught what the isolated component
  // harness structurally could not: the app-level cascade. The knob must
  // GLIDE (`.app .liquid-glass-control-knob` in a transition-shorthand group
  // once replaced its whole transition list and it teleported), stay the SAME
  // NODE, and still reach full swell.
  const fails = [];
  if (travel < 10) fails.push(`knob barely travelled (${travel.toFixed(0)}px) — did the tap register?`);
  if (gliding < 6) fails.push(`slide SNAPPED (${gliding} gliding frames) — the left transition is dead in the app cascade`);
  if (remount) fails.push(`knob remounted at ${Math.round(remount.t)}ms — no transition survives that`);
  if (peak < 1.98) fails.push(`press swell only reached ${peak.toFixed(3)}`);
  console.log("");
  if (!fails.length) console.log("PASS — the knob glides, swells and stays the same node inside the real app.");
  else for (const f of fails) console.log(`FAIL — ${f}`);
  app.exit(fails.length ? 1 : 0);
});
