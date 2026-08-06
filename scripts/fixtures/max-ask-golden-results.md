# max-ask golden run — qwen3-4b-thinking-2507-q4_k_m
_Hand-graded transcript. The probe grades only the mechanical layer;_
_direction/sense verdicts are written by a human under each case._

## explain-dialogue  (explain)
- pack: 589 tok [passage, ask, who, neighbours, story-so-far, open-threads, related] · undefinedms
- expect: explains this exchange lays out the central conflict: Teo wants to sell the Petrel, Mara insists it is a shared inheritance, and neither one budges.
- mustTouch: sell · teo · mara · boat   mustNotClaim: that mara agrees to sell · that renner is part of this exchange
- expectedSource: passage
- mechanical: validator=accepted · surfaced=true · basis=passage · ~1 sentences · conf=0.9
- ANSWER: This paragraph shows Teo and Mara arguing over ownership of the Petrel, with Teo claiming he has the right to sell it and Mara insisting it belongs to both of them as inherited from their aunt Solvei.
- VERDICT: PASS — conflict, sides and stakes all correct; touches 4/4; basis passage as expected.

## explain-quiet  (explain)
- pack: 690 tok [passage, ask, who, opening, neighbours, story-so-far, open-threads, related] · undefinedms
- expect: explains this beat shows Priya deliberately staying out of the argument while signalling that the tension between Mara and Teo is no longer private.
- mustTouch: priya · net · raised voices   mustNotClaim: that priya takes a side · that priya confronts mara or teo directly
- expectedSource: passage
- mechanical: validator=accepted · surfaced=true · basis=passage · ~1 sentences · conf=0.8
- ANSWER: This paragraph shows Priya working on the boat without comment, continuing the quiet tension of the story as Mara tries to piece together Solvei's past.
- VERDICT: PARTIAL — direction compatible (stays out, quiet tension) but thin: misses the net and the raised-voices beat (touches 1/3).

## explain-reveal  (explain)
- pack: 654 tok [passage, ask, who, opening, neighbours, story-so-far, open-threads, related] · undefinedms
- expect: explains this paragraph plants the mystery of a deliberately removed logbook page, implying Solvei hid something on purpose.
- mustTouch: torn · logbook · six weeks   mustNotClaim: that it names who cut out the page · that it confirms renner removed it
- expectedSource: passage
- mechanical: validator=accepted · surfaced=true · basis=passage · ~1 sentences · conf=0.9
- ANSWER: This paragraph reveals that someone deliberately altered Solvei's logbook to hide an entry from the storm, suggesting the entry might be incriminating or dangerous.
- VERDICT: PARTIAL — the deliberate-concealment mystery is right and nobody is accused, but it drifts the date: says the hidden entry is 'from the storm' when the cut page is dated six weeks BEFORE (touches 1/3).

## check-contradicts-summary  (check)
- pack: 660 tok [passage, ask, who, opening, neighbours, story-so-far, open-threads, related] · undefinedms
- expect: flags the contradiction: this paragraph has Mara herself saying she watched Solvei row out, but chapter 4's summary says no one admits to seeing Solvei go out that night.
- mustTouch: solvei · saw her leave · no one saw   mustNotClaim: that the paragraph fits with nothing wrong · that this proves someone else caused solvei's death
- expectedSource: story-so-far
- mechanical: validator=accepted · surfaced=true · basis=passage · ~1 sentences · conf=0.9
- ANSWER: Mara is thinking about Solvei rowing out alone into the fog, which conflicts with the story-so-far that Solvei drowned during a spring storm and Mara found the Petrel empty the next morning.
- VERDICT: PARTIAL — it FLAGS a conflict in the right paragraph, but articulates the wrong one (rowing-into-fog vs drowned-in-storm) instead of the planted saw-her-leave vs nobody-admits-seeing (touches 1/3).

## check-control  (check)
- pack: 654 tok [passage, ask, who, opening, neighbours, story-so-far, open-threads, related] · undefinedms
- expect: finds no conflict; the tide returning and the evening ending quietly fits everything established so far, and the paragraph should be said to fit.
- mustTouch: tide · fits   mustNotClaim: that this contradicts the mooring-key thread · that this contradicts solvei's death
- expectedSource: passage
- mechanical: validator=accepted · surfaced=true · basis=passage · ~1 sentences · conf=0.8
- ANSWER: The paragraph shows Priya finishing the splice and coiling the net without being asked, which conflicts with the story-so-far that Priya has not spoken to anyone about the night Solvei went missing and has not said what she saw from shore.
- VERDICT: FAIL — invents a non-sequitur conflict on clean prose (splicing a net does not conflict with not-having-spoken). The linter-that-always-warns failure, despite the absence-is-not-a-conflict line. The one real red flag of this run.

## check-contradicts-thread  (check)
- pack: 676 tok [passage, ask, who, opening, neighbours, story-so-far, open-threads, related] · undefinedms
- expect: flags the contradiction: the mooring key is here hanging in its usual place, but the open thread says it has been missing since before Solvei died.
- mustTouch: mooring key · missing · wheelhouse   mustNotClaim: that the paragraph fits with nothing wrong · that teo moved the key
- expectedSource: open-threads
- mechanical: validator=accepted · surfaced=true · basis=passage · ~1 sentences · conf=0.9
- ANSWER: The mooring key is ordinary and a little rusted, as if nothing about that week had been strange, but earlier sections established that the mooring key has been missing since before Solvei died and no one has explained why.
- VERDICT: PASS — exactly the planted contradiction, articulated correctly (key present vs missing-since-before-she-died); basis label imperfect (passage, expected open-threads) but the text cites the earlier sections.

## suggest-low  (suggest)
- pack: 694 tok [passage, ask, who, opening, neighbours, story-so-far, open-threads, related] · undefinedms
- expect: suggests a modest next beat: Priya keeps working and eventually asks Mara directly what is going on, rather than any dramatic turn.
- mustTouch: priya · ask · net   mustNotClaim: that priya reveals she works for renner · that priya quits the boat
- expectedSource: passage, neighbours
- mechanical: validator=accepted · surfaced=true · basis=open-threads · ~1 sentences · conf=0.8
- ANSWER: Priya might have seen something from shore that night, as she has not been aboard the night Solvei went missing and has never explained what she saw.
- VERDICT: PARTIAL — grounded in the open thread (what Priya saw) but reads as an inference about the past, not a suggested NEXT beat (touches 1/3).

## suggest-mid  (suggest)
- pack: 700 tok [passage, ask, who, opening, neighbours, story-so-far, open-threads, related] · undefinedms
- expect: suggests Mara presses Teo or Renner for proof of the paper, since Renner's claim now has to be answered rather than ignored.
- mustTouch: renner · paper · teo   mustNotClaim: that renner already produced the signed paper · that the boat is sold
- expectedSource: passage, neighbours
- mechanical: validator=accepted · surfaced=true · basis=passage · ~1 sentences · conf=0.8
- ANSWER: Mara would likely confront Teo about his desire to sell the boat, as he has been the one to suggest it and she has not yet discussed it with him.
- VERDICT: PARTIAL — plausible confrontation but misses the paper and Renner, which are the live question (touches 1/3).

## suggest-high  (suggest)
- pack: 660 tok [passage, ask, who, opening, neighbours, story-so-far, open-threads, related] · undefinedms
- expect: suggests the admission pushes toward a harder confrontation: Mara demanding to see exactly what Solvei signed, with trust between the siblings further damaged.
- mustTouch: teo · paper · mara   mustNotClaim: that teo already sold the boat · that priya leaves the crew
- expectedSource: passage, neighbours
- mechanical: validator=accepted · surfaced=true · basis=passage · ~1 sentences · conf=0.8
- ANSWER: Mara might confront Teo about the paper he mentioned, as he has been avoiding eye contact and seems to know more than he's letting on about the logbook and the boat's past.
- VERDICT: PASS — confrontation over the paper, trust strained; touches 3/3.

## question-from-summary  (question — "How did Mara end up running the Petrel instead of Solvei?")
- pack: 486 tok [passage, ask, who, neighbours, story-so-far, open-threads, related] · undefinedms
- expect: answers from the story-so-far: Solvei drowned in a spring storm and Mara took over as skipper afterward.
- mustTouch: solvei · storm · mara took over   mustNotClaim: that teo was named skipper · that renner appointed mara
- expectedSource: story-so-far
- mechanical: validator=accepted · surfaced=true · basis=story-so-far · ~1 sentences · conf=0.9
- ANSWER: Mara ran the Petrel because Solvei drowned during a storm and Mara found the boat empty the next morning, as established in chapter 4.
- VERDICT: PASS — cause and succession right, from the right rung (basis story-so-far matches).

## question-from-related  (question — "Did Solvei ever say who she wanted the Petrel to go to?")
- pack: 650 tok [passage, ask, who, opening, neighbours, story-so-far, open-threads, related] · undefinedms
- expect: answers from the related passage: Solvei once said the boat should go to whoever loved it enough to keep the log honest.
- mustTouch: solvei · log honest · whoever loved it   mustNotClaim: that it was written into a formal will · that solvei named teo specifically
- expectedSource: related
- mechanical: validator=accepted · surfaced=true · basis=passage · ~1 sentences · conf=0.9
- ANSWER: No, Solvei never said who she wanted the Petrel to go to.
- VERDICT: FAIL — the related rung CONTAINS the answer ('whoever loved it enough to keep the log honest') and the model answered 'No, she never said'. A deep-rung retrieval miss, and the confident wrong direction is worse than an abstention.

## question-unanswerable  (question — "What does Renner do with the money once boat owners pay him back?")
- pack: 696 tok [passage, ask, who, opening, neighbours, story-so-far, open-threads, related] · undefinedms
- expect: abstains — nothing in any section says what Renner does with money once it is repaid.
- mustTouch: renner · repaid   mustNotClaim: that he reinvests in more boats · that he is corrupt or stealing from the harbour
- expectedSource: abstain
- mechanical: validator=accepted · surfaced=true · basis=passage · ~1 sentences · conf=0.9
- ANSWER: The passage does not mention what Renner does with the money once boat owners pay him back.
- VERDICT: PASS (with note) — correctly refuses to invent, but abstains in PROSE with basis=passage rather than the abstention basis; same residual shape as the starved-pack case recorded in max-ask.ts.

## question-false-premise  (question — "Why did Teo sell his share of the Petrel to Renner last spring?")
- pack: 587 tok [passage, ask, who, neighbours, story-so-far, open-threads, related] · undefinedms
- expect: corrects the false premise — Teo has not sold anything; it is Solvei's alleged sale to Renner that is in question — or abstains. Must not answer as if Teo's sale happened.
- mustTouch: teo · renner   mustNotClaim: that teo sold his share of the boat · a reason for a sale that never happened
- expectedSource: passage, abstain
- mechanical: validator=accepted · surfaced=true · basis=passage · ~2 sentences · conf=0.9
- ANSWER: The question asks why Teo sold his share of the Petrel to Renner last spring, but the passage does not mention anything about Teo selling his share to Renner last spring. The passage only shows a conversation where Teo says he could sell it tomorrow to Renner, but there is no information about a prior sale.
- VERDICT: PASS — explicitly identifies the false premise and separates 'could sell tomorrow' from a past sale. The strongest answer of the run.

## question-detail-lookup  (question — "What is Priya carrying when she comes aboard?")
- pack: 684 tok [passage, ask, who, opening, neighbours, story-so-far, open-threads, related] · undefinedms
- expect: answers directly from the passage: a coil of new net.
- mustTouch: net · coil   mustNotClaim: that she is carrying rope or tools instead · that she brings the logbook
- expectedSource: passage
- mechanical: validator=accepted · surfaced=true · basis=passage · ~1 sentences · conf=0.9
- ANSWER: Priya is carrying a coil of new net.
- VERDICT: PASS — exact: 'a coil of new net.'

---

## Hand-graded summary — 2026-08-06, qwen3-4b-thinking-2507-q4_k_m

| verdict | count | cases |
|---|---|---|
| PASS | 7 | explain-dialogue, check-contradicts-thread, suggest-high, question-from-summary, question-unanswerable*, question-false-premise, question-detail-lookup |
| PARTIAL | 5 | explain-quiet, explain-reveal, check-contradicts-summary, suggest-low, suggest-mid |
| FAIL | 2 | check-control, question-from-related |

*abstains in prose rather than via the abstention basis.

**The strongest global result: ZERO mustNotClaim violations across all 14 —
nothing invented, no false premise confirmed, no accusation fabricated.** The
failures are misses and timidity, never fabrication, which is the right side
of the trade for a writing tool.

Known weaknesses, recorded for a MECHANISM fix later (never prompt-iteration
against this set — it is the evaluation, not training data):
1. check-control: a non-sequitur conflict invented on clean prose. Any fix
   must be built on the TUNING fixture and this set re-run ONCE.
2. question-from-related: deep-rung retrieval miss — content in the `related`
   rung was not used, and the model answered a confident "no" instead of
   abstaining. Rung salience is the suspect.
3. suggest-kind tends to converge on "Mara confronts Teo" regardless of the
   tension level asked for.
4. Abstention arrives as prose + basis=passage rather than the abstention
   basis (also seen on the starved-pack probe case).
