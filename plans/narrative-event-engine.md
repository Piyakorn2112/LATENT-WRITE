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

## 4 · What is still wrong, honestly

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
