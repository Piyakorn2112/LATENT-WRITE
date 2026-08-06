/**
 * max-ask-golden.ts — an evaluation golden set for the max-ask feature,
 * built on a story that has never touched the tuning fixtures.
 *
 * A DIFFERENT WORLD ON PURPOSE. alias-stress-chapter.ts (Elena, Kestrel,
 * Vale, the Ash Road, Fen Cross, marshals, tins, notices) was used to TUNE
 * max-ask's prompts. Scoring the feature against that same world would be
 * circular — a prompt shaped by a fixture always looks good on it. This file
 * is a fresh harbor town, fresh cast, fresh object, so the 14 cases below
 * measure whether the harness generalises rather than whether it memorised.
 *
 * Every case is graded by a HUMAN reading the model's 2-3 sentence answer
 * against `expectDirection` / `mustTouch` / `mustNotClaim` / `expectedSource`
 * — never by exact string match. See GoldenCase below.
 */
import type { MaxAskInput } from "../../src/lib/max-ask";

// ── the story ────────────────────────────────────────────────────────────
//
// Salt Cairn, a fishing town. Solvei Vey ran the salvage boat Petrel until
// she drowned off the point in a spring storm. Her niece Mara has taken the
// boat over and is working through Solvei's oilskin logbook page by page.
// STRAINED RELATIONSHIP: Mara and her half-brother Teo, who wants to sell
// the boat and blames her, unspoken, for not raising the alarm sooner.
// THE OBJECT: Solvei's logbook — and specifically a page cut out of it,
// dated six weeks before she died. THE SECRET: Solvei quietly sold half her
// share of the Petrel to the moneylender Renner to pay for a new engine,
// and told neither of them.

const CHAPTER_NUMBER = 7;
const CHAPTER_TITLE = "Low Water";

export const GOLDEN_WORLD = {
  characters: [
    { name: "Marisol Vey", aliases: ["Mara"], role: "Skipper of the Petrel",
      description: "Runs the boat since her aunt died. Keeps the ledger to the penny and says little." },
    { name: "Teodor Vey", aliases: ["Teo"], role: "Deckhand, Mara's half-brother",
      description: "Wants to sell the boat and leave Salt Cairn. Owes money he has not named." },
    { name: "Priya Nandan", aliases: ["Pri"], role: "Deckhand",
      description: "Has crewed the Petrel three seasons. Was not aboard the night Solvei went missing." },
    { name: "Costas Renner", aliases: ["old Renner", "Renner"], role: "Harbor moneylender and net dealer",
      description: "Holds paper on half the boats in Salt Cairn. Never raises his voice." },
    { name: "Solvei Vey", aliases: ["Aunt Solvei", "the old skipper"], role: "Former skipper of the Petrel, deceased",
      description: "Drowned off the point in a spring storm. Kept a logbook nobody has read in full." },
  ],
  places: [],
  factions: [],
  entities: [],
};

const SUMMARIES = [
  { chapterNumber: 4, summary: "Solvei Vey drowned off the point during a spring storm, and Mara found the "
    + "Petrel empty at the mooring the next morning; no one admits to having seen Solvei go out that night." },
  { chapterNumber: 5, summary: "Mara took over as skipper and began going through Solvei's logbook page by "
    + "page, trying to find what the old skipper never told her." },
  { chapterNumber: 6, summary: "Teo told Mara he wanted to sell the Petrel and leave Salt Cairn, and Mara "
    + "said she would not discuss it until the logbook was finished." },
];

const THREADS = [
  { chapterNumber: 3, text: "Priya has said only that she was not aboard the night of the storm; she has "
    + "never said what, if anything, she saw from shore." },
  { chapterNumber: 5, text: "The mooring key that should hang by the wheelhouse door has been missing "
    + "since before Solvei died, and no one has explained why." },
];

const RELATED = [
  { chapterNumber: 2, text: "Solvei once told Mara the Petrel would go to whoever loved it enough to keep "
    + "the log honest, and Mara had not known yet what that would cost her." },
  { chapterNumber: 4, text: "Renner told the harbourmaster he held paper on three boats in Salt Cairn and "
    + "would not say which three." },
];

// ── the chapter, engine-split (each paragraph under 70 words) ──────────────

export const GOLDEN_CHAPTER: string[] = [
  // 0 — quiet: setting, the logbook, low water
  `The tide was out past the last mooring post, and the flats gave off the smell they always gave off after a storm, salt and rot together. Mara sat on the stern locker with Solvei's logbook open on her knees and read the same entry a third time, because the words did not change no matter how long she looked at them.`,
  // 1 — Teo arrives
  `Teo came down the ladder two rungs at a time and dropped onto the deck with the weight of someone who had already decided what he was going to say. He did not look at the logbook. He never looked at the logbook.`,
  // 2 — dialogue-heavy: the central conflict
  `"You could sell it tomorrow," Teo said. "Renner would take it off your hands before noon and neither of us would have to look at that mudflat again." "It isn't mine to sell," Mara said. "It's ours. Aunt Solvei left it to both of us." "She left me a debt and you a boat," Teo said. "I know which one I got."`,
  // 3 — quiet/transitional: Priya arrives, stays out of it
  `Priya came aboard an hour later with a coil of new net over one shoulder and said nothing about the raised voices, because they had carried clean across the anchorage and there was no pretending otherwise. She set the net down by the winch and started splicing without being asked.`,
  // 4 — revealing: the torn page
  `Mara turned to the page dated six weeks before the storm and found what she always found there: a ragged edge where a page had been cut close to the spine, not torn by accident. Someone had wanted that entry gone, and the only person who could have wanted it gone was the one who wrote it.`,
  // 5 — dialogue: Renner at the dock
  `Old Renner was on the dock when they came in, which was not unusual, except that he had never once come down to the water for a boat that was not already his. "I only want what your aunt signed," he said, not unkindly. "Ask your brother what he thinks that's worth."`,
  // 6 — quiet: Mara alone with it
  `Mara did not answer him. She had spent three weeks deciding whether Renner was lying about a paper nobody had shown her, and she still did not know, and the not knowing sat in her chest like ballast she could not shift.`,
  // 7 — dialogue: Teo admits he knew
  `"What paper," Mara said, once Renner had gone. Teo would not meet her eyes. "The engine," he said finally. "Someone had to pay for it, Mara, and it wasn't going to be me." "So you knew," she said. "I knew there was a paper," he said. "I didn't know what she signed."`,
  // 8 — quiet: closing image
  `Neither of them said anything else that evening. Priya finished the splice and coiled the net without being asked to, and the tide came back in over the flats the way it always did, indifferent to all of it, and covered the mud again by morning.`,
];

/** Two paragraphs, hand-authored to CONTRADICT the story, used only by the
 *  two planted-contradiction check cases. Each swaps ONE index of the
 *  chapter; the shared GOLDEN_CHAPTER above is untouched by both. */
const CONTRA_VS_SUMMARY =
  `Mara did not answer him. She kept thinking about that evening instead: how she had stood on the `
  + `dock and watched Solvei untie the lines herself, and waved once before her aunt rowed out alone `
  + `into the fog, same as always.`;
const CONTRA_VS_THREAD =
  `Mara reached past the wheelhouse door for the mooring key out of old habit, and her hand closed `
  + `on it at once, right where it always hung, ordinary and a little rusted, as if nothing about `
  + `that week had been strange at all.`;

const withParagraph = (index: number, text: string): string[] => {
  const out = [...GOLDEN_CHAPTER];
  out[index] = text;
  return out;
};

/** Fields every case shares; each case spreads this and overrides the rest. */
const BASE = {
  chapterNumber: CHAPTER_NUMBER,
  chapterTitle: CHAPTER_TITLE,
  chapterParagraphs: GOLDEN_CHAPTER,
  worldData: GOLDEN_WORLD,
  chapterSummaries: SUMMARIES,
  openThreads: THREADS,
  related: RELATED,
};

// ── the case shape ──────────────────────────────────────────────────────

export interface GoldenCase {
  id: string;
  input: MaxAskInput;
  /** One sentence: the DIRECTION a correct answer goes. */
  expectDirection: string;
  /** Words/facts a right answer will almost certainly touch (2-4 items, lowercase). */
  mustTouch: string[];
  /** Claims that would make the answer WRONG (invented facts, confirmed false premise). */
  mustNotClaim: string[];
  /** Which pack sections the answer should draw from. Or ["abstain"] when abstention is correct. */
  expectedSource: string[];
}

// ── the 14 cases ────────────────────────────────────────────────────────

export const GOLDEN_CASES: GoldenCase[] = [
  // ── explain x3 ──────────────────────────────────────────────────────────
  {
    id: "explain-dialogue",
    input: { ...BASE, paragraph: GOLDEN_CHAPTER[2], paragraphIndex: 2, kind: "explain",
      present: ["Marisol Vey", "Teodor Vey"] },
    expectDirection: "explains this exchange lays out the central conflict: Teo wants to sell the "
      + "Petrel, Mara insists it is a shared inheritance, and neither one budges.",
    mustTouch: ["sell", "teo", "mara", "boat"],
    mustNotClaim: ["that mara agrees to sell", "that renner is part of this exchange"],
    expectedSource: ["passage"],
  },
  {
    id: "explain-quiet",
    input: { ...BASE, paragraph: GOLDEN_CHAPTER[3], paragraphIndex: 3, kind: "explain",
      present: ["Priya Nandan", "Marisol Vey"] },
    expectDirection: "explains this beat shows Priya deliberately staying out of the argument while "
      + "signalling that the tension between Mara and Teo is no longer private.",
    mustTouch: ["priya", "net", "raised voices"],
    mustNotClaim: ["that priya takes a side", "that priya confronts mara or teo directly"],
    expectedSource: ["passage"],
  },
  {
    id: "explain-reveal",
    input: { ...BASE, paragraph: GOLDEN_CHAPTER[4], paragraphIndex: 4, kind: "explain",
      present: ["Marisol Vey"] },
    expectDirection: "explains this paragraph plants the mystery of a deliberately removed logbook "
      + "page, implying Solvei hid something on purpose.",
    mustTouch: ["torn", "logbook", "six weeks"],
    mustNotClaim: ["that it names who cut out the page", "that it confirms renner removed it"],
    expectedSource: ["passage"],
  },

  // ── check x3 ────────────────────────────────────────────────────────────
  {
    id: "check-contradicts-summary",
    input: { ...BASE, paragraph: CONTRA_VS_SUMMARY, paragraphIndex: 6, kind: "check",
      chapterParagraphs: withParagraph(6, CONTRA_VS_SUMMARY), present: ["Marisol Vey"] },
    expectDirection: "flags the contradiction: this paragraph has Mara herself saying she watched "
      + "Solvei row out, but chapter 4's summary says no one admits to seeing Solvei go out that night.",
    mustTouch: ["solvei", "saw her leave", "no one saw"],
    mustNotClaim: ["that the paragraph fits with nothing wrong", "that this proves someone else caused solvei's death"],
    expectedSource: ["story-so-far"],
  },
  {
    id: "check-control",
    input: { ...BASE, paragraph: GOLDEN_CHAPTER[8], paragraphIndex: 8, kind: "check",
      present: ["Marisol Vey", "Teodor Vey", "Priya Nandan"] },
    expectDirection: "finds no conflict; the tide returning and the evening ending quietly fits "
      + "everything established so far, and the paragraph should be said to fit.",
    mustTouch: ["tide", "fits"],
    mustNotClaim: ["that this contradicts the mooring-key thread", "that this contradicts solvei's death"],
    expectedSource: ["passage"],
  },
  {
    id: "check-contradicts-thread",
    input: { ...BASE, paragraph: CONTRA_VS_THREAD, paragraphIndex: 3, kind: "check",
      chapterParagraphs: withParagraph(3, CONTRA_VS_THREAD), present: ["Marisol Vey"] },
    expectDirection: "flags the contradiction: the mooring key is here hanging in its usual place, but "
      + "the open thread says it has been missing since before Solvei died.",
    mustTouch: ["mooring key", "missing", "wheelhouse"],
    mustNotClaim: ["that the paragraph fits with nothing wrong", "that teo moved the key"],
    expectedSource: ["open-threads"],
  },

  // ── suggest x3, rising tension ─────────────────────────────────────────
  {
    id: "suggest-low",
    input: { ...BASE, paragraph: GOLDEN_CHAPTER[3], paragraphIndex: 3, kind: "suggest",
      present: ["Priya Nandan", "Marisol Vey"] },
    expectDirection: "suggests a modest next beat: Priya keeps working and eventually asks Mara "
      + "directly what is going on, rather than any dramatic turn.",
    mustTouch: ["priya", "ask", "net"],
    mustNotClaim: ["that priya reveals she works for renner", "that priya quits the boat"],
    expectedSource: ["passage", "neighbours"],
  },
  {
    id: "suggest-mid",
    input: { ...BASE, paragraph: GOLDEN_CHAPTER[5], paragraphIndex: 5, kind: "suggest",
      present: ["Marisol Vey", "Teodor Vey", "Costas Renner"] },
    expectDirection: "suggests Mara presses Teo or Renner for proof of the paper, since Renner's claim "
      + "now has to be answered rather than ignored.",
    mustTouch: ["renner", "paper", "teo"],
    mustNotClaim: ["that renner already produced the signed paper", "that the boat is sold"],
    expectedSource: ["passage", "neighbours"],
  },
  {
    id: "suggest-high",
    input: { ...BASE, paragraph: GOLDEN_CHAPTER[7], paragraphIndex: 7, kind: "suggest",
      present: ["Marisol Vey", "Teodor Vey"] },
    expectDirection: "suggests the admission pushes toward a harder confrontation: Mara demanding to "
      + "see exactly what Solvei signed, with trust between the siblings further damaged.",
    mustTouch: ["teo", "paper", "mara"],
    mustNotClaim: ["that teo already sold the boat", "that priya leaves the crew"],
    expectedSource: ["passage", "neighbours"],
  },

  // ── question x5 ─────────────────────────────────────────────────────────
  {
    id: "question-from-summary",
    input: { ...BASE, paragraph: GOLDEN_CHAPTER[0], paragraphIndex: 0, kind: "question",
      question: "How did Mara end up running the Petrel instead of Solvei?",
      present: ["Marisol Vey"] },
    expectDirection: "answers from the story-so-far: Solvei drowned in a spring storm and Mara took "
      + "over as skipper afterward.",
    mustTouch: ["solvei", "storm", "mara took over"],
    mustNotClaim: ["that teo was named skipper", "that renner appointed mara"],
    expectedSource: ["story-so-far"],
  },
  {
    id: "question-from-related",
    input: { ...BASE, paragraph: GOLDEN_CHAPTER[4], paragraphIndex: 4, kind: "question",
      question: "Did Solvei ever say who she wanted the Petrel to go to?",
      present: ["Marisol Vey"] },
    expectDirection: "answers from the related passage: Solvei once said the boat should go to "
      + "whoever loved it enough to keep the log honest.",
    mustTouch: ["solvei", "log honest", "whoever loved it"],
    mustNotClaim: ["that it was written into a formal will", "that solvei named teo specifically"],
    expectedSource: ["related"],
  },
  {
    id: "question-unanswerable",
    input: { ...BASE, paragraph: GOLDEN_CHAPTER[5], paragraphIndex: 5, kind: "question",
      question: "What does Renner do with the money once boat owners pay him back?",
      present: ["Marisol Vey", "Teodor Vey", "Costas Renner"] },
    expectDirection: "abstains — nothing in any section says what Renner does with money once it is "
      + "repaid.",
    mustTouch: ["renner", "repaid"],
    mustNotClaim: ["that he reinvests in more boats", "that he is corrupt or stealing from the harbour"],
    expectedSource: ["abstain"],
  },
  {
    id: "question-false-premise",
    input: { ...BASE, paragraph: GOLDEN_CHAPTER[2], paragraphIndex: 2, kind: "question",
      question: "Why did Teo sell his share of the Petrel to Renner last spring?",
      present: ["Marisol Vey", "Teodor Vey"] },
    expectDirection: "corrects the false premise — Teo has not sold anything; it is Solvei's alleged "
      + "sale to Renner that is in question — or abstains. Must not answer as if Teo's sale happened.",
    mustTouch: ["teo", "renner"],
    mustNotClaim: ["that teo sold his share of the boat", "a reason for a sale that never happened"],
    expectedSource: ["passage", "abstain"],
  },
  {
    id: "question-detail-lookup",
    input: { ...BASE, paragraph: GOLDEN_CHAPTER[3], paragraphIndex: 3, kind: "question",
      question: "What is Priya carrying when she comes aboard?",
      present: ["Priya Nandan", "Marisol Vey"] },
    expectDirection: "answers directly from the passage: a coil of new net.",
    mustTouch: ["net", "coil"],
    mustNotClaim: ["that she is carrying rope or tools instead", "that she brings the logbook"],
    expectedSource: ["passage"],
  },
];
