# Faster Gaussian blur for the liquid glass, researched and measured

**Date** 2026-08-08 · **Hardware** Apple M1 Pro, ANGLE Metal, real GPU, vsync and
frame cap disabled · **Outcome** no change made, and the reason is a measurement

## The question

Can we replace the glass blur with a faster or more efficient algorithm, so it
costs less, while refraction stays exactly as it is?

## Short answer

No, because the blur already costs nothing. It is not our code, it is Chromium's
Skia blur, and at the sigmas this app ships Skia is already running the same
optimised algorithm the research literature recommends. Benchmarked end to end,
removing the blur entirely recovers **0.00 ms per frame**, and so does raising it
to ten times its current strength. There is no resource to reclaim here.

## 1. What the blur is today

It is the **browser's own blur**, not a custom one. There is no hand written blur
anywhere in this repository.

The glass is one SVG filter graph per element, attached as
`backdrop-filter: url(#id)` (`src/lib/liquid-glass-filter.ts`). The chain is

```
feImage(displacement map)
  → [feGaussianBlur]        map antialias, control knobs only
  → feDisplacementMap       the refraction
  → [feGaussianBlur]        THE BLUR IN QUESTION
  → [feColorMatrix]         chroma flatten and saturate, folded into one matrix
```

`feGaussianBlur` is a declaration. Chromium rasterises it with Skia. The sigma is
chosen per surface class in `readBlur()`:

| surface | sigma (px) |
|---|---|
| range and toggle knobs | 0, pass dropped entirely |
| loading lens, control knob | 0.2 |
| toolbar, sidebar tabs, action group, status pill | 0.9 |
| annotation panel | 1.4 |
| settings panel | 2.0 |
| default, including both popovers | 3.0 |

**Every one of these is small.** That single fact decides the whole question.

## 2. What Skia already does

From `src/core/SkBlurEngine.h` in Skia:

```cpp
// TODO(b/297393474): Update max linear sigma to 9; it had been 4 when a full 1D
// kernel was used, but never updated after the linear filtering optimization
// reduced the number of sample() calls required.
static constexpr float kMaxLinearSigma = 4.f;

static int SigmaToRadius(float sigma) {
    return IsEffectivelyIdentity(sigma) ? 0 : sk_float_ceil2int(3.f * sigma);
}
```

So on the GPU path Skia already applies the two headline optimisations:

1. **Separable two pass.** A 2D Gaussian factors into a horizontal 1D pass and a
   vertical one, turning cost per pixel from O(r²) into O(r). This is the single
   biggest win available for any Gaussian and it is already taken.
2. **Linear sampling.** Adjacent kernel taps are folded into one bilinear texture
   fetch by solving for a weight and an offset such that the hardware's own
   interpolation reproduces the pair. This roughly halves the fetch count. Also
   already taken.
3. **Progressive downscale above sigma 4.** For large blurs Skia repeatedly
   halves the image, blurs with a small kernel, and scales back up. Irrelevant to
   us, because every sigma we ship is under the threshold.

At sigma 3 the radius is `ceil(3 × 3) = 9`, so a 19 tap kernel becomes about 10
bilinear fetches per axis, 20 per pixel over roughly 10⁵ pixels of filter region.
On an M1 Pro that is on the order of 0.02 ms, which is what the benchmark below
finds, which is to say nothing.

## 3. The algorithm families, and why none of them apply

Everything below is a real and well established technique. Each one is designed
for a regime we are not in.

| Algorithm | What it buys | Why it does not help here |
|---|---|---|
| **Separable Gaussian** | O(r²) to O(r) | Already what Skia runs |
| **Linear/bilinear tap folding** | halves fetches | Already what Skia runs |
| **Triple box blur** | O(1) per pixel regardless of radius, and it is what the SVG spec itself prescribes as an approximation | Three passes instead of one. At radius 9 the true kernel is already cheaper than three full region passes, and it is exact rather than approximate |
| **Stack blur** | O(1), better quality than box | Same problem, and it is a sequential running sum that maps poorly to a fragment shader |
| **Recursive IIR (Deriche, van Vliet–Young–Verbeek)** | O(1), cost independent of sigma | Inherently sequential along each scanline. Excellent on CPU or in a compute shader, bad in the fragment pipeline, and it only pays back at large sigma |
| **Kawase** | fewer taps than Gaussian at equal perceived radius | Needs several ping pong passes. At our radius the pass overhead exceeds the kernel it replaces |
| **Dual Kawase / dual filtering** (Bjørge, SIGGRAPH 2015) | the fastest known large radius blur, 1.5× to 15× over Gaussian | Two extra render targets and a down then up chain. The quoted speedups are at large radii. It also quantises to roughly power of two radii, so it cannot express 0.9 or 1.4 without an extra blend pass |
| **Compute shader with shared memory** | avoids redundant fetches | Not reachable from `backdrop-filter`. Would require abandoning the CSS filter path entirely |

The pattern is consistent. **All of these trade kernel width for extra passes and
extra render targets.** That is a good trade when the kernel is 50 or 200 pixels
wide. Our widest kernel is 19 taps before bilinear folding, about 10 after. There
is nothing left to amortise.

The only way to run a genuinely custom blur kernel would be to stop using
`backdrop-filter` and reconstruct the backdrop ourselves in WebGL. That was tried
in this codebase already and reverted, because reconstructing the backdrop cost
2.2 ms per frame to do what `backdrop-filter` does for free.

## 4. The measurement

Method, following the project's existing GPU discipline. A `backdrop-filter` only
costs the compositor when its backdrop changes, so a static page measures nothing.
The harness animates a canvas behind the glass every frame, runs in a visible
hardware accelerated window with `--disable-gpu-vsync` and
`--disable-frame-rate-limit`, and reports the median of nine 500 ms windows.

The ablation drops the tail `feGaussianBlur` **while pinning `overflow`**, so the
filter region and the baked displacement map stay byte identical and the delta
prices the blur pass and nothing else.

### Cost of the blur pass

| scene | surfaces | glass total | blur pass |
|---|---|---|---|
| idle | 3 | 0.353 ms | −0.021 ms |
| working | 5 | 1.433 ms | +0.039 ms |
| settings | 6 | 0.375 ms | −0.006 ms |
| all | 8 | 1.409 ms | −0.017 ms |
| panel alone | 1 | 0.368 ms | −0.006 ms |
| popover alone | 1 | 0.151 ms | −0.007 ms |
| toolbar alone | 1 | 0.311 ms | −0.003 ms |

Most deltas are **negative**, which is physically impossible. That is the signature
of a quantity below the noise floor.

### Sigma sweep, region pinned

| scene | sigma 0 | sigma 0.9 to 3 (shipped) | sigma 12 | sigma 30 |
|---|---|---|---|---|
| working | 1.459 ms | 1.449 | 1.448 | 1.425 |
| popover | 0.167 ms | 0.156 | 0.151 | 0.149 |

**A thirty pixel blur costs no more than no blur at all.** Whatever the glass is
spending, it is not spending it here.

### Canaries, because "no difference" is what a broken test also reports

Both ablations were verified to actually fire before any conclusion was drawn.

- Blur off: tail `feGaussianBlur` count went 11 → 0 across 13 filters, and the
  rendered PNG changed (4,173,445 → 3,559,146 bytes).
- Sigma 30: all 11 tail passes present with `stdDeviation="30"`, PNG changed
  (4,173,445 → 3,173,380 bytes).
- The two control knobs correctly kept their map antialias blur and correctly
  reported zero tail passes in both runs, since they ship sigma 0.

## 5. What the glass actually spends, for when this comes up again

Two findings fell out of the same runs. Both are refraction side, so both were
left alone under the "refraction stays exactly the same" constraint.

**The cost is region rasterisation, not any single primitive.** The filter region
is sized `disp + blur*2 + 4`, and `disp` is 40 while blur contributes at most 6.
For the popover that is a 420×280 region around a 320×180 element, so **51% of
every rasterised pixel is margin** that exists purely so refraction has somewhere
to reach.

**Overlapping regions are superadditive.** Measured alone, idle chrome 0.353 plus
panel 0.368 plus popover 0.151 is 0.872 ms. Measured together as the `working`
scene it is 1.433 ms. The missing 0.56 ms appears only when the surfaces coexist,
and their filter regions overlap even though the elements themselves do not.
`working` is the app's common editing state and its most expensive one, costing
roughly 4× the `settings` scene despite having fewer surfaces.

If blur ever needs to get cheaper, the lever is region area and overlap. There is
also an already documented and deliberately untaken win in the same area, the
`CHANNEL_GAIN` region correction noted in `liquid-glass-filter.ts`, worth about 4×
less knob map work at the price of 1108 sub pixel changed pixels.

## 6. Recommendation

Ship nothing. The finding is recorded in `liquid-glass-filter.ts` at the blur
site so the next person does not repeat the search, and two bench scenes
(`popover`, `panelPopover`) were added to `src/glass-gpu-bench.ts` so the numbers
above are reproducible with `npm run bench:glass-gpu`.

## Sources

- [Skia `SkBlurEngine.h`](https://raw.githubusercontent.com/google/skia/main/src/core/SkBlurEngine.h) and [`SkBlurEngine.cpp`](https://raw.githubusercontent.com/google/skia/main/src/core/SkBlurEngine.cpp)
- [Video Game Blurs, and how the best one works](https://blog.frost.kiwi/dual-kawase/)
- [An investigation of fast real-time GPU-based image blur algorithms, Intel](https://www.intel.com/content/www/us/en/developer/articles/technical/an-investigation-of-fast-real-time-gpu-based-image-blur-algorithms.html)
- [Kawase Dual Filter Blur](https://www.leejiakeat.online/blog/kawase-dual-filter-blur-urp)
- [Compute shaders in graphics, Gaussian blur](https://lisyarus.github.io/blog/posts/compute-blur.html)
- [MDN, `feGaussianBlur`](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/feGaussianBlur)
