# Auto role and description for the world panel, measured

**Question.** When a writer opens the world data overlay and selects a character,
can the app fill in `role` and `description` automatically, accurately enough to
be trusted, from a novel-wide context gathering system plus the local model, on
both the **on** and **max** tiers?

**Answer.** Yes for **max**, with a deterministic gate in front of the model and
a citation check behind it. No for **on** as a *generative* feature. The 1.7B
does not become conservative when told to be conservative. It becomes silent or
it fabricates, and it did both in the same run.

Every number below is measured, on the committed corpus, against the two
shipping models. Nothing here is shipped. Two probes are added.

---

## 1. What exists today

`WorldCharacter` in `src/types.ts` carries `name`, `aliases`, `role`,
`description`. Both text fields are free-form and hand-typed. `WorldDataView.tsx`
renders `role` with the placeholder "e.g. Protagonist" and `description` with "A
short note that helps you (and the analysis) keep track of this entity."

The scan pipeline already finds and classifies names
(`world-data.ts: scanAndClassify`), reviews the doubtful ones with the model
(`entity-review.ts`), and proposes aliases (`alias-scan.ts`). It has never
attempted the two prose fields.

### The three things a card would claim, and where each lives

| field | where the answer is | can the deterministic layer answer it |
|---|---|---|
| ROLE | structural: mention counts, chapters present, speech share, co-presence | mostly yes |
| APPEARANCE | in the prose, and almost never beside the name | no |
| LORE | often only ever inside dialogue | no |

---

## 2. The evidence exists

`scripts/probe-character-dossier.ts` harvests verbatim sentence spans through
nine syntactic channels and counts coverage of the top ten cast per book.

```
book       cast  vis>=1  vis>=3  lore>=1  rel>=1  spoken
pride        10     10     10      10      6       5
sherlock     10      9      8       6      0       3
anne         10     10     10      10      5       4
dracula      10     10     10      10      4       4
carol        10      9      8       3      2       2
webnovel     10      7      1       2      0       0
ALL          60    92%    78%     68%    28%     30%
```

So the material is there. The interesting question is *when* it arrives, because
a writer opens this panel mid-draft, not on a finished novel.

```
EVIDENCE vs DRAFT LENGTH (top-10 cast)
book          chapters    words  vis>=1  vis>=3  lore>=1
hollow-iris   4             12k     8      2       2
hollow-iris   16            49k     7      5       7
hollow-iris   all (174)    535k    10      9       8
root-crown    4             12k     6      3       3
root-crown    16            44k    10      9       8
anne          4             12k     9      4       6
anne          32            87k    10     10       8
pride         4              5k     6      1       4
pride         16            33k    10      9       9
```

**Below roughly 15k words the panel has very little to say, and it saturates
around 30k to 40k.** That is a product constraint, not a bug. A card offered at
chapter three will be mostly empty and must look deliberately empty rather than
broken.

Note the ceiling on `hollow-iris`: at 535k words one of the top ten still has no
visual evidence. A first-person narrator is invisible to appearance harvesting
because nobody describes them and they do not describe themselves.

---

## 3. The finding that reshaped the design

The first harvester required the character's name in the sentence. On Pride and
Prejudice it produced fourteen spans for Elizabeth Bennet and **not one of them
described her**. Two described other women who happened to share a sentence with
her.

That is not a tuning problem. Here is every real description of Elizabeth in the
book:

- "She is tolerable: but not handsome enough to tempt _me_"
- "it was rendered uncommonly intelligent by the beautiful expression of her dark eyes"
- "the brilliancy which exercise had given to her complexion"
- "Her face is too thin; her complexion has no brilliancy"

**Her name is in none of them.** Prose establishes a topic and then describes it
by pronoun. Requiring the name is not a strict rule, it is the wrong rule, and
its cost is the protagonist.

The fix already ships. `resolvePronounOwners` in `speech-detect.ts` is the
engine's internal pronoun resolution surfaced for the highlight layer. It is
gender-mapped, alias-canonicalised, refuses to resolve pronouns inside quotation
marks, and grades itself 0.9 tag-adjacent, 0.7 gender-known antecedent, 0.5
fallback. Trusting only the first two rungs and requiring an adjective attached
to the appearance noun added **390 spans** and moved `vis>=3` from 68% to 78%.
Elizabeth's "dark eyes" span appears only through this channel.

---

## 4. Retrieval is solved. Ranking is not.

The pool the harness produces is roughly **one usable appearance span in seven**,
which is close to the 1-in-8 raw precision the knowledge ledger measured before
the adjudicator was built for it.

Worse, the harness cannot tell which of its own spans is the good one. Ranking by
channel quality was tried first and it filled Elizabeth's entire budget with
`appositive` and `copular` hits ("Elizabeth, who had a letter to write") while
starving out the one channel that had found Austen's actual description. **A
ranking over channels is a bet that syntactic shape predicts descriptive content,
and it does not.** Every channel now gets a small guaranteed quota instead.

### The no-model baseline

`--top1` prints what the harness alone puts at rank one, for 36 characters across
six books. Judged by reading, **10 of the 31 ungated picks describe the right
person, about 32%.**

When it is right it is very right:

```
Scrooge   The cold within him froze his old features, nipped his pointed nose,
          shrivelled his cheek, stiffened his gait; made his eyes red...
Marilla   Marilla was a tall, thin woman, with angles and without curves; her
          dark hair showed some gray streaks...
Wickham   His appearance was greatly in his favour: he had all the best parts
          of beauty, a fine countenance, a good figure...
```

When it is wrong it is confidently about somebody else:

```
Darcy     His sister was less delicate, and directed her eye towards Mr. Darcy
          with a very expressive smile.
Mina      They were driven by a tall man, with a long brown beard...
Tiny Tim  ...in came little Bob, the father, with at least three feet of comforter
```

A card built this way would be wrong about two times in three. **The
deterministic layer cannot ship this alone.**

---

## 5. Both tiers fabricate on an empty pack

`scripts/probe-dossier-model.cjs` runs the real models over six real packs. Two
cases are deliberately starved, and per this repo's own doctrine those are the
cases that decide.

Handed a pack with **zero** spans, `Elder Kang`:

```
small (1.7B)   "Elder Kang looks like a man in his 70s, with a beard, wearing a
                traditional Chinese robe, and carrying a staff. He has a calm and
                wise gaze."     cites [1]  -- span 1 does not exist  -- conf 0.8

max (4B)       "A man with a long beard and a white robe"
                                cites [1]  -- span 1 does not exist  -- conf 0.8
```

Both fabricated. Both cited a passage number that does not exist. Both at 0.8.

This is **not** a prompt failure. The system prompt already said, in those words,
"An empty answer is a correct answer" and "Never use anything you know about this
book from elsewhere". Do not try to fix this by iterating the prompt.

### The gate, and it is measured

The empty pack must never reach the model. `visualCandidates` is the set of spans
that actually contain an appearance noun with an adjective attached. Zero means
the field stays empty and no call is made.

```
webnovel:Jonah       GATED -- 0 spans carry a describable feature   correct, 0 tokens
webnovel:Elder Kang  GATED -- 0 spans carry a describable feature   correct, 0 tokens
```

Canaried: `GATE=off` reproduces both fabrications above, so the gate is what
changed the outcome. Same rule as the adjudicator's guards, same reason. A
question a model cannot answer honestly is a question the harness should not ask.

**The gate had a real bug when first written.** `adjacentAdjective` tested only
the first appearance noun in a sentence, so Elizabeth's one description failed it
(the first noun is `face`, bare, in "hardly a good feature in her face"). Testing
every occurrence moved `pronoun-owned` from 281 spans to 390 and `vis>=1` from
87% to 92%. Recorded because a gate that silently excludes the best evidence in
the corpus is worse than no gate.

**The gate is a floor, not a whitelist.** It answers "does anything here describe
anybody", not "does anything here describe *this person*". Darcy's gate-eligible
set is almost entirely other people's faces. It must never be used to restrict
which spans may be cited.

---

## 6. What max actually does

With the gate on and the citation repaired:

| case | cited | wrote | verdict |
|---|---|---|---|
| pride:Elizabeth | [3] | "dark eyes" | grounded as cited |
| pride:Darcy | [1,7] | "standing near enough for her to overhear a conversation" | grounded, and vacuous |
| anne:Anne | [3,5,6] | "white face, big eyes, flushed face, freckled face, solemn gray eyes" | repairable to [9] |
| dracula:Van Helsing | [1,5,9] | "bushy brows" | grounded as cited |
| webnovel:Jonah | gated | | correct |
| webnovel:Elder Kang | gated | | correct |

Roughly 4 to 5 seconds per character, 8 seconds cold.

**Max picked the one correct span out of fourteen for Elizabeth.** That is the
whole value proposition: the harness moves precision from 32% to about 75%, and
that jump is the entire reason to make the call.

### Citation errors are repairable, not fatal

Both tiers wrote "freckled face, solemn gray eyes" for Anne Shirley and cited
spans that do not contain those words. The grounding check failed it. But the
words are in span **9**, which the model read and simply failed to number.

The retrieval was right, the writing was right, only the citation was wrong.
Rejecting there throws away the best description in the pack. So a claim that
fails against its own citations is re-checked against the whole pack, and only a
claim that locates nowhere is refused. This also rules out the contamination
worry: the model was reading, not remembering a famous book.

### The residual, recorded not patched

Darcy's answer is **grounded and useless**. "standing near enough for her to
overhear a conversation" passes every check and says nothing. Grounding proves
provenance, never relevance. A shipped version needs a separate usefulness test,
probably "does the line contain at least one appearance noun with a modifier",
and that test has not been measured.

---

## 7. The 1.7B cannot do this job

On the four packs with real evidence:

- **Three of four: abstained entirely.** Empty string, zero spans, confidence 0,
  where good evidence was sitting in front of it.
- **One of four: wrote and was refused.** "Anne's white face and big eyes, a
  little flat glossy sailor hat, and plain clothes were neatly arranged and cared
  for" contains material in no span at all. The role field came back as "the girl
  who is smart and obedient, willing to 9", truncated mid-token.

So it does not degrade gracefully into "correct but generic". It degrades into
silence or invention, unpredictably, on the same run.

### The narrower job also fails

`PICK=1` asks it only to point at spans, never to compose, which is the shape
`chip-picker.ts` already proves works for the timeline. Judged by reading, it
picks the right person **about half the time**, and its `reason` field on three
of four cases was the string "Passages 2, 3, 4, 9, 13, 14", listing numbers it
had not put in `spans`.

Half is not "still correct".

---

## 8. The architecture this implies

```
             ┌── harvest ──────────────────────────────────────────┐
             │  9 channels over narration and dialogue separately  │
             │  + resolvePronounOwners at confidence >= 0.7        │
             │  + per-channel quota, no cross-channel ranking      │
             └──────────────────────┬──────────────────────────────┘
                                    │  ~14 spans, ~1-in-7 useful
             ┌──────────────────────▼──────────────────────────────┐
             │  GATE  visualCandidates.length == 0  ->  stop here  │
             └──────────────────────┬──────────────────────────────┘
                   off              │              max
        ┌──────────────────────┐    │    ┌─────────────────────────┐
        │ NO MODEL.            │◄───┴───►│ 4B thinking, cite first │
        │ role from counted    │         │ then write from cites   │
        │ facts. description   │         └───────────┬─────────────┘
        │ blank, with the      │         ┌───────────▼─────────────┐
        │ top spans offered    │         │ ground -> repair -> or  │
        │ as quotes to accept  │         │ refuse. Never silent.   │
        └──────────────────────┘         └─────────────────────────┘
```

**on** is not a weaker generator, it is a different product. Counted facts give
`role` deterministically and honestly ("named 727 times across 57 of 57 chapters,
first in chapter 1, most often on the page with Darcy and Jane" is a real answer
to "what is this person to the story"). `description` stays empty, and the panel
offers the top ranked spans as verbatim quotes the writer can accept with one
click. Zero fabrication surface by construction, and the writer's own sentence
goes into their own card.

**max** is the generative tier, and it earns it.

---

## 9. The risk nobody would notice

`role` and `description` are not leaf fields. They are read back into two model
packs as the character dossier:

- `evidence-pack.ts:101` -> `const bits = [entry.role, entry.description]`
- `max-ask.ts:323` -> `const bits = [c?.role, c?.description].join(". ")`

So **generated text becomes evidence for later model calls**, and by the second
hop nothing distinguishes it from something the writer asserted. That is the
`corrections-are-error-evidence` failure with a new face.

There is a third reader. `character-voice.ts: inferGender` regexes `role` plus
`description` for gendered nouns and uses the result to raise pronoun-mismatch
warnings. A generated description containing "sister" or "his" can flip a gender
inference and manufacture a false warning about the writer's own prose.

**Any implementation has to carry provenance on these fields** (generated vs
written, and the cited chapter), must exclude generated text from packs fed back
to the model, and must exclude it from `inferGender` until the writer has
accepted it.

---

## 10. What is not settled

- The usefulness test that would have caught the Darcy answer. Not designed, not
  measured.
- Lore. Every number above is about appearance. `lore-spoken` fired for only 30%
  of the cast and a spoken claim about a character can be false in-world, which
  is a different problem from being ungrounded and is not addressed here.
- `they/them`. `resolvePronounOwners` handles he/him/his and she/her/hers only.
  Nonbinary characters get nothing from the channel that carries most of the
  evidence.
- Cost at cast scale. Every measurement is per character on demand. Twenty
  characters at 5s each is a 100s sweep, which is a background job with all the
  scheduling that implies, not a panel-open.
- Held-out books. Everything here ran on DEV books. The TEST set was not touched
  and must not be until a design is frozen.

---

## Reproduce

```bash
# the funnel, the growth curve, the no-model baseline
node node_modules/tsx/dist/cli.mjs scripts/probe-character-dossier.ts
node node_modules/tsx/dist/cli.mjs scripts/probe-character-dossier.ts --growth
node node_modules/tsx/dist/cli.mjs scripts/probe-character-dossier.ts --top1
node node_modules/tsx/dist/cli.mjs scripts/probe-character-dossier.ts --show pride
node node_modules/tsx/dist/cli.mjs scripts/probe-character-dossier.ts --pack pride:Elizabeth

# the models. Run the tiers separately, they do not both fit in memory.
TIERS=small ./node_modules/.bin/electron scripts/probe-dossier-model.cjs
TIERS=max   ./node_modules/.bin/electron scripts/probe-dossier-model.cjs
PICK=1 TIERS=small ./node_modules/.bin/electron scripts/probe-dossier-model.cjs
GATE=off TIERS=small ./node_modules/.bin/electron scripts/probe-dossier-model.cjs   # canary
```
