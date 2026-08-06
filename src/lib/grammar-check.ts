/**
 * grammar-checker.ts
 *
 * Conservative grammar, spelling, and minimal style checker for prose tools.
 * The goal is to flag clear mistakes while avoiding false positives in normal
 * English prose.
 */

export interface GrammarSuggestion {
  start: number;
  end: number;
  original: string;
  suggestion: string;
  kind:
    | "spelling"
    | "agreement"
    | "article"
    | "spacing"
    | "punctuation"
    | "capital"
    | "filter"
    | "passive"
    | "adverb"
    | "wordy"
    | "cliche"
    | "double"
    | "confusable";
  severity: "error" | "warning" | "suggestion";
}

/** Paragraph-level context for context-aware checking — when present, the
 *  checker can soften/skip rules inside dialogue speech segments where
 *  authors intentionally use colloquial or dialect speech. Coordinates are
 *  relative to the FULL text passed to checkGrammar. */
export interface GrammarContext {
  /** Half-open spans of dialogue (intra-quote) ranges. Hard agreement errors
   *  still fire here (so "they was" still flags), but stylistic rules
   *  (filter, passive, adverb, wordy, cliche) are suppressed inside speech. */
  speechSpans?: Array<{ start: number; end: number }>;
}

export interface CheckOptions {
  /** When false, omits low-importance style suggestions (filter words,
   *  passive voice, attribution adverbs, wordy phrases, clichés). Default
   *  is true so the paragraph renderer can show both tiers (high-importance
   *  ghost text always, low-importance only on hover) — see HighlightLayer
   *  for the visual distinction. */
  style?: boolean;
  /** Optional context from the speech / action detect pipelines, used to
   *  reduce false positives inside dialogue. */
  context?: GrammarContext;
}

interface RuleResult {
  suggestion: string;
  kind: GrammarSuggestion["kind"];
  severity: GrammarSuggestion["severity"];
}

interface Rule {
  pattern: RegExp;
  build: (m: RegExpExecArray) => RuleResult | null;
}

function matchCase(original: string, replacement: string): string {
  if (!original || !replacement) return replacement;
  const first = original[0];
  if (first >= "A" && first <= "Z") {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

const VOWEL_SOUND_EXCEPTIONS = new Set([
  "one",
  "once",
  "ouija",
  "useful",
  "user",
  "users",
  "using",
  "usual",
  "uniform",
  "unit",
  "united",
  "universal",
  "university",
  "unique",
  "unity",
  "ubiquitous",
  "utopia",
  "ukulele",
  "european",
  "euphemism",
  "eucalyptus",
  "ewe",
  "ewer",
  "u",
  "url",
]);

const SILENT_H_WORDS = [
  "honor",
  "honour",
  "honest",
  "hour",
  "heir",
  "homage",
];

function beginsWithVowelSound(word: string): boolean {
  if (!word) return false;

  if (/^[A-Z]-/.test(word)) {
    return "AEFHILMNORSX".includes(word[0]);
  }

  const lower = word.toLowerCase();
  if (/^[A-Z]{2,}$/.test(word)) {
    return "AEFHILMNORSX".includes(word[0]);
  }

  if (SILENT_H_WORDS.some((p) => lower.startsWith(p))) return true;
  if (VOWEL_SOUND_EXCEPTIONS.has(lower)) return false;

  const first = lower.replace(/^[^a-z]+/, "")[0];
  return !!first && "aeiou".includes(first);
}

type SpellEntry = [RegExp, string, boolean];

const SPELL_ENTRIES: SpellEntry[] = [
  [/\bteh\b/g, "the", false],
  [/\btehn\b/gi, "then", false],
  [/\bwierd\b/gi, "weird", false],
  [/\bthier\b/gi, "their", false],
  [/\bnoone\b/gi, "no one", false],
  [/\balot\b/gi, "a lot", false],
  [/\btruely\b/gi, "truly", false],
  [/\buntill\b/gi, "until", false],
  [/\bbegining\b/gi, "beginning", false],
  [/\bcomming\b/gi, "coming", false],
  [/\boccured\b/gi, "occurred", false],
  [/\boccurence(s)?\b/gi, "occurrence", true],
  [/\boccurrance(s)?\b/gi, "occurrence", true],
  [/\boccuring\b/gi, "occurring", false],
  [/\bacheiv(e|ed|ing|ment|ments|able|ably|s)?\b/gi, "achiev", true],
  [/\breciev(e|ed|s|ing|er|ers)?\b/gi, "receiv", true],
  [/\bbeleiv(e|ed|s|ing|er|ers)?\b/gi, "believ", true],
  [/\bdefinat(e|ely|eness)?\b/gi, "definit", true],
  [/\bseperat(e|ed|es|ing|ely|ions?)?\b/gi, "separat", true],
  [/\brecomend(ed|s|ing|ation|ations)?\b/gi, "recommend", true],
  [/\bdisapear(ed|s|ing|ance|ances)?\b/gi, "disappear", true],
  [/\bdisapoint(ed|s|ing|ment|ments)?\b/gi, "disappoint", true],
  [/\bdissapoint(ed|s|ing|ment|ments)?\b/gi, "disappoint", true],
  [/\bembarass(ed|es|ing|ment|ments)?\b/gi, "embarrass", true],
  [/\bharrass(ed|es|ing|ment|ments)?\b/gi, "harass", true],
  [/\baccomodat(e|ed|ing|ion|ions)?\b/gi, "accommodat", true],
  [/\bacommodat(e|ed|ing|ion|ions)?\b/gi, "accommodat", true],
  [/\baccidentaly\b/gi, "accidentally", false],
  [/\bagressive\b/gi, "aggressive", false],
  [/\bapparant\b/gi, "apparent", false],
  [/\bbecuase\b/gi, "because", false],
  [/\bbrocolli\b/gi, "broccoli", false],
  [/\bcamoflage\b/gi, "camouflage", false],
  [/\bcalender\b/gi, "calendar", false],
  [/\bcemetary\b/gi, "cemetery", false],
  [/\bcommitee\b/gi, "committee", false],
  [/\bcompletly\b/gi, "completely", false],
  [/\bconcious\b/gi, "conscious", false],
  [/\bdaugher\b/gi, "daughter", false],
  [/\bdefinately\b/gi, "definitely", false],
  [/\bdiscribe\b/gi, "describe", false],
  [/\bdrunkeness\b/gi, "drunkenness", false],
  [/\bequiptment\b/gi, "equipment", false],
  [/\benviroment(al|ally)?\b/gi, "environment", true],
  [/\bexistance\b/gi, "existence", false],
  [/\bexagerat(e|ed|ing|ion|ions)?\b/gi, "exaggerat", true],
  [/\bexagerrat(e|ed|ing|ion|ions)?\b/gi, "exaggerat", true],
  [/\bfourty\b/gi, "forty", false],
  [/\bfreind(s|ly|ship|ships)?\b/gi, "friend", true],
  [/\bforiegn\b/gi, "foreign", false],
  [/\bgaurd(ed|s|ing)?\b/gi, "guard", true],
  [/\bgoverment\b/gi, "government", false],
  [/\bgrammer\b/gi, "grammar", false],
  [/\bhieght\b/gi, "height", false],
  [/\bhygeine\b/gi, "hygiene", false],
  [/\bimediat(e|ely|ly)?\b/gi, "immediat", true],
  [/\bimmediat(e|ely|ly)?\b/gi, "immediat", true],
  [/\binconvient\b/gi, "inconvenient", false],
  [/\bindependant\b/gi, "independent", false],
  [/\bintresting\b/gi, "interesting", false],
  [/\bjewlry\b/gi, "jewelry", false],
  [/\bknowlege\b/gi, "knowledge", false],
  [/\blibary\b/gi, "library", false],
  [/\blightening\b/gi, "lightning", false],
  [/\bmaintence\b/gi, "maintenance", false],
  [/\bmaintainance\b/gi, "maintenance", false],
  [/\bmispell(ed|s|ing)?\b/gi, "misspell", true],
  [/\bneccessary\b/gi, "necessary", false],
  [/\bnecesary\b/gi, "necessary", false],
  [/\bnoticable\b/gi, "noticeable", false],
  [/\bocasion(ally|al|s)?\b/gi, "occasion", true],
  [/\bperminent\b/gi, "permanent", false],
  [/\bpersistant\b/gi, "persistent", false],
  [/\bposession\b/gi, "possession", false],
  [/\bpriviledge(d|s)?\b/gi, "privilege", true],
  [/\bproffessional\b/gi, "professional", false],
  [/\bpronounciation\b/gi, "pronunciation", false],
  [/\bquestionaire\b/gi, "questionnaire", false],
  [/\brefered\b/gi, "referred", false],
  [/\brefering\b/gi, "referring", false],
  [/\brelevent\b/gi, "relevant", false],
  [/\brember(ed|ing|s)?\b/gi, "remember", true],
  [/\brememberance\b/gi, "remembrance", false],
  [/\brestaraunt\b/gi, "restaurant", false],
  [/\brhythym\b/gi, "rhythm", false],
  [/\bsacrafice(d|s|ing)?\b/gi, "sacrific", true],
  [/\bsargent\b/gi, "sergeant", false],
  [/\bseige\b/gi, "siege", false],
  [/\bsincerly\b/gi, "sincerely", false],
  [/\bsmoe\b/gi, "some", false],
  [/\bsouvenier\b/gi, "souvenir", false],
  [/\bsubtley\b/gi, "subtly", false],
  [/\bsucceful\b/gi, "successful", false],
  [/\bsucessful\b/gi, "successful", false],
  [/\bsuccessfull\b/gi, "successful", false],
  [/\bsucess\b/gi, "success", false],
  [/\bsuprise(d|s|ingly)?\b/gi, "surprise", true],
  [/\btomarrow\b/gi, "tomorrow", false],
  [/\btomorow\b/gi, "tomorrow", false],
  [/\btommorow\b/gi, "tomorrow", false],
  [/\btruley\b/gi, "truly", false],
  [/\btwelth\b/gi, "twelfth", false],
  [/\bunfortunatly\b/gi, "unfortunately", false],
  [/\busefull\b/gi, "useful", false],
  [/\bvacum\b/gi, "vacuum", false],
  [/\bwhereever\b/gi, "wherever", false],
  [/\bwich\b/gi, "which", false],
  [/\bwithdrawl\b/gi, "withdrawal", false],
  [/\bwriteable\b/gi, "writable", false],
  [/\byeild(ed|s|ing)?\b/gi, "yield", true],
  [/\bpublically\b/gi, "publicly", false],
  [/\bparrallel\b/gi, "parallel", false],
  [/\bpeice(s)?\b/gi, "piece", true],
  [/\bstrenght\b/gi, "strength", false],
  [/\bthier\b/gi, "their", false],

  // Common doubled-consonant misses on -ed / -ing past forms. Pattern is:
  // short stressed syllable ending in single consonant should double before
  // -ed / -ing. Listed explicitly so false positives stay at zero (e.g.
  // "sloped" is legit and intentionally not in this list).
  [/\bstoped\b/gi, "stopped", false],
  [/\bstoping\b/gi, "stopping", false],
  [/\bdroped\b/gi, "dropped", false],
  [/\bdroping\b/gi, "dropping", false],
  [/\bplaned\b/gi, "planned", false],
  [/\bplaning\b/gi, "planning", false],
  [/\brunned\b/gi, "ran", false],
  [/\bgriped\b/gi, "gripped", false],
  [/\bgriping\b/gi, "gripping", false],
  [/\bswiming\b/gi, "swimming", false],
  [/\bbeging\b/gi, "begging", false],
  [/\bcuted\b/gi, "cut", false],
  [/\bputed\b/gi, "put", false],
  // Fused compounds and past-tense slips — found missing by the manuscript-
  // slip probe in scripts/test-grammar-check.ts §7. All unambiguous: none of
  // these strings is a word.
  [/\batleast\b/gi, "at least", false],
  [/\beverytime\b/gi, "every time", false],
  [/\baswell\b/gi, "as well", false],
  [/\bincase\b/gi, "in case", false],
  [/\bnevermind\b/gi, "never mind", false],
  [/\bpayed\b/gi, "paid", false],
  [/\bhappend\b/gi, "happened", false],
  [/\bbeleive(s|d)?\b/gi, "believe", true],
  [/\bfreind(s)?\b/gi, "friend", true],
  [/\bwich\b/gi, "which", false],
  [/\bthier\b/gi, "their", false],
  [/\bbecuase\b/gi, "because", false],
  [/\bdefinately\b/gi, "definitely", false],
  [/\bseperate(s|d|ly)?\b/gi, "separate", true],
  [/\boccured\b/gi, "occurred", false],
  [/\btommorow\b/gi, "tomorrow", false],
];

function makeSpellRules(): Rule[] {
  return SPELL_ENTRIES.map(([pattern, fix, hasSuffix]) => ({
    pattern,
    build(m): RuleResult | null {
      const suffix = hasSuffix ? (m[1] ?? "") : "";
      const suggestion = matchCase(m[0], fix + suffix);
      if (suggestion === m[0]) return null;
      return {
        suggestion,
        kind: "spelling",
        severity: "error",
      };
    },
  }));
}

function makeAuxRules(
  auxPattern: string,
  fixes: Array<[string, string]>,
  severity: GrammarSuggestion["severity"] = "error",
): Rule[] {
  return fixes.map(([wrong, right]) => ({
    pattern: new RegExp(`\\b(${auxPattern})\\s+${wrong}\\b`, "gi"),
    build: (m) => ({
      suggestion: matchCase(m[0], `${m[1]} ${right}`),
      kind: "agreement",
      severity,
    }),
  }));
}

function makeDidRules(fixes: Array<[string, string]>): Rule[] {
  return fixes.map(([wrong, right]) => ({
    pattern: new RegExp(`\\bdid\\s+${wrong}\\b`, "gi"),
    build: (m) => ({
      suggestion: matchCase(m[0], `did ${right}`),
      kind: "agreement",
      severity: "error",
    }),
  }));
}

const TENSE_RULES: Rule[] = [
  ...makeAuxRules("has|have|had", [
    ["went", "gone"],
    ["ran", "run"],
    ["drank", "drunk"],
    ["saw", "seen"],
    ["took", "taken"],
    ["came", "come"],
    ["ate", "eaten"],
    ["wrote", "written"],
    ["drove", "driven"],
    ["fell", "fallen"],
    ["began", "begun"],
    ["forgot", "forgotten"],
    ["broke", "broken"],
    ["chose", "chosen"],
    ["gave", "given"],
    ["swam", "swum"],
    ["layed", "laid"],
    ["done", "done"],
  ]),
  ...makeDidRules([
    ["went", "go"],
    ["ran", "run"],
    ["drank", "drink"],
    ["saw", "see"],
    ["took", "take"],
    ["came", "come"],
    ["ate", "eat"],
    ["wrote", "write"],
    ["drove", "drive"],
    ["fell", "fall"],
    ["began", "begin"],
    ["forgot", "forget"],
    ["broke", "break"],
    ["chose", "choose"],
    ["gave", "give"],
    ["swam", "swim"],
    ["done", "do"],
    ["had", "have"],
    ["was", "be"],
    ["were", "be"],
    ["seen", "see"],
    ["taken", "take"],
    ["written", "write"],
    ["driven", "drive"],
    ["broken", "break"],
    ["chosen", "choose"],
    ["begun", "begin"],
    ["forgotten", "forget"],
    ["fallen", "fall"],
  ]),
  {
    pattern: /\b(could|should|would|must|might|may)\s+of\b/gi,
    build: (m) => ({
      suggestion: matchCase(m[0], `${m[1].toLowerCase()} have`),
      kind: "agreement",
      severity: "error",
    }),
  },
  {
    pattern: /\b(he|she|it)\s+don't\b/gi,
    build: (m) => ({
      suggestion: matchCase(m[0], `${m[1]} doesn't`),
      kind: "agreement",
      severity: "error",
    }),
  },
  {
    pattern: /\b(he|she|it)\s+have\b/gi,
    build: (m) => ({
      suggestion: matchCase(m[0], `${m[1]} has`),
      kind: "agreement",
      severity: "error",
    }),
  },
  {
    pattern: /\b(he|she|it)\s+are\b/gi,
    build: (m) => ({
      suggestion: matchCase(m[0], `${m[1]} is`),
      kind: "agreement",
      severity: "warning",
    }),
  },
  {
    pattern: /\b(you|we|they)\s+was\b/gi,
    build: (m) => ({
      suggestion: matchCase(m[0], `${m[1]} were`),
      kind: "agreement",
      severity: "warning",
    }),
  },
  {
    pattern: /\b(you|we|they)\s+has\b/gi,
    build: (m) => ({
      suggestion: matchCase(m[0], `${m[1]} have`),
      kind: "agreement",
      severity: "error",
    }),
  },
  {
    pattern: /\bthere's\s+(lots|many|several|a\s+few|hundreds|thousands|millions|dozens)\s+/gi,
    build: (m) => ({
      suggestion: matchCase(m[0], `there are ${m[1]} `),
      kind: "agreement",
      severity: "warning",
    }),
  },
];

// ── Subject–verb agreement (third-person singular and plural) ─────────────
//
// Two complementary rules:
//   • Singular subject + bare verb   → suggest +s    ("she arrive" → "she arrives")
//   • Plural subject   + 3sg verb    → suggest bare  ("they walks" → "they walk")
//
// We enumerate verbs explicitly to keep false positives at zero — there's no
// general way to tell a bare verb from a noun without a parser. The list
// covers the common high-frequency offenders that show up in fiction prose.
//
// Pairs are stored as [bare, third-person-singular].

type VerbPair = [string, string];

const SVA_VERBS: VerbPair[] = [
  ["arrive", "arrives"],   ["feel", "feels"],     ["pause", "pauses"],
  ["sound", "sounds"],     ["seem", "seems"],     ["appear", "appears"],
  ["come", "comes"],       ["go", "goes"],        ["do", "does"],
  ["have", "has"],         ["run", "runs"],       ["walk", "walks"],
  ["talk", "talks"],       ["look", "looks"],     ["know", "knows"],
  ["think", "thinks"],     ["say", "says"],       ["tell", "tells"],
  ["need", "needs"],       ["want", "wants"],     ["like", "likes"],
  ["love", "loves"],       ["hate", "hates"],     ["hope", "hopes"],
  ["live", "lives"],       ["work", "works"],     ["play", "plays"],
  ["stop", "stops"],       ["start", "starts"],   ["make", "makes"],
  ["take", "takes"],       ["see", "sees"],       ["hear", "hears"],
  ["find", "finds"],       ["give", "gives"],     ["hold", "holds"],
  ["read", "reads"],       ["write", "writes"],   ["help", "helps"],
  ["wait", "waits"],       ["sit", "sits"],       ["stand", "stands"],
  ["fall", "falls"],       ["rise", "rises"],     ["move", "moves"],
  ["smile", "smiles"],     ["laugh", "laughs"],   ["sleep", "sleeps"],
  ["wake", "wakes"],       ["breathe", "breathes"], ["listen", "listens"],
  ["reach", "reaches"],    ["grab", "grabs"],     ["push", "pushes"],
  ["pull", "pulls"],       ["throw", "throws"],   ["catch", "catches"],
  ["open", "opens"],       ["close", "closes"],   ["turn", "turns"],
  ["leave", "leaves"],     ["enter", "enters"],   ["rush", "rushes"],
  ["watch", "watches"],    ["pass", "passes"],    ["miss", "misses"],
  ["wonder", "wonders"],   ["matter", "matters"], ["happen", "happens"],
  ["change", "changes"],   ["return", "returns"], ["continue", "continues"],
  ["remain", "remains"],   ["become", "becomes"], ["mean", "means"],
  ["believe", "believes"], ["remember", "remembers"], ["forget", "forgets"],
  ["call", "calls"],       ["answer", "answers"], ["ask", "asks"],
  ["whisper", "whispers"], ["shout", "shouts"],   ["bring", "brings"],
  ["carry", "carries"],    ["follow", "follows"], ["lead", "leads"],
  ["fit", "fits"],         ["differ", "differs"], ["exist", "exists"],
];

const SVA_BARE_TO_3SG = new Map<string, string>(SVA_VERBS);
const SVA_3SG_TO_BARE = new Map<string, string>(
  SVA_VERBS.map(([bare, third]) => [third, bare]),
);

function bareToThirdPattern(): string {
  return SVA_VERBS.map(([bare]) => bare).join("|");
}
function thirdToBarePattern(): string {
  return SVA_VERBS.map(([, third]) => third).join("|");
}

// Auxiliary / modal / infinitive markers that legitimately take a bare verb
// after a pronoun. Without this guard, "did he run" / "could she go" would
// incorrectly trip the (he|she|it) + bare-verb rule.
const BARE_VERB_LICENSORS = /\b(do|did|does|don't|didn't|doesn't|will|won't|would|wouldn't|could|couldn't|should|shouldn't|must|mustn't|might|may|can|can't|shall|let|to|help|helped|make|made|makes|watch|watched|see|saw|feel|felt|hear|heard|let's)\s+$/i;

// Causative/perception licensors that take "obj + bare verb": "make X seem"
// is grammatical, so "the rhythm seem" inside such a construct shouldn't trip
// the determiner-singular rule.
const CAUSATIVE_LICENSORS = /\b(make|makes|made|let|lets|let's|help|helps|helped|watch|watched|watches|see|sees|saw|seen|feel|feels|felt|hear|hears|heard|have|has|had)\s+$/i;

const SVA_RULES: Rule[] = [
  // Singular subject (he/she/it) + bare verb → 3sg form.
  // "she arrive" → "she arrives"; "it feel" → "it feels"; "She pause" → "She pauses".
  {
    pattern: new RegExp(
      `\\b(he|she|it)\\s+(${bareToThirdPattern()})\\b`,
      "gi",
    ),
    build: (m) => {
      const verb = m[2].toLowerCase();
      const fixed = SVA_BARE_TO_3SG.get(verb);
      if (!fixed) return null;
      // Skip cases where an auxiliary or modal preceded the pronoun and
      // legitimately licenses a bare verb: "did he run", "could she go",
      // "let it be", etc.
      const before = m.input.slice(Math.max(0, m.index - 12), m.index);
      if (BARE_VERB_LICENSORS.test(before)) return null;
      return {
        suggestion: matchCase(m[0], `${m[1]} ${fixed}`),
        kind: "agreement",
        severity: "error",
      };
    },
  },
  // Plural subject + 3sg verb → bare verb.
  // "they walks" → "they walk"; "we runs" → "we run"; "People rushes" → "People rush".
  {
    pattern: new RegExp(
      `\\b(they|we|you|people|men|women|children|police|cattle)\\s+(${thirdToBarePattern()})\\b`,
      "gi",
    ),
    build: (m) => {
      const verb = m[2].toLowerCase();
      const fixed = SVA_3SG_TO_BARE.get(verb);
      if (!fixed) return null;
      return {
        suggestion: matchCase(m[0], `${m[1]} ${fixed}`),
        kind: "agreement",
        severity: "error",
      };
    },
  },
  // Possessive + plural noun + 3sg verb → bare.
  // "his words comes out" → "his words come out"; "her hands shakes" → "her hands shake".
  // The plural-noun list is short and explicit so we avoid mistaking a singular
  // noun ending in -s ("his kiss feels…" — kiss is singular) for plural.
  {
    pattern: new RegExp(
      `\\b(his|her|their|my|your|our)\\s+` +
        `(words|things|hands|eyes|feet|legs|arms|fingers|teeth|lips|shoulders|knees|cheeks|ears|nails|toes|brothers|sisters|parents|friends|enemies|dreams|hopes|fears|plans|ideas|thoughts|memories|stories|secrets|reasons|questions|answers|kids|children|days|years|hours|minutes|moments|footsteps)\\s+` +
        `(${thirdToBarePattern()})\\b`,
      "gi",
    ),
    build: (m) => {
      const verb = m[3].toLowerCase();
      const fixed = SVA_3SG_TO_BARE.get(verb);
      if (!fixed) return null;
      return {
        suggestion: matchCase(m[0], `${m[1]} ${m[2]} ${fixed}`),
        kind: "agreement",
        severity: "error",
      };
    },
  },
  // Determiner + singular noun + bare verb → 3sg.
  // "the rhythm seem" → "the rhythm seems".
  // Restricted to a curated set of high-confidence sense verbs so we don't
  // misfire on imperative readings ("the rhythm, stop!").
  {
    pattern: new RegExp(
      `\\b(the|a|an|this|that|every|each)\\s+([A-Za-z][A-Za-z'\\-]+?)(?<!s)\\s+` +
        `(seem|sound|feel|appear|matter|exist|fit|differ|change|happen|continue|remain|return|become)\\b`,
      "gi",
    ),
    build: (m) => {
      const verb = m[3].toLowerCase();
      const fixed = SVA_BARE_TO_3SG.get(verb);
      if (!fixed) return null;
      // Skip when the head noun is itself a plural we know about.
      const noun = m[2].toLowerCase();
      if (
        noun === "people" || noun === "men" || noun === "women" ||
        noun === "children" || noun === "police" || noun === "cattle"
      ) return null;
      // Skip causative / perception constructs where bare verb is licensed:
      // "make the rhythm seem off", "let the music sound louder".
      const before = m.input.slice(Math.max(0, m.index - 16), m.index);
      if (CAUSATIVE_LICENSORS.test(before)) return null;
      return {
        suggestion: matchCase(m[0], `${m[1]} ${m[2]} ${fixed}`),
        kind: "agreement",
        severity: "error",
      };
    },
  },
];

const ARTICLE_RULE: Rule = {
  pattern: /\b([Aa]n?)\s+([A-Za-z][A-Za-z'\-]*)\b/g,
  build: (m) => {
    const article = m[1];
    const word = m[2];
    const isAn = article.toLowerCase() === "an";
    const wantsAn = beginsWithVowelSound(word);
    if (isAn === wantsAn) return null;
    return {
      suggestion: matchCase(article, wantsAn ? "an" : "a") + " " + word,
      kind: "article",
      severity: "error",
    };
  },
};

const CAPITAL_RULES: Rule[] = [
  {
    pattern: /(^|[^A-Za-z'])(i)(?![A-Za-z'])/g,
    build: (m) => ({
      suggestion: m[1] + "I",
      kind: "capital",
      severity: "error",
    }),
  },
  {
    pattern: /\bi('m|'ve|'ll|'d)\b/g,
    build: (m) => ({
      suggestion: "I" + m[1],
      kind: "capital",
      severity: "error",
    }),
  },
];

const PUNCT_RULES: Rule[] = [
  {
    pattern: /(?<=\S) {2,}(?=\S)/g,
    build: () => ({
      suggestion: " ",
      kind: "spacing",
      severity: "error",
    }),
  },
  {
    pattern: / +([.,;:!?])/g,
    build: (m) => ({
      suggestion: m[1],
      kind: "punctuation",
      severity: "error",
    }),
  },
  {
    pattern: / +(?=\n)/g,
    build: () => ({
      suggestion: "",
      kind: "spacing",
      severity: "error",
    }),
  },
];

const FILTER_RULE: Rule = {
  pattern: /\b(saw|noticed|watched|heard|felt|thought|wondered|realized|realised|decided|knew|remembered|seemed|observed|considered)\s+(?:that\s|what\s|how\s|a\s|an\s|the\s)/gi,
  build: (m) => ({
    suggestion: `[filter: ${m[1].toLowerCase()}]`,
    kind: "filter",
    severity: "suggestion",
  }),
};

const PASSIVE_PARTICIPLES = [
  "been",
  "seen",
  "done",
  "found",
  "made",
  "told",
  "given",
  "taken",
  "known",
  "thought",
  "brought",
  "caught",
  "taught",
  "bought",
  "sought",
  "fought",
  "held",
  "kept",
  "left",
  "sent",
  "spent",
  "built",
  "felt",
  "met",
  "said",
  "heard",
  "read",
  "led",
  "lit",
  "fit",
  "cut",
  "hit",
  "let",
  "put",
  "set",
  "shut",
  "spread",
  "shot",
  "forgotten",
  "written",
  "driven",
  "ridden",
  "spoken",
  "broken",
  "frozen",
  "stolen",
  "chosen",
  "hidden",
  "fallen",
  "forgiven",
  "shaken",
  "woken",
  "worn",
  "torn",
  "born",
  "sworn",
  "drawn",
  "grown",
  "blown",
  "thrown",
  "shown",
];

const PASSIVE_RULE: Rule = {
  pattern: new RegExp(
    `\\b(was|were|been|being|is|are|am)\\s+(?:[a-z]+ed|${PASSIVE_PARTICIPLES.join("|")})\\b`,
    "gi",
  ),
  build: (m) => ({
    suggestion: `[passive: ${m[0].toLowerCase()}]`,
    kind: "passive",
    severity: "suggestion",
  }),
};

// Adverb-on-attribution: "said softly" / "whispered loudly" — Show, don't tell.
// Limited to attribution verbs so we don't fire on every -ly adverb in prose.
const ADVERB_RULE: Rule = {
  pattern: /\b(said|asked|replied|answered|whispered|murmured|shouted|cried|called|muttered|exclaimed|stated|declared|added|remarked|continued|interrupted)\s+([a-z]+ly)\b/gi,
  build: (m) => ({
    suggestion: `[adverb: ${m[2].toLowerCase()} on "${m[1].toLowerCase()}"]`,
    kind: "adverb",
    severity: "suggestion",
  }),
};

// Wordy phrases — common bloat that can usually be tightened. Each pair is
// [pattern source, suggested replacement]. Listed as a small high-confidence
// set rather than an exhaustive style guide; false positives stay rare.
const WORDY_ENTRIES: Array<[RegExp, string]> = [
  [/\bin order to\b/gi, "to"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bdespite the fact that\b/gi, "although"],
  [/\bin spite of the fact that\b/gi, "although"],
  [/\bat this point in time\b/gi, "now"],
  [/\bat that point in time\b/gi, "then"],
  [/\bin the event that\b/gi, "if"],
  [/\bfor the purpose of\b/gi, "to"],
  [/\bin the process of\b/gi, "while"],
  [/\bat the present time\b/gi, "now"],
  [/\ba large number of\b/gi, "many"],
  [/\ba great deal of\b/gi, "much"],
  [/\bthe majority of\b/gi, "most"],
  [/\bcame to a stop\b/gi, "stopped"],
  [/\bgave a smile\b/gi, "smiled"],
  [/\bgave a nod\b/gi, "nodded"],
  [/\blet out a sigh\b/gi, "sighed"],
];

const WORDY_RULES: Rule[] = WORDY_ENTRIES.map(([pattern, fix]) => ({
  pattern,
  build: (m) => ({
    suggestion: matchCase(m[0], fix),
    kind: "wordy",
    severity: "suggestion",
  }),
}));

// Clichés — small starter set; intentionally narrow. Style suggestion tier.
const CLICHE_ENTRIES: Array<[RegExp, string]> = [
  [/\bat the end of the day\b/gi, "[cliché]"],
  [/\bin the blink of an eye\b/gi, "[cliché]"],
  [/\bonly time will tell\b/gi, "[cliché]"],
  [/\bcold as ice\b/gi, "[cliché]"],
  [/\bquiet as a mouse\b/gi, "[cliché]"],
  [/\bstrong as an ox\b/gi, "[cliché]"],
  [/\bnaked eye\b/gi, "[cliché]"],
  [/\bbottom line\b/gi, "[cliché]"],
];

const CLICHE_RULES: Rule[] = CLICHE_ENTRIES.map(([pattern, fix]) => ({
  pattern,
  build: (m) => ({
    suggestion: matchCase(m[0], fix),
    kind: "cliche",
    severity: "suggestion",
  }),
}));

// Doubled-word typo: "the the", "a a" — easy hit when editing.
const DOUBLE_RULE: Rule = {
  pattern: /\b([A-Za-z]+)\s+\1\b/g,
  build: (m) => {
    // Whitelist legitimate repetitions (had had, that that in some grammars).
    const w = m[1].toLowerCase();
    if (w === "had" || w === "that") return null;
    return {
      suggestion: m[1],
      kind: "double",
      severity: "error",
    };
  },
};

// Confusables — small explicit list. Each rule fires on one confidently-wrong
// usage. We avoid the truly context-sensitive cases (their/there/they're)
// because they need parsing to disambiguate without false positives.
const CONFUSABLE_RULES: Rule[] = [
  {
    pattern: /\byour\s+(welcome|right|wrong|here|there|gonna)\b/gi,
    build: (m) => ({
      suggestion: matchCase(m[0], `you're ${m[1]}`),
      kind: "confusable",
      severity: "warning",
    }),
  },
  {
    pattern: /\bits\s+(a|an|the|been|being|going|gonna|been|just|only)\b/gi,
    build: (m) => ({
      suggestion: matchCase(m[0], `it's ${m[1]}`),
      kind: "confusable",
      severity: "warning",
    }),
  },
  // "to" for "too" before an adjective. The adjective list deliberately
  // EXCLUDES verb homonyms (close, slow, clear, calm, empty, open, dry…)
  // because "to close the door" is an infinitive — only words that cannot
  // head an infinitive are safe to flag.
  {
    pattern: /\bto\s+(tired|late|early|heavy|hot|cold|big|small|loud|quiet|dark|old|young|deep|high|low|far|hard|expensive|important|dangerous|difficult|scared|afraid|angry|busy|serious|obvious|painful|risky|strong|weak|soon|much|many)\b(?=[\s.,;:!?]|$)/gi,
    build: (m) => ({
      suggestion: matchCase(m[0], `too ${m[1]}`),
      kind: "confusable",
      severity: "error",
    }),
  },
  // "their" for "they're" before a gerund/locative. Guarded against the
  // literary noun reading ("their coming was foretold") by refusing when a
  // verb follows.
  {
    pattern: /\btheir\s+(coming|going|leaving|staying|waiting|trying|getting|being|here|not)\b(?!\s+(?:was|is|were|are|had|has|seemed|felt))/gi,
    build: (m) => ({
      suggestion: matchCase(m[0], `they're ${m[1]}`),
      kind: "confusable",
      severity: "warning",
    }),
  },
];

const CORE_RULES: Rule[] = [
  ...makeSpellRules(),
  ...TENSE_RULES,
  ...SVA_RULES,
  ARTICLE_RULE,
  ...CAPITAL_RULES,
  ...PUNCT_RULES,
  DOUBLE_RULE,
  ...CONFUSABLE_RULES,
];

const STYLE_RULES: Rule[] = [
  FILTER_RULE,
  PASSIVE_RULE,
  ADVERB_RULE,
  ...WORDY_RULES,
  ...CLICHE_RULES,
];

const ALL_RULES: Rule[] = [...CORE_RULES, ...STYLE_RULES];

function buildRules(options: CheckOptions): Rule[] {
  return options.style !== false ? ALL_RULES : CORE_RULES;
}

const STYLE_KINDS_SET: ReadonlySet<GrammarSuggestion["kind"]> = new Set([
  "filter", "passive", "adverb", "wordy", "cliche",
]);

function inSpan(
  start: number,
  end: number,
  spans: ReadonlyArray<{ start: number; end: number }>,
): boolean {
  for (const s of spans) {
    if (start >= s.start && end <= s.end) return true;
  }
  return false;
}

/**
 * Run all enabled rules over `text`.
 *
 * Returns a sorted, non-overlapping list of suggestions. Earlier matches win
 * on overlap; on ties, longer matches win.
 *
 * Optional `options.context.speechSpans` suppresses *style* rules (filter,
 * passive, adverb, wordy, cliché) inside dialogue. Authors deliberately use
 * passive voice and stylized adverbs in dialogue and we don't want to
 * second-guess those. Hard errors (spelling, agreement, capitalization)
 * still fire inside speech — "stoped" and "they was" are wrong everywhere.
 */
export function checkGrammar(
  text: string,
  options: CheckOptions = {},
): GrammarSuggestion[] {
  if (!text) return [];

  const speechSpans = options.context?.speechSpans;

  const rules = buildRules(options);
  const all: GrammarSuggestion[] = [];

  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    let safety = 0;

    while ((m = rule.pattern.exec(text)) !== null) {
      if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
      if (++safety > 5000) break;

      const built = rule.build(m);
      if (!built) continue;

      const original = m[0];
      if (built.suggestion === original) continue;

      const start = m.index;
      const end = m.index + original.length;

      // Drop style hints inside dialogue — see doc-comment above.
      if (
        speechSpans &&
        STYLE_KINDS_SET.has(built.kind) &&
        inSpan(start, end, speechSpans)
      ) {
        continue;
      }

      all.push({
        start,
        end,
        original,
        suggestion: built.suggestion,
        kind: built.kind,
        severity: built.severity,
      });
    }
  }

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