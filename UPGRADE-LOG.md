# Upgrade Log — Language System & UX

Working log for the implementation of `language-system-audit.html`'s plan.
One entry per phase, appended as each phase completes. Every number here is
measured, not estimated.

---

## Phase 1 — Extractor comparator fix + regression lock + OOD harness wiring
**Status: DONE · 2026-07-29**

### What changed
- `src/lib/world-data.ts` `autoExtractKnownNamesFast` — ranking comparator
  changed from length-descending to **occurrence-count descending** before
  `slice(0, 30)`. Length ordering for regex alternation was never this
  function's job (`buildEntityPattern` re-sorts longest-first internally).
- `scripts/test-known-names.ts` — NEW regression lock. Self-contained
  synthetic manuscript where 4 short high-frequency protagonists compete with
  32 long institutional names. 7 assertions. Verified it **fails (6/7 red)
  under the old comparator** and passes under the new one.
- `package.json` — added `test:known-names`, `audit:ood`.
- `CLAUDE.md` — suite list + held-out audit rule + reference numbers.

### Measured impact (scripts/ood-language-audit.ts, 40 ch per novel)
| metric | Hollow Iris before → after | Root Crown (held out) before → after |
|---|---|---|
| cast recall (cold start) | 0% → 57.1% | 0% → **100%** |
| UNKNOWN @ default | 52.9% → **3.9%** | 39.9% → **4.7%** |
| UNKNOWN @ high | 30.9% → 0.4% | 25.3% → 1.8% |
| mean confidence @ default | 0.35 → 0.79 | 0.46 → 0.78 |
| default↔high conflict | 17.5% → 3.6% | 19.7% → 14.3% |

### Verification
- Full battery re-run: **16/16 suites green** (accuracy-suite fast 77 / default
  84 / high 97 — unchanged, no regression).
- Note: frequency ranking on the shipping path now *outperforms* the heavier
  `autoExtractEntities` scoring (condition B) on both corpora — no need to
  swap the fast path to the scored extractor.

### Learnings
- The remaining Root Crown default↔high conflict (14.3%) is genuine detector
  disagreement, not plumbing — that is Phase 5's converge-on-idle territory.
- Curated-6-name condition C is *worse* than auto-30 on Root Crown (26.2%
  UNKNOWN): a too-small curated cast starves attribution. The Phase 2 cast
  screen therefore confirms the FULL scanned character bucket, not a shortlist.

---

## Phase 2 — Cold-start cast confirmation screen
**Status: DONE · 2026-07-29**

### What changed
- `src/components/CastConfirmOverlay.tsx` — NEW. Shown at most once per
  manuscript, only at safe moments (app load / .txt import, deferred behind
  onboarding), never mid-typing. Lists the people the scan found with mention
  counts and a line of their dialogue as evidence; one click writes
  `worldData.characters` (+ places/factions/entities filed automatically).
  Composed entirely from the existing `wc-overlay` / `wc-panel` / `wc-row`
  system — zero new styling.
- `src/App.tsx` — trigger logic (`castPromptNeeded`: ≥2000 words, no curated
  world data, not previously answered), confirm/skip handlers, import hook.
- `src/types.ts` — `WorldData.castReviewed?: boolean` records the answer.
- `src/lib/parser.ts` — `castReviewed` now round-trips through txt
  serialize/parse (previously an empty-buckets world block was dropped
  entirely, which would have re-asked the question every session after skip).

### Candidate quality pipeline (the part that took iteration)
The classifier's character bucket is deliberately forgiving; a one-click
screen needs harder gates. Verified live on 12 Root Crown chapters:
1. **Article filter** — "The Pale Office" is never a person.
2. **Mid-sentence gate** — a name must occur ≥2 times NOT at a
   sentence/dialogue start. Kills capitalization artifacts ("Come",
   "Alright") that only ever open sentences; real names appear
   mid-sentence constantly ("said Mira").
3. **Short-form merge** — "Tessa" folds into "Tessa Mosswell" as an alias
   (first-token match only; bare family names like "Vell" are NOT merged).
4. **Default-check policy** — checked iff the name demonstrably speaks
   (dialogue-attribution evidence) or recurs ≥12 times; low-signal names
   stay visible but unchecked for opt-in.
5. Evidence prefers a 3+ word quote over fragments (scans up to 12 matches).

### Verification (Playwright against live vite dev, Root Crown seed)
- Scan → review → confirm flow: overlay renders, rows list
  Mira/Kinoko/Vey/Dowsa/Anwen Vell(Anwen)/Gareth/…, zero junk rows.
- Confirm writes characters + aliases + 6 places + 1 faction + castReviewed.
- Fresh-context reload with confirmed state: prompt does NOT reappear.
- Skip path: castReviewed persisted, empty buckets keep auto-extract behavior.
- Zero page errors; `tsc -b` clean.

### Learnings
- `addInitScript` re-seeds localStorage on reload — a false "bug" cost one
  debug loop; reload-persistence must be probed in a fresh context.
- The mid-sentence count is the cheapest reliable person-vs-artifact signal
  and likely belongs in `world-data.ts` proper eventually (it would also
  improve the World panel's scan review).

---

## Phase 3 — Confidence-aware speaker rendering
**Status: DONE · 2026-07-29**

### What changed
- `src/lib/confidence-bands.ts` — NEW, the single owner of "how sure is
  sure". Three bands matched to the engine's own internal gates:
  certain ≥0.85 · likely ≥0.58 · unsure below / no speaker. A writer's
  manual override is always certain. (First step of the "confidence policy
  has no owner" architecture fix — display consumes this module now; the
  other seven magic thresholds migrate as they're touched.)
- `src/components/HighlightLayer.tsx` — the speech display asserts only what
  the engine stands behind:
  · certain → speaker-coloured text (unchanged from before)
  · likely  → ink text + speaker-hued underline at 62% (hedged claim)
  · unsure  → ink text + faint neutral DOTTED underline (open question).
    Previously an unknown speaker painted iOS ORANGE — a confident look for
    a non-answer, which is how writers learn to distrust the whole layer.
- `src/styles.css` — `.speech-band-likely` / `.speech-band-unsure` (underline
  longhands only; hue arrives inline so the palette stays in JS where it
  lives). Composes with annotation-mode classes; corrections still flow
  through the existing AnnotationPopover → adaptive store loop, and an
  override instantly re-renders as certain.

### Verification (live vite + Playwright, Root Crown ch2 — 14 likely / 10 certain / 8 unsure)
- Computed styles confirmed in BOTH themes: certain = speaker colour + no
  underline; likely = ink + solid hued underline (color-mix 62%); unsure =
  ink + dotted 40% currentColor underline. Zero page errors.
- Engine-side histogram (10 chapters): certain 18% · likely 29% · unsure/no
  53% — all three bands are real populations, not theoretical.
- `tsc -b` clean; accuracy-suite unchanged (84/97) — display-only change.

### Learnings
- Chapter 1 of a manuscript can contain zero likely-band segments — a
  band-rendering probe must seed a chapter proven to carry all three
  populations (found via a per-chapter histogram first).
- `text-decoration` on the outer segment span decorates all inline children;
  no need to thread band styling into the inner rendering path.

---

## Phase 4 — Quieter entity highlights + HighlightLayer render optimization
**Status: DONE · 2026-07-29**

### What changed (visual — hues untouched, weight reduced)
- `.entity-tag` — the hue moved from a 100% SOLID pill fill (white text)
  into the TEXT itself, over a light wash of the same hue (13% light / 20%
  dark; hover deepens to 24% / 32% as the click-popover affordance, reset
  under `@media (hover: none)`). Names still read instantly as colour-coded
  highlights; they no longer shout on every mention.
- `.action-phrase` — actor wash 20% → 12% light / 16% dark. Action sentences
  cover most of a narration page, so this wash sets the page's noise floor.
- Speech confidence bands (Phase 3) sit on top; the page now has a clear
  loudness order: certain speech > entity names > action washes > grammar.

### What changed (structure/perf)
- The two absolutely-positioned bg divs inside every entity badge
  (`entity-tag-bg`, `entity-tag-bg-sub`) are replaced by two stacked flat
  `background-image` fills on the badge itself (single-stop gradient idiom;
  `box-decoration-break: clone` now applies to the fill correctly across
  line wraps too). **2 fewer DOM nodes per mention** — a chapter with 100
  mentions sheds 200 nodes, which is the WebKit scroll-cost lever.
- `cachedActionSentences` — `findActionSentences` is pure per-paragraph;
  now cached by text (cap 800) so full-plan rebuilds (analysis settle,
  annotation override, palette change) re-scan only changed paragraphs.

### Measured (18.9K-char chapter, `__GLASS_EDITOR_PERF__` console channel)
- highlight.nodes settle ~5ms before AND after (was never the bottleneck at
  this size — analysis.worker is 187ms initial / 11ms resettled). The DOM
  and cache wins are structural, sized for long chapters and Safari/WebKit
  paint cost rather than this benchmark.
- Per-keystroke path stays under the 4ms log threshold throughout typing.
- Verified visually in BOTH themes on real prose; zero page errors; tsc clean.

### Learnings
- Measure-first prevented an over-engineered rewrite here: the honest
  finding is that the snapshot path is already efficient at realistic
  chapter sizes, so Phase 4 spent its effort where the eye said the problem
  was (visual weight) plus two cheap structural wins.

---

## Phase 5 — Converge-on-idle intelligence (tier dial removed)
**Status: DONE · 2026-07-29**

### What changed
- `src/lib/use-analysis.ts` — new `converge` option: the debounced pass runs
  at **fast** (responsive while typing); after 1.6s of idle the same content
  re-runs at **high** in the worker and the deep result replaces the fast
  one. Any edit cancels the pending/in-flight refinement. Returns
  `isRefining` + `resultLevel`. Adjacent-chapter pre-analysis now also runs
  under converge (it was high-mode-only).
- `src/App.tsx` — intelMode collapsed to **off | on** ("auto" stored for
  pref compatibility; every legacy tier value maps to on). `cycleIntel` is a
  toggle. `autoResolvedLevel` / `effectiveLevel` / `lightweightPrescan`
  removed. StatusPill gains "Refining attribution…". Orb tint now tracks
  **which answer is on screen** (amber = fast pass current, violet = deep
  pass landed) — repurposing the existing per-mode orb palettes as an honest
  state display instead of a setting.
- `Toolbar.tsx` — mode copy rewritten (Live / Refined / Off), titles say
  "click to toggle". Orb visuals untouched.

**REVISED (owner feedback, same day):** the orb no longer swaps discrete
fast/high palettes. It keeps the app's AUTO identity (the blue-led cycle,
"logo-blue anchor") the whole time intelligence is on, and only LEANS with
the converge phase by riding the pre-built resolved-level cycles and their
1.4s `@property` colour handoffs:
- fast pass current → `data-resolved="fast"` (ghost layer leans warm; the
  front stays blue, so fast reads as a tint, not a mode)
- deep pass refining → `data-resolved="high"` (violet lean), held for a
  1.2s glow tail so the 50–150ms worker run reads as a visible breath
- converged and quiet → no lean: the original EQUAL cycle plus
  `.intel-btn--vivid` (saturate 1.3 / brightness 1.05 on top of the base
  blur+contrast, eased by the existing 0.5s filter transition)
Also fixed the same `resolvedLevel ?? "default"` coercion in
`OrbEngine.tsx` LegacyOrb so the behind-glass glow twin sits on the same
equal cycle at idle instead of drifting to the default lean. The WebGL twin
needed no change (`AUTO_CYCLE[lvl ?? "default"]` + LAB smoothstep already
glide). Verified live through all four phase transitions, zero errors.
- `AnalysisPanel.tsx` settings — the 5-way intel grid is now On / Off. The
  free-tier lock on manual tiers is gone (nothing left to lock).
- `Onboarding.tsx` page 3 + Electron menu ("Toggle Intelligence", same
  Cmd+Shift+I accelerator).

### Verified live (Playwright, Root Crown ch2)
| state | unsure quotes | likely | orb |
|---|---|---|---|
| fast pass (typing) | 10 | 11 | amber "fast" |
| after 1.6s idle + 56ms deep pass | **2** | 18 | violet "high" |
| immediately after an edit | 10 | 11 | amber (honest fallback) |
| reconverged | 2 | 18 | violet |

Exactly one refinement per idle period (no runaway loop), zero page errors,
legacy `intelMode: "high"` pref correctly maps to On. `tsc -b` clean.

### Notes for the owner
- **Pricing**: "intel-manual" (Pro) no longer exists as a concept — everyone
  now converges to the deep pass. If Pro needs an intelligence
  differentiator again, the honest lever is refine cadence or corpus-wide
  background analysis, not withholding accuracy. Pro still gates renderer
  workspace, custom tools, story-NLP control.
- The 16% default↔high conflict measured in the audit is now a UI feature
  instead of a hidden coin flip: the moment of replacement is visible (band
  marks resolve, orb shifts hue) and always converges to the better answer.

---

## Phase 6 — Panel observation layer (widgets kept, repositioned)
**Status: DONE · 2026-07-29**

### What changed
- `src/lib/chapter-observation.ts` — NEW pure-synthesis module: ONE sentence
  about the chapter, with a paragraph location, distilled from the settled
  analysis. Priority ladder: distinctive tension shape (plateau-high /
  spike / valley / double-peak, each with its own template and anchor) →
  warning diagnostic → extreme dialogue dominance (≥72%) → located slope →
  cross-chapter shape echo → null. No new analysis runs.
- `AnalysisPanel.tsx` — the observation renders at the TOP of the widgets
  view ("This chapter" eyebrow + serif sentence + "Go to ¶N" jump). **All
  widgets and the custom-tool widget system are untouched below it** — the
  panel keeps its at-a-glance depth; the observation is the entry point.
- `App.tsx` — `onJumpToParagraph` resolves the paragraph offset and reuses
  the existing search-hit jump (scroll + select).
- `scripts/test-chapter-observation.ts` — 15 assertions, 100% (wired into
  package.json + CLAUDE.md). Includes copy-rule locks (no em/en dashes,
  ≤160 chars) per house writing rules.

### Honesty gates (found by testing against REAL chapters, not fixtures)
- `hasRealPeak` — arc-shape labels are relative, so a calm chapter whose
  curve tops out at 0.26 can still be labelled "slope-up". Every tension
  template is now gated on the curve reaching ≥0.5; calm chapters surface
  the engine's own NO_CLEAR_CLIMAX note instead of an invented shape claim.
- Climb templates report the LATEST max (a curve that saturates early must
  not claim an early "peak at the close"), with phrasing that adapts when
  the peak is not in the final fifth.
- Double-peak requires both halves to actually reach ≥0.6 before claiming
  two peaks (a degenerate curve under a stale label falls through).

### Verified live (Root Crown ch2, converged analysis, panel open)
- Observation renders with the engine's no-climax note (correct for that
  genuinely calm chapter), 12 widget cards intact below, jump-to-paragraph
  selects the right span. Zero page errors. tsc clean. Suite 15/15.

---

## Final state

All six phases complete. Full battery re-run at the end of the session:
17 suites green (see below), tsc clean, every UI change verified against
the live app in both themes on real manuscript prose.

**The writer-facing arc of this upgrade, end to end:**
1. The app now *finds the cast* (0% → 100% recall on a held-out novel).
2. It *asks* the writer to confirm it once, with evidence, in thirty seconds.
3. It *says only what it knows*: certain speech asserts, likely speech
   hedges, unsure speech asks.
4. The page is *quiet*: hues kept, shouting removed, 2 DOM nodes fewer per
   entity mention.
5. The tier dial is gone: analysis *converges* to the deep answer whenever
   the writer pauses, visibly.
6. The panel *leads with one sentence worth acting on*, and every widget
   (and the custom widget system) remains one glance below.


---

## Phase 7 — Orb redesign: the petal pinwheel

The intelligence orb is no longer a blurred dot cloud. It is six FLAT
petals in a ring, moving on a spring rig, under an invisible lens.

This took three passes and the two rejected ones are worth recording,
because both failures were the same mistake in different clothes.

### What was rejected, and why
1. **Sharp overlapping "sheets"** (an iOS-27 Siri reading). Rejected: it
   was a CONTAINED disc. The owner's standing rule — stated twice now —
   is that the orb has no hard silhouette; its shape must fall out of the
   drawing, never be cut out by a mask.
2. **Six soft merged bubbles** with physics. Closer, but still wrong: the
   gesture was a free-floating jostle, and the translucent cloud carried
   a grey halo on light backgrounds.

### The halo, which was real and had a real cause
The owner asked twice why the graphic "always has a kind of dark shadow
outside". Two separate causes, both now gone:
- **Translucency.** Any semi-transparent mid-dark colour composited over
  a light page darkens it at the edges. No parameter fixes that; only
  opacity does. The petals are opaque.
- **A compositing bug.** The petal field mixed straight colours toward a
  black backdrop and carried coverage separately, so every antialiased
  edge pixel came out at HALF brightness — a dark outline around every
  shape, drawn by construction. Compositing premultiplied (`src·a` over
  `dst·(1−a)`) is the only version where a half-covered edge pixel is the
  petal's own colour at half alpha.

### The shape — between the reference and a plain ring
A research pass measured the OpenAI Foundation mark's own artwork
(connected components + image moments on the PNGs its site serves; there
is no design-press coverage of this mark to paraphrase). Measured: six
shapes, centroids at ONE radius (std. dev. 0.4%) spaced within 0.3° of
60°; **all six share one major-axis length** and differ only in WIDTH
(aspect 1.00, 1.27, 1.49, 1.79, 2.28, 3.42); every long axis exactly
radial within ~1°; clear gaps; ring radius 0.60× half-width, half-length
0.29×, empty centre 0.30×; monochrome, no animated version.

That geometry is a still frame of a travelling width wave — which is why
the logo and a loading ring can be the same object. Built literally,
though, it read as *the logo* rather than as this app's orb, so the
shipped rig sits deliberately between that and a plain ring of balls:

- Radial long axis and a family resemblance are kept.
- **Width is only the resemblance**, and it stops well short of the
  reference: floor 1.25:1 (never a true circle — that is the mark's
  signature, and it is also the widest a shape can get, which is what
  crowds its neighbours), ceiling 2.2:1 rather than 3.42:1.
- **Size varies too**, which the mark's one-length rule forbids. That is
  what carries the working state (below).
- Ring radius 0.556 and base half-length 0.22 in the shader's p-space.

The rubber sits on top: real centrifugal load (ω²·r) plus the pulse's
radial speed narrow a shape further, on their own looser underdamped
spring so the effect lags and settles. The long axis trails travel only
slightly — the reference is radial within a degree.

### Reaching into the centre
The ovals now extend much further in: the ring radius came IN to 0.52 and
the base length went OUT to 0.285, leaving an inner tip at 0.235 instead
of 0.30. The trade is unavoidable and worth naming — **length buys reach,
width spends the gap.** Six shapes on a ring sit `RING_R` apart and it is
their WIDTH that closes that distance, so extending inward costs a unit of
gap per unit of ring radius but 2/aspect per unit of length. Hence the
aspect floor had to come back up (1.04 → 1.42): they cannot be both this
long and as round as they were.

### The pulsed turn, and deformation from real motion
- **Working turns in PULSES,** not at a constant rate — a surge, an ease,
  another surge. The surge is normalised to average 1, so pulsing changes
  the RHYTHM without changing how fast the ring gets round.
- **The deformation now comes from each shape's own velocity.** Its speed
  through space is whatever the spin, the pulse and the throw are doing to
  it, so when the turn surges it is genuinely being hauled sideways: it
  draws out along its travel and leans into the turn, then eases back.

  ⚠ **The bug this first shipped with, and the rule that fixes it.** I
  leaned the axis by the ANGLE between the velocity and the radius. An
  axis is a line, not an arrow, so that angle has to be folded into a
  half-turn — and the fold is a discontinuity: the instant a shape's
  travel crossed it, the axis SNAPPED a quarter-turn. On screen the orb
  looked broken. The fix is to lean by the signed TANGENTIAL COMPONENT of
  the velocity, which passes smoothly through the same event. **Never
  drive a continuous visual from a folded angle; drive it from a
  component.**

### The working state — scale, and the throw
Working does not inflate the graphic and does not thin it into slivers.
Two things happen, both scaled by energy:

- **The six disagree about their SIZE.** Centred on the wave's midpoint,
  so the mean size holds steady and only the spread opens: measured
  1.33× at rest → 13.7× working, with mean area essentially flat. At rest
  the ring reads as six near-equal ovals on purpose — the disagreement is
  the working state's own signal, and spending it at idle would leave the
  orb nothing to say once it starts thinking.
- **The cluster is thrown off centre.** The wave's peak sits at
  `spin + phase − π/2` (the per-shape stagger is exactly one ring step,
  so it cancels) and travels tangentially; that tangent is the momentum
  every shape is pushed along, the currently-swelling one furthest. The
  group visibly leans and recovers as the wave moves on. Measured centre
  of mass: 0.054 dormant → 0.331 working.

Measured overall: aspect 1.14:1 at the trough, 1.85:1 at full load;
centre of mass 0.084 resting → 0.337 working; closest approach between any
two outlines 0.151 orb-radii — they never meet at any energy.

Two traps the probe caught that eyeballing would not have:
- Unclamped, spring overshoot × per-shape gain × centrifugal stacked to
  **4.95:1** — a 1.5px needle at button size that aliases into a flicker.
- With a *global* clamp, idle and busy both saturated at the ceiling and
  stopped reading apart. Energy now owns the ceiling (`room = max − min`;
  the physics terms fill that headroom without exceeding it).

### The colours — the highlight layer's own
`orbColors.ts` takes them straight from `lib/palette.ts`, the iOS set that
already colours speakers and entities in the manuscript — so the orb is
literally made of the colours the writer sees in their own prose. Each
oval is permanently assigned one:

    blue #1071D8 · orange #DC7B19 · cyan #009ABC ·
    red #D6363B · indigo #4F45D8 · green #2EA84A

The order alternates cool and warm around the ring. With three blues in
the set (blue, cyan, indigo) that is the only arrangement where none of
them end up side by side — including across the wrap from the last back
to the first, which is the pair an eye check of a linear list always
misses, so the probe asserts it.

Nothing cycles, drifts or follows the analysis phase. No hue is computed
at runtime, so no state can push one off-palette — an earlier derived-hue
scheme did exactly that (a +150° rotation off a blue dominant lands on the
app's amber, but off an amber dominant it lands on green). The only colour
change in the engine is the eased drain to grey when intelligence is off.

The colours live in their own module rather than in `OrbEngine.tsx`
because that file imports its own CSS, which node cannot load — and the
SVG exporter needs the values without dragging a React component in.

### The active <-> idle transition (spring-driven, measured)
The state change did not feel seamless, and it had two nameable causes.

**1. An exponential chase is a steep launch.** `energy` (the one driver
every amplitude reads) chased its target with `v += (target − v)·k·dt`.
That model recomputes velocity from the instantaneous error every frame,
so it carries its MAXIMUM speed on the very first frame after a retarget
and decays from there. It is C0 but not C1 — position is continuous,
velocity jumps. The house motion rules reject exactly this shape, and it
is the same defect Daniel Holden names in the game-dev literature ("no
velocity continuity... a kind of annoying sudden movement") and that
Android's Compose docs cite as the reason to prefer springs ("guarantees
the continuity of velocity when target value changes amid animations").

It is now a spring, asymmetric per the house rule "energy up front, long
gentle decay", with the velocity CARRIED across a retarget so an
interruption bends the motion instead of restarting it:

| | first-frame v | peak | settles | overshoot |
|---|---|---|---|---|
| entering work | 0.23 | 1.08 @ 167ms | 1167ms | +2.1% |
| leaving | 0.07 | 0.50 @ 300ms | 1967ms | −0.2% |

(ζ 0.78 entering — between SwiftUI's 0.825 default and Material's 0.6
expressive-spatial — and critically damped leaving, so it settles without
a rebound that would read as a second event. Note this is the OPPOSITE
direction to the NN/g and Material convention that entering takes LONGER
than exiting; that convention is about screen-level element choreography,
and the house rule for ambient/active motion governs here.)

**2. Three timelines.** The ring's growth was a CSS `transform: scale()`
with its own 0.55s duration and its own `cubic-bezier(0.34, 1.42, …)` —
itself a steep launch. Two timelines running beside each other is what
"not seamless" feels like. Growth now lives in the rig on the same spring
as everything else. It cost something: a CSS scale grew the canvas AND its
margin so it could never clip, while growing content inside a fixed canvas
can, so the peak throw was trimmed to pay for it.

**3. The effort curve was amplifying the overshoot.** `effort = e⁴` is
flat at 0 but its slope at 1 is 4: the amplitudes changed FASTEST exactly
where the motion should have been settling, and the spring's small
overshoot in energy came out four times larger in everything visible. It
is now a smootherstep (6t⁵−15t⁴+10t³) over a remapped range — zero first
AND second derivative at both ends, so the arrival decelerates into place
and an overshoot is absorbed rather than amplified. Rest got quieter for
free: size spread 1.32× → 1.12×, throw 0.061 → 0.034.

### Idle, unfocus, and the glass swap
- **Idle no longer means frozen.** The engine's idle floor was 4 fps once
  the rig went quiet, which reads as a stalled graphic rather than a
  resting one. It is 20 fps now: still a saving on the 30 fps active cap,
  but the ring visibly keeps turning while the app sits.
- **Unfocused steps back, it does not disappear.** `scale(0.72)` at 0.18
  opacity read as the orb being switched off rather than the window losing
  focus; it is `scale(0.94)` at 0.6 now.
- **The liquid-glass → plain-blur swap FADES.** The idle path trades the
  SVG liquid-glass composite for a cheap backdrop blur to save work, and
  that swap was an instant cut in both directions. Every affected surface
  now carries a 0.22s transition on background and backdrop-filter (both
  spellings, or WebKit cuts while the standard property fades). Kept short
  on purpose — the point is to remove the snap, not to make coming back
  from idle feel laggy.

### The refraction profile — a G2 version was tried and rejected
The lens falloff is a literal sphere (1−√(1−d²)) tapered by a smoothstep.
That is not curvature-continuous: the sphere term has a vertical tangent
at d=1 and smoothstep is C1 but not C2. A fully C2 replacement (a single
smootherstep bump, rise-to-shoulder then fall-away) was built and
**rejected on looks** — it reads flatter and loses the accelerating bend
that makes the edge feel like glass. The maths is less tidy and the
picture is better; the note is in `orbLens.ts` so nobody re-derives it.

### The panel's opening line sits on its own glass
`.chapter-observation` was a flat block with a bottom rule, which read as a
caption stuck above the widgets. It is now its own `liquid-glass` surface
with the panel chrome's 16px radius and the same
`data-liquid-glass-scroll-adaptive="panel"` enrolment the settings panel
and tab rail use, so it reads as a distinct thing the panel is telling you.

### Vector export — `npm run export:orb`
The geometry is decided by a pure engine, so a frame of the orb IS a
vector drawing: `scripts/export-orb-svg.ts` runs the same rig, freezes it
at a chosen instant, and writes the six shapes out directly. No
rasterising, no tracing, no screenshotting.

**It matches the live render, rather than approximating it.** The app does
not draw plain ellipses: every shape is read through the invisible lens,
which bends it as it nears the rim, and the colour goes through the
shader's brightness/saturation pass. An exporter emitting `<ellipse>` with
the raw palette hex therefore ships a DIFFERENT picture than the screen.
So the lens now lives in `orbLens.ts` as shared numbers — the GLSL
interpolates those exact constants into its own source, and the exporter
calls the same functions, so the two cannot drift. Each outline is sampled
in shape-space, pushed through the lens, and emitted as a `<path>`
(a refracted ellipse is not an ellipse, so `<ellipse>` cannot express it).
The probe round-trips every sample back through the shader's forward map
and asserts it lands where it started, worst error 1.9e-13.

    npm run export:orb -- --out public/orb-icon.svg
    npm run export:orb -- --time 3.2 --seed 42 --out working.svg

**It auto-picks the pose.** A frozen frame only reads as motion if it
catches the orb mid-gesture, and frame 0 is composed and even — truthful
but inert. So unless `--time` is given it scans the first 12 seconds and
keeps the frame scoring highest on sizes-far-apart, ring-thrown-off-centre
and axes-leaned-off-radial. Deterministic, because the rig is.
`--fit` sets how much of the canvas the mark fills; `--grey` exports the
off state. The
export fits the mark's own reach but keeps it centred on the ORB's centre,
not its bounding box — while working the orb is thrown off centre on
purpose, and re-centring the box would quietly undo that.

### The motion (`orbPhysics.ts`, pure engine)
- **Pulse.** Each petal reaches OUT and swells, then comes back in —
  never a uniform breathe. Each petal's beat is offset around the ring,
  so the swell travels like a loading indicator. The driver is a
  power-eased bump (fast out, dwelling at the extreme) and each petal
  chases it through its own underdamped spring (ζ ≈ 0.45, softer down the
  ring), so it overshoots on the way out and arrives late.
- **Individual sizing.** Working does NOT scale the graphic up. Each ball
  has its own resting size and its own gain on the sizing wave, and what
  strengthens with energy is how far those sizes DISAGREE — measured, the
  spread between the largest and smallest ball goes 2.2× → 9.5× while the
  mean area barely moves (1.13×). The wave is centred on the driver's
  midpoint for exactly that reason: a positive-only swell would have
  inflated the whole ring, which is the uniform scale-up this replaces.
  The CSS `scale(1.22)` on analyzing is down to 1.06.
- **Spin.** The whole ring turns: slow at rest, quick while working.
- **Flicks** land on jittered beats so the rhythm never metronomes.
- Energy scales reach and spin together, so active→idle needs no
  cross-fade — the transition IS the amplitude easing down. The CSS side
  adds only a light defocus + dim in the passive state.

### Removed
- **The backdrop glow** behind the toolbar glass (`OrbBackGlow`, its
  bloom/spectral layers and ~215 lines of CSS). It also carried the app's
  single most expensive effect, a live canvas re-rasterised through a CSS
  filter every frame (measured at ~0.72–0.78 ms/frame, ~36% of frame
  cost).
- The whole OKLab palette-cycling machinery from the engine, now dead.

### Verified
`npm run test:orb-physics` — a headless feel contract (reach inside the
slot at rest, never touching the canvas edge at full reach, the ring
turns while idle and faster when busy, the wave is bigger when busy and
arrives late around the ring, deterministic per seed). Plus the harness
in both themes at 20/64/140 px and the in-app probe in both themes
through live → converged idle → settle → wake → typing. tsc clean, zero
page errors.
