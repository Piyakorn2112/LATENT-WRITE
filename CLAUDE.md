# Glass Editor

Novel writing desktop app with an in-app renderer chat (Claude AI) and a suite of prose analysis widgets.

## Project layout

- `src/components/` — React components (`RendererPanel.tsx` is the renderer chat handler)
- `src/lib/` — pure analysis libraries (speech-detect, chapter-analysis, repetition, prose-profile, continuity, character-voice, chapter-dna, paragraph-risk, chapter-diff, local-review)
- `scripts/` — TDD accuracy test suites (run with `npx tsx scripts/<name>.ts`)
- `src/components/widgets/` — display widgets backed by `src/lib/` modules

## Working on the codebase

Read before editing. When modifying any `src/lib/` module, check whether a TDD suite exists in `scripts/` and run it first to establish a baseline. All widget-backing libraries target ≥85% accuracy.

Run a specific suite:
```
npx tsx scripts/accuracy-suite.ts           # speech detection (DEFAULT ≥82%, HIGH ≥96%)
npx tsx scripts/scan-accuracy-suite.ts      # local scan heuristics (recall ≥70%, precision ≥80%)
npx tsx scripts/test-chapter-analysis.ts    # chapter analysis
npx tsx scripts/test-repetition.ts          # repetition detection
npx tsx scripts/test-prose-profile.ts       # prose profile (POV/tense)
npx tsx scripts/test-grammar-check.ts       # grammar check
npx tsx scripts/test-continuity-voice.ts    # continuity + voice
npx tsx scripts/test-chapter-dna.ts         # chapter DNA builder
npx tsx scripts/test-paragraph-risk.ts      # paragraph risk scoring
npx tsx scripts/test-chapter-diff.ts        # chapter diff
npx tsx scripts/test-prose-segments.ts      # prose primitives: tokenizer/quotes/markers (≥95%)
npx tsx scripts/test-auto-format.ts         # auto-paragraph + auto-scene-break (≥90%)
npx tsx scripts/test-tension-scene.ts       # chapter tension scanner + scene labels (calm/elevated ≥85%)
npx tsx scripts/test-cast-roles.ts          # cast influence roles + chapter-role direction (clear cases)
```

`auto-paragraph.ts` and `auto-scene-break.ts` are the two one-shot formatting
passes; both build on the shared `prose-segments.ts` primitives (sentence
tokenizer, apostrophe-safe quote analyzer, discourse-marker taxonomy). Edit
those three together and run the two suites above.

Test suites exit with code 1 if below target.

## Liquid glass — treat as pixel-frozen

`src/lib/liquid-glass-worker.ts` (per-pixel displacement-map math) and
`src/lib/liquid-glass-filter.ts` (SVG filter chain) are performance-tuned under
a hard **zero-visual-change** constraint. The look is signed off; do not retune
blur, bezel, refraction, or saturation while optimising.

The look was deliberately re-signed-off ONCE, 2026-07-26 (owner-mandated): the
**fold-free refraction model** — profile `g(t)=(1−t)^1.25` with a per-shape
displacement cap (`effectiveDisp`) and LOCAL corner attenuation baked into the
map (`MapRequest.dispPx`), replacing the Snell/squircle profile whose singular
rim slope guaranteed mirrored fold-over on every shape. The lens alone keeps
the legacy model (`profile:"snell"`).
`scripts/liquid-glass-baseline.ts` was re-frozen to the new math at the same
time and says so in its header; the zero-visual-change discipline continues
from that baseline.

**The rule that matters: sampling must stay monotone.** `y' = y + disp(y)` has
to increase, or the rim shows a mirrored, compressed copy of interior content.
That is what "the top edge leans left and the bottom leans right" turned out to
be — not a rotational field. Peak displacement must stay under
`bezel / PROFILE_SLOPE`, so a FLATTER falloff buys more strength for the same
budget; don't raise the exponent to "soften" the look, it costs displacement
almost linearly. Panels are never limited by this (wide bezel → they keep the
full `DISP_PX`); only chrome thinner than ~2× the displacement is capped, and
there it is arithmetic — a 44px-tall bar cannot carry 40px of fold-free pull.

Two diagnostics, both dev-only pages driven by scripts:
- `glass-direction.html` — glass over vertical + horizontal stripe fields;
  makes fold-over and gradient swirl visible at a glance.
- `glass-shear.html` + `node scripts/glass-shear.cjs` — recovers the
  displacement field sub-pixel from the phase of a 16px grating's first
  harmonic, and prints whether it is symmetric. Use it before believing any
  claim about refraction *direction*. ⚠ `capturePage()` returns DEVICE pixels;
  scale every coordinate, or the analyser reads the wrong region and reports
  a confident zero.

Earlier deliberate exception, approved the same day: the knob presets'
`MAP_OVERSAMPLE` went 12 → 3. **Do not raise it back.** At 12 the two control
knobs cost 13.3 ms/frame on an M1 Pro — about 40× the entire 1100×44 toolbar —
because `filterRes` rasterises them at 4 device px per element px while the map
carried 12 texels per element px, so the compositor minified per pixel every
frame and discarded almost all of it.

Three harnesses prove a change is invisible. Run all three:

```
npm run test:glass-exact     # map bytes vs a frozen copy of the original math
npm run test:glass-fuzz      # same, over 1200 randomised geometries
npm run dev                  # then, in another shell:
npm run test:glass-pixels    # real-Chromium screenshot diff of /glass-verify.html
npm run bench:glass-gpu      # real-GPU cost per frame, per scene (needs a real GPU)
```

`bench:glass-gpu` is a measurement, not a gate. It needs the dev server and a
real GPU — it refuses to report on software compositing, because those numbers
would describe the CPU rasteriser instead. Note that a backdrop-filter only
costs anything when its backdrop *changes*, which is why the bench page animates
a canvas behind the glass; benchmarking a static page measures nothing.

`test:glass-pixels` needs a reference first (`npm run test:glass-pixels:save`
on the unmodified code). `scripts/liquid-glass-baseline.ts` is that frozen
oracle — **never** "fix" or update it to match new behaviour; it exists to
disagree. Before trusting a pass, confirm the harness can fail: perturb
`BEZEL_PX` by 1 and watch it go red.

Two properties the fast paths depend on, both verified empirically, both easy
to break by "simplifying":
- `Math.hypot(a, 0) === Math.abs(a)` exactly — but `Math.sqrt(a*a) !== Math.abs(a)`
  for subnormals (~5% of random inputs), so never swap hypot for that.
- `image/webp` at quality 1.0 is lossless, but PNG encodes 5-7x faster and
  2-4x smaller for these maps and decodes to identical pixels.

## Renderer chat commands — when to use which

The renderer chat in the app handles these slash commands. Use this decision table when the user asks about novel writing or which command to run:

| User wants to... | Command | Context mode |
|---|---|---|
| Quick prose/pattern scan (first pass, before anything else) | `/scan` | Compact — local heuristics + Claude diagnostic |
| Draft a new chapter | `/draft <N>` | Full |
| Build context packet before a complex draft | `/context <N>` | Full |
| Prose review / AI fingerprint pass | `/review <N>` | Full — includes voice, arc, neighborhood |
| World / lore consistency check | `/lore <N>` | Full — includes continuity signals |
| Assemble chapter into canon | `/assemble <N>` | Full |
| Update story artifacts after assembly | `/update <N>` | Full |
| Initialize a new novel project | `/init` | Full |

**Context rule:** `/scan` uses compact DNA (~100 tokens). All other commands use full context (~350 tokens + voice fingerprints + neighborhood context). This is automatic — do not try to override it.

**Ordering rule:** For a chapter going through the full pipeline, the correct sequence is:
`/context` → `/draft` → `/scan` → `/review` → `/lore` → `/assemble` → `/update`

`/scan` is always the first quality check after a draft exists. Do not run `/review` or `/lore` before `/scan` has been run once.

**Vague request routing:**
- "check for issues" → `/scan` (quick, cheap); escalate to `/review` if prose-level work is needed
- "review this" → `/review <N>`
- "something's wrong with the lore / world" → `/lore <N>`
- "is it ready?" → `/scan` if no scan exists; compare results against PRIMARY ≥7 gate
- "make it better" → identify which dimension is weak from scan results, then run the targeted command

## Novel writing system

Protocol files are at `../novel-writing-system/`. Do not modify them.
