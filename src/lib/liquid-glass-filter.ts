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
 *  Progressive blur: the worker bakes a rim-sharp → interior-blurred mix
 *  factor into the displacement map's BLUE channel (feDisplacementMap itself
 *  reads only R and G). Note that the current filter chain does not consume
 *  it — the blur below is applied uniformly to the displaced backdrop, and
 *  the blue channel survives only because it also keeps the map's bilinear
 *  sampling well-behaved at the rim (see the pre-fill in the worker). An
 *  earlier revision extracted it via feColorMatrix to mask a blurred copy;
 *  that is gone. Do not describe the chain as progressive-blurring.
 *
 *  Chain: feImage(map) → [feGaussianBlur(map AA, knobs only)] →
 *         feDisplacementMap → [feGaussianBlur(blur)] → [feColorMatrix(sat)]
 *  The bracketed passes are omitted when they would be identity transforms,
 *  since an identity pass still costs a full filter-region raster per frame.
 *
 *  Performance: filter generation is deferred to requestIdleCallback so
 *  panel-open / chapter-switch animations are not blocked. Until the JS
 *  filter is ready, the CSS fallback (a uniform blur) shows. The per-pixel
 *  map math lives in the worker — see its header for the cost structure and
 *  for the two harnesses that prove a change is pixel-identical.
 */

const SVG_ID = "lg-filter-svg";
const NS = "http://www.w3.org/2000/svg";
const SELECTOR = ".liquid-glass, .analysis-tab, .analysis-action-group, .liquid-glass-control-knob, .liquid-glass-lens";
const PAUSE_BODY_CLASSES = ["timeline-overlay-freeze", "renderer-workspace-freeze", "electron-window-unfocused", "scroll-edge-idle"];

// ── Tunables ─────────────────────────────────────────────────────────────
//
// Map-generation tunables (BEZEL_PX, MAP_DIVISOR, refractive indices, the
// squircle profile, the SDF helper, and the progressive-blur mask params)
// live in `liquid-glass-worker.ts` — that's where the per-pixel math runs.
// Keep them in sync with the worker file when adjusting the look.

// Used by the SVG filter primitives below — feDisplacementMap.scale and
// feGaussianBlur.stdDeviation read these directly.
const DISP_PX = 40;        // requested max refraction shift, pixels (see dispEff)
const BLUR_DEFAULT = 5;    // backdrop blur for unclassified elements, pixels
const SATURATE = "1.8";

// ── Fold-free displacement cap ───────────────────────────────────────────
//
// ★★ WHAT THIS PREVENTS, measured, on the real toolbar (1100x44, bezel 17.6,
// 40px peak — i.e. the model this app shipped before the cap existed):
//
//     y    G    displacement    y' = y + disp   (the row it samples FROM)
//     0   254      39.69           39.69
//     1   219      28.71           29.71   <-- DECREASING
//     4   164      11.45           15.45   <-- DECREASING
//     8   138       3.29           11.29   <-- DECREASING
//     9   135       2.35           11.35
//
// y′ must increase with y or the image folds. It fell for 8 of the first 22
// rows: 28.4px of backdrop was squeezed, REVERSED, into the top ~8px of the
// bar, and the same happened mirrored at the bottom. Over body text the two
// bands land on different lines, each crushed ~3.5:1, which is what reads as
// "the top edge leans left and the bottom edge leans right". It is not a
// rotational field — a 16px grating behind the same toolbar measures
// dx(y) = 0.000 at every row (scripts/glass-shear.cjs).
//
// Sampling stays monotone iff peak displacement ≤ bezel / PROFILE_SLOPE, since
// the profile's steepest normalised slope is PROFILE_SLOPE. FOLD_SAFE keeps a
// margin under that bound and sets the rim's peak magnification, 1/(1−0.85)
// ≈ 6.7x.
//
// The corner constraint (sampling inward past the corner-arc centre mirrors a
// blob into the corner) is NOT a term here: it is applied LOCALLY inside the
// map's corner-arc quadrants (worker, MapRequest.dispPx), so straight edges
// run at the full edge cap. A global corner term was what read as "refraction
// too small" — it dragged whole panels from 40px down to ~20.
//
// With PROFILE_EXP 1.25 and BEZEL_FRAC 1 the panels are NOT limited by this at
// all — their bezel is wide enough that they sit on DISP_PX and keep the full
// original 40px. Only chrome thinner than ~2·PROFILE_SLOPE·DISP_PX/FOLD_SAFE
// is capped, and there the cap is arithmetic: a 44px-tall bar cannot carry
// 40px of fold-free pull no matter what the profile is (the ceiling is the
// half-height, 22px).
const FOLD_SAFE = 0.85;
// Mirror of the worker's PROFILE_EXP / BEZEL_PX / BEZEL_FRAC — keep in sync.
const PROFILE_SLOPE = 1.25;
const BEZEL_PX_MAIN = 120;
const BEZEL_FRAC_MAIN = 1;
function effectiveDisp(
  disp: number, w: number, h: number, bezelOverride: number | null, profile: "snell" | "foldfree",
): number {
  if (profile === "snell") return disp;
  const halfShorter = Math.min(w, h) / 2;
  const bezel = Math.min(bezelOverride ?? BEZEL_PX_MAIN, halfShorter * BEZEL_FRAC_MAIN);
  return Math.min(disp, (FOLD_SAFE * bezel) / PROFILE_SLOPE);
}

// Blue channel of the map's neutral margin: (BLUR_EDGE_MIN * 255 + 0.5) | 0
// with BLUR_EDGE_MIN = 0.85 in liquid-glass-worker.ts. Keep in sync — feFlood
// uses it to extend a shrunk map across the rest of the filter region, and a
// mismatch would draw a visible step at the map's edge.
const MAP_NEUTRAL_MASK = 217;

// Element px of neutral margin to bake into the map, for presets where that is
// provably free of visual change (the worker's resolveMapPad decides, and falls
// back to the full margin otherwise). Only needs to be wide enough that the
// map's own edge is already neutral where it meets the feFlood; the knob maps
// oversample 12-16x, so 4 element px is a 48-64 texel collar.
const MAP_PAD_PX = 4;

// Bezel width (refraction radius) default lives in liquid-glass-worker.ts as
// BEZEL_PX (120). Per-element overrides (the lens) are passed to the worker;
// a null override means "use the worker's BEZEL_PX".

// ── Loading-lens knobs (this component only) ───────────────────────────────
// These three values tune ONLY `.liquid-glass-lens` (the centred loading
// circle). They do not touch the toolbar, panels, knobs, or any other glass.
// Everything adjustable for the lens lives right here:
const LENS_REFRACTION        = 20;   // refraction strength — px the backdrop shifts at the rim
const LENS_REFRACTION_RADIUS = 20;  // refraction radius   — bezel width (px) the lens bends over
const LENS_BLUR              = 0.2;     // blur radius         — px (0 = pure refraction, no frost)
const LENS_SUPERSAMPLE       = 4;     // supersampling — renders the filter + displacement map at
                                      // this multiple of the base size so the CSS scale-up stays
                                      // smooth (no ridges). Raise it if the CSS scale grows.
const LENS_SATURATE          = 1;     // saturation of the refracted backdrop. The global glass uses
                                      // 1.8 (vivid); the lens uses 0 so it never amplifies the mode-
                                      // tinted scan gradient / highlights behind it into colour. 1 =
                                      // natural, >1 = more vivid.

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
/** What the worker built: the map blob plus the margin actually baked into it. */
interface BuiltMap {
  url: string;
  padX: number;
  padY: number;
}
const pendingBlob = new Map<string, (map: { blob: Blob; padX: number; padY: number }) => void>();
type MapPreset = "default" | "control-knob" | "toggle-control-knob";

function ensureWorker(): Worker | null {
  if (workerDead) return null;
  if (worker) return worker;
  try {
    worker = new Worker(
      new URL("./liquid-glass-worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent<{ id: string; blob: Blob; padX: number; padY: number }>) => {
      const { id, blob, padX, padY } = e.data;
      const resolver = pendingBlob.get(id);
      if (resolver) {
        pendingBlob.delete(id);
        resolver({ blob, padX, padY });
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
  bezel: number | null,
  superSample: number,
  mapPad: number | null,
  profile: "snell" | "foldfree",
  dispPx: number,
): Promise<BuiltMap | null> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = `req-${++reqCounter}`;
    pendingBlob.set(id, ({ blob, padX, padY }) =>
      resolve({ url: URL.createObjectURL(blob), padX, padY }));
    w.postMessage({ id, elemW, elemH, radius, overflow, preset, bezel, superSample, mapPad, profile, dispPx });
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
  // The loading lens pulls pure refraction — displacement only, no blur — so
  // it reads as a clear glass lens over the scrolling text, not a frosted disc.
  if (el.classList.contains("liquid-glass-lens")) return LENS_BLUR;
  // ★ ORDER MATTERS. The range/toggle knobs carry BOTH `glass-*-knob` AND
  // `liquid-glass-control-knob`, so this specific test has to come first. It
  // used to sit below the generic control-knob branch, which made it dead code:
  // the knobs silently got 0.2px of blur instead of the 0 intended here (and
  // stated by their CSS fallback, `backdrop-filter: blur(0px) saturate(1.45)`).
  // On a 20x14 element 0.2px is enough to smear the refraction into mush, which
  // is what read as the knobs looking soft/pixelated. At 0 the tail
  // feGaussianBlur is also dropped entirely (see buildFilterEl), so the knobs
  // get a sharper result AND one less filter pass per frame.
  if (el.matches(".glass-range-knob, .glass-toggle-knob")) return 0;
  if (el.classList.contains("liquid-glass-control-knob")) return 0.2;
  if (el.classList.contains("toolbar")) return 1.2;
  if (el.classList.contains("settings-panel")) return 3;
  if (el.matches(".analysis-tab, .analysis-action-group")) return 1.2;
  if (el.classList.contains("status-pill")) return 1.2;
  if (el.matches(".annotation-popover, .annotation-panel")) return 2;
  return BLUR_DEFAULT;
}

// Refraction strength (feDisplacementMap scale). Only the lens overrides it.
function readDisp(el: Element): number {
  if (el.classList.contains("liquid-glass-lens")) return LENS_REFRACTION;
  return DISP_PX;
}

// Displacement falloff model. The loading lens keeps the legacy Snell/squircle
// profile its look was tuned around (fold-over included); everything else uses
// the fold-free profile — see FOLD_SAFE above and MapProfile in the worker.
function readProfile(el: Element): "snell" | "foldfree" {
  return el.classList.contains("liquid-glass-lens") ? "snell" : "foldfree";
}

// Refraction radius (bezel width) override; null → the worker's BEZEL_PX.
function readBezel(el: Element): number | null {
  if (el.classList.contains("liquid-glass-lens")) return LENS_REFRACTION_RADIUS;
  return null;
}

// Supersample factor — renders the filter chain + displacement map at this
// multiple of the element's layout size. 1 = normal (the perf-tuned downscale).
function readSuperSample(el: Element): number {
  if (el.classList.contains("liquid-glass-lens")) return LENS_SUPERSAMPLE;
  return 1;
}

// Saturation of the refracted backdrop (feColorMatrix). Only the lens overrides
// the global SATURATE, so it doesn't amplify mode-coloured content behind it.
function readSaturate(el: Element): number {
  if (el.classList.contains("liquid-glass-lens")) return LENS_SATURATE;
  return parseFloat(SATURATE);
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
    // ★ 4, not 2. The knobs are the one glass that renders under a CSS scale
    // while active — the range knob at 1.62x, the toggle at 2x — and the
    // filter rasterises at THIS density before that scale is applied. At 2
    // texels/element-px on a 2x display the pressed knob was showing a ~2x
    // magnified raster: the "pixelated knob" complaint. 4 covers the worst
    // case (2 CSS x 2 dpr). The region cost stays flat because dispEff also
    // shrank the knob filter region to what the refraction can actually reach.
    return { scale: 4, min: 160 };
  }
  return { scale: FILTER_RES_SCALE, min: FILTER_RES_MIN };
}

// The filter region is sized `ceil(dispEff) + blur*2 + 4` — the largest shift
// feDisplacementMap can actually produce for THIS element (scale = dispEff*2
// over a full-range ±127 map), plus the blur's reach and a little slack. An
// earlier revision sized every region for the global 40px maximum, which made
// the knob regions 5.9-10.3x larger in area than their refraction could ever
// reach; the fold-free dispEff made the true reach per-element and the region
// followed. (This superseded a comment here describing that shrink as a
// deliberately untaken optimisation pending sign-off on the knob rendering —
// the refraction rewrite was that sign-off.)

function buildFilterEl(
  id: string,
  w: number,
  h: number,
  overflow: number,
  map: BuiltMap,
  blur: number,
  preset: MapPreset,
  disp: number,
  superSample: number,
  saturate: number,
): SVGFilterElement {
  const totalW = w + 2 * overflow;
  const totalH = h + 2 * overflow;
  const displacementScale = disp * 2;
  const dispMapAntialias = readDispMapAntialias(preset);
  const dispMapInput = dispMapAntialias > 0 ? "dispMapAA" : "dispMap";
  // Supersample (the lens): rasterise the whole filter chain at superSample×
  // the element size — capped — so a CSS scale-up of the element stays smooth
  // instead of magnifying the perf downscale into ridges. Otherwise use the
  // normal perf-tuned fractional resolution.
  let filterResStr: string;
  if (superSample > 1) {
    const ss = (v: number) => String(Math.min(2048, Math.round(v * superSample)));
    filterResStr = `${ss(totalW)} ${ss(totalH)}`;
  } else {
    const filterRes = readFilterResConfig(preset);
    filterResStr = `${clampRes(totalW * filterRes.scale, filterRes.min)} ${clampRes(totalH * filterRes.scale, filterRes.min)}`;
  }
  const filter = createElNS("filter", {
    id,
    filterUnits: "userSpaceOnUse",
    primitiveUnits: "userSpaceOnUse",
    x: String(-overflow),
    y: String(-overflow),
    width: String(totalW),
    height: String(totalH),
    "color-interpolation-filters": "sRGB",
    filterRes: filterResStr,
  }) as SVGFilterElement;

  // The map covers the element plus `padX/padY` of neutral margin — which is
  // the whole filter region for most presets, but a thin collar for the knobs
  // (see resolveMapPad in the worker: their map would otherwise be 97% padding
  // by area, and Chromium re-samples the entire feImage every frame the
  // backdrop changes, which measured 13.31 ms/frame for two knobs on an M1 Pro).
  //
  // When the map is smaller than the region, feFlood supplies the same neutral
  // value everywhere else. That matters: outside an feImage's extent the result
  // is transparent black, and feDisplacementMap would read R=G=0 as a full
  // negative shift rather than "no shift". The flood must therefore match the
  // worker's pre-fill byte for byte — rgb(128,128,217), where 217 is
  // (BLUR_EDGE_MIN * 255 + 0.5) | 0 — and the seam is safe because the map's
  // own collar is already that exact colour, so any blend across it is a blend
  // of two identical values.
  const mapCoversRegion = map.padX >= overflow && map.padY >= overflow;
  const mapImageResult = mapCoversRegion ? "dispMap" : "dispMapImg";

  filter.append(
    createElNS("feImage", {
      href: map.url,
      x: String(-map.padX),
      y: String(-map.padY),
      width: String(w + 2 * map.padX),
      height: String(h + 2 * map.padY),
      preserveAspectRatio: "none",
      result: mapImageResult,
    }),
  );

  if (!mapCoversRegion) {
    filter.append(
      createElNS("feFlood", {
        "flood-color": `rgb(128,128,${MAP_NEUTRAL_MASK})`,
        "flood-opacity": "1",
        result: "dispMapPad",
      }),
      createElNS("feComposite", {
        in: mapImageResult,
        in2: "dispMapPad",
        operator: "over",
        result: "dispMap",
      }),
    );
  }

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

  // Both tail primitives are identity transforms at their neutral values, and
  // an identity pass still costs the compositor a full filter-region raster on
  // every frame the backdrop changes. Per spec a zero stdDeviation "disables
  // the effect of the given filter primitive (i.e. the result is the filter
  // input image)", and saturate(1) is the identity matrix — so dropping them is
  // *defined* to be a no-op (and is verified pixel-identical by
  // scripts/glass-pixel-diff.cjs). Each case fires for a real preset: the
  // range/toggle knobs run blur 0, and the loading lens — the largest glass
  // surface in the app, blown up 7x — runs saturate 1.
  //
  // If both are dropped the chain ends at feDisplacementMap, whose output is
  // then the filter result (the last primitive's always is).
  let tail = "displaced";
  if (blur > 0) {
    filter.append(
      createElNS("feGaussianBlur", {
        in: tail,
        stdDeviation: String(blur),
        result: "blurred",
      }),
    );
    tail = "blurred";
  }
  if (saturate !== 1) {
    filter.append(
      createElNS("feColorMatrix", {
        in: tail,
        type: "saturate",
        values: String(saturate),
      }),
    );
  }

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
  disp: number,
  bezel: number | null,
  superSample: number,
  saturate: number,
  profile: "snell" | "foldfree",
): Promise<string | null> {
  ensureSvgRoot();
  const w = snap(elemW);
  const h = snap(elemH);
  const r = snap(radius);
  const id = `lg-${preset}-${w}-${h}-${r}-b${blur}-d${disp}-z${bezel ?? "def"}${superSample > 1 ? `-s${superSample}` : ""}-q${saturate}-p${profile === "snell" ? "s" : "f"}`;

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
    const dispEff = effectiveDisp(disp, w, h, bezel, profile);
    const overflow = Math.ceil(dispEff) + blur * 2 + 4;
    const map = await buildMapInWorker(w, h, r, overflow, preset, bezel, superSample, MAP_PAD_PX, profile, dispEff);
    if (!map) return null;

    const filter = buildFilterEl(id, w, h, overflow, map, blur, preset, dispEff, superSample, saturate);
    defs!.append(filter);
    filterCache.set(id, { filter, blobUrl: map.url, refCount: 0 });
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
    const disp = readDisp(element);
    const bezel = readBezel(element);
    const superSample = readSuperSample(element);
    const saturate = readSaturate(element);
    const profile = readProfile(element);
    const key = `${preset}-${snap(w)}-${snap(h)}-${snap(r)}-b${blur}-d${disp}-z${bezel ?? "def"}-s${superSample}-q${saturate}-p${profile}`;
    if (lastSize.get(element) === key) return;
    lastSize.set(element, key);
    const id = await ensureFilter(w, h, r, blur, preset, disp, bezel, superSample, saturate, profile);
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
