/**
 * Dev-only GPU benchmark for the edge-colour glow.
 *
 * Scene is sized to the app's real load: ~24 glass surfaces (what
 * scripts/test-edge-color-perf.ts models) over a colourful backdrop with ~60
 * colour sources, using the REAL initEdgeColor through its public options.
 *
 * The surfaces move every frame. That matters: the glow is event-driven, so
 * while idle its blurs are cached and cost nothing — the cost only appears when
 * something moves and each overlay's filter re-rasterises. Measuring a static
 * page would report zero and be worthless.
 *
 * Not imported by the app.
 */

import { initEdgeColor, type EdgeColorOptions } from "./lib/edge-color/edge-color";

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = params.get(k);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

const glowOn = params.get("glow") !== "off";
const surfaces = num("surfaces", 24);

const scene = document.getElementById("scene")!;
const W = window.innerWidth;
const H = window.innerHeight;

// ── Colourful backdrop ────────────────────────────────────────────────────
const HUES = [0, 28, 52, 96, 140, 190, 215, 265, 300, 330];
for (let i = 0; i < 14; i++) {
  const b = document.createElement("div");
  b.className = "block";
  const w = 180 + ((i * 97) % 220);
  const h = 150 + ((i * 137) % 260);
  Object.assign(b.style, {
    left: `${(i * 211) % Math.max(1, W - w)}px`,
    top: `${(i * 173) % Math.max(1, H - h)}px`,
    width: `${w}px`,
    height: `${h}px`,
    background: `hsl(${HUES[i % HUES.length]} 85% 52%)`,
  });
  scene.appendChild(b);
}

// ── Colour sources the glow indexes by geometry ───────────────────────────
for (let i = 0; i < 60; i++) {
  const s = document.createElement("span");
  s.className = "edge-color-src";
  s.textContent = "the quick brown fox";
  Object.assign(s.style, {
    left: `${(i * 163) % Math.max(1, W - 160)}px`,
    top: `${(i * 271) % Math.max(1, H - 20)}px`,
    color: `hsl(${HUES[i % HUES.length]} 90% 60%)`,
  });
  scene.appendChild(s);
}

// ── Glass surfaces ────────────────────────────────────────────────────────
interface Card { el: HTMLElement; x0: number; y0: number; ax: number; ay: number; ph: number }
const cards: Card[] = [];
for (let i = 0; i < surfaces; i++) {
  const el = document.createElement("div");
  el.className = "glass liquid-glass";
  // A spread of sizes, including a toolbar-scale one so the large-surface
  // opacity tier is exercised too.
  const big = i === 0;
  const w = big ? Math.min(1100, W - 80) : 120 + ((i * 83) % 260);
  const h = big ? 44 : 60 + ((i * 59) % 200);
  const x0 = big ? 40 : (i * 197) % Math.max(1, W - w - 20);
  const y0 = big ? 12 : (i * 149) % Math.max(1, H - h - 20);
  Object.assign(el.style, { width: `${w}px`, height: `${h}px`, left: `${x0}px`, top: `${y0}px` });
  scene.appendChild(el);
  cards.push({ el, x0, y0, ax: 18 + (i % 5) * 6, ay: 12 + (i % 3) * 7, ph: i * 0.7 });
}

// ── Glow ──────────────────────────────────────────────────────────────────
if (glowOn) {
  const opts: EdgeColorOptions = { selector: ".liquid-glass" };
  if (params.has("softness")) opts.softness = num("softness", 28);
  if (params.has("scale")) opts.resolutionScale = num("scale", 0.5);
  if (params.has("intensity")) opts.intensity = num("intensity", 1.3);
  if (params.has("rimIntensity")) opts.rimIntensity = num("rimIntensity", 1.2);
  if (params.has("rimBrightness")) opts.rimBrightness = num("rimBrightness", 1.7);
  if (params.has("maxSources")) opts.maxSources = num("maxSources", 8);
  initEdgeColor(opts);
}

// ── Move everything, and measure ──────────────────────────────────────────
const WINDOW_MS = 500;
const WINDOWS = 9;
const results: number[] = [];
let windowStart = 0;
let windowFrames = 0;
let started = false;
const hud = document.getElementById("hud")!;

function frame(now: number) {
  // Drive the surfaces. left/top (not transform) so the glow's geometry sync
  // and the glass's backdrop both genuinely change — a transform-only move can
  // be composited without re-running the filters, which would flatter the glow.
  const t = now * 0.001;
  for (const c of cards) {
    c.el.style.left = `${c.x0 + Math.cos(t + c.ph) * c.ax}px`;
    c.el.style.top = `${c.y0 + Math.sin(t * 0.8 + c.ph) * c.ay}px`;
  }

  if (!started) {
    if (now > 3000) { started = true; windowStart = now; windowFrames = 0; }
    requestAnimationFrame(frame);
    return;
  }

  windowFrames++;
  const elapsed = now - windowStart;
  if (elapsed >= WINDOW_MS) {
    const fps = (windowFrames * 1000) / elapsed;
    results.push(fps);
    hud.textContent = `${glowOn ? "glow" : "no glow"}: ${fps.toFixed(1)} fps [${results.length}/${WINDOWS}]`;
    windowStart = now;
    windowFrames = 0;
    if (results.length >= WINDOWS) {
      const kept = results.slice(1).sort((a, b) => a - b);
      const median = kept[kept.length >> 1];
      Object.assign(window as unknown as Record<string, unknown>, {
        __benchDone: true,
        __benchFps: median,
        __benchGlow: glowOn,
        __benchSurfaces: cards.length,
        __benchOverlays: document.querySelectorAll(".lqg-edge-color").length,
        __benchRims: document.querySelectorAll(".lqg-edge-rim").length,
      });
      hud.textContent = `median ${median.toFixed(1)} fps`;
      return;
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
