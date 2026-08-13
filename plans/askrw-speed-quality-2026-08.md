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

## Final configuration

- **Ask**: reason-first in-schema per the v3 policy; the 256/1024-token
  free-text think pass is retired wholesale; the loop, review, refine and
  widen mechanics unchanged; the two new gates above.
- **Rewrite**: unchanged flow (it was already right); the sidecar lane on
  its constrained calls where the engine is present.
- **Both**: lane 'batch' + compact grammar (the engine work of
  plans/engine-speed-2026-08.md) with busy falling back to the host's
  single-flight lane.

## Results

(final table from the sidecar-variant run + the one-shot golden probe)
