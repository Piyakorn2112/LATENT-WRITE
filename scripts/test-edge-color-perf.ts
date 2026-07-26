/**
 * test-edge-color-perf.ts
 *
 * Resource-cost measurement + gates for the edge-colour glow
 * (src/lib/edge-color/edge-color.ts).
 *
 * The glow adds, per glass surface, a sibling overlay that the glass refracts.
 * Two things drive cost and neither shows up in a normal accuracy test:
 *
 *   GPU  — each overlay with a live `backdrop-filter: blur()` is a separate
 *          compositor pass the GPU re-runs EVERY frame, over its whole box,
 *          on top of the existing refraction pass. N glass ⇒ ~N extra blur
 *          passes/frame. On a GPU already saturated by the refraction + orb
 *          this is the dominant added cost. Proxy metrics: number of live
 *          backdrop-filter layers, total filtered pixel area, blur radius.
 *
 *   CPU  — the rAF loop calls, per visible overlay PER FRAME:
 *            · glass.getBoundingClientRect()      (forced layout)
 *            · offsetParent.getBoundingClientRect()(forced layout)
 *            · getComputedStyle(glass)            (forced style recalc, in radiusOf)
 *          even when nothing moved. Metrics: layout reads + style reads + style
 *          writes per frame, in three regimes (setup / idle / active-scroll).
 *
 * This is a deterministic, instrumented fake DOM driving the REAL initEdgeColor
 * through its public interface — it measures observable resource behaviour, not
 * internals, so it survives refactors. The GATES at the bottom encode the
 * post-optimisation targets (RED until the glow is optimised, GREEN after).
 *
 * Run:  npx tsx scripts/test-edge-color-perf.ts
 */

import { initEdgeColor } from "../src/lib/edge-color/edge-color";

// ─────────────────────────── instrumented fake DOM ──────────────────────────

const metrics = {
  rectReads: 0,        // getBoundingClientRect()
  computedStyleReads: 0, // getComputedStyle()
  styleWrites: 0,      // element.style.<prop> = ...
};
function resetMetrics() {
  metrics.rectReads = 0;
  metrics.computedStyleReads = 0;
  metrics.styleWrites = 0;
}

interface Rect { left: number; top: number; width: number; height: number; right: number; bottom: number; }

const createdOverlays: FakeEl[] = []; // body-glow siblings (className lqg-edge-color)
const createdRims: FakeEl[] = [];     // specular-rim children (className lqg-edge-rim)

class FakeClassList {
  constructor(private el: FakeEl) {}
  contains(c: string): boolean {
    return this.el.className.split(/\s+/).includes(c);
  }
}

function makeStyleProxy(): Record<string, string> {
  const target: Record<string, string> = {};
  return new Proxy(target, {
    set(t, p, v) {
      metrics.styleWrites++;
      t[p as string] = String(v);
      return true;
    },
    get(t, p) {
      return (t[p as string] as string) ?? "";
    },
  });
}

class FakeEl {
  tagName: string;
  className = "";
  style = makeStyleProxy();
  classList = new FakeClassList(this);
  parentNode: FakeEl | null = null;
  children: FakeEl[] = [];
  // layout/state the module reads
  __rect: Rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  __radius = 0;
  __position = "relative";
  __bg = "rgba(0, 0, 0, 0)";
  __fg = "rgb(0, 0, 0)";
  __entityColor = "";
  clientLeft = 0;
  clientTop = 0;
  scrollLeft = 0;
  scrollTop = 0;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get offsetParent(): FakeEl | null {
    return this.parentNode && this.parentNode !== body ? this.parentNode : null;
  }
  get offsetLeft(): number { return this.__rect.left; }
  get offsetTop(): number { return this.__rect.top; }
  get offsetWidth(): number { return this.__rect.width; }
  get offsetHeight(): number { return this.__rect.height; }
  get firstChild(): FakeEl | null {
    return this.children[0] ?? null;
  }
  getBoundingClientRect(): Rect {
    metrics.rectReads++;
    return this.__rect;
  }
  insertBefore(node: FakeEl, ref: FakeEl | null): FakeEl {
    node.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i >= 0) this.children.splice(i, 0, node);
    else this.children.push(node);
    if (node.className === "lqg-edge-color") createdOverlays.push(node);
    if (node.className === "lqg-edge-rim") createdRims.push(node);
    return node;
  }
  appendChild(node: FakeEl): FakeEl {
    return this.insertBefore(node, null);
  }
  remove(): void {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  matches(sel: string): boolean {
    return sel.split(",").some((part) => {
      const cls = part.trim().replace(/^\./, "");
      return this.className.split(/\s+/).includes(cls);
    });
  }
  querySelectorAll(sel: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl) => {
      for (const c of n.children) {
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

// rAF clock — manual, deterministic.
let rafSeq = 0;
let rafQueue: Array<[number, FrameRequestCallback]> = [];
function runFrame(nowMs: number) {
  const due = rafQueue;
  rafQueue = [];
  for (const [, cb] of due) cb(nowMs);
}

const docEl = new FakeEl("html");
const body = new FakeEl("body");
docEl.appendChild(body);
const container = new FakeEl("div"); // shared positioned offset-parent
container.__position = "relative";
body.appendChild(container);

// Event registries so the suite can drive the event-driven loop (scroll wakes it).
const docListeners = new Map<string, EventListener>();
const winListeners = new Map<string, EventListener>();
function fireDoc(type: string) { docListeners.get(type)?.(undefined as unknown as Event); }

const g = globalThis as unknown as Record<string, unknown>;
g.window = {
  scrollX: 0, scrollY: 0, innerWidth: 1600, innerHeight: 1000,
  addEventListener: (t: string, fn: EventListener) => winListeners.set(t, fn),
  removeEventListener: (t: string) => winListeners.delete(t),
};
g.requestAnimationFrame = (cb: FrameRequestCallback): number => {
  const id = ++rafSeq;
  rafQueue.push([id, cb]);
  return id;
};
g.cancelAnimationFrame = (id: number): void => {
  rafQueue = rafQueue.filter(([i]) => i !== id);
};
g.getComputedStyle = (el: FakeEl) => {
  metrics.computedStyleReads++;
  return {
    borderTopLeftRadius: `${el.__radius}px`,
    position: el.__position,
    backgroundColor: el.__bg,
    color: el.__fg,
    getPropertyValue: (p: string) => (p === "--entity-color" ? el.__entityColor : ""),
    // (--ap-color etc. resolve to "" in the harness — sources use --entity-color)
  } as unknown as CSSStyleDeclaration;
};
class FakeIO {
  constructor(_cb: IntersectionObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}
class FakeMO {
  constructor(_cb: MutationCallback) {}
  observe() {}
  disconnect() {}
}
class FakeRO {
  constructor(_cb: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}
g.IntersectionObserver = FakeIO as unknown as typeof IntersectionObserver;
g.MutationObserver = FakeMO as unknown as typeof MutationObserver;
g.ResizeObserver = FakeRO as unknown as typeof ResizeObserver;
g.document = {
  createElement: (tag: string) => new FakeEl(tag),
  querySelectorAll: (sel: string) => docEl.querySelectorAll(sel),
  documentElement: docEl,
  body,
  hidden: false,
  addEventListener: (t: string, fn: EventListener) => docListeners.set(t, fn),
  removeEventListener: (t: string) => docListeners.delete(t),
};

// ─────────────────────────── scene builder ──────────────────────────────────

// A realistic mix: big panels + toolbar + tabs/pills and small knobs. 24 glass
// surfaces (the glow width auto-shrinks on the small ones).
function buildScene(n = 24): FakeEl[] {
  const glasses: FakeEl[] = [];
  for (let i = 0; i < n; i++) {
    const el = new FakeEl("div");
    el.className = "lg";
    const toolbar = i === 1; // a wide-but-short toolbar → large tier
    const big = i % 4 !== 0;
    const w = toolbar ? 900 : big ? 240 + (i % 5) * 40 : 28;
    const h = toolbar ? 44 : big ? 120 + (i % 3) * 30 : 28;
    const x = toolbar ? 20 : 20 + (i % 6) * 260;
    const y = 20 + Math.floor(i / 6) * 200;
    el.__rect = { left: x, top: y, width: w, height: h, right: x + w, bottom: y + h };
    el.__radius = big ? 18 : 14;
    el.__position = i === 0 ? "fixed" : "relative"; // glass[0] mimics the fixed search box
    container.appendChild(el);
    glasses.push(el);
  }
  return glasses;
}

// Colour-source elements (the highlight layer): coloured entity tags scattered
// across the viewport, read directly by geometry.
function buildSources(n = 60): void {
  for (let i = 0; i < n; i++) {
    const el = new FakeEl("span");
    el.className = "src";
    const x = 10 + (i % 12) * 130, y = 10 + Math.floor(i / 12) * 90;
    el.__rect = { left: x, top: y, width: 60, height: 18, right: x + 60, bottom: y + 18 };
    el.__entityColor = ["#1B8A5E", "#9B6B00", "#5A44B0", "#D6363B"][i % 4];
    container.appendChild(el);
  }
}

// ─────────────────────────── measurement ────────────────────────────────────

const glasses = buildScene(24);
const N = glasses.length;
const M = 60;
buildSources(M);

// Distinct opacity tiers so the gate proves the toolbar (large) tier is applied.
const handle = initEdgeColor({
  selector: ".lg", colorSources: ".src", sourceRefreshMs: 80,
  opacity: 0.5, opacityLarge: 0.2,
});

let clock = 0;
function step() { clock += 40; runFrame(clock); } // advance past the 30fps throttle
function settleLoop(maxIters = 40) { let i = 0; while (rafQueue.length && i++ < maxIters) step(); }

// SETUP: first processed frame after init (positions + shapes + first source build).
resetMetrics();
step();
const setup = { ...metrics };

// Let the loop settle to a full stop now that nothing is moving.
settleLoop();
const stoppedWhenIdle = rafQueue.length === 0;

// IDLE: nothing moved — a tick far in the future must do nothing (loop stopped).
resetMetrics();
runFrame(clock + 100000);
const idle = { ...metrics };

// ACTIVE-REBUILD: a scroll wakes the loop; the FIRST frame rebuilds the source
// index (throttle window elapsed) — its cost is the worst-case active frame.
for (const el of glasses) el.__rect = { ...el.__rect, top: el.__rect.top + 12, bottom: el.__rect.bottom + 12 };
fireDoc("scroll");
resetMetrics();
step();
const activeRebuild = { ...metrics };

// ACTIVE-STEADY: a further scroll within the throttle window — repositions +
// repaints from the cached index, NO source rebuild, NO getComputedStyle.
fireDoc("scroll");
resetMetrics();
step();
const active = { ...metrics };

// GPU proxy from the produced overlays.
function px(v: string): number { return parseFloat(v) || 0; }
let backdropFilterLayers = 0;
let totalFilterAreaPx = 0;
let blurPx = 0;
for (const o of [...createdOverlays, ...createdRims]) {
  const bf = o.style.backdropFilter || "";
  const hasLiveBlur = /blur\(\s*([0-9.]+)px/.test(bf);
  if (hasLiveBlur) {
    backdropFilterLayers++;
    totalFilterAreaPx += px(o.style.width) * px(o.style.height);
    blurPx = Math.max(blurPx, parseFloat(/blur\(\s*([0-9.]+)px/.exec(bf)![1]));
  }
}

// Correctness smoke: with colour sources present, overlays must paint a mesh of
// radial glows from sampled source colours, not nothing.
let paintedRings = 0;
for (const o of createdOverlays) {
  // Soft-ellipse rewrite: body bands are radial gradients (linear before it).
  if (/(?:linear|radial)-gradient/.test(o.style.backgroundImage || "")) paintedRings++;
}
// The specular rim lights the source-facing part of the perimeter.
// It is drawn with stacked INSET BOX-SHADOWS rather than background gradients:
// a shadow follows the element's `border-radius`, so the light bends around a
// rounded corner by construction. Axis-aligned gradient bands cannot — two of
// them meeting at a corner form an L, which is what made corners read wrong no
// matter how they were weighted. Since the masked-ring rewrite the shadows
// live on pooled per-source RING CHILDREN of the rim, each localised to its
// facing arc by a radial mask. This gate is named for the behaviour (the rim
// paints a coloured catch at all), so it accepts any mechanism — a shadow or
// gradient on the rim itself or on any of its ring children.
let paintedSpecular = 0;
for (const o of createdRims) {
  const carriers = [o, ...o.children];
  const painted = carriers.some((c) =>
    /inset/.test(c.style.boxShadow || "") ||
    /(?:linear|radial)-gradient/.test(c.style.backgroundImage || ""));
  if (painted) paintedSpecular++;
}

// Structural facts must be read BEFORE destroy() detaches the overlays.
const body0 = createdOverlays[0];
const parent0 = glasses[0].parentNode!;
const bodyIsRefractedSibling =
  body0?.parentNode === parent0 &&
  parent0.children.indexOf(body0) < parent0.children.indexOf(glasses[0]) &&
  body0?.style.position !== "" &&
  body0?.style.zIndex !== "-1";
const toolbarOpacity = createdOverlays[1]?.style.opacity;
const normalOpacity = createdOverlays[0]?.style.opacity;

handle.destroy();

// ─────────────────────────── report ─────────────────────────────────────────

console.log("\n══ edge-colour glow — resource cost ══");
console.log(`  glass surfaces (N)            : ${N}`);
console.log("\n  GPU (per compositor frame, always-on):");
console.log(`    live backdrop-filter layers : ${backdropFilterLayers}`);
console.log(`    total filtered area (px²)    : ${totalFilterAreaPx.toLocaleString()}`);
console.log(`    blur radius (px)             : ${blurPx}`);
console.log(`\n  colour sources (highlight layer, M): ${M}`);
console.log("\n  CPU main-thread, per regime (lower = better):");
const row = (name: string, m: typeof metrics) =>
  console.log(`    ${name.padEnd(14)} layoutReads=${String(m.rectReads).padStart(3)}  styleReads=${String(m.computedStyleReads).padStart(3)}  styleWrites=${String(m.styleWrites).padStart(3)}`);
row("setup", setup);
row("idle", idle);
row("active-steady", active);
row("active-rebuild", activeRebuild); // worst case: throttled source-index rebuild

// ─────────────────────────── gates (optimisation targets) ───────────────────
// RED until the glow is optimised; GREEN after. Each gate is justified above.

let failed = 0;
function gate(label: string, ok: boolean, detail: string) {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label} — ${detail}`);
  }
}

console.log("\n══ gates ══");

// GPU: the glow must add NO live per-frame blur passes. Colour should come from a
// cheap static paint the glass refracts, not a live backdrop-filter per surface.
gate(
  "no live backdrop-filter passes",
  backdropFilterLayers === 0,
  `${backdropFilterLayers} live blur layers over ${totalFilterAreaPx.toLocaleString()}px² re-run every frame`,
);

// CPU idle: the loop must STOP when nothing moves — no rAF, no forced layout/style.
gate(
  "idle: loop stops, no forced layout/style",
  stoppedWhenIdle && idle.rectReads === 0 && idle.computedStyleReads === 0,
  `stopped=${stoppedWhenIdle} idleReads layout=${idle.rectReads} style=${idle.computedStyleReads}`,
);

// CPU active (steady): while scrolling, ≤ ~1 layout read per surface (cache
// offset-parent) and no per-frame getComputedStyle (radius cached; source index
// reused between throttled rebuilds).
gate(
  "active-steady ≤ ~1 layout read / surface",
  active.rectReads <= N + 1,
  `${active.rectReads} layout reads for ${N} surfaces (expected ≤ ${N + 1})`,
);
gate(
  "active-steady: no per-frame getComputedStyle",
  active.computedStyleReads === 0,
  `${active.computedStyleReads} getComputedStyle calls/frame (forces style recalc)`,
);
// The source index rebuild (M reads + M style) must be THROTTLED — it happens on
// the rebuild frame but NOT on the very next active frame within the window.
gate(
  "source-index rebuild is throttled",
  activeRebuild.computedStyleReads > 0 && active.computedStyleReads === 0,
  `rebuild styleReads=${activeRebuild.computedStyleReads}, next-frame styleReads=${active.computedStyleReads} (should be 0)`,
);
// Correctness: glasses near sources actually paint a shaped edge glow.
gate(
  "shaped edge glow catches nearby source colour",
  paintedRings > 0,
  `${paintedRings}/${N} overlays painted a glow`,
);
// The body glow is a refracted SIBLING behind the glass (same parent, inserted
// before it) — not a child — so the glass's own backdrop-filter distorts it.
gate(
  "body glow is a refracted sibling under the glass",
  bodyIsRefractedSibling,
  `pos="${body0?.style.position}" z="${body0?.style.zIndex}" (must be a positioned sibling before the glass, not a z:-1 child)`,
);
// The specular rim is a separate, crisp (un-refracted) child painting bright
// edge arcs via its masked ring children.
gate(
  "specular rim catches nearby colour (bright edge bands)",
  paintedSpecular > 0,
  `${paintedSpecular}/${createdRims.length} rims painted edge bands`,
);
// The large tier (toolbar, glass[1]) gets opacityLarge; a normal surface gets opacity.
gate(
  "opacity tier: toolbar=opacityLarge, normal=opacity",
  toolbarOpacity === "0.2" && normalOpacity === "0.5",
  `toolbar="${toolbarOpacity}" (exp 0.2), normal="${normalOpacity}" (exp 0.5)`,
);

console.log("");
if (failed > 0) {
  console.log(`✗ ${failed} gate(s) failing — optimisation needed.\n`);
  process.exit(1);
}
console.log("✓ all resource gates pass.\n");
