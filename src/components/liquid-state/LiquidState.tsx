/* LiquidState — what the model is doing, said with one body of liquid.
 *
 * Replaces the spinning six-oval OrbEngine in the three places the app waits on the
 * language model (the ask popover, the writing tool, the world dossier). The orb is
 * the app's IDENTITY and it belongs in the toolbar; a copy of it tinted blue and set
 * spinning is a spinner with better provenance. It says "working" and nothing else,
 * while the app already knows — and already prints in the label beside it — whether it
 * is reading the manuscript, reasoning, or writing.
 *
 * So this indicator says that instead:
 *
 *     idle       the app's own orb, unchanged — the real WebGL OrbEngine
 *     reading    one body sweeping the box, leaning into its own travel
 *     thinking   two dots taking turns jumping
 *     writing    a pen, drawing a line
 *
 * and the changes BETWEEN them are the crafted part: a tear that accelerates as the
 * neck snaps, a collision that squashes and throws a droplet. See choreography.ts.
 *
 * ── ENGINEERING NOTES ──────────────────────────────────────────────────────────────
 *
 * ★★ TWO LAYERS, AND THE HAND-OVER BETWEEN THEM IS THE CRAFT. The resting mark is the
 *    app's actual orb — a WebGL engine with a lens, a per-petal palette and per-channel
 *    dispersion — and no metaball is going to be that. So the orb keeps its own layer,
 *    and when work starts it SHRINKS AND BLURS INTO A DROPLET first. Only once it is a
 *    small soft blob, a shape the canvas can match exactly, does the canvas take over.
 *
 *    Both layers are driven from the SAME pose, on the same clock, so there is no
 *    second timeline to keep in step — `orbScale`, `orbBlur` and `orbAlpha` are pose
 *    channels like any other and are blended by the same windows.
 *
 *    ★ THE CANVAS IS REVEALED UNDER THE ORB AND ONLY THE ORB FADES. Two layers
 *      cross-fading at 50% cover 1 − 0.25 = 75% of the pixel, so a symmetric dissolve
 *      makes the mark visibly translucent for a moment every time work starts. Gated.
 *
 * ★ CANVAS, PER PIXEL, IN FLOAT for the working states. Not an SVG goo filter: a blur
 *   wide enough to merge two 6px dots is wider than the dots, and a thresholded blur's
 *   rim width is a function of its σ, so the outline inflates the moment anything
 *   moves. Blur is used in exactly one place here — the hand-over — because there it
 *   is the only thing that works.
 *
 * ★ THE POSE IS A PURE FUNCTION OF A CLOCK, so the component holds almost no state:
 *   a clock, an optional transition, and the last pose it painted. Everything that
 *   decides what a frame looks like lives in choreography.ts where a test can sample
 *   it without a browser.
 *
 * ★ INTERRUPTION IS FREE, because a transition starts from the pose that was ACTUALLY
 *   on screen. A merge interrupted by a split at 40% tears apart from wherever the
 *   dots had got to, not from a canonical two-dot pose — no queue, no replay, and no
 *   frame where the mass jumps.
 *
 * ★ IT STOPS WHEN NOBODY IS LOOKING. Hidden document, unfocused Electron window: the
 *   loop is cancelled, not throttled. It costs the same as the orb it replaced and it
 *   is in the same three surfaces, which are exactly the surfaces that are on screen
 *   while the machine is busy with a model.
 *
 * ★ REDUCED MOTION KEEPS THE MEANING. One still frame per state — two dots, or one
 *   body. The indicator stops performing; it does not stop speaking.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { OrbEngine } from "../orb/OrbEngine";
import { rasterise } from "./field";
import {
  DURATION, fieldOf, kindFor, loopPose, poseAt, staticPose,
  type LiquidStateName, type Motion, type Pose,
} from "./choreography";

export type { LiquidStateName };

interface Props {
  /** What the model is doing right now. */
  state: LiquidStateName;
  /** CSS pixels, square. 18 in the app's wait rows. */
  size?: number;
  /** The custom property to take the colour from. Resolved from the computed style of
   *  this element, so light/dark and any future override are inherited from the one
   *  place that defines them rather than restated here. */
  tint?: string;
  className?: string;
  style?: CSSProperties;
}

const PAUSED_BODY_CLASS = "electron-window-unfocused-orb-paused";

/** `rgb()/rgba()/#hex` → 0..255 rgb plus alpha. Null on anything else; the caller
 *  falls back rather than guessing at a colour. */
function parseCssColor(raw: string): { rgb: [number, number, number]; a: number } | null {
  const v = raw.trim();
  const m = v.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return { rgb: [parts[0], parts[1], parts[2]], a: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1 };
    }
  }
  const h = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (h) {
    const s = h[1];
    const w = s.length === 3
      ? [s[0] + s[0], s[1] + s[1], s[2] + s[2]]
      : [s.slice(0, 2), s.slice(2, 4), s.slice(4, 6)];
    return { rgb: [parseInt(w[0], 16), parseInt(w[1], 16), parseInt(w[2], 16)], a: 1 };
  }
  return null;
}

const FALLBACK = { rgb: [59, 130, 246] as [number, number, number], a: 0.88 };

export function LiquidState({ state, size = 18, tint = "--control-value-fill", className, style }: Props) {
  const hostRef = useRef<HTMLCanvasElement>(null);
  const orbRef = useRef<HTMLSpanElement>(null);
  /* The orb is a WebGL context, so it is mounted only while it has something to show —
   * three indicators each holding a context for a layer at zero opacity is three
   * contexts wasted, and browsers cap how many a page may have. */
  const [orbOn, setOrbOn] = useState(state === "idle");
  const orbOnRef = useRef(orbOn);
  /* The prop is read inside the loop rather than closed over, so a state change does
   * not tear down and rebuild the rAF loop — which would reset the clock and drop the
   * pose the transition has to start from. */
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const canvas = hostRef.current;
    if (!canvas) return;

    /* ★ AUTHOR AT THE DENSITY IT IS DISPLAYED AT. 18 CSS px at 3× is 54×54 = 2916
     *   pixels of field a frame; the whole point of painting this analytically is that
     *   the edges are exact at whatever density the screen actually has. Capped at 3
     *   because past that the cost doubles for a difference nothing can see. */
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    /* ★★ AND CAPPED IN ABSOLUTE PIXELS. Cost is (pixels × bodies), which at 18px is
     *    nothing and at a 150px specimen on a sheet is 450×450×7 — over a million
     *    distance evaluations a frame, in JavaScript, several of those on one page.
     *    That does not hold 60fps and visibly does not. The app never asks for more
     *    than 18, so the cap costs it nothing; a large specimen renders at 288 and is
     *    scaled up by under 2×, which on shapes made of smooth curves is invisible. */
    const px = Math.max(2, Math.min(Math.round(size * dpr), 288));
    canvas.width = px;
    canvas.height = px;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;
    const image = ctx.createImageData(px, px);
    const buf = image.data;

    const resolved = parseCssColor(getComputedStyle(canvas).getPropertyValue(tint)) ?? FALLBACK;

    const motionMq = window.matchMedia("(prefers-reduced-motion: reduce)");

    let raf = 0;
    let last = 0;
    let clock = 0;
    let current: LiquidStateName = stateRef.current;
    let motion: Motion | null = {
      from: null, to: current, kind: "enter",
      fromPose: loopPose(current, 0), elapsed: 0,
    };
    let painted: Pose = loopPose(current, 0);
    let reducedDrawn: LiquidStateName | null = null;

    const paint = (pose: Pose) => {
      painted = pose;
      /* Nothing to paint while the orb owns the mark, and nothing to read either — the
       * canvas is transparent, so the whole field evaluation is skipped. */
      if (pose.alpha > 0.002) {
        rasterise(buf, px, fieldOf(pose), resolved.rgb, resolved.a * pose.alpha);
        ctx.putImageData(image, 0, 0);
      }
      canvas.style.opacity = pose.alpha > 0.002 ? "1" : "0";

      const orb = orbRef.current;
      if (orb) {
        orb.style.transform = `scale(${pose.orbScale.toFixed(4)})`;
        orb.style.filter = pose.orbBlur > 0.01 ? `blur(${pose.orbBlur.toFixed(2)}px)` : "none";
        orb.style.opacity = pose.orbAlpha.toFixed(3);
      }
      const need = pose.orbAlpha > 0.002;
      if (need !== orbOnRef.current) {
        orbOnRef.current = need;
        setOrbOn(need);
      }
    };

    const paused = () => document.hidden || document.body.classList.contains(PAUSED_BODY_CLASS);

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (paused()) { last = now; return; }

      if (motionMq.matches) {
        /* One frame per state change, and nothing between. */
        if (reducedDrawn !== stateRef.current) {
          reducedDrawn = stateRef.current;
          paint(staticPose(reducedDrawn));
        }
        last = now;
        return;
      }
      reducedDrawn = null;

      /* A tab that was in the background hands back a huge delta; a clamp keeps a
       * resumed indicator from teleporting through half a cycle. */
      const dt = last === 0 ? 16 : Math.min(now - last, 64);
      last = now;

      if (stateRef.current !== current) {
        const kind = kindFor(current, stateRef.current);
        motion = { from: current, to: stateRef.current, kind, fromPose: painted, elapsed: 0 };
        current = stateRef.current;
        clock = 0;
      }

      if (motion) {
        motion.elapsed += dt;
        if (motion.elapsed >= DURATION[motion.kind]) {
          /* ★ THE HANDSHAKE. Every transition is authored to end exactly on its target
           *   loop's clock-zero pose, so the loop can take over on the next frame with
           *   the clock at zero and no settling step. Gated in test-liquid-state.ts. */
          motion = null;
          clock = 0;
        }
      } else {
        clock += dt;
      }

      paint(poseAt(current, clock, motion));
    };

    const onVisibility = () => { last = 0; };
    const bodyObserver = new MutationObserver(() => { last = 0; });
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    document.addEventListener("visibilitychange", onVisibility);
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      bodyObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    /* `state` is deliberately absent: it is read through stateRef so a change animates
     * instead of remounting the loop. Everything in the dep list changes the canvas's
     * backing store or its colour, and both of those DO need a rebuild. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, tint]);

  return (
    <span
      className={className ? `liquid-state-host ${className}` : "liquid-state-host"}
      style={{ width: size, height: size, ...style }}
      aria-hidden="true"
    >
      <canvas ref={hostRef} className="liquid-state" style={{ width: size, height: size }} />
      {orbOn && (
        <span ref={orbRef} className="liquid-state-orb">
          {/* ★ THE SAME PROPS THE WAIT ROWS PASS, not merely the same component.
              `analyzing` is the working motion, and flowScale/aberration are what make
              the app's blue orb look like the app's blue orb rather than like the
              toolbar's. Copied from MaxAskPopover / WritingToolPopover / WorldDataView,
              which all pass this exact set. */}
          <OrbEngine mode="default" analyzing size={size} flowScale={0.8} aberration={0.45} tint={tint} />
        </span>
      )}
    </span>
  );
}
