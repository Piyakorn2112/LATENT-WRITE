/**
 * alias-stress-chapter.ts — one adversarial chapter, and the answers it owes.
 *
 * ★★ ONE STORY READ SPAN BY SPAN BEATS A PILE OF SYNTHETIC CASES. Isolated
 *    fixtures let every layer meet its evidence in perfect conditions and never
 *    meet each other's; a chapter makes the layers share a text, so the
 *    adjacency pass has to survive the sentence openers the vocative pass
 *    needs, and the family veto has to fire in a book that also wants a
 *    surname absorbed two paragraphs earlier.
 *
 * ★★ HALF THE ANSWERS ARE REFUSALS. A scan measured only on what it FINDS
 *    scores best by linking everything to everything, which welds a cast
 *    together silently. Every MUST_FIND below is paid for by a MUST_REFUSE
 *    built from the same surface shape in the same prose.
 *
 * ★ THE CAST IS DELIBERATELY INCOMPLETE, the way a real writer's is. Tomas
 *   Okonkwo appears in the chapter as "Mr. Okonkwo" and is NOT in the cast —
 *   which is exactly the condition that makes a bare-surname link to Nadia look
 *   safe, and exactly the condition the family veto exists for.
 *
 * This file is the single source for both the gate (scripts/test-alias-scan.ts)
 * and the copy the writer pastes into the app. If they ever diverge, the gate
 * is measuring something nobody can reproduce.
 */

export const CHAPTER_TITLE = "Chapter Nine: The Ash Road";

export const CHAPTER = `The fire had been out since midnight, but the smell of it stayed in the walls. Elena Vasquez sat with her back to the cold stove and counted what was left in the tin, and then counted it again because the first answer had not improved anything.

Kestrel came in from the yard with ash on both sleeves and did not bother to knock the worst of it off before she sat down.

"You are going to get us both killed, Kes," Elena said, without looking up. "You know that."

"So don't come," Kestrel said. "It is a long walk and I would rather do it without the lecture."

Elena set the tin down. "It isn't a lecture. It is arithmetic. There are four of us and one road."

"Kes," Elena said again, and this time Kestrel looked at her properly, and neither of them said anything for a while after that.

Kestrel went out again before the light came, and Elena let her go, and by the time the sun was over the ridge there was ash in the gutters and nobody in the yard at all.

The muster list at Fen Cross had four names on it and three of them were wrong. Captain Vale read it twice anyway, because Captain Vale read everything twice, and because a man who signs a bad list owns it afterwards.

Nadia Okonkwo leaned over his shoulder without being asked. "Mr. Okonkwo has already signed," she said. "You are the only one holding it up now."

Corin Vale did not sign. The clerk had written Corin Vale in a hand nobody could read, and the ink had gone through the paper, and he thought about that longer than the name deserved.

Then Vale asked the question the clerk had been dreading all morning.

"Who told you there were four?"

"Sparrow," Nadia Okonkwo said, and Elena was still standing in the doorway with her coat on, so it was not clear who she meant it for. "You have gone very quiet on me."

"I am always quiet before a run," Corin Vale said, and folded the list into his coat pocket, and did not look at Elena at all.

Miss Okonkwo signed for both of them in the end, the way Miss Okonkwo always did, and then the clerk stamped it and the thing was done.

Then Vale put his hand flat on the table. "One road," he said. "Say it back to me."

They went out past the post office, where a notice had been up long enough to curl at the corners. It named her in full — Elena Vasquez, known as the Ash Marshal, of no fixed parish — and offered forty marks to anyone who could say where she slept.

Elena read it without stopping. She had been the Ash Marshal for nine years and she had never once been asked to be anything else, and it had stopped being a name somewhere around the fourth year.

"Sparrow," Nadia Okonkwo said again at the gate, and Elena kept walking, and Corin Vale stopped. "You will want the short way."

Sparrow and Kestrel went ahead to the ridge to see what the weather was doing, and the rest of them followed at the pace of the slowest cart, and then the road turned and the wind came off the burn and after that nobody talked much at all.`;

/** What the writer already has in World Data when they press the button. */
export const CAST = [
  { name: "Elena", aliases: [] as string[] },
  { name: "Vale", aliases: [] as string[] },
  { name: "Kestrel", aliases: [] as string[] },
  { name: "Nadia Okonkwo", aliases: [] as string[] },
];

/**
 * What the entity scan would hand in alongside — recurring Title-Case forms it
 * extracted on its own. "Okonkwo" is here because that is how it reaches the
 * proposer in the app, and the family veto has to meet it.
 */
export const EXTRA_CANDIDATES = ["Okonkwo", "Fen Cross"];

export interface Expectation {
  character: string;
  alias: string;
  /** Which layer owes this row. */
  source: string;
  why: string;
}

/** Rows the scan must produce. */
export const MUST_FIND: Expectation[] = [
  { character: "Elena", alias: "Elena Vasquez", source: "adjacent-right",
    why: "the surname is absorbed from the right of a known name" },
  { character: "Elena", alias: "Vasquez", source: "adjacent-right",
    why: "…and the bare surname too — it never once stands alone in this chapter, " +
         "so no frequency-based extractor could ever have offered it" },
  { character: "Elena", alias: "Ash Marshal", source: "attested",
    why: "★ the indirect one: shares not a letter with the canonical name, and " +
         "the text declares it — “known as the Ash Marshal”" },
  { character: "Vale", alias: "Corin Vale", source: "adjacent-left",
    why: "the given name is absorbed from the left" },
  { character: "Vale", alias: "Corin", source: "adjacent-left",
    why: "…and on its own" },
  { character: "Vale", alias: "Captain Vale", source: "titled",
    why: "a rank to the left is a title, not a given name" },
  { character: "Kestrel", alias: "Kes", source: "vocative",
    why: "★ the speech-act one: spoken only inside dialogue, to the one person " +
         "present who is not talking. Morphology cannot reach it — a 3-letter " +
         "stem is below the hypocorism floor, by design" },
];

/**
 * Rows the scan must NOT produce, each carrying the surface shape of a row it
 * must. The veto named is the one that should fire; a different veto firing is
 * still a pass, and the gate says so.
 */
export const MUST_REFUSE: Array<{ alias: string; veto: string; why: string }> = [
  { alias: "Then", veto: "common-word",
    why: "★ “Then Vale asked…” twice is the identical shape to “Corin Vale did…” " +
         "twice. The ratio test is the only thing between them: lower-case " +
         "“then” outnumbers the capital in this chapter, and “Corin” has no " +
         "lower-case twin at all" },
  { alias: "Okonkwo", veto: "shared-surname",
    why: "★ the Miss Darcy case. Nadia is in the cast and Tomas is not, so " +
         "uniqueness says the surname is safe — and it is not: the chapter " +
         "writes both “Mr. Okonkwo” and “Miss Okonkwo”, so the name belongs to " +
         "a family" },
  { alias: "Sparrow", veto: "ambiguous",
    why: "★ two people are present and not speaking, so the vocative does not " +
         "resolve itself. It must reach the writer as a question, not an answer" },
];

/**
 * Names that must not be attached to the wrong person even though the chapter
 * dangles them there.
 */
export const MUST_NOT_PAIR: Array<{ character: string; alias: string; why: string }> = [
  { character: "Kestrel", alias: "Sparrow",
    why: "“Sparrow and Kestrel went ahead” — coordination is proof of two people, " +
         "and it must beat every inference, including the model's" },
  { character: "Nadia Okonkwo", alias: "Sparrow",
    why: "she is the one SAYING it; a vocative names the addressee, never the speaker" },
];

/** The unresolved form that should reach the model layer, and its answer. */
export const MODEL_CASE = {
  alias: "Sparrow",
  answer: "Vale",
  why: "the turn that follows the vocative is Corin Vale answering to it. The " +
       "passage handed to the model must contain that reply, or the question " +
       "has no answer in it and the probe measures the harness",
};
