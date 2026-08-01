/**
 * Dev-only harness: the REAL <GlassToggle/> driven by REAL pointer events,
 * with the REAL liquid-glass engine running.
 *
 * Every earlier harness simulated the component by flipping its classes on a
 * timer — i.e. it tested my MODEL of the component, which is exactly where the
 * bugs kept hiding. This mounts the shipping component and dispatches genuine
 * pointerdown/pointerup, so the timers, the state machine and the CSS are all
 * the real ones.
 *
 * Driven by scripts/verify-toggle-press.cjs. Not imported by the app.
 */

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { initLiquidGlassFilter } from "./lib/liquid-glass-filter";
import { GlassToggle } from "./components/GlassToggle";

const backdrop = document.getElementById("backdrop")!;
const stage = document.getElementById("stage")!;

document.body.style.margin = "0";
document.body.style.background = "#101014";

// Hostile, high-frequency, deterministic backdrop — refraction is only visible
// against detail.
Object.assign(backdrop.style, {
  position: "fixed",
  inset: "0",
  backgroundImage:
    "repeating-linear-gradient(90deg,#ff3b30 0 12px,#34c759 12px 24px,#0a84ff 24px 36px,#ffd60a 36px 48px)," +
    "repeating-linear-gradient(0deg,rgba(0,0,0,.55) 0 6px,rgba(255,255,255,.55) 6px 12px)",
  backgroundBlendMode: "overlay",
});

// The app's toggles live inside .settings-panel; several rules and the glass
// engine key off that ancestor, so the harness has to provide it.
stage.className = "settings-panel";
Object.assign(stage.style, { position: "fixed", left: "160px", top: "160px", padding: "40px" });

function Harness() {
  const [on, setOn] = useState(false);
  return <GlassToggle checked={on} onChange={setOn} ariaLabel="verify" />;
}

createRoot(stage).render(<StrictMode><Harness /></StrictMode>);
initLiquidGlassFilter();

interface W extends Window {
  __tap?: (downMs?: number) => void;
  __probe?: () => Record<string, unknown> | null;
}
const w = window as W;

const knob = () => document.querySelector<HTMLElement>(".glass-toggle-knob");
const btn = () => document.querySelector<HTMLElement>(".glass-toggle");

/** A genuine tap: pointerdown, then pointerup `downMs` later. Default 50ms is
 *  a normal human click — the case the knob must still fully expand on. */
w.__tap = (downMs = 50) => {
  const el = btn();
  if (!el) return;
  const r = el.getBoundingClientRect();
  const opts = {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse",
    button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
  };
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  window.setTimeout(() => {
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }, downMs);
};

w.__probe = () => {
  const k = knob();
  if (!k) return null;
  const cs = getComputedStyle(k);
  const m = cs.transform.match(/matrix\(([^)]+)\)/);
  return {
    scale: m ? parseFloat(m[1].split(",")[0]) : 1,
    left: parseFloat(cs.left) || 0,
    glass: k.classList.contains("liquid-glass-control-knob"),
    on: !!btn()?.classList.contains("glass-toggle--on"),
  };
};
