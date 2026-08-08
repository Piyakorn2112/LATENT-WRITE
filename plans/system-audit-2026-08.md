# System audit — 2026-08-08

Read-only survey. **No code was changed for anything in this document** except
the one interface description in §0, which was explicitly requested. Every
number here was measured on this machine, not estimated.

Severity key: **P1** correctness or data risk · **P2** real cost or a trap that
will bite · **P3** hygiene, safe to defer.

---

## 0. Answered first: are speech and action separate engines?

**No. Action attribution is DOWNSTREAM of speech, and the interface was
describing them as peers.**

The modules look independent (`speech-detect.ts` and `action-detect.ts` do not
import each other) but the pipeline in `chapter-analysis-runner.ts` chains
them, and the coupling is deep:

1. `detectSpeechInChapter` runs first and produces `speechResults`.
2. `buildActionPredictions(paragraphs, speechResults, …)` then:
   - **excludes** any sentence overlapping a speech span from action candidacy
     (`runner:145`),
   - **admits speakers into the actor pool** when `confidence >= 0.65` and the
     name survives `isCommonWordName` (`runner:92-101`),
   - **seeds the pronoun antecedent** — `carryingSpeaker` and `actorCarry` are
     set from the confident speaker of the preceding quote (`runner:150+`).

So a wrong speaker does not stay contained; it becomes the antecedent that the
following action sentences resolve their pronouns against. Reading the two
numbers as independent scores hid that.

**Changed (interface copy only):** the debug panel now labels them `Speech ·
runs first` and `Action · from speech`, and states plainly that action reads
speech so a wrong speaker carries into it. No engine change.

**Research note.** This is the known weakness of the standard architecture, not
a local mistake. BookNLP runs quotation attribution as four independent stages
(NER → name clustering → pronominal coreference → quote-mention linking) and
the literature names *error accumulation across pipeline stages* as its main
drawback. The published mitigation is to **restrict candidates to already
resolved mentions** rather than re-deriving them per stage, which is a more
principled version of what `actorCandidates` + `isCommonWordName` do by hand.
Worth considering if action attribution is ever revisited — see §8.

---

## 1. P1 — The adaptive learner is two-thirds dead but still runs on every correction

`adaptive-ranker.ts` retrains **all three** tasks (`TASKS = ['speech',
'action', 'entity']`, `adaptive-ranker.ts:14`) on every correction, via
`retrainAdaptiveModels` / `applyOnlineAdaptiveUpdate` (`App.tsx:1825-1830`,
`1907-1910`).

Since corrections became pins, **nothing reads the speech or action models**.
Only `entity` is still live, consumed by `WorldDataView` for the world scan
(`WorldDataView.tsx:350`).

Why this is P1 rather than tidy-up:
- `retrainAdaptiveModels` **replays the entire prediction history from scratch**
  (up to `MAX_PERSISTED_PREDICTIONS = 2000` records × every candidate pair) and
  it is called synchronously inside a `setState` updater on the correction path.
  Two thirds of that work provably cannot affect anything.
- The store still filters out unlabeled predictions on every load and save
  (`adaptive-store.ts:59, 87, 165`), so it remains structurally incapable of
  recording agreement — which is the prerequisite for ever re-enabling learning
  safely (noted in the annotation section of `harness-upgrade-spec.md`).
- `model.bias` takes an always-positive gradient (`gradient = 1 - sigmoid(...)`
  is never negative), so it **grows without bound** and never converges. It is
  ranking-neutral (a constant added to every candidate cancels in the
  comparison) so it is not a live bug, but it is an unbounded persisted number.
- `sampleCount` increments **per candidate pair**, not per example, so the
  `ADAPTIVE_MIN_MODEL_SAMPLES = 8` gate trips after roughly two corrections.
  Whatever that gate was meant to guarantee, it does not.

**Proposed:** scope the retrain to the tasks that are actually consumed, and
decide explicitly whether `entity` keeps the learner. Do not delete the modules
— they are the record of the experiment and `probe-annotation-feedback.ts`
still exercises them.

**Break risk: LOW-MEDIUM.** `entity` behaviour must be held constant. Gate it
with a before/after entity-scan comparison on a fixed book before touching it.

---

## 2. P1 — 25 silenced `exhaustive-deps` warnings, 12 of them in `App.tsx`

Each `// eslint-disable-next-line react-hooks/exhaustive-deps` is a hand-waived
correctness argument that no tool re-checks. The chapter-boundary pin bug fixed
this week was exactly this class: a value that looked stable during render was
not, and only an effect updated it.

**Proposed:** audit them one at a time, cheapest first. For each, either add the
dep or write the *reason* it is genuinely excluded next to the disable. Several
almost certainly encode "runs when analysis settles, not when the callback
identity changes", which is legitimate but should say so.

**Break risk: MEDIUM.** Adding a missing dep can turn a once-per-settle effect
into a per-keystroke effect. Every one needs its own reasoning and a manual pass
over the affected surface. Do not batch-fix.

---

## 3. P2 — `App.tsx` is a god component: 3052 lines, 124 hooks

19 `useState`, 34 `useEffect`, 54 `useCallback`, 17 `useMemo`. It owns the
novel, the story graph, annotations, the adaptive store, the knowledge ledger,
reviews, project lifecycle, the assistant, popovers, split view and the
timeline. It is also where the annotation bar is inlined.

The concrete harm is already visible:
- I edited `AnnotationPanel.tsx` believing it was the annotation bar. It was
  dead code; the live bar is inlined at `App.tsx:2859`. Duplicate-and-drift is
  the predictable outcome of a component this size (that file has since been
  deleted).
- Ordering between the boot effect, the hydrate path and the per-store save
  effects is load-bearing and implicit. The durable-state bug lived exactly
  there.

**Proposed:** extract by *ownership boundary*, not by line count. The natural
first seam is **project/session state** (novel, story graph, annotations,
ledger, reviews, adaptive, hydrate, boot, save effects) into a single provider
with an explicit lifecycle. That is the cluster with the proven bug history.

**Break risk: HIGH if done as one move, LOW per seam.** Each extraction must
keep effect ordering identical. `verify-state-persistence.ts` covers the save
side; there is no equivalent for boot ordering yet, so **write that gate
first**.

---

## 4. P2 — The action algorithm is split across two files

`action-detect.ts` holds the primitives (`findActionSentences`,
`actorCandidates`, `predictActionActor`, gender inference). But
`buildActionPredictions` — the orchestrator holding the *stateful* carry
(`carryingSpeaker`, `actorCarry`, `recentActors`, scene-break resets) — lives in
`chapter-analysis-runner.ts:64-200`.

The carry is the part the comments themselves call "the whole game", and it
sits in the file whose job is wiring. Anyone reading `action-detect.ts` to
understand action attribution reads the half without the state machine.

**Proposed:** move `buildActionPredictions` into `action-detect.ts` and let the
runner call it. Pure code move, no behaviour change.

**Break risk: LOW.** Mechanical. Guard with the existing corpus attribution
tests before and after; output must be byte-identical.

---

## 5. P2 — God functions in the detection engine

| Lines | Location | Function |
|---|---|---|
| ~880 | `speech-detect.ts:1311` | `findAttribution` |
| ~405 | `speech-detect.ts:2190` | `processParagraph` |
| 1382 | `RendererPanel.tsx:657` | `RendererPanel` |
| 1040 | `WorldDataView.tsx:265` | `WorldDataView` |
| 726 | `edge-color.ts:279` | `initEdgeColor` |
| 688 | `TimelineGraphFull.tsx:932` | `TimelineGraphFullImpl` |
| 441 | `alias-scan.ts:604` | `scanAliases` |

`findAttribution` is the tiered scorer and is the single most consequential
function in the app.

**Proposed:** do NOT refactor `findAttribution` for tidiness. It is heavily
tuned against the accuracy suites and the corpus, and its risk/benefit is bad.
If it is touched at all, extract *pure scoring helpers* one tier at a time with
a byte-identical output gate over the whole corpus, never a rewrite.

**Break risk: VERY HIGH for `findAttribution`, MEDIUM for the components.**

---

## 6. P3 — Dead and over-exported code

Measured by resolving every `export function|const|class` against all of
`src/`, `scripts/` and `electron/`:

- **19 truly dead runtime exports** (referenced nowhere, not even locally).
  Notable: `ProjectSetup.tsx` (an entire unused component),
  `detectSpeechInParagraph`, `runRendererReview` + `REVIEW_MODELS` +
  `FLAG_COLORS`, `buildKnowledgeTracks`, `lightweightPrescan`,
  `buildChapterObservation`, `hasAccess`, `getProjectPath`, plus the three
  now-orphaned adaptive helpers (`attachCorrectionToAdaptiveStore`,
  `computeAdaptiveMetrics`, `buildAdaptivePredictionRecord`).
- **128 over-exported internals** — used only inside their own file. Heaviest:
  `Icon.tsx` (17), `chip-picker.ts` (12), `writing-tool.ts` (12),
  `alias-review.ts` (10). These are prompt constants and schemas that leaked
  into the public surface; they are not dead, just not anyone's business.
- **`alias-review.ts` (12 exports) is deliberately unwired** and must stay that
  way. Flag it in the file header so a future sweep does not "clean it up".
- **159 test-only exports** exist purely for `scripts/`. That is legitimate but
  worth marking, so the two categories are not confused later.

**Break risk: LOW**, with one trap: exports consumed only by `scripts/` look
dead to a naive tool. Any deletion pass must resolve against `scripts/` and
`electron/` too, exactly as this audit did.

---

## 7. P3 — Small algorithmic waste (measured, not guessed)

**Scaling is healthy and that is the headline.** Measured on Great
Expectations' largest chapter:

- Paragraph count: 111 → 888 paragraphs costs 69ms → 539ms. Growth factors
  ×1.91, ×1.97, ×2.07 per doubling. **Linear.**
- Cast size: 10 → 160 names costs 65ms → 202ms. Growth factors ×0.92, ×1.26,
  ×1.51, ×1.79. **Sub-linear.**
- Tier cost, 111 paragraphs: fast 23ms, default 75ms, high 159ms.

No quadratic blowup anywhere. The engine is not algorithmically broken and does
not need re-architecting for performance.

Genuine small waste:
- `chapter-analysis.ts:546-547` calls `p.toLowerCase()` **inside** the `.some()`
  callback, so each paragraph is lowercased once per keyword — 16 times per
  paragraph across the two scans instead of once. Hoisting is a two-line change.
- 148 `new RegExp` construction sites in `src/lib`. Most are correctly hoisted
  into per-name sweep tables built once per chapter; a few
  (`action-detect.ts:721, 755, 788`) build inside per-name loops. Small, but the
  fix is free.

**Break risk: VERY LOW.** Both are provable no-ops on output; gate with the
corpus test.

---

## 8. Deferred with reasons (not proposed as work)

- **Re-separating action from speech.** Tempting after §0, but the coupling is
  load-bearing: the speaker carry is what gives pronoun-subject action
  sentences an antecedent at all, worth a measured 8.1% recovery per the
  runner's own comment. Decoupling would regress that unless replaced by real
  coreference. Only revisit alongside a mention-resolution stage.
- **Replacing the hand-rolled attribution engine.** The literature's stronger
  systems are neural (BERT-based quote-mention linking, character embeddings)
  and would mean a model download plus a large accuracy re-validation, against
  a system already at 80/86/100% on its suites. Not justified now.
- **Splitting `speech-detect.ts`.** See §5. High risk, low reward.

---

## Tidy-up pass executed 2026-08-08 (low-risk only)

Gated by `scripts/fingerprint-analysis.ts` — 21 signatures, ~93k
consumer-visible facts, hash IDENTICAL before and after every change.

**Done**
- Deleted `src/lib/auto-intel.ts` (36 lines, born dead 2026-04-30) and
  `src/components/ProjectSetup.tsx` (212 lines, born dead 2026-05-18; the only
  commit mentioning it is its own creation). Both confirmed unreferenced
  including by string, across `src/`, `scripts/`, `electron/` and `index.html`.
- Removed three adaptive helpers orphaned when the debug panel stopped
  reporting the retired learner.
- Hoisted the per-keyword `toLowerCase()` in `chapter-analysis.ts`.

**Measured and reverted** — caching per-name word-boundary regexes in
`action-detect.ts` moved nothing (2070ms → 2080ms on a 444-paragraph,
120-name stress shape). V8 already caches them. Shipped nothing.

**Corrections to this audit, found by checking rather than trusting §6**
- `renderer-review.ts`'s `runRendererReview` / `REVIEW_MODELS` / `FLAG_COLORS`
  are NOT dead. There is a live electron IPC handler at `main.cjs:520` and a
  preload binding. It is staged infrastructure awaiting UI. **§6 was wrong to
  list them.** Any future sweep must resolve against `electron/` IPC channel
  names, not just JS identifiers.
- Neither micro-optimisation in §7 is a measurable performance win. §7's claim
  should be read as "removes redundant work", not "makes it faster". The
  bottleneck is elsewhere and was not located.
- Unused entries in the `Icon.tsx` lucide barrel are not a defect; a curated
  palette exposes more than any one screen uses.

**Deliberately untouched:** `alias-review.ts` (must stay unwired),
`features.ts: hasAccess` (licensing scaffolding), `chapter-observation.ts`
(staged feature), `detectSpeechInParagraph` (core engine file), and everything
in §1-§5.

## Suggested order

1. §7 micro-waste — free, provable, warms up the corpus gate. (P3 but trivial)
2. §4 move `buildActionPredictions` — mechanical, byte-identical gate.
3. §1 scope the adaptive retrain — real cost, needs an entity-scan gate.
4. §6 dead-code sweep — resolve against `scripts/` and `electron/`.
5. §2 `exhaustive-deps`, one at a time with written reasons.
6. §3 `App.tsx` seams — only after a boot-ordering gate exists.

Do not start §5. Do not start §3 before its gate.

---

## Method notes

- Dead-code numbers come from resolving each export against every `.ts/.tsx/
  .cjs/.mjs/.js` in `src/`, `scripts/` and `electron/`, then splitting on
  whether the symbol is referenced *inside its own file* (over-exported) or
  nowhere at all (dead). A first pass that scanned only `src/` reported 491
  "unused" exports; the real figure is 19. **Scope the resolver to every
  consumer or the result is fiction.**
- Scaling figures are the min of two warm runs after a JIT warm-up call. The
  first cold run of `runChapterAnalysis` measured 765ms versus 159ms warm, so a
  single cold sample would have overstated cost by ~5x.
- Sources consulted for §0: [Improving Automatic Quotation Attribution in
  Literary Novels](https://arxiv.org/pdf/2307.03734), [The Project Dialogism
  Novel Corpus](https://arxiv.org/pdf/2204.05836), [Improving Quotation
  Attribution with Fictional Character
  Embeddings](https://arxiv.org/pdf/2406.11368), [Fast and Accurate Quotation
  Attribution in Literary Texts](https://arxiv.org/html/2608.02359).
