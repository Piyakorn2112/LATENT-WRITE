# Assistant wave 2 — attribution, continuity, scene function

> Status: SPEC, measured before designed. Every number below came from
> `scripts/probe-assist-funnels.ts` over 73 DEV chapters (pride, sherlock,
> anne, dracula, carol, webnovel). Written 2026-08-03.

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

### 3.1 Attribution tie-break (`attribution-review.ts`)

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
