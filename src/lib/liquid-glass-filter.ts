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
 *         feDisplacementMap → [feGaussianBlur(blur)] →
 *         [chroma gate: 3×feColorMatrix + 2×feComposite(add) →
 *          feGaussianBlur(neutral branch) → feComposite(in) →
 *          feComposite(over)] → [feColorMatrix(sat)]
 *  The bracketed passes are omitted when they would be identity transforms,
 *  since an identity pass still costs a full filter-region raster per frame.
 *
 *  Performance: filter generation is deferred to requestIdleCallback so
 *  panel-open / chapter-switch animations are not blocked. Until the JS
 *  filter is ready, the CSS fallback (a uniform blur) shows. The per-pixel
 *  map math lives in the worker — see its header for the cost structure and
 *  for the two harnesses that prove a change is pixel-identical.
 */

import { CANVAS_GLASS_ATTR } from "./glass-canvas";

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
const DISP_PX = 40;        // max refraction shift, pixels
const BLUR_DEFAULT = 3;    // backdrop blur for unclassified elements, pixels
const SATURATE = "2.15";

// ── Chroma flatten ─────────────────────────────────────────────────────────
//
// What sits behind a glass surface in this app is overwhelmingly PROSE:
// near-black on near-white, or the inverse in dark mode — chroma ≈ 0 either
// way. What is actually worth seeing through the glass is the coloured half:
// entity tags, action phrases, highlights, the mode tint. A plain
// backdrop-filter has only one lever for the busyness of all that text, blur,
// and blur cannot tell the two apart — it smears the colour just as hard.
//
// So separate them by the one thing that already distinguishes them, and do
// it POINTWISE. Split each pixel into luma + chroma and fade only the luma,
// toward the page's own tone:
//
//   out = base − t·(luma(base) − K)          K = the page's luminance
//
// A neutral pixel is all luma, so it collapses toward K by the fraction t —
// black text on a white page lifts toward the page and stops competing. A
// coloured pixel's chroma is the zero-sum part of that expression and passes
// through completely untouched, then takes the raised saturate on top. That
// is "mostly black-and-white, not 100%, and more than the coloured elements",
// and it is what PAYS FOR the much lower blur above: the surface's legibility
// no longer depends on smearing everything behind it.
//
// ★ IT IS FREE. Both this and the saturation are 3×3 linear maps with an
// offset, so their product is one too — the combined matrix REPLACES the
// saturate pass rather than adding to it. Zero extra primitives, zero extra
// filter-region rasters, and no spatial operator, so it cannot ghost, comb or
// moiré the way a gather-based scheme does.
//
// The measured alternative, for the record: gating a second blur by a
// per-pixel colourfulness mask (3×feColorMatrix + 2×feComposite + blur + 2
// composites) cost 3.59 ms/frame against 0.40 for the whole rest of the chain
// on six surfaces — 9× the glass budget for an effect this achieves pointwise.
//
// CHROMA_FLATTEN = 0 makes the combined matrix reduce EXACTLY to the old
// saturate matrix, which is how the excluded surfaces stay byte-identical.
const CHROMA_FLATTEN = 0.5;     // fraction of the neutral (B&W) signal removed
const LUMA = [0.2126, 0.7152, 0.0722];

// Luminance the flattened neutral collapses toward — the page's own tone, so
// text fades INTO the page rather than toward an arbitrary grey (a mid-grey
// target would darken a white page and lighten a dark one, greying the glass
// in both). Theme-dependent, so it is read from CSS and re-read on a scheme
// flip, and it is part of the filter cache key.
const FLATTEN_TARGET_VAR = "--lqg-flatten-target";
const FLATTEN_TARGET_FALLBACK = 0.94;
let flattenTarget = FLATTEN_TARGET_FALLBACK;
function readFlattenTarget(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(FLATTEN_TARGET_VAR).trim();
  const v = parseFloat(raw);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : FLATTEN_TARGET_FALLBACK;
}

/**
 * The tail colour matrix: chroma-flatten by `t` toward `k`, then saturate by
 * `s`, as a single 4×5 matrix.
 *
 *   flatten F_ij = δ_ij − t·L_j              offset f_i = t·k
 *   saturate S_ij = s·δ_ij + (1−s)·L_j
 *   combined  M = S·F,  M_ij = s·δ_ij + L_j·[(1−s)(1−t) − s·t]
 *
 * The offset survives the product unchanged because every row of S sums to 1.
 * At t = 0 this is the plain saturate matrix, term for term.
 */
function tailMatrixValues(s: number, t: number, k: number): string {
  const coef = (1 - s) * (1 - t) - s * t;
  const rows: string[] = [];
  for (let i = 0; i < 3; i++) {
    const row = LUMA.map((l, j) => (i === j ? s : 0) + l * coef);
    rows.push(`${row.map((v) => v.toFixed(6)).join(" ")} 0 ${(t * k).toFixed(6)}`);
  }
  rows.push("0 0 0 1 0");
  return rows.join("  ");
}

// The sidebar tab buttons sit OUT of this whole pass — same blur, same tint,
// same saturation, no gate — so they keep reading exactly as they did while
// every other surface changes around them. One predicate, so the three
// exclusions cannot drift apart.
const SATURATE_LEGACY = "1.8";  // pre-pass saturation, tab buttons only
function isSidebarTab(el: Element): boolean {
  return el.matches(".analysis-tab, .analysis-action-group");
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
): Promise<BuiltMap | null> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = `req-${++reqCounter}`;
    pendingBlob.set(id, ({ blob, padX, padY }) =>
      resolve({ url: URL.createObjectURL(blob), padX, padY }));
    w.postMessage({
      id, elemW, elemH, radius, overflow, preset, bezel, superSample, mapPad,
      // Knobs author their map at press density; every other preset ignores it.
      displayScale: isKnobPreset(preset) ? KNOB_DISPLAY_SCALE : undefined,
      // …and need the filter's displacement scale to size their fold-free
      // budget, since that is what turns their packed bytes into element px.
      dispPx: isKnobPreset(preset) ? DISP_PX : undefined,
    });
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
  if (el.classList.contains("toolbar")) return 0.9;
  if (el.classList.contains("settings-panel")) return 2;
  // ★ The sidebar tab buttons keep 1.2 — they are deliberately EXCLUDED from
  // the less-blur/more-opaque pass (they are also the only glass that does not
  // carry `.liquid-glass`, so the denser tint in styles.css misses them by
  // construction rather than by a second rule).
  if (el.matches(".analysis-tab, .analysis-action-group")) return 1.2;
  if (el.classList.contains("status-pill")) return 0.9;
  // ★ The annotation POPOVER is deliberately absent here, so it falls through
  // to BLUR_DEFAULT and matches the entity popover exactly. The two are the
  // same kind of surface — a small card that opens over the prose to say
  // something about the span under the caret — and they were reading as
  // different materials only because this line pinned one of them to 2px while
  // the other took the 5px default. Blur was the ONLY reader that told them
  // apart; displacement, bezel, supersample and saturation were already shared.
  // The annotation PANEL keeps its own value: it is a wide persistent bar, not
  // a card, and a heavier blur over that much text costs legibility.
  if (el.classList.contains("annotation-panel")) return 1.4;
  return BLUR_DEFAULT;
}

// Refraction strength (feDisplacementMap scale). Only the lens overrides it.
function readDisp(el: Element): number {
  if (el.classList.contains("liquid-glass-lens")) return LENS_REFRACTION;
  return DISP_PX;
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
  if (isSidebarTab(el)) return parseFloat(SATURATE_LEGACY);
  return parseFloat(SATURATE);
}

/** How much of the neutral signal this element's chain fades out. */
function readChromaGate(el: Element): number {
  if (isSidebarTab(el)) return 0;
  // The lens is a clear reading lens, not a frosted card: fading its neutral
  // content would erase exactly the prose it exists to magnify.
  if (el.classList.contains("liquid-glass-lens")) return 0;
  return CHROMA_FLATTEN;
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

/**
 * How much bigger than its layout box a knob is DISPLAYED at while its glass
 * is attached.
 *
 * ★ THIS IS NOT A TUNABLE — it is read off the CSS. `.glass-toggle--pressed
 * .glass-toggle-knob` and the slider's `:has(:active)` rule both scale the
 * knob to `scale(2)`, and GlassToggle/GlassRange attach
 * `liquid-glass-control-knob` for exactly that press and its settle. So the
 * knob is never displayed at 1x with glass on: authoring its map from the
 * LAYOUT box meant a 32x24 map magnified across a 64x48 knob at the one
 * moment it is biggest (verify-toggle-press.cjs called it "STRETCHED over the
 * swell"). If the CSS scale changes, change this with it.
 */
const KNOB_DISPLAY_SCALE = 2;

function isKnobPreset(preset: MapPreset): boolean {
  return preset === "control-knob" || preset === "toggle-control-knob";
}

function readDispMapAntialias(preset: MapPreset): number {
  if (preset === "control-knob") return 0.55;
  if (preset === "toggle-control-knob") return 0.48;
  return 0;
}

function readFilterResConfig(preset: MapPreset): { scale: number; min: number } {
  if (preset === "control-knob" || preset === "toggle-control-knob") {
    // ★ 4, not 2 — the "knobs look pixelated" fix, and it is about the CSS
    // SCALE, not the map. The knobs are the only glass that renders magnified:
    // the range knob goes to scale(1.62) and the toggle to scale(2) while
    // pressed (styles.css). `filterRes` rasterises the chain BEFORE that
    // transform, so at scale 2 the knob was showing 2 texels per element px
    // blown up by 2 CSS x 2 dpr. 4 covers that worst case.
    //
    // Affordable only because the knob map density is 3 (MAP_OVERSAMPLE) and
    // not the 12 it used to be — that was the 13 ms/frame problem, and it was
    // map minification, not raster resolution. They trade against each other:
    // measure with `npm run bench:glass-gpu` if you touch either.
    return { scale: 4, min: 160 };
  }
  return { scale: FILTER_RES_SCALE, min: FILTER_RES_MIN };
}

// ── KNOWN, DELIBERATELY UNTAKEN OPTIMISATION ──────────────────────────────
//
// The filter region below is sized `disp + blur*2 + 4`, which is exactly the
// largest shift feDisplacementMap can produce (`scale * (channel/255 - 0.5)`
// with the worker's `128 + v*127*gain` packing) *at gain 1*, plus the blur's
// reach and a little slack.
//
// It does NOT account for CHANNEL_GAIN. The knob presets pack at 0.35 / 0.24,
// so they displace at most 14.1px / 9.7px rather than 40px, which makes their
// filter region 5.9x / 10.3x larger in AREA than the refraction can ever
// reach — and since those presets build their map at 16x oversample, the empty
// margin dominates: a 20x14 range knob rasterises a 1728x1632 map that is 97%
// untouched padding.
//
// Correcting it is a large win (~4x less knob map work) but it is NOT free:
// the region feeds `filterRes`, so shrinking it moves the raster grid and
// scripts/glass-pixel-diff.cjs measures 1108 changed pixels (max channel
// delta 53) on the two knobs. That is sub-pixel, knob-only, and arguably more
// correct — but it is a visual change, so it stays untaken here.
// Revisit only with explicit sign-off on the knob rendering.

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
  chromaGate: number,
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

  // ── Tail: chroma-flatten + saturate, as ONE matrix ──────────────────────
  //
  // Both are identity at their neutral values, and an identity pass still
  // costs the compositor a full filter-region raster on every frame the
  // backdrop changes. saturate(1) with flatten 0 is the identity matrix, so
  // dropping the pass is *defined* to be a no-op (verified pixel-identical by
  // scripts/glass-pixel-diff.cjs) — and it fires for a real preset: the
  // loading lens, the largest glass surface in the app, runs saturate 1 and
  // is excluded from the flatten. When it is dropped the chain ends at the
  // blur (or at feDisplacementMap, if blur is 0 as it is for the knobs),
  // whose output is then the filter result.
  if (saturate !== 1 || chromaGate > 0) {
    filter.append(
      createElNS("feColorMatrix", {
        in: tail,
        type: "matrix",
        values: tailMatrixValues(saturate, chromaGate, flattenTarget),
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
  chromaGate: number,
): Promise<string | null> {
  ensureSvgRoot();
  const w = snap(elemW);
  const h = snap(elemH);
  const r = snap(radius);
  // ★ Every option that changes the OUTPUT belongs in this id — it is the
  // cache key. displayScale changes the map's density, so a knob authored at
  // press density must not be served from an entry built without it.
  const id = `lg-${preset}-${w}-${h}-${r}-b${blur}-d${disp}-z${bezel ?? "def"}${superSample > 1 ? `-s${superSample}` : ""}${isKnobPreset(preset) ? `-x${KNOB_DISPLAY_SCALE}` : ""}-q${saturate}${chromaGate > 0 ? `-c${chromaGate}@${flattenTarget}` : ""}`;

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
    const overflow = disp + blur * 2 + 4;
    const map = await buildMapInWorker(w, h, r, overflow, preset, bezel, superSample, MAP_PAD_PX);
    if (!map) return null;

    const filter = buildFilterEl(id, w, h, overflow, map, blur, preset, disp, superSample, saturate, chromaGate);
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
  // ★ THE CANVAS ENGINE OWNS THIS ONE. src/lib/glass-canvas claims the
  //   panel-class surfaces and refracts them from a backdrop it reconstructs
  //   itself; building a displacement map for the same element would cost a
  //   worker round-trip and a filter-region raster per frame for something the
  //   CSS then disables anyway. The attribute is the handshake, so the two
  //   engines never both hold an element, and a surface the canvas path hands
  //   BACK (see release()) loses the attribute and lands here on the next
  //   class mutation.
  if (element.hasAttribute(CANVAS_GLASS_ATTR)) return;

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
    const chromaGate = readChromaGate(element);
    const key = `${preset}-${snap(w)}-${snap(h)}-${snap(r)}-b${blur}-d${disp}-z${bezel ?? "def"}-s${superSample}-q${saturate}-c${chromaGate}@${flattenTarget}`;
    if (lastSize.get(element) === key) return;
    lastSize.set(element, key);
    const id = await ensureFilter(w, h, r, blur, preset, disp, bezel, superSample, saturate, chromaGate);
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
    flattenTarget = readFlattenTarget();
    scan(document.body);
    syncLiquidGlassPauseState();

    // ★ The chroma flatten fades neutral content toward the PAGE's tone, which
    // is the one filter input that flips with the colour scheme. Nothing else
    // in this engine is theme-dependent, so this listener is the only reason
    // it needs one: re-read the target and rebuild. `lastSize` carries the
    // target in its key, so applyTo() rebuilds exactly the elements whose
    // filter actually changed and no-ops on the rest (the tab buttons and the
    // lens run flatten 0, so their key does not move).
    const schemeMq = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;
    schemeMq?.addEventListener?.("change", () => {
      const next = readFlattenTarget();
      if (next === flattenTarget) return;
      flattenTarget = next;
      // ★ SCHEDULE, do not applyTo. applyTo() opens with
      // `if (elementSchedule.has(element)) return` — it is the ADOPT path, so
      // on an already-tracked element it is a silent no-op and nothing
      // rebuilds. Every element here is tracked by definition, so calling it
      // refreshed exactly nothing; surfaces kept their light-mode filter until
      // something else happened to re-run their update (a resize, a remount,
      // or the pause/resume cycle an unfocus gives you — which is why the bug
      // hid whenever the flip was done by leaving the app, and showed on a
      // flip with the window focused, e.g. macOS auto light/dark at sunset).
      // Gated by scripts/verify-theme-flip.cjs, which flips BOTH ways.
      for (const el of trackedElements) elementSchedule.get(el)?.();
    });

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
