# Assistant wave 2 — attribution, continuity, scene function

> Status: SHIPPED, and NARROWER THAN SPECIFIED. Every funnel number below came
> from `scripts/probe-assist-funnels.ts` over 73 DEV chapters (pride, sherlock,
> anne, dracula, carol, webnovel). Written 2026-08-03, implemented and
> re-measured 2026-08-04.
>
> **What shipped: scene near-misses and Chekhov confirmation. Attribution was
> built, wired, measured against the real model, and withdrawn.** See §7.

---

## 1 · What the measurement said, and what it killed

| candidate source | per chapter | verdict |
|---|---|---|
| attribution tie-breaks (spans in the 0.25–0.78 band) | **43.62** | too noisy to sweep |
| Chekhov candidates (introduced, never recurs) | **4.88** | high — needs a cut |
| time/place hand-off drift | **0.04** | too sparse — **not built** |
| scene-function abstentions | **16.64** (1215 of 1896 scenes, 64%) | too noisy to sweep |

Three consequences, all of which change the design I would otherwise have
written:

**A background sweep is the wrong shape for all of these.** The knowledge
ledger produced ~1.5 candidates per chapter, which a sweep drains in seconds.
43 attribution ties per chapter at ~600ms each is 26 seconds of continuous
inference *per chapter*, or roughly 13 minutes for a 30-chapter novel — for a
queue that regenerates on every edit. The ledger's pattern does not transfer.

**Hand-off drift is not a feature.** Three instances across 73 chapters. The
deterministic rule already answers, and a model call would be theatre. It is
explicitly out of scope; `continuity.ts` keeps computing it for the widget.

**Scene abstention is not a defect queue.** 64% of scenes abstain, because
`classifyScene` is *designed* to prefer silence (gate → floor → margin). Most
of those scenes genuinely have no function worth naming. Only the near-misses
are worth a second opinion.

## 2 · The rule this wave adopts

> **RANK AND CAP, DO NOT SWEEP.** Every task gets a per-chapter budget and a
> ranking that decides who spends it. A queue with no ceiling is a queue that
> never drains, and a writer who edits invalidates it before it does.

Budget per chapter, and why it is affordable:

| task | cap | ranked by |
|---|---|---|
| attribution | 3 | ambiguity × how much the span moves the chapter |
| Chekhov | 2 | mentions, then earliest introduction |
| scene function | 3 | margin to the floor — the near-misses only |

Eight calls per chapter, ~5s of background work, and it is bounded whatever the
prose does. A chapter that legitimately has nothing spends nothing.

## 3 · The three tasks

All three follow the shape the runtime already enforces: a deterministic
generator produces candidates, the model answers a bounded question about one
of them with evidence attached, abstention is a first-class answer, and every
verdict is cache-keyed so an unchanged chapter is never re-asked.

### 3.1 Attribution tie-break (`attribution-review.ts`) — WITHDRAWN, see §7

The engine's own uncertainty is the queue: spans where a speaker was chosen but
the confidence landed between `PRONOUN_MIN_POSTERIOR` (0.25) and
`ATTESTED_FLOOR` (0.78). It already computes the candidate ranking, so the
model is choosing between named options, never naming someone new.

- **Evidence**: the quoted line, the two paragraphs before it, the engine's top
  candidates with their scores, and who spoke the previous two attributed lines
  (dialogue alternates; that is most of the signal).
- **Schema**: `{reason, speaker, confidence}` — reason first, per the ordering
  lesson. `speaker` is an enum of the offered candidates plus `"unsure"`.
- **Guards**: a speaker outside the offered set is dropped. A verdict below
  0.7 is discarded rather than applied — this writes into the adaptive store,
  and a wrong confident answer teaches the ranker the wrong thing.
- **Where it lands**: `AnnotationCorrection`-shaped, via the existing adaptive
  path, so it improves every widget downstream. It is never applied silently to
  a span the writer already corrected.

### 3.2 Chekhov confirmation (`chekhov-review.ts`)

`continuity.ts` finds definite-article noun phrases introduced and never
mentioned again. It is a regex, so it surfaces furniture as often as it
surfaces a loaded gun.

- **Evidence**: the phrase, its introducing sentence, the chapter it appeared
  in, and how many chapters have passed since.
- **Schema**: `{reason, verdict, confidence}` with verdict
  `promise | furniture | unsure`. "Furniture" is the honest majority answer and
  must be cheap to give.
- **Guards**: only `promise` at ≥0.7 surfaces. Everything else renders nothing,
  and the deterministic list stays as it is today for anyone who opens it.

### 3.3 Scene-function adjudication (`scene-review.ts`)

Only the near-misses: scenes where the top candidate cleared its gate but fell
short of `FLOOR` (1.2) or lost the `MARGIN` (0.08) test. A scene that produced
no candidate at all is silence on purpose and is not asked about.

- **Evidence**: the scene's paragraphs (capped), its tension band, and the two
  or three labels that nearly won, with their scores.
- **Schema**: `{reason, label, confidence}`, `label` an enum of the near-miss
  candidates plus `"none"`.
- **Guards**: `"none"` is the default and costs nothing. A label is applied
  only at ≥0.7, and it is marked as model-sourced so the corpus harness can
  still measure the deterministic engine separately — **the accuracy gates in
  `test-scene-labels.ts` must keep measuring the engine alone**, or the next
  person tuning it will be tuning against the model's answers.

## 4 · Scheduling

One shared sweep, not three. It reuses the adjudication scheduler already in
`App.tsx`: idle ≥3s, `assistantAvailable()`, hidden-window defer, 30s retry,
cancellation on cleanup. The order is fixed and states the priority:
**attribution → scene → Chekhov**, because attribution feeds everything else
and a wrong speaker poisons the widgets that read it.

Per chapter the sweep spends its caps and stops. It moves to the next chapter
only when the current one is settled, and any edit to a chapter drops its
pending work rather than finishing it.

## 5 · Verification

- `scripts/probe-assist-funnels.ts` — kept. It is the measurement this spec is
  built on, and re-running it is how anyone checks the caps still fit.
- `scripts/test-assist-reviews.ts` — pure gates, no model: ranking and cap for
  each task, enum-outside-offered rejected, low confidence discarded,
  abstention preserved, cache keys move with content.
- `scripts/verify-assistant-tasks.cjs` — three live cases added to the ONE
  existing Electron harness, each with a deliberate right answer and a control
  that must NOT be answered confidently.
- `test-scene-labels.ts` unchanged and still measuring the engine alone.

## 6 · Explicitly not built

- **Hand-off drift adjudication** — 0.04/chapter. Measured, rejected.
- **Sweeping every attribution tie** — 43/chapter. The cap is the feature.
- **Applying a verdict to a span the writer has already corrected** — their
  decision outranks the model's, permanently, as with knowledge rulings.

---

## 7 · What the implementation changed, and why

Written after the code existed and the real model had answered. Four departures
from §1–§6, each forced by a measurement or by reading the code §3 described.

### 7.1 Attribution is withdrawn (§3.1, §4)

The funnel said there was work here — 43.62 ties a chapter — and the cap made
it affordable. What the funnel could not say is whether the model can do the
work. `scripts/probe-attribution-anchor.cjs` asked it, on five cases whose
answer the prose fixes: three where the engine had guessed wrong and two where
it had guessed right, so "always overturn" scores no better than "always agree".

| presentation of the offered names | right | declined | **wrong-applied** |
|---|---|---|---|
| incumbent first + annotated (as specified) | 1 | 0 | **4** |
| incumbent first, plain | 1 | 1 | **3** |
| incumbent last + annotated | 1 | 0 | **4** |
| alphabetical, unmarked | 1 | 1 | **3** |

The first hypothesis was anchoring: the engine's guess is printed first *and*
annotated as the current answer. **Falsified** — removing both changes nothing,
and the same case is right and the same cases wrong in all four. The reasons
show the actual failure: the model asserts evidence that is not there ("the line
directly names the speaker", for lines naming nobody) and inverts the reply
direction, naming whoever a line ANSWERS instead of whoever speaks it. Restating
the direction twice in the prompt (`ATTRIBUTION_PROMPT_VERSION` 2) did not move
it.

Every wrong answer arrived at 0.8–1.0 confidence, so §3.1's floor cannot filter
them: **no threshold separates the right answers from the wrong ones.** The
engine's own posterior is better than that, which makes the task net-negative at
1.7B — and a suggestion wrong three times in five, carrying a fluent reason,
costs a writer more attention than it saves.

The module and its gates are kept, unwired. To wire it back: run the probe
against the candidate model and require **wrong-applied = 0**, not merely a
better `right` — a declined answer costs nothing because the engine keeps its
own attribution, and a confident wrong one is the only failure that costs.

### 7.2 Even if it had worked, it would not have auto-applied (§3.1)

§3.1 said the verdict lands "`AnnotationCorrection`-shaped, via the existing
adaptive path". Reading that path rules it out: it feeds the writer's EXPORTED
annotation corpus and runs `applyOnlineAdaptiveUpdate`, which trains the ranker
on the spot. Auto-applying there is a self-training loop with no human in it,
gated on a model's self-reported confidence, quietly mixing model guesses into
the corpus the writer exports as ground truth. The design was a popover
suggestion the writer confirms. §7.1 removed the need for it.

### 7.3 The sweep is scoped to the chapter the writer is in (§4)

§4 has it moving to the next chapter when the current one settles. Scene
near-misses need a full chapter analysis, which exists for the ACTIVE chapter
only; sweeping the book would mean re-analysing every chapter first. Scoping to
the visited chapter puts the work where its result is visible and costs nothing
for a book nobody is reading.

### 7.4 A scene the engine labelled is never asked about (§3.3)

§3.3 defines a near-miss by FLOOR and MARGIN. That is incomplete:
`classifyScene` also refuses to repeat the previous scene's label, stepping down
to the runner-up and labelling the scene with THAT. The raw scores then read as
a margin loss on a scene the engine answered. `meta.sceneLabel` is what the
engine concluded, so it is what filters.

### 7.5 Two defects the gates caught before shipping

- **One line, two spellings.** The engine's prediction trace stores a quote's
  CONTENT; the editor's annotation target stores the whole SEGMENT, marks
  included. A `===` between them is not a strict guard, it is an off switch —
  every suggestion resolves to null, silently, with no error anywhere. (Removed
  with §7.1, but the shape recurs anywhere those two sides meet.)
- **A gate that read green while proving nothing.** The scene-exclusion fixture
  used two-word paragraphs, below `sceneCandidateScores`'s 45-word floor, so
  EVERY scene was absent and the exclusion was never tested.

### 7.6 A fixture whose answer is a judgement call is not a gate

The first scene pair failed the live harness and **both failures were the
fixture's fault**: the positive case was three parts interiority to one part
decision, so the model's "reflection" was defensible; the control held a
sustained argument, so its "friction" was defensible too. Gating either would
have gated my reading of prose — the thing this harness explicitly refuses to do
for chip labels — and would have been tunable by rewording the prompt until the
model shared my opinion. Both were rebuilt so the evidence fixes the answer.

### 7.7 Final shape

| task | cap | status |
|---|---|---|
| attribution | — | built, measured, withdrawn (§7.1) |
| scene function | 3 | shipped |
| Chekhov | 2 | shipped |

Five questions a chapter, ~3s of idle work, both controls declined correctly by
the real model (`scripts/verify-assistant-tasks.cjs`, 30/30).
