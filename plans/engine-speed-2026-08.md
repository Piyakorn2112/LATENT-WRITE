# Base-engine speed, measured, and the version-pull convention

**Question.** Can inference get noticeably faster with zero quality change
and no reduction in thinking — engine-level only, nothing about what the
models are asked or allowed to reason?

**Ground truth first.** This engine's per-call floor was already measured
and most of the obvious levers are settled. Do not re-litigate these:

| lever | verdict | where measured |
|---|---|---|
| prompt-lookup drafting | REJECTED **on the binding only, see §Copy step** | probe-decode-speed |
| 1.7B drafting for the 4B | REJECTED **on the binding only, see §Copy step** | probe-draft-speculative |
| ngram-mod on llama-server | **ADOPTED, 2.4x decode, byte-identical** | probe-spec-decode |
| llama.cpp b10298 → b10472 | REFUTED, -3.0% against 8.4% bracket drift | probe-engine-build |
| parallel decode on node-llama-cpp | REFUTED, JS-side serialization, temp-0 determinism lost | probe-parallel-decode |
| flash attention | ON both tiers (byte-identical, lean) | probe-kv-cache |
| KV Q8_0 | 1.7B NO (answer changed), 4B YES | probe-kv-cache, registry |
| compact JSON grammar | ADOPTED for chips/summaries (~1/3 decode tokens are whitespace under the pretty grammar) | probe-decode-speed |
| llama-server sidecar | GO — faster per call than the binding, 1.75x at 4-way, schema held | probe-llama-server |
| sidecar micro-batch -ub 128 | UI-smoothness lever, costs 4% prefill | assistant-sidecar notes |
| --cache-ram 1024 | prompt-cache cap, prefix reuse across slots | assistant-sidecar notes |

**The gap those verdicts leave open.** The sidecar — the fastest engine the
app has — serves only background batch work (v1 scope). Interactive
constrained calls run on the in-process binding, single-flight, at the
binding's floor, and most of them never adopted the compact grammar. The
dossier redesign (plans/dossier-depth-naturalness-2026-08.md) removed the
last unconstrained call from the card flow, so the whole card is now
constrained JSON — exactly the shape the sidecar serves.

## The levers under test (probe-interactive-sidecar.cjs)

1. **host-compact** — jsonStyle:'compact' on the interactive constrained
   calls. Content unchanged by construction (the same tokens minus
   pretty-print whitespace); decode-token savings measured on chips.
2. **sidecar routing** — lane:'batch' with a precompiled compact grammar
   for the same calls; transparent in-process fallback wherever the binary
   is absent (existing contract, verified by probe-sidecar-e2e).
3. **sidecar concurrency** — one card's independent field calls fired
   together across slots (the 1.75x class win); requires busy-tolerant
   callers on the fallback path, so it lands second if it lands.

Quality gating for every lever: the shipped normalizeFieldAnswer grades
each answer on each path and the statuses/texts are compared; the dossier
quality bench re-runs on the winning configuration; golden sets stay
untouched; thinking budgets unchanged (the max tier's think-capable
surfaces keep their in-process freeText path).

## Results (measured 2026-08-13, real dossier bytes, real 4B)

**The bug the probe caught first.** The initial sidecar run burned every
call to its full n_predict cap: a 36-token answer became 512 tokens of
trailing newlines in 13.5s. The generated no-new-lines grammar permits
newlines AFTER the closing brace and the server samples them forever; the
in-process host has guarded exactly this with stopGenerationTriggers
['\n\n\n\n'] since the compact grammar shipped. The sidecar now mirrors
that stop. The verify:engine TERMINATION gate exists so this class can
never ship silently again.

**Per-call, single stream, means over 10 real requests:**

```
host, pretty grammar (the old interactive path)   4534ms
host, compact grammar                             4047ms   (−11%)
sidecar, compact grammar                          3852ms   (−15%)
```

**Concurrency, one card's independent field calls fired together:**

```
Marilla   2 fields   wall  8.8s  vs serial 14.4s   1.63x
Holmes    2 fields   wall  9.2s  vs serial 14.9s   1.62x
Mira      3 fields   wall  9.4s  vs serial 20.4s   2.18x
```

**End to end, the full 14-card max bench on the new wiring vs the shipped
sequential wiring, same code, same gold:**

```
                  core   ext  anti  invented  frag  s/card   field time/card
shipped (serial)   14%    5%    0      0        5%   21.4    ~15.5s sequential
sidecar (wave)     14%    5%    0      0        0%   19.6     9.6s concurrent
```

Quality parity is exact on every axis; fragments improved to zero. The
bench's own overhead (~5s of tsx grading boots per card, identical in both
columns) hides the real product delta: in-app the card's model time drops
from ~20s to ~14s. Against the session's starting point (38.5s think-pass
cards) the max card is now ~2.5x faster with more content and the same
zero-fabrication record.

Chips unregressed after the stop-trigger change: probe-sidecar-e2e reports
1.88x warm concurrency, contract shape held, decode+normalize chain green.

**What shipped:** the stop trigger beside every sidecar grammar; automatic
compact-grammar generation in trySidecarRun for any jsonStyle:'compact'
call without a hand-built gbnf (same builder, same options as the host, so
both engines constrain a call identically); the dossier card's field calls
and fusion on lane:'batch' + jsonStyle:'compact', fired as one concurrent
wave with sequential re-asks for 'busy' fallbacks — a machine without the
engine binary pays exactly the old sequential path. verify:engine 4/4,
suite 85/85, verify:dossier-ui 18/18, verify:assistant-tasks 30/30, tsc
and vite build clean.

**Not done, deliberately:** the max-ask and writing-tool surfaces still
run in-process (they carry freeText think passes the sidecar's closed-think
template cannot serve — an open-think template is the next engine
experiment); the small tier has no sidecar config yet (its calls are short
and the win is smaller); speculative decoding stays dead per the standing
verdicts.

## The version-pull convention

The user-facing requirement: future engine or model versions must be
pullable without breaking the tuned configuration. The convention already
half-exists; this section makes it whole.

**Engines.** `electron/assistant-sidecar.cjs` pins the llama.cpp release as
an ENGINE object (tag, tarball, sha256, dir) downloaded on demand and
verified before extraction — the same discipline as model downloads. The
in-process binding is pinned by package-lock (node-llama-cpp 3.19.1).

**Models.** `electron/assistant.cjs` MODEL_REGISTRY pins every model to a
Hugging Face repo at a REVISION with the LFS sha256, so a repo re-upload
can never change bytes. A future draft/special model import follows the
same entry shape.

**The rule that makes pulls safe: a version is data, the flags are ours,
and a gate script decides.** All tuned flags live in exactly two places
(the ENGINE args block in assistant-sidecar.cjs; the per-tier registry
entries in assistant.cjs) — never scattered at call sites. Bumping a
version means: change the pin (tag/sha256 or revision/sha256), run
`verify:engine`, and read the diff it prints. The gate:

- boots the pinned sidecar and the in-process host,
- runs the fixed interactive request set on both (real bytes, temp 0),
- asserts a SPEED FLOOR (no regression beyond noise vs the recorded
  numbers in this doc) and QUALITY EQUALITY (graded answers match statuses;
  schema held on every call),
- prints per-request deltas so a kernel-level change is visible before it
  ships.

A future llama.cpp release that changes flag semantics fails the gate
loudly instead of silently degrading; a future model revision that changes
bytes fails its sha256 before it is ever loaded. If a true custom fork is ever
needed, it enters as a NEW ENGINE object (own tag/sha256/url pointing at
our fork's release), and the same gate arbitrates — the convention does not
care whose release it is.

## Addendum: time-to-first-token (2026-08-13)

TTFT decomposed per engine (probe-ttft.cjs): boot+load 1.0-2.5s (page
cache warm), generation start fine — the whale is PREFIX PREFILL, ~3.3s
for a ~500-token system prompt (~145 tok/s) on both engines, identical
with and without a grammar (grammar exonerated by the no-grammar
discriminator). Two engine facts decide the design:

- llama-server reuses a cached PREFIX partially: a new user text on a
  cached system prompt prefills in ~160ms. The in-process host does not
  (full re-prefill per new user text, 3.7s) — one more reason the
  interactive surfaces live on the batch engine.
- warm-same TTFT is 40-104ms: the caches work; the cost is only ever the
  FIRST touch of a prefix.

**Shipped: prewarm on intent.** Opening the ask popover or the writing
popover fires one 1-token request carrying the surface's fixed system
prompt (the writing ops share their SHARED_RULES head, so one warms the
family). The engine boots and the prefix warms while the writer reads the
menu. Measured end to end with real ask bytes: prewarm 2.8s off the user
path, then the real ask at TTFT 329ms — against 5.8s cold. Health poll
250ms → 100ms shaves boot detection. Nothing loads before intent, so the
memory round's budget holds; a canceled popover cancels its prewarm with
everything else.

Batch-geometry prefill tuning (-ub above 128) was left alone: the 128
setting owns a measured UI-smoothness number, and the prewarm removes the
same seconds without touching that trade.


## The copy step (2026-08-18): 2.4x decode, and why the old verdict did not apply

**Both speculative verdicts in the table above were measured on
node-llama-cpp, and the sidecar inherited them untested.** That is the whole
finding. The 1.7B-drafting run did not just lose on speed, it printed
`"pushed tokens are incompatible with the grammar evaluation state. The
grammar will be ignored"` — which is a statement about THAT BINDING's draft
predictor, not about the technique and not about llama.cpp. llama-server
carries its own implementations behind `--spec-type`, the sidecar arrived
months after the verdict, and nobody re-ran it there. Neither did the memory
objection survive: the ngram family reads the context the engine already
holds, so there is no second model and no extra RAM.

**Why it works on THIS workload.** Measured on the real chip answer against
the candidate list it was shown, **206 of 258 characters, 80%, already
existed word for word in its own prompt**. The picker is handed candidate
sentences and told to choose and label them, so the labels and details come
back quoted, and the JSON scaffolding repeats once per pick. A copier that
matches the tail just written against the context and copies forward what
followed last time gets that 80% for free. The model then verifies the whole
span in ONE forward pass, keeps the run that agrees with what it would have
produced, and cuts at the first disagreement. At temperature 0 that makes the
output identical by construction.

**The arithmetic, from a real trace of one chip request:**

```
                    model runs   ms per run   total     tok/s
base                        72         29ms   2108ms     34.1
--spec-type ngram-mod       17         39ms    665ms    108.3
                                                   (draft_n 55, accepted 55)
```

Each run got MORE expensive, because it now covers several positions instead
of one. There are 4.2x fewer of them.

**Match-length sweep, paired against a fresh baseline each round:**

```
match 12   +24%      match 32   +112%      match 64   +141%
match 24   +48%      match 48   +141%   ← shipped, plateau
```

48 and 64 agreeing to 0.1% is a ceiling, not a lucky point. Shipped
`--spec-type ngram-mod --spec-ngram-mod-n-match 48`, env-overridable via
`ASSISTANT_SIDECAR_SPEC` (`none` disables) and `ASSISTANT_SIDECAR_SPEC_MATCH`.

**★★ THE FASTEST SETTING IS THE ONE THAT MUST NOT SHIP.**
`--spec-ngram-mod-n-min 24 --spec-ngram-mod-n-max 32` measured 70.7 tok/s
against match32's 70.0, a rounding error apart, and **rewrote a chapter
summary into different events** (base: "watched the seal run off the harbour
writ as he tried to reach the pier"; that config: "watched the harbour writ
burn as the seal ran off it"). By the greedy-verification argument this is
impossible, so the guarantee leaks somewhere in that path, most likely the
grammar state not being reapplied identically when drafted chunks are short
and frequent. The leak was not diagnosed and does not need to be. The lesson
is that the theory said all of these were safe and one measurably was not,
which is why byte comparison is a GATE and not a comment.

**Gates.** New `verify:spec-decode` asserts three things: every answer
byte-identical to a copy-step-off baseline, decode above a +25% floor so a
silently ignored flag after an engine bump fails loudly instead of leaving
every other gate green, and the shipped defaults read back out of
assistant-sidecar.cjs so the gate is measuring the config the sidecar
actually spawns rather than one the probe defines. 5/5. verify:engine 4/4,
verify:assistant-tasks 30/30 and its aggregate moved 71.4 → 83.6 tok/s
(+17% on the real mixed suite through the app bridge).

**Scope.** Max tier only. The small tier has no sidecar entry, so On mode
runs in-process on node-llama-cpp, which has no equivalent. Within max mode
every surface gains, because chips, summaries, the dossier, max-ask and the
writing tools all already carry `lane:'batch'`.

**Bracketing earned its keep twice.** The b10298 → b10472 bump looked like a
3% regression and was nothing at all: three passes of the SAME build decayed
8.4% across the run, so the gap was inside the drift. Every number above is
paired against a baseline measured in the same minute.

**Still open, in order of expected payoff:** the writing tools and the
dossier should gain MORE than chips, because a proofread returns your own
paragraph with a few fixes in it (unmeasured, predicted from the mechanism);
`-ub 128` deserves re-opening now that each pass covers ~4 positions instead
of 1, which is a different UI-smoothness trade from the one that set it;
EAGLE-3 (`--spec-type draft-eagle3`, already in the build's menu, third-party
Qwen3 checkpoints exist) stacks with ngram-mod and attacks the novel tokens
the copier structurally cannot help with; and On mode has no sidecar at all,
which is the largest total-time lever left.

**Not a lever, stated because it will be asked again.** Apple's "LLM in a
Flash" (arXiv 2312.11514) does not transfer. It solves "the model does not
fit in RAM", and our 4B is 2.5GB on a 16GB machine. Its core trick also needs
FFN activation sparsity from ReLU-family activations; Qwen3 uses SwiGLU and
is not sparse that way, and making it so would change the model's outputs.
The transferable half of Apple's stack is the draft model they pair with
their 3.18B base, which is the technique above in its learned form.
