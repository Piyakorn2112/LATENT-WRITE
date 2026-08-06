# max-ask golden — ROUND 2, full shipped chain — qwen3-4b-thinking-2507-q4_k_m
_ask -> coerce -> claim-check -> (refine -> re-check). Hand-graded below._

## explain-dialogue  (explain)
- expect: explains this exchange lays out the central conflict: Teo wants to sell the Petrel, Mara insists it is a shared inheritance, and neither one budges.
- mustTouch: sell · teo · mara · boat   mustNotClaim: that mara agrees to sell · that renner is part of this exchange
- chain: flagged:"Teo and Mara argue over ownership of the Petrel" · refined=true · review=supported · basis=passage · 25072ms
- ANSWER: This paragraph shows Teo and Mara discussing the ownership and sale of the Petrel, with Teo claiming he has the right to sell it and Mara insisting it belongs to both of them as inherited from their aunt Solvei.
- VERDICT: PASS (refined) — the quote-check flagged a fair paraphrase ('argue over ownership'), the refine pass re-grounded it, the re-check passed, and the writer would see only the small self-corrected line. The user-described case, working.

## explain-quiet  (explain)
- expect: explains this beat shows Priya deliberately staying out of the argument while signalling that the tension between Mara and Teo is no longer private.
- mustTouch: priya · net · raised voices   mustNotClaim: that priya takes a side · that priya confronts mara or teo directly
- chain: clean · refined=false · review=supported · basis=passage · 9745ms
- ANSWER: This paragraph shows Priya working on the boat without comment, continuing the quiet tension of the story as Mara tries to piece together Solvei's past.
- VERDICT: PARTIAL — unchanged from round 1 (direction compatible, thin).

## explain-reveal  (explain)
- expect: explains this paragraph plants the mystery of a deliberately removed logbook page, implying Solvei hid something on purpose.
- mustTouch: torn · logbook · six weeks   mustNotClaim: that it names who cut out the page · that it confirms renner removed it
- chain: clean · refined=false · review=supported · basis=passage · 9639ms
- ANSWER: This paragraph reveals that someone deliberately altered Solvei's logbook to hide an entry from the storm, suggesting the entry might be incriminating or dangerous.
- VERDICT: PARTIAL — unchanged; the six-weeks/storm date drift persists.

## check-contradicts-summary  (check)
- expect: flags the contradiction: this paragraph has Mara herself saying she watched Solvei row out, but chapter 4's summary says no one admits to seeing Solvei go out that night.
- mustTouch: solvei · saw her leave · no one saw   mustNotClaim: that the paragraph fits with nothing wrong · that this proves someone else caused solvei's death
- chain: flagged:"Mara thinks about Solvei rowing out alone" · refined=true · review=supported · basis=story-so-far · 20922ms
- ANSWER: The paragraph conflicts with the story-so-far section because it implies Mara knows Solvei rowed out alone, but earlier established that Mara did not know what Solvei did that night.
- VERDICT: PASS (refined) — UP from PARTIAL: the revision now articulates the PLANTED contradiction (Mara knowing Solvei rowed out vs 'did not know what Solvei did that night'), basis story-so-far. The refine pass turned a muddled flag into the right one.

## check-control  (check)
- expect: finds no conflict; the tide returning and the evening ending quietly fits everything established so far, and the paragraph should be said to fit.
- mustTouch: tide · fits   mustNotClaim: that this contradicts the mooring-key thread · that this contradicts solvei's death
- chain: clean · refined=false · review=supported · basis=fits · 9483ms
- ANSWER: The paragraph does not conflict with anything established in the other sections. It fits.
- VERDICT: PASS — UP from FAIL: basis=fits, 'It fits.' The schema outlet did exactly what the ask-line alone could not.

## check-contradicts-thread  (check)
- expect: flags the contradiction: the mooring key is here hanging in its usual place, but the open thread says it has been missing since before Solvei died.
- mustTouch: mooring key · missing · wheelhouse   mustNotClaim: that the paragraph fits with nothing wrong · that teo moved the key
- chain: clean · refined=false · review=supported · basis=passage · 14640ms
- ANSWER: The mooring key is ordinary and a little rusted, as if nothing about that week had been strange, but earlier sections established that the mooring key has been missing since before Solvei died and no one has explained why.
- VERDICT: PASS — unchanged; the planted key contradiction, correctly articulated.

## suggest-low  (suggest)
- expect: suggests a modest next beat: Priya keeps working and eventually asks Mara directly what is going on, rather than any dramatic turn.
- mustTouch: priya · ask · net   mustNotClaim: that priya reveals she works for renner · that priya quits the boat
- chain: clean · refined=false · review=supported · basis=open-threads · 9707ms
- ANSWER: Priya might have seen something from shore that night, as she has not been aboard the night Solvei went missing and has never explained what she saw.
- VERDICT: PARTIAL — unchanged (inference about the past, not a next beat).

## suggest-mid  (suggest)
- expect: suggests Mara presses Teo or Renner for proof of the paper, since Renner's claim now has to be answered rather than ignored.
- mustTouch: renner · paper · teo   mustNotClaim: that renner already produced the signed paper · that the boat is sold
- chain: clean · refined=false · review=supported · basis=passage · 9951ms
- ANSWER: Mara would likely confront Teo about his desire to sell the boat, as he has been the one to suggest it and she has not yet discussed it with him.
- VERDICT: PARTIAL — unchanged (misses paper/Renner).

## suggest-high  (suggest)
- expect: suggests the admission pushes toward a harder confrontation: Mara demanding to see exactly what Solvei signed, with trust between the siblings further damaged.
- mustTouch: teo · paper · mara   mustNotClaim: that teo already sold the boat · that priya leaves the crew
- chain: flagged:"Teo knows about the paper but not what it is" · refined=false · review=overreaches · basis=passage · 22700ms
- ANSWER: Mara might confront Teo about the paper he mentioned, as he has been avoiding eye contact and seems to know more than he's letting on about the logbook and the boat's past.
- VERDICT: PASS with an unnecessary caution — the answer is fine, but the checker flagged a supported-but-paraphrased claim and the refine failed to ground it, so a caution shows on a decent answer. New residual class, cost = a caution, never a wrong fact.

## question-from-summary  (question — "How did Mara end up running the Petrel instead of Solvei?")
- expect: answers from the story-so-far: Solvei drowned in a spring storm and Mara took over as skipper afterward.
- mustTouch: solvei · storm · mara took over   mustNotClaim: that teo was named skipper · that renner appointed mara
- chain: flagged:"Mara found the Petrel empty the next morning after Solvei's" · refined=false · review=overreaches · basis=story-so-far · 21992ms
- ANSWER: Mara ran the Petrel because Solvei drowned during a storm and Mara found the boat empty the next morning, as established in chapter 4.
- VERDICT: PASS with an unnecessary caution — same residual class as suggest-high: correct answer, flag on a claim the summaries do state, refine could not ground it.

## question-from-related  (question — "Did Solvei ever say who she wanted the Petrel to go to?")
- expect: answers from the related passage: Solvei once said the boat should go to whoever loved it enough to keep the log honest.
- mustTouch: solvei · log honest · whoever loved it   mustNotClaim: that it was written into a formal will · that solvei named teo specifically
- chain: clean · refined=false · review=supported · basis=passage · 7020ms
- ANSWER: No, Solvei never said who she wanted the Petrel to go to.
- VERDICT: FAIL — unchanged, and now precisely diagnosed: 'No, Solvei never said' decomposes to nothing checkable (a negative claim has no quote), so the checker returns supported and the refine never fires. The confident-negative shape needs the same coercion prose-abstention got.

## question-unanswerable  (question — "What does Renner do with the money once boat owners pay him back?")
- expect: abstains — nothing in any section says what Renner does with money once it is repaid.
- mustTouch: renner · repaid   mustNotClaim: that he reinvests in more boats · that he is corrupt or stealing from the harbour
- chain: clean · refined=false · review=- · basis=not-in-what-i-was-given · 4191ms
- ANSWER: The passage does not mention what Renner does with the money once boat owners pay him back.
- VERDICT: PASS — UP from pass-with-note: the coercion turned the prose abstention into a real one (basis not-in-what-i-was-given), so the loop and UI treat it honestly.

## question-false-premise  (question — "Why did Teo sell his share of the Petrel to Renner last spring?")
- expect: corrects the false premise — Teo has not sold anything; it is Solvei's alleged sale to Renner that is in question — or abstains. Must not answer as if Teo's sale happened.
- mustTouch: teo · renner   mustNotClaim: that teo sold his share of the boat · a reason for a sale that never happened
- chain: clean · refined=false · review=- · basis=not-in-what-i-was-given · 4625ms
- ANSWER: The question asks why Teo sold his share of the Petrel to Renner last spring, but the passage does not mention anything about Teo selling his share to Renner last spring. The passage only shows a conversation where Teo says he could sell it tomorrow to Renner, but there is no information about a prior sale.
- VERDICT: PASS — still the run's best behaviour; now lands as a proper abstention with the explanation intact.

## question-detail-lookup  (question — "What is Priya carrying when she comes aboard?")
- expect: answers directly from the passage: a coil of new net.
- mustTouch: net · coil   mustNotClaim: that she is carrying rope or tools instead · that she brings the logbook
- chain: clean · refined=false · review=supported · basis=passage · 6353ms
- ANSWER: Priya is carrying a coil of new net.
- VERDICT: PASS — exact.

---

## Round 2 summary vs Round 1

| | R1 | R2 |
|---|---|---|
| PASS | 7 | **9** (2 refined, 2 with unnecessary caution) |
| PARTIAL | 5 | 4 |
| FAIL | 2 | **1** |

Still ZERO mustNotClaim violations. What moved:
- check-control FAIL -> PASS: the `fits` schema outlet.
- check-contradicts-summary PARTIAL -> PASS: the refine pass re-articulated
  the flag into the planted contradiction.
- Two paraphrase flags were resolved invisibly by refine + re-check — the
  writer sees a small "self-corrected" line, not a warning.
- question-unanswerable now abstains properly (prose-abstention coercion).
- NEW residual: 2 unnecessary cautions where the checker flagged a
  supported-but-paraphrased claim and the refine failed to ground it.
- REMAINING FAIL: question-from-related — "No, Solvei never said" decomposes
  to nothing checkable, so no flag, no refine. Fixed after this run by adding
  never/nothing to the prose-abstention coercion (unit-gated; per the
  one-re-run discipline this set is NOT run a third time — the expectation is
  that the case now ships as an abstention rather than a confident wrong "No").

Note on timings: per-case ms in this transcript includes ~1s of tsx spawn
overhead per chain stage (probe artifact); in-app the chain has no spawns.
