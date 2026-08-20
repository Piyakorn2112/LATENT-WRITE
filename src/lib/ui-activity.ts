/**
 * ui-activity.ts — is the writer touching the app right now?
 *
 * One signal, owned in one place, so background work can stay off the screen
 * while the screen is being used.
 *
 * ★★ WHY THIS EXISTS, MEASURED. With the chip and summary tick running against
 *    the full-screen timeline, the app delivers 116.1 fps against 120.0 idle
 *    and 120.1 idle again (drift 0.1 fps) — but 69 frames in forty seconds
 *    land over 25ms, worst 58ms, where an idle window has none at all. That is
 *    not the model decoding: driving the same request bytes at the same
 *    concurrency straight at the engine, with the app scrolling beside it,
 *    costs nothing (120.5 fps, GPU pegged at 98%). It is the cost of the tick
 *    existing in the same renderer at the same moment.
 *
 *    None of that work is urgent. Chips and summaries are convergence: they
 *    will run again, they have no deadline, and nobody is waiting for them.
 *    The cheapest possible fix is therefore not to make them faster but to
 *    move them to a moment when the writer is not looking.
 *
 * ★ SCROLL AND POINTER ARE LISTENED FOR IN THE CAPTURE PHASE, so a handler
 *   that stops propagation cannot hide the writer from this. `pointermove` is
 *   throttled: it fires per frame during a drag and marking a timestamp
 *   sixty times a second to learn one bit is its own small waste.
 *
 * ★ PASSIVE, EVERY ONE OF THEM. This module must never be the reason a scroll
 *   waits on JavaScript — it exists to protect frames.
 */

/** The event types that mean "the writer is doing something with the screen". */
const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "wheel",
  "scroll",
  "keydown",
  "touchstart",
] as const;

/** Marking more often than this buys nothing; a drag fires every frame. */
const POINTER_THROTTLE_MS = 100;

let lastActivity = 0;
let listening = 0;
let lastPointerMark = 0;

function mark(event: Event): void {
  if (event.type === "pointermove") {
    const now = performance.now();
    if (now - lastPointerMark < POINTER_THROTTLE_MS) return;
    lastPointerMark = now;
  }
  lastActivity = performance.now();
}

/**
 * Begin tracking. Reference counted, so several callers may start it and the
 * listeners are only removed when the last one stops.
 */
export function startActivityTracking(): () => void {
  if (typeof window === "undefined") return () => {};
  if (listening === 0) {
    // Treat mount as activity: the app has just appeared in front of someone.
    lastActivity = performance.now();
    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, mark, { capture: true, passive: true });
    }
  }
  listening++;
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    listening--;
    if (listening === 0) {
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, mark, { capture: true });
      }
    }
  };
}

/** Milliseconds since the writer last did anything. Infinity before tracking. */
export function msSinceActivity(): number {
  if (typeof window === "undefined" || lastActivity === 0) return Infinity;
  return performance.now() - lastActivity;
}

/**
 * Has the screen been still for `ms`?
 *
 * ★ AN UNFOCUSED OR HIDDEN WINDOW IS QUIET BY DEFINITION, whatever the last
 *   event was — the writer is somewhere else and no frame of ours is being
 *   looked at. Without this a window blurred mid-scroll would read as busy
 *   forever, and background work would never resume.
 */
export function isQuiet(ms: number): boolean {
  if (typeof document !== "undefined" && (document.hidden || !document.hasFocus())) return true;
  return msSinceActivity() >= ms;
}

/** Test seam: pretend the writer just did something. */
export function __markActivityForTest(): void {
  lastActivity = performance.now();
}
/** Test seam: pretend the screen has been still forever. */
export function __clearActivityForTest(): void {
  lastActivity = 0;
}
