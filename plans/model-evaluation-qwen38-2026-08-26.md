# Qwen3.8 distills — 2B and 4B — researched, downloaded, measured

**Date** 2026-08-26 · **Hardware** Apple M1 Pro, 16 GB · **Outcome** keep both
shipping models, and keep the memory finding.

The **2B** loses to both incumbents on every quality instrument here (§4). The
**4B** ties the current Max on two of three and fails the third (§4c) — the
closest any candidate has come in two rounds. What survives both rejections is
§4b: this architecture costs **12x less memory per token of context**, which is
the first measured route to lifting the Max tier's 8k cap.

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

## 3. Speed — and a measurement that was wrong twice

> ★★ **CORRECTED 2026-08-26, same day.** This section first reported a "2.1x
> prompt-cache ceiling" for qwen35 in-process against the incumbent's 64x, and
> concluded the pinned binding could not reuse a cached prefix for this
> architecture. **That was an artifact of the probe, not a property of
> anything.** The correction is below; the original claim should not be cited.

**The bug in the instrument.** `probe-model-candidate.ts` discarded exactly ONE
cold run before timing. On qwen3 that is enough. **On qwen35 the prefix cache
needs two or three evaluations to engage** — observed directly at
`2618ms, 2524ms, 24ms, 32ms` — so discarding one and taking a median over the
next two averaged a still-cold run against a warm one and produced a number
that meant nothing.

The same model, same binding, warmed properly:

| model | arch | cold prefill | warm prefill |
|---|---|---|---|
| Qwen3-1.7B | qwen3 | 1801 ms | **36.5 ms** |
| Qwen3.5-0.8B | qwen35 | 941 ms | **46.5 ms** |

**There is no architecture penalty on the in-process path.** Warm prefill is
comparable, and the "54x interactive regression" this document previously
attributed to the 4B distill (§4c) is withdrawn — see the correction there.

★ **THE FIX IS IN THE PROBE, NOT IN A NOTE.** It now warms until two
consecutive runs agree within 35% rather than discarding a fixed count, because
a fixed warm-up count encodes an assumption about the model under test, which
is the one thing a candidate probe must not do.

★★ **AND THE FALSIFICATIONS THAT LOOKED LIKE CONFIRMATIONS.** Two checks were
run against the false finding and both "passed":
`FLASH=off` reproduced it (742 ms vs 737 ms), and the sidecar showed a
contrasting 100x. Neither was wrong, and neither could catch this, because both
compared the broken measurement against *something else* rather than asking
whether the measurement itself was sound. A control that varies the treatment
cannot detect a broken thermometer.

The sidecar figures stand on their own and remain useful — llama-server reuses
a repeated 2908-token prompt down to 4 reprocessed tokens (**100x**, 28 ms) for
the 2B and **107x** (66 ms) for the 4B, against **210x** (13 ms) for the
incumbent.

**Generation speed was measured independently and is unaffected by any of this:**

| model | tok/s |
|---|---|
| Qwen3-1.7B | 83–88 |
| **Qwen3.8-2B** | **58–68** |
| Qwen3-4B-Thinking | 38–41 |

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

## 4c. Qwen3.8-**4B**-Distill — the right weight class, tested

The 2B was aimed at a tier it was never sized for. The card points at the 4B,
[it exists in GGUF](https://huggingface.co/empero-ai/Qwen3.8-4B-Distill-GGUF),
and it is the same distillation of the same teacher into Qwen3.5-4B.
Downloaded at Q4_K_M — 2,783,446,304 B, sha256 `dec96e8c…c6790`, verified
byte-exact — and put through the identical suite.

| model | 30 gates | attribution right / **WRONG** | presence right / **WRONG** | gen tok/s | KV/tok | total @8k |
|---|---|---|---|---|---|---|
| Qwen3-1.7B (On) | **30/30** | 1 / 3–4 | 4 / **0** | 83 | 112 KB | 1.99 GB |
| Qwen3-4B-Thinking (Max) | 28/30 | **4 / 1** | 3 / **0** | 33–40 | 144 KB | 3.05 GB (Q8_0 KV) |
| Qwen3.5-4B (rejected 08-08) | 27/30 | **4 / 1** | 5 / **0** | 25 | — | — |
| Qwen3.8-2B-Distill | 26/30 | 2 / 3 | 1 / **0** | 58 | 12 KB | 1.39 GB |
| **Qwen3.8-4B-Distill** | **28/30** | **4 / 1** | 4 / **1** | 29–31 | **32 KB** | **3.03 GB (f16 KV)** |

It **ties the current Max** on the gate suite and on attribution, and the
grammar-cap warnings that sank the 2B fall from 11 to 3. This is a real model,
not a curiosity. It still does not ship — originally for three reasons, of
which **the largest was withdrawn the same day when the probe behind it turned
out to be broken.** What remains is reason 1 and reason 3.

**1. It fails the one stated ship condition.** `probe-presence-review.cjs`
prints it in the output: *wrong-and-applied = 0. A better "right" does not pay
for a confident wrong mark, because the engine already had an answer.* Every
model ever tested here scored 0 in that column — 1.7B, 4B-Thinking, Qwen3.5-4B,
and the 2B. This one produced **one confident wrong presence mark**, and a
wrong mark is what the writer sees.

  The probe notes that a threshold would separate them (wrong at 0.9, all six
  right answers at 1.0). **That is not a fix, it is a fit** — seven cases, one
  error, and a floor moved to clear it is tuned against the sample it was
  measured on. If this candidate is ever revisited, the presence probe needs
  more cases before that threshold means anything.

**2. ~~Interactive latency regresses 54x~~ — WITHDRAWN, the measurement was
broken.** This originally read: warm prefill 1864 ms against the incumbent's
34 ms, a 2.1x cache ceiling blamed on b10068. **It was the probe discarding too
few cold runs on an architecture that needs three (§3).** Warmed properly,
qwen35 prefill is comparable to qwen3 on the same binding. The 4B's own
corrected number was never re-measured before its weights were deleted, so it
is recorded here as **unknown, and no longer an objection.**

  This was the largest of the three reasons for rejecting the 4B. It is gone.

**3. Generation is 25% slower** — 30.5 tok/s against 40.3. Measured
independently of the prefill bug and unaffected by it.

Against all that it wins one column decisively: **32 KB/token against 144**.
At 8k its plain f16 KV costs what the incumbent reaches only by spending an
experimental Q8_0 KV option, losslessly. At 16k it would cost 3.28 GB total —
less than the incumbent costs at 8k. **It could double the Max tier's context
inside the same budget**, which is the standing constraint no other candidate
has offered to lift.

**What would change the verdict**, concretely: a `node-llama-cpp` release built
on a newer llama.cpp, which turns reason 2 from a 54x regression into nothing,
and a presence probe with more than seven cases to say whether reason 1 is a
real behaviour or one unlucky draw. Reason 3 would remain, and would be worth
paying for double the context.

### An incidental fifth confirmation

The candidate fails `continues+` in all four presentations, with the same
reading — "a reply to Bern Halloway's statement" — that Qwen3-1.7B,
Qwen3-4B-Thinking and Qwen3.5-4B all gave. That failure now survives **two
architectures, three model generations and five models**. The previous round
called it model-invariant within the family on three; it is safe to drop the
qualifier. No purchase clears that bar, and the cheap prompt fix it recommended
is still the only thing that might.

## 5. Verdict

**Change nothing. Again.** Put to the owner with the numbers above on
2026-08-26 and confirmed: leave the lineup alone. The variant that prompted
this round ("smaller but smarter and much faster") does not exist among the
candidates measured — the 2B is genuinely smaller and is neither of the other
two.

- **On tier** — keep Qwen3-1.7B. Not on size: the candidate's total footprint
  is genuinely 600 MB smaller (§4b), which is the one thing it wins. It loses
  on the two that decide the tier — 4 gates the incumbent passes, and 58 tok/s
  against 83. On is the tier where speed *is* the product.
- **Max tier** — keep Qwen3-4B-Thinking-2507. The candidate halves the download
  and runs 1.7x faster, and gives up half the attribution accuracy to do it
  (WRONG-APPLIED 3 against 1). That column is the one the writer sees.

- **Max tier** — keep Qwen3-4B-Thinking-2507 **for now**. Qwen3.8-4B-Distill
  ties on gates and attribution and costs 4.5x less per token of context, then
  fails the stated presence ship condition with a confident wrong mark and
  generates 25% slower. Its third objection was withdrawn (§4c).

**This verdict is weaker than it was when first written**, and honestly so. The
largest objection against the 4B evaporated when its own measurement was found
broken, and the remaining one rests on a single wrong answer in a seven-case
probe. **The next round should widen the presence probe before anything else**
— it is now the only thing standing between the Max tier and a model that costs
4.5x less per token of context.

Qwen3.8-9B is out of budget and will stay there. **Qwen3.5-4B at IQ4_XS is now
the strongest open candidate**: the previous round rejected it on memory
(3.01 GB against a 2.50 GB budget) and §4b shows memory was the wrong column to
judge it in — the real IQ4_XS file is **2.48 GB**, under the incumbent, and at
hybrid KV rates it totals ~2.73 GB at 8k against the incumbent's 3.05 GB.

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

# quality — the documented suite (swap the filename for Qwen3.8-4B-Q4_K_M.gguf)
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
