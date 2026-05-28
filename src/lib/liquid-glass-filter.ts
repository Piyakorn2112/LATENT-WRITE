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
const SELECTOR = ".liquid-glass, .analysis-tab, .analysis-action-group, .liquid-glass-control-knob";
const PAUSE_BODY_CLASSES = ["timeline-overlay-freeze", "renderer-workspace-freeze", "electron-window-unfocused", "scroll-edge-idle"];

// ── Tunables ─────────────────────────────────────────────────────────────
//
// Map-generation tunables (BEZEL_PX, MAP_DIVISOR, refractive indices, the
// squircle profile, the SDF helper, and the progressive-blur mask params)
// live in `liquid-glass-worker.ts` — that's where the per-pixel math runs.
// Keep them in sync with the worker file when adjusting the look.

// Used by the SVG filter primitives below — feDisplacementMap.scale and
// feGaussianBlur.stdDeviation read these directly.
const DISP_PX = 30;        // max refraction shift, pixels
const BLUR_DEFAULT = 4;    // backdrop blur for unclassified elements, pixels
const SATURATE = "1.8";

// Round (W, H, R) to this for cache key — sub-pixel differences do not
// produce a visually different filter and otherwise we'd build a new map
// on every resize-observer tick during animations.
const CACHE_GRID = 1;

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

// ── Worker dispatch ──────────────────────────────────────────────────────

let worker: Worker | null = null;
let workerDead = false;
const pendingBlob = new Map<string, (blob: Blob) => void>();
type MapPreset = "default" | "control-knob" | "toggle-control-knob";

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
  preset: MapPreset,
): Promise<string | null> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = `req-${++reqCounter}`;
    pendingBlob.set(id, (blob) => resolve(URL.createObjectURL(blob)));
    w.postMessage({ id, elemW, elemH, radius, overflow, preset });
  });
}

// ── Filter generation / caching ──────────────────────────────────────────

interface CacheEntry {
  filter: SVGFilterElement;
  blobUrl: string | null;
  /** How many live elements currently set their backdrop-filter to this id. */
  refCount: number;
}

const TRANSIENT_GLASS_ATTR = "data-liquid-glass-transient";

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

function clampRes(v: number, min = FILTER_RES_MIN): number {
  return Math.max(min, Math.round(v));
}

function readBlur(el: Element): number {
  if (el.classList.contains("liquid-glass-control-knob")) return 0;
  if (el.matches(".glass-range-knob, .glass-toggle-knob")) return 0;
  if (el.classList.contains("toolbar")) return 2;
  if (el.classList.contains("settings-panel")) return 5;
  if (el.matches(".analysis-tab, .analysis-action-group")) return 1;
  if (el.classList.contains("status-pill")) return 2;
  if (el.matches(".annotation-popover, .annotation-panel")) return 2;
  return BLUR_DEFAULT;
}

// Sync note: These blur values also need to match the CSS idle-state fallback
// overrides in styles.css (body.scroll-edge-idle rules). When updating blur
// values here, verify the corresponding CSS rules apply the same blur px value.

function readMapPreset(el: Element): MapPreset {
  if (el.classList.contains("glass-toggle-knob") && el.classList.contains("liquid-glass-control-knob")) {
    return "toggle-control-knob";
  }
  return el.classList.contains("liquid-glass-control-knob") ? "control-knob" : "default";
}

function readDispMapAntialias(preset: MapPreset): number {
  if (preset === "control-knob") return 0.55;
  if (preset === "toggle-control-knob") return 0.48;
  return 0;
}

function readFilterResConfig(preset: MapPreset): { scale: number; min: number } {
  if (preset === "control-knob" || preset === "toggle-control-knob") {
    return { scale: 2, min: 160 };
  }
  return { scale: FILTER_RES_SCALE, min: FILTER_RES_MIN };
}

function buildFilterEl(
  id: string,
  w: number,
  h: number,
  overflow: number,
  mapUrl: string,
  blur: number,
  preset: MapPreset,
): SVGFilterElement {
  const totalW = w + 2 * overflow;
  const totalH = h + 2 * overflow;
  const displacementScale = DISP_PX * 2;
  const dispMapAntialias = readDispMapAntialias(preset);
  const dispMapInput = dispMapAntialias > 0 ? "dispMapAA" : "dispMap";
  const filterRes = readFilterResConfig(preset);
  const filter = createElNS("filter", {
    id,
    filterUnits: "userSpaceOnUse",
    primitiveUnits: "userSpaceOnUse",
    x: String(-overflow),
    y: String(-overflow),
    width: String(totalW),
    height: String(totalH),
    "color-interpolation-filters": "sRGB",
    filterRes: `${clampRes(totalW * filterRes.scale, filterRes.min)} ${clampRes(totalH * filterRes.scale, filterRes.min)}`,
  }) as SVGFilterElement;

  filter.append(
    createElNS("feImage", {
      href: mapUrl,
      x: String(-overflow),
      y: String(-overflow),
      width: String(w + 2 * overflow),
      height: String(h + 2 * overflow),
      preserveAspectRatio: "none",
      result: "dispMap",
    }),
  );

  if (dispMapAntialias > 0) {
    filter.append(
      createElNS("feGaussianBlur", {
        in: "dispMap",
        stdDeviation: String(dispMapAntialias),
        edgeMode: "duplicate",
        result: "dispMapAA",
      }),
    );
  }

  filter.append(
    createElNS("feDisplacementMap", {
      in: "SourceGraphic",
      in2: dispMapInput,
      scale: String(displacementScale),
      xChannelSelector: "R",
      yChannelSelector: "G",
      result: "displaced",
    }),
  );

  filter.append(
    createElNS("feGaussianBlur", {
      in: "displaced",
      stdDeviation: String(blur),
      result: "blurred",
    }),
    createElNS("feColorMatrix", {
      in: "blurred",
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

function cleanupFilterNow(id: string) {
  const entry = filterCache.get(id);
  if (!entry || entry.refCount > 0) return;
  filterCache.delete(id);
  entry.filter.remove();
  if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
}

// Async because the displacement map is generated in a Web Worker — heavy
// SDF + Snell math + PNG encode all run off the main thread, so panel-open
// and chapter-switch animations don't block on filter generation. The CSS
// fallback blur shows until this resolves.
async function ensureFilter(
  elemW: number,
  elemH: number,
  radius: number,
  blur: number,
  preset: MapPreset,
): Promise<string | null> {
  ensureSvgRoot();
  const w = snap(elemW);
  const h = snap(elemH);
  const r = snap(radius);
  const id = `lg-${preset}-${w}-${h}-${r}-b${blur}`;

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
    const overflow = DISP_PX + blur * 2 + 4;
    const mapUrl = await buildMapInWorker(w, h, r, overflow, preset);
    if (!mapUrl) return null;

    const filter = buildFilterEl(id, w, h, overflow, mapUrl, blur, preset);
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

function shouldPauseLiquidGlass(): boolean {
  const body = document.body;
  return !!body && PAUSE_BODY_CLASSES.some((className) => body.classList.contains(className));
}

function normalizedWheelDelta(event: WheelEvent): number {
  const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? Math.max(window.innerHeight * 0.85, 320)
      : 1;
  return (Math.abs(event.deltaX) + Math.abs(event.deltaY)) * scale;
}

function setFastScrollActive(nextActive: boolean) {
  if (fastScrollActive === nextActive) return;
  fastScrollActive = nextActive;
  document.body.classList.toggle("glass-fast-scroll", nextActive);
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
    if (element instanceof HTMLElement && element.getAttribute(TRANSIENT_GLASS_ATTR) === "true") {
      cleanupFilterNow(prevId);
    }
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
  if (element instanceof HTMLElement && element.getAttribute(TRANSIENT_GLASS_ATTR) === "true") {
    cleanupFilterNow(prevId);
  }
  elementFilterId.delete(element);
}

function readRadius(el: Element): number {
  const cs = getComputedStyle(el);
  // Use top-left as representative; mixed-corner radii are rare here.
  const tl = parseFloat(cs.borderTopLeftRadius || "0");
  return isFinite(tl) ? tl : 0;
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
    // offsetWidth/Height return layout size, ignoring CSS transforms — so
    // scale animations don't trigger filter rebuilds.
    const w = element.offsetWidth;
    const h = element.offsetHeight;
    if (w < 4 || h < 4) return;
    const r = readRadius(element);
    const blur = readBlur(element);
    const preset = readMapPreset(element);
    const key = `${preset}-${snap(w)}-${snap(h)}-${snap(r)}-b${blur}`;
    if (lastSize.get(element) === key) return;
    lastSize.set(element, key);
    const id = await ensureFilter(w, h, r, blur, preset);
    if (!id) return; // worker dead → CSS fallback stays
    if (glassPaused) return;
    if (lastSize.get(element) !== key) return;
    bindFilter(element, id);
    const ref = `url(#${id})`;
    element.style.setProperty("backdrop-filter", ref);
    element.style.setProperty("-webkit-backdrop-filter", ref);
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
  trackedElements.delete(el as HTMLElement);
  elementSchedule.delete(el as HTMLElement);
  unbindFilter(el);
  if (el instanceof HTMLElement) {
    el.style.removeProperty("backdrop-filter");
    el.style.removeProperty("-webkit-backdrop-filter");
  }
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
