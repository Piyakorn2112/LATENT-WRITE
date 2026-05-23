/**
 * Per-element physics-based liquid-glass refraction filter.
 *
 *  • Per-element map sized to actual W×H so the bezel stays uniform on
 *    rectangular pills (not anisotropic as it would be with a stretched
 *    shared map).
 *  • All length values use userSpaceOnUse, so blur and displacement are
 *    fixed in absolute pixels — universal across panels.
 *  • Bezel shape is the SDF of a rounded rectangle matching the element's
 *    CSS border-radius. Refraction direction is the unit gradient of the
 *    SDF (correct curved-corner refraction).
 *  • Bezel height profile is the convex squircle h(t) = (1−(1−t)⁴)^¼.
 *
 *  Progressive blur: edges stay sharp so the rim refraction reads as a
 *  lens; interior crossfades into a stronger blur. The blur mix factor is
 *  baked into the displacement map's blue channel (the displacement map
 *  reads only R and G), then extracted via feColorMatrix and used to mask
 *  a blurred copy of the displaced backdrop. Single extra blur pass +
 *  three composite primitives — efficient on the GPU.
 *
 *  Performance: filter generation is deferred to requestIdleCallback so
 *  panel-open / chapter-switch animations are not blocked. Until the JS
 *  filter is ready, the CSS fallback (a uniform blur) shows.
 */

const SVG_ID = "lg-filter-svg";
const NS = "http://www.w3.org/2000/svg";
const SELECTOR = ".liquid-glass, .analysis-tab, .analysis-action-group";
const PAUSE_BODY_CLASSES = ["timeline-overlay-freeze", "renderer-workspace-freeze"];
const FAST_SCROLL_ADAPTIVE_ATTR = "data-liquid-glass-scroll-adaptive";

// ── Tunables ─────────────────────────────────────────────────────────────
//
// Map-generation tunables (BEZEL_PX, MAP_DIVISOR, refractive indices, the
// squircle profile, the SDF helper, and the progressive-blur mask params)
// live in `liquid-glass-worker.ts` — that's where the per-pixel math runs.
// Keep them in sync with the worker file when adjusting the look.

// Used by the SVG filter primitives below — feDisplacementMap.scale and
// feGaussianBlur.stdDeviation read these directly.
const DISP_PX = 40;        // max refraction shift, pixels
const BLUR_PX = 4;         // backdrop blur stdDeviation, pixels
const SATURATE = "1.8";

// Round (W, H, R) to this for cache key — sub-pixel differences do not
// produce a visually different filter and otherwise we'd build a new map
// on every resize-observer tick during animations.
const CACHE_GRID = 24;

// Internal rasterization resolution of the filter chain, as a fraction of
// element size. The GPU computes all 7 filter primitives at this reduced
// resolution and bilinearly upsamples the result. At 0.35 the compositor
// processes ~12% of the pixel count per frame — equivalent GPU savings to
// running at ~15fps on a 120Hz display, but without stutter because every
// frame still gets a freshly upsampled result. The existing blur (BLUR_PX)
// hides upscaling artifacts; refraction edges stay sharp because the bezel
// is already anti-aliased in the displacement map (MAP_DIVISOR=7).
const FILTER_RES_SCALE = 0.35;
const FILTER_RES_MIN   = 48;
const FILTER_RES_MAX   = 280;
const FAST_SCROLL_DELTA_THRESHOLD_PX = 24;
const FAST_SCROLL_HOLD_MS = 200;

// LRU cap so long-running sessions with varied panel sizes don't accrete
// hundreds of <filter> nodes in the DOM. Eviction also skips any filter
// currently bound to a live element (refcount > 0), so this cap only
// trims *unreferenced* sized variants. Toolbar, scroll edges, analysis tab,
// popovers, and focus button between them already use ~8 unique sizes;
// add resize jitter and the cap needs to be generous or the toolbar's
// in-use filter is evicted while the user resizes a popover textbox.
const FILTER_CACHE_LIMIT = 32;

// ── Smooth crossfade tunables ────────────────────────────────────────
// When fast-scrolling, panels crossfade from SVG filter to CSS blur via
// a brief opacity dip so the swap is masked by reduced visibility.
// Asymmetric timing: fast freeze (user wants to scroll NOW), slow thaw
// (luxurious return to full glass when scroll settles).
const CROSSFADE_DIM_MS          = 60;       // dim phase duration
const CROSSFADE_DIM_OPACITY     = 0.55;     // opacity at swap point
const CROSSFADE_REVEAL_MS       = 100;      // freeze reveal duration
const CROSSFADE_THAW_REVEAL_MS  = 200;      // thaw reveal (slower, elegant)

// ── Worker dispatch ──────────────────────────────────────────────────────

let worker: Worker | null = null;
let workerDead = false;
const pendingBlob = new Map<string, (blob: Blob) => void>();

function ensureWorker(): Worker | null {
  if (workerDead) return null;
  if (worker) return worker;
  try {
    worker = new Worker(
      new URL("./liquid-glass-worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent<{ id: string; blob: Blob }>) => {
      const { id, blob } = e.data;
      const resolver = pendingBlob.get(id);
      if (resolver) {
        pendingBlob.delete(id);
        resolver(blob);
      }
    };
    worker.onerror = (err) => {
      console.error("[liquid-glass] worker error:", err);
      workerDead = true;
      worker = null;
    };
    return worker;
  } catch (err) {
    console.warn("[liquid-glass] worker init failed, glass will use CSS fallback only:", err);
    workerDead = true;
    return null;
  }
}

let reqCounter = 0;
function buildMapInWorker(
  elemW: number,
  elemH: number,
  radius: number,
  overflow: number,
): Promise<string | null> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = `req-${++reqCounter}`;
    pendingBlob.set(id, (blob) => resolve(URL.createObjectURL(blob)));
    w.postMessage({ id, elemW, elemH, radius, overflow });
  });
}

// ── Filter generation / caching ──────────────────────────────────────────

interface CacheEntry {
  filter: SVGFilterElement;
  blobUrl: string | null;
  /** How many live elements currently set their backdrop-filter to this id. */
  refCount: number;
}

type FilterResolutionVariant = "base";

let svgRoot: SVGSVGElement | null = null;
let defs: SVGDefsElement | null = null;
const filterCache = new Map<string, CacheEntry>();
const inFlightFilter = new Map<string, Promise<string | null>>();

function ensureSvgRoot() {
  if (svgRoot) return;
  svgRoot = document.createElementNS(NS, "svg") as SVGSVGElement;
  svgRoot.id = SVG_ID;
  svgRoot.setAttribute("aria-hidden", "true");
  Object.assign(svgRoot.style, {
    position: "absolute",
    width: "0",
    height: "0",
    overflow: "hidden",
    pointerEvents: "none",
  });
  defs = document.createElementNS(NS, "defs") as SVGDefsElement;
  svgRoot.append(defs);
  document.body.prepend(svgRoot);
}

function snap(v: number): number {
  return Math.max(CACHE_GRID, Math.round(v / CACHE_GRID) * CACHE_GRID);
}

function createElNS(tag: string, attrs: Record<string, string>) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function clampRes(v: number): number {
  return Math.max(FILTER_RES_MIN, Math.min(FILTER_RES_MAX, Math.round(v)));
}

function filterResScale(_variant: FilterResolutionVariant): number {
  return FILTER_RES_SCALE;
}

function buildFilterEl(
  id: string,
  w: number,
  h: number,
  overflow: number,
  mapUrl: string,
  variant: FilterResolutionVariant,
): SVGFilterElement {
  const totalW = w + 2 * overflow;
  const totalH = h + 2 * overflow;
  const filter = createElNS("filter", {
    id,
    filterUnits: "userSpaceOnUse",
    primitiveUnits: "userSpaceOnUse",
    x: String(-overflow),
    y: String(-overflow),
    width: String(totalW),
    height: String(totalH),
    "color-interpolation-filters": "sRGB",
    filterRes: `${clampRes(totalW * filterResScale(variant))} ${clampRes(totalH * filterResScale(variant))}`,
  }) as SVGFilterElement;

  filter.append(
    // Displacement map is sized to the full filter region. The overflow
    // margin is pre-baked as neutral grey (128,128,128,A=255 with mask=0)
    // so the previous feFlood + feComposite(over) pair is no longer
    // needed — saves two primitives per frame.
    createElNS("feImage", {
      href: mapUrl,
      x: String(-overflow),
      y: String(-overflow),
      width: String(w + 2 * overflow),
      height: String(h + 2 * overflow),
      preserveAspectRatio: "none",
      result: "dispMap",
    }),
    createElNS("feDisplacementMap", {
      in: "SourceGraphic",
      in2: "dispMap",
      // scale × 0.5 = max pixel shift, so scale = DISP_PX × 2.
      scale: String(DISP_PX * 2),
      xChannelSelector: "R",
      yChannelSelector: "G",
      result: "displaced",
    }),
    createElNS("feGaussianBlur", {
      in: "displaced",
      stdDeviation: String(BLUR_PX),
      result: "blurred",
    }),
    // Extract the B channel of the displacement-map image as alpha. Matrix
    // sets RGB to white and copies B → A. Result is a white-on-mask image
    // whose alpha is the blur mix factor at every pixel.
    createElNS("feColorMatrix", {
      in: "dispMap",
      type: "matrix",
      values: "0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 1 0 0",
      result: "blurMask",
    }),
    // Centre region: blurred * mask  (mask=1 in centre, 0 at rim).
    createElNS("feComposite", {
      in: "blurred",
      in2: "blurMask",
      operator: "in",
      result: "centerBlur",
    }),
    // Rim region: displaced * (1 − mask)  (sharp where mask=0).
    createElNS("feComposite", {
      in: "displaced",
      in2: "blurMask",
      operator: "out",
      result: "edgeSharp",
    }),
    // Combine: arithmetic add. Both inputs are pre-multiplied by mask /
    // 1−mask so summing reconstructs lerp(displaced, blurred, mask).
    createElNS("feComposite", {
      in: "centerBlur",
      in2: "edgeSharp",
      operator: "arithmetic",
      k1: "0",
      k2: "1",
      k3: "1",
      k4: "0",
      result: "progressive",
    }),
    createElNS("feColorMatrix", {
      in: "progressive",
      type: "saturate",
      values: SATURATE,
    }),
  );

  return filter;
}

function evictLRU() {
  if (filterCache.size <= FILTER_CACHE_LIMIT) return;

  // Walk from oldest to newest. Skip:
  //   · entries currently referenced by a live element (refcount > 0) —
  //     removing their <filter> node would break the existing backdrop-filter
  //     url(#id) on that element. Toolbars/panels that don't resize would
  //     otherwise lose their glass when a popover resize storm filled the cache.
  //   · the newest entry — it was just created and is about to be bound by
  //     the caller, so its refcount is still 0 only because the bind is one
  //     statement away.
  const ids = [...filterCache.keys()];
  const newestId = ids[ids.length - 1];
  for (const id of ids) {
    if (filterCache.size <= FILTER_CACHE_LIMIT) break;
    if (id === newestId) continue;
    const entry = filterCache.get(id);
    if (!entry || entry.refCount > 0) continue;
    filterCache.delete(id);
    entry.filter.remove();
    if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
  }
}

// Async because the displacement map is generated in a Web Worker — heavy
// SDF + Snell math + PNG encode all run off the main thread, so panel-open
// and chapter-switch animations don't block on filter generation. The CSS
// fallback blur shows until this resolves.
async function ensureFilter(
  elemW: number,
  elemH: number,
  radius: number,
  variant: FilterResolutionVariant,
): Promise<string | null> {
  ensureSvgRoot();
  const w = snap(elemW);
  const h = snap(elemH);
  const r = snap(radius);
  const id = `lg-${w}-${h}-${r}-${variant}`;

  const cached = filterCache.get(id);
  if (cached) {
    filterCache.delete(id);
    filterCache.set(id, cached);
    return id;
  }

  // Dedupe concurrent requests for the same id.
  const existing = inFlightFilter.get(id);
  if (existing) return existing;

  const promise = (async () => {
    const overflow = DISP_PX + BLUR_PX * 2 + 4;
    const mapUrl = await buildMapInWorker(w, h, r, overflow);
    if (!mapUrl) return null;

    const filter = buildFilterEl(id, w, h, overflow, mapUrl, variant);
    defs!.append(filter);
    filterCache.set(id, { filter, blobUrl: mapUrl, refCount: 0 });
    evictLRU();
    inFlightFilter.delete(id);
    return id;
  })();

  inFlightFilter.set(id, promise);
  return promise;
}

// ── Per-element attachment ───────────────────────────────────────────────

const observed = new WeakMap<Element, ResizeObserver>();
const lastSize = new WeakMap<Element, string>();
const elementSchedule = new WeakMap<HTMLElement, () => void>();
const trackedElements = new Set<HTMLElement>();
// Tracks which filter id each live element is currently pointing at, so we
// can decrement the previous filter's refcount when an element re-binds to
// a new size's filter (and on detach).
const elementFilterId = new WeakMap<Element, string>();
let glassPaused = false;
let fastScrollActive = false;
let fastScrollResetHandle: number | null = null;

const frozenElements = new Set<HTMLElement>();
const CSS_BLUR_FALLBACK = `blur(${BLUR_PX}px) saturate(${SATURATE})`;
const crossfadeTimers = new WeakMap<HTMLElement, number>();

function shouldPauseLiquidGlass(): boolean {
  const body = document.body;
  return !!body && PAUSE_BODY_CLASSES.some((className) => body.classList.contains(className));
}

function isFastScrollAdaptiveElement(element: Element): boolean {
  return element.hasAttribute(FAST_SCROLL_ADAPTIVE_ATTR);
}

function normalizedWheelDelta(event: WheelEvent): number {
  const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? Math.max(window.innerHeight * 0.85, 320)
      : 1;
  return (Math.abs(event.deltaX) + Math.abs(event.deltaY)) * scale;
}

const PANEL_CROSSFADE_ENABLED = false;

function setFastScrollActive(nextActive: boolean) {
  if (fastScrollActive === nextActive) return;
  fastScrollActive = nextActive;
  document.body.classList.toggle("glass-fast-scroll", nextActive);
  if (PANEL_CROSSFADE_ENABLED) {
    for (const element of trackedElements) {
      if (!isFastScrollAdaptiveElement(element)) continue;
      if (nextActive) smoothFreeze(element);
      else smoothThaw(element);
    }
  }
}

function observeElement(element: HTMLElement, schedule: () => void) {
  if (observed.has(element)) return;
  const ro = new ResizeObserver(schedule);
  ro.observe(element);
  observed.set(element, ro);
}

function pauseAllGlassWork() {
  for (const element of trackedElements) {
    const ro = observed.get(element);
    if (!ro) continue;
    ro.disconnect();
    observed.delete(element);
  }
}

function resumeAllGlassWork() {
  for (const element of trackedElements) {
    const schedule = elementSchedule.get(element);
    if (!schedule) continue;
    observeElement(element, schedule);
    schedule();
  }
}

function syncLiquidGlassPauseState() {
  const nextPaused = shouldPauseLiquidGlass();
  if (nextPaused === glassPaused) return;
  glassPaused = nextPaused;
  if (glassPaused) pauseAllGlassWork();
  else resumeAllGlassWork();
}

function bindFilter(element: Element, newId: string) {
  const prevId = elementFilterId.get(element);
  if (prevId === newId) return;
  if (prevId) {
    const prev = filterCache.get(prevId);
    if (prev && prev.refCount > 0) prev.refCount--;
  }
  const next = filterCache.get(newId);
  if (next) next.refCount++;
  elementFilterId.set(element, newId);
}

function unbindFilter(element: Element) {
  const prevId = elementFilterId.get(element);
  if (!prevId) return;
  const prev = filterCache.get(prevId);
  if (prev && prev.refCount > 0) prev.refCount--;
  elementFilterId.delete(element);
}

function readRadius(el: Element): number {
  const cs = getComputedStyle(el);
  // Use top-left as representative; mixed-corner radii are rare here.
  const tl = parseFloat(cs.borderTopLeftRadius || "0");
  return isFinite(tl) ? tl : 0;
}

// ── Smooth crossfade ─────────────────────────────────────────────────
// Opacity-dip technique: briefly dim the panel (compositor-only, free),
// swap the backdrop-filter while dimmed so the visual jump is masked,
// then brighten back. No dual-filter overlap, no extra DOM layers.

function cancelCrossfade(element: HTMLElement) {
  const t = crossfadeTimers.get(element);
  if (t !== undefined) window.clearTimeout(t);
  crossfadeTimers.delete(element);
  element.style.transition = "";
  element.style.opacity = "";
}

function smoothFreeze(element: HTMLElement) {
  cancelCrossfade(element);
  if (frozenElements.has(element)) return;
  frozenElements.add(element);
  const ro = observed.get(element);
  if (ro) { ro.disconnect(); observed.delete(element); }

  element.style.transition = `opacity ${CROSSFADE_DIM_MS}ms ease-out`;
  requestAnimationFrame(() => {
    element.style.opacity = String(CROSSFADE_DIM_OPACITY);
    crossfadeTimers.set(element, window.setTimeout(() => {
      element.style.setProperty("backdrop-filter", CSS_BLUR_FALLBACK);
      element.style.setProperty("-webkit-backdrop-filter", CSS_BLUR_FALLBACK);
      element.style.transition = `opacity ${CROSSFADE_REVEAL_MS}ms ease-in`;
      element.style.opacity = "1";
      crossfadeTimers.set(element, window.setTimeout(() => {
        element.style.transition = "";
        crossfadeTimers.delete(element);
      }, CROSSFADE_REVEAL_MS));
    }, CROSSFADE_DIM_MS));
  });
}

function smoothThaw(element: HTMLElement) {
  cancelCrossfade(element);
  if (!frozenElements.has(element)) return;

  element.style.transition = `opacity ${CROSSFADE_DIM_MS}ms ease-out`;
  requestAnimationFrame(() => {
    element.style.opacity = String(CROSSFADE_DIM_OPACITY);
    crossfadeTimers.set(element, window.setTimeout(() => {
      frozenElements.delete(element);
      const filterId = elementFilterId.get(element);
      if (filterId) {
        const ref = `url(#${filterId})`;
        element.style.setProperty("backdrop-filter", ref);
        element.style.setProperty("-webkit-backdrop-filter", ref);
      }
      const schedule = elementSchedule.get(element);
      if (schedule) observeElement(element, schedule);
      element.style.transition = `opacity ${CROSSFADE_THAW_REVEAL_MS}ms ease-in`;
      element.style.opacity = "1";
      crossfadeTimers.set(element, window.setTimeout(() => {
        element.style.transition = "";
        crossfadeTimers.delete(element);
      }, CROSSFADE_THAW_REVEAL_MS));
    }, CROSSFADE_DIM_MS));
  });
}

// ── Idle scheduling ──────────────────────────────────────────────────────
// Kicks off the worker request during browser idle time so filter generation
// is doubly non-blocking (idle dispatch + worker compute).
type IdleHandle = number;
const idleSchedule: (cb: () => void) => IdleHandle =
  typeof (globalThis as any).requestIdleCallback === "function"
    ? ((cb) =>
        (globalThis as any).requestIdleCallback(cb, { timeout: 200 }) as IdleHandle)
    : ((cb) => requestAnimationFrame(cb) as IdleHandle);

function applyTo(element: HTMLElement) {
  if (elementSchedule.has(element)) return;

  trackedElements.add(element);

  let scheduled = false;
  const update = async () => {
    scheduled = false;
    if (glassPaused) return;
    if (frozenElements.has(element)) return;
    // offsetWidth/Height return layout size, ignoring CSS transforms — so
    // scale animations don't trigger filter rebuilds.
    const w = element.offsetWidth;
    const h = element.offsetHeight;
    if (w < 4 || h < 4) return;
    const r = readRadius(element);
    const key = `${snap(w)}-${snap(h)}-${snap(r)}-base`;
    if (lastSize.get(element) === key) return;
    lastSize.set(element, key);
    const id = await ensureFilter(w, h, r, "base");
    if (!id) return; // worker dead → CSS fallback stays
    if (glassPaused) return;
    if (lastSize.get(element) !== key) return;
    bindFilter(element, id);
    if (!frozenElements.has(element)) {
      const ref = `url(#${id})`;
      element.style.setProperty("backdrop-filter", ref);
      element.style.setProperty("-webkit-backdrop-filter", ref);
    }
  };

  const schedule = () => {
    if (glassPaused) {
      scheduled = false;
      return;
    }
    if (scheduled) return;
    scheduled = true;
    idleSchedule(update);
  };

  elementSchedule.set(element, schedule);
  if (glassPaused) return;

  schedule();
  observeElement(element, schedule);
}

function unobserve(el: Element) {
  const ro = observed.get(el);
  if (ro) {
    ro.disconnect();
    observed.delete(el);
    lastSize.delete(el);
  }
  cancelCrossfade(el as HTMLElement);
  frozenElements.delete(el as HTMLElement);
  trackedElements.delete(el as HTMLElement);
  elementSchedule.delete(el as HTMLElement);
  unbindFilter(el);
}

function isGlassEl(el: Element): boolean {
  return typeof el.matches === "function" && el.matches(SELECTOR);
}

function scan(root: ParentNode) {
  if (root instanceof Element && isGlassEl(root)) applyTo(root as HTMLElement);
  root.querySelectorAll?.(SELECTOR).forEach((el) => applyTo(el as HTMLElement));
}

export function initLiquidGlassFilter(): void {
  if (document.getElementById(SVG_ID)) return;

  const startup = () => {
    ensureSvgRoot();
    scan(document.body);
    syncLiquidGlassPauseState();

    const mo = new MutationObserver((muts) => {
      for (const mut of muts) {
        if (mut.type === "childList") {
          mut.addedNodes.forEach((n) => {
            if (n.nodeType === 1) scan(n as Element);
          });
          mut.removedNodes.forEach((n) => {
            if (n.nodeType !== 1) return;
            const el = n as Element;
            if (isGlassEl(el)) unobserve(el);
            el.querySelectorAll?.(SELECTOR).forEach(unobserve);
          });
        } else if (mut.type === "attributes" && mut.target instanceof Element) {
          const el = mut.target;
          if (isGlassEl(el)) {
            if (!trackedElements.has(el as HTMLElement)) applyTo(el as HTMLElement);
          } else if (trackedElements.has(el as HTMLElement)) {
            unobserve(el);
          }
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

    const bodyClassObserver = new MutationObserver(() => {
      syncLiquidGlassPauseState();
    });
    bodyClassObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });

    window.addEventListener("wheel", (event) => {
      if (glassPaused) return;
      if (normalizedWheelDelta(event) < FAST_SCROLL_DELTA_THRESHOLD_PX) return;
      setFastScrollActive(true);
      if (fastScrollResetHandle !== null) window.clearTimeout(fastScrollResetHandle);
      fastScrollResetHandle = window.setTimeout(() => {
        fastScrollResetHandle = null;
        setFastScrollActive(false);
      }, FAST_SCROLL_HOLD_MS);
    }, { passive: true });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startup, { once: true });
  } else {
    startup();
  }
}
