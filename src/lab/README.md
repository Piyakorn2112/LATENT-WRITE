# Glass lab — can we reconstruct the backdrop and refract it ourselves?

**Sandbox. Nothing in `src/lab/` is imported by the app.** This is the
feasibility study for replacing the SVG `backdrop-filter` glass with a canvas
path that owns its own backdrop, the way `KnobGlass` already does for the
control knobs.

Every number below was measured by a script in `scripts/`, on this machine, at
`dpr 2`. Re-run any of them; none of them are quoted from memory.

---

## The question

`KnobGlass` refracts properly because it **reconstructs** its backdrop — it
reads the track and the panel out of the live DOM, repaints them into a canvas,
and refracts those pixels per pixel in float. That is why the knobs have no
combs, no banding and no 8-bit quantisation: there is no displacement map in the
path at all.

Can that generalise to the rest of the app's glass?

Three things had to be true, and they were measured separately.

---

## 1 · Is per-pixel float refraction affordable at app sizes? **Not in JS.**

`npm run probe:refraction-cost` times the **shipping** knob painter at real
surface sizes.

| surface | device px | ms/frame | throughput |
|---|---:|---:|---:|
| toggle knob 32×24 | 3,072 | 0.20 | 15,620 px/ms |
| toolbar 920×46 | 169,280 | **4.83** | 35,048 px/ms |
| settings panel 420×620 | 1,041,600 | **40.2** | 25,889 px/ms |
| timeline overlay 1400×860 | 4,816,000 | **173.6** | 27,747 px/ms |

A 16.7 ms frame buys about 432,000 device px of glass — roughly one 658×658
surface, and that is the **whole** frame budget with nothing else in it. The
knob's method is correct and its implementation is in the wrong place.

Moved to a fragment shader (`glass-gl.ts`), the same optics cost **0.01–0.02 ms**
for every size in the table, including the 3.9M-pixel overlay. The refraction was
never the expensive part.

## 2 · Can the backdrop be reconstructed? **Yes — to under 1/255.**

`backdrop-reconstruct.ts` walks the DOM under a surface and repaints it: fills,
gradients, borders, and text laid out where the browser put it. It rasterises
only the surface's own rect, so cost is bounded by the *surface*, not the
document.

Measured against ground truth (`npm run probe:glass-fidelity` — a real
screenshot of the page with the glass hidden):

| surface | raw MAE | max | >32/255 | through the glass's own 3px blur |
|---|---:|---:|---:|---:|
| tab 26×73 | 0.03 | 2 | 0.0% | 1.11 |
| toolbar 920×46 | 0.21 | 11 | 0.0% | 1.91 |
| popover 420×120 | 0.07 | 14 | 0.0% | 1.08 |
| panel 420×620 | 0.14 | 35 | 0.0% | 0.93 |

And on the **running app** (`npm run probe:glass-real-app`), where the CSS is
not mine to choose:

| surface | raw MAE | max | through the 3px blur |
|---|---:|---:|---:|
| toolbar 920×46 | 0.65 | 3 | 0.43 |
| settings panel 370×819 | 0.63 | 2 | 0.95 |
| analysis tab 26×34 (worst) | 2.87 | 119 | **1.45 / max 6** |

The residual is glyph-edge antialiasing — DOM text and canvas `fillText`
legitimately rasterise differently — and it is confined to edges: **flat-pixel
error is 0.00–0.19/255**. Through the blur the surface actually applies, nothing
exceeds 6/255 anywhere.

Each of those numbers started far worse, and each fix is recorded in the source:

- **A half-pixel baseline** put every glyph one device pixel low. Raw MAE 6.09 →
  0.03. Caught by a registration test (shift ±1px, re-measure), not by looking.
- **Borders were never painted.** Panel max 123 → 35.
- **The default gradient direction.** Chromium's *computed* value omits the
  direction whenever it is the default, so `linear-gradient(180deg, …)` arrives
  with no direction token; the parser guessed horizontal. A surface sitting
  entirely on one measured MAE 7.97 against 0.29 over prose. Now built from the
  spec's gradient-line geometry: 7.97 → 0.75.
- **Premultiplied alpha.** CSS interpolates gradients premultiplied, canvas does
  not, so `#eef0f3 → transparent` fades out light in CSS and travels through mid
  grey on a canvas. `.scroll-edge-top-overlay` is exactly that gradient and it
  covers the toolbar: **MAE 46.65, 98% of pixels off by >32**. Zero-alpha stops
  now borrow their neighbour's RGB. 46.65 → 0.65.

> The skip-counter said nothing about the last two, because the painter did not
> skip those elements — it drew them wrong. A gate that counts what a component
> *declined* to do is blind to what it did incorrectly.

## 3 · Is the result better than the SVG path? **Yes, with one caveat.**

Shots in `.glass-shots/lab/*-3-svg.png` vs `*-4-gl.png`. The GPU path shows the
compressed, partly mirrored rim strip that reads as thick glass — the thing the
8-bit displacement map cannot do without combing — and it is sharp at any size
because there is no map to magnify.

Two things had to be ported from the shipping engine before that was true:

- **The smooth-max normal.** A rounded rect's SDF gradient is genuinely
  discontinuous on the medial axis, and the first shader drew a diagonal seam out
  of every corner. `liquid-glass-worker.ts` carries `GRAD_K = 40` for exactly
  this. Note it is used for the **gradient only** — using the smooth SDF for the
  distance too replaced the seam with four caustic wedges, because over that band
  it moves the bevel itself.
- **The bevel constant.** `BEZEL_FRAC = 0.34` is a fraction of the **half** short
  side. Applying it to the full short side doubled every bevel and pull.

**The caveat:** the shader does not yet implement the filter chain's
`CHROMA_FLATTEN` — the pointwise luma fade that stops prose competing with the
surface and is what pays for the app's low blur. That is a few lines of shader,
but it is not written, so the GL shots read busier than the shipping ones.

---

## What is ruled out, and why

**HTML-in-Canvas (`drawElementImage` / `texElementImage2D`).** Chromium 148 —
which is exactly what Electron 42 ships — has it, and with
`--enable-blink-features=CanvasDrawElement` it works: measured **0.033 ms** to
rasterise an element carrying a mask, a filter *and* a transform, all with
Chromium's own painter. It would make `backdrop-reconstruct.ts` unnecessary.

It cannot be used here:

```
Only immediate children of the <canvas> element can be passed to DrawElementImage.
```

It is an API for canvas-*hosted* UI, not for photographing an app that already
exists. Reparenting a **clone** into a hidden `<canvas layoutsubtree>` fails too
— `No cached paint record for element` — and on an `opacity: 0` canvas it does
not throw at all, it silently draws nothing. Using it would mean moving the
editor inside a canvas, which the API's own docs say costs independent scrolling
and animation.

Re-test with `npm run probe:draw-element` when Chromium relaxes the constraint;
if it ever accepts an arbitrary same-origin element, it replaces the hand painter
outright.

## What the hand painter cannot express

Counted live under every glass surface in the running app
(`npm run probe:glass-unsupported`): **34 transforms, 33 masks, 9 filters**.
Today **none of them paint anything** — they are masks on empty boxes, the
edge-glow layers and the orb canvas — so they cost nothing. That is a fact about
the app's current CSS, not a property of the painter, and it is the standing risk
in this approach: the first painting element with a mask under a glass surface is
a silent visual regression.

Also unimplemented: box-shadows, blend modes, non-linear gradients, `background-image`
that is not a gradient, stacking order (the walk is DOM order), and images.

## How to re-run everything

```sh
npm run dev                       # in another shell
npm run probe:glass-backdrops     # what is behind each surface
npm run probe:refraction-cost     # the 2D painter's ceiling
npm run probe:glass-lab           # fidelity + GPU cost + shots
npm run probe:glass-fidelity      # registration, flat-vs-edge, post-blur
npm run probe:glass-real-app      # the same, against the running editor
npm run probe:draw-element        # the HTML-in-Canvas route
```
