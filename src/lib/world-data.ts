import type {
  AdaptiveCandidateOption,
  AdaptiveInferenceContext,
  AdaptivePredictionTrace,
  Novel,
  WorldData,
} from "../types";
import { rerankAdaptiveCandidates } from "./adaptive-inference";

// ── Types ──────────────────────────────────────────────────────────────────

export interface WorldEntity {
  name: string;
  type: "character" | "place" | "faction" | "entity";
  role?: string;
  description?: string;
}

interface EntityContextSignals {
  occurrences: number;
  charScore: number;
  placeScore: number;
  factScore: number;
  entityScore: number;
  /** Occurrences preceded by the/a/an. Never a bucket score — see FACTION_PREFIX_RE. */
  determinedCount: number;
  /**
   * ★ HOW MANY CONTEXT RULES FIRED, INDEPENDENT OF WHAT THEY ARE WORTH.
   *
   *   Retention asks "did the prose say anything at all about this name"; the
   *   buckets ask "what did it say". Mixing them means every reweighting
   *   silently changes which names survive — measured: dropping bare place
   *   prepositions from 1.25 to 0.5 (right, because "to Jane" is ambiguous)
   *   took Darkholm's context under the keep threshold and lost an invented
   *   place name that had four sightings, on a change that was never about
   *   retention.
   */
  signalHits: number;
  totalContext: number;
  previewBefore: string;
  previewAfter: string;
  isMultiWord: boolean;
  hasJoiner: boolean;
}

// ── Empty / construction helpers ───────────────────────────────────────────

export function emptyWorldData(): WorldData {
  return { characters: [], places: [], factions: [], entities: [] };
}

export function ensureWorldData(novel: Novel): WorldData {
  const wd = novel.worldData;
  if (!wd) return emptyWorldData();
  return {
    characters: wd.characters ?? [],
    places: wd.places ?? [],
    factions: wd.factions ?? [],
    entities: wd.entities ?? [],
  };
}

export function isWorldDataEmpty(wd: WorldData | undefined): boolean {
  if (!wd) return true;
  return (
    (wd.characters?.length ?? 0) === 0 &&
    (wd.places?.length ?? 0) === 0 &&
    (wd.factions?.length ?? 0) === 0 &&
    (wd.entities?.length ?? 0) === 0
  );
}

// ── Stop list — words that start sentences but aren't proper nouns ─────────
const STOPLIST = new Set([
  "The", "This", "That", "These", "Those", "There", "Then", "Than", "What",
  "When", "Where", "Why", "How", "Who", "Which", "He", "She", "It", "They",
  "We", "You", "His", "Her", "Its", "Their", "Our", "My", "Your", "Was", "Were",
  "Had", "Has", "Have", "Be", "Been", "Being", "Is", "Are", "Do", "Does",
  "Did", "Will", "Would", "Could", "Should", "May", "Might", "Must", "Can",
  "All", "Any", "Not", "No", "So", "As", "If", "But", "And", "Or", "For",
  "With", "From", "By", "At", "To", "In", "On", "Of", "Up", "Out",
  "About", "Into", "After", "Before", "Through", "Between", "Without",
  "Very", "Just", "More", "Most", "Also", "Still", "Even", "Now", "Back",
  "Each", "First", "Last", "Next", "Same", "Other", "New", "Old", "Such",
  "Only", "Both", "Over", "Down", "Here", "Again", "Much", "Many", "While",
  "During", "Once", "Every", "Never", "Always", "Already", "Something",
  "Someone", "Somewhere", "Nothing", "Nobody", "Nowhere", "Everything",
  "Everyone", "Everywhere", "Anything", "Anyone", "Somehow", "Whatever",
  "Whoever", "However", "Wherever", "Whenever", "Whichever", "Neither",
  "Either", "Few", "Several", "Another", "Above", "Against", "Along",
  "Among", "Around", "Across", "Behind", "Below", "Beside", "Beyond",
  "Despite", "Except", "Inside", "Instead", "Near", "Off", "Outside",
  "Past", "Since", "Throughout", "Toward", "Under", "Until", "Upon",
  "Within", "Perhaps", "Eventually", "Suddenly", "Quickly", "Slowly",
  "Carefully", "Finally", "Immediately", "Certainly", "Clearly", "Simply",
  "Naturally", "Probably", "Possibly", "Obviously", "Apparently", "Nearly",
  "Quietly", "Briefly", "Partly", "Mostly", "Barely", "Deeply",
  "Quite", "Rather", "Exactly", "Almost", "Enough", "Ahead", "Away",
  "Yes", "Well", "Okay", "Sure", "Hello", "Hi", "Hey", "Please", "Thanks", "Thank",
  "Because", "Maybe", "Though", "Although", "Unless", "Meanwhile", "Otherwise", "Later",
  "Chapter",
  // ★ INTERJECTIONS ARE A CLOSED CLASS, and they beat both name tests on a
  //   technicality: "Alright" opens dialogue lines, never appears lowercase in
  //   a webnovel register, and an opening quote counts as mid-sentence
  //   evidence. Measured on root-crown: "Alright" reached the CHARACTER
  //   bucket. Listing a closed class is safe where listing nouns was not.
  "Alright", "Yeah", "Nah", "Nope", "Yep", "Yup", "Hmm", "Huh", "Ugh", "Whoa",
  "Aye", "Ah", "Oh", "Um", "Er", "Eh", "Uh", "Phew", "Psst", "Shh", "Hush",
  "Wow", "Ooh", "Aah", "Hah", "Heh", "Hm", "Mm", "Mmm",
]);

// ── Hard discrete filter — commonly-capitalised non-entity English words ───
//
// Words in these well-defined semantic classes appear Title-Cased at sentence
// starts in every novel but are never characters, places, or factions.
// This O(1) lookup removes the most frequent false-positive classes before
// the more expensive IDF scoring stage.
/**
 * ★ A BARE HONORIFIC IS NEVER A CHARACTER.
 *
 * Measured across the 16-book corpus by `test:cast-corpus`: the token "Mrs"
 * alone reaches the top-30 extracted cast in NINE of sixteen books. It then wins
 * attribution matches outright — `"Mrs. Joe" -> speaker "Mrs"` — which is worse
 * than failing to attribute, because a confidently wrong speaker propagates into
 * event labels and the cast list a writer is shown.
 *
 * This is one of the two mechanisms behind honorific attribution being 52.3%
 * WRONG on 243 corpus-wide tags (`test:attribution-corpus`). The other is the
 * period in "Mr." breaking the attribution regex, which is a separate fix.
 *
 * Kept separate from COMMON_CAPITALIZED because these are not common words that
 * happen to be capitalised — they are name FRAGMENTS, and the right handling for
 * a fragment is to fuse it with what follows, not to admit it alone.
 */
const BARE_HONORIFIC: ReadonlySet<string> = new Set([
  "mr", "mrs", "ms", "miss", "dr", "prof", "professor", "sir", "madam", "madame",
  "lord", "lady", "master", "mistress", "rev", "reverend", "capt", "captain",
  "col", "colonel", "gen", "general", "lt", "lieutenant", "sgt", "sergeant",
  "st", "saint", "aunt", "uncle", "grandma", "grandpa", "papa", "mama",
]);

const COMMON_CAPITALIZED: ReadonlySet<string> = new Set([
  // Sentence-opening adverbs. A CLOSED class, unlike the open set of nouns that
  // can start a sentence, so listing them is safe where listing nouns was not.
  // These glue themselves to the following name and produced candidates like
  // "Tonight Tessa": capitalised, never seen lower case in a short chapter, and
  // therefore passing both name tests on a technicality.
  "Tonight","Today","Tomorrow","Yesterday","Later","Earlier","Afterward",
  "Afterwards","Meanwhile","Sometimes","Often","Once","Now","Then","Here",
  "There","Still","Even","Perhaps","Maybe","Instead","Finally","Eventually",
  "Suddenly","Soon","Already","Almost","Always","Never","Outside","Inside",
  "Above","Below","Beyond","Nearby","Everywhere","Somewhere","Nowhere",
  "Together","Alone","Beside","Behind","Ahead","Meantime","Presently",
  // Days of week
  "Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday",
  // Months
  "January","February","March","April","June",
  "July","August","September","October","November","December",
  // Cardinal numbers — one through nineteen, round tens, large magnitudes
  "One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten",
  "Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen",
  "Eighteen","Nineteen","Twenty","Thirty","Forty","Fifty","Sixty",
  "Seventy","Eighty","Ninety","Hundred","Thousand","Million","Billion",
  // Ordinals
  "Second","Third","Fourth","Fifth","Sixth","Seventh","Eighth",
  "Ninth","Tenth","Eleventh","Twelfth","Thirteenth","Fourteenth",
  "Fifteenth","Sixteenth","Seventeenth","Eighteenth","Nineteenth","Twentieth",
  // Seasons
  "Spring","Summer","Autumn","Winter",
  // Time-of-day / relative-time expressions
  "Morning","Afternoon","Evening","Midnight","Noon","Dusk",
  "Today","Tomorrow","Yesterday","Year","Years",
]);

// ── TF-IDF: English prose word-frequency table (IDF proxy) ────────────────
//
// Each entry maps a lowercase word to its approximate relative frequency in
// general English fiction prose, calibrated against BNC / COCA word-frequency
// lists and normalised to [0, 1].
//
//   IDF(w) = log(1 + 1 / freq(w))
//
// High-frequency English words ("Thursday" → 0.81, "One" → 0.97) yield
// IDF < 1.0 and are suppressed by the NSS gate below.
// Invented / world-specific names absent from this table default to
// RARE_WORD_FREQ ≈ 0.02, giving IDF ≈ 3.93 — well above every threshold.
//
// Threshold reference:
//   freq 0.97 → IDF 0.71   ("one" — blocked)
//   freq 0.82 → IDF 0.80   ("thursday" — blocked)
//   freq 0.27 → IDF 1.61   (breakeven for MIN_IDF_SOLO)
//   freq 0.55 → IDF 0.72   (breakeven for MIN_IDF_WITH_CONTEXT)
//   freq 0.02 → IDF 3.93   (invented name — always passes)
const ENGLISH_WORD_FREQ: ReadonlyMap<string, number> = new Map<string, number>([
  // Days
  ["monday",0.82],["tuesday",0.81],["wednesday",0.82],["thursday",0.81],
  ["friday",0.82],["saturday",0.80],["sunday",0.80],
  // Months
  ["january",0.83],["february",0.80],["march",0.82],["april",0.81],
  ["may",0.80],["june",0.80],["july",0.80],["august",0.79],
  ["september",0.78],["october",0.79],["november",0.78],["december",0.80],
  // Cardinals
  ["one",0.97],["two",0.96],["three",0.95],["four",0.94],["five",0.93],
  ["six",0.92],["seven",0.91],["eight",0.90],["nine",0.89],["ten",0.89],
  ["eleven",0.86],["twelve",0.86],["thirteen",0.85],["fourteen",0.84],
  ["fifteen",0.84],["sixteen",0.83],["seventeen",0.83],["eighteen",0.83],
  ["nineteen",0.82],["twenty",0.88],["thirty",0.86],["forty",0.85],
  ["fifty",0.85],["sixty",0.84],["seventy",0.83],["eighty",0.83],
  ["ninety",0.82],["hundred",0.90],["thousand",0.88],["million",0.87],
  ["billion",0.85],
  // Ordinals
  ["first",0.95],["second",0.94],["third",0.93],["fourth",0.88],
  ["fifth",0.87],["sixth",0.85],["seventh",0.84],["eighth",0.83],
  ["ninth",0.82],["tenth",0.82],["eleventh",0.80],["twelfth",0.79],
  // Seasons
  ["spring",0.84],["summer",0.87],["autumn",0.82],["winter",0.85],
  // Time
  ["morning",0.90],["afternoon",0.88],["evening",0.88],["night",0.91],
  ["midnight",0.85],["noon",0.83],["dawn",0.84],["dusk",0.82],
  ["today",0.93],["tomorrow",0.92],["yesterday",0.91],
  // High-frequency common nouns that appear title-cased in fiction
  ["people",0.93],["person",0.92],["man",0.94],["woman",0.92],
  ["child",0.91],["boy",0.90],["girl",0.90],["time",0.95],
  ["day",0.94],["year",0.93],["way",0.94],["thing",0.93],
  ["world",0.90],["life",0.90],["death",0.88],["blood",0.86],
  ["hand",0.92],["eye",0.89],["heart",0.89],["mind",0.88],
  ["soul",0.85],["voice",0.87],["face",0.91],["head",0.91],
  ["door",0.88],["room",0.88],["wall",0.87],["floor",0.86],
  ["sky",0.87],["sun",0.89],["moon",0.86],["star",0.87],
  ["wind",0.87],["rain",0.86],["fire",0.88],["water",0.90],
  ["earth",0.88],["light",0.91],["darkness",0.84],["shadow",0.84],
  ["name",0.92],["word",0.91],["thought",0.89],["feeling",0.87],
  ["power",0.89],["place",0.91],["moment",0.90],["memory",0.87],
  ["silence",0.84],["air",0.90],["ground",0.88],["path",0.87],
  ["step",0.88],["nothing",0.91],["everything",0.89],["something",0.89],
  ["someone",0.89],["anyone",0.87],["everyone",0.87],["nobody",0.85],
  // Common adjectives / adverbs that frequently open sentences in fiction
  ["good",0.94],["bad",0.93],["long",0.93],["short",0.91],
  ["big",0.92],["small",0.92],["high",0.91],["low",0.90],
  ["young",0.90],["true",0.92],["false",0.88],
  ["wrong",0.90],["hard",0.90],["soft",0.87],
  ["cold",0.89],["hot",0.89],["fast",0.88],["slow",0.88],
  ["full",0.90],["empty",0.87],["open",0.90],["closed",0.86],
  ["dead",0.89],["alive",0.86],["free",0.90],["lost",0.88],
  ["ready",0.88],["gone",0.88],["done",0.90],["dark",0.87],
  // Additional sentence-starters common in English fiction prose
  ["later",0.90],["soon",0.91],["once",0.90],["twice",0.87],
  ["half",0.91],["above",0.88],["below",0.87],["inside",0.88],
  ["outside",0.87],["near",0.90],["far",0.88],["across",0.88],
  ["around",0.89],["within",0.87],["beyond",0.86],["beneath",0.85],
  ["beside",0.85],["despite",0.87],["except",0.87],["along",0.88],
  ["through",0.90],["toward",0.88],["upon",0.88],["until",0.90],
  ["past",0.89],["since",0.90],
]);

// ── Novel-Specificity Score (NSS) — TF-IDF-inspired proper-noun metric ─────
//
// IDF(w) = log(1 + 1 / freq_english(w))
//
// Two-tier threshold system:
//
//   MIN_IDF_SOLO         — required when context signals are absent or weak.
//                          Filters common English words (days, months, numbers,
//                          generic nouns) that happen to be capitalised.
//                          Breakeven at corpus-freq ≈ 0.27.
//
//   MIN_IDF_WITH_CONTEXT — relaxed threshold applied when accumulated
//                          character / place / faction signal points reach
//                          CONTEXT_SIGNAL_THRESHOLD.  Admits borderline words
//                          used as actual entity names (e.g. "Dawn", "Hope",
//                          "March") when the prose provides clear evidence.
//                          Breakeven at corpus-freq ≈ 0.55.
//
// Words completely absent from ENGLISH_WORD_FREQ receive RARE_WORD_FREQ
// (0.02) → IDF ≈ 3.93, comfortably above both thresholds.
const RARE_WORD_FREQ           = 0.02;
const MIN_IDF_SOLO             = 1.61; // log(1 + 1/0.27)
const MIN_IDF_WITH_CONTEXT     = 0.72; // log(1 + 1/0.55)
const CONTEXT_SIGNAL_THRESHOLD = 4;    // min accumulated context points to unlock relaxed gate

const TITLE_TOKEN_PATTERN = `[A-Z][a-z]{1,}(?:['’-][A-Z][a-z]{1,})*`;
const TITLE_JOINER_PATTERN = `(?:of|the|for|de|du|del|da|di|la|le)`;
const LEADING_ARTICLES = new Set(["The"]);
const CONNECTOR_WORDS = new Set(["of", "the", "for", "de", "du", "del", "da", "di", "la", "le"]);

function buildTitleCaseCandidateRe(maxWords: number): RegExp {
  return new RegExp(
    `\\b(${TITLE_TOKEN_PATTERN}(?:[ \\t]+(?:${TITLE_JOINER_PATTERN}[ \\t]+)?${TITLE_TOKEN_PATTERN}){0,${Math.max(0, maxWords - 1)}})\\b`,
    "g",
  );
}

function allowLeadingArticle(words: string[]): boolean {
  if (!LEADING_ARTICLES.has(words[0] ?? "")) return false;
  const meaningfulTail = words.slice(1).filter((word) => !CONNECTOR_WORDS.has(word.toLowerCase()));
  return meaningfulTail.length >= 2;
}

function shouldRejectCandidateName(name: string): boolean {
  const words = name.split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first || name.length < 3) return true;
  if (STOPLIST.has(first) || COMMON_CAPITALIZED.has(first) || BARE_HONORIFIC.has(first)) {
    return !allowLeadingArticle(words);
  }
  if (words.length > 1) {
    const tailWords = words.slice(1);
    const hasBlockedTail = tailWords.some((word) => STOPLIST.has(word) || COMMON_CAPITALIZED.has(word));
    const hasConnector = words.some((word) => CONNECTOR_WORDS.has(word.toLowerCase()));
    if (hasBlockedTail && !hasConnector) return true;
  }
  return false;
}

/** Compute IDF weight for a candidate word or phrase. */
function computeIDF(word: string): number {
  const lc      = word.toLowerCase();
  const firstLc = word.split(" ")[0].toLowerCase();
  const freq    = ENGLISH_WORD_FREQ.get(lc) ?? ENGLISH_WORD_FREQ.get(firstLc) ?? RARE_WORD_FREQ;
  return Math.log(1 + 1 / freq);
}

/**
 * Is this match at the START of a sentence?
 *
 * Walks back over whitespace and opening quotes/brackets. Start-of-text counts.
 * Anything else must be preceded by a sentence terminator.
 *
 * ★ AN OPENING QUOTE IS ITSELF A SENTENCE START, and missing that leaked common
 * nouns into the cast for as long as this function has existed.
 *
 * The old version walked back OVER the quote character and then judged the
 * position by whatever preceded it. For the overwhelmingly common attribution
 * shape the preceding character is a comma:
 *
 *     She said, “Come here.”
 *
 * A comma is not a sentence terminator, so `Come` was reported MID-SENTENCE —
 * and mid-sentence is the strongest evidence a candidate can have, since
 * isProbablyName returns true on it immediately without ever consulting the
 * lowercase-form test that exists to reject exactly this word. So every ordinary
 * noun that ever opened a line of dialogue was admitted to the cast as a
 * character. Measured on the 15-book corpus: only 26% of extracted names ever
 * carry a speech tag, and `Body`, `Voice`, `Woman`, `Spirit`, `Some` and `Come`
 * were being handed to speech-detect as candidate speakers — where they won
 * 15.7% of bare dialogue lines outright.
 *
 * The fix is positional and needs no word list: if the walk crossed an opening
 * quote, the candidate opens a quotation, and a quotation begins a sentence
 * regardless of the punctuation that introduced it. The candidate then has to
 * earn its place through the lowercase-form test like any other, which `Kinoko`
 * passes and `Body` does not.
 *
 * The straight apostrophe is deliberately NOT treated as an opener. It is
 * ambiguous with the possessive (`the girls' Camp`), and this corpus quotes with
 * `“ ”` or `"`, so nothing is lost by leaving it skip-only.
 */
const QUOTE_OPENERS = /["“‘]/;

function isSentenceInitial(text: string, index: number): boolean {
  let i = index - 1;
  let crossedQuote = false;
  while (i >= 0 && /[\s"'“‘([]/.test(text[i])) {
    if (QUOTE_OPENERS.test(text[i])) crossedQuote = true;
    i--;
  }
  if (crossedQuote) return true;
  if (i < 0) return true;
  return /[.!?…:;]/.test(text[i]);
}

/**
 * Collect title-case candidates, and REQUIRE EVIDENCE THAT THEY ARE NAMES.
 *
 * ★ THE BUG THIS FIXES. Every sentence starts with a capital letter, and this
 * collector only ever asked "is it capitalised". So on The Root Crown chapter 1
 * it reported NINE characters: Kinoko, Vey, and then Basement, Standing, Stone,
 * Knees, Older, Cot and Arm. Chapter 16 added "Tonight Tessa" and "Knew". The
 * whole-book scan produced "Classify Crown Prince" and "Perform the Growth".
 * Common nouns, verbs and adverbs, all of them sitting at the front of a
 * sentence.
 *
 * The stoplists could not fix this. They are finite and the set of words that can
 * open a sentence is not, so every new manuscript brings new false names. That is
 * the same trap the event engine's phrase dictionaries fell into.
 *
 * The general fix is POSITIONAL and needs no word list at all: a real name also
 * appears in the MIDDLE of sentences. It follows "said", it takes possessives, it
 * sits in object position. A word that is only ever capitalised because it happens
 * to start a sentence never does. So a candidate has to be seen mid-sentence at
 * least once to survive.
 *
 * This generalises to any manuscript in any register, and it is the same
 * reasoning applied in narrative-events.ts, where the proper-noun test skips the
 * clause's first word for exactly this reason.
 */
/**
 * ★★ A CAPITALISED SUBSTRING IS NOT A NAME.
 *
 * `\b` treats an apostrophe, a hyphen and a digit boundary as word edges, so
 * three whole classes of non-name walked into the cast. All three measured on
 * The Root Crown, all three in the CHARACTER bucket:
 *
 *   "Don't let them take it"          → Don
 *   "a pre-Imperial monastic chronicler" → Imperial
 *   "the early evening of Day 23"     → Day
 *
 * ★ THE TEST IS ON THE OCCURRENCE, NOT ON THE NAME, and that is the whole
 *   design. A book that has both "Don't" and a man called Don keeps the man:
 *   only his contraction occurrences are discarded, and what remains is
 *   counted normally. A name list could never do that — it would have to
 *   choose, book-wide, between losing Don and keeping the fragment.
 *
 * A hyphen AFTER the token is the opposite situation: the name is the head of
 * the compound and the modifier follows it ("Growth-class", "Bind-containment"
 * are the Growth and Bind phrases). Only a LOWERCASE letter before the hyphen
 * marks the token as somebody else's suffix.
 */
function isFragmentOccurrence(text: string, start: number, end: number): boolean {
  const after = text.slice(end, end + 4);
  // A contraction: the apostrophe belongs to a verb, not to a possessive.
  // "'s" is deliberately absent — that one really is the name's possessive.
  if (/^['’](?:t|ll|re|ve|d|m)\b/i.test(after)) return true;
  // An index, not a name: "Day 1", "Chapter 4", "Level 12".
  if (/^\s+\d/.test(after)) return true;
  // A lowercase prefix owns the hyphen: pre-, post-, non-, self-, mid-.
  if (/[a-z][-–]$/.test(text.slice(Math.max(0, start - 2), start))) return true;
  return false;
}

function collectTitleCaseCandidates(text: string, maxWords: number): Map<string, number> {
  const total = new Map<string, number>();
  const midSentence = new Map<string, number>();
  // Every word that appears LOWERCASE anywhere in this text. See isProbablyName:
  // this is the dictionary, and it is the text's own.
  const lowercaseForms = new Set<string>(text.match(/\b[a-z][a-z'-]{1,}\b/g) ?? []);
  const pattern = buildTitleCaseCandidateRe(maxWords);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (isFragmentOccurrence(text, match.index, match.index + match[1].length)) continue;
    let name = match[1];
    const words = name.split(/\s+/).filter(Boolean);
    const prefix = text.slice(Math.max(0, match.index - 4), match.index);
    if (/\bthe\s$/i.test(prefix) && words.length >= 2) {
      name = `The ${name}`;
    }
    // ★ TRIM a leading ordinary word rather than reject the whole candidate.
    //
    // "Classify Crown Prince" and "Perform the Growth" are a verb glued to a real
    // name by nothing but a sentence boundary. "Tonight Tessa" is the same shape
    // with an adverb. Rejecting the pair loses the name; keeping it invents one.
    // The test is the text's own: if the first word also appears in lower case
    // here and the remainder does not, the first word is ordinary vocabulary and
    // the remainder is the name. This is more general than any word list, which
    // is why it also catches the adverbs.
    // NOTE: a "trim the leading ordinary word" rule was tried here, to turn
    // "Classify Crown Prince" into "Crown Prince". Two variants were measured and
    // BOTH were reverted. Requiring the whole tail to be absent in lower case
    // never fired, because "crown" appears throughout a novel called The Root
    // Crown. Gating on sentence-initial position instead did fire, and broke
    // test-known-names: it also trims real leading words out of the cold-start
    // name ranking, which that suite locks at 100%. One residual false name at
    // whole-book scale is a better trade than a regression in the ranking the app
    // depends on to know who the characters are.
    if (shouldRejectCandidateName(name)) {
      // ★★ "Within Darkholm." AT A SENTENCE START IS DARKHOLM.
      //
      //    The candidate regex is greedy, so a capitalised sentence-opener
      //    swallows the name that follows it into a two-word candidate, and
      //    that candidate is then thrown away whole because its first word is
      //    a stopword. Measured: Darkholm has four sightings in the fixture
      //    and reached the classifier with TWO, because "Within Darkholm" and
      //    "From Darkholm" both vanished — enough to drop it under the
      //    retention floor and lose an invented place name outright.
      //
      // ★  ONLY ON THE PATH WHERE THE CANDIDATE IS ALREADY BEING DISCARDED,
      //    which is what makes this safe where a general "trim the leading
      //    ordinary word" rule was measured and reverted twice. Nothing that
      //    survives today changes; this can only add back occurrences that
      //    were about to be dropped. The tail still faces
      //    `shouldRejectCandidateName` and, because the position stays
      //    sentence-initial, still has to earn its place through the
      //    never-lowercase test — which is exactly what keeps "The Basement"
      //    and "Within Reach" out while letting Darkholm through.
      const leadIsWhyItFailed =
        words.length === 2
        && (STOPLIST.has(words[0]) || COMMON_CAPITALIZED.has(words[0]) || LEADING_ARTICLES.has(words[0]));
      const tail = leadIsWhyItFailed ? words[1] : "";
      if (!tail || shouldRejectCandidateName(tail)) continue;
      total.set(tail, (total.get(tail) ?? 0) + 1);
      continue;
    }
    total.set(name, (total.get(name) ?? 0) + 1);
    if (!isSentenceInitial(text, match.index)) {
      midSentence.set(name, (midSentence.get(name) ?? 0) + 1);
    }
  }

  const freq = new Map<string, number>();
  for (const [name, count] of total) {
    // A candidate that opens a "The …" phrase is exempt: institution and place
    // names legitimately live at the front of sentences and carry their own
    // determiner as evidence ("The Listenfold Clinic", "The Open School").
    if (name.startsWith("The ")) { freq.set(name, count); continue; }
    if (isProbablyName(name, midSentence.get(name) ?? 0, lowercaseForms)) freq.set(name, count);
  }
  return freq;
}

/**
 * TWO independent kinds of evidence. A candidate needs either one.
 *
 * 1. It appears MID-SENTENCE somewhere. Real names follow "said", take
 *    possessives, sit in object position. A word capitalised only because it
 *    opens a sentence never does.
 *
 * 2. It never appears LOWERCASE in this text. This is the decisive one, and the
 *    dictionary it consults is the manuscript itself. "Basement", "Standing",
 *    "Knees", "Cot", "Arm" and "Knew" all occur in lower case elsewhere in the
 *    same book, because they are ordinary words the author also uses ordinarily.
 *    "Kinoko", "Mosshollow", "Anvas" never do, because they are names.
 *
 * ★ Why the second test is not optional, and why it is not a word list.
 *
 * Requiring only the positional test dropped KINOKO from The Root Crown chapter
 * 1, and she is the point-of-view character: in that chapter she happens to open
 * every sentence she appears in. Losing the protagonist is a far worse failure
 * than admitting a stray noun.
 *
 * The first attempt at a second test asked whether the word was in
 * ENGLISH_WORD_FREQ, and that failed silently and completely: that map is a small
 * curated frequency table, not a dictionary, so almost nothing is in it and
 * almost every candidate passed. Every false name came straight back. The
 * self-referential version needs no dictionary to be complete, works on invented
 * vocabulary, and works in any language.
 */
function isProbablyName(
  name: string,
  midSentenceCount: number,
  lowercaseForms: ReadonlySet<string>,
): boolean {
  if (midSentenceCount > 0) return true;
  const words = name.split(/\s+/).filter(Boolean);
  // EVERY word must be absent in lower case. "Tonight Tessa" must not qualify on
  // the strength of "Tessa" alone, and "tonight" is certainly in the text.
  return words.every((word) => !lowercaseForms.has(word.toLowerCase()));
}

const CHAR_NAMED_RE = /\b(named|called|name is)\s*$/i;
const CHAR_POSSESSIVE_AFTER_RE = /^\s*['’]s\b/i;
const PLACE_OF_RE = /\b(city|town|village|hamlet|kingdom|empire|realm|province|district|ward|sector|port|harbor|harbour|temple|fortress|castle|keep|mount|mountain|river|lake|forest|woods|island|sea|bay|garden|market|road|street|avenue|hall|inn|bridge|gate|capital|region|territory|basin|ring|plaza|station|library|campus)\s+(?:of|called)\s*$/i;
/**
 * ★★ "the" IS NOT IN EITHER LIST, AND TAKING IT OUT IS THE FIX.
 *
 *    It used to lead both, worth +1.5 to faction and +1.5 to entity on every
 *    occurrence. So a name a novel writes as "the X" accumulated two equal
 *    piles of evidence proportional to nothing but its frequency, tied at the
 *    top of the argmax, and the tie fell through to `character` and then out
 *    of the determiner eviction into `entity`. Measured on The Root Crown:
 *    Mosshollow reached faction 63 / entity 63 / place 0, and a valley
 *    finished in the same bucket as the magic system, alongside Cymboll,
 *    Dovesmoor, Mosswell and the Drowner's Lift.
 *
 *    A determiner is real evidence, but of ONE thing only: that the name is
 *    not a personal name. That is what `determinerUsage` is for, and it is
 *    read once, in the decision, instead of being spent as bucket score here.
 */
const FACTION_PREFIX_RE = /\b(house|order|guild|clan|legion|council|academy|guard|watch|union|alliance|ministry|court|brotherhood|sisterhood|syndicate|collective|committee|board)\s*$/i;
const ENTITY_PREFIX_RE = /\b(directive|framework|protocol|act|policy|program|system|charter|doctrine|orthodoxy|standard|authority|shell|compact|accord|network|initiative)\s*$/i;
const ENTITY_OF_RE = /\b(directive|framework|protocol|act|policy|program|system|charter|doctrine|orthodoxy|standard|authority|shell|compact|accord|network|initiative|unit|processing)\s+(?:of|for)\s*$/i;
const ENTITY_PREP_RE = /\b(under|via|per|according\s+to|pursuant\s+to)\s*$/i;
const ENTITY_AFTER_RE = /^\s*(requires|mandates|governs|defines|permits|forbids|authorizes|regulates|maintains|tracks|allocates|routes|weights|classifies|stabilizes|monitors|enforces|codifies)\b/i;

function computeEntityContextSignals(
  text: string,
  name: string,
  nouns?: ReadonlySet<string>,
): EntityContextSignals {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ctxRe = new RegExp(`([^\\n]{0,90})\\b${escaped}\\b([^\\n]{0,90})`, "gi");

  let occurrences = 0;
  let charScore = 0;
  let placeScore = 0;
  let factScore = 0;
  let entityScore = 0;
  let determinedCount = 0;
  let signalHits = 0;
  let previewBefore = "";
  let previewAfter = "";

  // ★★ THE HEAD WORD CARRIES THE KIND; A MODIFIER ONLY HINTS AT IT.
  //    The suffix vocabularies used to be tested against the whole name, so
  //    "Outer Ring Anomaly" collected +4 place for `ring` AND +4 entity for
  //    `anomaly` and tied — and an anomaly named after a district went to the
  //    faction bucket. English puts the head last: an Anomaly is an anomaly
  //    wherever it happened, and a Ring is a ring however outer it is. The
  //    modifier keeps a small voice (+1) because it is still evidence, just
  //    never enough to outvote the head.
  const byHead = headVocabularyLabel(name);
  if (byHead === "place") placeScore += 4;
  else if (PLACE_SUFFIX_RE.test(name)) placeScore += 1;
  if (byHead === "faction") factScore += 4;
  else if (FACTION_SUFFIX_RE.test(name)) factScore += 1;
  if (byHead === "entity") entityScore += 4;
  else if (ENTITY_SUFFIX_RE.test(name)) entityScore += 1;

  let match: RegExpExecArray | null;
  while ((match = ctxRe.exec(text)) !== null) {
    const before = match[1];
    const after = match[2];
    occurrences += 1;
    if (!previewBefore && !previewAfter) {
      previewBefore = before;
      previewAfter = after;
    }

    const hitsBefore = { char: charScore, place: placeScore, fact: factScore, entity: entityScore };

    if (CHAR_TITLE_RE.test(before))   charScore += 3;
    if (CHAR_PRONOUN_RE.test(before)) charScore += 2;
    if (CHAR_VERB_RE.test(after))     charScore += 1.25;
    if (CHAR_NAMED_RE.test(before))   charScore += 2;
    if (CHAR_POSSESSIVE_AFTER_RE.test(after)) charScore += 0.75;

    // "the Dovesmoor marshes": a word this book uses after an article is a
    // noun, and so is any word already in one of the vocabularies — the
    // lexicon is a fallback for the ones that are not, not a prerequisite.
    // Gating the modified-noun signal on the lexicon left Dovesmoor with zero
    // evidence, because The Root Crown never writes the bare phrase "the
    // marshes" anywhere.
    const modified = DETERMINER_BEFORE_RE.test(before) ? attributiveHeadLabel(after) : null;
    const attributive = modified !== null || followingWordIsNoun(after, nouns);

    // ★★ A BARE PREPOSITION BEFORE A PROPER NOUN IS AMBIGUOUS; THE SAME
    //    PREPOSITION BEFORE "the X" IS NOT.
    //
    //    "to the Mosshollow" cannot be a person. "to Jane" can, and so can
    //    "near Jane", "beside Jane", "past Jane", "from Jane" — English lets
    //    every one of these take a person as easily as a location. Scoring
    //    them equally is what put the second lead of Pride and Prejudice in
    //    the PLACES bucket on 34 sightings against 28 person signals, and
    //    Renfield in Dracula on a margin of 0.75. Both were near-ties the
    //    classifier reported as decisions.
    //
    //    So the determined form keeps full weight and the bare form is worth
    //    less than half of it. Netherfield, Longbourn, Pemberley and Meryton
    //    are unaffected: nothing competes with them, because nobody ever
    //    speaks to an estate.
    if (PLACE_PREP_DET_RE.test(before) && !attributive) placeScore += 1.25;
    else if (PLACE_PREP_RE.test(before)) placeScore += 0.5;
    else if (PLACE_TO_RE.test(before) && !TO_GOVERNED_BY_PERSON_VERB.test(before)) placeScore += 0.5;
    if (PLACE_OF_RE.test(before))     placeScore += 2.5;

    if (modified === "place") placeScore += ATTRIBUTIVE_WEIGHT;
    else if (modified === "faction") factScore += ATTRIBUTIVE_WEIGHT;
    else if (modified === "entity") entityScore += ATTRIBUTIVE_WEIGHT;

    if (DETERMINER_BEFORE_RE.test(before)) determinedCount += 1;
    if (/\bthe\s*$/i.test(before) && FACTION_COLLECTIVE_RE.test(after)) factScore += 2;
    if (FACTION_PREFIX_RE.test(before)) factScore += 1.5;

    if (ENTITY_PREFIX_RE.test(before)) entityScore += 1.5;
    if (ENTITY_OF_RE.test(before)) entityScore += 2.5;
    if (ENTITY_PREP_RE.test(before)) entityScore += 1.25;
    if (ENTITY_AFTER_RE.test(after)) entityScore += 1.1;

    if (
      charScore + placeScore + factScore + entityScore
      > hitsBefore.char + hitsBefore.place + hitsBefore.fact + hitsBefore.entity
    ) {
      signalHits += 1;
    }
  }

  return {
    occurrences,
    charScore,
    placeScore,
    factScore,
    entityScore,
    determinedCount,
    signalHits,
    totalContext: charScore + placeScore + factScore + entityScore,
    previewBefore,
    previewAfter,
    isMultiWord: /\s/.test(name),
    hasJoiner: /['’-]/.test(name),
  };
}

function shouldKeepEntityCandidate(
  name: string,
  occurrences: number,
  signals: EntityContextSignals,
  minFreq: number,
): boolean {
  const strongest = Math.max(signals.charScore, signals.placeScore, signals.factScore, signals.entityScore);
  const structural = signals.isMultiWord || signals.hasJoiner || PLACE_SUFFIX_RE.test(name) || FACTION_SUFFIX_RE.test(name) || ENTITY_SUFFIX_RE.test(name);
  const wordCount = name.trim().split(/\s+/).filter(Boolean).length;
  if (
    wordCount === 1
    && occurrences < Math.max(2, minFreq + 1)
    && strongest < 2
    && signals.signalHits < 2
    && signals.totalContext < 2.75
  ) {
    return false;
  }
  if (occurrences >= minFreq + 2) return true;
  // ★ A DETERMINED NAME IS STILL A NAME. Taking bare "the" out of the faction
  //   and entity prefix lists was right — it said nothing about WHICH bucket —
  //   but it also removed the only retention evidence some low-frequency names
  //   had, and Dovesmoor (4 uses, all "the Dovesmoor <something>") fell out of
  //   the scan entirely. Repeated "the X" is precisely how prose refers to a
  //   named thing, so it belongs here, in the keep-or-drop decision, and
  //   nowhere near the bucket comparison.
  if (signals.determinedCount >= 2 && occurrences >= minFreq) return true;
  if (structural && occurrences >= minFreq) return true;
  // Two occurrences the prose said something about. Counted as HITS, not as
  // score, so a reweighting of the buckets cannot quietly change who survives.
  if (signals.signalHits >= 2) return true;
  if (structural && wordCount >= 3 && occurrences >= Math.max(1, minFreq - 1)) return true;
  if (signals.totalContext >= 2) return true;
  if (strongest >= 1.5 && occurrences >= minFreq) return true;
  return false;
}

function candidateSortScore(
  occurrences: number,
  idf: number,
  signals: EntityContextSignals,
): number {
  return occurrences * 14 + signals.totalContext * 6 + (signals.isMultiWord ? 5 : 0) + (signals.hasJoiner ? 3 : 0) + idf * 4;
}

const ENTITY_SUFFIX_RE = /\b(directive|framework|orthodoxy|protocol|act|policy|program|system|charter|doctrine|standard|authority|shell|compact|accord|network|initiative|unit|processing|committee|commission|board|bureau|directorate|registry|anomaly|investigation|incident|outbreak|practice|practices|script)\b/i;
const INSTITUTIONAL_TERM_RE = /\b(executive|hierarchical|administrative|continuity|distributed|adaptive|civic|informed|processing|authority|framework|directive|orthodoxy|protocol|program|policy|system)\b/i;
const ENTITY_SEMANTIC_ANCHORS = {
  entity: "a doctrine, directive, framework, act, policy, protocol, institution, committee, commission, board, bureau, directorate, registry office, executive directive, governing framework, ideology, orthodoxy, administrative program",
  faction: "a faction, alliance, guild, order, wing, political group, organization, ministry, council, military unit, collective",
  place: "a place, planet, city, district, station, campus, world, location, building, plaza",
} as const;

let semanticSimilarityFn: ((text: string, anchor: string) => Promise<number>) | null = null;
let semanticSimilarityLoader: Promise<((text: string, anchor: string) => Promise<number>) | null> | null = null;

function runtimeSupportsSemanticEntityAssist(): boolean {
  if (typeof window === "undefined") return true;
  return !!((window as Window & {
    electronAPI?: { narrativeLMEmbed?: ((text: string) => Promise<number[] | null>) | undefined };
  }).electronAPI?.narrativeLMEmbed);
}

function looksInstitutionalName(name: string): boolean {
  return name.trim().split(/\s+/).length >= 2 && (ENTITY_SUFFIX_RE.test(name) || INSTITUTIONAL_TERM_RE.test(name));
}

async function getSemanticSimilarityFn() {
  if (!runtimeSupportsSemanticEntityAssist()) return null;
  if (semanticSimilarityFn) return semanticSimilarityFn;
  if (semanticSimilarityLoader) return semanticSimilarityLoader;
  semanticSimilarityLoader = import("./narrative-lm")
    .then((mod) => {
      semanticSimilarityFn = mod.semanticSimilarity;
      return semanticSimilarityFn;
    })
    .catch(() => null);
  return semanticSimilarityLoader;
}

async function maybeRefineInstitutionalLabel(
  name: string,
  signals: EntityContextSignals,
  previewBefore: string,
  previewAfter: string,
  rankedConfidence: number,
  predictedLabel: "character" | "place" | "faction" | "entity",
  enabled: boolean | undefined,
): Promise<"character" | "place" | "faction" | "entity"> {
  if (enabled === false) return predictedLabel;
  if (!looksInstitutionalName(name)) return predictedLabel;
  if (signals.charScore >= 2.25) return predictedLabel;
  if (rankedConfidence >= 0.82 && predictedLabel === "entity") return predictedLabel;
  if (signals.entityScore <= 0 && signals.factScore <= 0) return predictedLabel;

  const similarity = await getSemanticSimilarityFn();
  if (!similarity) return predictedLabel;

  const query = `${previewBefore.slice(-80)} ${name} ${previewAfter.slice(0, 80)}`.replace(/\s+/g, " ").trim() || name;
  const [entitySim, factionSim, placeSim] = await Promise.all([
    similarity(query, ENTITY_SEMANTIC_ANCHORS.entity),
    similarity(query, ENTITY_SEMANTIC_ANCHORS.faction),
    similarity(query, ENTITY_SEMANTIC_ANCHORS.place),
  ]);
  const bestOther = Math.max(factionSim, placeSim);
  if (entitySim >= 0.34 && entitySim - bestOther >= 0.07) return "entity";
  if (factionSim >= 0.16 && factionSim - Math.max(entitySim, placeSim) >= 0.03) return "faction";
  if (placeSim >= 0.2 && placeSim - Math.max(entitySim, factionSim) >= 0.04) return "place";
  return predictedLabel;
}

// ── Auto-extraction heuristic ──────────────────────────────────────────────

/**
 * Scans all chapters for Title-Case words/phrases that appear `minFreq`+ times.
 * Used as a zero-config fallback when the user hasn't entered any world data.
 * Pure regex + frequency count — no external libraries.
 */
export function autoExtractEntities(novel: Novel, minFreq = 3, max = 30): string[] {
  const allText = novel.chapters.map((c) => c.content).join("\n");
  if (!allText) return [];
  const freq = collectTitleCaseCandidates(allText, 2);

  return [...freq.entries()]
    // ★★ THE CHEAP TERMS FIRST, AND IT IS NOT AN APPROXIMATION.
    //    computeEntityContextSignals runs a full-text regex PER CANDIDATE, and
    //    this mapped it over every Title-Case form in the book — thousands of
    //    them, most occurring once — before the frequency filter below threw
    //    them away. Measured on Pride and Prejudice (670KB, 57 chapters):
    //    39.4 SECONDS, on the main thread, and it is reached from the
    //    characters tab of the world panel.
    //
    //    Both terms hoisted here are NECESSARY CONDITIONS of the filter that
    //    follows, so the survivor set is unchanged by construction:
    //      · `n >= minFreq` is the identical term and depends on nothing else.
    //      · the filter needs `idf >= minIdf`, and minIdf is one of two
    //        constants; MIN_IDF_WITH_CONTEXT (0.72) is the smaller, so
    //        `idf >= 0.72` is implied by either branch.
    //    computeIDF is a map lookup. Verified byte-identical on five books.
    .filter(([name, n]) => n >= minFreq && computeIDF(name) >= MIN_IDF_WITH_CONTEXT)
    .map(([name, n]) => {
      const signals = computeEntityContextSignals(allText, name);
      const idf = computeIDF(name);
      const minIdf = signals.totalContext >= CONTEXT_SIGNAL_THRESHOLD
        ? MIN_IDF_WITH_CONTEXT
        : MIN_IDF_SOLO;
      return { name, n, idf, minIdf, signals };
    })
    .filter(({ name, n, idf, minIdf, signals }) =>
      n >= minFreq && idf >= minIdf && shouldKeepEntityCandidate(name, n, signals, minFreq),
    )
    .sort((a, b) => candidateSortScore(b.n, b.idf, b.signals) - candidateSortScore(a.n, a.idf, a.signals))
    .slice(0, max)
    .map(({ name }) => name);
}

/**
 * Name candidates WITHOUT the entity classifier — frequency and IDF only.
 *
 * ★★ FOR CALLERS THAT WANT NAMES, NOT TYPES. autoExtractEntities runs
 *    computeEntityContextSignals per surviving candidate — a full-text regex
 *    each — to decide character / place / faction / entity. A caller that only
 *    needs "which capitalised forms does this book use often" pays seconds for
 *    a classification it then discards. Measured on Dracula (800KB): 38.7s
 *    there against 0.95s here.
 *
 * ★ AND IT DOES NOT SHORT-CIRCUIT ON worldData, which resolveKnownNames does —
 *   that returns the writer's OWN cast the moment the panel is non-empty, so it
 *   can confirm a name but can never discover one. Anything hunting for a form
 *   the writer does not have yet has to come through here.
 */
export function extractNameCandidatesFast(novel: Novel, minFreq = 2, max = 30): string[] {
  return autoExtractKnownNamesFast(novel, minFreq, max);
}

function autoExtractKnownNamesFast(novel: Novel, minFreq = 2, max = 30): string[] {
  const allText = novel.chapters.map((c) => c.content).join("\n");
  if (!allText) return [];
  const freq = collectTitleCaseCandidates(allText, 3);

  // Rank by occurrence count (relevance), never by name length. A
  // length-descending sort here silently becomes the selection policy the
  // moment slice(0, max) follows it: every short protagonist name loses to
  // thirty longer institutional nouns, and speech attribution downstream
  // starves (measured: 0% cast recall, ~53% of dialogue unattributed).
  // Longest-first ordering for regex alternation is buildEntityPattern's
  // job — it re-sorts internally.
  return [...freq.entries()]
    // ★ A BARE HONORIFIC IS NEVER A CHARACTER. "Mrs" alone reached the top-30
    // extracted cast in NINE of sixteen books, measured by test:cast-corpus, and
    // then WON attribution matches outright — `"Mrs. Joe" -> speaker "Mrs"`.
    // A confidently wrong speaker is worse than none: it propagates into event
    // labels and into the cast list a writer is shown.
    .filter(([name, n]) =>
      n >= minFreq
      && computeIDF(name) >= MIN_IDF_SOLO
      && !BARE_HONORIFIC.has(name.toLowerCase().replace(/\.$/, "")))
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, max)
    .map(([name]) => name);
}

// ── Contextual entity classifier ──────────────────────────────────────────

const PLACE_SUFFIX_RE = /\b(forest|wood|woods|mountain|mountains|peak|ridge|valley|plains|plain|desert|island|islands|lake|river|sea|ocean|bay|gulf|cove|creek|brook|stream|falls|harbor|harbour|port|city|town|village|hamlet|castle|keep|tower|gate|bridge|road|street|avenue|square|market|hall|inn|tavern|temple|shrine|palace|manor|estate|fortress|citadel|dungeon|ruins|cave|cavern|mine|district|quarter|ward|sector|ring|zone|corridor|region|territory|province|country|land|field|fields|garden|gardens|cliff|pass|hills|hill|marsh|swamp|bog|inlet|basin|station|hub|outpost|terminal|platform|crossing|junction|checkpoint|settlement|colony|depot|compound|encampment|sanctuary|lookout|clinic|hospital|infirmary|office|shop|store|mill|forge|dock|docks|wharf|pier|lane|alley|yard)\b/i;

const FACTION_SUFFIX_RE = /\b(order|guild|house|council|brotherhood|sisterhood|society|alliance|clan|legion|corps|division|union|academy|circle|court|agency|federation|confederation|republic|dynasty|tribe|cult|sect|guard|watch|wing|militia|syndicate|collective|assembly|parliament|senate|commission|committee|board|ministry|institute|college|chapter|covenant|school|conclave)\b/i;

/**
 * The three vocabularies again, anchored to a SINGLE word so they can be asked
 * about the head instead of about the whole name. Derived from the same
 * sources so the two can never drift apart.
 */
const asWholeWordRe = (re: RegExp) => new RegExp(`^(?:${re.source.slice(2, -2)})$`, "i");
const PLACE_HEAD_RE = asWholeWordRe(PLACE_SUFFIX_RE);
const FACTION_HEAD_RE = asWholeWordRe(FACTION_SUFFIX_RE);
const ENTITY_HEAD_RE = asWholeWordRe(ENTITY_SUFFIX_RE);

/** The last word, which in English is the head of a noun phrase. Possessives
 *  strip so "the Hand Tower's stair" still reports `tower`. */
function headWordOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words[words.length - 1] ?? "").toLowerCase().replace(/['’]s$/, "");
}

/**
 * Which bucket a word argues for, when it argues for exactly one. A word in two
 * vocabularies argues for neither, because a coin flip is not evidence.
 *
 * ★ THE VOCABULARIES ARE SINGULAR AND PROSE IS NOT. "The Northern Passes" is a
 *   place and `pass` is in the list, but `\bpass\b` does not match "passes",
 *   so the name arrived at the classifier with no name-internal evidence at
 *   all and finished in the cast. Same for "Monastic Practices" and `practice`.
 */
function vocabularyLabelOf(word: string): "place" | "faction" | "entity" | null {
  for (const form of singularForms(word)) {
    const hits: Array<"place" | "faction" | "entity"> = [];
    if (PLACE_HEAD_RE.test(form)) hits.push("place");
    if (FACTION_HEAD_RE.test(form)) hits.push("faction");
    if (ENTITY_HEAD_RE.test(form)) hits.push("entity");
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  return null;
}

function headVocabularyLabel(name: string): "place" | "faction" | "entity" | null {
  return vocabularyLabelOf(headWordOf(name));
}


const CHAR_TITLE_RE = /\b(lord|lady|sir|captain|master|doctor|dr|father|mother|queen|king|prince|princess|elder|chief|general|colonel|major|sergeant|inspector|professor|saint|magister|marshal|warden|goodman|goodwife|brother|sister|abbot|abbess|madam|mistress|dame)\s*$/i;

/**
 * ★ A NAME WHOSE HEAD WORD DENOTES A PERSON IS A PERSON, determiner or not.
 *   "the Crown Prince", "the Pale Marshal" and "the Spore Warden" are people
 *   referred to by title, and title reference takes a determiner — exactly
 *   the usage the determiner test below reads as "not a personal name". This
 *   closed-ish class of role nouns is the guard that keeps titled characters
 *   out of the entity bucket, and it also recovers a titled person the
 *   suffix heuristics banished to places.
 */
const PERSON_HEAD_RE = /\b(prince|princess|king|queen|emperor|empress|duke|duchess|lord|lady|marshal|warden|magister|master|mistress|captain|colonel|general|sergeant|doctor|professor|priest|priestess|monk|nun|abbot|abbess|brother|sister|father|mother|elder|chief|smith|blacksmith|scribe|clerk|steward|herald|hunter|keeper|rider|guard|prefect|magistrate|alderman)\s*$/i;

/** The title can also LEAD the name: "Magister Adena Volk", "Aunt Mira",
 *  "Blacksmith Oren". Same closed class, tested at the front. */
const PERSON_LEAD_RE = /^(?:prince|princess|king|queen|emperor|empress|duke|duchess|lord|lady|marshal|warden|magister|master|mistress|captain|colonel|general|sergeant|doctor|dr|professor|priest|priestess|monk|abbot|abbess|brother|sister|father|mother|elder|chief|blacksmith|goodman|goodwife|aunt|uncle|madam|madame|mistress|dame|inspector|saint)\.?\s+\S/i;

/**
 * ★ A TITLE ANYWHERE IN A NAME MAKES IT A PERSON'S NAME. PERSON_HEAD_RE reads
 *   the end and PERSON_LEAD_RE reads the front, so "Crown Prince Sevren" — the
 *   title in the middle — matched neither and was filed as a character only by
 *   the no-evidence default, at confidence 0.20, which then spent a review slot.
 *
 *   Guarded on the head: "The Guard Tower" contains `guard` and is a building,
 *   and the head word is the thing that settles it.
 */
const PERSON_TITLE_WORD_RE = new RegExp(`^${/\((?:[a-z|]+)\)/.exec(PERSON_HEAD_RE.source)?.[0] ?? "(?!)"}$`, "i");

function nameCarriesPersonTitle(name: string): boolean {
  if (headVocabularyLabel(name)) return false;
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.some((w) => PERSON_TITLE_WORD_RE.test(w));
}

const PLACE_PREP_RE = /\b(in|at|from|near|through|outside|inside|across|toward|towards|beyond|into|within|upon|above|below|around|beside|along|between|past)\s*$/i;

/**
 * ★★ "to" IS NOT A PLACE PREPOSITION ON ITS OWN, AND THIS BUG WAS ALREADY
 *    PAID FOR ONCE.
 *
 *    entity-review's `placePrep` carries the same guard and the same comment;
 *    the scan's copy of the list never got it, and while the determiner was
 *    flooding faction and entity with score the place signal was too drowned
 *    for it to matter. With that removed it matters immediately: measured on
 *    books nobody tuned against, "said to Jane" and "wrote to Jane" put the
 *    second lead of Pride and Prejudice in the PLACES bucket, and "spoke to
 *    Renfield" did the same in Dracula.
 *
 *    A speech or attention verb governing "to" makes the object a person, not
 *    a destination. The unambiguous prepositions above need no such guard.
 */
const PLACE_TO_RE = /\bto\s*$/i;
const TO_GOVERNED_BY_PERSON_VERB = /\b(?:turn|turns|turned|turning|spoke|speak|speaks|speaking|said|says|say|told|tell|tells|talk|talks|talked|listen|listens|listened|whisper|whispers|whispered|shout|shouts|shouted|gesture|gestures|gestured|nod|nods|nodded|point|points|pointed|reply|replies|replied|wrote|write|writes|writing|read|reads|according|close|closer|next|back|married|introduced|attached|known|belong|belongs|belonged|happened|explained|answered|admitted|confessed|owe|owes|owed)\s+to\s*$/i;

/**
 * ★★ THE SAME PREPOSITIONS, ACROSS A DETERMINER.
 *
 *    `PLACE_PREP_RE` requires the preposition to touch the name, so "at the
 *    Mosshollow" scored ZERO for place while "at Mosshollow" scored 1.25 — and
 *    English requires the article for most named locations. The names with the
 *    most place evidence in the prose were therefore the ones with the least
 *    place score in the classifier, which is the inversion that sent a valley,
 *    a village and a marsh into the entity bucket.
 *
 * ★ "to" IS DELIBERATELY ABSENT HERE, though it is present in the bare form
 *   above. "turned to the marshal", "spoke to the elder" are person usage, and
 *   the determined form is where that shape lives; entity-review paid for this
 *   lesson already (a speaking character read as a location). The unambiguous
 *   prepositions carry the signal on their own.
 */
const PLACE_PREP_DET_RE = /\b(in|at|from|near|through|outside|inside|across|toward|towards|beyond|into|within|upon|above|below|around|beside|along|between|past)\s+(?:the|a|an|this|that|his|her|its|their|our|my)\s+$/i;

/**
 * ★★ "in the Growth phrase" IS NOT A PLACE, AND THE NAME IS NOT WHAT THE
 *    PREPOSITION GOVERNS.
 *
 *    Letting place prepositions reach across a determiner is what recovered
 *    Mosshollow and Cymboll, and it immediately handed the same credit to
 *    every ATTRIBUTIVE use: "from the Growth phrase", "the Dovesmoor marshes",
 *    "the Mosswell loaves". There the name is a modifier and the preposition
 *    governs the noun after it, so the casting classes went to the place
 *    bucket — a new inversion in place of the old one.
 *
 *    The discriminator has to separate a following NOUN from a following VERB
 *    ("to the Mosshollow was easy"), and the dictionary for that is the
 *    manuscript itself, the same trick that decides which capitalised words
 *    are names: collect every lowercase word this book writes directly after
 *    an article. "phrase", "loaves" and "marshes" are all in it; "was", "had"
 *    and "would" are in no book's. No word list, works on invented vocabulary,
 *    works in any language that has articles.
 */
function buildNounLexicon(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\b(?:the|a|an)\s+([a-z][a-z'’-]{1,})\b/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.add(m[1]);
  return out;
}

function followingWordIsNoun(after: string, nouns: ReadonlySet<string> | undefined): boolean {
  if (!nouns) return false;
  const next = /^\s+([a-z][a-z'’-]*)/.exec(after);
  return !!next && nouns.has(next[1]);
}

/**
 * ★★ AN ATTRIBUTIVE USE NAMES THE KIND OF THING IT MODIFIES.
 *
 *    Having decided that "the Dovesmoor marshes" is not the preposition
 *    governing Dovesmoor, there is still a reader's inference sitting in
 *    plain sight and it was being thrown away: whatever Dovesmoor is, the
 *    prose just said the marshes belong to it. Same for "the Cymboll valley".
 *    For a name whose every occurrence is attributive — which is exactly the
 *    shape that has no direct evidence at all — this is the only evidence
 *    there is.
 *
 *    Weighted at 0.75, below a direct sighting: a modified noun is a strong
 *    hint about the referent and not a statement about it, and "the Anvas
 *    market" would say place about a person's market stall just as readily.
 */
const ATTRIBUTIVE_WEIGHT = 0.75;

/** Crude but sufficient: the vocabularies are singular, prose is not. */
function singularForms(word: string): string[] {
  const forms = [word];
  if (word.endsWith("es")) forms.push(word.slice(0, -2));
  if (word.endsWith("s")) forms.push(word.slice(0, -1));
  return forms;
}

function attributiveHeadLabel(after: string): "place" | "faction" | "entity" | null {
  const next = /^\s+([a-z][a-z'’-]*)/.exec(after);
  return next ? vocabularyLabelOf(next[1]) : null;
}

const CHAR_VERB_RE = /^\s*(said|asked|replied|whispered|shouted|called|told|warned|answered|explained|nodded|shook|smiled|frowned|looked|stared|watched|turned|walked|ran|moved|stood|sat|fell|rose|felt|thought|knew|heard|saw|met|glanced|waved|reached|grabbed|held|spoke|cried|laughed|sighed|gasped|blinked|noticed|realized|remembered|decided|wondered|wanted|needed|found|returned|entered|left|opened|closed|pulled|pushed|drew|raised|pressed|touched|released|jumped|stepped|leaned|knelt|bowed|pointed|added|continued|interrupted)\b/i;

const CHAR_PRONOUN_RE = /\b(he|she|they|him|her)\s*$/i;

const FACTION_COLLECTIVE_RE = /^\s*(attacked|gathered|declared|sent|marched|controlled|ruled|ordered|commanded|demanded|allied|fought|held|occupied|protected|served|arrived|retreated|advanced|surrounded|captured|released|accepted|rejected|agreed|disbanded|recruited|deployed|imposed)\b/i;

export interface ScanResult {
  characters: string[];
  places:     string[];
  factions:   string[];
  entities:   string[];
}

type BucketLabel = "character" | "place" | "faction" | "entity";

interface BucketDecision {
  label: BucketLabel;
  /** How far the winner sits from the runner-up, 0..1. Low means the scan is
   *  guessing, and a guess is exactly what the review pass should read first. */
  confidence: number;
  reason: string;
}

/**
 * ★★ ONE DECISION, MADE ONCE, WITH ITS OWN CONFIDENCE.
 *
 *    This replaces an argmax followed by a separate eviction cascade, and the
 *    two-stage shape was itself a bug. The argmax required a STRICT maximum,
 *    so a tie produced no label and fell through to the `character` default;
 *    the eviction then noticed the name was determined, kicked it out of
 *    character, and ran down a chain whose last rung was `entity`. Neither
 *    stage ever decided anything for a tied name — `entity` was where names
 *    went when nothing had been decided, which is why The Root Crown's entity
 *    bucket held a valley, a village, a marsh, a transit line, a surname and
 *    the magic system all at once.
 *
 *    The determiner test now runs BEFORE the comparison rather than after it,
 *    which is where it belongs: "this is not a personal name" is a fact about
 *    the candidate, not an appeal against a verdict. And when the evidence
 *    genuinely does not separate the buckets, that is reported as a low
 *    confidence instead of being laundered into a label — `selectReviewable`
 *    ranks on exactly this number, so an honest shrug is what puts the name in
 *    front of the model.
 */
function decideBucket(
  name: string,
  signals: EntityContextSignals,
  determined: boolean,
): BucketDecision {
  const headIsPerson =
    PERSON_HEAD_RE.test(name) || PERSON_LEAD_RE.test(name) || nameCarriesPersonTitle(name);

  // ★ TITLE REFERENCE IS THE ONE LEGITIMATE DETERMINED PERSON. "the Crown
  //   Prince", "the Spore Warden", "Magister Volk" — a title takes an article
  //   and still names somebody. Settled first so the determiner test below
  //   cannot reach it.
  if (headIsPerson) return { label: "character", confidence: 0.9, reason: "person-title" };

  const scores: Array<[BucketLabel, number]> = [
    ["character", determined ? 0 : signals.charScore],
    ["place", signals.placeScore],
    ["faction", signals.factScore],
    ["entity", signals.entityScore],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const [top, second] = scores;

  // ★★ AN ARGMAX OVER ALMOST NO EVIDENCE IS A COIN FLIP, AND THE OLD ONE SAID
  //    IT WAS CERTAIN. "Growth" appears 32 times in The Root Crown and follows
  //    a place preposition ONCE; that single 1.25 beat three zeroes, so the
  //    gap-based confidence read 1.0 and a casting class was filed as a
  //    location — and Bind and Founding went with it on one sighting each.
  //
  //    Two floors, because one sighting and one-in-thirty are different
  //    failures. MIN_DECIDING_SCORE is two independent sightings (or one "the
  //    city of X", which is worth 2.5 on its own): one is a coincidence.
  //    MIN_DECIDING_RATE asks that the evidence appear in a nontrivial share
  //    of the uses at all — measured on this book, the names that clear it are
  //    Mosshollow (0.21) and Cymboll (0.29), and the ones that do not are
  //    Growth (0.13), Bind, Founding and Lift, which is exactly the split a
  //    reader makes. Below either floor the answer is "undecided", which the
  //    review pass reads as a question rather than as an answer.
  //    A third rung, MIN_DOMINANT_RATE, exists because the absolute floor is
  //    the wrong test for a name that is only used a few times: Dovesmoor
  //    appears four times and two of them say "the Dovesmoor marshes", which
  //    is 1.5 points and every bit as conclusive as Cymboll's twelve. When the
  //    evidence covers better than a third of the uses, the count stops
  //    mattering. Growth is at 0.13 and Founding at 0.21, so the gap is real.
  const MIN_DECIDING_SCORE = 2.5;
  const MIN_DECIDING_RATE = 0.15;
  const MIN_DOMINANT_RATE = 0.35;
  const rate = signals.occurrences > 0 ? top[1] / signals.occurrences : 0;
  const enough = (top[1] >= MIN_DECIDING_SCORE && rate >= MIN_DECIDING_RATE) || rate >= MIN_DOMINANT_RATE;

  if (enough && top[1] > 0 && top[1] > second[1]) {
    return {
      label: top[0],
      confidence: Math.min(0.95, (top[1] - second[1]) / top[1]),
      reason: determined ? "context-determined" : "context",
    };
  }

  // Tied, or no context evidence at all. Name-internal vocabulary is weaker
  // than prose but it is still evidence, and it is the last of it.
  const byHead = headVocabularyLabel(name);
  if (byHead) return { label: byHead, confidence: 0.4, reason: "head-vocabulary" };

  // Nothing left. A bare repeated capitalised form with no determiner is
  // overwhelmingly a person in a novel; a determined one is not, and there is
  // no honest way to say which of the other three it is.
  if (determined) return { label: "entity", confidence: 0.05, reason: "undecided-determined" };

  // ★ ZERO DETERMINERS ACROSS MANY SIGHTINGS IS NOT "NO EVIDENCE" — it is the
  //   strongest person signal this codebase has, and the whole basis of
  //   `filterSpeakerCandidates`. A name written bare twenty times running is a
  //   person even when nothing else fired, and calling that a 0.2 guess sent
  //   real minor characters into the review queue ahead of names nobody could
  //   classify at all.
  const neverDetermined = signals.determinedCount === 0 && signals.occurrences >= 5;
  return neverDetermined
    ? { label: "character", confidence: 0.45, reason: "never-determined" }
    : { label: "character", confidence: 0.2, reason: "undecided-bare" };
}

interface ScanAndClassifyOptions {
  adaptiveContext?: AdaptiveInferenceContext;
  predictionTraceOut?: { value: AdaptivePredictionTrace[] };
  onProgress?: (progress: ScanProgress) => void;
  signal?: AbortSignal;
  yieldEvery?: number;
  semanticEntityAssist?: boolean;
}

export interface ScanProgress {
  stage: "extract" | "analyze" | "classify";
  label: string;
  detail: string;
  completed: number;
  total: number;
  fraction: number;
}

const SCAN_STAGE_WEIGHTS = {
  extract: 0.46,
  analyze: 0.34,
  classify: 0.20,
} as const;

function makeAbortError(): Error {
  const error = new Error("World scan aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw makeAbortError();
}

function stageFraction(stage: ScanProgress["stage"], completed: number, total: number): number {
  const safeTotal = Math.max(1, total);
  const local = Math.max(0, Math.min(1, completed / safeTotal));
  if (stage === "extract") return local * SCAN_STAGE_WEIGHTS.extract;
  if (stage === "analyze") return SCAN_STAGE_WEIGHTS.extract + local * SCAN_STAGE_WEIGHTS.analyze;
  return SCAN_STAGE_WEIGHTS.extract + SCAN_STAGE_WEIGHTS.analyze + local * SCAN_STAGE_WEIGHTS.classify;
}

function reportScanProgress(
  onProgress: ScanAndClassifyOptions["onProgress"],
  stage: ScanProgress["stage"],
  completed: number,
  total: number,
  detail: string,
) {
  if (!onProgress) return;
  const label =
    stage === "extract"
      ? "Reading chapters"
      : stage === "analyze"
        ? "Scoring name candidates"
        : "Classifying entities";
  onProgress({
    stage,
    label,
    detail,
    completed,
    total,
    fraction: stageFraction(stage, completed, total),
  });
}

async function yieldToMainThread() {
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

function buildExcludedNameSet(existing: WorldData | undefined): Set<string> {
  const excluded = new Set<string>();
  for (const e of [
    ...(existing?.characters ?? []),
    ...(existing?.places     ?? []),
    ...(existing?.factions   ?? []),
    ...(existing?.entities   ?? []),
  ]) {
    excluded.add(e.name.toLowerCase());
    for (const a of e.aliases ?? []) excluded.add(a.toLowerCase());
  }
  return excluded;
}

function emptySignals(name: string): EntityContextSignals {
  return {
    occurrences: 0,
    charScore: 0,
    placeScore: 0,
    factScore: 0,
    entityScore: 0,
    determinedCount: 0,
    signalHits: 0,
    totalContext: 0,
    previewBefore: "",
    previewAfter: "",
    isMultiWord: /\s/.test(name),
    hasJoiner: /['’-]/.test(name),
  };
}

function mergeSignals(target: EntityContextSignals, next: EntityContextSignals): EntityContextSignals {
  target.occurrences += next.occurrences;
  target.charScore += next.charScore;
  target.placeScore += next.placeScore;
  target.factScore += next.factScore;
  target.entityScore += next.entityScore;
  target.determinedCount += next.determinedCount;
  target.signalHits += next.signalHits;
  target.totalContext = target.charScore + target.placeScore + target.factScore + target.entityScore;
  if ((!target.previewBefore && !target.previewAfter) && (next.previewBefore || next.previewAfter)) {
    target.previewBefore = next.previewBefore;
    target.previewAfter = next.previewAfter;
  }
  return target;
}

function hasCoordinatingJoiner(name: string): boolean {
  return /\b(and|or)\b/i.test(name);
}

function containsWholeWordSequence(longerName: string, shorterName: string): boolean {
  const longerWords = longerName.toLowerCase().split(/\s+/).filter(Boolean);
  const shorterWords = shorterName.toLowerCase().split(/\s+/).filter(Boolean);
  if (shorterWords.length === 0 || shorterWords.length >= longerWords.length) return false;

  for (let index = 0; index <= longerWords.length - shorterWords.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < shorterWords.length; offset += 1) {
      if (longerWords[index + offset] !== shorterWords[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function finalizeCandidates(
  freqEntries: Array<[string, number]>,
  signalMap: Map<string, EntityContextSignals>,
  minFreq: number,
): string[] {
  const countMap = new Map(freqEntries.map(([name, count]) => [name.toLowerCase(), count]));
  const candidates = freqEntries
    .filter(([name, n]) => {
      const wordCount = name.trim().split(/\s+/).filter(Boolean).length;
      const allowLowFreqLongName = wordCount >= 3 && n >= Math.max(1, minFreq - 1);
      if (n < minFreq && !allowLowFreqLongName) return false;
      const signals = signalMap.get(name) ?? emptySignals(name);
      const idf = computeIDF(name);
      const minIdf = signals.totalContext >= CONTEXT_SIGNAL_THRESHOLD
        ? MIN_IDF_WITH_CONTEXT
        : MIN_IDF_SOLO;
      return idf >= minIdf && shouldKeepEntityCandidate(name, n, signals, minFreq);
    })
    .sort((a, b) => {
      const lengthDelta = b[0].length - a[0].length;
      if (lengthDelta !== 0) return lengthDelta;
      const aSignals = signalMap.get(a[0]) ?? emptySignals(a[0]);
      const bSignals = signalMap.get(b[0]) ?? emptySignals(b[0]);
      return candidateSortScore(b[1], computeIDF(b[0]), bSignals) - candidateSortScore(a[1], computeIDF(a[0]), aSignals);
    })
    .map(([name]) => name);

  const kept: string[] = [];
  for (const name of candidates) {
    const lc = name.toLowerCase();
    const count = countMap.get(lc) ?? 0;
    if (!kept.some((candidate) => {
      const candidateLc = candidate.toLowerCase();
      if (candidateLc === lc) return false;
      if (hasCoordinatingJoiner(candidate)) return false;
      if (!containsWholeWordSequence(candidate, name)) return false;
      return (countMap.get(candidateLc) ?? 0) >= count;
    })) {
      kept.push(name);
    }
  }

  // ★ A BARE GENERIC SUFFIX WORD IS ANAPHORA, NOT A NAME. Root-crown's scan
  //   listed "College", "Guild" and "Tower" beside "The Mycomedical College",
  //   "The Mycoflora Guild" and "The Hand Tower" — the bare word is how prose
  //   refers BACK to the named thing ("the College decided"), so it always
  //   out-counts its own full name and the count-based absorption above can
  //   never fold it. When the word alone is generic (it IS one of the suffix
  //   vocabulary words) and a kept multi-word name contains it, the bare
  //   entry is the same referent and is dropped. A bare NON-generic word
  //   ("Conclave") is left alone: it may name a thing no longer form covers.
  const isGenericSuffixWord = (word: string) =>
    !/\s/.test(word) && (
      new RegExp(`^(?:${PLACE_SUFFIX_RE.source.slice(2, -2)})$`, "i").test(word)
      || new RegExp(`^(?:${FACTION_SUFFIX_RE.source.slice(2, -2)})$`, "i").test(word)
      || new RegExp(`^(?:${ENTITY_SUFFIX_RE.source.slice(2, -2)})$`, "i").test(word)
    );
  return kept.filter((name) =>
    !(isGenericSuffixWord(name)
      && kept.some((other) => other !== name && containsWholeWordSequence(other, name))));
}

interface CastDecision {
  name: string;
  label: BucketLabel;
  confidence: number;
  determined: boolean;
  dropped?: boolean;
  spanIndex: number;
  contextBefore: string;
  contextAfter: string;
  candidates: AdaptiveCandidateOption[];
  rerankConfidence: number;
  rerankNeedsReview: boolean;
  rerankAmbiguityGap: number;
}

/**
 * ★★ THREE THINGS ONLY THE WHOLE CAST CAN SEE.
 *
 *    Every rule up to here judges one name against the prose around it, and
 *    each of these three failures is invisible from there. They run once, after
 *    every name has a label, because each one needs the OTHER names' labels as
 *    its evidence.
 *
 *    1. A SURNAME IS A PERSON. "Mosswell" appears 40 times in The Root Crown
 *       and 24 of them are "the Mosswell <something>" — the loaves, the house,
 *       the kitchen. The determiner test reads that as a common noun and
 *       evicts it from the cast, correctly by its own lights: the article in
 *       "the Mosswell loaves" really does belong to the loaves. What settles it
 *       is that "Tessa Mosswell" and "Brennan Mosswell" are in the same book,
 *       and Tessa and Brennan are already known to be people.
 *
 *    2. A FAMILY PLURAL IS THE FAMILY. "the Vells had gone home" is the Vell
 *       household, and filing it separately hands the writer two entries for
 *       one referent plus a group that never existed. Vell is already in the
 *       cast; that is the entire evidence needed.
 *
 *    3. INSTITUTIONS OF THE SAME KIND ARE THE SAME KIND OF THING. The scan put
 *       "The Closed School" in places and "The Open School" in factions, off
 *       nothing but which one more often followed a place preposition — people
 *       walk to one and the other publishes findings, and both are true of a
 *       school. A writer reads that split as the system being confused, and is
 *       right. Only fires when the members DISAGREE: consistent prose beats a
 *       vocabulary list, and the list only breaks a stalemate.
 */
function applyCastCoherence(decisions: CastDecision[], text: string): void {
  const live = () => decisions.filter((d) => !d.dropped);

  // One pass over the text for every Title-Case bigram, rather than a
  // full-text regex per candidate. 660KB, one scan.
  const followers = new Map<string, Map<string, number>>();
  const bigram = /\b([A-Z][a-z]+)[ \t]+([A-Z][a-z]+)\b/g;
  for (let m = bigram.exec(text); m; m = bigram.exec(text)) {
    const [, first, second] = m;
    let inner = followers.get(second);
    if (!inner) { inner = new Map(); followers.set(second, inner); }
    inner.set(first, (inner.get(first) ?? 0) + 1);
  }

  // 1 ── surname recovery
  const confidentPeople = new Set(
    live()
      .filter((d) => d.label === "character" && !d.determined && !/\s/.test(d.name))
      .map((d) => d.name),
  );
  for (const d of live()) {
    if (d.label === "character" || /\s/.test(d.name)) continue;
    // A generic noun that follows a name is that name's street or house, not
    // its family: "Vell Street" must not make Street a person.
    if (headVocabularyLabel(d.name)) continue;
    let givenNameHits = 0;
    for (const [first, count] of followers.get(d.name) ?? []) {
      if (confidentPeople.has(first)) givenNameHits += count;
    }
    // Two, because one is a coincidence and a surname that appears with a
    // given name only once has not been established as a family name.
    if (givenNameHits >= 2) {
      d.label = "character";
      d.confidence = Math.max(d.confidence, 0.7);
    }
  }

  // 1b ── full names
  //
  // ★★ THE SAME EVIDENCE, READ FORWARD. "Tessa Mosswell", "Halen Drust",
  //    "Anwen Vell" and "Pala Drest" appear two or three times each and never
  //    beside a speech verb, so they arrived at the decision with no context
  //    at all and were filed as characters by the bare-name default — right
  //    answer, no confidence, and NINE of the review pass's twenty-four slots
  //    spent asking the model about people it had no reason to doubt.
  //
  //    A multi-word name containing a token the cast already knows is a person
  //    is that person's full name. The head-vocabulary guard is what keeps
  //    "Kinoko Street" and "Anvas Market" out.
  for (const d of live()) {
    if (!/\s/.test(d.name) || headVocabularyLabel(d.name)) continue;
    const words = d.name.split(/\s+/).filter(Boolean);
    if (!words.some((w) => confidentPeople.has(w))) continue;
    d.label = "character";
    d.confidence = Math.max(d.confidence, 0.75);
  }

  // 2 ── family plurals
  const peopleNow = new Set(live().filter((d) => d.label === "character").map((d) => d.name));
  for (const d of live()) {
    if (/\s/.test(d.name) || !/[a-z]s$/.test(d.name)) continue;
    if (!peopleNow.has(d.name.slice(0, -1))) continue;
    // Only when it is written as a group ("the Vells"). A plural used bare is
    // doing something else and keeps its own entry.
    if (d.determined) d.dropped = true;
  }

  // 3 ── head-family coherence
  const byHead = new Map<string, CastDecision[]>();
  for (const d of live()) {
    if (!/\s/.test(d.name)) continue;
    const head = headWordOf(d.name);
    if (!headVocabularyLabel(d.name)) continue;
    const group = byHead.get(head);
    if (group) group.push(d);
    else byHead.set(head, [d]);
  }
  for (const [, group] of byHead) {
    if (group.length < 2) continue;
    if (new Set(group.map((d) => d.label)).size === 1) continue;
    const agreed = headVocabularyLabel(group[0].name);
    if (!agreed) continue;
    for (const d of group) {
      if (d.label === agreed) continue;
      d.label = agreed;
      d.confidence = Math.min(d.confidence, 0.5);
    }
  }
}

/**
 * Scans `text` for Title-Case proper-noun candidates not already in `existing`,
 * then classifies each into character / place / faction using name-internal
 * keywords and contextual signals from the surrounding prose.
 */
export async function scanAndClassify(
  text: string | string[],
  existing: WorldData | undefined,
  minFreq = 2,
  options?: ScanAndClassifyOptions,
): Promise<ScanResult> {
  const chunks = (Array.isArray(text) ? text : [text]).filter((chunk) => !!chunk);
  const excluded = buildExcludedNameSet(existing);
  const predictionTraceOut = options?.predictionTraceOut;
  const onProgress = options?.onProgress;
  const signal = options?.signal;
  const yieldEvery = Math.max(1, options?.yieldEvery ?? (chunks.length > 24 ? 2 : 1));

  const freq = new Map<string, number>();
  const perChunkFreq: Map<string, number>[] = [];
  const extractTotal = Math.max(1, chunks.length);

  reportScanProgress(onProgress, "extract", 0, extractTotal, chunks.length === 1 ? "Chapter 1 / 1" : `Chapter 0 / ${chunks.length}`);

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    throwIfAborted(signal);
    const chunk = chunks[chunkIndex];
    const chunkFreq = collectTitleCaseCandidates(chunk, 3);
    const filtered = new Map<string, number>();

    for (const [name, count] of chunkFreq) {
      if (excluded.has(name.toLowerCase())) continue;
      filtered.set(name, count);
      freq.set(name, (freq.get(name) ?? 0) + count);
    }

    perChunkFreq.push(filtered);
    reportScanProgress(
      onProgress,
      "extract",
      chunkIndex + 1,
      extractTotal,
      chunks.length === 1 ? "Chapter 1 / 1" : `Chapter ${chunkIndex + 1} / ${chunks.length}`,
    );

    if (chunkIndex + 1 < chunks.length && (chunkIndex + 1) % yieldEvery === 0) {
      await yieldToMainThread();
    }
  }

  const candidateEntries = [...freq.entries()].filter(([name, count]) => {
    if (count >= minFreq) return true;
    const wordCount = name.trim().split(/\s+/).filter(Boolean).length;
    return wordCount >= 3;
  });
  // One pass over the whole manuscript, shared by every candidate.
  const nouns = buildNounLexicon(chunks.join("\n"));
  const signalMap = new Map<string, EntityContextSignals>();
  const analyzeTotal = Math.max(1, candidateEntries.length);
  reportScanProgress(onProgress, "analyze", 0, analyzeTotal, candidateEntries.length === 0 ? "No viable candidates" : `Candidate 0 / ${candidateEntries.length}`);

  for (let candidateIndex = 0; candidateIndex < candidateEntries.length; candidateIndex += 1) {
    throwIfAborted(signal);
    const [name] = candidateEntries[candidateIndex];
    const aggregate = emptySignals(name);

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      if (!perChunkFreq[chunkIndex]?.has(name)) continue;
      mergeSignals(aggregate, computeEntityContextSignals(chunks[chunkIndex], name, nouns));
    }

    signalMap.set(name, aggregate);
    reportScanProgress(onProgress, "analyze", candidateIndex + 1, analyzeTotal, `Candidate ${candidateIndex + 1} / ${candidateEntries.length}`);

    if (candidateIndex + 1 < candidateEntries.length && (candidateIndex + 1) % yieldEvery === 0) {
      await yieldToMainThread();
    }
  }

  const kept = finalizeCandidates(candidateEntries, signalMap, minFreq);
  const fullText = chunks.join("\n");
  const result: ScanResult = { characters: [], places: [], factions: [], entities: [] };
  const decisions: CastDecision[] = [];
  if (predictionTraceOut) predictionTraceOut.value = [];

  const classifyTotal = Math.max(1, kept.length);
  reportScanProgress(onProgress, "classify", 0, classifyTotal, kept.length === 0 ? "No entities to classify" : `Entity 0 / ${kept.length}`);

  for (let keptIndex = 0; keptIndex < kept.length; keptIndex++) {
    throwIfAborted(signal);
    const name = kept[keptIndex];
    const signals = signalMap.get(name) ?? emptySignals(name);
    const charScore = signals.charScore;
    const placeScore = signals.placeScore;
    const factScore = signals.factScore;
    const entityScore = signals.entityScore;
    const previewBefore = signals.previewBefore;
    const previewAfter = signals.previewAfter;

    // ── NSS (Novel-Specificity Score) gate ────────────────────────────────
    // Suppresses common English words that happen to be Title-Cased (e.g.
    // "Thursday", "Morning", "Second") unless strong contextual evidence
    // confirms they are used as entity names in this specific text.
    const totalContext = signals.totalContext;
    const idf          = computeIDF(name);
    const minIDF       = totalContext >= CONTEXT_SIGNAL_THRESHOLD
      ? MIN_IDF_WITH_CONTEXT
      : MIN_IDF_SOLO;
    if (idf < minIDF) continue;

    const entityCandidates: AdaptiveCandidateOption[] = [
      {
        label: "character",
        source: "entity-heuristic",
        baseScore: charScore * 25 + idf * 8,
        learnedAdjustment: 0,
        finalScore: charScore * 25 + idf * 8,
        features: {
          char_score: charScore,
          place_score: placeScore,
          faction_score: factScore,
          total_context: totalContext,
          idf,
          place_suffix: PLACE_SUFFIX_RE.test(name) ? 1 : 0,
          faction_suffix: FACTION_SUFFIX_RE.test(name) ? 1 : 0,
        },
      },
      {
        label: "place",
        source: "entity-heuristic",
        baseScore: placeScore * 25 + idf * 8,
        learnedAdjustment: 0,
        finalScore: placeScore * 25 + idf * 8,
        features: {
          char_score: charScore,
          place_score: placeScore,
          faction_score: factScore,
          total_context: totalContext,
          idf,
          place_suffix: PLACE_SUFFIX_RE.test(name) ? 1 : 0,
          faction_suffix: FACTION_SUFFIX_RE.test(name) ? 1 : 0,
        },
      },
      {
        label: "faction",
        source: "entity-heuristic",
        baseScore: factScore * 25 + idf * 8,
        learnedAdjustment: 0,
        finalScore: factScore * 25 + idf * 8,
        features: {
          char_score: charScore,
          place_score: placeScore,
          faction_score: factScore,
          entity_score: entityScore,
          total_context: totalContext,
          idf,
          place_suffix: PLACE_SUFFIX_RE.test(name) ? 1 : 0,
          faction_suffix: FACTION_SUFFIX_RE.test(name) ? 1 : 0,
        },
      },
      {
        label: "entity",
        source: "entity-heuristic",
        baseScore: entityScore * 25 + idf * 8,
        learnedAdjustment: 0,
        finalScore: entityScore * 25 + idf * 8,
        features: {
          char_score: charScore,
          place_score: placeScore,
          faction_score: factScore,
          entity_score: entityScore,
          total_context: totalContext,
          idf,
          place_suffix: PLACE_SUFFIX_RE.test(name) ? 1 : 0,
          faction_suffix: FACTION_SUFFIX_RE.test(name) ? 1 : 0,
          entity_suffix: ENTITY_SUFFIX_RE.test(name) ? 1 : 0,
        },
      },
      {
        label: null,
        source: "entity-null",
        baseScore: Math.max(0, (MIN_IDF_SOLO - idf) * 40),
        learnedAdjustment: 0,
        finalScore: Math.max(0, (MIN_IDF_SOLO - idf) * 40),
        features: {
          char_score: charScore,
          place_score: placeScore,
          faction_score: factScore,
          entity_score: entityScore,
          total_context: totalContext,
          idf,
          place_suffix: PLACE_SUFFIX_RE.test(name) ? 1 : 0,
          faction_suffix: FACTION_SUFFIX_RE.test(name) ? 1 : 0,
        },
      },
    ];

    // ★ A PERSONAL NAME TAKES NO DETERMINER — the same evidence that keeps
    //   non-speakers out of attribution (filterSpeakerCandidates), read here
    //   BEFORE the buckets are compared rather than as an appeal afterwards.
    //   Measured on The Root Crown: "Lift" (18 of 20 uses are "the Lift"),
    //   "Bind" (7 of 7), "Conclave" (20 of 24) and "Mosshollow" (41 of 42) all
    //   reached the CHARACTER bucket, because character was the default a tie
    //   fell into and nothing downstream could tell a tie from a decision.
    const dr = determinerUsage(fullText, name);
    const determined = dr.occurrences >= 3 && dr.ratio >= 0.4;
    const decision = decideBucket(name, signals, determined);
    const predictedLabel = decision.label;

    const ranked = rerankAdaptiveCandidates(options?.adaptiveContext, entityCandidates, {
      task: "entity",
      spanText: name,
      contextBefore: previewBefore.slice(-120),
      contextAfter: previewAfter.slice(0, 120),
    });
    const chosenLabel = ranked.candidates[0]?.label;
    let finalLabel =
      options?.adaptiveContext && typeof chosenLabel === "string" && ranked.confidence >= 0.68
        ? chosenLabel as "character" | "place" | "faction" | "entity"
        : predictedLabel;
    finalLabel = await maybeRefineInstitutionalLabel(
      name,
      signals,
      previewBefore,
      previewAfter,
      ranked.confidence,
      finalLabel,
      options?.semanticEntityAssist,
    );

    // ★ TITLE REFERENCE IS RECOVERED IN BOTH DIRECTIONS. "the Crown Prince"
    //   and "Magister Volk" are people, and a title takes an article, so a
    //   person-headed name keeps its bucket against the suffix heuristics too.
    if (
      finalLabel !== "character"
      && (PERSON_HEAD_RE.test(name) || PERSON_LEAD_RE.test(name))
      && !PLACE_HEAD_RE.test(headWordOf(name))
      && !FACTION_HEAD_RE.test(headWordOf(name))
    ) {
      finalLabel = "character";
    }

    decisions.push({
      name,
      label: finalLabel,
      confidence: decision.confidence,
      determined,
      spanIndex: keptIndex,
      contextBefore: previewBefore.slice(-120),
      contextAfter: previewAfter.slice(0, 120),
      candidates: ranked.candidates,
      rerankConfidence: ranked.confidence,
      rerankNeedsReview: ranked.needsReview,
      rerankAmbiguityGap: ranked.ambiguityGap,
    });

    reportScanProgress(onProgress, "classify", keptIndex + 1, classifyTotal, `Entity ${keptIndex + 1} / ${kept.length}`);
    if (keptIndex + 1 < kept.length && (keptIndex + 1) % yieldEvery === 0) {
      await yieldToMainThread();
    }
  }

  applyCastCoherence(decisions, fullText);

  // ★★ THE SCAN'S OWN CONFIDENCE, NOT THE RERANKER'S, WHEN NOTHING LEARNED IS
  //    IN PLAY — AND READ AFTER THE COHERENCE PASS, NOT BEFORE IT.
  //
  //    Without an adaptive context the reranker reports the spread of four
  //    synthetic baseScores, which for a tied name is a confident-looking
  //    number attached to a coin flip. `selectReviewable` ranks on exactly
  //    this field, so the deterministic decision's own margin is what puts a
  //    genuine tie in front of the model instead of burying it under ninety
  //    names it already knows.
  //
  //    Emitting it inside the classify loop published the confidence a name
  //    had BEFORE the cast-wide rules ran, so every name those rules settled
  //    still looked like a guess and kept its slot in the queue.
  const adaptive = !!options?.adaptiveContext;
  for (const d of decisions) {
    if (d.dropped) continue;
    predictionTraceOut?.value.push({
      task: "entity",
      paragraphIndex: 0,
      spanIndex: d.spanIndex,
      spanText: d.name,
      contextBefore: d.contextBefore,
      contextAfter: d.contextAfter,
      candidates: d.candidates,
      predictedLabel: d.label,
      confidence: adaptive ? d.rerankConfidence : d.confidence,
      needsReview: adaptive ? d.rerankNeedsReview : d.confidence < 0.3,
      ambiguityGap: adaptive ? d.rerankAmbiguityGap : d.confidence,
      source: "entity-scan",
    });
    if (d.label === "faction") result.factions.push(d.name);
    else if (d.label === "place") result.places.push(d.name);
    else if (d.label === "entity") result.entities.push(d.name);
    else result.characters.push(d.name);
  }

  return result;
}

// ── Combined known-names resolver ─────────────────────────────────────────

/**
 * Type-structured entity name map — preserves the character/place/faction/entity
 * distinction so callers can route names appropriately (e.g. speech-detect only
 * receives character names; the highlight layer uses all four with type info).
 */
export interface EntityNameMap {
  /** Names + aliases of characters — the ONLY type eligible to speak dialogue. */
  characters: string[];
  /** Names + aliases of places — can be highlighted but never speak. */
  places: string[];
  /** Names + aliases of factions — can take collective action but not speak. */
  factions: string[];
  /** Names + aliases of doctrines / protocols / entities — neither speak nor act physically. */
  entities: string[];
  /** Flat union of all four lists, deduplicated, longest-first for regex building. */
  all: string[];
}

function dedup(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function collectNames(items: Array<{ name: string; aliases?: string[] }>): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.name) out.push(item.name);
    for (const a of item.aliases ?? []) if (a) out.push(a);
  }
  return out;
}

/**
 * Returns entity names grouped by type from the novel's worldData.
 * Falls back to heuristic extraction (all names as characters) when worldData
 * is absent — the fallback is intentionally lenient for untagged manuscripts.
 */
export function resolveEntityNameMap(novel: Novel): EntityNameMap {
  const wd = novel.worldData;
  if (wd && (
    (wd.characters?.length ?? 0) > 0 ||
    (wd.places?.length ?? 0)     > 0 ||
    (wd.factions?.length ?? 0)   > 0 ||
    (wd.entities?.length ?? 0)   > 0
  )) {
    const characters = dedup(collectNames(wd.characters ?? []));
    const places     = dedup(collectNames(wd.places     ?? []));
    const factions   = dedup(collectNames(wd.factions   ?? []));
    const entities   = dedup(collectNames(wd.entities   ?? []));
    // Union in type order; already-seen entries from earlier types win ties.
    const all = dedup([...characters, ...places, ...factions, ...entities]);
    return { characters, places, factions, entities, all };
  }
  // ── No worldData: the cold-start path ────────────────────────────────────
  // Everything auto-extracted used to be returned as a CHARACTER, on the
  // forgiving grounds that the writer had not categorised anything yet. But
  // `characters` is not a neutral bucket: use-analysis feeds exactly that list
  // to speech-detect as "the only type eligible to be attributed as speakers",
  // so the forgiving default quietly made every place, faction and instrument a
  // candidate speaker. Measured on the 15-book corpus, 15.2% of bare dialogue
  // lines were then attributed to an entity that never speaks in its own book.
  //
  // The determiner test splits them without a word list and without losing any
  // real speaker — see `filterSpeakerCandidates`. Non-speakers are still
  // returned (in `entities`, and so in `all`), so the highlight layer is
  // unaffected and nothing disappears from the writer's view; they are only
  // barred from holding a line of dialogue.
  const extracted = autoExtractKnownNamesFast(novel);
  const text = novel.chapters.map((c) => c.content).join("\n");
  const characters = filterSpeakerCandidates(extracted, text);
  const charSet = new Set(characters);
  const entities = extracted.filter((n) => !charSet.has(n));
  return { characters, places: [], factions: [], entities, all: extracted };
}

/**
 * Returns the deduplicated list of ALL entity names for the highlight layer.
 * Prefers world data when present, falls back to heuristic extraction.
 * World data names always come first so they win equal-length ties during
 * longest-first sorting in the highlight regex.
 */
export function resolveKnownNames(novel: Novel): string[] {
  return resolveEntityNameMap(novel).all;
}

/**
 * Of these entity names, which could plausibly be a SPEAKER?
 *
 * ★ THE PROBLEM. `resolveKnownNames` returns characters, places, factions and
 * entities as one flat list, because until a writer categorises them the
 * extractor cannot tell them apart. Speech attribution then treats every member
 * as a candidate speaker, so `Body`, `Assembly`, `Meridian` and `The Drift Belt`
 * compete for dialogue lines against the actual cast — and win. Measured on the
 * 15-book corpus: 15.2% of bare dialogue lines were attributed to an entity that
 * never speaks anywhere in its own book.
 *
 * Note this is NOT an extraction bug and cannot be fixed upstream. In the
 * manuscript where `Body` leaks, `Body` really is a capitalised in-world proper
 * noun appearing mid-sentence 74 times (`Body-A`, `Body C`). It is a correct
 * extraction of a thing that is not a person.
 *
 * ★ THE TEST: A PERSONAL NAME TAKES NO DETERMINER. English says `Nora said`, and
 * never `the Nora said`; it says `the Assembly`, `the Martians`, `the Thames`.
 * So the share of occurrences preceded by the/a/an separates people from things
 * without any word list, in any register, on invented vocabulary — the same
 * reasoning as the positional test in `collectTitleCaseCandidates`.
 *
 * ★ THE THRESHOLD IS SET BY RECALL, NOT PRECISION. Dropping a real character
 * makes every line they speak unattributable, which is far worse than admitting
 * a distractor that context usually outvotes. Measured across 446 extracted
 * entities in 15 books (label: carries an explicit speech tag somewhere in the
 * book), 0.10 drops 74 entities while losing ZERO real speakers — Martians,
 * Shimerdas, Heat-Ray, Temple, Thames, City, Oxford, Rhine, Turkey, Tank. Looser
 * thresholds admit more junk for no recall gain; combining it with a possessive
 * escape hatch (`OR takes 's`) also gained no recall and readmitted 24 entities,
 * so the rule is deliberately the single test and nothing else.
 *
 * Callers pass the widest text they have. This is cast-level work that runs once
 * in the background, never on the typing path.
 */
const DETERMINER_BEFORE_RE = /\b(?:the|a|an)\s$/i;
const MAX_DETERMINER_RATIO = 0.10;

/** How often is this name preceded by the/a/an? Shared evidence for speaker
 *  filtering (threshold 0.10, recall-first) and bucket coherence in
 *  scanAndClassify (threshold 0.4, precision-first) — same measurement, two
 *  deliberately different bars. */
export function determinerUsage(text: string, name: string): { occurrences: number; ratio: number } {
  const re = new RegExp(`(.{0,4})\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  let occurrences = 0;
  let determined = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    occurrences++;
    if (DETERMINER_BEFORE_RE.test(m[1])) determined++;
  }
  return { occurrences, ratio: occurrences === 0 ? 0 : determined / occurrences };
}

export function filterSpeakerCandidates(names: readonly string[], text: string): string[] {
  if (!text) return [...names];
  return names.filter((name) => {
    const re = new RegExp(`(.{0,4})\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    let occ = 0;
    let determined = 0;
    let bracketed = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      occ++;
      if (DETERMINER_BEFORE_RE.test(m[1])) determined++;
      // ★ A NAME THAT LIVES INSIDE SQUARE BRACKETS IS A DOCUMENT ARTIFACT.
      // Gutenberg texts carry `[Illustration: ...]`, `[Copyright ...]`,
      // `[Transcriber's note ...]` — and "Illustration" passed the determiner
      // test (nobody writes "the Illustration") straight into Pride and
      // Prejudice's cast, where it WON dialogue lines. Same family of test as
      // the determiner: no word list, positional evidence the text itself
      // supplies. Prose never brackets a person's name; markup always does.
      if (/\[\s*$/.test(m[1])) bracketed++;
    }
    if (occ === 0) return true;
    if (bracketed / occ >= 0.5) return false;
    return determined / occ < MAX_DETERMINER_RATIO;
  });
}

/**
 * Link NICKNAMES to their full names, conservatively — `Lizzy` → `Elizabeth`.
 *
 * ★ WHY. Pride and Prejudice's auto-extracted cast holds Elizabeth, Lizzy and
 * Eliza as three unrelated strings, so the engine's weights, rosters and scene
 * pairs fragment one person across three identities — and an attribution of
 * "Lizzy" scores as wrong against a tag that says "Elizabeth" although both
 * are the same woman. Aliasing is identity, and identity belongs in ONE key.
 *
 * The linker is deliberately narrow, because a wrong merge is far worse than a
 * missed one (two characters collapse into a single speaker everywhere):
 *
 *   MORPHOLOGY — the classic English hypocorism: lower-case the short form,
 *   strip a trailing y/ie/ey, collapse a doubled final consonant, and require
 *   the ≥3-letter stem to appear inside the long form. Lizzy → lizz → liz ⊂
 *   elizabeth. Kitty → kit ⊄ catherine, correctly missed: that nickname is
 *   cultural knowledge, not derivable, and guessing it would need a word list.
 *
 *   UNIQUENESS — a stem matching two different long forms links to neither.
 *
 *   COORDINATION — "X and Y" / "X or Y" anywhere in the text is proof of two
 *   people, and vetoes the pair. An author never coordinates a character with
 *   her own nickname.
 *
 * Single-token names only on both sides: multi-word forms ("Miss Bennet",
 * "Lady Catherine") encode honorific conventions where the surname names a
 * whole family, and merging those needs context no morphology supplies.
 *
 * The CANONICAL form is whichever name the text uses more (tie → the longer),
 * so downstream labels show the name the author actually favours. Returned map
 * is keyed by lower-cased trimmed name and maps EVERY member of a linked group
 * to the canonical display form.
 */
export function buildSpeakerAliasMap(
  names: readonly string[],
  text: string,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!text) return out;
  // ≥4 letters on the short side: three-letter names generate mid-word
  // substring hits ("Don" ⊂ "London") that no length-3 stem can disambiguate.
  const single = names.filter((n) => !/\s/.test(n) && n.length >= 4);
  const lowerText = text.toLowerCase();

  const stemOf = (n: string): string | undefined => {
    let st = n.toLowerCase().replace(/(?:ey|ie|y)$/, "");
    st = st.replace(/([a-z])\1$/, "$1");
    return st.length >= 3 ? st : undefined;
  };
  const countOf = (n: string): number =>
    (text.match(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g")) ?? []).length;

  for (const a of single) {
    const stem = stemOf(a);
    if (!stem) continue;
    const fulls = single.filter(
      (f) => f !== a && f.length > a.length && f.toLowerCase().includes(stem),
    );
    if (fulls.length !== 1) continue;
    const f = fulls[0];
    // A plural is a FAMILY ("the Cratchits"), not a nickname of one member.
    if (f.toLowerCase() === `${a.toLowerCase()}s` || f.toLowerCase() === `${a.toLowerCase()}es`) continue;
    const coord = new RegExp(
      `\\b(?:${a}\\s+(?:and|or)\\s+${f}|${f}\\s+(?:and|or)\\s+${a})\\b`, "i");
    if (coord.test(lowerText)) continue;
    const canonical = countOf(f) >= countOf(a) ? f : a;
    out.set(a.toLowerCase().trim(), canonical);
    out.set(f.toLowerCase().trim(), canonical);
  }
  return out;
}

/** `filterSpeakerCandidates` over a whole novel's text. */
export function resolveSpeakerCandidates(novel: Novel): string[] {
  const text = novel.chapters.map((c) => c.content).join("\n");
  return filterSpeakerCandidates(resolveKnownNames(novel), text);
}

/**
 * Lightweight current-text resolver for live highlight updates.
 *
 * Merges fast exact matches from already-known names with cheap title-case
 * extraction from the current text so entity tags can appear almost
 * immediately while the heavier chapter analysis catches up.
 */
export function resolveLiveKnownNames(text: string, seedNames: string[] = [], max = 24): string[] {
  if (!text.trim()) return [];

  const seedCanonical = new Map<string, string>();
  for (const name of seedNames) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    seedCanonical.set(trimmed.toLowerCase(), trimmed);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  const push = (name: string) => {
    const canonical = seedCanonical.get(name.toLowerCase()) ?? name;
    const key = canonical.toLowerCase();
    if (!canonical || seen.has(key)) return;
    seen.add(key);
    out.push(canonical);
  };

  for (const name of seedNames) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length < 3) continue;
    if (text.includes(trimmed)) push(trimmed);
  }

  const freq = collectTitleCaseCandidates(text, 3);
  const ranked = [...freq.entries()]
    .map(([name, occurrences]) => {
      const signals = computeEntityContextSignals(text, name);
      const idf = computeIDF(name);
      return { name, occurrences, signals, idf };
    })
    .filter(({ name, occurrences, signals, idf }) => {
      if (seen.has(name.toLowerCase())) return false;
      const wordCount = name.trim().split(/\s+/).filter(Boolean).length;
      const minIdf = signals.totalContext >= CONTEXT_SIGNAL_THRESHOLD
        ? MIN_IDF_WITH_CONTEXT
        : MIN_IDF_SOLO;
      if (idf < minIdf) return false;
      if (occurrences >= 2) return shouldKeepEntityCandidate(name, occurrences, signals, 1);
      return wordCount >= 2 && signals.totalContext >= 1.25;
    })
    .sort((a, b) => candidateSortScore(b.occurrences, b.idf, b.signals) - candidateSortScore(a.occurrences, a.idf, a.signals));

  for (const candidate of ranked) {
    push(candidate.name);
    if (out.length >= max) break;
  }

  return out.slice(0, max);
}

// ── Regex pattern builder ──────────────────────────────────────────────────

/**
 * Returns the alternation pattern string for entity matching. Caller
 * constructs `new RegExp(pattern, 'gi')` fresh per use to avoid shared
 * lastIndex issues. Longer names listed first so "Iris Valen" beats "Iris".
 */
export function buildEntityPattern(names: string[]): string | null {
  if (names.length === 0) return null;
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `\\b(?:${escaped.join("|")})\\b`;
}

// ── Rename ─────────────────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replace `oldName` with `newName` in `text`. Word-bounded and case-sensitive
 * by default — protects against false positives like renaming "Mark" turning
 * "marker" into "Bobker". Returns { text, count } so callers can display
 * what was changed.
 */
export function renameInText(text: string, oldName: string, newName: string): {
  text: string;
  count: number;
} {
  if (!oldName || oldName === newName) return { text, count: 0 };
  let count = 0;
  // \b is unreliable around accented letters / Unicode; we anchor manually
  // with character-class checks for word boundaries instead. The straight
  // apostrophe stays a WORD character (it protects O'Brien-style compounds
  // on both sides) — but that silently skipped possessives ("Sarah's coat"
  // survived a rename to Maren, found 2026-08), so `'s` at a word end is
  // allowed through explicitly. Curly-apostrophe possessives were already
  // fine (’ was never in the word class).
  const re = new RegExp(`(^|[^A-Za-z0-9_'\\u00C0-\\u024F])(${escapeRe(oldName)})(?=$|[^A-Za-z0-9_'\\u00C0-\\u024F]|'s(?:$|[^A-Za-z0-9_'\\u00C0-\\u024F]))`, "g");
  const next = text.replace(re, (_m, pre) => {
    count++;
    return pre + newName;
  });
  return { text: next, count };
}

/**
 * Rename across every chapter in the novel. Returns the patched novel and
 * a per-chapter count summary.
 */
export function renameInBook(
  novel: Novel,
  oldName: string,
  newName: string,
): { novel: Novel; total: number } {
  let total = 0;
  const chapters = novel.chapters.map((c) => {
    const { text, count } = renameInText(c.content, oldName, newName);
    total += count;
    return count > 0 ? { ...c, content: text } : c;
  });
  return { novel: { ...novel, chapters }, total };
}

// ── Entity lookup / update helpers ─────────────────────────────────────────

/**
 * Find which world-data record (and which list) holds the given name or alias.
 * Returns a path token like `characters[2]` to address it from React state.
 */
export function findEntityIndex(
  worldData: WorldData | undefined,
  name: string,
): { kind: "characters" | "places" | "factions" | "entities"; index: number } | null {
  if (!worldData || !name) return null;
  const lc = name.toLowerCase();
  const match = (
    list: { name: string; aliases?: string[] }[] | undefined,
  ): number => {
    if (!list) return -1;
    return list.findIndex(
      (e) =>
        e.name.toLowerCase() === lc ||
        (e.aliases ?? []).some((a) => a.toLowerCase() === lc),
    );
  };
  let i = match(worldData.characters);
  if (i >= 0) return { kind: "characters", index: i };
  i = match(worldData.places);
  if (i >= 0) return { kind: "places", index: i };
  i = match(worldData.factions);
  if (i >= 0) return { kind: "factions", index: i };
  i = match(worldData.entities);
  if (i >= 0) return { kind: "entities", index: i };
  return null;
}
