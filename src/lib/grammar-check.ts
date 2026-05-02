// Rule-based grammar + style checker.
//
// Detects common writing errors and emits ghost-text suggestions. NOT a full
// NLP system — just a pragmatic, large list of frequent confusables, typos,
// agreement/article patterns, plus prose-style flags (filter words,
// adverb-in-attribution, body-language clichés, wordy phrases, etc.). The
// HighlightLayer renders each suggestion as small ghost text floating
// above the original, no red squiggles.
//
// Design principles:
// • Conservative on context-sensitive rules — we'd rather miss a real error
//   than constantly nag a writer with false positives. Every confusable is
//   gated on adjacent tokens that disambiguate the substitution.
// • Style suggestions ("filter", "wordy", "cliche") use a different `kind`
//   so the UI can distinguish them from outright errors and let the writer
//   keep them when intentional.
// • The whole pipeline is one regex-sweep per rule; cheap enough to run on
//   every keystroke even on long chapters.

export interface GrammarSuggestion {
  /** Absolute start offset in input text. */
  start: number;
  /** Absolute end offset (exclusive). */
  end: number;
  /** The original wrong text exactly as it appears. */
  original: string;
  /** The suggested replacement (will be displayed as ghost text). */
  suggestion: string;
  /** Short label classifying the type of issue. */
  kind:
    | "confusable"
    | "spelling"
    | "spacing"
    | "double"
    | "punctuation"
    | "agreement"
    | "article"
    | "capital"
    | "wordy"
    | "filter"
    | "passive"
    | "adverb"
    | "cliche";
}

interface Rule {
  pattern: RegExp;        // Must use the global flag.
  build: (m: RegExpExecArray) => { suggestion: string; kind: GrammarSuggestion["kind"] } | null;
}

// Helper — preserves the leading capital of `original` on the replacement.
function matchCase(original: string, replacement: string): string {
  if (!original) return replacement;
  if (original[0] === original[0].toUpperCase() && original[0] !== original[0].toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

// ─── Vowel-sound test for a/an article rule ─────────────────────────────
//
// English articles attach to the *sound* of the next word, not its spelling.
// We approximate with an opening-letter heuristic + a list of exceptions
// where the spelling lies (silent h, vowel-letter words that begin with a
// consonant sound, etc.). This is the same technique used by Hemingway and
// LanguageTool for an "a → an" warning that's right ~95% of the time on
// natural prose.

const VOWEL_SOUND_EXCEPTIONS = new Set([
  // Words that BEGIN with a consonant sound but are spelled with a vowel.
  "one", "once", "ouija", "useful", "user", "using", "uniform", "unit",
  "united", "universal", "university", "ubiquitous", "utopia", "european",
  "ewe", "ewer", "u", "uno",
]);
const SILENT_H_PREFIXES = [
  "honor", "honour", "honest", "hour", "heir", "herb", "homage",
];

function startsWithVowelSound(word: string): boolean {
  if (!word) return false;
  const lower = word.toLowerCase();
  if (SILENT_H_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (VOWEL_SOUND_EXCEPTIONS.has(lower)) return false;
  // Strip leading punctuation
  const c = lower.replace(/^[^a-z]+/, "")[0];
  return "aeiou".includes(c);
}

// ─── Misspellings: a curated list of single-correction typos ─────────────
//
// Keys are *patterns* (case-insensitive); values are the correct spelling.
// We exclude any informal/dialectal forms commonly used in fiction
// (gonna/wanna/tho/cuz/y'all/finna). Suffix-bearing rules (e.g. recieve →
// receive + suffix) live as standalone rules below.
const MISSPELLINGS: Array<[RegExp, string]> = [
  [/\bteh\b/g,                            "the"],          // (case-sensitive on purpose)
  [/\btehn\b/gi,                          "then"],
  [/\bwierd\b/gi,                         "weird"],
  [/\bthier\b/gi,                         "their"],
  [/\bsupposably\b/gi,                    "supposedly"],
  [/\birregardless\b/gi,                  "regardless"],
  [/\bnoone\b/gi,                         "no one"],
  [/\balot\b/gi,                          "a lot"],
  [/\btruely\b/gi,                        "truly"],
  [/\buntill\b/gi,                        "until"],
  [/\bbegining\b/gi,                      "beginning"],
  [/\boccured\b/gi,                       "occurred"],
  [/\boccurence\b/gi,                     "occurrence"],
  [/\boccurances\b/gi,                    "occurrences"],
  [/\bacheive(d|s|ment|ments|able)?\b/gi, "achieve"],     // suffix preserved by build() below
  [/\bcalender\b/gi,                      "calendar"],
  [/\bcemetary\b/gi,                      "cemetery"],
  [/\bchangable\b/gi,                     "changeable"],
  [/\bcollectible\b/gi,                   "collectable"], // both valid; prefer more common
  [/\bcommitee\b/gi,                      "committee"],
  [/\bcompletly\b/gi,                     "completely"],
  [/\bconcious\b/gi,                      "conscious"],
  [/\bdaugher\b/gi,                       "daughter"],
  [/\bdiscribe\b/gi,                      "describe"],
  [/\bdrunkeness\b/gi,                    "drunkenness"],
  [/\bembarass(ed|ment|es|ing)?\b/gi,     "embarrass"],
  [/\bequiptment\b/gi,                    "equipment"],
  [/\bexistance\b/gi,                     "existence"],
  [/\bfourty\b/gi,                        "forty"],
  [/\bfreind(s|ly|ship)?\b/gi,            "friend"],
  [/\bgaurd(ed|s|ing)?\b/gi,              "guard"],
  [/\bgoverment\b/gi,                     "government"],
  [/\bgrammer\b/gi,                       "grammar"],
  [/\bharrass(ed|ment|es|ing)?\b/gi,      "harass"],
  [/\bhieght\b/gi,                        "height"],
  [/\bhumourous\b/gi,                     "humorous"],
  [/\bhygeine\b/gi,                       "hygiene"],
  [/\bibelieve\b/gi,                      "I believe"],
  [/\bimediatly\b/gi,                     "immediately"],
  [/\bimediately\b/gi,                    "immediately"],
  [/\bimmediatly\b/gi,                    "immediately"],
  [/\binconvient\b/gi,                    "inconvenient"],
  [/\bindependant\b/gi,                   "independent"],
  [/\binfact\b/gi,                        "in fact"],
  [/\bintresting\b/gi,                    "interesting"],
  [/\bjewlry\b/gi,                        "jewelry"],
  [/\bjudgement\b/gi,                     "judgment"],   // US preferred
  [/\bknowlege\b/gi,                      "knowledge"],
  [/\blibary\b/gi,                        "library"],
  [/\blightening\b/gi,                    "lightning"],  // weather, not the verb
  [/\bmaintence\b/gi,                     "maintenance"],
  [/\bmaintainance\b/gi,                  "maintenance"],
  [/\bmispell(ed|s|ing)?\b/gi,            "misspell"],
  [/\bmispelling\b/gi,                    "misspelling"],
  [/\bneccessary\b/gi,                    "necessary"],
  [/\bnecesary\b/gi,                      "necessary"],
  [/\bnoticable\b/gi,                     "noticeable"],
  [/\bocasion(s|ally|al)?\b/gi,           "occasion"],
  [/\boccasion(s|ally|al)?\b/gi,          "occasion"],   // already correct, no-op via early skip
  [/\bperminent\b/gi,                     "permanent"],
  [/\bpersistant\b/gi,                    "persistent"],
  [/\bposession\b/gi,                     "possession"],
  [/\bpriviledge\b/gi,                    "privilege"],
  [/\bproffessional\b/gi,                 "professional"],
  [/\bpronounciation\b/gi,                "pronunciation"],
  [/\bquestionaire\b/gi,                  "questionnaire"],
  [/\brecomend(ed|s|ation|ing)?\b/gi,     "recommend"],
  [/\brefered\b/gi,                       "referred"],
  [/\brefering\b/gi,                      "referring"],
  [/\brelevent\b/gi,                      "relevant"],
  [/\brember(ed|ing|s)?\b/gi,             "remember"],
  [/\brememberance\b/gi,                  "remembrance"],
  [/\brestaraunt\b/gi,                    "restaurant"],
  [/\brhythym\b/gi,                       "rhythm"],
  [/\bsacrafice\b/gi,                     "sacrifice"],
  [/\bsargent\b/gi,                       "sergeant"],
  [/\bsence\b/gi,                         "since"],
  [/\bseige\b/gi,                         "siege"],
  [/\bsincerly\b/gi,                      "sincerely"],
  [/\bsixtin\b/gi,                        "sixteen"],
  [/\bsmoe\b/gi,                          "some"],
  [/\bsouvenier\b/gi,                     "souvenir"],
  [/\bsubtley\b/gi,                       "subtly"],
  [/\bsucceful\b/gi,                      "successful"],
  [/\bsucessful\b/gi,                     "successful"],
  [/\bsucess\b/gi,                        "success"],
  [/\bsuprise(d|s|ingly)?\b/gi,           "surprise"],
  [/\btomarrow\b/gi,                      "tomorrow"],
  [/\btomorow\b/gi,                       "tomorrow"],
  [/\btommorow\b/gi,                      "tomorrow"],
  [/\bthrough(out)?\b/gi,                 "through"],   // already correct, skipped
  [/\btruley\b/gi,                        "truly"],
  [/\btwelth\b/gi,                        "twelfth"],
  [/\bunfortunatly\b/gi,                  "unfortunately"],
  [/\busefull\b/gi,                       "useful"],
  [/\bvacum\b/gi,                         "vacuum"],
  [/\bwhereever\b/gi,                     "wherever"],
  [/\bwich\b/gi,                          "which"],
  [/\bwierd\b/gi,                         "weird"],
  [/\bwithdrawl\b/gi,                     "withdrawal"],
  [/\bwriteable\b/gi,                     "writable"],
  [/\byeild\b/gi,                         "yield"],
];

// ─── Filter words (style) ───────────────────────────────────────────────
// "Filter" words distance the reader from the POV character's experience.
// "She heard the door creak" → "The door creaked." etc. Flagged at the
// word level — the writer can keep them when intentional.
const FILTER_WORDS = [
  "saw", "noticed", "watched", "heard", "felt", "thought", "wondered",
  "realized", "decided", "knew", "remembered", "seemed", "looked", "appeared",
  "experienced", "observed", "considered",
];

// ─── Body-language clichés ──────────────────────────────────────────────
const BODY_CLICHES: Array<[RegExp, string]> = [
  [/\b(rolled|rolling)\s+(?:his|her|their|my|your)\s+eyes?\b/gi,            "[overused: rolling eyes]"],
  [/\b(raised|raising|cocked|cocking|arched|arching)\s+(?:an|his|her|their|my|your)\s+(?:eye)?brow\b/gi,
                                                                             "[overused: raised brow]"],
  [/\b(shrugged|shrugging)\s+(?:his|her|their|my|your)\s+shoulders?\b/gi,    "shrugged"],
  [/\b(let\s+out|heaved)\s+a\s+(?:long\s+)?(?:deep\s+)?(?:weary\s+)?breath\b/gi,
                                                                             "[overused: heavy breath]"],
  [/\b(let\s+out|heaved|gave)\s+a\s+(?:long\s+)?sigh\b/gi,                  "[overused: long sigh]"],
  [/\bnodd(?:ed|ing)\s+(?:his|her|their|my|your)\s+head\b/gi,                "nodded"],
  [/\bshook\s+(?:his|her|their|my|your)\s+head\b/gi,                         "[check: head shake — common cliché]"],
  [/\bbit\s+(?:his|her|their|my|your)\s+(?:lower\s+)?lip\b/gi,               "[overused: lip bite]"],
  [/\bclench(?:ed|ing)\s+(?:his|her|their|my|your)\s+(?:fists?|jaw|teeth)\b/gi,
                                                                             "[overused: clenched fist/jaw]"],
  [/\bran\s+(?:his|her|their|my|your)\s+(?:fingers|hand)\s+through\s+(?:his|her|their|my|your)\s+hair\b/gi,
                                                                             "[overused: fingers through hair]"],
  [/\b(?:his|her|their|my|your)\s+heart\s+(?:skipped|raced|pounded|hammered|thudded)\b/gi,
                                                                             "[overused: heart racing]"],
];

// ─── Wordy phrases (style) ──────────────────────────────────────────────
const WORDY: Array<[RegExp, string]> = [
  [/\bin\s+order\s+to\b/gi,                                  "to"],
  [/\bdue\s+to\s+the\s+fact\s+that\b/gi,                     "because"],
  [/\bowing\s+to\s+the\s+fact\s+that\b/gi,                   "because"],
  [/\bin\s+spite\s+of\s+the\s+fact\s+that\b/gi,              "although"],
  [/\bdespite\s+the\s+fact\s+that\b/gi,                      "although"],
  [/\bin\s+the\s+event\s+that\b/gi,                          "if"],
  [/\bat\s+this\s+(?:point|moment)\s+in\s+time\b/gi,         "now"],
  [/\bat\s+the\s+present\s+time\b/gi,                        "now"],
  [/\bin\s+the\s+near\s+future\b/gi,                         "soon"],
  [/\ba\s+(?:large|great)\s+number\s+of\b/gi,                "many"],
  [/\bthe\s+majority\s+of\b/gi,                              "most"],
  [/\bbasically\b/gi,                                        ""],
  [/\bactually\b/gi,                                         ""],
  [/\bliterally\b/gi,                                        ""],
  [/\bvery\s+unique\b/gi,                                    "unique"],
  [/\bcompletely\s+unique\b/gi,                              "unique"],
  [/\bend\s+result\b/gi,                                     "result"],
  [/\bfinal\s+outcome\b/gi,                                  "outcome"],
  [/\bfree\s+gift\b/gi,                                      "gift"],
  [/\bpast\s+history\b/gi,                                   "history"],
  [/\babsolutely\s+essential\b/gi,                           "essential"],
  [/\bjoin\s+together\b/gi,                                  "join"],
  [/\bcollaborate\s+together\b/gi,                           "collaborate"],
  [/\beach\s+and\s+every\b/gi,                               "every"],
  [/\bnod(?:ded|ding)?\s+(?:his|her|their|my|your)\s+head\s+yes\b/gi, "nodded"],
  [/\bsudden(?:ly)?\b/gi,                                    "[avoid: \"suddenly\"]"],
];

// ─── Confusable pairs (context-gated) ───────────────────────────────────
const CONFUSABLES: Rule[] = [
  // your → you're (before contractions or adjectives following "be")
  { pattern: /\byour\s+(welcome|right|wrong|the\s+best|amazing|so|too|not|gonna|going\s+to|going\s+|getting\s+|being\s+|never\s+gonna|always\s+|already\s+)\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `you're ${m[1]}`), kind: "confusable" }) },

  // you're → your (before nouns)
  { pattern: /\byou're\s+(book|car|house|name|friend|family|hand|face|eyes|hair|mom|dad|brother|sister|son|daughter|own|fault|turn|time|chance|problem|business|idea|fault|mind|head|body|life|home|room|place|side|self|kind|kids?|wife|husband|child(?:ren)?|partner|boss|teacher|parents?|enemies|enemy)\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `your ${m[1]}`), kind: "confusable" }) },

  // their / there
  { pattern: /\btheir\s+(is|are|was|were|will\s+be|has\s+been|isn't|aren't|wasn't|weren't|won't\s+be)\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `there ${m[1]}`), kind: "confusable" }) },
  { pattern: /\bthere\s+(own|house|car|family|book|name|friend|hand|face|mom|dad|brother|sister|kids?|home|life|own|side|fault|business|turn|time|chance|child(?:ren)?)\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `their ${m[1]}`), kind: "confusable" }) },
  { pattern: /\bthey're\s+(house|car|book|own|family|name|friend|hand|face|mom|dad|brother|sister|kids?|home|side|child(?:ren)?)\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `their ${m[1]}`), kind: "confusable" }) },

  // its / it's
  { pattern: /\bits\s+(a|an|the|going|been|just|only|too|not|gonna|so|because|like|hard|easy|time|true|fine|okay|over|done|here|there)\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `it's ${m[1]}`), kind: "confusable" }) },
  { pattern: /\bit's\s+(own|way|effect|tail|head|color|colour|name|side|edge|surface|shape|size|core|home|nature|origin|purpose|fault)\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `its ${m[1]}`), kind: "confusable" }) },

  // affect / effect
  { pattern: /\b(the|an|a|that|this|side|major|minor|adverse|positive|negative|net|primary|secondary|domino|ripple|knock-on|cumulative)\s+affect\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `${m[1]} effect`), kind: "confusable" }) },
  { pattern: /\b(it|this|that|to|will|would|may|might|could|can|does|doesn't|didn't)\s+effects\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `${m[1]} affects`), kind: "confusable" }) },

  // then / than
  { pattern: /\b(more|less|better|worse|other|rather|stronger|weaker|bigger|smaller|taller|shorter|faster|slower|older|younger|sooner|later|further|farther|harder|easier|cheaper|costlier|brighter|darker|warmer|colder|kinder|crueler)\s+then\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `${m[1]} than`), kind: "confusable" }) },

  // loose / lose
  { pattern: /\bloose\s+(the|a|my|his|her|their|your|our|it|him|her|them|control|hope|track|sight|weight|time|money|count|focus|grip|interest|patience|temper|track|touch)\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `lose ${m[1]}`), kind: "confusable" }) },

  // could of / should of / would of / must of / might of
  { pattern: /\b(could|should|would|must|might|may)\s+of\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `${m[1].toLowerCase()} have`), kind: "confusable" }) },

  // accept / except
  { pattern: /\b(everyone|everybody|all|nobody|no\s+one)\s+accept\s+(?!the\s+fact)/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `${m[1]} except `), kind: "confusable" }) },

  // who's / whose
  { pattern: /\bwho's\s+(book|car|house|name|fault|turn|side|child|kids?|wife|husband)\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `whose ${m[1]}`), kind: "confusable" }) },
  { pattern: /\bwhose\s+(coming|going|here|there|gonna|been|got|the|a|an)\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `who's ${m[1]}`), kind: "confusable" }) },

  // lay / lie (common cases)
  { pattern: /\b(?:i|he|she|they|we|you)\s+(?:was|were|am|is|are)\s+laying\s+(?:on|in|down|there|here|across)\b/gi,
    build: (m) => ({ suggestion: m[0].replace(/laying/i, (s) => s[0] === s[0].toUpperCase() ? "Lying" : "lying"), kind: "confusable" }) },
  { pattern: /\bI\s+layed\b/gi,
    build: () => ({ suggestion: "I lay", kind: "confusable" }) },

  // fewer / less
  { pattern: /\bless\s+(people|cars|books|things|chairs|tables|days|hours|minutes|seconds|times|reasons|ideas|kids|children|students|words|sentences)\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `fewer ${m[1]}`), kind: "confusable" }) },

  // amount / number  (use "number" with countable nouns)
  { pattern: /\bamount\s+of\s+(people|cars|books|things|chairs|kids|children|students|days|hours)\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `number of ${m[1]}`), kind: "confusable" }) },

  // farther / further (physical vs metaphorical)
  { pattern: /\bfurther\s+(down\s+the\s+road|away|north|south|east|west|along\s+the)\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `farther ${m[1]}`), kind: "confusable" }) },

  // emigrate / immigrate
  { pattern: /\bemigrate\s+to\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], "immigrate to"), kind: "confusable" }) },
  { pattern: /\bimmigrate\s+from\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], "emigrate from"), kind: "confusable" }) },

  // principal / principle
  { pattern: /\bschool\s+principle\b/gi,
    build: () => ({ suggestion: "school principal", kind: "confusable" }) },
  { pattern: /\bprincipal\s+of\s+the\s+matter\b/gi,
    build: () => ({ suggestion: "principle of the matter", kind: "confusable" }) },

  // stationary / stationery
  { pattern: /\bstationary\s+(store|paper|envelope)\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `stationery ${m[1]}`), kind: "confusable" }) },

  // peek / peak / pique
  { pattern: /\bpeak\s+(?:my|your|his|her|their|our)\s+(?:interest|curiosity)\b/gi,
    build: (m) => ({ suggestion: m[0].replace(/peak/i, (s) => s[0] === "P" ? "Pique" : "pique"), kind: "confusable" }) },

  // bare / bear (with the burden, repeat, etc.)
  { pattern: /\bbare\s+(with\s+me|the\s+burden|fruit|in\s+mind|witness|responsibility)\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `bear ${m[1]}`), kind: "confusable" }) },

  // sale / sail
  { pattern: /\bsale\s+(?:the|across|through|over)\s+the\s+(sea|ocean|harbor|harbour)\b/gi,
    build: (m) => ({ suggestion: m[0].replace(/sale/i, (s) => s[0] === "S" ? "Sail" : "sail"), kind: "confusable" }) },

  // breath / breathe
  { pattern: /\bI\s+can(?:'t|not)\s+breath\b/gi,
    build: () => ({ suggestion: "I can't breathe", kind: "confusable" }) },
  { pattern: /\btake\s+a\s+deep\s+breathe\b/gi,
    build: () => ({ suggestion: "take a deep breath", kind: "confusable" }) },

  // compliment / complement
  { pattern: /\bcompliment\s+each\s+other\b/gi,
    build: () => ({ suggestion: "complement each other", kind: "confusable" }) },

  // led / lead (verb past tense)
  { pattern: /\b(?:he|she|they|i|we|you)\s+lead\s+(?:the\s+way|me|us|them|him|her)\b/gi,
    build: (m) => ({ suggestion: m[0].replace(/lead/i, "led"), kind: "confusable" }) },
];

// ─── Subject-verb agreement (light) ─────────────────────────────────────
const AGREEMENT: Rule[] = [
  { pattern: /\b(he|she|it)\s+don't\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `${m[1]} doesn't`), kind: "agreement" }) },
  { pattern: /\b(he|she|it)\s+have\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `${m[1]} has`), kind: "agreement" }) },
  { pattern: /\b(he|she|it)\s+were\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `${m[1]} was`), kind: "agreement" }) },
  { pattern: /\b(I|you|we|they)\s+was\b/g,
    build: (m) => ({ suggestion: `${m[1]} were`, kind: "agreement" }) },
  // "There's lots of …" → "There are lots of …" (informal but commonly flagged)
  { pattern: /\bthere's\s+(lots|many|several|a\s+few|hundreds|thousands|millions|some)\s+/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `there are ${m[1]} `), kind: "agreement" }) },
  // "have went / has went" → "have gone / has gone"
  { pattern: /\b(has|have|had)\s+went\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `${m[1]} gone`), kind: "agreement" }) },
  // "have ran" → "have run"
  { pattern: /\b(has|have|had)\s+ran\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `${m[1]} run`), kind: "agreement" }) },
  // "have drank" → "have drunk"
  { pattern: /\b(has|have|had)\s+drank\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `${m[1]} drunk`), kind: "agreement" }) },
  // "have saw" → "have seen"
  { pattern: /\b(has|have|had)\s+saw\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `${m[1]} seen`), kind: "agreement" }) },
  // "have took" → "have taken"
  { pattern: /\b(has|have|had)\s+took\b/gi,
    build: (m) => ({ suggestion: matchCase(m[0], `${m[1]} taken`), kind: "agreement" }) },
  // "ain't" → flag (informal; suggest "isn't"/"am not"/"aren't" depending on subject; we just flag)
  { pattern: /\bain't\b/gi,
    build: () => ({ suggestion: "[informal: ain't]", kind: "agreement" }) },
];

// ─── Article rule: a/an before vowel-sound words ────────────────────────
const ARTICLE_RULE: Rule = {
  pattern: /\b([Aa]n?)\s+([A-Za-z][A-Za-z'\-]*)\b/g,
  build: (m) => {
    const article = m[1];
    const word = m[2];
    const isAn = article.toLowerCase() === "an";
    const wantsAn = startsWithVowelSound(word);
    if (wantsAn === isAn) return null;
    const fixed = wantsAn ? "an" : "a";
    return {
      suggestion: matchCase(article, fixed) + " " + word,
      kind: "article",
    };
  },
};

// ─── Capitalization ─────────────────────────────────────────────────────
//
// Two sub-rules:
//   (a) standalone lowercase pronoun "i" → "I" (not "i'm" — that's caught
//       by the contraction rule below)
//   (b) sentence-start lowercase letter after .!?
const CAP_RULES: Rule[] = [
  // Standalone "i" with whitespace boundaries.
  { pattern: /(^|[^A-Za-z'])(i)(?![A-Za-z'])/g,
    build: (m) => {
      // Don't replace if it's the very first character — there's no leading
      // group to keep — match[2] is index 0 then.
      const lead = m[1];
      return { suggestion: lead + "I", kind: "capital" };
    } },
  // "i'm / i've / i'll / i'd" → "I'm" etc.
  { pattern: /\bi('m|'ve|'ll|'d)\b/g,
    build: (m) => ({ suggestion: "I" + m[1], kind: "capital" }) },
  // Sentence-start lowercase letter after .!?
  { pattern: /([.!?])\s+([a-z])/g,
    build: (m) => ({ suggestion: `${m[1]} ${m[2].toUpperCase()}`, kind: "capital" }) },
];

// ─── Punctuation / spacing ──────────────────────────────────────────────
const PUNCT_RULES: Rule[] = [
  // Doubled space inside a sentence
  { pattern: / {2,}(?=\S)/g,
    build: () => ({ suggestion: " ", kind: "spacing" }) },
  // Space before sentence punctuation
  { pattern: / +([.,;:!?])/g,
    build: (m) => ({ suggestion: m[1], kind: "punctuation" }) },
  // Missing space after sentence punctuation (lower → upper / letter)
  { pattern: /([.!?])([A-Z][a-z])/g,
    build: (m) => ({ suggestion: `${m[1]} ${m[2]}`, kind: "spacing" }) },
  // Three+ exclamation / question marks → one
  { pattern: /!{3,}/g, build: () => ({ suggestion: "!", kind: "punctuation" }) },
  { pattern: /\?{3,}/g, build: () => ({ suggestion: "?", kind: "punctuation" }) },
  // Trailing space before paragraph break
  { pattern: / +(?=\n)/g, build: () => ({ suggestion: "", kind: "spacing" }) },
  // Two periods (likely typo, not ellipsis)
  { pattern: /(?<![.!?])\.\.(?!\.)/g,
    build: () => ({ suggestion: ".", kind: "punctuation" }) },
  // Spaced ellipsis ". . ." → "…"
  { pattern: /\. \. \./g, build: () => ({ suggestion: "…", kind: "punctuation" }) },
  // Three dots → ellipsis (style — many editors prefer the proper char)
  { pattern: /(?<![.])\.{3}(?!\.)/g,
    build: () => ({ suggestion: "…", kind: "punctuation" }) },
  // Two-hyphen pseudo-em-dash
  { pattern: /(?<!-)--(?!-)/g, build: () => ({ suggestion: "—", kind: "punctuation" }) },
  // Space-flanked hyphen between words → en-dash for ranges, em for breaks.
  // Conservative: only when both sides are letters (likely a sentence break).
  { pattern: /(\w) - (\w)/g,
    build: (m) => ({ suggestion: `${m[1]}—${m[2]}`, kind: "punctuation" }) },
];

// ─── Doubled words ──────────────────────────────────────────────────────
const DOUBLE_RULES: Rule[] = [
  { pattern: /\b(the|a|an|and|of|to|in|on|for|but|with|as|i|he|she|they|we|you|her|his|him|its|their|our|my|your|me|us|them|so|too|very|just|when|where|what|who|why|how|all|any|some|now|here|there|then|than|will|would|could|should|can|may|might|must|been|being|was|were|is|are|am|been|have|having|had|each|every|both|either|neither)\s+\1\b/gi,
    build: (m) => ({ suggestion: m[1], kind: "double" }) },
];

// ─── Filter words (style) ───────────────────────────────────────────────
const FILTER_RE = new RegExp(
  `\\b(${FILTER_WORDS.join("|")})\\b`,
  "gi",
);
const FILTER_RULE: Rule = {
  pattern: FILTER_RE,
  build: (m) => ({
    suggestion: `[filter: ${m[1].toLowerCase()}]`,
    kind: "filter",
  }),
};

// ─── Adverb-in-attribution ──────────────────────────────────────────────
//
// "she said angrily", "he whispered loudly", etc. Telling instead of
// showing. Flag the adverb only.
const ATTRIBUTION_VERBS = [
  "said", "asked", "replied", "whispered", "shouted", "yelled", "muttered",
  "cried", "sighed", "laughed", "snapped", "growled", "purred", "hissed",
  "barked", "rasped", "answered",
];
const ATTRIB_RE = new RegExp(
  `\\b(${ATTRIBUTION_VERBS.join("|")})\\s+([a-z]+ly)\\b`,
  "gi",
);
const ATTRIBUTION_ADVERB_RULE: Rule = {
  pattern: ATTRIB_RE,
  build: (m) => ({
    suggestion: `${m[1]} [show, don't tell]`,
    kind: "adverb",
  }),
};

// ─── Passive voice (light) ──────────────────────────────────────────────
//
// Pattern: form of "to be" + past participle. We match a small but high-
// signal subset (regular -ed verbs + an irregular list). The replacement
// just flags it; the writer decides whether to revise.
const IRREGULAR_PARTICIPLES = [
  "been","seen","done","gone","found","made","told","given","taken","known",
  "thought","brought","caught","taught","bought","sought","fought","held",
  "kept","left","sent","spent","built","bent","felt","met","said","heard",
  "read","led","lit","fit","cut","hit","let","put","set","shut","spread",
  "shot","forgot","gotten","written","driven","ridden","spoken","broken",
  "frozen","stolen","chosen","hidden","fallen","forbidden","forgiven",
  "shaken","woken","worn","torn","born","sworn","drawn","grown","blown",
  "thrown","known","flown","shown",
];
const PASSIVE_RE = new RegExp(
  `\\b(was|were|been|being|is|are|am|be)\\s+(?:[a-z]+ed|${IRREGULAR_PARTICIPLES.join("|")})\\b`,
  "gi",
);
const PASSIVE_RULE: Rule = {
  pattern: PASSIVE_RE,
  build: (m) => ({
    suggestion: `[passive: ${m[0].toLowerCase()}]`,
    kind: "passive",
  }),
};

// ─── Cliché phrases ─────────────────────────────────────────────────────
const CLICHE_PHRASES: Array<[RegExp, string]> = [
  [/\bat\s+the\s+end\s+of\s+the\s+day\b/gi,                 "[cliché]"],
  [/\bin\s+the\s+nick\s+of\s+time\b/gi,                     "[cliché]"],
  [/\bavoid\s+(?:like|as)\s+the\s+plague\b/gi,              "[cliché]"],
  [/\bas\s+(?:luck|fate)\s+would\s+have\s+it\b/gi,          "[cliché]"],
  [/\bonly\s+time\s+will\s+tell\b/gi,                       "[cliché]"],
  [/\bbetter\s+late\s+than\s+never\b/gi,                    "[cliché]"],
  [/\bthe\s+calm\s+before\s+the\s+storm\b/gi,               "[cliché]"],
  [/\ba\s+blessing\s+in\s+disguise\b/gi,                    "[cliché]"],
  [/\bevery\s+cloud\s+has\s+a\s+silver\s+lining\b/gi,       "[cliché]"],
  [/\bfit\s+as\s+a\s+fiddle\b/gi,                           "[cliché]"],
  [/\b(?:wide-?eyed|deer)\s+in\s+(?:the\s+)?headlights\b/gi, "[cliché]"],
  [/\bcold\s+sweat\b/gi,                                     "[cliché]"],
  [/\b(?:eyes|gaze)\s+(?:bored|drilling)\s+into\b/gi,        "[cliché]"],
  [/\bblood\s+ran\s+cold\b/gi,                               "[cliché]"],
];

// ─── Combined rules list ────────────────────────────────────────────────

const MISSPELLING_RULES: Rule[] = MISSPELLINGS.map(([re, fix]) => ({
  pattern: re,
  build: (m) => {
    // For patterns with a captured suffix group, append it.
    const suffix = m[1] ?? "";
    return { suggestion: matchCase(m[0], fix + suffix), kind: "spelling" };
  },
}));

const BODY_CLICHE_RULES: Rule[] = BODY_CLICHES.map(([re, msg]) => ({
  pattern: re,
  build: () => ({ suggestion: msg, kind: "cliche" }),
}));

const WORDY_RULES: Rule[] = WORDY.map(([re, fix]) => ({
  pattern: re,
  build: (m) => ({
    suggestion: fix === "" ? "[remove]" : matchCase(m[0], fix),
    kind: "wordy",
  }),
}));

const CLICHE_RULES: Rule[] = CLICHE_PHRASES.map(([re, msg]) => ({
  pattern: re,
  build: () => ({ suggestion: msg, kind: "cliche" }),
}));

const RULES: Rule[] = [
  // Order matters only for tie-breaking on identical start positions.
  // High-confidence spelling first so it beats overlapping style flags.
  ...MISSPELLING_RULES,
  ...CONFUSABLES,
  ...AGREEMENT,
  ARTICLE_RULE,
  ...CAP_RULES,
  ...PUNCT_RULES,
  ...DOUBLE_RULES,
  // Style suggestions last so spelling/grammar wins on overlap.
  ...WORDY_RULES,
  ATTRIBUTION_ADVERB_RULE,
  FILTER_RULE,
  PASSIVE_RULE,
  ...BODY_CLICHE_RULES,
  ...CLICHE_RULES,
];

/** Run all rules over `text`, returning a sorted, non-overlapping list of
 *  suggestions. Earlier (lower-start) matches win on overlap; on ties, a
 *  longer match wins (so phrase-level rules beat single-word rules at the
 *  same start). */
export function checkGrammar(text: string): GrammarSuggestion[] {
  if (!text) return [];

  const all: GrammarSuggestion[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    let safety = 0;
    while ((m = rule.pattern.exec(text)) !== null) {
      // Pathological zero-width match safety
      if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
      if (++safety > 5000) break;

      const built = rule.build(m);
      if (!built) continue;
      const original = m[0];
      // Skip no-op suggestions (rule already correct).
      if (built.suggestion === original) continue;
      all.push({
        start: m.index,
        end: m.index + original.length,
        original,
        suggestion: built.suggestion,
        kind: built.kind,
      });
    }
  }

  // Sort by start (asc), then by length (desc — longer wins on tie).
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out: GrammarSuggestion[] = [];
  let lastEnd = -1;
  for (const s of all) {
    if (s.start < lastEnd) continue;
    out.push(s);
    lastEnd = s.end;
  }
  return out;
}
