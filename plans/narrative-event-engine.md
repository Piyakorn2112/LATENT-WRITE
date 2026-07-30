# Narrative Event Engine — diagnosis, rebuild, and what is still open

Written 2026-07-30. The arc timeline's events did not describe what happens in a
chapter. This records what was actually wrong (measured, not asserted), what
replaced it, how it is proved, and what a real LLM would add on top.

---

## 1 · The diagnosis, in numbers

Every figure below came from running the shipping pipeline over the two sample
manuscripts. Nothing here is an impression.

### The engine

Measured over **80 events across 30 chapters**, both books:

| Defect | Measurement |
|---|---|
| `confidence` carried no information | **95%** of events reported exactly `1.00`; **3** distinct values across all 80. `min(1, total / 2.5)` saturated. |
| The type was mostly a fall-through default | `confrontation` was 36.3% of output and is the initial value of `dominantType`. "It stretched ahead of her" and "Dreams bled between bodies" were both typed as confrontations. |
| Labels were sentence fragments | 18.8% ended in an ellipsis, 13.8% were a bare quotation. "She delivered most of her". "The performed vote". "She watched people". |
| Events clustered at the chapter's edges | 13.8% in the first 5% of the chapter, where by construction nothing has changed yet. |
| Nothing separated a happening from a description | **48.8%** of anchors were past perfect (backstory), habitual, modal, bare copula, or had no agent. |
| Yield ignored the prose | 2.67 events per chapter, std dev 0.67, correlation with chapter length **0.03**. |

### The dictionaries

249 phrases across 6 dictionaries; **170** of them multi-word (the tuned ones):

- **45%** occur in Hollow Iris and **not** in The Root Crown
- **24%** occur in **neither** book
- `INTELLECTUAL_DISCOURSE` matched 87% in Hollow Iris against 24% in Root Crown

It was a Hollow Iris detector. On a third manuscript almost nothing fires and the
engine degrades to punctuation, entity density and vocabulary-novelty noise —
which is exactly what the edge bias above is.

### The tension curve, which everything cites

`analyzeChapter` reduced tension to ≤30 samples by **point-sampling** one
paragraph per bucket. Over 40 chapters longer than 30 paragraphs:

- **49.1%** of paragraphs never entered the curve at all
- the curve never reached the chapter's real maximum in **15%** of chapters
- locating the peak by inverting the curve named a paragraph that was **not** at
  the chapter's maximum tension in **47.5%** of cases

The "This chapter" box says "One spike at ¶34 carries the chapter" and offers a
Go-to-¶34 button. Roughly half the time that number was wrong.

### The box itself

Over 52 chapters the box produced **six distinct sentences**. 17 chapters got
`"Two peaks, near ¶N and ¶N, with a slack stretch between them."` verbatim.
30.8% got a diagnostic scold instead of an observation. 48% had no anchor.

### And the LM had never run offline

`@xenova/transformers` v2 statically imports `sharp`, whose native binary is not
built in this pnpm store. Electron's main process stubs it; no script did. So
importing `narrative-lm.ts` under `tsx` threw at import time, and
`enrichChapterEntryWithLM` wraps the whole pass in `catch { return entry }`.

`test-event-labels.ts` therefore reported **"relabeled events: 0/6 (0%)"** — and
that zero was readable as "the LM agrees with the dictionary" when it actually
meant "the LM was never loaded". Nothing logged. Nothing failed.

---

## 2 · What replaced it

`src/lib/narrative-events.ts`. Four changes of principle.

### The unit is a clause, not a paragraph

Scores were computed per paragraph and the label was then scavenged from anywhere
inside it, so the agent, verb, type and label could each come from a different
sentence. "The records system was imperfect" was emitted as a revelation from a
paragraph beginning "She began with the obvious."

An event is a clause. The label is now generated from the same clause that
triggered detection, so it cannot disagree with its own evidence.

### Verb classes, not memorised phrases

Verbs are a closed class and generalise; multi-word idioms are open and do not.
The lexicon maps verb lemmas to event types (`refuse` → decision, `admit` →
revelation, `depart` → departure) and inflection is handled morphologically.

### A realis test

Backstory, habit and hypothetical are penalised, not silently accepted. The
penalties are **subtractive rather than fatal**, and the confidence is calibrated
**within** the chapter, so a wholly retrospective chapter still ranks its own best
clauses instead of returning nothing.

This matches LitBank's definition of a literary event (asserted realis; Sims, Park
& Bamman, ACL 2019) with one deliberate divergence: LitBank excludes negated
events, and this engine keeps them, because a refusal is one of the strongest
beats in this corpus.

### Two channels, because the events are in the dialogue

The gold annotations made this obvious and it was the single most useful finding
of the whole exercise. Most events in this fiction are **attributed dialogue
acts**: "Tessa reveals Brennan knew Mira doesn't age" is a speaker plus a speech
act plus its content, not the surface subject-verb-object of the quoted sentence.

Speaker attribution is this app's strongest signal — `speech-detect` runs at ~96%
in high mode — and the old event engine used it as a flat `+0.2` for "contains a
quotation mark". So:

- **NARRATION** — a realis clause: agent + change-of-state verb + object
- **DIALOGUE** — an attributed utterance whose act has consequences

Both yield an (agent, act, object) triple, which is what makes a label fit the
timeline's real budget of ~28 characters: short by construction rather than
truncated after the fact.

### Supporting fixes

- **Tension curve**: aggregate per bucket instead of point-sampling. Peak level is
  now never lost (15.0% → 0.0%).
- **`analysis.peakParagraph`**: a new field locating the peak from the full
  per-paragraph signal, tie-broken to the middle of the longest run at the
  chapter maximum. Off-peak 47.5% → **0.0%**.
- **`MajorEvent.sentence` / `.paragraphIndex`** persist. The source clause was
  previously computed and thrown away, which is why the timeline could show a
  four-word chip with no way to see what it referred to.
- **The LM stopped relabelling.** It would have put the truncated sentences
  straight back. It now does semantic dedup and detail tags only, and says so out
  loud when no backend is reachable.

---

## 3 · How it is proved

Two suites, on the pattern this repo already uses for speech detection.

### `npm run test:event-detect` — the gold set

`scripts/fixtures/event-gold.json`: 22 hand-annotated events across 5 chapters of
both books, deliberately spanning quiet (2 events / 29 paragraphs) to eventful
(9 events / 32 paragraphs), so a detector that emits a fixed three cannot score
well.

**The fixture self-checks before scoring.** Every gold event carries an `evidence`
clause copied from the text and the harness confirms it occurs where it claims. A
shifted paragraph split would otherwise turn the whole set into plausible-looking
near-misses and the suite would report a confident, meaningless number.

Scoring uses **±1 paragraph tolerance**, which is not a convenience: RAMS measured
agreement between its own trained annotators at 55.3% on exact boundaries and
69.9% at ±1, so humans do not agree on the exact anchor and an exact-match metric
would mostly measure annotation noise. SoftED found soft-vs-hard scoring changed
which detector won in over 36% of evaluations.

| | OLD | NEW |
|---|---|---|
| emitted (for 22 gold) | 14 | 21 |
| matched (±1 ¶) | 4 | **12** |
| exact anchor | 0 | **8** |
| precision | 28.6% | **57.1%** |
| recall | 18.2% | **54.5%** |
| **recall on major events** | 27.3% | **63.6%** |
| F1 | 22.2% | **55.8%** |
| type correct, of matched | **0.0%** | **50.0%** |
| label ↔ gold token overlap | **0.0%** | 20.7% |
| labels fitting the UI budget | 50.0% | **100%** |

The old engine got the type wrong on **every single matched event**, and its
labels shared **no content words** with what a reader said happened.

Type accuracy is reported but not gated. Gius & Vauth's literary event typology
reached Krippendorff's α of only 0.57–0.75 among trained literary scholars on a
*coarser* four-way scheme, so moderate type agreement is a property of the domain.
Position and salience are the gates.

### `npm run audit:ood-events` — label-free, whole manuscripts

Hollow Iris (in-distribution for the old dictionaries) against The Root Crown
(held out). The point is the **gap** between the columns.

| | OLD in-dist / held-out | NEW in-dist / held-out |
|---|---|---|
| distinct confidence values | 3 / 5 | **121 / 34** |
| confidence at the ceiling | 97.0% / 80.0% | **0.0% / 0.0%** |
| events in the first 5% | 13.0% / 10.0% | **8.2% / 2.0%** |
| labels over budget | 55.0% / 45.0% | **0.0% / 0.0%** |
| labels truncated | 16.0% / 15.0% | **0.0% / 0.0%** |
| yield std dev | 0.67 / 0.50 | **2.38 / 1.56** |
| yield ↔ length correlation | 0.03 / 0.60 | 0.45 / 0.02 |

The confidence channel now carries information, the labels always fit, the edge
bias is roughly halved, and yield responds to the chapter instead of being a
constant.

---

## 3a · CORRECTION: the 5-chapter numbers were optimistic

The table above was measured on a 22-event / 5-chapter gold set. Expanding it to
**45 events across 11 chapters** re-scored the SAME code far lower:

| | 22 events, 5 chapters | 45 events, 11 chapters |
|---|---|---|
| precision | 57.1% | 35.7% |
| recall on major events | 63.6% | 56.0% |
| F1 | 55.8% | 39.6% |
| type correct | 50.0% | 55.0% |

The larger set is the honest one. Never quote a figure without saying which set
produced it. Two further reversals came out of the same expansion:

- **The dialogue channel was far weaker than it looked.** One new chapter lost
  ALL FIVE of its events, every one an ordinary `"…," she said` line whose act
  lives in the content ("You're defending the system", "I want someone to know").
  Requiring a coloured attribution verb or one of four hand-written openings was
  the phrase-dictionary mistake one level down. Replaced with a general rule:
  a first- or second-person claim, or an imperative. Major recall 44.0% → 56.0%.
- **The LM lost.** At n=22 anchor classification appeared to beat the engine's
  verb-based typing (63.6% vs 50.0%); at n=44 it is 43.2% against 55.0%. It is
  therefore NOT wired into the type path. A verb is stronger evidence of what a
  clause does than a cosine against a description of a category.

## 3b · The LM, now tested

`npm run test:narrative-lm`. Until it existed, no test had executed a single
embedding, for the reason in section 1. Its first assertion is a hard gate on the
backend loading and must never be softened into a skip.

| variant | top-1 | top-2 |
|---|---|---|
| single anchor, uncalibrated (the shape that shipped) | 27.3% | 34.1% |
| five anchors per class, uncalibrated | **43.2%** | **52.3%** |
| five anchors + null-anchor calibration | 40.9% | 47.7% |

**Multi-anchor is a large real win.** The single-anchor shape sat at 27.3% against
a 12.5% chance baseline for eight classes: it was barely working. That, not "the
embeddings are bad", is the honest diagnosis.

**Null calibration did not help** and defaults off. "Calibrate Before Use" is
about generative label scoring and the correction does not appear to transfer to
cosine over multi-anchor means. It costs ~2 points consistently. The option stays
so the claim remains testable rather than folklore.

Also measured: **4.0 ms per embed**, so a p90 chapter (270 sentences) costs ~1.1 s
of embedding. That is the headroom that makes a bigger embedding model viable and
a generative model not, on a weak machine.

## 4 · What is still wrong, honestly

**Precision is the open problem: 35.7%, and it is FLAT across the whole usable
confidence range (32–37%).** No threshold fixes it — the false positives score as
high as the true positives, so it is a candidate-quality problem. Two attempts
that measured as net losses and were reverted, recorded so they are not retried
blind: rejecting content-less dialogue acts outright (cost 12 points of major
recall), and rejecting pronoun object heads at extraction time (same). Both are
handled by scoring now instead.

**`action` dominates the held-out book at 54.0%**, and the type entropy gap
between in-distribution and held-out (0.11) is slightly *worse* than the old
engine's (0.07). `action` is the widest class in the lexicon and a domestic rural
novel is made of people opening doors and pouring drinks. Requiring a real object
or a specified clause moved it from 58.9% to 54.0%; it needs a better answer than
that, probably splitting the class or requiring the persistence signal.

**This was deliberately not tuned further.** Tuning against the out-of-distribution
audit would destroy the only thing that makes it worth having. The gold set is
what gets tuned against; the audit is what gets reported.

**The operating point rests on 22 gold events.** The confidence floor was chosen
by sweeping, and F1 is flat from 0.28 to 0.52, so the exact value is not
meaningful to two decimal places. Re-run the sweep whenever the gold set grows.
One useful thing the sweep showed: cleaning up the *candidates* moved the optimum
floor **down**, because the floor had been suppressing junk by suppressing
everything. A threshold that has to be high is a symptom.

**Label ↔ gold token overlap is 20.7%.** Up from zero, but that means the label
usually names the right beat with different words than a reader would choose.
This is the ceiling of a heuristic: "Helia authorizes firing" is correct and
useful, and "Helia orders the fatal orbital strike" is what a person writes. The
gap is abstraction, and abstraction is what a generative model is for.

**The gold set is only 5 chapters from 2 books.** It needs genuinely
out-of-distribution prose — a different author, a different register — before any
of these numbers should be quoted as generalisation.

---

## 4a · STATUS CORRECTIONS (this document went stale within one commit)

Read this before section 5. An architecture pass caught the doc describing its
own unfinished work as future when it had already shipped, which is exactly how a
plan file becomes misleading.

**The LM salience pass is DONE, not future.** `refineEventSalience` is in
`narrative-events.ts` and wired through `story-graph.ts`. It took precision from
32.8% to 41.7% on the set current at the time.

**The numbers throughout this document are from a ONE-AUTHOR gold set and are
optimistic.** The current measurement, on 103 events across 19 chapters of EIGHT
books by seven authors:

| | value |
|---|---|
| major events found anywhere | 40.7% |
| major events reaching the top four chips | **22.0%** |
| precision over all output | 25.5% |
| precision@4, what a writer sees | 31.1% |
| labels fitting the timeline uncut | 100% |

**The named next defect is the RANKING, not precision or recall.** Major-event
coverage in the top four (22.0%) is about half what the engine finds overall
(40.7%), so confidence is close to uninformative about correctness and the engine
buries real events under false ones. Until that is fixed, further recall work
barely reaches the writer.

**One performance fact this document should have carried.** The intelligence
tier dial described in the README no longer exists. `intelMode` is off/auto, and
auto CONVERGES: a fast pass on every edit, then the `high` pass replaces it when
the writer pauses (`src/App.tsx:306`, `src/lib/use-analysis.ts:96-100`). So the
expensive tier is the default on every pause, and event detection rides that
pipeline. The one-entry memo in `detectNarrativeEvents` means unchanged content is
free, but an edit followed by a pause re-detects the whole chapter.

## 5 · The LLM path, and why it is not in this change

The brief was to try the heuristic route first. That is what shipped. This is the
groundwork for the next step, from the research pass.

The one technique that addresses the remaining label gap is the only one that
changes the *kind* of output produced: a small instruct model reading the detected
clause and generating a description, rather than assembling one from parts. A
classifier can only pick among labels; it cannot describe.

### Runtime options

| Runtime | Offline | Bundle cost | Native rebuild | GPU | Structured out | macOS only | Biggest risk |
|---|---|---|---|---|---|---|---|
| **node-llama-cpp** | yes | 0.25–2.5 GB (weights dominate) | no, prebuilt N-API | Metal | GBNF + JSON-schema | no | electron-builder is documented to fail bundling ~2 GB via `extraResources`; use download-on-first-run |
| **Apple Foundation Models** via a spawned Swift helper | yes | ~0 | no (separate binary) | Neural Engine | native `@Generable` | yes | needs the user to have Apple Intelligence on; 4096-token context; the Node bridge packages are small and one looks stale |
| transformers.js + WebGPU | yes | small + weights | no | **renderer only** | manual | no | WebGPU does not reach the main process, so it cannot replace `onnxruntime-node` here |
| ONNX Runtime GenAI | yes | — | — | CoreML/CPU | library | no | **no official Node binding exists** |
| MLX (mlx-swift) | yes | small + weights | no | best on Apple Silicon | via Swift | yes | no Node bindings; same Swift-helper investment as Foundation Models |
| Ollama sidecar | after pull | binary + model | no | Metal | JSON mode | no | a whole extra server lifecycle for one narrow task |

**Recommended: `node-llama-cpp` in a dedicated `utilityProcess`, with Apple
Foundation Models as an opportunistic higher-quality tier when available.** It is
the only option that is both Electron-proven and platform-portable, and it slots
into the main-process-plus-IPC shape this app already uses for `onnxruntime-node`.

Model shortlist, licence-first because this ships in a paid app: **Qwen3-4B**
(Apache 2.0, ~2.5 GB Q4), **SmolLM3-3B** (Apache 2.0, ships official GGUF / ONNX /
MLX), **Phi-4-mini** (MIT). Avoid Llama 3.2 — its custom licence requires carrying
attribution and licence text downstream. Gemma's terms permit commercial use but
are non-OSI with a prohibited-use policy.

Two findings worth heeding before writing any of it:

1. **Constrain late, not from token one.** Naive full-sequence grammar constraining
   measurably degrades quality, worst in exactly the small-model regime here: a 1B
   model on GSM8K scored 15.2% under naive constraining against 39.0% with an
   unconstrained draft first. Let the model write, then constrain a trailing JSON
   block.
2. **Do not rip out the embedding path.** The assumption that anchor-cosine is
   inherently weak is not well supported — modern sentence-embedding similarity
   beat NLI zero-shot on 3 of 4 datasets in one 2022 benchmark. The real, narrower
   diagnosis is one hand-written anchor per class and no calibration. The cheap
   fixes are several paraphrased anchors per type and a null-anchor subtraction
   (the "Calibrate Before Use" correction), which is why `setEmbedder` and the
   anchor tables were kept rather than deleted.

### Also worth doing regardless

`@xenova/transformers` is the deprecated name; `@huggingface/transformers` is the
maintained successor and drops the `sharp` dependency that hid the LM from every
offline test for months. Migrating removes the entire class of failure that
`scripts/lm-node-backend.ts` currently works around.

---

## 6 · Files

```
src/lib/narrative-events.ts        the engine. Read its header first.
src/lib/chapter-observation.ts     the "This chapter" brief
src/lib/chapter-analysis.ts        tension curve + peakParagraph
src/lib/story-graph.ts             builds entries; LM dedup pass
src/lib/narrative-lm.ts            embeddings + the setEmbedder seam
src/lib/event-detect.ts            SUPERSEDED. Kept so the suite can score against it.

scripts/test-event-detect.ts       gold scoring, gated
scripts/fixtures/event-gold.json   22 annotated events, 5 chapters
scripts/ood-event-audit.ts         label-free, whole manuscripts
scripts/lm-node-backend.ts         makes the LM reachable from tsx
scripts/print-chapter.ts           numbered paragraphs for annotating
```

```bash
npm run test:event-detect                 # both engines, gated on the new one
npm run test:event-detect -- --detail     # per-chapter alignment, every miss
FLOOR=0.4 npm run test:event-detect       # sweep the operating point
npm run audit:ood-events                  # label-free, in-dist vs held-out
npm run print:chapter root-crown 16       # numbered paragraphs, for annotation
```

---

## The precision/recall frontier, mapped (2026-07-31)

Target for this stretch was **+5 points on all five metrics at once**. That is not
available, and the useful outcome is knowing exactly why rather than another
round of guessing. Baseline, and everything measured against it:

    baseline                      p@3 50.9  majShown 22.0  majRecall 45.8  prec 35.3  F1 40.5

**Levers that move ALONG the frontier and cannot leave it**

| change | p@3 | majShown | majRecall | prec | F1 |
|---|---|---|---|---|---|
| prune cut -0.14 | 47.4 | 25.4 | 54.2 | 29.0 | 37.8 |
| prune cut -0.11 | 48.2 | 23.7 | 50.8 | 30.1 | 38.0 |
| prune cut -0.03 | 46.2 | 23.7 | 42.4 | 35.0 | 37.3 |
| confidence floor 0.40 | 49.1 | 25.4 | 39.0 | 33.0 | 34.4 |
| confidence floor 0.55 | 47.8 | 20.3 | 25.4 | 44.3 | 32.9 |
| +event anchors, cut -0.05 | 49.1 | 25.4 | 50.8 | 31.3 | 38.7 |
| +event anchors, cut -0.11 | 45.6 | 23.7 | 54.2 | 28.0 | 37.0 |
| +both anchor sets, cut -0.05 | 47.4 | 27.1 | 50.8 | 31.0 | 37.2 |
| +description anchors only | 47.2 | 20.3 | 42.4 | 34.7 | 37.9 |

Every row trades. The best recall point costs ~4 points of precision; the best
precision point costs ~20 points of major recall. Nothing dominates the baseline,
so the baseline ships.

**Levers measured and found empty**

- **Refitting the scorer weights.** Saturated. Three attempts; the first won 15
  points because the SIGNS were wrong, the next two lost. Lift is a marginal
  association, not a conditional effect, and the features are correlated.
- **Expanding CHANGE_VERBS.** Rejected on BOTH paths, for different reasons.
  Entity path: flat tail, top ten verbs are 24% of 152 and mostly non-events
  ("The tea cooled"). Person path: this is the single largest funnel loss in the
  engine — 450 of 886 subjects, 50.8% — but the verbs are `looked, stood, sat,
  felt, saw, knew, heard, seemed`. Perception and posture. Admitting them
  recreates the "She thinks about hands" defect the engine was built to fix. The
  gate is doing deliberate work; the 50.8% is not a bug.
- **Crossing a subject's prepositional post-modifier.** 17 subjects recovered,
  ZERO gold events.
- **Fronted adverbials** ("With an effort I turned", "…, he hurled the woman").
  Linguistically real and it fires 78 times, but exactly neutral at the shipped
  anchors — the recovered clauses die at the same verb gate. NOTE: it turns
  POSITIVE (+1.7 p@3, +1.6 majRecall) when combined with the extended event
  anchors, because those let the clauses survive the prune. If the anchors are
  ever revisited, revisit this with them; alone it is worth nothing.
- **Blending LM salience into confidence, retested with better anchors.**
  Still monotonically harmful (w=0 → 0.4 → 0.8 → 1.5 falls 49.1 → 49.1 → 47.4 →
  42.1). The earlier conclusion was not an artifact of weak anchors. MiniLM
  prunes well and ranks badly, full stop.

**Where the frontier actually comes from**

Of 59 major events the engine finds 27, and 13 of those 27 reach the three chips.
So two independent ceilings:

1. **Recall.** The 24 never found split 33% first-person subject, 33%
   third-person named, 25% verbless or elliptical fragments.
2. **Three slots.** Even perfect ranking caps majShown at 3×19/59 = 96.6%, and
   every minor event that is genuinely correct competes for the same slots.

Moving majShown to 80% needs recall well above 80% AND near-perfect ranking. It
is not reachable by tuning; it needs a detector for interior/first-person
decisions, which is a different mechanism from anything in the file today.

---

## Does a trained model beat the hand-written rules? (2026-07-31)

Answer: **not today, and the reason is labelled data rather than model class.**
`scripts/train-event-ranker.ts` is the experiment; it stays in the repo because
the question will be asked again.

**Why a model was worth trying at all.** Not a general appeal to ML. The
hand-fitted weights saturated for a SPECIFIC reason: `analyse-event-signals.ts`
measures each signal's MARGINAL association with being right, and the features
overlap heavily, so fitting each to its own marginal double-counts what they
share. A logistic regression fits them JOINTLY. That is precisely and only the
thing hand-fitting cannot do.

**Evaluation protocol.** Leave-one-BOOK-out, always. 204 candidates against 30
features will memorise happily, and rows from one book share an author's voice,
so any split that mixes them measures memorisation. The hand-fitted weights are
scored on the identical held-out split.

| model | held-out precision@3 | vs hand-fitted 47.4% |
|---|---|---|
| pointwise logistic, lean features, L2=0.3 | **49.1%** | **+1.8pp** |
| pointwise, L2=0.6 | 47.4% | 0.0 |
| pointwise, L2=0.03 (underregularised) | 43.9% | −3.5 |
| pointwise + 5 structural features | 43.9% | −3.5 |
| pairwise / RankNet, lean | 40.4% | −7.0 |
| pairwise, L2 ≥ 0.3 | 36.8% | −10.5 |

**+1.8pp is one chip out of 57. That is not a result**, and it should not be
shipped as one.

Three things worth keeping from it:

1. **More features made it WORSE.** Adding baseConf, centrality, peak-distance,
   sentence length and candidate density took held-out precision from 49.1% to
   43.9%. On 204 rows that is the signature of too many parameters, and
   leave-one-book-out is what makes it visible — in-sample it looked better.
2. **Pairwise learning-to-rank LOST BADLY**, which was not the expectation. The
   reasoning for trying it was sound (the product needs an ORDER, not a
   probability, and pairs multiply the training signal ~30x from the same
   labels). It fails anyway, most likely because pairs discard the absolute
   calibration the hand engine's confidence already encodes, and because chapters
   with many candidates dominate the pair count. Recorded so the idea is not
   re-derived from first principles and re-run.
3. **The strongest learned coefficient was `position` (+0.565)** — where in the
   chapter the clause sits. The hand rules only penalise the extreme first and
   last 4%. That is the model pointing at a genuinely under-used STRUCTURAL
   signal, and it is the most useful thing the exercise produced.

**The learning curve is the decisive measurement.** Train on k books, evaluate on
the rest, sweep k:

    2 books  38.3%
    3 books  40.9%
    4 books  40.6%
    5 books  43.8%
    6 books  36.6%      (noise — the test set is only 2 books here)
    7 books  48.7%      ← crosses the hand-written baseline of 47.4%

Noisy, because the test set shrinks as k grows. But it has **not plateaued**, and
it crosses the hand-written rules exactly at the largest training set that can be
built from the current fixture. So:

> The constraint is GOLD DATA, not the model. A trained ranker is worth revisiting
> at roughly 2–3x the current annotation (say 20+ books, 250+ events), and is not
> worth shipping below that. Until then the hand-written rules are both more
> accurate and far lighter, which is the outcome the owner preferred anyway.

If that annotation ever happens, start from: pointwise logistic, LEAN feature set,
L2 ≈ 0.3, leave-one-book-out. Do not start from pairwise, and do not add
structural features until the sample supports them — both are measured above.
