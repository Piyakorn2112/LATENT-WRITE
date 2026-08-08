/**
 * Dev-only GPU benchmark for the liquid-glass engine.
 *
 * Measures STEADY-STATE compositor cost, which is the thing that actually
 * competes with the app's frame budget: a backdrop-filter is only re-rasterised
 * when its backdrop changes, so an animating canvas sits behind the glass and
 * dirties it every frame (the same situation as text scrolling under a panel).
 *
 * Run via scripts/glass-gpu-bench.cjs — it needs a REAL GPU and vsync disabled,
 * otherwise every configuration reports the display refresh rate and the
 * comparison is meaningless.
 *
 * Not imported by the app.
 */

import { initLiquidGlassFilter } from "./lib/liquid-glass-filter";

interface Spec {
  cls: string;
  w: number;
  h: number;
  r: number;
  x: number;
  y: number;
  style?: Partial<CSSStyleDeclaration>;
}

// The app's real surfaces, at the sizes styles.css lays them out.
const TOOLBAR: Spec = { cls: "liquid-glass toolbar", w: 1100, h: 44, r: 22, x: 40, y: 16 };
const TAB: Spec = { cls: "liquid-glass analysis-tab", w: 160, h: 36, r: 18, x: 40, y: 80 };
const PILL: Spec = { cls: "liquid-glass status-pill", w: 120, h: 28, r: 14, x: 220, y: 84 };
const POPOVER: Spec = { cls: "liquid-glass annotation-popover", w: 320, h: 180, r: 14, x: 400, y: 80 };
const PANEL: Spec = { cls: "liquid-glass annotation-panel", w: 300, h: 420, r: 16, x: 760, y: 80 };
const SETTINGS: Spec = { cls: "liquid-glass settings-panel", w: 420, h: 520, r: 18, x: 40, y: 140 };
const RANGE_KNOB: Spec = { cls: "glass-range-knob liquid-glass-control-knob", w: 20, h: 14, r: 999, x: 500, y: 300 };
const TOGGLE_KNOB: Spec = { cls: "glass-toggle-knob liquid-glass-control-knob", w: 32, h: 24, r: 999, x: 540, y: 296 };
const LENS: Spec = {
  cls: "liquid-glass-lens", w: 100, h: 100, r: 50, x: 600, y: 400,
  style: { transform: "translate(-50%, -50%) scale(7)", opacity: "1" },
};
// The lens as the app actually leaves it when NOT loading: still in the DOM,
// still carrying a generated backdrop-filter, but fully transparent.
const LENS_HIDDEN: Spec = {
  ...LENS,
  style: { transform: "translate(-50%, -50%) scale(7)", opacity: "0" },
};

const SCENES: Record<string, Spec[]> = {
  // Chrome that is on screen essentially all the time.
  idle: [TOOLBAR, TAB, PILL],
  // Chrome plus an open analysis panel — the common working state.
  working: [TOOLBAR, TAB, PILL, PANEL, POPOVER],
  // Settings open, with its two live control knobs.
  settings: [TOOLBAR, TAB, PILL, SETTINGS, RANGE_KNOB, TOGGLE_KNOB],
  // Everything at once — worst case.
  all: [TOOLBAR, TAB, PILL, PANEL, POPOVER, SETTINGS, RANGE_KNOB, TOGGLE_KNOB],
  // Isolated surfaces, to price each one on its own.
  toolbar: [TOOLBAR],
  panel: [PANEL],
  popover: [POPOVER],
  panelPopover: [PANEL, POPOVER],
  settingsPanelOnly: [SETTINGS],
  knobs: [RANGE_KNOB, TOGGLE_KNOB],
  lens: [LENS],
  lensHidden: [LENS_HIDDEN],
  none: [],
};

const params = new URLSearchParams(location.search);
const sceneName = params.get("scene") || "working";
const glassOff = params.get("glass") === "off";
const specs = SCENES[sceneName] ?? SCENES.working;

// ── Animating backdrop ────────────────────────────────────────────────────
// Must change every frame or the compositor caches the filtered output and the
// benchmark measures nothing. Deliberately cheap to draw (a few fills) so the
// number reflects the FILTER cost, not the canvas cost.
const canvas = document.getElementById("bg") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
function sizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
sizeCanvas();

function drawBackdrop(t: number) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = "#101014";
  ctx.fillRect(0, 0, w, h);
  // High-contrast moving bars: forces a real re-filter and is trivial to draw.
  const n = 14;
  for (let i = 0; i < n; i++) {
    const p = ((i / n) + t * 0.00006) % 1;
    ctx.fillStyle = `hsl(${(i * 27) % 360} 90% 55%)`;
    ctx.fillRect(p * w - 40, 0, 80, h);
  }
  ctx.fillStyle = "#fff";
  for (let i = 0; i < 10; i++) {
    const y = ((i / 10) + t * 0.00004) % 1;
    ctx.fillRect(0, y * h, w, 2);
  }
}

// ── Mount ─────────────────────────────────────────────────────────────────
const host = document.getElementById("specimens")!;
for (const spec of specs) {
  const el = document.createElement("div");
  el.className = `spec ${spec.cls}`;
  el.style.left = `${spec.x}px`;
  el.style.top = `${spec.y}px`;
  el.style.width = `${spec.w}px`;
  el.style.height = `${spec.h}px`;
  el.style.borderRadius = `${spec.r}px`;
  if (spec.style) Object.assign(el.style, spec.style);
  host.appendChild(el);
}

if (!glassOff) initLiquidGlassFilter();

// ── Measure ───────────────────────────────────────────────────────────────
// With vsync off, achieved frame rate is GPU-bound, so it prices the filter
// chain directly. Report the median of several windows to blunt scheduler noise.
const WINDOW_MS = 500;
const WINDOWS = 9;
const results: number[] = [];
let windowStart = 0;
let windowFrames = 0;
let started = false;
const hud = document.getElementById("hud")!;

function frame(now: number) {
  drawBackdrop(now);

  if (!started) {
    // Let the engine bind every filter (idle callback + worker round-trip)
    // before timing, or the first window measures the CSS fallback instead.
    const bound = glassOff
      ? specs.length
      : (Array.from(host.children) as HTMLElement[])
          .filter((e) => e.style.backdropFilter.startsWith("url(")).length;
    if (bound >= specs.length && now > 2500) {
      started = true;
      windowStart = now;
      windowFrames = 0;
    }
    requestAnimationFrame(frame);
    return;
  }

  windowFrames++;
  const elapsed = now - windowStart;
  if (elapsed >= WINDOW_MS) {
    const fps = (windowFrames * 1000) / elapsed;
    results.push(fps);
    hud.textContent = `${sceneName}${glassOff ? " (glass off)" : ""}: ${fps.toFixed(1)} fps  [${results.length}/${WINDOWS}]`;
    windowStart = now;
    windowFrames = 0;
    if (results.length >= WINDOWS) {
      // Drop the first window (ramp-up), take the median of the rest.
      const kept = results.slice(1).sort((a, b) => a - b);
      const median = kept[kept.length >> 1];
      const w = Object.assign(window as unknown as Record<string, unknown>, {
        __benchDone: true,
        __benchScene: sceneName,
        __benchGlass: !glassOff,
        __benchFps: median,
        __benchAll: results,
        __benchCount: specs.length,
      });
      void w;
      hud.textContent = `${sceneName}: median ${median.toFixed(1)} fps`;
      return;
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
