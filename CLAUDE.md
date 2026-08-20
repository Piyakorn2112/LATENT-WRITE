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
npx tsx scripts/analyse-event-signals.ts    # per-signal LIFT — run before any weight change
npx tsx scripts/probe-entity-funnel.ts      # where entity-subject candidates die
npx tsx scripts/probe-missed-majors.ts      # what the engine is BLIND to, by class
npx tsx scripts/probe-lm-blend.ts           # does the LM blend actually re-rank?
npx tsx scripts/probe-type-mix.ts <book>    # what is behind a collapsed type mix
```

## Event detection — read the plan before touching it

`src/lib/narrative-events.ts` replaced `event-detect.ts`. Every rule in it answers
a measured failure; the header explains which, and `plans/narrative-event-engine.md`
has the numbers. `event-detect.ts` is kept ONLY so the suite can score against it —
do not extend it.

Two suites, and they do different jobs:

- `test:event-detect` scores **410 hand-annotated events across 66 chapters of
  FOURTEEN books by thirteen authors** with ±1 paragraph tolerance, spanning
  Victorian British, American modernist, Canadian YA and adventure registers.
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

**The number that describes the PRODUCT is precision@BUDGET**, where the budget
is `TIMELINE_CHIP_BUDGET` in `narrative-events.ts` — currently 3. Current, on the
FOURTEEN-book set: precision@3 49.7%, major events SHOWN 22.4%, major events
found anywhere 44.3%, overall precision 31.7%. Quote precision@3, and never quote a
figure without saying which gold set produced it. Every smaller set was
flattering: 1 author / 22 events gave precision 57.1%, and it meant nothing.

**The chip budget has ONE definition and three consumers.** It used to be three
different answers: `TimelineGraphFull` capped at 3, `TimelineGraph` had no cap at
all and drew every event the engine emitted (up to 40 on a long chapter), and the
suite hardcoded 4 — so the gate scored a view nobody had. All three now import
`TIMELINE_CHIP_BUDGET`. Re-measuring at the real budget moved precision@N only
50.7% → 49.1% but nearly halved major-events-shown, 30.5% → 16.9%, because three
slots cannot hold as many. Nothing regressed; the measurement got honest. Same
applies to `LABEL_BUDGET`, which the suite had also re-declared independently.

**Run `npm run analyse:event-signals` before touching any scoring weight.** It
measures, per signal, the hit rate of candidates where that signal fired against
those where it did not. That measurement found every bonus in the scorer to be
ANTI-predictive and the ranking inverted: top third by confidence hit 19.1%,
bottom third 33.8%. Weights are fitted to measured lift. Three things it now
reports that are easy to misread:

- **Lifts are conditional on the gates.** Re-run after ANY gate change. Fixing
  the noun-phrase walk moved the candidate pool 205 → 243 and five signals
  changed sign, including `pronoun-agent` (+8.8 → −4.4) and `-habitual`
  (+11.6 → −0.0). Neither fit was wrong; a signal's value depends on what it
  competes against.
- **Nested signals have confounded raw lift.** A feature that can only fire
  inside another (`unspecified-entity` inside `entity-subject`) shows the
  parent's strength, not its own. The analyser detects ≥90% containment
  automatically and reports the within-parent number. Weight on that one.
- **Read the TOP-N separation, not the median split.** They came apart:
  precision@N rose 47.5% → 50.0% while the median split stayed flat at 1.8pp,
  because the ranking is sharp at the top and noisy through the middle. Only the
  top-N cut costs a writer anything. It currently separates by ~20pp.

**A FAILED REFIT MEANS "NOT ENOUGH DATA TO FIT", NOT "NOTHING LEFT TO FIT".**
Fit #3 lost on 212 candidates and I concluded the weights had saturated. Wrong.
When the fixture tripled to 444, FOUR signs were wrong (`pronoun-agent` -0.20 vs
measured +6.3pp, `-pluperfect` -0.12 vs +5.4, `-chapter-close` -0.30 vs +11.8,
`-modal` +0.05 vs -3.7) and fixing them took precision@3 46.1% -> 50.4%. 212
candidates against 16 features cannot resolve a 5-point lift, so fit #3 was
fitting noise. **Re-run the analyser whenever the FIXTURE grows, not only when
the gates change.** A fifth pass tuning the largest remaining gaps then lost
(50.4% -> 49.6%), which is the real saturation point for this sample size.

**The LM PRUNES well and RANKS badly, and those are separate settings.**
`refineEventSalience` filters on the raw contrastive score and separately blends
it into confidence. The prune is where all the value is: without it precision@3
drops 50.9% → 43.9%. The blend was measured costing 1.8 points of precision and
1.7 of major coverage, so `weight` is now **0**. It was not inert — with pruning
disabled it reshuffled the top three in 78.9% of chapters and landed on exactly
the accuracy of not blending at all. Constant churn, zero gain: MiniLM's
event-vs-description judgement is good enough to prune with, not to rank with.
Chapter centrality still blends, re-swept to **0.6** (plateau 0.45–0.6).
The prune cut is a CLIFF, not a slope: −0.2 prunes 3 events, −0.05 prunes 65,
+0.1 prunes 174 of 204 and destroys the output.

**When a rate looks wrong, count the funnel — don't hypothesise.**
`npm run probe:entity-funnel` exists because four rounds of reasoning blamed the
wrong gate. Entity subjects are the engine's strongest signal and it produced six
of them; the standing theory was that `isSpecified` throttled them, and removing
that gate entirely yielded ONE extra candidate. One funnel run found the real
loss: 425 of 523 entity subjects (81.3%) failed to find a verb, because the
noun-phrase walk had carried the search past it. A rate says something is wrong;
a funnel says where.

**★ NORMALISE TYPOGRAPHY BEFORE PATTERN-MATCHING DIALOGUE.** Two bugs, one
character each, both invisible on reading and both costing real recall.
Detection runs per SENTENCE, so a multi-sentence utterance leaves the caller's
quote regex unable to find a closing quote and the string reaching
`classifyUtterance` keeps its opening `“` — every `^`-anchored rule then fails.
And real books are typeset with `’` (U+2019), so every contraction written as
`I'll` / `don't` / `weren't` silently never matched. Fixing both:
major recall 41.0% → 44.0%, precision@3 50.4% → 51.3%. Both fixes belong at the
top of `classifyUtterance`, not in each pattern.

**A first-person utterance is an event only when its verb is PERFORMATIVE.**
Austin's distinction, and it is load-bearing here. "I promise", "I refuse",
"I confess" change the situation between two people; "I am tired", "I saw him",
"I think so" do not, however fluent they are. The rule was twice written as a
frequency list of common first-person verbs and twice collapsed on a
dialogue-heavy author, because that list is precisely the vocabulary
conversation is made of: Austen ran to 84.4% then 64.9% "revelation", with a
chip on lines like "I do not cough for my own amusement". Performative verbs are
a small CLOSED class, which is why the cut generalises to registers unlike
Austen's. Narrowing to it: precision 28.9% → 33.3%, F1 35.7% → 39.2%, Austen
entropy 0.57 → 0.78, Doyle 0.66 → 0.81, and it *gained* a gold match while
removing 19 false positives.

**Two things measured and REJECTED — do not re-derive them.**
A trained ranker (`train:event-ranker`, logistic over the engine's own features,
leave-one-BOOK-out) beats the hand-written weights by +1.8pp on 204 candidates
and only **+0.8pp on 435** — the advantage SHRINKS as data grows, so labelled
data is not the constraint. And a model bake-off (`EMBED_MODEL=<id>`) found the
33MB MiniLM-L12 beating bge-small, gte-small AND the 113MB bge-base on every
metric; MTEB does not predict this task and 3.4x the parameters buys nothing.
Both point the same way: the limit is EXTRACTION — a better model or better
weights cannot find an event the extractor never proposed.

**Adding gold data LOWERS every number, five times running.** 22 events → 45 →
67 → 103 → 279, and precision@3 fell at each step with the engine untouched.
That is the ruler getting honest. Re-baseline the targets and record the reason
at the constant; never lower one for any weaker reason. Annotate with
`scripts/fixtures/ANNOTATION-GUIDE.md` and verify with `npm run gold:validate`
BEFORE merging — its one non-negotiable is that an annotator must never look at
the detector's output first.

**Previous known weakness, now closed:** `action` was 54.0% of events on the
held-out manuscript. It is 29.4% in-distribution / 36.2% held-out today, and no
corpus has a dominant type above 44% or entropy below 0.78.

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

## Knowledge ledger + local assistant

Spec and measured decisions: `plans/knowledge-ledger-and-local-adjudicator.md`.
The deterministic ledger (`knowledge-ledger.ts`, `knowledge-store.ts`) is a
high-recall candidate generator; a grammar-constrained local model
(`electron/assistant*.cjs`, Qwen3-1.7B in a utilityProcess) adjudicates. Only a
confident `break` ever surfaces, through `surfacedKnowledgeFindings` — the ONE
display selector. Writer rulings are durable. The assistant is generic: entity
scan review (`entity-review.ts`) is the second consumer.

- `npm run test:knowledge-ledger` — funnel gates, synthetic-break recall ≥85%,
  monotonicity, anchor retirement (DEV books only; never tune on TEST)
- `npm run test:evidence-pack` — pack determinism, budget, drop order, snapshot
- `npm run verify:assistant-runtime` — utilityProcess runtime, cancellation,
  RSS reclaim (Electron, needs the downloaded model; SKIPs without it)
- `npm run verify:assistant-tasks` — live model gates for ALL assistant tasks
  (adjudication, entity review, timeline chips); fixtures regenerate from the
  real modules. ★ the wire label is `no_way_to_know` because `break` was
  UNREACHABLE for the small model — do not "simplify" it
- `npm run test:chip-picker` — pure chip-picker gates: normalizeChipPicks,
  chipKeyFor stability, selectDisplayChips fallback identity. ★ chips are
  PICKED BY RANK from the heuristic engine's own candidates and relabeled —
  the model never invents an event; all display goes through
  selectDisplayChips (the one-selector rule)
- `npm run test:entity-review` / `npm run test:chapter-summary` — model-free
  gates for the scan reviewer and the summariser
- `npm run verify:widget-help` — every widget can explain itself and says
  nothing until asked

★★ **REASON BEFORE LABEL in every grammar-constrained schema.** A grammar
emits properties in DECLARATION ORDER, so a schema with the label first makes
the model commit before it has written a word of evidence. Measured: the entity
reviewer returned `object` for a name whose own reason read "clearly a person".
Moving `reason` first fixed two failing cases at once and raised confidence
from 0.5 to 0.8–0.9. Applies to any new task module.

★★ **A catch-all class must be narrow, last, and never a default.** "entity"
described as "a named thing" is true of every input; the model quoted the
phrase back while mislabelling a person. Types are an ordered ladder now.
Renaming the wire label alone did NOT fix it — the description was the bug.

★ **Modes are a property of the data, not a switch.** A story-graph entry
carrying `lmChips`/`lmSummary` renders enhanced; one without renders exactly as
before. No placeholder, no "unavailable" chatter, nothing to configure.
- `npm run verify:knowledge-e2e` — the whole chain in the real app (hermetic
  profile via LW_USER_DATA): backfill → candidate → sweep → verdict persisted.
  Verifies WIRING, not judgment — do not tighten it to demand a verdict value
- `npm run verify:cross-widgets` — deep widgets present in the panel (the
  dropped-intelligenceLevel regression)

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

**The two control knobs are no longer part of this engine.** They run
`src/lib/knob-glass.ts`, and the frozen oracle below no longer covers them.
A knob is a PILL, so its surface normal is available in closed form — the
general engine probes a numerical gradient (3 extra SDF evaluations per pixel)
and blends a smooth-max over ±40 element px to hide a diagonal seam that only
large rectangles have. On a 32×24 knob that blend band is wider than the knob.
knob-glass solves the normal analytically instead (the method the STM /about
hero uses for its glass stripes: analytic shape ⇒ exact SDF and exact normal,
no probes) and reads the displacement profile from a 1-D LUT.

★ **The app's knobs are PAINTED, not filtered.** `GlassToggle`/`GlassRange`
render `KnobGlass` (`src/lib/knob-glass-paint.ts`), which draws the backdrop
the knob covers and refracts it PER PIXEL IN FLOAT with bilinear sampling —
the method stm-page uses (`GlassBars` in a shader, `EventOrbit/glassRefract`
as a canvas resample). Every artifact these knobs ever had came from the
ENCODING, not the optics: an 8-bit displacement map gathered by the
compositor quantises (comb), tears where the sampling stops increasing
(fold), and is authored in the layout box then magnified by the press (soft).
Float sampling has none of those failure modes, and the canvas is sized to
the DISPLAYED box so the press scale costs no sharpness. Its limitation is
the honest one: a canvas cannot sample arbitrary page content, so it
RECONSTRUCTS the backdrop from the live DOM (the track's rect/radius/colour,
the first opaque ancestor behind it). That is exact for a knob, which only
ever sits on its own track over a panel — do not reach for this where the
backdrop is arbitrary content. Gate: `verify:toggle-press` checks the canvas
is at display resolution, carries no backdrop-filter, and has no comb
(adjacent-pixel jumps along scanlines through the refraction band).

The notes below describe the SVG map engine, which the knob presets still use
on the dev bench pages:

★ **Map density is capped by the 8-BIT DISPLACEMENT CHANNEL — do not raise it
to match the display size.** One byte moves the sample by `DISP_PX/255` =
0.157 element px; one texel advances `1/density`. Once a texel is worth about
one byte, every texel either steps a whole byte (the sampling STALLS) or none
(it advances fully), so the refraction band alternates — and that alternation
is a comb of stripes over any hard backdrop edge, magnified 2x by the press.
Measured at density 6: 56% of band texels stalled, advances reading
`1 1 1 .06 1 .06 1 .06`. At density 3 the dominant step is a gentle 0.53x.
The ceiling is `255 / (2·DISP_PX)` = 3.19, and the knobs sit at 3.
`maxUsefulDensity()` enforces it; a caller may ask for press density and will
be capped. If a sharper pressed knob is ever wanted the lever is a FINER
ENCODING (a second channel for the low byte) or a smaller DISP_PX — never more
texels. `npm run diagnose:knob` prints the advance distribution that shows it.

★ **The knobs' refraction profile is NOT the squircle→Snell curve.** That
curve crams its whole pull into the first ~10% of the bezel, which a knob's
thin bezel cannot carry: measured on the shipped map, 1228 of 6580 interior
texels sampled BACKWARDS (19% of the knob), which is the mirrored comb the
general engine's own "known artifact" note describes. The knobs use a
bounded-derivative falloff instead — `g(t) = (1−t)²(1+2t)`, max|g′| = 1.5 —
with the RIM MAGNITUDE unchanged, so the glass bends exactly as hard at its
edge and merely decays more gently inward. Fold-free needs
`peak ≤ bezel/1.5`; the 32x24 toggle knob asks 4.78px of 6.40px and passes
untouched, the 20x14 range knob asks 6.97px of 3.73px and is scaled to fit
(x0.535) rather than shipped torn.

It also authors the map at the density the knob is DISPLAYED at, up to that
ceiling. The knob only
wears glass while pressed, and the press scales it to 2×, so a map authored
from the layout box was magnified across the swollen knob — 1.5 texels per
displayed pixel where 3 was intended. `KNOB_DISPLAY_SCALE` in the filter is
read off that CSS scale; change it if the CSS changes.

Measured at the switch-over, against the frozen baseline: every non-knob
preset stayed byte-identical; the knobs moved 17916 bytes (range, max delta 2)
and 21982 (toggle, max delta 1), R and G only. Their gate is
`npm run test:knob-glass` — physics, LUT error bound, normal fidelity, press
density, map invariants, a 240-geometry fuzz and a byte checksum. The real-app
density check is `verify:toggle-press`, which now measures texels per displayed
pixel rather than comparing the painted box to the layout box (that only
restated the CSS transform, so it reported "STRETCHED" unconditionally).

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

## Liquid state indicator — what the model is doing

`src/components/liquid-state/` is the 18px indicator the app shows while the
language model is working, in the ask popover, the writing tool and the world
dossier. It is not a spinner: it has three shapes and each says which of three
things the model is doing.

| state | shape | when |
|---|---|---|
| `idle` | the app's orb: six petals around an empty centre, turning slowly | at rest. Available, not yet wired into any surface |
| `reading` | a flat lozenge sweeping the box | evidence is being gathered — "Reading chapter 3 of 12…" |
| `thinking` | two dots taking turns jumping | the reasoning pass — the rotating `ThinkingLabel` |
| `writing` | one body reaching out to the right | tokens are being produced — "Writing the card…" |

**`idle` is the app's orb drawn in the same liquid**, which is the whole
reason it exists: a mark rendered by a different engine can only be *swapped*
for the working shape, and a swap between a WebGL orb and a canvas metaball is
a cross-fade however it is dressed up. Rendered in the field, the ring can
collapse inward, feed a single mass, and that mass can tear into two dots. Its
proportions are taken from `orbPhysics.ts` — ring 0.556, half-length 0.255,
aspect 1.15, empty centre 0.278 — not drawn by eye. Two versions were guessed
at first and both read as an asterisk.

Each surface maps its own vocabulary onto those three. `MaxAskPopover` carries
`work` beside `label` because the ask harness narrates five phases and there
are three shapes — that collapse is a translation, and it belongs at the call
site, not inside the component.

**It is an analytic metaball, not a goo filter.** `field.ts` evaluates a
circular smooth-minimum per pixel in float at device density. The usual
blur-then-threshold trick is wrong at this size for reasons that are not
matters of taste: a blur wide enough to merge two 6px dots is wider than the
dots, its rim width is a function of its σ so the outline visibly inflates the
moment anything moves, and it is authored at the layout box and magnified by
any transform. Same lesson as the glass engine — when a small element's effect
keeps producing artifacts, stop tuning the map and paint it.

**Rules that are load-bearing, all of them learned by breaking them:**

- **Position and shape never share a curve.** Separation and travel land
  without overshoot; `sx`/`sy` ring on an elastic whose window starts earlier
  and ends later. That lag is the entire liquid effect. Curves come from
  `curves.ts`, ported from `@stephantechlab/ui`'s liquid family.
- **Every transition ends exactly on its target loop's clock-zero pose.** There
  is no crossfade and no settling step. The split therefore ends with one half
  thrown up to the apex of its first jump — the tear's energy becomes the
  loop's first beat.
- **Petal tension is derived from how far the ring has collapsed**, not
  authored. No transition has to remember to ramp it, and it can never be left
  on at rest, where it would weld the mark into a disc.
- **The ring is centred where a resting mass is centred**, a constant. Deriving
  it from the body's own centre and floating the mark with `lift0` is wrong the
  instant a transition grows a body: the lift and the radius both push it up.
- **`fieldOf` always emits every body.** A body that should not be seen gets
  zero radius *and* zero blend, which is inert under `min()`. Dropping it
  instead is a discrete branch inside a continuous animation and steps the
  picture by ~160 square pixels in one frame.
- **`smin(a, a, k)` is `a − k`.** Two coincident bodies blended at k are one
  body inflated by k, so the pair's blend is tied to their separation in
  `fieldOf` and cannot be got wrong by an author.
- **A zero-radius body is absent, not a point.** `sdEllipse` returns Infinity.
  Clamping the radius to something tiny makes it report distance ≈ 0 at its own
  centre, which paints a stray half-lit pixel wherever it happens to sit.

**Three gates, and they answer different questions.**

- `npm run test:liquid-state` — 41 headless checks against the same functions
  the component paints. Continuity is a **scaling test** and needs no constant:
  halve the timestep and the largest frame-to-frame change in the rendered
  alpha must halve. Continuous motion reads 7.2–7.8 against an ideal 8; a
  planted 0.04 step reads 1.00, and that planted step is in the suite.
- `npm run verify:liquid-state` — 13 checks in a real Electron renderer:
  backing store density, rAF, the pause path, reduced motion, and a **tint
  negative control** that sets `--control-value-fill` to a magenta nothing else
  uses and requires the painted pixels to be it.
- `npm run film:liquid-state <dir>` — contact sheets of every loop and every
  transition, at 96px and at the real 18px blown up 4×. **Look at the second
  one.** Four decisions the 96px sheet would have let through were wrong at 18:
  the writing state was invisible, reading and writing had the same silhouette,
  thinking was bobbing rather than jumping, and the merge's droplet evaporated
  at the top of its arc.

Do not measure "is it animating" by total ink. Every squash sets `sx = 1/sy`,
so the painted area is conserved to 0.02% and two samples read identically.
Use the centroid.

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
