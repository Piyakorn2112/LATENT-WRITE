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
function collectTitleCaseCandidates(text: string, maxWords: number): Map<string, number> {
  const total = new Map<string, number>();
  const midSentence = new Map<string, number>();
  // Every word that appears LOWERCASE anywhere in this text. See isProbablyName:
  // this is the dictionary, and it is the text's own.
  const lowercaseForms = new Set<string>(text.match(/\b[a-z][a-z'-]{1,}\b/g) ?? []);
  const pattern = buildTitleCaseCandidateRe(maxWords);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
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
    if (shouldRejectCandidateName(name)) continue;
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
const FACTION_PREFIX_RE = /\b(the|house|order|guild|clan|legion|council|academy|guard|watch|union|alliance|ministry|court|brotherhood|sisterhood|syndicate|collective|committee|board)\s*$/i;
const ENTITY_PREFIX_RE = /\b(the|directive|framework|protocol|act|policy|program|system|charter|doctrine|orthodoxy|standard|authority|shell|compact|accord|network|initiative)\s*$/i;
const ENTITY_OF_RE = /\b(directive|framework|protocol|act|policy|program|system|charter|doctrine|orthodoxy|standard|authority|shell|compact|accord|network|initiative|unit|processing)\s+(?:of|for)\s*$/i;
const ENTITY_PREP_RE = /\b(under|via|per|according\s+to|pursuant\s+to)\s*$/i;
const ENTITY_AFTER_RE = /^\s*(requires|mandates|governs|defines|permits|forbids|authorizes|regulates|maintains|tracks|allocates|routes|weights|classifies|stabilizes|monitors|enforces|codifies)\b/i;

function computeEntityContextSignals(text: string, name: string): EntityContextSignals {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ctxRe = new RegExp(`([^\\n]{0,90})\\b${escaped}\\b([^\\n]{0,90})`, "gi");

  let occurrences = 0;
  let charScore = 0;
  let placeScore = 0;
  let factScore = 0;
  let entityScore = 0;
  let previewBefore = "";
  let previewAfter = "";

  if (PLACE_SUFFIX_RE.test(name)) placeScore += 4;
  if (FACTION_SUFFIX_RE.test(name)) factScore += 4;
  if (ENTITY_SUFFIX_RE.test(name)) entityScore += 4;

  let match: RegExpExecArray | null;
  while ((match = ctxRe.exec(text)) !== null) {
    const before = match[1];
    const after = match[2];
    occurrences += 1;
    if (!previewBefore && !previewAfter) {
      previewBefore = before;
      previewAfter = after;
    }

    if (CHAR_TITLE_RE.test(before))   charScore += 3;
    if (CHAR_PRONOUN_RE.test(before)) charScore += 2;
    if (CHAR_VERB_RE.test(after))     charScore += 1.25;
    if (CHAR_NAMED_RE.test(before))   charScore += 2;
    if (CHAR_POSSESSIVE_AFTER_RE.test(after)) charScore += 0.75;

    if (PLACE_PREP_RE.test(before))   placeScore += 1.25;
    if (PLACE_OF_RE.test(before))     placeScore += 2.5;

    if (/\bthe\s*$/i.test(before) && FACTION_COLLECTIVE_RE.test(after)) factScore += 2;
    if (FACTION_PREFIX_RE.test(before)) factScore += 1.5;

    if (ENTITY_PREFIX_RE.test(before)) entityScore += 1.5;
    if (ENTITY_OF_RE.test(before)) entityScore += 2.5;
    if (ENTITY_PREP_RE.test(before)) entityScore += 1.25;
    if (ENTITY_AFTER_RE.test(after)) entityScore += 1.1;
  }

  return {
    occurrences,
    charScore,
    placeScore,
    factScore,
    entityScore,
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
  if (wordCount === 1 && occurrences < Math.max(2, minFreq + 1) && strongest < 2 && signals.totalContext < 2.75) {
    return false;
  }
  if (occurrences >= minFreq + 2) return true;
  if (structural && occurrences >= minFreq) return true;
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

const ENTITY_SUFFIX_RE = /\b(directive|framework|orthodoxy|protocol|act|policy|program|system|charter|doctrine|standard|authority|shell|compact|accord|network|initiative|unit|processing|committee|commission|board|bureau|directorate|registry)\b/i;
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

// ── World data → entity map ────────────────────────────────────────────────

/**
 * Converts world data into a lookup map (lowercase key → entity) and a flat
 * list of all display names + aliases for regex building. Returns empty
 * structures for an empty/missing worldData.
 */
export function buildEntityMap(worldData: WorldData | undefined): {
  map: Map<string, WorldEntity>;
  names: string[];
} {
  const map = new Map<string, WorldEntity>();
  const names: string[] = [];
  if (!worldData) return { map, names };

  const push = (
    type: WorldEntity["type"],
    name: string,
    role?: string,
    description?: string,
    aliases?: string[],
  ) => {
    if (!name) return;
    const entity: WorldEntity = { name, type, role, description };
    map.set(name.toLowerCase(), entity);
    names.push(name);
    for (const alias of aliases ?? []) {
      if (!alias) continue;
      map.set(alias.toLowerCase(), entity);
      names.push(alias);
    }
  };

  for (const c of worldData.characters ?? []) {
    push("character", c.name, c.role, c.description, c.aliases);
  }
  for (const p of worldData.places ?? []) {
    push("place", p.name, p.type, p.description, p.aliases);
  }
  for (const f of worldData.factions ?? []) {
    push("faction", f.name, f.type, f.description, f.aliases);
  }
  for (const e of worldData.entities ?? []) {
    push("entity", e.name, e.type, e.description, e.aliases);
  }

  return { map, names };
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

const PLACE_SUFFIX_RE = /\b(forest|wood|woods|mountain|mountains|peak|ridge|valley|plains|plain|desert|island|islands|lake|river|sea|ocean|bay|gulf|cove|creek|brook|stream|falls|harbor|harbour|port|city|town|village|hamlet|castle|keep|tower|gate|bridge|road|street|avenue|square|market|hall|inn|tavern|temple|shrine|palace|manor|estate|fortress|citadel|dungeon|ruins|cave|cavern|mine|district|quarter|ward|sector|ring|zone|corridor|region|territory|province|country|land|field|fields|garden|gardens|cliff|pass|hills|hill|marsh|swamp|bog|inlet|basin|station|hub|outpost|terminal|platform|crossing|junction|checkpoint|settlement|colony|depot|compound|encampment|sanctuary|lookout)\b/i;

const FACTION_SUFFIX_RE = /\b(order|guild|house|council|brotherhood|sisterhood|society|alliance|clan|legion|corps|division|union|academy|circle|court|agency|federation|confederation|republic|dynasty|tribe|cult|sect|guard|watch|wing|militia|syndicate|collective|assembly|parliament|senate|commission|committee|board|ministry|institute|college|chapter|covenant)\b/i;

const CHAR_TITLE_RE = /\b(lord|lady|sir|captain|master|doctor|dr|father|mother|queen|king|prince|princess|elder|chief|general|colonel|major|sergeant|inspector|professor|saint)\s*$/i;

const PLACE_PREP_RE = /\b(in|at|from|to|near|through|outside|inside|across|toward|towards|beyond|into|within|upon|above|below|around|beside|along|between|past)\s*$/i;

const CHAR_VERB_RE = /^\s*(said|asked|replied|whispered|shouted|called|told|warned|answered|explained|nodded|shook|smiled|frowned|looked|stared|watched|turned|walked|ran|moved|stood|sat|fell|rose|felt|thought|knew|heard|saw|met|glanced|waved|reached|grabbed|held|spoke|cried|laughed|sighed|gasped|blinked|noticed|realized|remembered|decided|wondered|wanted|needed|found|returned|entered|left|opened|closed|pulled|pushed|drew|raised|pressed|touched|released|jumped|stepped|leaned|knelt|bowed|pointed|added|continued|interrupted)\b/i;

const CHAR_PRONOUN_RE = /\b(he|she|they|him|her)\s*$/i;

const FACTION_COLLECTIVE_RE = /^\s*(attacked|gathered|declared|sent|marched|controlled|ruled|ordered|commanded|demanded|allied|fought|held|occupied|protected|served|arrived|retreated|advanced|surrounded|captured|released|accepted|rejected|agreed|disbanded|recruited|deployed|imposed)\b/i;

export interface ScanResult {
  characters: string[];
  places:     string[];
  factions:   string[];
  entities:   string[];
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
  return kept;
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
  const signalMap = new Map<string, EntityContextSignals>();
  const analyzeTotal = Math.max(1, candidateEntries.length);
  reportScanProgress(onProgress, "analyze", 0, analyzeTotal, candidateEntries.length === 0 ? "No viable candidates" : `Candidate 0 / ${candidateEntries.length}`);

  for (let candidateIndex = 0; candidateIndex < candidateEntries.length; candidateIndex += 1) {
    throwIfAborted(signal);
    const [name] = candidateEntries[candidateIndex];
    const aggregate = emptySignals(name);

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      if (!perChunkFreq[chunkIndex]?.has(name)) continue;
      mergeSignals(aggregate, computeEntityContextSignals(chunks[chunkIndex], name));
    }

    signalMap.set(name, aggregate);
    reportScanProgress(onProgress, "analyze", candidateIndex + 1, analyzeTotal, `Candidate ${candidateIndex + 1} / ${candidateEntries.length}`);

    if (candidateIndex + 1 < candidateEntries.length && (candidateIndex + 1) % yieldEvery === 0) {
      await yieldToMainThread();
    }
  }

  const kept = finalizeCandidates(candidateEntries, signalMap, minFreq);
  const result: ScanResult = { characters: [], places: [], factions: [], entities: [] };
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

    const max = Math.max(charScore, placeScore, factScore, entityScore);
    let predictedLabel: "character" | "place" | "faction" | "entity" = "character";
    if (entityScore === max && entityScore > Math.max(charScore, placeScore, factScore)) predictedLabel = "entity";
    else if (factScore === max && factScore > Math.max(charScore, placeScore, entityScore)) predictedLabel = "faction";
    else if (placeScore === max && placeScore > Math.max(charScore, factScore, entityScore)) predictedLabel = "place";

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

    predictionTraceOut?.value.push({
      task: "entity",
      paragraphIndex: 0,
      spanIndex: keptIndex,
      spanText: name,
      contextBefore: previewBefore.slice(-120),
      contextAfter: previewAfter.slice(0, 120),
      candidates: ranked.candidates,
      predictedLabel: finalLabel,
      confidence: ranked.confidence,
      needsReview: ranked.needsReview,
      ambiguityGap: ranked.ambiguityGap,
      source: "entity-scan",
    });

    if (finalLabel === "faction") result.factions.push(name);
    else if (finalLabel === "place") result.places.push(name);
    else if (finalLabel === "entity") result.entities.push(name);
    else result.characters.push(name);

    reportScanProgress(onProgress, "classify", keptIndex + 1, classifyTotal, `Entity ${keptIndex + 1} / ${kept.length}`);
    if (keptIndex + 1 < kept.length && (keptIndex + 1) % yieldEvery === 0) {
      await yieldToMainThread();
    }
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
  // with character-class checks for word boundaries instead.
  const re = new RegExp(`(^|[^A-Za-z0-9_'\\u00C0-\\u024F])(${escapeRe(oldName)})(?=$|[^A-Za-z0-9_'\\u00C0-\\u024F])`, "g");
  const next = text.replace(re, (_m, pre) => {
    count++;
    return pre + newName;
  });
  return { text: next, count };
}

/**
 * Rename across a single chapter's content. Returns the patched content
 * and the replacement count.
 */
export function renameInChapter(
  chapter: { content: string },
  oldName: string,
  newName: string,
): { content: string; count: number } {
  const { text, count } = renameInText(chapter.content, oldName, newName);
  return { content: text, count };
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
