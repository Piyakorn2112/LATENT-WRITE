# Base-engine speed, measured, and the version-pull convention

**Question.** Can inference get noticeably faster with zero quality change
and no reduction in thinking — engine-level only, nothing about what the
models are asked or allowed to reason?

**Ground truth first.** This engine's per-call floor was already measured
and most of the obvious levers are settled. Do not re-litigate these:

| lever | verdict | where measured |
|---|---|---|
| prompt-lookup drafting | REJECTED, +18% slower (output not in prompt) | probe-decode-speed |
| 1.7B drafting for the 4B | REJECTED, 4x slower AND grammar bypassed | probe-draft-speculative |
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
