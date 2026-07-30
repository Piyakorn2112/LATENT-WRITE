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
npx tsx scripts/test-known-names.ts         # cold-start name resolution ranking (100% — regression lock)
npx tsx scripts/test-chapter-observation.ts # "This chapter" brief: contract, not wording (100%)
npx tsx scripts/test-event-detect.ts        # EVENT DETECTION vs the hand-annotated gold set (gated)
npx tsx scripts/ood-language-audit.ts       # OUT-OF-DISTRIBUTION audit: speech, label-free (~4 min)
npx tsx scripts/ood-event-audit.ts          # OUT-OF-DISTRIBUTION audit: events, label-free
```

## Event detection — read the plan before touching it

`src/lib/narrative-events.ts` replaced `event-detect.ts`. Every rule in it answers
a measured failure; the header explains which, and `plans/narrative-event-engine.md`
has the numbers. `event-detect.ts` is kept ONLY so the suite can score against it —
do not extend it.

Two suites, and they do different jobs:

- `test:event-detect` scores **103 hand-annotated events across 19 chapters of
  EIGHT books by seven authors** with ±1 paragraph tolerance.
  This is what you tune against. `--detail` prints every miss and false positive;
  `FLOOR=0.4` sweeps the operating point.
- `audit:ood-events` reports label-free health over both whole manuscripts, split
  in-distribution vs held out. **Do not tune against this one** — tuning against a
  held-out measure destroys the only thing it is for.

Three rules that are easy to break by "simplifying":

1. **The fixture self-checks before scoring.** Every gold event carries an
   `evidence` clause and the harness confirms it occurs where it claims. Without
   it, a changed paragraph split turns the whole gold set into plausible-looking
   near-misses and the suite reports a confident, meaningless number.
2. **Read `analysis.peakParagraph`; never invert `tensionCurve`** to find a
   paragraph. The curve is a ≤30-bucket reduction and a bucket index maps back to
   a bucket *centre*; doing it that way named a non-peak paragraph 47.5% of the time.
3. **The LM must not relabel.** `narrative-events.ts` builds labels from the clause
   that triggered detection, inside the timeline's real 28-character budget. The
   old LM pass replaced them with picked sentences, which is where the truncated
   fragments came from. It does dedup and detail tags only.

Type accuracy is reported, not gated: a trained-literary-scholar event typology
reached Krippendorff's α of only 0.57-0.75 on a coarser scheme than this one, so
moderate type agreement is a property of the domain, not a bug.

**The number that describes the PRODUCT is precision@4**, because the timeline
renders four chips. Current, on the eight-book set: precision@4 45.9%, major
events reaching the top four 25.4%, major events found anywhere 39.0%, overall
precision 26.6%. Quote precision@4, and never quote a figure without saying which
gold set produced it. Every smaller set was flattering: 1 author / 22 events gave
precision 57.1%, and it meant nothing.

**Run `npm run analyse:event-signals` before touching any scoring weight.** It
measures, per signal, the hit rate of candidates where that signal fired against
those where it did not. That measurement found every bonus in the scorer to be
ANTI-predictive and the ranking inverted: top third by confidence hit 19.1%,
bottom third 33.8%. Weights are now fitted to measured lift, and the lifts are
conditional on which candidates survive the gates, so re-run it after any gate
change.

**Known weakness, deliberately left:** `action` is 54.0% of events on the held-out
manuscript. It is the widest verb class and a domestic novel is made of people
opening doors. See the plan's section 4.

**Held-out audit rule:** the curated suites above hand `knownNames` in explicitly, so
they can never catch a failure in the extraction that produces those names (this
exact blind spot shipped a 0%-cast-recall bug). `ood-language-audit.ts` runs the
real pipeline over two full manuscripts (Hollow Iris = in-distribution, The Root
Crown = held out) and reports UNKNOWN rate, mean confidence, and default↔high
disagreement (a label-free accuracy lower bound). Run it after any change to
`world-data.ts` extraction/ranking or `speech-detect.ts` attribution. Reference
numbers post-fix (2026-07-29): UNKNOWN@default 3.9% / 4.7%, mean conf 0.79 / 0.78,
default↔high conflict 3.6% / 14.3% (Hollow Iris / Root Crown, cold-start condition A).

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

**The refraction is the ORIGINAL squircle→Snell model** (`DISP_PX` 40, no
displacement cap). A fold-free variant was built and reverted twice; the
engine does not contain it. Read the next paragraph before proposing another.

**Known artifact, understood and accepted: the sampling folds.** `y' = y +
disp(y)` must increase or the rim shows a mirrored, compressed copy of interior
content. With 40px of pull into the toolbar's 17.6px bezel it decreases for 8
of the first 22 rows — 28.4px of backdrop squeezed REVERSED into the top ~8px,
mirrored at the bottom. Over body text the two bands land on different lines
crushed ~3.5:1, which reads as "the top edge leans left and the bottom leans
right". It is NOT a rotational field: the map's R channel is exactly 128 across
the whole middle span, and a grating measures `dx(y) = 0.000` at every row.

Removing it is arithmetic, not tuning: fold-free needs peak ≤ `bezel/max|g′|`,
so a 44px-tall bar cannot carry 40px of pull (its ceiling is the 22px
half-height). Every fold-free profile therefore trades displacement on THIN
chrome — that trade was rejected. Panels are wide enough to be fold-free at the
full 40px, so the fold could be confined to thin chrome per-preset if it is
ever revisited. Do not "fix" it silently.

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
