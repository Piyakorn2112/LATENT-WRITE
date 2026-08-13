# Ask + rewrite on a paragraph: faster, leaner, better, measured

**Question.** Can the two right-click surfaces — ask (check / explain /
suggest / free question) and rewrite (proofread / rewrite / custom) — get
noticeably faster AND cheaper AND better at once?

**Method.** A reference set first (fixtures/ask-rewrite-reference.ts): fixed
inputs over a planted world, and for every case a GOLDEN output written by a
high-capacity model against exactly the evidence the local model sees, plus
mechanical keys / mustKeep / antiKeys. The bench
(bench-ask-rewrite.cjs + bench-askrw-helper.ts) mirrors the shipped flows
call for call and records per-call latency, decode tokens and prompt size.
This set is FOR iteration; the frozen max-ask golden stays a one-shot.

## Baseline (the shipped flows, 2026-08-13)

```
ask      7 cases   19.0s mean   1809 decode tok   (+~1024 uncounted think tokens)
rewrite  6 cases    4.7s mean    245 decode tok
```

What the reading found, ranked:

1. **The check surface missed the planted contradiction** (called it fits,
   0.9) — and the menu kinds have NO reasoning stage at all; only free
   questions ever thought.
2. **The free-text think pass is the whale**: the causal question spent
   30.5s of its 44.3s inside it, and the pass's ~1024 tokens are invisible
   to the timings (freeText reports zero).
3. **A trivial lookup burned 23.9s**: a claim-check false flag ("Tam is
   Ede's apprentice" — true, but its quote paraphrased the pack) triggered
   refine + re-check for nothing.
4. **A prose abstention shipped as an answer** ("is not explicitly stated",
   basis passage): the coercion regex allowed no adverb between negation
   and verb.
5. **Rewrites are already in good shape**: 11/11 keys, zero anti, clean
   prose left untouched, tense shift 5/5. Their cost is the custom-op think
   (256-320 tokens ≈ 6s) and nothing else.

## The A/B rounds (ask)

**v1 — reason-first everywhere.** The dossier-measured pattern: a reason
field declared FIRST in the schema, think pass off. Found the contradiction
(5/6 keys) and cut the causal question 44.3s → 10.9s with a better answer —
and invented a conflict on the clean control, over-derived on the absent
fact, and wasted tokens on the lookup. One-sided weighing goes looking for
a verdict.

**v2 — quote-the-opposites + abstention rule.** Still found the planted
conflict; the control STILL invented (now expensively, 29s); and the
abstention-regex fix exposed a new path: step 1 honestly abstains, the loop
widens, and step 2 fabricates ("Ede's second husband died in the flood").

**v3 — two-sided reason for check, scoped elsewhere.** Argue FITS first,
then quote both sides of any conflict or fit stands; reason only on check
and difficulty-shaped questions (the same features the old think policy
used); explain/suggest/lookup keep the plain schema. Result: contradiction
found (5/6) AND control clean (fits, zero anti). This is the shipped
wording.

## The gates the rounds forced (all code, all tested)

- **The upgrade gate**: an answer that displaces a step-1 abstention must
  survive the claim check or the abstention ships. Fail-open on a null
  verdict (a review that could not run is infrastructure, not evidence).
- **Wholly-unlocated coercion**: a question answer whose EVERY fact claim
  failed to locate, after the refine had its chance, ships as the
  abstention — scoped so the lookup's one-of-three false flag keeps its
  answer and its caution.
- **The adverb gap** in the prose-abstention regex ("not explicitly
  stated" now coerces).
- `failedFacts` joined ReviewAnswer so "wholly invented" is computable.

Loop suite: 85/85 including new positive gates for both behaviors; the
think-pass test rewritten to assert the new contract (one constrained
call, reason declared first, no out-of-band pass).

## The frozen golden's one re-run, and what it refuted

The frozen max-ask golden (14 cases, hand-graded r2 on record) was run ONCE
against the reason-first candidate. The check cases held (control fits,
contradictions found). The QUESTION cases refuted the field: it accepted a
false premise ("Teo sold his share of the Petrel to Renner … because he
owed money" — the set's first-ever mustNotClaim violation) and derived an
answer on the unanswerable case ("he keeps it as a loan"). A reason field
weighs; weighing manufactures a rationale when the honest move is refusing
the question's terms. The frozen probe has always measured think-free, so
the diff isolated the schema change cleanly. Per the one-re-run discipline
the set was not run again; the r2 transcript stays the record, and the
shipped question configuration is bit-identical to what r2 graded PASS.

## Final configuration (shipped)

- **check**: reason-first in-schema, the two-sided wording. The one kind
  both benches agree on.
- **explain / suggest / question**: the plain schema, no reason, no think —
  the exact configuration the frozen set graded, now also the fastest.
- **All ask calls**: lane 'batch' + compact grammar (every call is
  constrained now), busy falling back to the host's single-flight lane.
- **Rewrite**: wholly unchanged in the product. The sidecar experiment for
  it measured engine ping-pong (custom ops think on the host; batching
  their main calls forced a reload per attempt, 9.3s → 11.6s) and the
  surface was already at 11/11 keys.
- **The gates** (upgrade gate, wholly-unlocated coercion, adverb-tolerant
  abstention regex) ship for every kind.

## Results (the shipped configuration, reference set)

```
              wall mean      decode tokens        keys vs golden   anti
ask   before    19.0s   1809 (+~1024 hidden)          8/30           1
ask   shipped    9.9s   1413 (nothing hidden)        14/30           0
rw    before     4.7s    245                         11/11           0
rw    shipped    4.7s    245  (unchanged)            11/11           0
```

Ask is 48% faster wall and half the real compute, with quality up on every
axis that moved: the planted contradiction 6/6 (quoting both sides of the
conflict), the clean control at fits, zero anti-hits. The trivial lookup
fell 23.9s → 14.5s from the engine lane alone. Per hard ask, ~1024 think
tokens and ~20-30s of GPU time are simply gone, and the flow being
sidecar-served ends the 1.7B↔4B host reload when background work
interleaves with asks.

**Residual, recorded not patched:** the starved absent-fact question can
still fabricate by smuggling a genuinely-located quote under an invented
claim ("died before she could learn anything … from the road he took").
This is the claim-check's documented compound-escape class; the
wholly-unlocated gate catches the fully-invented shape, not the
half-anchored one. Closing it likely needs per-claim subject checking —
the next measured experiment. The golden's two unnecessary-caution cases
(supported-but-paraphrased claims) also stand as recorded.

## The custom-instruction round (2026-08-13, continued)

The owner named long multi-part custom instructions as the frequent
real-world shape and asked for thinking ON with the speed to afford it.
Three hard cases joined the reference set (multi-part with protected
dialogue and a required closing image; a long ordered walk with a protected
last sentence; a compression with a five-item keep-list).

**Thinking earns its keep on hard customs, measured:** think-off failed two
of six outright (unrevisable at the gate) and went 1 → 7 anti-hits;
in-schema reason nearly as bad (6 anti, one lost protected word). The
shipped policy held best.

**Both researched think guides were REFUTED here:** guided-checklist and
free-with-guards each forced thinking onto simple customs (tripling their
latency for zero gain), each introduced a protected-word loss the policy
did not have, and neither fixed the multi-part miss. Guided at a 512
budget improved the multi-part substance but at 19s and still with the
residue. The guides stay in fixtures as bench history.

**What actually fixed the multi-part case: harness sight, not model
thought.** The instruction's checkable promises are now parsed as
INSTRUCTION CONTRACTS (writing-intent.readContracts): "keep/leave the
dialogue exactly" makes every quoted span of the original a verbatim
requirement; "end on <phrase>" makes the final sentence carry the phrase.
The gate enforces them (never relaxed — they are the writer's own words),
so the EXISTING think-retry finally receives a concrete diagnosis. Result:
the multi-part case's retry produced the best output of any arm — clipped
narration, dialogue byte-identical, the lamp last. One semantic residue
("comfortable and unbothered") remains gate-invisible by nature.

**Engine:** the open-think template joined the sidecar (freeText served
with the assistant turn's think block left open, stop at </think>), so
think passes ride the batch engine — whole-flow migration per the
ping-pong rule, at measured parity per call, with think tokens finally
REPORTED (the host never counted them). The writing runner ships
lane 'batch' with a busy fallback to the host.

**Timing anomaly, recorded:** the long-passage case reproduced 6-11x
decode slowdowns (127-245s at the same 656 tokens that earlier ran 22.3s)
late in a benching session with no orphaned processes — the sustained-load
degradation class again. Quality outputs identical; timing claims for long
decodes should be taken from fresh sessions only.
