# Canvas glass: what the experiment measured, and why it was reverted

**Status: reverted.** The code is gone from `main`; this is the record so nobody
has to run it again to learn the same things.

The idea: stop asking the compositor for a backdrop via
`backdrop-filter: url(#…)`, and instead **reconstruct** what lies under each
glass surface by repainting the DOM into a canvas, then refract those pixels
per pixel in float on the GPU — the method `KnobGlass` already uses for the
control knobs.

The commits, if the detail is ever wanted:

| | |
|---|---|
| `55e7c21` | the sandbox / feasibility study |
| `ecbf23c` | the engine, on the panel-class surfaces |
| `8cbbb7e` | knob-shaped bevel, fallback off, transition deferral |
| `b9c7dd5` | display list, highlight fixes, thicker edge |

Everything below was measured on this machine at dpr 2, against the running
app, with harnesses that were in those commits (`verify:canvas-glass`,
`diff:canvas-glass`, `probe-glass-realtime`, `probe-glass-real-app`).

---

## It worked, in the narrow sense

- **Reconstruction is accurate.** Against real screenshots of the running app,
  through the 3px blur the glass applies: **MAE 0.11–1.73/255, max 7**. Flat
  pixel error 0.00–0.19 — all residual was glyph-edge antialiasing, where DOM
  text and canvas `fillText` legitimately differ.
- **The refraction is genuinely better.** Float sampling with hardware bilinear
  has no 8-bit quantisation, so the compressed rim strip that reads as thick
  glass has no combing, and it is sharp at any size because there is no map to
  magnify.
- **The GPU cost is nothing.** The shader draw is 0.01–0.02 ms at every size
  including a 3.9M-pixel overlay, against 151 ms for the same optics in JS.
- **Layering can be preserved exactly.** Canvas at `z-index: -1` under a
  restored stacking context (`isolation: isolate` replacing the one
  `backdrop-filter` was already creating) left `::before` and `::after`
  untouched: the edge-glow band moved by **0.0–0.8/255**.

## Why it is not worth having anyway

**1 · It costs main-thread time, permanently, for work the compositor does for
free.** Even after the display-list rewrite the DOM walk was **2.2 ms median
per frame** during a scroll. `backdrop-filter` costs zero main-thread time. The
app has an analysis pipeline, an assistant runtime and a live orb competing for
that budget, and glass is the least important thing in it.

**2 · The painter is a partial reimplementation of CSS, and it drifts.** It
never handled transforms, filters, masks, blend modes, box-shadows,
non-linear-gradient backgrounds, `background-size`/`position`, stacking
contexts, or `z-index`. Under live glass in a normal app state there were
already **34 transforms, 33 masks and 9 filters**. Every future CSS change
anywhere near a glass surface is a chance for a silent visual regression, and
the failure mode is not a crash — it is a slightly wrong pixel nobody notices
for a month.

**3 · The safety net, honestly applied, disables the feature.** The gate that
hands a surface back to `backdrop-filter` when the painter cannot express
something underneath is the right design. With it ON, the two constructs that
disqualify nearly every surface in this app are **other glass surfaces'
`box-shadow`** and **SVG icons**. The engine only "worked" with its own safety
switched off.

**4 · Every bug produced confident, silent, wrong output.** Not one of these
threw:

- **Colours regexed into numbers.** Chromium serialises modern colours as
  `color(srgb 0 0.65098 0.588235 / 0.2)`. Pulling `[\d.]+` out and writing
  `rgba(0, 0.65098, 0.588235, 0.16)` gives BLACK at 16% instead of teal —
  `rgba()` takes 0–255, `color()` gives 0–1. Every number present, wrong units.
  This is what made the entity/action highlights render nearly black.
- **Premultiplied alpha.** CSS interpolates gradients premultiplied; canvas
  does not. `#eef0f3 → transparent` fades out light in CSS and travels through
  mid grey on a canvas. One such overlay across the toolbar: **MAE 46.65/255,
  98% of pixels off by more than 32**.
- **The default gradient direction.** Chromium's *computed* value omits the
  direction whenever it is the default, so `linear-gradient(180deg, …)`,
  `to bottom` and the bare form all arrive with no direction token. Guessing
  horizontal painted them sideways: 7.97 vs 0.29 over prose.
- **A half-pixel text baseline.** `lineBox.top + halfLeading +
  fontBoundingBoxAscent` is the textbook construction and is wrong by one
  device pixel everywhere; canvas font metrics and the layout engine's ascent
  are not obliged to agree. MAE 6.09 → 0.03 once measured from the page
  instead (an empty `inline-block` with `vertical-align: baseline` has zero
  height, so its box top IS the baseline).
- **Multi-layer backgrounds parsed as one**, by slicing from the first `(` to
  the last `)` — which spans every layer.
- **Inline elements painted across the union of their line boxes**, so a
  wrapped entity mention would paint a slab of tint across the paragraph.

Six separate ways to be quietly wrong, in the part of the system whose entire
job is to look right.

---

## Things worth keeping, whatever happens to the glass

- **`backdrop-filter` creates a stacking context.** Removing it silently
  changes `mix-blend-mode` on descendants, because `plus-lighter` blends
  against its stacking context. `isolation: isolate` restores it without
  changing z-order. Anything that touches `.liquid-glass`'s filter needs to
  know this.
- **A skip-counter is blind to what a component draws WRONG.** Counting
  constructs the painter "cannot express" said nothing about the two worst
  errors above — it did not skip those elements, it drew them incorrectly. Gate
  on *carries an unsupported construct AND actually paints something*.
- **Per-surface counters cannot be differenced across a remount.** Opening the
  analysis panel remounts its subtree, so anything keyed to an element is
  re-created with its counters at zero, and a harness sampling them reads 0 —
  indistinguishable from "nothing happened". Totals have to live at module
  scope.
- **A missing debug hook reads exactly like a working system doing nothing.**
  A probe returning a `-1` default has a delta of 0. Two separate investigations
  here chased bugs that did not exist because a stale dev bundle had no hook.
- **`transitionrun`/`transitionend` do not reliably pair.** An element removed
  mid-transition never ends; a cancel can arrive alongside an end. Counting
  them leaves the count wrong in a direction that either freezes everything or
  silently defeats whatever it guards. Use a deadline that expires on its own.
- **`preserveDrawingBuffer: false` means `readPixels` after the frame returns
  zeros.** Measure ink from a composited screenshot, not the GL buffer.

## Ruled out, with a reason rather than a guess

**Chromium's HTML-in-Canvas API** (`drawElementImage` / `texElementImage2D`).
Chromium 148 — which is exactly what Electron 42 ships — has it, and behind
`--enable-blink-features=CanvasDrawElement` it works: **0.033 ms** to rasterise
an element carrying a mask, a filter *and* a transform, with Chromium's own
painter. It would have made the hand-written painter unnecessary, and with it
every one of the six bugs above.

It cannot be used to photograph an app that already exists:

```
Only immediate children of the <canvas> element can be passed to DrawElementImage.
```

Reparenting a clone into a hidden `<canvas layoutsubtree>` fails too — `No
cached paint record for element` — and on an `opacity: 0` canvas it does not
throw, it silently draws nothing. It is an API for canvas-*hosted* UI. Using it
would mean moving the editor inside a canvas, which its own documentation says
costs independent scrolling and animation.

**If Chromium ever relaxes that constraint to accept an arbitrary same-origin
element, the whole calculation changes** — the painter disappears, the CSS-drift
risk disappears, and only the main-thread cost of the texture upload remains.
That is the one thing worth re-checking before anyone tries this again.

## If it is ever revisited

The blocking question is not the optics, which are solved and cheap. It is:
**where do the backdrop pixels come from without reimplementing CSS?** Until
there is an answer to that which is not "walk the DOM by hand", this stays
reverted.
