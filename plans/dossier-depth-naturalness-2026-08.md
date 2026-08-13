# Dossier depth and naturalness, measured

**Question.** Can the auto-generated character description read like a person
wrote it on the ON tier, and go materially deeper on MAX — more personality
and action, more detail — at roughly the latency each tier already spends,
with fabrication still at zero?

**Method.** A quote-verified gold benchmark first, then variants measured
against it on the real shipping tiers. Nothing below is a guess; the numbers
are the bench's, the verdicts on prose are from reading every card.

Predecessor: `plans/character-dossier-research-2026-08.md` (the engine this
builds on). Bench: `scripts/bench-dossier-prep.ts` +
`scripts/bench-dossier-quality.cjs` + `scripts/bench-dossier-score.ts`.
Variants under test live in `scripts/lib-dossier-variants.ts` and graduate
into the engine only on a measured win.

---

## 1. The benchmark

22 characters across 7 DEV books (pride, anne, carol, dracula, sherlock, the
synthetic webnovel, and the owner-register draft root-crown), 317 facts, each
kind-tagged (appearance / personality / background / action / voice /
relationship), weight-tagged (core / extended), and backed by a VERBATIM
quote that must locate in the book after whitespace normalization — all 317
verified. 110 anti-facts (plausible genre-typical claims verified ABSENT from
the text: Elder Kang's beard, robe and staff; Anne's blue eyes) catch
fabrication.

Scoring per card: core-fact coverage (any key present, stem-loose), extended
coverage as depth, anti-fact hits and invented particulars as the fabrication
axes, fragment/telegraph ratios as naturalness proxies, wall clock. Anti-fact
keys that also appear in the character's true gold only fire when the WHOLE
claim co-occurs ("dowsa" in a legitimate company line is not "afraid of
Dowsa").

Held-out books were not touched and must not be until a design is frozen.

## 2. Baseline (the shipped card, measured 2026-08-13)

```
                       cards  core   ext  anti  invented  s/card
on   (extractive+1.7B)   12    7%    2%    0       0        ~2
max  (4B, 3 fields)      12   13%    2%    0       0       38.6
```

Zero fabrication held. Everything else had room:

- **The deterministic composer shipped junk on 5 of 12 cards.** "The victim
  of an overwhelming attack of stage fright" (Anne — a scene copular filed as
  identity), "Not a man to be frightened by echoes" (Scrooge), "The happy
  woman by whom he finally seated himself" (Elizabeth — the relative clause
  is Darcy's), "some face" (Scrooge — `some` passes the -some suffix test
  that exists for "handsome"), Jane's week in town stated twice (two channels
  harvested the same sentence).
- **The max BACKGROUND field was scene-junk on 7 of 11 answered cards**, every
  one grounded: "had been at Netherfield long enough", "returned from his
  excursion", "a telegram came from Van Helsing" (the telegram is the
  subject), "studied her lessons", Mira's card carrying her FATHER's habit.
  Grounding proves provenance, never durability.
- **The 1.7B appearance call contributed on 2 of 13 cards** and the rest fell
  back to extraction, so ON-mode quality ≈ extraction quality.
- Personality on max came back as bare trait lists ("Intelligent, romantic,
  emotionally deep") — the depth the owner wants is conduct, cited.

## 3. Floor fixes the bench forced (shipped, suite 85/85 green)

All in the deterministic layer, all closed-class or positional:

1. **A definition must be durable.** Identity rejects negations ("not a man
   to…"), event/temporal heads (victim / occasion / week / night), and
   definitions that only parse relative to someone else ("the least dear TO
   HER of all her children"). Any clause carrying the OPPOSITE-gender pronoun
   is about somebody else and is skipped in every channel.
2. **Weak lore predicates need their complements checked.** The predicate
   list split STRONG (born / inherited / married / was known as — always
   biography) from WEAK (came from / returned from / studied /
   had-been-locative). A weak-only sentence must survive vetoes: locatives
   need a duration ("for sixty-three years"), comings and goings must not own
   a possessive errand ("returned from *his excursion*"), object nouns cannot
   donate their senders (the telegram), homework is not formation ("studied
   her lessons"), and bare "had once" became "had once been".
3. **Junk modifiers stopped**: some, such, next, last, first, best, worst.
4. **Cross-channel duplicate sentences refused** (stem-overlap ≥ 0.6).
5. **The too-thin floor moved to the whole card**, so "Big eyes." survives
   beside a counted line instead of dying alone before composition.

## 4. What the research said (distilled to what applies here)

Web synthesis, two passes (small-model practice; character-profiling
literature). The full agent reports are in the session transcript; what
survives contact with this pipeline:

- **Schema order is an instruction channel.** Constrained JSON emits in
  declaration order; a free-prose reason field FIRST recovers much of the
  measured constrained-decoding quality loss at 1-4B ("Let Me Speak Freely",
  the constraint-tax replications). The repo already knew reason-before-label;
  the new move is replacing the 30s unconstrained think pass with an
  in-schema ~100-token reason on the personality call.
- **Select-then-generate is the published shape of this engine** (BookNLP →
  Attribute-First-then-Generate): deterministic extraction first, model
  fusion second, citations from selection for free. Multi-span fusion — cite
  2-3 agreeing passages, fuse into ONE statement — is the depth+naturalness
  lever inside the existing per-field call.
- **Show, don't tell** (LIIPA): lead the personality answer with cited
  conduct, let the trait follow. Zero-cost prompt change with direct
  literature support.
- **Self-critique loops hurt at this scale; externally-checked repair works**
  (token-matched studies, 18/18 negative for self-inspection). The only
  retry shapes here name a concrete failed check: the extractive retry the
  engine already had, and the fusion retry that lists the offending words.
- **Copy-constrained rewriting is the naturalness path that keeps zero
  fabrication**: rewrite gated in CODE — every content word must locate in
  the input facts, at most one fact line dropped, sentence shape enforced.
  Faithfulness detectors cap at ~70% balanced accuracy on narrative text, so
  the gate stays lexical, never a model judging a model.
- **Don't**: speculative decoding at this scale (net-negative on measured
  hardware), statistical trait-from-word-frequency (needs ~4-5k words per
  character), NLI/self-critique faithfulness checks.

## 5. The variants

- **skeleton** — richer DETERMINISTIC card: the shipped composition plus
  closed-template counted lines — voice ("She speaks in short lines, often
  to snap or mutter", verbs from a hand-written base-form map of the closed
  attribution set), company ("Most often on the page with Vey and Osric",
  self-aliases filtered), and the harvest's own action line ("Across the
  book she is the one who mended, baked, wove", ≥2 distinctive verbs).
- **fusion** — the tier model rewrites the card's fact lines as 2-5 connected
  sentences behind the containment gate; a failed gate falls back to the
  deterministic text, so its fabrication surface is zero by construction.
  The gate licenses the facts' own conjugations (possessive folding,
  irregular families, regular inflections) and rejects real invention
  ("moves through shadows … weaving tale" — the 1.7B, caught and killed).
- **deep** (max only) — wider evidence (span cap 14→20, per-channel quota
  3→4), deeper field caps (20/25/25 → 30/40/35 words), personality asked
  reason-first with show-don't-tell and multi-span fusion instructions, NO
  unconstrained think pass, then fusion. The think pass's 30s pays for all
  of it.

## 6. Results

(to be filled from the clean same-code sweep)

## 7. What ships

(to be decided from §6 — the wiring change is in WorldDataView.generateDossier
plus graduating the winning variant helpers into character-dossier.ts)

## Reproduce

```bash
# gold integrity
/opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs scripts/bench-dossier-score.ts bench-results/dossier-on-baseline.json

# a variant run (tiers do not co-fit in memory; run modes separately)
MODE=on  VARIANT=fusion ./node_modules/.bin/electron scripts/bench-dossier-quality.cjs
MODE=max VARIANT=deep   ./node_modules/.bin/electron scripts/bench-dossier-quality.cjs
```
