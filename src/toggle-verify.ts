/**
 * Dev-only harness: the REAL toggle knob, over a hostile backdrop, with the
 * REAL liquid-glass engine running — so the press can be inspected as the
 * writer actually sees it.
 *
 * Why this exists: scripts/verify-toggle-motion.cjs loads styles.css onto a
 * bare page with no React and no liquid-glass-filter.ts. It proved the
 * transform curve three times over while the thing that actually looked wrong
 * was the MATERIAL — the refraction the engine paints into the knob, which
 * that harness could not see at all. A feedback loop that cannot observe the
 * symptom is not a feedback loop.
 *
 * Driven by scripts/verify-toggle-press.cjs.
 * Not imported by the app.
 */

import "./styles.css";
import { initLiquidGlassFilter } from "./lib/liquid-glass-filter";

const backdrop = document.getElementById("backdrop")!;
const stage = document.getElementById("stage")!;

document.body.style.margin = "0";
document.body.style.background = "#101014";

// Hostile, high-frequency, DETERMINISTIC backdrop: refraction is only visible
// against detail, and a flat fill would hide every material bug there is.
Object.assign(backdrop.style, {
  position: "fixed",
  inset: "0",
  backgroundImage:
    "repeating-linear-gradient(90deg,#ff3b30 0 12px,#34c759 12px 24px,#0a84ff 24px 36px,#ffd60a 36px 48px)," +
    "repeating-linear-gradient(0deg,rgba(0,0,0,.55) 0 6px,rgba(255,255,255,.55) 6px 12px)",
  backgroundBlendMode: "overlay",
});

// The exact DOM GlassToggle renders, so the engine dispatches on the same
// classes and sizes the same displacement map.
const btn = document.createElement("button");
btn.className = "glass-toggle";
btn.id = "tg";
btn.setAttribute("role", "switch");
const knob = document.createElement("span");
knob.className = "glass-toggle-knob liquid-glass-control-knob";
knob.id = "kn";
btn.appendChild(knob);

Object.assign(stage.style, {
  position: "fixed",
  left: "160px",
  top: "160px",
  // The app's toggles live inside .settings-panel; the engine and several CSS
  // rules key off that ancestor, so the harness has to provide it.
  padding: "40px",
});
stage.className = "settings-panel";
stage.appendChild(btn);

initLiquidGlassFilter();

// Driver hooks. Class flipping mirrors GlassToggle's own state exactly.
interface PressWindow extends Window {
  __press?: (on: boolean) => void;
  __click?: (hold: number) => void;
  __reset?: () => void;
  __probe?: () => Record<string, unknown>;
}
const w = window as PressWindow;

w.__press = (on: boolean) => {
  btn.classList.toggle("glass-toggle--pressed", on);
};

/**
 * A FULL CLICK, timed exactly as GlassToggle drives it, because the thing
 * being judged is a SEQUENCE — expand, slide while expanded, then shrink —
 * and testing the three moves separately can never show whether they overlap
 * correctly.
 *
 *   t=0    pointerdown  -> --pressed  (knob expands, 300ms)
 *   t=50   pointerup    -> --on       (knob slides, 340ms) and the shrink is
 *                                      scheduled for MIN_PRESS_MS
 *   t=hold              -> --pressed removed (knob shrinks, 240ms)
 */
w.__click = (hold: number) => {
  btn.classList.remove("glass-toggle--on");
  btn.classList.add("glass-toggle--pressed");
  window.setTimeout(() => btn.classList.add("glass-toggle--on"), 50);
  window.setTimeout(() => btn.classList.remove("glass-toggle--pressed"), hold);
};

w.__reset = () => {
  btn.classList.remove("glass-toggle--on", "glass-toggle--pressed");
};

w.__probe = () => {
  const cs = getComputedStyle(knob);
  const r = knob.getBoundingClientRect();
  return {
    // What the ENGINE applied, not what the stylesheet asked for.
    backdropFilter:
      cs.backdropFilter || (cs as unknown as Record<string, string>).webkitBackdropFilter,
    transform: cs.transform,
    background: cs.backgroundColor,
    // Layout box vs painted box: the displacement map is built from the
    // LAYOUT size, so if these diverge under scale the material is stretched.
    layoutW: knob.offsetWidth,
    layoutH: knob.offsetHeight,
    paintedW: Math.round(r.width),
    paintedH: Math.round(r.height),
    dpr: window.devicePixelRatio,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
  };
};
