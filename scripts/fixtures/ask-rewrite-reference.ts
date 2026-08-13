/**
 * ask-rewrite-reference.ts — the reference set for the ask + rewrite
 * surfaces: fixed inputs, and for each a GOLDEN output written by a
 * high-capacity model (Claude) against EXACTLY the evidence the local
 * model sees — the quality ceiling the local system is compared to.
 *
 * ★ THE GOLDEN OBEYS THE LOCAL RULES. Every golden ask answer uses only
 *   what its pack contains and cites a real rung; every golden rewrite
 *   preserves meaning and the writer's voice. A reference the local model
 *   could not legally produce would measure nothing.
 *
 * ★ KEYS MAKE THE COMPARISON MECHANICAL. `keys` = content any good answer
 *   must touch (any-match, lowercase); `antiKeys` = content that marks a
 *   failure (invention, a missed correction, advice-speak). The reading
 *   still decides; the keys rank.
 *
 * ★ THIS SET IS FOR ITERATION. The frozen max-ask golden
 *   (max-ask-golden.ts) stays a one-shot; prompts may be iterated against
 *   THIS file, never against that one.
 */

// ── World H: "Harrow Lane" — literary register, planted facts ─────────────

const H_WORLD = {
  characters: [
    { name: "Ede", role: "the bonesetter", description: "Sets bones for the three villages. Widowed twice; says the second time taught her nothing the first had not." },
    { name: "Tam", role: "her apprentice", description: "Seventeen. Writes everything down in a ledger Ede pretends not to read." },
    { name: "Corwin", role: "the miller", description: "Owes Ede for a set arm. Has not paid in two winters." },
  ],
  places: [], factions: [], entities: [],
};

const H_SUMMARIES = [
  { chapterNumber: 3, summary: "Ede sets Corwin's arm and refuses his note of credit; she tells Tam a debt written down is a debt argued later." },
  { chapterNumber: 4, summary: "Tam begins recording Ede's remedies in his ledger against her wishes." },
  { chapterNumber: 5, summary: "The mill floods; Corwin loses the winter grain and his stores." },
];

const H_THREADS = [
  { chapterNumber: 4, text: "Ede has never told Tam what happened to her first husband, only that the road he took is grown over now." },
];

const H_RELATED = [
  { chapterNumber: 3, text: "Ede took payment in eggs, in thatch-work, in a winter of split wood — anything, Tam noticed, except a promise." },
];

const H_PARA_CLEAN =
  "Ede wrapped the wrist without hurry, the way she did everything that mattered. " +
  "Tam held the splint boards and did not ask why she had gone quiet, and when Corwin " +
  "began his apology about the money she stopped him with a look that cost him nothing and " +
  "settled everything. Payment could wait until the mill was dry.";

const H_PARA_CONTRA =
  "Ede took Corwin's written note of credit and folded it into her apron without reading it. " +
  "Paper was as good as eggs, she said; a promise held its shape better than thatch. " +
  "Tam wrote the sum in his ledger while she watched, nodding.";

const H_NEIGHBOURS = [
  "The mill yard still smelled of river mud, and the grain that could not be saved had been carted out to the pigs by noon.",
  "Corwin met them at the door with his arm out of the sling, which was its own kind of apology.",
];

const askInput = (
  world: "H",
  paragraph: string,
  kind: string,
  question?: string,
) => ({
  paragraph,
  paragraphIndex: 4,
  chapterNumber: 6,
  chapterTitle: "After the Flood",
  kind,
  question,
  chapterParagraphs: ["", "", H_NEIGHBOURS[0], H_NEIGHBOURS[1], paragraph, ""],
  present: ["Ede", "Tam", "Corwin"],
  worldData: H_WORLD,
  chapterSummaries: H_SUMMARIES,
  openThreads: H_THREADS,
  related: H_RELATED,
});

export interface AskCase {
  id: string;
  input: ReturnType<typeof askInput>;
  budget?: number;
  golden: { answer: string; basis: string };
  keys: string[];
  antiKeys: string[];
  note: string;
}

export const ASK_CASES: AskCase[] = [
  {
    id: "H-explain-clean",
    input: askInput("H", H_PARA_CLEAN, "explain"),
    golden: {
      answer:
        "It settles the debt question without settling the debt: Ede silences Corwin's apology " +
        "and defers payment until the mill is dry, which keeps her chapter 3 refusal of written " +
        "credit intact while the flood has made collecting impossible. It also shows Tam reading " +
        "her silence instead of questioning it, the apprentice learning her terms.",
      basis: "story-so-far",
    },
    keys: ["debt", "flood", "defer", "wait", "silence", "apolog"],
    antiKeys: ["foreshadow", "the author", "the reader", "consider adding"],
    note: "The work of the paragraph, tied to the established credit refusal and the flood.",
  },
  {
    id: "H-check-contra",
    input: askInput("H", H_PARA_CONTRA, "check"),
    golden: {
      answer:
        "This conflicts with what chapter 3 establishes: Ede refused Corwin's note of credit and " +
        "told Tam a debt written down is a debt argued later, and earlier she took any payment " +
        "except a promise. Here she accepts the written note approvingly and calls paper as good " +
        "as eggs, with no sign anything changed her mind.",
      basis: "story-so-far",
    },
    keys: ["conflict", "chapter 3", "refus", "note", "credit", "promise"],
    antiKeys: ["fits", "no conflict"],
    note: "The planted contradiction: written credit accepted vs refused.",
  },
  {
    id: "H-check-clean",
    input: askInput("H", H_PARA_CLEAN, "check"),
    golden: {
      answer:
        "Nothing here conflicts with what the story has established. Deferring payment while the " +
        "mill dries is consistent with Ede refusing written credit but taking real payment in her " +
        "own time, and Tam's quiet watching fits his habit of recording rather than asking.",
      basis: "fits",
    },
    keys: ["fits", "consistent", "no conflict", "nothing here conflicts"],
    antiKeys: ["conflict with chapter", "contradic"],
    note: "The control: clean prose must get a clean bill, no invented problem.",
  },
  {
    id: "H-suggest-clean",
    input: askInput("H", H_PARA_CLEAN, "suggest"),
    golden: {
      answer:
        "The unpaid debt now has no visible end: the flood took Corwin's grain and stores, so " +
        "what he pays with, and when, is open. Tam's ledger habit could surface the sum Ede " +
        "never wrote down, and the still-open question of her first husband's road is available " +
        "whenever her quiet turns into an answer.",
      basis: "story-so-far",
    },
    keys: ["ledger", "grain", "debt", "husband", "pay"],
    antiKeys: ["you could", "the author should", "readers"],
    note: "Grounded continuations from established threads, not generic advice.",
  },
  {
    id: "H-question-causal",
    input: askInput(
      "H", H_PARA_CLEAN, "question",
      "Why does Ede stop Corwin's apology instead of letting him finish, and what does it cost her?",
    ),
    golden: {
      answer:
        "Stopping him keeps the debt off paper and out of words: an apology about money is the " +
        "start of the promise she never accepts, and after the flood pressing him would collect " +
        "nothing anyway. The look costs Corwin nothing and settles everything, so what it costs " +
        "Ede is the payment itself, deferred until the mill is dry with no note to enforce it.",
      basis: "passage",
    },
    keys: ["promise", "defer", "flood", "cost", "paper"],
    antiKeys: [],
    note: "Causal + two entities: the shape that currently triggers the 1024-token think pass.",
  },
  {
    id: "H-question-lookup",
    input: askInput("H", H_PARA_CLEAN, "question", "Who is Tam?"),
    golden: {
      answer:
        "Tam is Ede's seventeen-year-old apprentice, who writes everything down in a ledger she " +
        "pretends not to read. In this scene he holds the splint boards and reads her silence " +
        "rather than questioning it.",
      basis: "who",
    },
    keys: ["apprentice", "ledger", "seventeen"],
    antiKeys: [],
    note: "A bare lookup; must stay fast (no think pass).",
  },
  {
    id: "H-question-absent",
    input: askInput("H", H_PARA_CLEAN, "question", "What happened to Ede's second husband?"),
    golden: {
      answer:
        "That is not in what I was given. The story has established only that Ede was widowed " +
        "twice and has never told Tam what happened to her first husband; the second is not " +
        "explained anywhere in these sections.",
      basis: "not-in-what-i-was-given",
    },
    keys: ["not"],
    antiKeys: ["died of", "was killed by", "illness", "accident"],
    note: "Honest abstention: the fact genuinely is not in the pack.",
  },
];

// ── Rewrite cases: real-register paragraphs, planted flaws where mechanical ──

export interface RewriteCase {
  id: string;
  op: "proofread" | "rewrite" | "custom";
  instruction?: string;
  text: string;
  before: string;
  golden: string;
  /** Corrections/changes any good result must make (substring, lowercase). */
  keys: string[];
  /** Content that must survive unchanged (meaning anchors). */
  mustKeep: string[];
  /** Marks of failure: uncorrected flaws or invented content. */
  antiKeys: string[];
  note: string;
}

export const REWRITE_CASES: RewriteCase[] = [
  {
    id: "proof-typos",
    op: "proofread",
    before: "The kitchen had gone quiet after the argument.",
    text:
      "She poured the tea carefull, watching the leafs settle in the pot. It wasnt that she " +
      "regreted the words, exactly — it was that she could not rember which of them had said " +
      "the worst one first, her or him.",
    golden:
      "She poured the tea carefully, watching the leaves settle in the pot. It wasn't that she " +
      "regretted the words, exactly — it was that she could not remember which of them had said " +
      "the worst one first, her or him.",
    keys: ["carefully", "leaves", "wasn't", "regretted", "remember"],
    mustKeep: ["poured the tea", "worst one first", "her or him"],
    antiKeys: ["carefull,", "leafs", "wasnt", "regreted", "rember"],
    note: "Five planted errors; a proofread fixes all five and changes nothing else.",
  },
  {
    id: "proof-clean",
    op: "proofread",
    before: "",
    text:
      "The letter sat on the table for three days before she opened it. By then the news inside " +
      "was older than the argument that had stopped her, and neither had improved with keeping.",
    golden:
      "The letter sat on the table for three days before she opened it. By then the news inside " +
      "was older than the argument that had stopped her, and neither had improved with keeping.",
    keys: [],
    mustKeep: ["three days", "older than the argument", "improved with keeping"],
    antiKeys: [],
    note: "Clean prose: the correct proofread is UNCHANGED. Touching it is the failure.",
  },
  {
    id: "rewrite-flat",
    op: "rewrite",
    before: "The harvest was done and the carts were gone.",
    text:
      "Gareth walked to the field. He looked at the rows. The rows were empty now. He thought " +
      "about the summer. The summer had been long. He turned around and walked back to the house.",
    golden:
      "Gareth walked out to the field and stood looking at the rows, empty now. The summer had " +
      "been long. He turned and walked back to the house.",
    keys: [],
    mustKeep: ["field", "rows", "empty", "summer", "house"],
    antiKeys: ["golden light", "he remembered when", "tears", "heart"],
    note: "Choppy telegraphic prose smoothed WITHOUT adding invented sentiment or imagery.",
  },
  {
    id: "custom-tense",
    op: "custom",
    instruction: "put this in past tense",
    before: "",
    text:
      "Kinoko counts the jars twice and writes nothing down. The kitchen keeps its own record: " +
      "what is missing announces itself at supper, and what is doubled nobody complains about.",
    golden:
      "Kinoko counted the jars twice and wrote nothing down. The kitchen kept its own record: " +
      "what was missing announced itself at supper, and what was doubled nobody complained about.",
    keys: ["counted", "wrote", "kept", "announced", "complained"],
    mustKeep: ["jars", "supper", "nobody"],
    antiKeys: ["counts", "writes", "keeps its own record"],
    note: "Mechanical tense shift, meaning and rhythm intact.",
  },
  {
    id: "custom-tighten",
    op: "custom",
    instruction: "make this about half as long without losing what happens",
    before: "The road crew had been at it since first light.",
    text:
      "Vey stood at the window for a long moment, watching the men work on the road below, and " +
      "she found herself thinking, as she often did at moments like this one, that there was " +
      "something in the way a person did a small job that told you more or less everything you " +
      "would ever really need to know about how they would handle a large one, if a large one " +
      "ever happened to come along and find them.",
    golden:
      "Vey stood at the window, watching the men work on the road below, thinking that the way " +
      "a person did a small job told you everything about how they would handle a large one.",
    keys: [],
    mustKeep: ["window", "road", "small job", "large one"],
    antiKeys: ["if a large one ever happened to come along and find them"],
    note: "Length instruction: roughly half, the observation kept, the padding gone.",
  },
  {
    id: "custom-voice",
    op: "custom",
    instruction: "make the narration colder, more clinical, no similes",
    before: "",
    text:
      "The infirmary smelled like a storm about to break, all metal and waiting. Ha-eun moved " +
      "between the beds like a dancer who had forgotten the music, checking each chart with " +
      "hands that trembled like leaves.",
    golden:
      "The infirmary smelled of metal and antiseptic. Ha-eun moved between the beds in a fixed " +
      "order, checking each chart. Her hands trembled.",
    keys: ["metal"],
    mustKeep: ["infirmary", "beds", "chart", "trembl"],
    antiKeys: ["like a", "storm about to break", "dancer", "leaves"],
    note: "All three similes must go; the facts (route, charts, tremor) must stay.",
  },

  // ── HARD customs: the long multi-part instructions the owner expects to
  //    be the frequent real-world shape. These are what the thinking A/B
  //    is judged on: each demands decomposing the instruction, deciding
  //    what is affected and what must survive, and executing all parts.

  {
    id: "hard-multipart",
    op: "custom",
    instruction:
      "make the narration more tense and clipped, but leave both lines of dialogue " +
      "exactly as they are, and end the paragraph on the image of the unlit lamp",
    before: "The knock had come twice already that evening.",
    text:
      "Vey crossed the room without any particular hurry and looked out at the yard, where " +
      "the gate stood open in a way that it should not have been. \"Who left it like that?\" " +
      "she asked. Kinoko shrugged from the doorway, comfortable and unbothered. \"It was like " +
      "that at supper,\" she said. The lamp by the window was unlit, and the room settled " +
      "into a pleasant evening dimness around the two of them.",
    golden:
      "Vey crossed the room fast. The yard: the gate stood open. It should not have been. " +
      "\"Who left it like that?\" she asked. Kinoko shrugged from the doorway. \"It was like " +
      "that at supper,\" she said. The room dimmed around the two of them. By the window, " +
      "the lamp, unlit.",
    keys: [],
    mustKeep: [
      "Who left it like that?", "It was like that at supper",
      "gate", "doorway",
    ],
    antiKeys: ["pleasant", "without any particular hurry", "comfortable and unbothered"],
    note:
      "Three constraints at once: tense narration (the leisurely phrasing must go), " +
      "dialogue verbatim (both quotes byte-identical), lamp image LAST. The failure " +
      "modes are editing the dialogue or burying the lamp mid-paragraph.",
  },
  {
    id: "hard-longpass",
    op: "custom",
    instruction:
      "cut this to about two thirds of its length, keep all three stops on the walk " +
      "in order (forge, well, notice board) and keep the last sentence exactly as it is",
    before: "Market day emptied the lane by noon.",
    text:
      "Gareth took the long way through the village because the long way was the one that " +
      "told him things. At the forge he stopped and listened to the ring of the hammer, which " +
      "was steady and unhurried, which meant the work was ordinary and nobody had broken an " +
      "axle or thrown a shoe that morning. At the well he stopped again and read the queue, " +
      "four women and a boy, none of them from the far cottages, which meant the far lane was " +
      "busy with something that kept people home. At the notice board he stopped a third time " +
      "and found nothing new pinned under the old harvest notice, which he had expected, " +
      "because news that mattered in the valley never travelled by paper. He walked home the " +
      "short way. The village had told him what it always told him: nothing, three times, in " +
      "the right order.",
    golden:
      "Gareth took the long way because the long way told him things. At the forge, the " +
      "hammer rang steady: ordinary work, no broken axle, no thrown shoe. At the well, the " +
      "queue was four women and a boy, none from the far cottages, so the far lane was busy " +
      "with something that kept people home. At the notice board, nothing new under the old " +
      "harvest notice, as he had expected. He walked home the short way. The village had told " +
      "him what it always told him: nothing, three times, in the right order.",
    keys: ["forge", "well", "notice board"],
    mustKeep: [
      "nothing, three times, in the right order",
      "forge", "well", "notice board", "harvest notice",
    ],
    antiKeys: ["which was steady and unhurried, which meant"],
    note:
      "Long passage, ordered structure, a protected final sentence, and a length " +
      "target. Failure modes: dropping a stop, reordering, or touching the last line.",
  },
  {
    id: "hard-priority",
    op: "custom",
    instruction:
      "tighten this a lot, but you must keep all three of the smells, the cold door " +
      "handle, and the sound of the kettle",
    before: "",
    text:
      "The kitchen, when she finally came down into it in the early morning before anyone " +
      "else in the house was awake or moving around, smelled of last night's bread and of " +
      "cold ash from the banked stove and, faintly, underneath everything else, of the " +
      "lavender her mother kept hanging in bunches from the beam. The door handle was cold " +
      "under her hand when she closed it behind her. Somewhere behind her the kettle began " +
      "its small climbing whine, and she stood still for a long moment listening to it climb.",
    golden:
      "The kitchen, before anyone else was awake, smelled of last night's bread, cold ash " +
      "from the banked stove, and faintly of her mother's lavender hanging from the beam. " +
      "The door handle was cold under her hand. Behind her the kettle began its small " +
      "climbing whine, and she stood listening to it climb.",
    keys: ["bread", "ash", "lavender", "handle", "kettle"],
    mustKeep: ["bread", "ash", "lavender", "cold", "handle", "kettle", "whine"],
    antiKeys: ["when she finally came down into it in the early morning"],
    note:
      "A compression with five protected details. The lazy cut drops a smell; the " +
      "test is whether tightening respects an explicit keep-list.",
  },
];
