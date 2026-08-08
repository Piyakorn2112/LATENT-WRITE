# Is there a better model for On and Max? Researched, downloaded, measured

**Date** 2026-08-08 · **Hardware** Apple M1 Pro, 16 GB · **Outcome** keep both
shipping models, one candidate is disqualified outright and the other is a tie
that costs memory

## What we ship today

| mode | model | Q4_K_M | licence | context |
|---|---|---|---|---|
| **On** (small tier) | Qwen3-1.7B | 1.11 GB | Apache-2.0 | 4096 |
| **Max** | Qwen3-4B-Thinking-2507 | 2.50 GB | Apache-2.0 | 8192 |

Constraints that decide everything below. The licence must be Apache-2.0 or MIT
because this ships in a paid app. The Max tier is sized against an **8 GB
machine**, so weights plus KV must stay near 3.7 GB at 4k. Output is always
**GBNF grammar-constrained JSON**, either through node-llama-cpp in the
in-process host or through llama-server's native `/completion` with a
precompiled grammar. MoE is useless here because every expert stays resident.

## 1. Research verdict

Two candidates survived licence, size, GGUF availability and llama.cpp support.
Everything else failed a hard gate, and the full disqualification list is at the
bottom.

| slot | candidate | Q4_K_M | licence | why it was worth testing |
|---|---|---|---|---|
| On | IBM Granite-4.0-1B (dense) | 1.02 GB | Apache-2.0 | IFEval-strict 80.82, BFCL v3 54.82, both strong for the size class |
| Max | Qwen3.5-4B | 3.01 GB | Apache-2.0 | Qwen's own card claims IFEval 89.8 vs 87.4, MMLU-Pro 79.1 vs 74.0, GPQA-D 76.2 vs 65.8 over our current Max |

Both were verified to exist on Hugging Face, downloaded, and checked for the
GGUF magic bytes before any claim was made about them.

One reported risk turned out not to apply. [llama.cpp#20345](https://github.com/ggml-org/llama.cpp/issues/20345)
reports grammar enforcement going silently inactive when `response_format` is
combined with `enable_thinking` on the OpenAI-compatible endpoint, reproduced on
Qwen3.5. We do not use that endpoint. The sidecar posts to the native
`/completion` with a precompiled `grammar`, and the in-process host compiles
GBNF through node-llama-cpp, so neither path goes through `response_format`.

## 2. A note on how the tests had to be fixed first

`ASSISTANT_MODEL_PATH` swaps the **weights** but the tier's **config** still
comes from the registry. Pointing it at the 4B therefore ran a thinking-only
model with the small tier's `noThink: true`, and the harness printed
`model: Qwen3 1.7B` while loading 4B weights. That run reported 2/30 failures and
was meaningless. Any candidate comparison done this way is measuring a
misconfiguration.

Two inputs were added, both defaulting to exactly the old behaviour, so every
historical number stays comparable:

- `PROBE_TIER=max` uses the registry's max config (`noThink` false, 8k context)
- `PROBE_NOTHINK=0` stops appending `/no_think`, which is a **Qwen token** and is
  literal junk in a Granite or Gemma prompt

Verified afterwards that the default path is unchanged: 30/30, 926 tokens, same
as before the edit.

## 3. Results

### 3a. Task gate suite (30 gates, real model, small-tier tasks)

| model | gates | tok/s |
|---|---|---|
| **Qwen3-1.7B (ships, On)** | **30/30** | 83.1 |
| Qwen3-4B-Thinking (ships, Max) | 28/30 | 33.3 |
| Qwen3.5-4B (candidate) | 27/30 | 25.2 |
| Granite-4.0-1B (candidate) | collapsed, see below | n/a |

**Bigger is not better on the tuned tasks, and that is the headline.** Both 4B
models lose gates the 1.7B passes, at a third of the speed. The current Max
answers `plausible_offscreen` for every adjudication pack. Qwen3.5-4B fixes that
one but goes silent on three chip cases, returning zero picks where the gate
wants three.

This is not a defect in the big models so much as a fact about tuned prompts.
The chip prompt is at v5 and the adjudicator at v1, both iterated against
Qwen3-1.7B. **Swapping the model invalidates the tuning**, which is a cost no
benchmark table shows.

### 3b. Attribution anchoring, the withdrawn feature

Five cases whose answer the prose fixes, each under four presentations. The ship
condition set in `attribution-review.ts` is **WRONG-APPLIED must be 0**.

| model | right | declined | WRONG-APPLIED |
|---|---|---|---|
| Qwen3-1.7B (ships, On) | 1 | 0-1 | **3-4** |
| Qwen3-4B-Thinking (ships, Max) | 4 | 0 | **1** |
| Qwen3.5-4B (candidate) | 4 | 0 | **1** |
| Granite-4.0-1B (candidate) | 0 | 5 | 0 |

Scale fixes most of it. The 1.7B pathology of asserting evidence that is not
there is gone at 4B, and three of its four wrong cases go right.

**But both 4B models fail the same single case, `continues+`, in all four
presentations, at the same 0.9 confidence, with the same sentence**: "the line is
a direct reply to Bern Halloway's statement". That is the reply-direction
inversion, applying dialogue alternation to a speaker continuing through his own
beat. The gold is not in doubt. ¶7 is Bern's own action beat and the line opens
with "And", continuing his own sentence.

It survives 1.7B to 4B, Qwen3 to Qwen3.5, four presentations and two prompt
versions. **It is model-invariant within this family, so no purchase clears the
bar.** The feature stays unwired.

### 3c. Presence review

Seven cases the engine defers. Ship condition is again wrong-applied 0.

| model | right | wrong-applied | declined | "unsure" |
|---|---|---|---|---|
| Qwen3-1.7B | 4 | 0 | 3 | **0** |
| Qwen3-4B-Thinking | 3 | 0 | 4 | **0** |
| Qwen3.5-4B | **5** | 0 | 2 | **0** |
| Granite-4.0-1B | 0 | 0 | 7 | **0** |

Qwen3.5-4B is the best here. Every model clears the ship condition already, so
this task is not a reason to change anything. Separately, the "`unsure` is
unreachable" claim in `presence-review.ts` was measured on qwen3-1.7b alone. It
now holds on four models across the whole size range and a model generation, so
it is a property of the **task**, not of one model.

### 3d. Granite-4.0-1B is disqualified, and not on quality

It does not produce usable output in this app at all:

```
Error: Failed to accept token in sampler:
Unexpected empty grammar stack after accepting piece: ! (0)
```

GBNF decoding fails on it under our pinned node-llama-cpp. The first
adjudication call threw and timed out, which wedged the single-slot host, so
every later call returned `busy`. On attribution it declined 5 of 5 in all four
presentations.

**Its 0 in the WRONG-APPLIED column is not a pass.** A model that emits nothing
scores zero confident-wrong answers. Read that column only together with
`right`.

Whether the fault is Granite, the quant, or the binding was not chased, because
the app's requirement is grammar-constrained JSON and it fails that requirement
today. Worth a retest on a newer node-llama-cpp before dismissing permanently.

### 3e. Qwen3.5-4B also breaks the memory budget

3.01 GB of weights against the current 2.50 GB, on a tier explicitly designed to
fit an 8 GB machine at about 3.7 GB total. That is roughly 0.5 GB straight off
the headroom before any KV. `IQ4_XS` at 2.67 GB is the fallback but was not
measured. Qwen3.5's hybrid attention may need less KV per token, which could
offset it, but nothing here measured that, so it stays an open question rather
than a claim.

## 4. Verdict on swapping

**Change nothing.**

- **On tier**: keep Qwen3-1.7B. The only candidate in budget cannot do
  grammar-constrained JSON in our stack, and the incumbent is the only model
  tested that passes all 30 gates, at 2.5x the speed of anything else.
- **Max tier**: keep Qwen3-4B-Thinking-2507. Qwen3.5-4B ties it on attribution,
  beats it by two cases on presence, loses a chip behaviour, and costs 0.5 GB
  against an 8 GB target. That is a lateral move with a memory bill.

Qwen3.5-4B is the one worth revisiting, on `IQ4_XS`, if the 8 GB floor is ever
raised or if the chip prompt is retuned.

## 5. Fine-tuning and distillation

### Is it legally possible?

Yes. Qwen3 is Apache-2.0, so fine-tuning and redistributing a derivative is
permitted with the NOTICE preserved. For distillation the teacher must be
permissively licensed too, which Qwen3-32B and Qwen3-235B-A22B are, and outputs
of an Apache-2.0 model carry no licence restriction of their own. Closed APIs are
out, because their terms forbid training a competing model on their output.

### Is it technically possible on this hardware?

A LoRA on the 1.7B is comfortable on a 16 GB M1 Pro through mlx-lm, then fused
and converted back to GGUF. None of that tooling is installed today. A 4B LoRA
is tighter but feasible. Training a teacher locally is not: Qwen3-32B at Q4 is
about 20 GB and does not fit, so distillation from a genuinely larger model needs
either rented GPU time or the 4B already on disk acting as teacher for the 1.7B.

### Is there data?

Not labelled data, no. What exists is 463 labelled events and 14 golden ask
cases, which is two orders of magnitude short of an SFT set. What does exist is
**13 public-domain novels**, which is unlimited raw material, plus one property
that matters more than any of it: **the deterministic engine is already confident
on most spans**. Above the 0.78 attested floor its attributions are effectively
gold, so training pairs can be mined from the engine's own confident calls at
zero labelling cost, and the model is only ever asked about the uncertain band.

The risk in that is distribution shift. Training on easy spans and deploying on
hard ones is exactly how a model learns to imitate the engine rather than read
the line, which is the failure already documented at 1.7B. Hard-band labels would
still need a teacher or a human.

**Do not train on the corrections store.** It samples the engine's errors, not
the world, and that was already measured on this codebase at 2.9% blast radius
for 0.0pp benefit.

### Is it worth the effort?

**Not yet, and the measurement above is why.** The honest ranking of effort
against payoff:

1. The one thing a fine-tune would fix is now precisely known: a single,
   reproducible, model-invariant failure, with unlimited training data for it,
   sitting between us and restoring a whole withdrawn feature. That is an
   unusually clean target, and the literature supports it. Narrow structured
   extraction and classification is the regime where a small fine-tune matches a
   much larger model, and rank-8 LoRA is enough.
2. But the same model runs six-plus task types on one set of weights. Tuning for
   attribution risks the other five, and catastrophic forgetting on
   grammar-constrained JSON would be worse than the feature is valuable.
   Per-task adapters mean hot-swapping LoRAs in llama.cpp, which is real
   complexity in a single-slot host.
3. Shipping it means hosting a 1 GB GGUF, losing the "load any GGUF" escape
   hatch for that tier, and re-doing the work at every base-model upgrade.
4. **Cheaper things have not been tried.** The failure is one rule, stated once,
   about a speaker continuing through his own beat. `PROMPT_VERSION 2` restated
   the reply direction but never addressed continuation. A prompt or a
   deterministic pre-filter that recognises "the previous paragraph is the same
   speaker's action beat" costs hours, not days, and would be tested by the
   probe that already exists.

**Recommendation.** Try the cheap fix for `continues+` first and re-run
`probe-attribution-anchor.cjs`. Only if the bar still fails, and only if
restoring attribution is worth several days plus ongoing maintenance, is a LoRA
justified. If it comes to that, the shape is a rank-8 LoRA on Qwen3-1.7B, trained
on engine-confident attributions mined from the corpus, with the 4B labelling the
hard band, gated on the existing 30-gate suite showing no regression on the other
tasks.

## 6. Reproducing this

```bash
# baselines
./node_modules/.bin/electron scripts/verify-assistant-tasks.cjs
./node_modules/.bin/electron scripts/probe-attribution-anchor.cjs
./node_modules/.bin/electron scripts/probe-presence-review.cjs

# a max-tier model, with the max tier's own config
PROBE_TIER=max ./node_modules/.bin/electron scripts/probe-attribution-anchor.cjs

# a candidate, non-Qwen so no /no_think
ASSISTANT_MODEL_PATH=/path/to/candidate.gguf PROBE_NOTHINK=0 \
  ./node_modules/.bin/electron scripts/verify-assistant-tasks.cjs
```

The two candidate GGUFs were downloaded to the session scratchpad, not into the
app's model directory, so nothing the app manages was touched.

## Full disqualification list

| family | status as of Aug 2026 | why out |
|---|---|---|
| LFM2 / LFM2.5 | fits size, llama.cpp-native | custom `lfm1.0` licence |
| Falcon-H1 | fits size | custom `falcon-llm-license` |
| InternLM2.5-1.8B | fits size | custom licence; the Apache one is 8B, too big |
| Nemotron 3 Nano 4B | fits size, GGUF shipped | NVIDIA Open Model Licence, not Apache/MIT |
| Phi-4-mini-reasoning | MIT, 2.49 GB | GPQA-D 52.0 vs our 65.8, clearly weaker |
| SmolLM3-3B | Apache-2.0, 1.92 GB | GPQA-D 41.7 vs 65.8, clearly weaker |
| Ministral-3-3B-Reasoning | Apache-2.0, 2.15 GB | weaker, plus open llama.cpp arch-recognition bugs |
| Granite 4.0 Micro / H variants | Apache-2.0 | not reasoning models; hybrid variants are WIP in llama.cpp |
| OLMo 3, MiniCPM4, InternLM3, GLM-4, ERNIE | various | no model at a usable size in budget |
| Qwen3.6, Qwen3.5-9B and up | Apache-2.0 | no sub-9B size, out of budget |
| any MoE (Qwen3-30B-A3B etc.) | n/a | all experts stay resident; ~18.6 GB at Q4 |

## Sources

- [Qwen/Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B), [bartowski GGUF](https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF)
- [ibm-granite/granite-4.0-1b](https://huggingface.co/ibm-granite/granite-4.0-1b), [GGUF](https://huggingface.co/ibm-granite/granite-4.0-1b-GGUF), [Granite 4.0 Nano announcement](https://huggingface.co/blog/ibm-granite/granite-4-nano)
- [llama.cpp#20345, grammar inactive with response_format + thinking](https://github.com/ggml-org/llama.cpp/issues/20345)
- [How Small Can You Go? LoRA fine-tuning 270M-8B for structured extraction](https://arxiv.org/html/2606.08051v1)
- [UNH at CheckThat! 2025, fine-tuning vs prompting for claim extraction](https://arxiv.org/pdf/2509.06883)
- [microsoft/Phi-4-mini-reasoning](https://huggingface.co/microsoft/Phi-4-mini-reasoning), [HuggingFaceTB/SmolLM3-3B](https://huggingface.co/HuggingFaceTB/SmolLM3-3B), [mistralai/Ministral-3-3B-Reasoning-2512](https://huggingface.co/mistralai/Ministral-3-3B-Reasoning-2512)
