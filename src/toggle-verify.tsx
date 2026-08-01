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
import { GlassRange } from "./components/GlassRange";

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
  const [v, setV] = useState(0.55);
  return (
    <>
      <GlassToggle checked={on} onChange={setOn} ariaLabel="verify" />
      {/* ★ The COLOUR-PICKER case: a slider whose track is a GRADIENT, not a
          flat colour. An element painted with a gradient reports
          `backgroundColor: transparent`, so the knob's backdrop reconstruction
          has to read background-IMAGE too or it paints nothing over the one
          control where the backdrop is the whole point. */}
      <div style={{ width: 220, marginTop: 28 }}>
        <GlassRange
          min={0} max={1} step={0.01} value={v} onChange={setV}
          enableGlass showFill={false} ariaLabel="verify gradient"
          className="gcp-slider"
          trackUnderlayStyle={{ background: "linear-gradient(to right, #000 0%, #ff3b30 100%)" }}
        />
      </div>
    </>
  );
}

createRoot(stage).render(<StrictMode><Harness /></StrictMode>);
initLiquidGlassFilter();

interface W extends Window {
  __tap?: (downMs?: number, pointerType?: string, wobblePx?: number) => void;
  __pressRange?: (down: boolean) => void;
  __press?: (down: boolean) => void;
  __click?: (holdMs?: number) => void;
  __reset?: () => void;
  __probe?: () => Record<string, unknown> | null;
}
const w = window as W;

const knob = () => document.querySelector<HTMLElement>(".glass-toggle-knob");
const btn = () => document.querySelector<HTMLElement>(".glass-toggle");

const pointerOpts = () => {
  const el = btn()!;
  const r = el.getBoundingClientRect();
  return {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse" as const,
    button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
  };
};

/** Hold or release the pointer — half a tap, for mid-press inspection. */
w.__press = (down) => {
  const el = btn();
  if (!el) return;
  const opts = pointerOpts();
  if (down) el.dispatchEvent(new PointerEvent("pointerdown", opts));
  else {
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }
};

/** A click with an explicit hold — __tap with the naming the press harness uses. */
w.__click = (holdMs = 50) => w.__tap!(holdMs);

/** Return the toggle to OFF and wait out any animation before the next scene. */
w.__reset = () => {
  const el = btn();
  if (el?.classList.contains("glass-toggle--on")) w.__tap!(10);
};

/** A genuine tap: pointerdown, then pointerup `downMs` later. Default 50ms is
 *  a normal human click — the case the knob must still fully expand on.
 *
 *  `wobblePx` simulates a FINGER: real touch contact drifts a few px between
 *  down and up, which is enough to cross the component's 4px drag threshold.
 *  A mouse tap wobbles 0; a thumb wobbles 5-10. */
w.__tap = (downMs = 50, pointerType = "mouse", wobblePx = 0) => {
  const el = btn();
  if (!el) return;
  const r = el.getBoundingClientRect();
  const opts = {
    bubbles: true, cancelable: true, pointerId: 1, pointerType,
    button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
  };
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  if (wobblePx) {
    window.setTimeout(() => {
      el.dispatchEvent(new PointerEvent("pointermove", { ...opts, clientX: opts.clientX + wobblePx }));
    }, Math.min(16, downMs / 2));
  }
  window.setTimeout(() => {
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0, clientX: opts.clientX + wobblePx }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }, downMs);
};

/** Press the gradient slider's knob, so its painted glass mounts. */
w.__pressRange = (down: boolean) => {
  const input = document.querySelector<HTMLElement>(".gcp-slider input[type=range]");
  if (!input) return;
  const r = input.getBoundingClientRect();
  const o = {
    bubbles: true, cancelable: true, pointerId: 2, pointerType: "mouse" as const,
    button: 0, buttons: down ? 1 : 0,
    clientX: r.left + r.width * 0.55, clientY: r.top + r.height / 2,
  };
  input.dispatchEvent(new PointerEvent(down ? "pointerdown" : "pointerup", o));
};

w.__probe = () => {
  const k = knob();
  if (!k) return null;
  // Remount detector: a CSS transition cannot survive the element being
  // recreated, so if this tag ever resets the "instant switch" is a REMOUNT.
  const tagged = k as HTMLElement & { __tag?: number };
  if (!tagged.__tag) tagged.__tag = performance.now();
  const cs = getComputedStyle(k);
  const m = cs.transform.match(/matrix\(([^)]+)\)/);
  const scale = m ? parseFloat(m[1].split(",")[0]) : 1;
  const r = k.getBoundingClientRect();
  return {
    tag: tagged.__tag,
    scale,
    left: parseFloat(cs.left) || 0,
    glass: k.classList.contains("liquid-glass-control-knob"),
    on: !!btn()?.classList.contains("glass-toggle--on"),
    transform: cs.transform,
    background: cs.backgroundColor,
    backdropFilter: cs.backdropFilter,
    layoutW: k.offsetWidth, layoutH: k.offsetHeight,
    paintedW: Math.round(r.width), paintedH: Math.round(r.height),
  };
};
