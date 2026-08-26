# Qwen3.8-2B-Distill, researched, downloaded, measured

**Date** 2026-08-26 · **Hardware** Apple M1 Pro, 16 GB · **Outcome** keep both
shipping models. The candidate loads cleanly on the pinned engine and is the
fastest reasoning-tuned model tested, and it still loses to both incumbents on
every quality instrument this repo has.

Follow-up to [model-evaluation-2026-08.md](model-evaluation-2026-08.md), which
tested Qwen3.5-4B and Granite-4.0-1B on 2026-08-08 and kept both incumbents.
That round closed with a line this candidate reopens:

> Qwen3.6, Qwen3.5-9B and up — Apache-2.0 — **no sub-9B size, out of budget**

That is no longer true. Qwen3.5 now has a 2B, and Qwen3.8 shipped on 2026-08-12
with a distillation into it. Same method, same instruments, so the numbers drop
straight into the old table.

## 1. What the candidate is

[empero-ai/Qwen3.8-2B-Distill](https://huggingface.co/empero-ai/Qwen3.8-2B-Distill)
— a full-parameter distillation of **Qwen3.8-2.4T-A95B** into the **Qwen3.5-2B**
architecture, on roughly 30,000 curated teacher traces. Apache-2.0. 262,144
native context. 25 layers, 8 heads, hybrid Gated DeltaNet attention.

| | Q4_K_M | sha256 |
|---|---|---|
| [GGUF repo](https://huggingface.co/empero-ai/Qwen3.8-2B-Distill-GGUF) @ `f4f7358` | 1,312,164,224 B (1.31 GB) | `4aa0fb13c431514262f259d420ecc95a8714df58ac2a2384514e20b93983f0ff` |

Downloaded, size and sha256 verified byte-exact against the repo's own
`SHA256SUMS` before anything was claimed about it.

**The card's benchmarks compare it only to its own base, never to a 4B.**

| task | Qwen3.5-2B base | Qwen3.8-2B-Distill | Δ |
|---|---|---|---|
| gsm8k_cot (flexible) | 0.330 | 0.640 | +0.310 |
| mmlu CoT (flexible) | 0.283 | 0.548 | +0.265 |

A large gain over a small base is not evidence against a 4B, and the card says
so itself: for harder work, "step up to Qwen3.8-4B or Qwen3.8-9B."

## 2. Engine compatibility — the gate that could have ended it

The architecture is hybrid linear attention, and the model card warns that
"older builds will fail to load the architecture." That is a real risk here,
because the in-process host does not use the pinned sidecar engine — it uses
whatever llama.cpp `node-llama-cpp` was built against.

Both paths already have it, so **no engine bump is required**:

| path | engine | registers `qwen35` |
|---|---|---|
| in-process host | b10068 (node-llama-cpp 3.19.1) | yes — `qwen35`, `qwen35moe`, `qwen3next` |
| sidecar | b10298 (pinned in `assistant-sidecar.cjs`) | yes |

`libggml-base.dylib` carries `GATED_DELTA_NET`, `GATED_LINEAR_ATTN` and
`SSM_SCAN`. The model loads in 1.4s, reports `arch=qwen35`,
`trainCtx=262144`, and produces valid grammar-constrained JSON on the first
try — no `empty grammar stack` failure of the kind that disqualified Granite.

Its embedded chat template is ChatML and switches thinking with an
`enable_thinking` flag, emitting `<think>\n\n</think>\n\n` when false — **the
same closed-think prefill `TEMPLATES.qwen3` already hand-builds**. It does
*not* read `/no_think`; that is a Qwen3 control token this family dropped.
(That finding is why `setCustomModel` no longer defaults `noThink` to true —
see §6.)

## 3. Speed — and the trap in the first measurement

The first in-process numbers looked disqualifying, and were wrong about why.

**Warm prefill, in-process, on the app's real chip request (~1450 tokens):**

| model | cold prefill | warm prefill | cache gain |
|---|---|---|---|
| Qwen3-1.7B | 1538 ms | **24 ms** | 64x |
| Qwen3.8-2B | 1527 ms | **737 ms** | 2.1x |

★★ **Cold prefill is identical. The entire gap is prompt-cache reuse.** Raw
compute is the same; what differs is whether a repeated system prompt has to be
re-scanned. That matters more here than anywhere, because every batch task in
this app sends a byte-identical 400-1400 token preamble and asks for ~50 tokens
back — the shipped cost *is* the warm number.

Two things were then falsified rather than assumed:

- **Flash attention is not the cause.** `FLASH=off` gives 742 ms against
  737 ms. Unchanged.
- **The architecture is not the cause either.** On the *sidecar* (b10298) the
  same model caches fine:

| model | first request | repeat | reprocessed | gain |
|---|---|---|---|---|
| Qwen3-1.7B | 2732 ms | 13 ms | 1 of 2787 tok | 210x |
| Qwen3.8-2B | 2806 ms | 28 ms | 4 of 2908 tok | 100x |

So the 2x ceiling is **b10068 / the in-process binding**, not Gated DeltaNet.
On the path the app would actually route batch work through, the candidate's
warm prefill is 28 ms — 15 ms behind the incumbent and irrelevant in absolute
terms.

**Generation**, all three models, same requests, temperature 0:

| model | tok/s |
|---|---|
| Qwen3-1.7B | 83–88 |
| **Qwen3.8-2B** | **58–68** |
| Qwen3-4B-Thinking | 38–41 |

It is the fastest reasoning-tuned model tested — 1.7x the current Max — and
still slower than the 1.7B it would have to displace on the On tier.

## 4. Quality — the documented suite, unchanged

Run exactly as §6 of the previous evaluation prescribes: `PROBE_NOTHINK=0`
(the candidate does not read `/no_think`), `PROBE_TIER=max` for the two probes
that take it.

| model | 30 gates | attribution right / **WRONG-APPLIED** | presence right / wrong / declined | tok/s |
|---|---|---|---|---|
| Qwen3-1.7B (ships, On) | **30/30** | 1 / 3–4 | **4** / 0 / 3 | 83.1 |
| Qwen3-4B-Thinking (ships, Max) | 28/30 | **4 / 1** | 3 / 0 / 4 | 33.3 |
| Qwen3.5-4B (rejected 08-08) | 27/30 | **4 / 1** | **5** / 0 / 2 | 25.2 |
| **Qwen3.8-2B-Distill** | **26/30** | 2 / **3** | **1** / 0 / 6 | 58.4 |

Last on the gate suite, last on presence, and confidently wrong on 3 of 5
attribution cases in all four presentations.

★ **Its 0 in presence's wrong column is not a pass** — the same reading the
previous round had to apply to Granite. Six of its seven answers were dropped
by the validator. A model that mostly fails to answer scores no confident wrong
answers.

### 4a. The four gate failures are one defect

- `non-name → "common-word"` — returned `character`
- `summaries are one paragraph, within the cap` — exceeded the 320 cap
- `chekhov/promise` — `not-a-thing` at 0.9 confidence
- `chekhov: the model discriminates` — **every** phrase answered `not-a-thing`

And in a single 30-gate run, **11 separate warnings** of the form:

```
⚠ reason hit the 120-char grammar cap and was cut mid-word
```

★★ **The model writes long into fields sized for terse answers.** That is the
whole story, and it is worse than it looks because of a deliberate choice in
the schemas: `reason` is declared **before** `label`, so the model states its
evidence before it commits (grammar emits in declaration order). A reason that
spends its entire 120-char budget on restating the passage reaches the label
with nothing decided — which is exactly how chekhov collapsed to one verdict
for every phrase.

This is a distilled-reasoning model behaving as trained. Its teacher traces are
all chain-of-thought, and a grammar masks think tokens from token zero
(`src/lib/think.ts`), so it is asked to produce the conclusion of a reasoning
process it is never allowed to run, in 120 characters. It answers by starting
the reasoning inside the field.

The incumbents do not do this because **the prompts and caps were tuned against
them**. That cost is real and it is not the candidate's fault — it is the same
finding the previous round put in bold: *swapping the model invalidates the
tuning.* It is stated here as a caveat, not as an excuse, because a swap that
requires retuning six task prompts is a swap whose cost is measured in days.

## 4b. Memory — the one column the candidate wins outright

The previous evaluation left this open, in as many words:

> Qwen3.5's hybrid attention may need less KV per token, which could offset it,
> but nothing here measured that, so it stays an open question rather than a
> claim.

Measured now, by reading llama.cpp's own `llama_kv_cache: size = …` line at
four context sizes (`probe-model-kv-scaling.ts`). The 1.7B's slope comes out at
112 KB/token against a hand-computed 28 layers x 1024 KV dims x 2 x f16 =
112 KB, so the instrument is calibrated against geometry before it is trusted
on anything new.

| model | KV per token (f16) | KV at 8k | weights | **total at 8k** |
|---|---|---|---|---|
| Qwen3-1.7B (On) | 112 KB | 0.88 GB | 1.11 GB | **1.99 GB** |
| **Qwen3.8-2B** | **12 KB** | **0.09 GB** | 1.30 GB | **1.39 GB** |
| Qwen3-4B-Thinking (Max) | 144 KB | 1.13 GB | 2.50 GB | **3.63 GB** |

★★ **A twelvefold cut, and it is the architecture doing it.** Only a quarter of
the layers keep a conventional KV cache; the Gated DeltaNet layers hold a
fixed-size recurrent state that does not grow with context. So the candidate's
weights are 200 MB *larger* than the 1.7B's and its real footprint is 600 MB
*smaller* — and the gap widens with every extra token of window. At 16k the
current Max needs 2.3 GB of KV; this needs 0.19 GB.

★ **This is the finding worth keeping even though the model was rejected.** The
Max tier's context is capped at 8192 by memory, it spends an experimental Q8_0
KV option to afford that, and `kvBytesPerToken` is the single number the memory
guard reasons with. An architecture that makes context nearly free is the one
thing that would lift that cap — and it is the reason a Qwen3.8-**4B**-Distill
at 2.78 GB of weights may still cost *less* in total than the 2.50 GB model it
would replace.

## 5. Verdict

**Change nothing. Again.**

- **On tier** — keep Qwen3-1.7B. Not on size: the candidate's total footprint
  is genuinely 600 MB smaller (§4b), which is the one thing it wins. It loses
  on the two that decide the tier — 4 gates the incumbent passes, and 58 tok/s
  against 83. On is the tier where speed *is* the product.
- **Max tier** — keep Qwen3-4B-Thinking-2507. The candidate halves the download
  and runs 1.7x faster, and gives up half the attribution accuracy to do it
  (WRONG-APPLIED 3 against 1). That column is the one the writer sees.

What would change the answer: **[Qwen3.8-4B-Distill](https://huggingface.co/empero-ai/Qwen3.8-4B-Distill-GGUF)**,
which the card itself points at and which exists in GGUF. Q4_K_M is 2.78 GB
against Max's 2.50 GB — over budget on weights, and §4b says that is the wrong
place to look: at 8k the hybrid's KV is ~0.19 GB against the incumbent's
1.13 GB, so the candidate plausibly costs *less* in total. It is the right next
test and it is in progress; the 2B was the wrong weight class to aim at Max in
the first place.

Qwen3.8-9B is out of budget and will stay there. Qwen3.5-4B at IQ4_XS remains
open from the previous round.

### On tuning it

The previous evaluation's §5 covers licence, hardware and data, and none of
that changed. One thing did:

**The gap measured here is not a knowledge gap, so a LoRA is the wrong tool for
it.** The candidate is not wrong about the passages — it is verbose past a
grammar cap. That is a schema-and-prompt shape problem, fixable in hours by
raising `reason` caps or moving to a two-field `evidence`/`label` split, and it
would have to be redone at every model swap regardless. Fine-tuning to teach a
model to be brief, when the cap can simply be widened, is paying days for
something that costs an afternoon.

The narrow, clean fine-tune target identified last round — the model-invariant
`continues+` reply-direction inversion — is still the only one worth the money,
and it is still behind the cheap prompt fix that was recommended and has not
been tried.

## 6. What shipped out of this round

Not a model swap. Three things:

1. **The alternate-model picker in Settings is hidden.** It offered other models
   as three one-click buttons, which put the regression measured twice now
   (here and on 08-08) one press away with nothing on screen connecting the
   press to the worse answers. `MODEL_PRESETS` and `assistant:presets` are
   untouched in main, so restoring it is a render change.
2. **The direct-URL box stays, and is now the whole menu.** Its purpose was
   never model-shopping — it is the escape hatch for a dead source, and that is
   unchanged.
3. **`setCustomModel` no longer defaults `noThink` to true.** With the picker
   gone every custom model arrives as a bare URL, and a bare URL must not be
   assumed to be a Qwen3: `/no_think` is a Qwen3 control token, junk in a
   Granite or Gemma prompt and ignored by Qwen3.5/3.8. It was already cosmetic
   on constrained runs. Gated both ways in `verify-model-manage.cjs`.

## 7. Reproducing this

```bash
# does it load at all, and how does it cache — in-process
MODELS=Qwen3-1.7B-Q4_K_M.gguf,Qwen3.8-2B-Q4_K_M.gguf \
  ./node_modules/.bin/tsx scripts/probe-model-candidate.ts
FLASH=off MODELS=Qwen3.8-2B-Q4_K_M.gguf \
  ./node_modules/.bin/tsx scripts/probe-model-candidate.ts

# …and on the sidecar, which is a different engine with a different cache
MODEL=Qwen3.8-2B-Q4_K_M.gguf ./node_modules/.bin/tsx scripts/probe-model-server-cache.ts

# what a token of context actually costs — read off llama.cpp, not RSS
MODELS=Qwen3-1.7B-Q4_K_M.gguf,Qwen3.8-2B-Q4_K_M.gguf,Qwen3-4B-Thinking-2507-Q4_K_M.gguf \
  ./node_modules/.bin/tsx scripts/probe-model-kv-scaling.ts

# what the file says about itself
MODELS=Qwen3.8-2B-Q4_K_M.gguf ./node_modules/.bin/tsx scripts/print-gguf-template.ts

# quality — the documented suite
CAND="$HOME/Library/Application Support/Latent Write/models/Qwen3.8-2B-Q4_K_M.gguf"
ASSISTANT_MODEL_PATH="$CAND" PROBE_NOTHINK=0 \
  ./node_modules/.bin/electron scripts/verify-assistant-tasks.cjs
ASSISTANT_MODEL_PATH="$CAND" PROBE_TIER=max PROBE_NOTHINK=0 \
  ./node_modules/.bin/electron scripts/probe-attribution-anchor.cjs
ASSISTANT_MODEL_PATH="$CAND" PROBE_TIER=max PROBE_NOTHINK=0 \
  ./node_modules/.bin/electron scripts/probe-presence-review.cjs
```

Raw output: `bench-results/model-candidate-3way.json`,
`model-candidate-flash-on.json`, `model-candidate-flash-off.json`,
`tasks-qwen38-2b.txt`.

## Sources

- [empero-ai/Qwen3.8-2B-Distill](https://huggingface.co/empero-ai/Qwen3.8-2B-Distill) · [GGUF](https://huggingface.co/empero-ai/Qwen3.8-2B-Distill-GGUF)
- [QwenLM/Qwen3.8](https://github.com/QwenLM/Qwen3.8) — 2.4T-A95B released 2026-08-12, 27B on 08-14
- [llama.cpp b10068](https://github.com/ggml-org/llama.cpp/releases/tag/b10068) (in-process), [b10298](https://github.com/ggml-org/llama.cpp/releases/tag/b10298) (sidecar pin)
