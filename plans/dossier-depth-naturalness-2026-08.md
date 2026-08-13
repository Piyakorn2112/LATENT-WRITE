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

## 5b. The second reading round (mixed-code sweep, findings only)

The first full variant sweep ran while fixes were still landing, so its
numbers are not comparable — but reading its cards produced five findings,
each fixed before the clean sweep:

1. **Light verbs are glue, not claims.** The gate's residual rejects were
   found ×4, appeared ×3, wore, made, remained, showed — verbs that
   predicate facts already present ("wore a deep blue cloak", cloak being
   the fact). A closed glue set is licensed; contentful words stay checked.
2. **Lexical containment cannot see a causal join.** The 4B fused two true
   facts into "had been at Netherfield long enough TO BE the least dear…" —
   every word licensed, the claim invented. The prompt now forbids joining
   facts into cause, purpose or sequence the lines do not state. (This is
   the known limit of the gate; the residual risk is a wrong CONNECTIVE
   between true facts, never a new particular.)
3. **The action line failed its second audition.** "Across the book Kinoko
   is the one who filed, agreed, closed" is grammatical and empty —
   distinctive verbs are distinctive relative to the cast, not meaningful in
   themselves. Reverted, same lesson as the owner's original verb-tally
   revert. The verbs stay pack facts the model may phrase ("focused and
   precise in action" — the 4B, from the same counts).
4. **Background needs an ownership clause.** Lyssa's "she was twenty-two"
   shipped on Gareth's card via a span genuinely about his wedding year. The
   field definition now requires history of THIS PERSON only.
5. **A bearing is not an origin** ("the direction Kinoko would come from"
   passed the weak-lore vetoes); the head noun in front of the motion now
   disqualifies it.

Also measured in that round: deep mode HALVED the card (38.6s → ~20s) by
replacing the 1024-token think pass with an in-schema reason field, and its
best fused cards were the first output of this engine that reads written
rather than assembled: "Darcy is a fine, tall person with handsome features
and a noble mien. He is intelligent and socially superior, yet emotionally
sensitive and prone to resentment. Darcy speaks at length and is most often
on the page with Elizabeth and Jane."

## 6. Results (clean same-code sweep, 14 cards, 2026-08-13)

```
                          core   ext  anti  invented  frag  words  s/card
on   baseline (shipped)     4%    1%    0      0        6%    11     0.9
on   skeleton               14%    5%    0      0       31%    26     0.9   ← ships
on   fusion (1.7B)          14%    5%    0      0       28%    25     3.4   1/12 gate pass — rejected
max  baseline (shipped)     10%    0%    0      0       36%    20    38.5
max  fusion (think kept)    12%    2%    0      0       12%    32    41.4
max  deep                   13%    5%    0      0        8%    40    ~17*   ← ships
```

\* Three root-crown cards in the deep run hit 10-35 MINUTE model calls at the
tail of a 90-minute continuous sweep; a fresh re-run of the same three cards
took 17/16/25s. The stall is environment degradation under sustained load
(the calls carry a 180s timeout that the assistant layer's reload path
evidently exceeds), recorded here as an ops observation — the variant's own
latency is the fresh number.

Fabrication stayed ZERO on every axis in every variant: no anti-fact hits,
no invented particulars, across 70 generated cards.

Reading verdicts that the aggregates cannot show:

- The deep+fused cards are the first this engine has produced that read
  written rather than assembled (Darcy, Jane, Kinoko).
- The on-tier fusion is not shippable: the 1.7B reaches for imagery and
  fails the containment gate 11 of 12 times even with the glue license and
  a named-words retry. The skeleton alone carries the on-tier win.
- The pronoun gate closed the last measured wrong-person leak (Lyssa's age
  on Gareth's card survived the ownership prompt; the code gate refuses a
  factual answer opening on the opposite-gender pronoun).

## 7. What shipped (2026-08-13)

Everything measured above graduated into `src/lib/character-dossier.ts` and
`WorldDataView.generateDossier`:

- **ON tier**: the extractive composition gained the voice and company
  counted lines (its 4% → 14%); the 1.7B appearance call stays; no fusion.
  Latency unchanged (~1-2s plus the model call).
- **MAX tier**: wider evidence (MAX_PACK_OPTS 20/4), raised caps
  (220/300/260 chars, 30/40/35 words), conduct-first fused-citation
  personality asked reason-first IN-SCHEMA (the 1024-token think pass is
  retired — its ~30s bought less than the ~100-token reason field),
  opposite-pronoun code gate on factual fields, then the fusion pass with
  the containment gate and one named-words retry. Composed fields remain
  the fallback whenever fusion fails, so fusion can only add.

**Definitive numbers, the shipped wiring measured end to end** (the same
14 dev cards, one code version, fresh process):

```
                    core   ext  anti  invented  frag  words  s/card
on   shipped         14%    5%    0      0       32%    24     0.9   (was 4% / 1% / 11w)
max  shipped         14%    5%    0      0        5%    44    21.4   (was 10% / 0% / 20w / 38.5s)
```

Fusion passed its gate on 5 of 13 attempted cards; every failure fell back
to the composed fields. Cards worth quoting, verbatim from the run:

> "Darcy is a fine, tall person with handsome features and a noble mien.
> He is superior, clever, and continually gives offence. Darcy speaks at
> length. He is most often found on the page with Elizabeth and Jane."

> "Van Helsing has bushy brows and a dark figure with great brown hands.
> He moves with fury of strength when he swoops upon someone. His face is
> often agonised, and he speaks at length."

Verification ledger: suite 85/85 (tidy fixture rebuilt at the new cap),
verify:dossier-ui 18/18 (Osric contract updated: counted lines are facts,
and ONLY counted lines may appear for a never-described character),
verify:assistant-tasks 30/30, tsc and vite build clean.

## 8. Residuals, recorded not patched

- **Background at 35 words invites the ramble.** Scrooge's card carries the
  locomotive-hearse sentence, Mira's her father's standing lunches (the
  span's strong predicate is "before Mira was born"; the model quotes its
  surroundings). A tighter budget or a scene-clause veto on the ANSWER side
  is the next measured experiment.
- **The extractive retry can compress to a gerund list** ("Sighing,
  drawing, realizing" passed the three-word trait floor). A
  no-bare-gerund-list test on usefulTrait would close it.
- **Fusion sometimes stumbles on its own repetition** ("Kinoko considered
  the question. Kinoko considered.") — all words licensed, so the gate
  passes it; a repeated-clause check would catch it.
- **The fragment-shape reject is the top fusion failure** (the card's
  noun-phrase register collides with the gate's every-sentence-finite-verb
  rule when the model keeps a bare appearance line). Letting ONE
  noun-phrase sentence through when it carries an appearance noun would
  roughly double the pass rate; needs measuring against the invention risk.
- **Long-sweep environment degradation**: after ~90 minutes of continuous
  model load, individual calls ballooned to 10-35 minutes despite a 180s
  request timeout (the assistant layer's reload path evidently exceeds it).
  Ops observation for any future long bench: run sweeps in fresh processes,
  and treat tail-of-sweep latency as suspect.

## 9. The held-out one-shot (hollow-iris, sealed gold, run ONCE, 2026-08-13)

Six characters, gold written blind by an agent before the config froze,
never iterated against. Reported verbatim:

```
                    core   ext  anti  invented  frag  words  s/card
on   shipped         25%   24%    4      0        9%    31     1.0
max  shipped         38%   27%    4      0        0%    69    20.4
```

Coverage generalized UPWARD from the dev books (the draft's institutional
register states more outright). Invented particulars stayed zero. The four
anti-fact hits were read one by one: three are gold-key artifacts (the
sealed gold's keys were never calibrated — "often" fires on "often
mirroring", and the counted company line "most often on the page with Nora"
trips a "they never meet in person" claim), and one is a REAL residual
worth its own line: Kael's card carries "shielded eyes", a scene moment
grounded in the pack and presented as durable appearance — the
scene-as-feature class again, this time surviving on the model side. It
joins §8 as the next measured experiment (the same veto family the
composer's appearance channel already applies, at the answer side).

## Reproduce

```bash
# gold integrity
/opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs scripts/bench-dossier-score.ts bench-results/dossier-on-baseline.json

# a variant run (tiers do not co-fit in memory; run modes separately)
MODE=on  VARIANT=fusion ./node_modules/.bin/electron scripts/bench-dossier-quality.cjs
MODE=max VARIANT=deep   ./node_modules/.bin/electron scripts/bench-dossier-quality.cjs
```
