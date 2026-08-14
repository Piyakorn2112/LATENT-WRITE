# The timeline lane, made cheap without touching what it says

**Scope, and only this scope.** Two LLM paths: the timeline CHIP picker
(`chip-picker.ts`) and the chapter SUMMARY shown in the widget panel and the
timeline inspector (`chapter-summary.ts`). Both are background convergence work
driven by the self-arming loop in App.tsx, and both run on the small tier
in-process. No other assistant path was touched — not the ask surfaces, not the
writing tool, not the dossier, not the adjudicator, not the review sweep.

**Goals set by the owner.** Preserve quality exactly. −30% average inference
time for this lane, −20% GPU and memory.

**Result.** −51% wall, −52% GPU-busy, −47% calls, with the answers unchanged
BY CONSTRUCTION rather than by judgement. Memory residency −19 to −20% at
realistic writing cadences; peak RSS unchanged, and the reason is a wall
documented below rather than an omission.

---

## 1. Ground truth first (what the lane actually costs)

`scripts/probe-timeline-lane.ts` drives the four frozen fixture chapters
through the real 1.7B in the real drain order, on ONE context sequence with a
fresh `LlamaChatSession` per run — the host's exact pattern, so the prefix
cache behaves as it does in the app. It records prefill/generation/tokens per
call, integrates the Metal accelerator's own utilisation counter (`ioreg`, no
sudo) into GPU-busy milliseconds, and captures every normalised answer.

Warm lane, 4 chapters, 8 calls:

```
lane 8.7s   prefill 3181ms (37%)   gen 5073ms (58%)   445 generated tokens
gpu busy 8098ms — 93% of the lane. GPU time and wall time are the same number here.
```

Per call, the shape that matters:

```
chips   first call  prefill 1348ms  (the 911-token system prompt, cold)
chips   later calls prefill  ~275ms  (only the chapter's own ~250 tokens)
summary first call  prefill  438ms  (a different system prompt — full re-prefill)
summary later calls prefill  ~170ms
```

Generation runs at 88 tok/s, which is at this hardware's floor for a 1.7B
Q4_K_M on an M1 Pro. Decode is not where the fat is.

## 2. Three researched levers, measured and REFUTED

Recorded so nobody re-runs them.

| lever | expectation | measured | verdict |
|---|---|---|---|
| grammar decode tax | llama.cpp checks the grammar against all 151,936 vocab tokens at every sampling step, and bounded repetitions (`{0,420}`) are the documented pathological shape | unconstrained 88.8 tok/s vs constrained 87.7 tok/s | REFUTED — the grammar is free on this stack |
| compact grammar (`allowNewLines:false`) | ~14–17% of a chip answer is pretty-printing, measured on the 4B | 445 generated tokens with it, 445 without — byte-identical output | REFUTED **on the small tier**; the 4B measurement stands, the 1.7B simply does not pretty-print |
| tuple wire for small-tier chips | the same trick that took the 4B's rich answer from 120 to 72 tokens | 486 tokens (worse), and it fired the repair pass twice — labels failed validation and fell back | REFUTED — costs 9%, and the repair call's foreign system prompt evicts the chip prefix on top |

The refutations are the finding: this lane's DECODE side is already tight. The
fat is all in prefill, and prefill is decided by the cache key.

## 3. What was actually wrong: the key was not the question

Both tasks cached their answer under
`${content.length}|${first 60 chars}` plus a fingerprint of the events' ranks
and sentences. That is not what either model is shown, and it was wrong in
both directions.

**Too eager.** `contentHash` moves on every keystroke that changes the
chapter's length, while the prompt frequently does not move at all.
`scripts/probe-lane-staleness.ts` drives four books through the real analysis
pipeline under two edit populations — a chapter written forward in small
chunks, and local revisions to a finished chapter:

```
                       rebuilds   old key    new key
TYPING   chips             192       192       168   -13%
         summary           192       192       115   -40%
REVISING chips              54        39        12   -69%
         summary            54        39         1   -97%
COMBINED lane              462       462       296   -36% of all inferences
```

A word added, a sentence appended, a trailing space: each ordered two full
inferences whose prompts were byte-identical to the pair before them. At
temperature 0 an identical request cannot produce a different answer.

**Too blind.** The old key could see nothing outside the chapter body, and the
prompt is full of exactly that. Renaming a chapter, a re-resolved `agent`, a
re-derived heuristic `label`, a shifted `tensionPosition`, a changed narrative
type, a cast correction — every one changes what is sent (or what the
validators judge the answer with) and none of them moved the key. Those were
stale chips, shipped. `scripts/verify-lane-keys.ts` found this while being
written against the OLD key: 21 of its 36 gates failed, and several were
correctness failures rather than cost ones.

**The fix.** Hash the request:

- the system prompt and the user turn, exactly as sent
- the material the validators use that the prompt does not always carry — a
  candidate's heuristic draft (the fallback label, and the polarity check) and
  its resolved agent, plus the FULL cast (`labelIsGrounded` reads all of it
  while the header prints three)
- the model id, and the prompt version

Fields are LENGTH-PREFIXED, not delimited: prompts, chip labels and character
names are prose and can forge any separator. Memoised on graph-entry identity
in a `WeakMap`, because the background loop asks for this key for every chapter
on every 350ms tick — 1000 key computations over 200 chapters cost 17ms.

The summary key deliberately folds in LESS: `normalizeSummary` is mechanical
text repair that reads nothing outside the response, so the prompt alone
decides. One consequence worth stating, because it looks like an oversight and
is not: a re-rank that does not reorder the moments moves the CHIP key (the
chip prompt prints ranks and the model answers with them) and correctly does
NOT move the summary key (the summary prompt lists moments in rank order and
never prints a rank). One engine change, two correct verdicts.

## 4. The second half of the win, which counting calls would have missed

A request whose system prompt differs from the one before it diverges at token
zero and pays a FULL re-prefill. The chip system prompt is 911 tokens — about
1.3s of it. Under the old key both tasks went stale together on every
keystroke, so the lane ran `chips, summary, chips, summary, …` and paid that
re-prefill on **every single call**. Under the new key the two tasks go stale
at very different rates, so consecutive calls are usually the same task and the
prefix cache actually holds.

`scripts/probe-lane-session.ts` builds the exact ordered call list each key
orders across a real drafting-then-revising session and replays both through
the real model, bracketed (old, new, old) so thermal and page-cache drift
cannot be mistaken for the change:

```
             calls   full re-prefills   wall     prefill   gen     gpu busy
old key        30           30          46.4s     24.4s   20.6s     43.9s
new key        16            9          22.5s     10.7s   11.1s     21.2s
                                       -51%                         -52%

call sequence  old   c s c s c s c s c s c s c s c s …   (perfectly alternating)
               new   c s c s c c c s c c c c c c s c     (runs of chips share a prefix)
per-call chip cost   1900ms → 1445ms   -24%
```

So the −52% is two effects multiplying: 47% fewer calls, and each surviving
chip call 24% cheaper because the prefix it needs is still resident.

## 5. Memory, stated honestly

**Peak inference RSS is unchanged, and no lever inside this lane can move it.**
The small tier's memory is weights (1.06 GB, mmapped and evictable) plus a KV
cache llama.cpp ALLOCATES IN FULL at context creation — 4096 tokens at ~103 KB
each. How many cells a prompt occupies changes nothing about the allocation, so
no shortening of these prompts touches peak. The two things that would are the
model (a requant changes logits — a quality change, refused) and the context
size, which is shared with every other small-tier task and therefore outside
this round's scope. This is the same wall `plans/inference-memory-2026-08.md`
reached, re-confirmed here rather than re-litigated.

What IS this lane's memory cost is how long that allocation stays RESIDENT. The
utility process exits on the small tier's 120s idle TTL and returns in ~1.3s
from page cache, so a lane ordering fewer calls holds 1.7 GB for less of the
session. Every input to this is measured (the real call sequences, each call's
real wall time); only the writer's cadence is a parameter, so it is swept:

```
a rebuild every     old key    new key
   20s              100%       100%      no change (the TTL covers the gaps either way)
   45s              100%        96%      -4%
   90s               98%        79%      -19%
  180s               63%        51%      -20%
  300s               38%        30%      -20%
```

So: −20% at the cadences where memory is contended at all, and no change during
continuous fast drafting, where the TTL keeps the model warm regardless of what
this lane does.

## 6. Quality

Unchanged BY CONSTRUCTION, which is a stronger claim than a passing bench: the
prompts, schemas, grammars, sampling and validators are byte-identical, and the
only change is which requests are sent twice. `verify-lane-keys.ts` (38 gates)
holds the two-sided property that makes that claim true — the key survives every
edit that leaves the prompt byte-identical, and moves for every change the model
or the validators can see, including the agent/draft/title/cast cases the old key
was blind to.

Gates green: `verify:lane-keys` 38/38, `test:chip-picker`, `test:chapter-summary`,
`test:evidence-pack`, `test:narrative-lm` 14/14, `verify:assistant-tasks` 30/30
(71.4 tok/s aggregate, unregressed), `verify-timeline-panel` 6/6,
`verify-cross-widgets`, `tsc -b` and `vite build` clean.

One-time cost: the stored keys change recipe, so every chapter recomputes its
chips and summary once after the update. That is the last time most of them will
recompute for a spelling fix.

## 7. Identified, measured, NOT shipped

**Merging the two system prompts.** The 9 remaining full re-prefills are all
chip↔summary alternation, worth about 5s of the 22.5s (−22% more). Removing them
means one shared system prompt for both tasks, either as a single fused answer or
as a two-turn conversation in one request. Both are prompt changes on a 1.7B
whose chip prompt was tuned across seven measured wording variants, and the
owner's constraint for this round was to preserve quality exactly. The size of
the prize is recorded here so the trade can be made deliberately later, with its
own quality bench, rather than folded silently into a performance round.

**Shortening the 911-token chip system prompt.** Same reasoning: it would cut
cold prefill proportionally, and it is a prompt change. Note that the existing
record says wording variants which ADDED text made compliance worse; removal is
untested in either direction.
