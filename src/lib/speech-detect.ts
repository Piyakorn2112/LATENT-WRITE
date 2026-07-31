// @ts-nocheck — vendored copy; suppress unused-variable errors from the original source
import { rerankAdaptiveCandidates } from "./adaptive-inference";
/**
 * speech-detect.ts  (v2 — smarter attribution)
 *
 * Key improvements over v1:
 *  - type: 'speech' | 'narrative' — quotes with no speech verb nearby get
 *    the 'narrative' type (rendered in neutral grey) instead of the accent
 *    colour, preventing false-positive dialogue highlights.
 *  - Priority-based speaker attribution:
 *      1. Direct trailing attribution  ("quote," Name verb.)
 *      2. Direct leading attribution   (Name verb, "quote")
 *      3. Pronoun interpolation        (she/he/they → recency weights)
 *      4. Extended context             (prev 2 paragraphs, lower confidence)
 *  - Markov-style recency weights: speak/mention weights decay per paragraph
 *    so the most-recently-active character wins ambiguous pronoun resolution.
 *  - Active-subject tracking: the first named entity in a paragraph's opening
 *    clause is tracked as the "active subject", boosting pronoun resolution.
 *  - Generic speaker library: "officer", "guard", "voice", "system", etc. are
 *    attributed when they are the unambiguous subject of a speech verb.
 *  - 3-paragraph context window at the chapter level (prev 2 + next 1 para).
 */

/**
 * Three analysis tiers controlling the accuracy/overhead trade-off.
 *
 * 'fast'    — ~85% accuracy of default. Skips gender pre-pass and scene
 *             grouping; narrower context windows (1 para extCtx, 3-speaker
 *             recency window). Optimized for minimal scan time.
 * 'default' — Balanced (existing behaviour). 2-para extCtx, 5-speaker
 *             recency window, full gender map, scene grouping.
 * 'high'    — Maximum accuracy. 3-para extCtx, 8-speaker recency window,
 *             lowered pronoun-resolution threshold, wider sibling context.
 */
export type IntelligenceLevel = 'fast' | 'default' | 'high';

export interface ChapterEndContext {
  speakWeights: Map<string, number>;
  mentionWeights: Map<string, number>;
  activeSubject: string | undefined;
  recentSpeakers: string[];
  finalTensionAvg: number;
}

export interface SpeechDetectOptions {
  intelligenceLevel?: IntelligenceLevel;
  /** Seed weights and state from a previous chapter's end. */
  prevChapterContext?: ChapterEndContext;
  /** Box to receive the final weights and state at the end of this chapter. */
  contextOut?: { value: ChapterEndContext | null };
  /**
   * Learned bias derived from the annotation store.
   * Applied additively to speakWeights init, pronoun resolution, and
   * speaker-transition scoring. Undefined → pure existing behaviour.
   */
  learnedBias?: import("../types").LearnedBias;
  /** Optional adaptive ranker + memory layer layered on top of the rules. */
  adaptiveContext?: import("../types").AdaptiveInferenceContext;
  /** Collects per-span prediction traces for feedback logging. */
  predictionTraceOut?: { value: import("../types").AdaptivePredictionTrace[] };
}

export interface SpeechSegment {
  /** Start index inside the paragraph text string */
  start: number;
  /** End index (exclusive) */
  end: number;
  /** Best-guess speaker name, if determinable from attribution */
  speaker?: string;
  /**
   * True when this paragraph starts mid-quote (no opening quotation mark)
   * because the previous paragraph's quote was left intentionally unclosed.
   */
  continuation?: boolean;
  /**
   * 'speech'    → real dialogue; rendered with the accent / speaker colour.
   * 'narrative' → embedded / reported / conceptual quote (no speech verb
   *               nearby); rendered with the neutral grey system colour.
   */
  type: 'speech' | 'narrative';
  /**
   * Attribution confidence 0–1.  High (≥0.65) → display speaker name normally.
   * Low (<0.65) → display as uncertain ("? Name", dimmed/italic).
   * 0 = no speaker attributed, or narrative.
   */
  confidence: number;
}

/** Paragraph-level tension and dialogue density metadata. */
export interface ParagraphMeta {
  /** Overall tension signal for this paragraph. */
  tension: 'calm' | 'rising' | 'high';
  /** Per-paragraph tension label (used internally and as scene-label source). */
  label?: string;
  /** Ratio of speech characters to total paragraph characters (0–1). */
  dialogueDensity: number;
  /** Quality hint for calm paragraphs — aggregated by groupIntoScenes for scene labels. */
  paragraphHint?: 'reflective' | 'intimate' | 'celebratory' | 'weighted' | 'significant';
  // ── Scene-level fields (set by groupIntoScenes post-pass) ──
  /** True on the first paragraph of a detected scene group. */
  sceneStart?: boolean;
  /** Human-readable scene label shown as the scene header. */
  sceneLabel?: string;
  /** Dominant tension across the scene (drives header colour). */
  sceneTension?: 'calm' | 'rising' | 'high';
}

/** One paragraph's output: its speech segments + paragraph-level metadata. */
export interface ChapterParaResult {
  segments: SpeechSegment[];
  meta: ParagraphMeta;
}

// ── Constants ─────────────────────────────────────────────────────────────

const OPEN_DOUBLE  = '\u201C';
const CLOSE_DOUBLE = '\u201D';
const OPEN_SINGLE  = '\u2018';
const CLOSE_SINGLE = '\u2019';
const ASCII_DOUBLE = '"';

// Guillemet quotes — common in translated light novels / European prose
const OPEN_GUILLEMET  = '\u00AB';  // «
const CLOSE_GUILLEMET = '\u00BB';  // »

// Em-dash dialogue opening — Russian/European/translated LN convention
// e.g. "— I don't think so, — she said."
const EM_DASH = '\u2014';  // —

// Local window: speech verb must appear within this distance of the quote
// for it to count as real dialogue (not narrative embedding).
const LOCAL_VERB_WINDOW = 80;

// Markov recency decay per paragraph
const DECAY_SPEAK   = 0.80;
const DECAY_MENTION = 0.82;

// Minimum total score for pronoun resolution (prevents resolution on empty state)
const PRONOUN_MIN_SCORE = 18;

// Minimum posterior probability to emit a speaker attribution.
// Above 0.40 → confident (confidence = topProb × 0.85)
// 0.25–0.40  → uncertain (confidence = topProb × 0.50, renders as "? Name")
// Below 0.25 → truly ambiguous, emit unknown
const PRONOUN_MIN_POSTERIOR = 0.25;

// Max proportional bonus for the character who dominated the preceding
// paragraph — scales by their actual focus dominance ratio (0–1) × 120
// so a character with 3/3 mentions gets +120, one with 1/3 gets +40.
const NARRATIVE_FOCUS_MAX = 120;

// ── Speech attribution verbs ──────────────────────────────────────────────

const SPEECH_VERBS = [
  'said','says','say','asked','ask','replied','reply','answered','answer',
  'whispered','whisper','called','call','continued','continue','added','add',
  'began','begin','insisted','insist','murmured','murmur','told','tell',
  'shouted','shout','noted','note','observed','observe','thought','think',
  'wondered','wonder','admitted','admit','agreed','agree','announced','announce',
  'demanded','demand','exclaimed','exclaim','explained','explain','gasped','gasp',
  'laughed','laugh','muttered','mutter','offered','offer','ordered','order',
  'promised','promise','repeated','repeat','sighed','sigh','snapped','snap',
  'spoke','speak','stated','state','suggested','suggest','urged','urge',
  'warned','warn','breathed','breathe','hissed','hiss','cried','cry',
  'interrupted','interrupt','responded','respond','called','yelled','yell',
  // Extended for wider genre coverage (isekai, fantasy, LN, thriller)
  'growled','growl','scoffed','scoff','pleaded','plead','conceded','concede',
  'declared','declare','groaned','groan','whimpered','whimper','stammered','stammer',
  'stuttered','stutter','bellowed','bellow','chanted','chant','recited','recite',
  'remarked','remark','quipped','quip','taunted','taunt','teased','tease',
  'countered','counter','interjected','interject','protested','protest',
  'mumbled','mumble','rasped','rasp','croaked','croak','blurted','blurt',
];

const SPEECH_VERB_PAT = `(?:${SPEECH_VERBS.join('|')})`;

/**
 * Does this trailing text carry an EXPLICIT attribution tag — a speech verb
 * followed by something that names the speaker?
 *
 * Used to make inference yield to evidence. A carried subject, an alternation
 * guess or any other inferred speaker is the right answer when the text says
 * nothing; it is never the right answer when the text says "said the child" two
 * characters later.
 */
/**
 * Pull the speaker out of an explicit DEFINITE-DESCRIPTION tag — "said the
 * blacksmith" -> "Blacksmith".
 *
 * `GENERIC_SPEAKERS` is a whitelist, and a whitelist of the nouns fiction uses
 * for people can never be finished: extending it from a measured failure list
 * took definite-description precision 78% -> 89%, and the corpus still leaves 39
 * quotes UNATTRIBUTED because their noun is not on it (blacksmith, sexton,
 * turnkey, ostler...). Every one of those is a quote whose speaker the text
 * states outright.
 *
 * The grammar is doing the work here, not a word list: a determiner plus a
 * common noun in the attribution slot of a speech verb IS a speaker reference,
 * whatever the noun. Bounded to that slot, so ordinary prose cannot reach it.
 */
const NOT_A_SPEAKER_NOUN = new Set([
  "truth", "word", "words", "same", "rest", "matter", "reason", "thing",
  "things", "way", "time", "other", "others", "one", "two", "first", "last",
  "moment", "night", "morning", "day", "end", "door", "room", "house",
]);
function speakerFromDescriptiveTag(after: string): string | undefined {
  const m = new RegExp(
    `^${TAG_LEAD}\\b(?:${SPEECH_VERBS.join("|")})\\b\\s+(?:the|a|an)\\s+((?:old|young|little|tall|short|fat|thin|grey|gray|white|black)\\s+)?([a-z][a-z-]{2,})\\b`,
    "i",
  ).exec(after);
  if (!m) return undefined;
  const noun = m[2].toLowerCase();
  if (NOT_A_SPEAKER_NOUN.has(noun)) return undefined;
  const adj = m[1] ? m[1].trim().toLowerCase() : "";
  const phrase = adj ? `${adj} ${noun}` : noun;
  return phrase.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

const TAG_LEAD = "[\\s,.:;\\u2014\\u2013\\u201c\\u201d\\u2018\\u2019\"']*";
function hasExplicitTrailingTag(after: string): boolean {
  // Speech verb followed by a determiner or honorific \u2014 "said the child",
  // "said Mr. Wilson". Case-insensitive.
  const descriptive = new RegExp(
    `^${TAG_LEAD}\\b${SPEECH_VERB_PAT}\\b\\s+(?:the|a|an|Mr|Mrs|Ms|Miss|Dr|Prof|Rev|Sir|Lord|Lady|Madam|Master)\\b`,
    "i",
  );
  // Speech verb followed by a capitalised name \u2014 "said Belle". Case-SENSITIVE,
  // because the capital is the whole signal.
  const named = new RegExp(`^${TAG_LEAD}\\b(?:${SPEECH_VERBS.join("|")})\\b\\s+[A-Z][a-z']{2,}`);
  return descriptive.test(after) || named.test(after);
}

/** Honorifics that carry an abbreviating period, which reads as a sentence end. */
const HONORIFIC_PAT = "(?:Mr|Mrs|Ms|Miss|Dr|Prof|Rev|St|Capt|Col|Sgt|Lt|Gen|Sir|Lady|Lord|Madam|Master|Mister)";


// (?<!to ) excludes bare infinitives like "to ask", "to say" which are NOT speech attribution
const SPEECH_VERB_RE  = new RegExp(`(?<!to )\\b${SPEECH_VERB_PAT}\\b`, 'i');

// Pronoun + (optional words) + speech verb  e.g. "she said", "he quietly asked"
const PRONOUN_RE = new RegExp(
  `\\b(she|he|they|it)\\b(?:\\s+\\w+){0,4}\\s+\\b${SPEECH_VERB_PAT}\\b`,
  'i',
);

// ── Generic speaker library ───────────────────────────────────────────────
// These are attributed ONLY when they are the unambiguous grammatical subject
// or direct object of a speech verb (strict matching to avoid false positives).

const GENERIC_SPEAKERS: readonly string[] = [
  'officer','guard','soldier','sergeant','captain','commander',
  'staff','attendant','receptionist','technician','medic','doctor',
  'voice','announcement','broadcast','intercom','system','terminal',
  'man','woman','figure','stranger','visitor',
  'administrator','official','representative','delegate',
  // Title-prefix generics (Fix A: NER expansion for institutional/sci-fi prose)
  'director','inspector','warden','prefect','professor','dean',
  'coordinator','supervisor','overseer','liaison','analyst','handler',
  // Genre-fiction additions: isekai, fantasy, sci-fi
  'knight','priest','priestess','mage','wizard','sage','elder',
  'king','queen','prince','princess','lord','lady',
  'merchant','innkeeper','guild master','adventurer','demon',
  // ★ 19th-century and domestic prose, added from a MEASURED failure list.
  // test:attribution-corpus scored definite-description attribution at 77.1%
  // precision, and every single correct case hit this whitelist — so its
  // coverage IS the accuracy. The 41 failures were nouns simply missing from it,
  // collected across dickens, stoker, stevenson, austen and montgomery rather
  // than imagined: a corpus of Victorian and children's fiction refers to people
  // by role and relation far more than the institutional/sci-fi registers this
  // list was originally built for.
  'child','boy','girl','lad','lass','gentleman','gentlewoman',
  'ghost','spirit','phantom','apparition','shade',
  'squire','nephew','niece','cousin','aunt','uncle',
  'clerk','landlord','landlady','housekeeper','maid','servant','butler',
  'policeman','constable','magistrate','lawyer','solicitor',
  'lieutenant','beggar','sailor','seaman','coachman','driver','porter',
  'old man','old woman','young man','young lady','little girl','little boy',
  'narrator','operator','ai','assistant','instructor','mentor',
];

// ── Helpers ───────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function normKey(s: string): string {
  return s.toLowerCase().trim();
}

class NameRegexCache {
  private wordBoundary = new Map<string, RegExp>();
  private wordBoundaryNoPoss = new Map<string, RegExp>();
  private mentionGi = new Map<string, RegExp>();
  private possessiveStart = new Map<string, RegExp>();
  private immediateStart = new Map<string, RegExp>();
  private voiceRe = new Map<string, RegExp>();
  private objTestRe = new Map<string, RegExp>();
  private directFwdRe = new Map<string, RegExp>();
  private directInvRe = new Map<string, RegExp>();

  getWordBoundary(name: string): RegExp {
    let re = this.wordBoundary.get(name);
    if (!re) {
      re = new RegExp(`\\b${esc(name)}\\b`, 'i');
      this.wordBoundary.set(name, re);
    }
    return re;
  }

  getWordBoundaryNoPoss(name: string): RegExp {
    let re = this.wordBoundaryNoPoss.get(name);
    if (!re) {
      re = new RegExp(`\\b${esc(name)}\\b(?!['\\u2018\\u2019]s)`, 'i');
      this.wordBoundaryNoPoss.set(name, re);
    }
    return re;
  }

  getMentionGi(name: string): RegExp {
    let re = this.mentionGi.get(name);
    if (!re) {
      re = new RegExp(`\\b${esc(name)}\\b`, 'gi');
      this.mentionGi.set(name, re);
    }
    return re;
  }

  getPossessiveStart(name: string): RegExp {
    let re = this.possessiveStart.get(name);
    if (!re) {
      re = new RegExp(`^\\s*${esc(name)}['\\u2019]s?\\b`, 'i');
      this.possessiveStart.set(name, re);
    }
    return re;
  }

  getImmediateStart(name: string): RegExp {
    let re = this.immediateStart.get(name);
    if (!re) {
      re = new RegExp(`^\\s*\\b${esc(name)}\\b(?!['\\u2018\\u2019]s)`, 'i');
      this.immediateStart.set(name, re);
    }
    return re;
  }

  getVoiceRe(name: string): RegExp {
    let re = this.voiceRe.get(name);
    if (!re) {
      re = new RegExp(`\\b${esc(name)}['\\u2018\\u2019]s?\\s+(?:voice|tone|words?|breath|question|answer|reply|response|laugh|sigh|cry|shout)\\b`, 'i');
      this.voiceRe.set(name, re);
    }
    return re;
  }

  getObjTestRe(name: string): RegExp {
    let re = this.objTestRe.get(name);
    if (!re) {
      re = new RegExp(`\\b(?:to|toward|at|with|for)\\s+${esc(name)}\\b`, 'i');
      this.objTestRe.set(name, re);
    }
    return re;
  }

  getDirectFwdRe(name: string): RegExp {
    let re = this.directFwdRe.get(name);
    if (!re) {
      re = new RegExp(`\\b${esc(name)}\\b(?!['\\u2018\\u2019]s)[^.!?\\u201c\\u201d\\u201e\\u2018\\u2019"']{0,120}\\b${SPEECH_VERB_PAT}\\b`, 'i');
      this.directFwdRe.set(name, re);
    }
    return re;
  }

  getDirectInvRe(name: string): RegExp {
    let re = this.directInvRe.get(name);
    if (!re) {
      // ★ The gap excludes '.' so the search cannot cross a sentence boundary —
      // correct, and it also broke every "said Mr. Wilson." in the corpus, because
      // the abbreviating period in the honorific looks exactly like a full stop.
      // Measured at scale by test:attribution-corpus: 243 honorific tags, 52.3%
      // confidently WRONG, failing across pride, sherlock, dracula, carol,
      // expectations, gatsby, anne and awakening.
      //
      // An OPTIONAL honorific is now allowed to sit immediately before the name,
      // with its period, without opening the gap to sentence boundaries generally.
      re = new RegExp(`\\b${SPEECH_VERB_PAT}\\b[^.!?\\u201c\\u201d\\u201e\\u2018\\u2019"']{0,70}(?:\\b${HONORIFIC_PAT}\\.?\\s+)?\\b${esc(name)}\\b(?!['\\u2018\\u2019]s)`, 'i');
      this.directInvRe.set(name, re);
    }
    return re;
  }
}

let _cachedNames: string[] | undefined;
let _nameRegexCache: NameRegexCache | undefined;

function getNameRegexCache(knownNames: string[]): NameRegexCache {
  if (_cachedNames === knownNames && _nameRegexCache) return _nameRegexCache;
  _nameRegexCache = new NameRegexCache();
  _cachedNames = knownNames;
  return _nameRegexCache;
}

const GENERIC_FWD_RES: RegExp[] = (GENERIC_SPEAKERS as readonly string[]).map(gen => {
  const e = esc(gen);
  return new RegExp(`(?:the|a|an)?\\s*\\b${e}\\b[^.!?\\u201c\\u201d"']{0,30}\\b${SPEECH_VERB_PAT}\\b`, 'i');
});
const GENERIC_INV_RES: RegExp[] = (GENERIC_SPEAKERS as readonly string[]).map(gen => {
  const e = esc(gen);
  return new RegExp(`\\b${SPEECH_VERB_PAT}\\b[^.!?\\u201c\\u201d"']{0,25}(?:the|a|an)?\\s*\\b${e}\\b`, 'i');
});
const GENERIC_IMMEDIATE_RES: RegExp[] = (GENERIC_SPEAKERS as readonly string[]).map(gen =>
  new RegExp(`^\\s*\\b${esc(gen)}\\b`, 'i')
);

function countNameMentions(text: string, name: string, cache?: NameRegexCache): number {
  if (!text || !name) return 0;
  const re = cache ? cache.getMentionGi(name) : new RegExp(`\\b${esc(name)}\\b`, 'gi');
  re.lastIndex = 0;
  return (text.match(re) ?? []).length;
}

// ── Quote pair extraction ─────────────────────────────────────────────────

interface QuotePair {
  start: number;
  end: number; // index of closing char (inclusive)
}

function extractQuotePairs(text: string): QuotePair[] {
  const pairs: QuotePair[] = [];

  // ── Smart double quotes ── “...”
  let pos = 0;
  while (pos < text.length) {
    const openIdx = text.indexOf(OPEN_DOUBLE, pos);
    if (openIdx === -1) break;
    const closeIdx = text.indexOf(CLOSE_DOUBLE, openIdx + 1);
    if (closeIdx === -1) { pairs.push({ start: openIdx, end: text.length - 1 }); break; }
    pairs.push({ start: openIdx, end: closeIdx });
    pos = closeIdx + 1;
  }

  // ── Smart single quotes ── ‘...’ (skip apostrophes)
  pos = 0;
  while (pos < text.length) {
    const openIdx = text.indexOf(OPEN_SINGLE, pos);
    if (openIdx === -1) break;
    const prevChar = openIdx > 0 ? text[openIdx - 1] : '';
    if (/\w/.test(prevChar)) { pos = openIdx + 1; continue; }
    const closeIdx = text.indexOf(CLOSE_SINGLE, openIdx + 1);
    if (closeIdx === -1) break;
    pairs.push({ start: openIdx, end: closeIdx });
    pos = closeIdx + 1;
  }

  // ── ASCII straight quotes ── "..."
  const asciiPositions: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ASCII_DOUBLE) asciiPositions.push(i);
  }
  for (let i = 0; i + 1 < asciiPositions.length; i += 2) {
    pairs.push({ start: asciiPositions[i], end: asciiPositions[i + 1] });
  }
  // Trailing unpaired opening quote (multi-paragraph speech continuation):
  // extend it to the end of the paragraph so it gets a proper segment.
  if (asciiPositions.length % 2 !== 0) {
    const lastOpen = asciiPositions[asciiPositions.length - 1];
    pairs.push({ start: lastOpen, end: text.length - 1 });
  }

  // ── Guillemet quotes ── «...» (translated LNs, European prose)
  pos = 0;
  while (pos < text.length) {
    const openIdx = text.indexOf(OPEN_GUILLEMET, pos);
    if (openIdx === -1) break;
    const closeIdx = text.indexOf(CLOSE_GUILLEMET, openIdx + 1);
    if (closeIdx === -1) { pairs.push({ start: openIdx, end: text.length - 1 }); break; }
    pairs.push({ start: openIdx, end: closeIdx });
    pos = closeIdx + 1;
  }

  // ── Em-dash dialogue ── "— spoken text" at start of paragraph or after period
  // Common in Russian/French/translated LN convention. Opening em-dash that
  // starts a sentence is treated as dialogue until the next sentence boundary.
  const emDashRe = /(?:^|(?<=[.!?]\s))\u2014\s*([^.!?\u2014]+[.!?])/g;
  let emMatch: RegExpExecArray | null;
  while ((emMatch = emDashRe.exec(text)) !== null) {
    // Skip if this region already overlaps with an existing pair
    const emStart = emMatch.index;
    const emEnd = emMatch.index + emMatch[0].length - 1;
    const overlaps = pairs.some(p => !(emEnd < p.start || emStart > p.end));
    if (!overlaps) {
      pairs.push({ start: emStart, end: emEnd });
    }
  }

  pairs.sort((a, b) => a.start - b.start);
  const result: QuotePair[] = [];
  let lastEnd = -1;
  for (const p of pairs) {
    if (p.start > lastEnd) { result.push(p); lastEnd = p.end; }
  }
  return result;
}

// ── Attribution-window helpers ────────────────────────────────────────────

/**
 * Returns the last full sentence in `before` — the clause that directly
 * leads into the quote.  Trims trailing whitespace first, then walks
 * backwards to find the second-to-last sentence boundary so the returned
 * text IS the last sentence rather than the empty string after it.
 */
function leadingClause(before: string): string {
  const t = before.trimEnd();
  // Walk backwards through the trimmed string looking for a sentence boundary
  // (punctuation followed by a space) so we can return the last sentence.
  for (let i = t.length - 2; i >= 0; i--) {
    const ch = t[i];
    if ((ch === '.' || ch === '!' || ch === '?') && t[i + 1] === ' ') {
      return t.slice(i + 2);
    }
  }
  return t.slice(-120); // no boundary found — use tail
}

// ── Action subject finder ─────────────────────────────────────────────────

/**
 * Returns the first known name that is the unambiguous grammatical subject
 * of a clause.  Used for "action attribution": when an author writes
 * "Iris leaned forward. 'quote'" without an explicit speech verb, the
 * action subject implies the speaker.
 *
 * Safety: returns undefined if no known name appears in the first 55% of
 * the clause (too deep in a subordinate phrase to be the subject).
 */
function findActionSubject(clause: string, knownNames: string[], cache?: NameRegexCache): string | undefined {
  const quotedRegions: Array<{ start: number; end: number }> = [];
  const quoteMarks = [
    { open: OPEN_DOUBLE, close: CLOSE_DOUBLE },
    { open: OPEN_SINGLE, close: CLOSE_SINGLE },
    { open: ASCII_DOUBLE, close: ASCII_DOUBLE },
  ];
  for (const { open, close } of quoteMarks) {
    let pos = 0;
    while (pos < clause.length) {
      const openIdx = clause.indexOf(open, pos);
      if (openIdx === -1) break;
      const closeIdx = clause.indexOf(close, openIdx + 1);
      if (closeIdx === -1) { quotedRegions.push({ start: openIdx, end: clause.length }); break; }
      quotedRegions.push({ start: openIdx, end: closeIdx });
      pos = closeIdx + 1;
    }
  }
  const isInsideQuote = (idx: number) => quotedRegions.some(r => idx >= r.start && idx <= r.end);

  let firstMatch: { name: string; pos: number } | undefined;
  for (const name of knownNames) {
    const re = cache ? cache.getWordBoundaryNoPoss(name) : new RegExp(`\\b${esc(name)}\\b(?!['\\u2018\\u2019]s)`, "i");
    const m = re.exec(clause);
    if (m && !isInsideQuote(m.index) && (!firstMatch || m.index < firstMatch.pos)) {
      firstMatch = { name, pos: m.index };
    }
  }
  // Possessive-subject fallback: "Name's [action]" at the very start of a
  // clause is a literary pattern implying the character is the implied speaker
  // (e.g. "Iris's pause was the lattice processing…"). Only applies when no
  // non-possessive match was found and the possessive appears at position 0.
  if (!firstMatch) {
    for (const name of knownNames) {
      if (new RegExp(`^\\s*\\b${esc(name)}\\b['\\u2018\\u2019]s?\\s`, 'i').test(clause)
          && !isInsideQuote(0)) {
        firstMatch = { name, pos: 0 };
        break;
      }
    }
  }
  if (!firstMatch) return undefined;
  if (firstMatch.pos > clause.length * 0.55) return undefined;
  return firstMatch.name;
}

/**
 * Returns the text of the FIRST sentence after the quote — the direct
 * trailing attribution clause.
 */
function trailingClause(after: string): string {
  const stopIdx = after.search(/[.!?]/);
  return stopIdx >= 0 ? after.slice(0, stopIdx + 1) : after.slice(0, 120);
}

// ── Direct name finder ────────────────────────────────────────────────────

/**
 * Checks whether `text` contains an unambiguous subject-attribution:
 *   "Name [words] verb"  or  "verb [words] Name"
 * for a known character name or a generic speaker role.
 * Returns the canonical name string if found, else undefined.
 */
function findDirectName(
  text: string,
  knownNames: string[],
  cache?: NameRegexCache,
): string | undefined {
  // ★ THIS LOOP IS OVER NAMES, NOT POSITIONS, and `knownNames` is sorted by
  // FREQUENCY. So across a long context window this returns the book's
  // most-mentioned character rather than whoever is nearest the quote — a
  // frequency prior where a recency prior belongs.
  //
  // Harmless in fast mode, which sees one preceding paragraph. In HIGH mode,
  // which sees six by design, it means more context makes the protagonist more
  // likely to appear and therefore more likely to win.
  //
  // A nearest-wins variant WAS built and measured: corpus completely unchanged
  // (high still 176 correct / 33 wrong on descriptions) and accuracy-suite
  // DEFAULT fell 182 -> 181. Reverted. So the frequency prior is real but it is
  // NOT where high's descriptive errors come from — those never reach the
  // extended-context step at all, which the Step 4 guard experiment already
  // showed independently.
  //
  // Three explanations are now eliminated by measurement: generic/name ordering,
  // the Step 4 fallback, and the frequency prior. The 17 cases where fast says
  // UNATTRIBUTED and high says WRONG are resolved by a high-only path further
  // up — subjectWeights, the dialogue thread, extCtx density, or
  // pronounMinScore 12 vs fast's higher floor. Instrument WHICH source sets the
  // speaker on those 17 before attempting a fourth fix.
  for (const name of knownNames) {
    const objTest = cache ? cache.getObjTestRe(name) : new RegExp(`\\b(?:to|toward|at|with|for)\\s+${esc(name)}\\b`, 'i');
    if (objTest.test(text)) continue;
    // Fix B: expanded window 0–50 → 0–120 to handle long embedded clauses
    // Exclude quote marks in char class to prevent bridging across quote boundaries
    const fwdRe = cache ? cache.getDirectFwdRe(name) : new RegExp(`\\b${esc(name)}\\b(?!['’]s)[^.!?\u201c\u201d\u201e\u2018\u2019"']{0,120}\\b${SPEECH_VERB_PAT}\\b`, 'i');
    if (fwdRe.test(text)) return name;
  }
  // Known names: inverted pattern — verb ... Name
  for (const name of knownNames) {
    const objTest = cache ? cache.getObjTestRe(name) : new RegExp(`\\b(?:to|toward|at|with|for)\\s+${esc(name)}\\b`, 'i');
    if (objTest.test(text)) continue;
    // Fix B: also expand inverted window 0–40 → 0–70 (more conservative on inverted)
    const invRe = cache ? cache.getDirectInvRe(name) : new RegExp(`\\b${SPEECH_VERB_PAT}\\b[^.!?\u201c\u201d\u201e\u2018\u2019"']{0,70}\\b${esc(name)}\\b(?!['’]s)`, 'i');
    if (invRe.test(text)) return name;
  }
  // ★ PRECEDENCE NOTE, MEASURED. Generic speakers resolve AFTER known names, so a
  // named character anywhere in the 120-char forward / 70-char inverse window
  // beats the words actually touching the speech verb. That looks like the cause
  // of HIGH mode being the worst of the three on definite descriptions (33 wrong
  // vs fast's 16 on the 16-book corpus) — high reads six paragraphs of context
  // where fast reads one, so it finds more distant names to prefer.
  //
  // Putting an ADJACENT generic match first was tried and LOST in every mode:
  // correct 176 -> 173, wrong 16 -> 19 (fast) and 33 -> 36 (high), and it cost a
  // bulk easy-case answer too. The rule fires on "the doctor said" where the
  // doctor IS a named character, which is common. Reverted.
  //
  // So the ordering is not the bug, or not the whole bug. The remaining suspects
  // are high-only and upstream of here: extCtxDepth 6 vs fast's 1,
  // maxRecentSpeakers 10 vs 3, and pronounMinScore 12 vs 16 — all of which make
  // high attribute where fast stays silent. Its extra WRONG answers and its
  // extra CORRECT answers on accuracy-suite's hard cases come from the same
  // machinery, so the fix has to separate them rather than turn it down.
  // Generic speakers — use pre-computed arrays (no RegExp allocation per call)
  for (let gi = 0; gi < GENERIC_SPEAKERS.length; gi++) {
    if (GENERIC_FWD_RES[gi].test(text)) return cap(GENERIC_SPEAKERS[gi]);
    if (GENERIC_INV_RES[gi].test(text)) return cap(GENERIC_SPEAKERS[gi]);
  }
  return undefined;
}

// ── Paragraph subject detector ────────────────────────────────────────────

/**
 * Finds the first named character in the paragraph's opening clause.
 * Used to track the "active subject" for pronoun resolution across paragraphs.
 */
export function detectParagraphSubject(para: string, knownNames: string[], cache?: NameRegexCache): string | undefined {
  const match = para.match(/^(?:[^.!?]+[.!?]\s*){0,1}[^.!?]+/);
  const windowStr = match ? match[0] : para.slice(0, 250);
  let firstMatch: { name: string; pos: number } | undefined;
  for (const name of knownNames) {
    const re = cache ? cache.getWordBoundaryNoPoss(name) : new RegExp(`\\b${esc(name)}\\b(?!['\\u2018\\u2019]s)`, "i");
    const found = re.exec(windowStr);
    if (found && (!firstMatch || found.index < firstMatch.pos)) {
      firstMatch = { name, pos: found.index };
    }
  }
  return firstMatch?.name;
}

// ── Post-quote immediate name ─────────────────────────────────────────────

/**
 * Checks if a known name is the first word after the closing quote mark
 * (within 55 chars, anchored from start).  This covers the literary pattern:
 *   "Yes." Iris looked at the darkness.  →  Iris is the speaker.
 *
 * GUARD: if the matched name is a generic speaker (e.g. "System", "Voice")
 * and there is NO speech verb in the following 100 chars, it is almost
 * certainly a section break / chapter label rather than an attribution.
 */
function findImmediateNameAfter(after: string, knownNames: string[], cache?: NameRegexCache): string | undefined {
  const win = after.slice(0, 55);
  const guardWindow = after.slice(0, 100);
  for (const name of knownNames) {
    const re = cache ? cache.getImmediateStart(name) : new RegExp(`^\\s*\\b${esc(name)}\\b(?!['’]s)`, 'i');
    if (re.test(win)) {
      // Known proper name → trust immediately
      return name;
    }
  }
  // Generic speakers — only if speech verb follows (prevents section-header false positives)
  for (let gi = 0; gi < GENERIC_SPEAKERS.length; gi++) {
    if (GENERIC_IMMEDIATE_RES[gi].test(win)) {
      if (SPEECH_VERB_RE.test(guardWindow)) return cap(GENERIC_SPEAKERS[gi]);
    }
  }
  return undefined;
}


// ── Voice attribution ─────────────────────────────────────────────────────

/**
 * Detects attribution via "Name's voice/tone/words came/said/…".
 * Handles the common literary pattern where the author describes WHO is
 * speaking through their voice rather than a speech verb:
 *   "And my gap?" Iris's voice came from above.  →  Iris
 */
function findVoiceAttribution(text: string, knownNames: string[], cache?: NameRegexCache): string | undefined {
  for (const name of knownNames) {
    const re = cache ? cache.getVoiceRe(name) : new RegExp(`\\b${esc(name)}['’]s?\\s+(?:voice|tone|words?|breath|question|answer|reply|response|laugh|sigh|cry|shout)\\b`, 'i');
    if (re.test(text)) return name;
  }
  return undefined;
}

// ── Gender association map ─────────────────────────────────────────────────

export type GenderHint = 'M' | 'F' | 'N';

/**
 * Lightweight per-chapter gender map built by scanning prose for
 * name → pronoun co-occurrence within a 60-char window.
 * Only ever used to EXCLUDE candidates that contradict the pronoun's gender;
 * it never forces an attribution.
 *
 *   "Nora ... she/her" within 60 chars  → genderMap.set('nora', 'F')
 *   "Varren ... he/him" within 60 chars → genderMap.set('varren', 'M')
 *
 * Running score: each co-occurrence adds +1. After all paragraphs, the
 * winning side wins. A tie or empty → 'N' (neutral / unknown).
 * Requires at least 2 hits and 2× dominance to avoid noise on short texts.
 */
function buildGenderMap(
  paragraphs: string[],
  knownNames: string[],
  cache?: NameRegexCache,
): Map<string, GenderHint> {
  const mScore = new Map<string, number>(); // masculine hits
  const fScore = new Map<string, number>(); // feminine hits
  const masc = /\b(?:he|him|his)\b/gi;
  const fem  = /\b(?:she|her|hers)\b/gi;

  // Pass 1: Collect direct signals from name-pronoun proximity
  for (const para of paragraphs) {
    const lower = para.toLowerCase();
    for (const name of knownNames) {
      const k = normKey(name);
      const nameRe = cache ? cache.getMentionGi(name) : new RegExp(`\\b${esc(name)}\\b`, 'gi');
      nameRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = nameRe.exec(lower)) !== null) {
        const winBefore = lower.slice(Math.max(0, m.index - 60), m.index);
        const winAfter  = lower.slice(m.index, m.index + 80);
        const mascAfterRe = /\b(?:he|his)\b/gi;
        const femAfterRe  = /\b(?:she|her|hers)\b/gi;
        const mascHits = (winBefore.match(masc) ?? []).length + (winAfter.match(mascAfterRe) ?? []).length;
        const femHits  = (winBefore.match(fem)  ?? []).length + (winAfter.match(femAfterRe)  ?? []).length;
        mScore.set(k, (mScore.get(k) ?? 0) + mascHits);
        fScore.set(k, (fScore.get(k) ?? 0) + femHits);
      }
    }
  }

  // Pass 2: Inference from speech-attribution pronouns
  for (const para of paragraphs) {
    const lower = para.toLowerCase();
    const speechAttrRe = new RegExp(`[\\u201d"'\\u2019]\\s*,?\\s*\\b(he|she|him|her)\\b.*?\\b${SPEECH_VERB_PAT}\\b`, 'gi');
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = speechAttrRe.exec(lower)) !== null) {
      const pronoun = attrMatch[1].toLowerCase();
      const isMasc = pronoun === 'he' || pronoun === 'him';
      const isFem  = pronoun === 'she' || pronoun === 'her';
      const attrWin = lower.slice(Math.max(0, attrMatch.index - 50), attrMatch.index + 150);
      const nearbyNames = knownNames.filter(n => {
        const re = cache ? cache.getWordBoundary(n) : new RegExp(`\\b${esc(n)}\\b`, 'i');
        return re.test(attrWin);
      });
      
      if (nearbyNames.length === 1) {
        const k = normKey(nearbyNames[0]);
        if (isMasc) mScore.set(k, (mScore.get(k) ?? 0) + 1);
        if (isFem)  fScore.set(k, (fScore.get(k) ?? 0) + 1);
      } else if (nearbyNames.length === 0 && knownNames.length === 2) {
        const [n1, n2] = knownNames;
        const k1 = normKey(n1), k2 = normKey(n2);
        if (isMasc) {
          if ((fScore.get(k1) ?? 0) > 0 && (mScore.get(k2) ?? 0) === 0) mScore.set(k2, (mScore.get(k2) ?? 0) + 1);
          else if ((fScore.get(k2) ?? 0) > 0 && (mScore.get(k1) ?? 0) === 0) mScore.set(k1, (mScore.get(k1) ?? 0) + 1);
        } else if (isFem) {
          if ((mScore.get(k1) ?? 0) > 0 && (fScore.get(k2) ?? 0) === 0) fScore.set(k2, (fScore.get(k2) ?? 0) + 1);
          else if ((mScore.get(k2) ?? 0) > 0 && (fScore.get(k1) ?? 0) === 0) fScore.set(k1, (fScore.get(k1) ?? 0) + 1);
        }
      }
    }
  }

  const result = new Map<string, GenderHint>();
  for (const name of knownNames) {
    const k = normKey(name);
    const m = mScore.get(k) ?? 0;
    const f = fScore.get(k) ?? 0;
    // Require at least 1 hit and 2× dominance to classify;
    // lowered from 2 hits to catch speech-attribution patterns.
    if (m >= 1 && f === 0) result.set(k, 'M');
    else if (f >= 1 && m === 0) result.set(k, 'F');
    else if (m >= 2 && m >= f * 2) result.set(k, 'M');
    else if (f >= 2 && f >= m * 2) result.set(k, 'F');
    else {
      // Last resort: name-morphology heuristic for names with no text signals.
      // Common name endings provide weak but useful gender hints in fiction.
      const lower = name.toLowerCase();
      if (/(?:a|ia|ine|elle|ette|ora|ila|ola|ina|ela|isa|ara|ira)$/.test(lower)) result.set(k, 'F');
      else if (/(?:en|eth|on|us|ar|or|ur|an|el|ren|ard|ald)$/.test(lower)) result.set(k, 'M');
      else result.set(k, 'N');
    }
  }
  return result;
}

// ── Narrative focus (prev-paragraph dominant character) ───────────────────

/**
 * Returns the dominant character and their focus dominance ratio.
 * `focusDominance` = bestCount / totalMentions (0–1).
 * Used for the proportional NARRATIVE_FOCUS_MAX bonus in pronoun resolution.
 */
function findParagraphFocusWithRatio(
  para: string,
  knownNames: string[],
  cache?: NameRegexCache,
): { name: string; ratio: number } | undefined {
  let bestName: string | undefined;
  let bestCount = 0;
  let totalMentions = 0;
  for (const name of knownNames) {
    const re = cache ? cache.getMentionGi(name) : new RegExp(`\\b${esc(name)}\\b`, 'gi');
    re.lastIndex = 0;
    const count = (para.match(re) ?? []).length;
    totalMentions += count;
    if (count > bestCount) { bestCount = count; bestName = name; }
  }
  if (!bestName || bestCount === 0) return undefined;
  return { name: bestName, ratio: bestCount / Math.max(1, totalMentions) };
}

// ── Core attribution ──────────────────────────────────────────────────────

interface Attribution {
  speaker: string | undefined;
  type: 'speech' | 'narrative';
  confidence: number;
  trace?: Omit<import("../types").AdaptivePredictionTrace, "task" | "paragraphIndex" | "spanIndex">;
}

/**
 * Determines the speaker and type (speech vs narrative) for a single quote.
 *
 * Priority order (when speech verb IS present in local window):
 *  1. Direct trailing attribution  ("quote," Name verb.)
 *  2. Direct leading attribution   (Name verb, "quote")
 *  3. Pronoun resolution via recency weights + active subject
 *  4. Extended context (prev 2 paragraphs)
 *
 * When NO speech verb is in the local window:
 *  A. Action attribution — Name performs action immediately before quote
 *     e.g. "Iris leaned forward. 'quote'" → Iris is speaker, type='speech'
 *  B. Quote ends with '?' or '!' → type='speech', speaker=undefined
 *  C. Otherwise → type='narrative' (embedded / reported / conceptual)
 */

// ── DialogueThread (High mode) ────────────────────────────────────────────

interface DialogueThread {
  participants: string[];           // known names who spoke, unique, most recent last
  lastSpeaker: string | undefined;
  turnCounts: Map<string, number>;  // normKey → turn count
  isActive: boolean;                // true if ≥ 2 attributed quotes found
}

/**
 * Parse extCtx for attribution history, building a light conversation model.
 * Called once per paragraph in high mode.  Re-uses extractQuotePairs so it
 * handles curly and straight quotes the same way as the main loop.
 */
function extractDialogueThread(
  extCtx: string,
  knownNames: string[],
  genderMap?: Map<string, GenderHint>,
): DialogueThread {
  const pairs = extractQuotePairs(extCtx);
  const sw = new Map<string, number>();
  const mw = new Map<string, number>();
  for (const n of knownNames) { sw.set(normKey(n), 0); mw.set(normKey(n), 0); }

  const turnCounts = new Map<string, number>();
  const ordered: string[] = [];

  for (const pair of pairs) {
    const before = extCtx.slice(0, pair.start);
    const after  = extCtx.slice(pair.end + 1);
    const attr = findAttribution(
      before, after, '', knownNames, sw, mw,
      ordered[ordered.length - 1], undefined, undefined, ordered, genderMap,
    );
    if (attr.speaker && attr.confidence >= 0.65) {
      const k = normKey(attr.speaker);
      turnCounts.set(k, (turnCounts.get(k) ?? 0) + 1);
      sw.set(k, 1.0);
      if (ordered.length === 0 || normKey(ordered[ordered.length - 1]) !== k) {
        ordered.push(attr.speaker);
      }
    }
  }

  const seen = new Set<string>();
  const participants = ordered
    .map(s => knownNames.find(n => normKey(n) === normKey(s))!)
    .filter(n => { if (!n || seen.has(normKey(n))) return false; seen.add(normKey(n)); return true; });

  return {
    participants,
    lastSpeaker: ordered[ordered.length - 1],
    turnCounts,
    isActive: pairs.length >= 2,
  };
}

// ── detectTurnPattern (replaces hardcoded H1) ─────────────────────────────

/**
 * Analyze a sequence of recent speakers and predict who should speak next.
 * Handles 2-party alternation as well as 3+ party "overdue" detection.
 * Returns the canonical name from genderFilteredNames, or undefined if no
 * confident prediction can be made.
 *
 * Also returns the confidence level so callers can calibrate appropriately.
 */
function detectTurnPattern(
  recentSpeakers: string[],
  genderFilteredNames: string[],
): { name: string; confidence: number } | undefined {
  if (recentSpeakers.length < 2) return undefined;

  const seq = recentSpeakers.map(normKey);
  const participants = [...new Set(seq)];

  // 2-party: strict alternation — the other participant is always next
  if (participants.length === 2) {
    const [a, b] = participants;
    const lastK = seq[seq.length - 1];
    const nextK = lastK === a ? b : a;
    const name = genderFilteredNames.find(n => normKey(n) === nextK);
    if (name) return { name, confidence: 0.70 };
  }

  // 3+ party: find who is most overdue (largest gap since last spoke)
  const lastSeen = new Map<string, number>();
  for (let i = 0; i < seq.length; i++) lastSeen.set(seq[i], i);
  const currentPos = seq.length;
  let maxGap = 0;
  let overdue: string | undefined;
  for (const [k, pos] of lastSeen) {
    if (k === seq[seq.length - 1]) continue;
    const gap = currentPos - pos;
    if (gap > maxGap) { maxGap = gap; overdue = k; }
  }
  if (overdue && maxGap >= 3) {
    const name = genderFilteredNames.find(n => normKey(n) === overdue);
    if (name) return { name, confidence: 0.65 + Math.min(0.10, maxGap * 0.015) };
  }
  return undefined;
}

// ── buildExtCtxDensity (High mode) ────────────────────────────────────────

/** Count raw (undecayed) name occurrences in the extCtx window. */
function buildExtCtxDensity(extCtx: string, knownNames: string[], cache?: NameRegexCache): Map<string, number> {
  const density = new Map<string, number>();
  for (const name of knownNames) {
    const re = cache ? cache.getMentionGi(name) : new RegExp(`\\b${esc(name)}\\b`, 'gi');
    re.lastIndex = 0;
    const hits = (extCtx.match(re) ?? []).length;
    if (hits > 0) density.set(normKey(name), hits);
  }
  return density;
}

function findAttribution(
  before: string,
  after: string,
  extCtx: string,
  knownNames: string[],
  speakWeights: Map<string, number>,
  mentionWeights: Map<string, number>,
  activeSubject: string | undefined,
  prevParaFocus: { name: string; ratio: number } | undefined,
  quoteContent?: string,
  // Turn-taking: last N high-confidence attributed speakers
  recentSpeakers?: string[],
  // Gender map: 'M'|'F'|'N' per normKey(name) — used for pronoun gender exclusion
  genderMap?: Map<string, GenderHint>,
  // Intelligence level: overrides PRONOUN_MIN_SCORE when set
  pronounMinScore?: number,
  // High mode extras
  thread?: DialogueThread,
  extCtxDensity?: Map<string, number>,
  activeSubjectIsLocal?: boolean,
  learnedBias?: import("../types").LearnedBias,
  adaptiveContext?: import("../types").AdaptiveInferenceContext,
  cache?: NameRegexCache,
): Attribution {
  const localBefore = before.slice(-LOCAL_VERB_WINDOW);
  const localAfter  = after.slice(0, LOCAL_VERB_WINDOW);
  const hasSpeechVerb = SPEECH_VERB_RE.test(localBefore + ' ' + localAfter);

  // ── AN EXPLICIT TAG BEATS EVERY INFERENCE, even for an unknown name.
  //
  // `said Mr. Wilson` where "Wilson" is not in the resolved cast used to fall
  // straight through to context-carry, which then confidently supplied whoever
  // spoke last. Measured by test:attribution-corpus, that is where the residual
  // honorific errors live: several books show 6 wrong out of 7, all of them a
  // real tag overridden by an unrelated carried speaker.
  //
  // Guessing from context is reasonable when the text says nothing. It is never
  // reasonable when the text names the speaker outright. Requires the honorific
  // form specifically, so a bare capitalised word after "said" — which is often
  // a place or an object — cannot reach it.
  {
    const tagged = `${localAfter}`.match(
      new RegExp(`^\\s*[,]?\\s*\\b${SPEECH_VERB_PAT}\\b\\s+(${HONORIFIC_PAT})\\.?\\s+([A-Z][a-z']{1,}(?:\\s+[A-Z][a-z']{1,})?)`, 'i'),
    ) ?? `${localBefore}`.match(
      new RegExp(`\\b${SPEECH_VERB_PAT}\\b\\s+(${HONORIFIC_PAT})\\.?\\s+([A-Z][a-z']{1,}(?:\\s+[A-Z][a-z']{1,})?)\\s*$`, 'i'),
    );
    if (tagged) {
      // The BARE NAME, not "Mr. Wilson" — every other path in this file returns a
      // name without its honorific, and downstream label building assumes that.
      // A two-word name resolves to its LAST token — "Mr. James Windibank" is
      // Windibank, and the cast list holds surnames. Falls back to the single
      // token when there is only one.
      const parts = tagged[2].trim().split(/\s+/);
      return { speaker: parts[parts.length - 1], type: 'speech', confidence: 0.9 };
    }
  }

  // ── No speech verb in local window ─────────────────────────────────────
  if (!hasSpeechVerb) {
    // A) Post-quote immediate name: "Yes." Iris looked → Iris spoke
    const immediateNameAfter = findImmediateNameAfter(after, knownNames, cache);
    if (immediateNameAfter) return { speaker: immediateNameAfter, type: 'speech', confidence: 0.92 };

    // A+) Voice attribution: "Iris's voice came from above" → Iris
    const voiceNameNoVerb = findVoiceAttribution(after.slice(0, 120), knownNames, cache);
    if (voiceNameNoVerb) return { speaker: voiceNameNoVerb, type: 'speech', confidence: 0.88 };

    // C) Same-paragraph continuation: a speech verb exists earlier in this
    //    paragraph (not just the ±80-char window) and a speaker is established.
    //    Handles: "quote 1," she said. <long narrative beat>. "quote 2."
    //    Moved above B so intra-paragraph speaker continuity (stronger signal)
    //    is not overridden by action subjects found in the narrative beat
    //    text (which may reference other characters as grammatical objects).
    if (activeSubject && SPEECH_VERB_RE.test(before)) {
      return { speaker: activeSubject, type: 'speech', confidence: 0.78 };
    }

    // B) Action attribution: last sentence before quote has a named subject
    const leadingText   = leadingClause(before);
    const actionSpeaker = findActionSubject(leadingText, knownNames, cache);
    if (actionSpeaker) return { speaker: actionSpeaker, type: 'speech', confidence: 0.72 };

    // C2) Intra-paragraph beat carry: no speech verb in before-text but the
    //     active subject has maximal speak weight from earlier in this paragraph
    //     (i.e. they were just attributed). Handles the literary beat pattern:
    //       "I'm sensitive," she said. "More." She met Nora's eyes. "It's mine."
    //     — "She met Nora's eyes." is a beat, not an attribution; the final quote
    //     belongs to the same speaker as the preceding ones.
    //     Guard 1: if the before text introduces a NEW named actor (not the active
    //     subject), that person may be taking over — don't carry.
    //     Guard 2: only fires when there is actual text before the quote in this
    //     paragraph (leadingText.trim() non-empty), preventing cross-paragraph carry.
    if (activeSubject && (speakWeights.get(normKey(activeSubject)) ?? 0) >= 0.75 && leadingText.trim().length > 0) {
      const beatActor = findActionSubject(leadingText, knownNames, cache);
      if (!beatActor || normKey(beatActor) === normKey(activeSubject)) {
        return { speaker: activeSubject, type: 'speech', confidence: 0.72 };
      }
    }

    // NEW-PARA-NEW-SPEAKER: universally applied typography convention in
    // published fiction — a new paragraph of dialogue implies a speaker change.
    // Fires when the paragraph opens bare (no leading text before the quote)
    // and we have ≥2 recent speakers to alternate between.
    // Placed above B+ so established alternation is not overridden by
    // distant extCtx action subjects (which widen with higher intelligence levels).
    if (before.trim().length === 0 && recentSpeakers && recentSpeakers.length >= 2) {
      const prevSpeakerK = normKey(recentSpeakers[recentSpeakers.length - 1]);
      for (let j = recentSpeakers.length - 2; j >= 0; j--) {
        const k = normKey(recentSpeakers[j]);
        if (k !== prevSpeakerK) {
          // Enhancement B: also check recentSpeakers for generic speakers
          // not in knownNames (e.g. "Officer" from "the officer said")
          const name = knownNames.find(n => normKey(n) === k)
            ?? recentSpeakers.find(s => normKey(s) === k);
          if (name) return { speaker: name, type: 'speech', confidence: 0.73 };
        }
      }
    }

    // THREAD-INFERRED ALTERNATION (HIGH only):
    // When a bare opening quote has insufficient recentSpeakers for
    // alternation (< 2) BUT we can infer the alternation partner from
    // context, assign the next speaker. Two sub-strategies:
    //   A1) Thread has 2+ participants → alternate to the other participant.
    //       Requires thread.isActive (≥2 quotes in extCtx).
    //   A2) Thread has 1 participant AND knownNames has exactly 2 members →
    //       the bare quote belongs to the other character (2-party scene
    //       assumption). Does NOT require thread.isActive — even a single
    //       attributed quote in the extCtx establishes who spoke.
    // This leverages the 6-paragraph context window to bootstrap the
    // alternation pattern even when no prior quotes exist in the recent
    // window (e.g. after a narrative-only paragraph).
    // ★★ ABLATION RESULT — the dialogue thread is high mode's most valuable
    // mechanism AND the source of its worst corpus errors. Both, measured:
    //
    //   ABLATE=thread   accuracy-suite HIGH  210/217 -> 183/217  (BELOW target)
    //   ABLATE=thread   corpus descriptive   33 wrong -> 26 wrong
    //
    // Every other high-only mechanism is EXACTLY NEUTRAL on those descriptions —
    // pronoun floor (12 vs 16), subject weights, extCtx density, and the
    // confidence upgrade/demotion pass all leave 33/176/10 untouched. The thread
    // alone owns 7 of the 33, and it alone owns 27 of high's hard-case wins.
    //
    // So the goal is NOT to weaken it. It is to make it yield where the text is
    // explicit and keep it everywhere else. Guarding THIS branch on `after`
    // carrying an attribution tag was tried and changed nothing, which means the
    // 7 come through one of the thread's OTHER two consumers — the two-compatible
    // -names branch below, or the activeSubject branch after it. That is where a
    // fourth attempt should start, with the same ablation harness to confirm.
    if (before.trim().length === 0 && thread) {
      const lastK = activeSubject ? normKey(activeSubject)
        : (recentSpeakers?.length ? normKey(recentSpeakers[recentSpeakers.length - 1]) : undefined);
      if (lastK) {
        // A1: Thread has 2+ explicit participants (requires active thread)
        if (thread.isActive && thread.participants.length >= 2) {
          const alt = thread.participants.find(p => normKey(p) !== lastK);
          if (alt) return { speaker: alt, type: 'speech', confidence: 0.70 };
        }
        // A2: Thread has 1 participant, but cast is exactly 2 known names →
        //     infer the other as alternation partner (early conversation).
        //     Use thread.participants.last as the "who just spoke" reference
        //     (more reliable than activeSubject which may be a narrative carry).
        //     Confidence 0.65 ensures it survives the HIGH-mode demotion pass.
        if (thread.participants.length >= 1 && knownNames.length === 2) {
          const lastThreadSpeakerK = normKey(thread.participants[thread.participants.length - 1]);
          const otherName = knownNames.find(n => normKey(n) !== lastThreadSpeakerK);
          if (otherName) return { speaker: otherName, type: 'speech', confidence: 0.65 };
        }
      }
    }

    // B+) extCtx action fallback: walk backward through context paragraphs
    //     when the local leading clause yields no action subject AND no
    //     intra-paragraph or alternation signal fired above.
    if (!actionSpeaker && extCtx) {
      const extParas = extCtx.split(/\n+/).filter(Boolean).reverse();
      for (const ep of extParas.slice(0, 3)) {
        const epSubject = findActionSubject(leadingClause(ep), knownNames, cache);
        if (epSubject) {
          return { speaker: epSubject, type: 'speech', confidence: 0.60 };
        }
      }
    }

    // D) Bare-opening-quote alternation: quote opens the paragraph (before is
    //    empty), no action beat establishes the speaker. Alternate to the most
    //    recently active OTHER participant in this conversation.
    //    e.g. Iris just spoke → next untagged standalone quote → Nora → Iris → …
    //    Uses activeSubject only when they have speak weight (i.e. actually spoke),
    //    otherwise uses recentSpeakers.last to avoid carrying narrative action
    //    subjects (who never spoke) as the "most recent speaker" reference.
    if (before.trim().length === 0 && recentSpeakers && recentSpeakers.length >= 1) {
      const activeHasSpeakWeight = activeSubject
        ? (speakWeights.get(normKey(activeSubject)) ?? 0) >= 0.05
        : false;
      const mostRecent = activeHasSpeakWeight
        ? activeSubject!
        : recentSpeakers[recentSpeakers.length - 1];
      const kLast = normKey(mostRecent);
      // 1) Scan recentSpeakers backwards for the most recently seen other participant
      for (let _j = recentSpeakers.length - 1; _j >= 0; _j--) {
        const k = normKey(recentSpeakers[_j]);
        if (k !== kLast) {
          const altName = knownNames.find(n => normKey(n) === k)
            ?? recentSpeakers.find(s => normKey(s) === k);
          if (altName) return { speaker: altName, type: 'speech', confidence: 0.65 };
          break;
        }
      }
      // 2) Fallback: scan extCtx + weights for most prominent non-last character.
      //    Handles snippets where the other participant hasn't spoken yet.
      let bestAlt: { name: string; score: number } | undefined;
      for (const name of knownNames) {
        const k = normKey(name);
        if (k === kLast) continue;
        const sw = speakWeights.get(k) ?? 0;
        const mw = mentionWeights.get(k) ?? 0;
        const ctxCount = extCtx
          ? (extCtx.match(new RegExp(`\\b${esc(name)}\\b`, 'gi')) ?? []).length
          : 0;
        const score = sw * 80 + mw * 45 + ctxCount * 8;
        if (score > 3 && (!bestAlt || score > bestAlt.score)) bestAlt = { name, score };
      }
      if (bestAlt) return { speaker: bestAlt.name, type: 'speech', confidence: 0.55 };
    }

    // E) Question/exclamation marks are strong speech signals
    const forcesSpeech = quoteContent != null && /[?!]\s*$/.test(quoteContent.trimEnd());
    if (forcesSpeech) return { speaker: undefined, type: 'speech', confidence: 0 };

    // F) No evidence of speech → narrative embedding
    return { speaker: undefined, type: 'narrative', confidence: 0 };
  }

  // ── Speech verb present: find speaker via attribution hierarchy ────────

  // ── Step 1: direct trailing (name + voice pattern) ──
  const trailing = trailingClause(after);
  const trailName = findDirectName(trailing, knownNames, cache)
    ?? findVoiceAttribution(trailing, knownNames, cache);
  if (trailName) return { speaker: trailName, type: 'speech', confidence: 0.95 };

  // ── Step 1.5: trailing pronoun attribution ──
  // When the trailing clause has a pronoun + speech verb but no name
  // (e.g. '"quote," he said'), resolve the speaker using gender exclusion.
  // If genderMap already identified one candidate as the opposite gender,
  // the pronoun must refer to the remaining candidate.
  // If both are 'N', scan the full paragraph text for opposite-gender
  // pronoun + name associations to identify the other character.
  if (!trailName && genderMap && knownNames.length >= 2) {
    // Detect the SUBJECT pronoun of the speech verb — not just any pronoun
    // in the trailing clause. "he said, sitting across from her" should
    // detect 'he' as the attribution pronoun, not 'her' (which is an object).
    const trailLower = trailing.toLowerCase();
    const subjMascRe = new RegExp(`\\b(he|him)\\b\\s*(?:\\w+\\s+){0,3}\\b${SPEECH_VERB_PAT}\\b`, 'i');
    const subjFemRe  = new RegExp(`\\b(she|her)\\b\\s*(?:\\w+\\s+){0,3}\\b${SPEECH_VERB_PAT}\\b`, 'i');
    const trailMasc = subjMascRe.test(trailLower);
    const trailFem  = subjFemRe.test(trailLower);
    if ((trailMasc || trailFem) && !(trailMasc && trailFem)) {
      // Try genderMap exclusion
      const compatNames = knownNames.filter(n => {
        const g = genderMap.get(normKey(n)) ?? 'N';
        if (trailMasc && g === 'F') return false;
        if (trailFem  && g === 'M') return false;
        return true;
      });
      if (compatNames.length === 1) {
        return { speaker: compatNames[0], type: 'speech', confidence: 0.88 };
      }
      // GenderMap couldn't narrow it down — try paragraph-context deduction.
      // (HIGH mode only: expensive full-paragraph pronoun scan)
      // Scan the full paragraph (before + after) for opposite-gender pronouns
      // near a known name. If "from her" appears near no name, but the
      // paragraph only has 2 characters, the 'her' must be the non-speaker.
      if (compatNames.length === 2 && thread) {
        const fullPara = (before + ' ' + after).toLowerCase();
        const oppositeGender = trailMasc ? /\b(?:she|her|hers)\b/ : /\b(?:he|him|his)\b/;
        if (oppositeGender.test(fullPara)) {
          for (const name of knownNames) {
            const nameRe = new RegExp(`\\b${esc(name)}\\b`, 'i');
            const oppPronounRe = trailMasc
              ? /\b(?:she|her|hers)\b/gi
              : /\b(?:he|him|his)\b/gi;
            let oppMatch: RegExpExecArray | null;
            while ((oppMatch = oppPronounRe.exec(fullPara)) !== null) {
              const win = fullPara.slice(Math.max(0, oppMatch.index - 30), oppMatch.index + 50);
              if (nameRe.test(win)) {
                const otherName = knownNames.find(n => normKey(n) !== normKey(name));
                if (otherName) return { speaker: otherName, type: 'speech', confidence: 0.82 };
              }
            }
          }
        }
      }
    }
  }

  // ── Step 2: direct leading ──
  const leading = leadingClause(before);
  const leadName = findDirectName(leading, knownNames, cache)
    ?? findVoiceAttribution(leading, knownNames, cache);
  if (leadName) return { speaker: leadName, type: 'speech', confidence: 0.90 };

  // ── Step 2.3 (HIGH only): Active subject carry in speech-verb paragraphs.
  //    When trailing/leading direct attribution both fail but activeSubject
  //    was set from a previous quote in this same paragraph, carry the
  //    attribution. This handles patterns where the leading clause contains
  //    a possessive or pronoun that the name-finder can't resolve:
  //      "Q1," Iris said. The voice was Iris's voice... "Q2"
  //      "Q1," Iris said. She looked up. "Q2"
  //    Guard: only if no NEW named subject appears in the leading text.
  //    Guard: before must be non-empty — paragraph-opening quotes have no
  //    "previous quote in this same paragraph", so carrying a potentially
  //    stale cross-paragraph activeSubject would be incorrect here.
  //    (Without this guard, a narrative-only character who was the subject
  //    of a preceding paragraph — e.g. "Kael was aboard." — could be
  //    carried into dialogue attribution even as the scene shifts to Nora.)
  // ★ THE CARRIED SUBJECT YIELDS TO AN EXPLICIT TAG.
  //
  // Per-branch ablation of the dialogue thread's three consumers, on the 16-book
  // corpus and accuracy-suite together:
  //
  //     branch                     corpus wrong    accuracy-suite HIGH
  //     (none ablated)                  33            210/217
  //     A  bare alternation             33            210/217
  //     B  two-compatible-names         33            210/217
  //     C  carried subject (this)       26            210/217
  //
  // This branch owns ALL SEVEN of the thread's wrong answers and contributes
  // ZERO hard cases — the thread's 27-case value lives entirely in A and B. It
  // fires whenever `before` is non-empty, and returns the carried subject at 0.78
  // BEFORE anything reads the tag sitting in `after`. So `"..." said the child.`
  // was answered by whoever spoke last, with the real answer two characters away.
  //
  // Not removed: a carried subject is the correct answer whenever the text is
  // silent, which is most of the time. It now simply defers when the text names
  // its speaker. That is the mode using its context better rather than less of it.
  if (activeSubject && thread && !hasExplicitTrailingTag(after)
      && (activeSubjectIsLocal || before.trim().length > 0)) {
    const leadSubj = findActionSubject(leading, knownNames, cache);
    if (!leadSubj || normKey(leadSubj) === normKey(activeSubject)) {
      return { speaker: activeSubject, type: 'speech', confidence: 0.78 };
    }
  }

  // ── Step 2.5: local subject → pronoun match ──────────────────────────
  // "Iris chose the middle ground. 'I'm sensitive,' she said."
  //  ↑ action subject in leading sentence             ↑ pronoun attribution
  // When the sentence immediately before the quote names a known character
  // as its grammatical subject AND the attribution pronoun is gender-
  // compatible, resolve directly — before the Bayesian stage can be
  // overwhelmed by accumulated cross-paragraph weights (prevParaFocus, etc.).
  const isPronounLocal = PRONOUN_RE.test(localBefore + ' ' + localAfter);
  if (isPronounLocal) {
    const localSubj = findActionSubject(leadingClause(before), knownNames, cache);
    if (localSubj) {
      const pCtx  = (localBefore + ' ' + localAfter).toLowerCase();
      const pMasc = /\bhe\b|\bhim\b|\bhis\b/.test(pCtx);
      const pFem  = /\bshe\b|\bher\b|\bhers\b/.test(pCtx);
      const sg    = genderMap?.get(normKey(localSubj));
      const genderOk = (!pMasc && !pFem) || (pFem && sg !== 'M') || (pMasc && sg !== 'F');
      if (genderOk) return { speaker: localSubj, type: 'speech', confidence: 0.88 };
    }
    if (before.trim().length === 0 && activeSubject && activeSubjectIsLocal) {
      const pCtx  = (localBefore + ' ' + localAfter).toLowerCase();
      const pMasc = /\bhe\b|\bhim\b|\bhis\b/.test(pCtx);
      const pFem  = /\bshe\b|\bher\b|\bhers\b/.test(pCtx);
      const sg    = genderMap?.get(normKey(activeSubject));
      const genderOk = (!pMasc && !pFem) || (pFem && sg !== 'M') || (pMasc && sg !== 'F');
      if (genderOk) return { speaker: activeSubject, type: 'speech', confidence: 0.86 };
    }
  }

  // ── Step 3: pronoun resolution (Bayesian posterior) ──
  const isPronoun = PRONOUN_RE.test(localBefore + ' ' + localAfter);
  if (isPronoun) {
    // ── Gender exclusion: extract the specific pronoun and filter mismatched candidates
    const pronounCtx = (localBefore + ' ' + localAfter).toLowerCase();
    const isMasc = /\bhe\b|\bhim\b|\bhis\b/.test(pronounCtx);
    const isFem  = /\bshe\b|\bher\b|\bhers\b/.test(pronounCtx);
    const genderFilteredNames = genderMap
      ? knownNames.filter(name => {
          const g = genderMap.get(normKey(name)) ?? 'N';
          if (isMasc && g === 'F') return false; // 'he' cannot be a female character
          if (isFem  && g === 'M') return false; // 'she' cannot be a male character
          return true;
        })
      : knownNames;

    // H1 — Turn-taking: use detectTurnPattern for N-deep sequence analysis
    // (replaces the previous hardcoded ABA/ABAB/ABABA pattern matching).
    const filteredRecent = recentSpeakers
      ? recentSpeakers.filter(s => genderFilteredNames.some(n => normKey(n) === normKey(s)))
      : recentSpeakers;

    if (filteredRecent && filteredRecent.length >= 2) {
      const turn = detectTurnPattern(filteredRecent, genderFilteredNames);
      // Continuity Guard: if the turn pattern suggests a switch but the last speaker
      // is the active paragraph subject (and we are in a multi-paragraph context),
      // the pattern might be interrupted by a narrative break. In this case,
      // fall through to Bayesian scoring which weights activeSubject heavily.
      const lastK = normKey(filteredRecent[filteredRecent.length - 1]);
      const isContinuity = activeSubject && normKey(activeSubject) === lastK;

      if (turn && (!isContinuity || turn.confidence >= 0.85)) {
        return { speaker: turn.name, type: 'speech', confidence: turn.confidence };
      }
    }

    // H2 — DialogueThread 2-party fast-path (high mode):
    // When the extended context contains exactly 2 active conversation participants
    // and the pronoun is gender-compatible, resolve directly without Bayesian scoring.
    // This handles scenes where accumulated cross-paragraph weights would otherwise
    // overwhelm the correct alternation.
    if (thread?.isActive && thread.participants.length === 2) {
      const [p1, p2] = thread.participants;
      const lastK = thread.lastSpeaker ? normKey(thread.lastSpeaker) : undefined;
      const altName = lastK === normKey(p1) ? p2 : p1;
      const g = genderMap?.get(normKey(altName)) ?? 'N';
      const gOk = (!isMasc && !isFem) || (isFem && g !== 'M') || (isMasc && g !== 'F');
      if (gOk) return { speaker: altName, type: 'speech', confidence: 0.82 };
    }

    // H2.5 — Single-candidate pronoun resolution:
    // When gender filtering leaves exactly 1 viable candidate, resolve directly.
    // This handles characters whose first appearance is via pronoun speech
    // attribution (e.g. "Two months ago," he said → Varren is the only non-F
    // candidate). Fires before Bayesian scoring to prevent UNKNOWN cascades.
    if (genderFilteredNames.length === 1) {
      return { speaker: genderFilteredNames[0], type: 'speech', confidence: 0.85 };
    }

    // Build scored candidate list using gender-filtered names
    const scores: Array<{
      name: string;
      score: number;
      features: Record<string, number>;
      evidence: string[];
    }> = [];
    const pronounMatch = /\b(he|she|they|him|her|them|his|hers|their)\b/i.exec(pronounCtx);
    for (const name of genderFilteredNames) {
      const k = normKey(name);
      const sw = speakWeights.get(k)   ?? 0;
      const mw = mentionWeights.get(k) ?? 0;
      let score = sw * 75 + mw * 55;
      const features: Record<string, number> = {
        base_score: 0,
        speak_weight: sw,
        mention_weight: mw,
        active_subject_match: 0,
        prev_focus_ratio: 0,
        thread_turns: 0,
        ext_ctx_density: 0,
        pronoun_posterior: 0,
        before_name_mentions: 0,
        after_name_mentions: 0,
        surrounding_name_weight: 0,
        previous_speaker_carry: 0,
      };
      const evidence: string[] = [];
      if (activeSubject && normKey(name) === normKey(activeSubject)) score += 45;
      if (activeSubject && normKey(name) === normKey(activeSubject)) {
        features.active_subject_match = 1;
        evidence.push("active-subject");
      }
      if (prevParaFocus && normKey(name) === normKey(prevParaFocus.name)) {
        score += prevParaFocus.ratio * NARRATIVE_FOCUS_MAX;
        features.prev_focus_ratio = prevParaFocus.ratio;
        evidence.push(`prev-focus=${prevParaFocus.ratio.toFixed(2)}`);
      }
      // Thread participant bonus: characters who are active in the extCtx dialogue
      // get additional weight proportional to how many turns they've taken.
      if (thread?.turnCounts.has(k)) {
        score += (thread.turnCounts.get(k)! * 60);
        features.thread_turns = thread.turnCounts.get(k) ?? 0;
        evidence.push(`thread=${features.thread_turns}`);
      }
      // Local extCtx density bonus: raw undecayed occurrence count in the 5-para window.
      if (extCtxDensity) {
        score += (extCtxDensity.get(k) ?? 0) * 14;
        features.ext_ctx_density = extCtxDensity.get(k) ?? 0;
      }
      const beforeNameMentions = countNameMentions(before, name);
      const afterNameMentions = countNameMentions(after, name);
      const cueWeights = learnedBias?.contextCueWeights;
      if (cueWeights) {
        if (beforeNameMentions > 0) {
          score += beforeNameMentions * (6 + cueWeights.beforeName * 22);
          features.before_name_mentions = beforeNameMentions;
          evidence.push(`before=${beforeNameMentions}`);
        }
        if (afterNameMentions > 0) {
          score += afterNameMentions * (5 + cueWeights.afterName * 18);
          features.after_name_mentions = afterNameMentions;
          evidence.push(`after=${afterNameMentions}`);
        }
        if (beforeNameMentions + afterNameMentions > 0) {
          score += cueWeights.surroundingName * 18;
          features.surrounding_name_weight = cueWeights.surroundingName;
        }
        const previousSpeaker = recentSpeakers[recentSpeakers.length - 1];
        if (previousSpeaker && normKey(previousSpeaker) === k) {
          score += cueWeights.previousSpeakerCarry * 16;
          features.previous_speaker_carry = cueWeights.previousSpeakerCarry;
          evidence.push(`carry=${cueWeights.previousSpeakerCarry.toFixed(2)}`);
        }
      }
      // ── Learned pronoun posterior (Bayesian annotation bias) ─────────────
      // Multiply score by P(speaker | pronoun) derived from user corrections.
      // Defaults to 1 (identity) when no bias or no pronoun match in context.
      if (learnedBias && pronounMatch) {
        const pronoun = pronounMatch[1].toLowerCase();
        const posteriorWeight =
          learnedBias.pronounSpeakerWeights[pronoun]?.[name] ?? undefined;
        if (posteriorWeight !== undefined) {
          score *= 1 + posteriorWeight;
          features.pronoun_posterior = posteriorWeight;
          evidence.push(`posterior=${posteriorWeight.toFixed(2)}`);
        }
      }
      features.base_score = score / 100;
      if (score > 0) scores.push({ name, score, features, evidence });
    }
    const ranked = rerankAdaptiveCandidates(
      adaptiveContext,
      scores.map((candidate) => ({
        label: candidate.name,
        source: "pronoun-bayes",
        baseScore: candidate.score,
        learnedAdjustment: 0,
        finalScore: candidate.score,
        features: candidate.features,
        evidence: candidate.evidence,
      })),
      {
        task: "speech",
        spanText: quoteContent ?? "",
        contextBefore: before.slice(-120),
        contextAfter: after.slice(0, 120),
        previousSpeaker: recentSpeakers?.length ? recentSpeakers[recentSpeakers.length - 1] : activeSubject,
      },
    );
    const best = ranked.candidates[0];
    const second = ranked.candidates[1];
    // Cast-size penalty: more candidates dilute the posterior even when one
    // character clearly dominates. Scale the threshold up slightly per extra cast
    // member beyond 4, and require a minimum dominance ratio over the runner-up.
    const dominanceRatio = second ? best?.finalScore / Math.max(1, second.finalScore) : Infinity;
    const castPenalty = Math.max(0, (genderFilteredNames.length - 4) * 0.03);
    const adjustedThreshold = (pronounMinScore ?? PRONOUN_MIN_SCORE) + castPenalty;

    if (best && best.finalScore >= adjustedThreshold) {
      const totalScore = ranked.candidates.reduce((s, x) => s + Math.max(0, x.finalScore), 0);
      const topProb = totalScore > 0 ? Math.max(0, best.finalScore) / totalScore : ranked.confidence;
      const traceBase = {
        spanText: quoteContent ?? "",
        contextBefore: before.slice(-120),
        contextAfter: after.slice(0, 120),
        candidates: ranked.candidates,
        predictedLabel: best.label ?? null,
        confidence: ranked.confidence,
        needsReview: ranked.needsReview,
        ambiguityGap: ranked.ambiguityGap,
        source: "pronoun-bayes",
      };

      if (topProb >= 0.40 && dominanceRatio >= 1.8) {
        return {
          speaker: best.label ?? undefined,
          type: 'speech',
          confidence: Math.max(topProb * 0.85, ranked.confidence * 0.8),
          trace: traceBase,
        };
      } else if (topProb >= PRONOUN_MIN_POSTERIOR && second && dominanceRatio >= 1.4) {
        return {
          speaker: best.label ?? undefined,
          type: 'speech',
          confidence: Math.max(topProb * 0.50, ranked.confidence * 0.55),
          trace: traceBase,
        };
      }
    }
    return {
      speaker: undefined,
      type: 'speech',
      confidence: 0,
      trace: {
        spanText: quoteContent ?? "",
        contextBefore: before.slice(-120),
        contextAfter: after.slice(0, 120),
        candidates: ranked.candidates,
        predictedLabel: null,
        confidence: ranked.confidence,
        needsReview: true,
        ambiguityGap: ranked.ambiguityGap,
        source: "pronoun-bayes",
      },
    };
  }

  // ★ TWO TARGETED FIXES TRIED HERE AND BOTH REJECTED — read before trying a third.
  //
  // HIGH mode is the WORST of the three on definite descriptions (33 wrong against
  // fast's 16 on the 16-book corpus) while being 8.9x slower, and its descriptive
  // RECALL is identical to fast's — it converts unattributed into wrong, not into
  // correct. Two explanations were tested:
  //
  //   1. Generic speakers resolve after known names inside `findDirectName`, so a
  //      distant name beats an adjacent tag. Putting adjacent generics first LOST
  //      in every mode (176 -> 173 correct) because it fires on "the doctor said"
  //      where the doctor IS a named character.
  //   2. Step 4 below reaches back six paragraphs in high mode, so a local
  //      descriptive tag should block it. Guarding Step 4 on a local generic match
  //      left HIGH COMPLETELY UNCHANGED — the errors never reach Step 4 at all.
  //
  //   3. `findDirectName` loops over knownNames sorted by FREQUENCY, so a long
  //      window returns the protagonist rather than the nearest speaker. A
  //      nearest-wins variant left the corpus UNCHANGED and cost accuracy-suite
  //      DEFAULT a point. Reverted.
  //
  // ★ AND NOTE WHAT IS *NOT* THE ANSWER. The depth-6 window, the cross-paragraph
  // reach and the next/previous-chapter context are high mode's DESIGN, verified
  // during its development, and must not be narrowed. The goal is to make high
  // use that data more intelligently, not to give it less.
  //
  // Three explanations are now eliminated by measurement. The 17 cases where fast
  // says UNATTRIBUTED and high says WRONG are set by a high-only path further up:
  // subjectWeights, the dialogue thread, extCtx density, or pronounMinScore 12
  // against fast's higher floor. INSTRUMENT WHICH SOURCE sets the speaker on those
  // 17 before attempting a fourth fix — every attempt so far has been a
  // well-reasoned guess at the wrong layer, and the harness can answer this
  // directly.

  // ── Step 4: extended context (previous paragraphs) ──
  //
  // ★ ALSO YIELDS TO AN EXPLICIT TAG, for the same reason branch C does. This
  // step reaches back six paragraphs in high mode — by design, and that reach is
  // what lets it resolve speakers the local paragraph never names. But reaching
  // back is the wrong move when the local text says "said the child": a name from
  // four paragraphs ago cannot outrank the words touching the quote.
  //
  // Ablation on the post-branch-C baseline showed every high-only MECHANISM is
  // neutral on the remaining descriptive errors, and only reducing extCtxDepth
  // 6 -> 3 moved them (26 wrong -> 22). Cutting the depth is not an option — it is
  // the mode's design and its reach. Yielding to explicit evidence gets the same
  // errors back while keeping every paragraph.
  // Resolve the tag the guard just deferred to, rather than leaving it silent.
  {
    const descr = speakerFromDescriptiveTag(after);
    if (descr) return { speaker: descr, type: 'speech', confidence: 0.75 };
  }

  if (extCtx && !hasExplicitTrailingTag(after)) {
    const extName = findDirectName(extCtx, knownNames, cache);
    if (extName) {
      // Validate with recency: only use if this character was recently active
      const k = normKey(extName);
      const recency = Math.max(speakWeights.get(k) ?? 0, mentionWeights.get(k) ?? 0);
      // ── Learned transition boost ──────────────────────────────────────
      // If the user's annotation data indicates that extName frequently
      // follows the most-recent attributed speaker, raise confidence slightly.
      // This is a read-only check; `learnedBias` is captured in the outer
      // `detectSpeechInChapter` closure and available here via `options`.
      const prevSpeaker = recentSpeakers[recentSpeakers.length - 1];
      const transitionBoost =
        learnedBias && prevSpeaker
          ? (learnedBias.speakerTransitions[prevSpeaker]?.[extName] ?? 0)
          : 0;
      if (recency >= 0.3) {
        return { speaker: extName, type: 'speech', confidence: Math.min(0.72, 0.58 + transitionBoost * 0.3) };
      }
    }
  }

  return { speaker: undefined, type: 'speech', confidence: 0 };
}

// ── Per-paragraph processor ───────────────────────────────────────────────

interface ParaResult {
  segments: SpeechSegment[];
  endsOpen: boolean;
}

function processParagraph(
  text: string,
  paragraphIndex: number,
  knownNames: string[],
  isContinuation: boolean,
  extCtx: string,
  nextParaStart: string,
  speakWeights: Map<string, number>,
  mentionWeights: Map<string, number>,
  activeSubject: string | undefined,
  prevParaFocus: { name: string; ratio: number } | undefined,
  recentSpeakers: string[],
  genderMap?: Map<string, GenderHint>,
  maxRecentSpeakers?: number,
  pronounMinScore?: number,
  thread?: DialogueThread,
  extCtxDensity?: Map<string, number>,
  continuationDepth?: number,
  activeSubjectIsLocal?: boolean,
  learnedBias?: import("../types").LearnedBias,
  adaptiveContext?: import("../types").AdaptiveInferenceContext,
  predictionTraceOut?: { value: import("../types").AdaptivePredictionTrace[] },
  cache?: NameRegexCache,
): ParaResult {
  const segments: SpeechSegment[] = [];

  if (isContinuation) {
    let closeIdx = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === CLOSE_DOUBLE || ch === ASCII_DOUBLE || ch === CLOSE_SINGLE) {
        closeIdx = i; break;
      }
    }
    if (closeIdx === -1) {
      const attr = findAttribution(text, nextParaStart, extCtx, knownNames,
        speakWeights, mentionWeights, activeSubject, prevParaFocus, undefined, recentSpeakers, genderMap, pronounMinScore, thread, extCtxDensity, activeSubjectIsLocal, learnedBias, adaptiveContext, cache);
      const confMod = Math.max(0.6, 1.0 - ((continuationDepth ?? 0) * 0.12));
      const spanIndex = segments.length;
      segments.push({ start: 0, end: text.length, speaker: attr.speaker, continuation: true, type: 'speech', confidence: attr.confidence * confMod });
      if (predictionTraceOut) {
        predictionTraceOut.value.push({
          ...(attr.trace ?? {
            spanText: text,
            contextBefore: "",
            contextAfter: nextParaStart.slice(0, 120),
            candidates: [{
              label: attr.speaker ?? null,
              source: attr.type === 'speech' ? 'rule' : 'narrative',
              baseScore: attr.confidence * 100,
              learnedAdjustment: 0,
              finalScore: attr.confidence * 100,
              features: { base_score: attr.confidence, direct_rule: 1 },
            }],
            predictedLabel: attr.speaker ?? null,
            confidence: attr.confidence * confMod,
            needsReview: attr.confidence > 0 && attr.confidence < 0.58,
            ambiguityGap: attr.confidence * 100,
            source: 'rule',
          }),
          task: 'speech',
          paragraphIndex,
          spanIndex,
        });
      }
      if (attr.speaker) speakWeights.set(normKey(attr.speaker), 1.0);
      return { segments, endsOpen: true };
    }
    const contBefore = text.slice(0, closeIdx + 1);
    const contAfter  = text.slice(closeIdx + 1);
    const attr = findAttribution(contBefore, contAfter, extCtx, knownNames,
      speakWeights, mentionWeights, activeSubject, prevParaFocus, undefined, recentSpeakers, genderMap, pronounMinScore, thread, extCtxDensity, activeSubjectIsLocal, learnedBias, adaptiveContext, cache);
    const confMod = Math.max(0.6, 1.0 - ((continuationDepth ?? 0) * 0.12));
    const spanIndex = segments.length;
    segments.push({ start: 0, end: closeIdx + 1, speaker: attr.speaker, continuation: true, type: 'speech', confidence: attr.confidence * confMod });
    if (predictionTraceOut) {
      predictionTraceOut.value.push({
        ...(attr.trace ?? {
          spanText: contBefore,
          contextBefore: "",
          contextAfter: contAfter.slice(0, 120),
          candidates: [{
            label: attr.speaker ?? null,
            source: attr.type === 'speech' ? 'rule' : 'narrative',
            baseScore: attr.confidence * 100,
            learnedAdjustment: 0,
            finalScore: attr.confidence * 100,
            features: { base_score: attr.confidence, direct_rule: 1 },
          }],
          predictedLabel: attr.speaker ?? null,
          confidence: attr.confidence * confMod,
          needsReview: attr.confidence > 0 && attr.confidence < 0.58,
          ambiguityGap: attr.confidence * 100,
          source: 'rule',
        }),
        task: 'speech',
        paragraphIndex,
        spanIndex,
      });
    }
    if (attr.speaker) speakWeights.set(normKey(attr.speaker), 1.0);

    const rest = processParagraph(
      text.slice(closeIdx + 1), paragraphIndex, knownNames, false, extCtx, nextParaStart,
      speakWeights, mentionWeights, activeSubject, prevParaFocus, recentSpeakers, genderMap, maxRecentSpeakers, pronounMinScore, thread, extCtxDensity,
      undefined,
      activeSubjectIsLocal,
      learnedBias,
      adaptiveContext,
      predictionTraceOut,
      cache,
    );
    for (const seg of rest.segments) {
      segments.push({ ...seg, start: seg.start + closeIdx + 1, end: seg.end + closeIdx + 1 });
    }
    return { segments, endsOpen: rest.endsOpen };
  }

  const pairs = extractQuotePairs(text);
  const asciiCount = (text.match(/"/g) ?? []).length;
  const endsOpen = asciiCount % 2 !== 0;

  // Adjacent quote inheritance state
  let lastAttributedSpeaker: string | undefined;
  let lastAttributedConfidence = 0;
  let prevPairEnd = 0;

  for (const pair of pairs) {
    const before = text.slice(0, pair.start);
    const after  = text.slice(pair.end + 1);
    const quoteContent = text.slice(pair.start + 1, pair.end);
    let attr = findAttribution(before, after, extCtx, knownNames,
      speakWeights, mentionWeights, activeSubject, prevParaFocus, quoteContent, recentSpeakers, genderMap, pronounMinScore, thread, extCtxDensity, activeSubjectIsLocal, learnedBias, adaptiveContext, cache);

    // Adjacent quote inheritance: if attribution failed but the immediately
    // preceding attributed quote had high confidence and no new named actor
    // appeared in the beat text between them, inherit the same speaker with decay.
    if (!attr.speaker && lastAttributedSpeaker && lastAttributedConfidence >= 0.65) {
      const beatText = text.slice(prevPairEnd, pair.start);
      const beatActor = findActionSubject(beatText, knownNames, cache);
      const newActor = beatActor && normKey(beatActor) !== normKey(lastAttributedSpeaker);
      if (!newActor) {
        attr = { speaker: lastAttributedSpeaker, type: 'speech', confidence: lastAttributedConfidence * 0.82 };
      }
    }

    const spanIndex = segments.length;
    segments.push({ start: pair.start, end: pair.end + 1, speaker: attr.speaker, type: attr.type, confidence: attr.confidence });
    if (predictionTraceOut) {
      predictionTraceOut.value.push({
        ...(attr.trace ?? {
          spanText: text.slice(pair.start, pair.end + 1),
          contextBefore: before.slice(-120),
          contextAfter: after.slice(0, 120),
          candidates: [{
            label: attr.speaker ?? null,
            source: attr.type === 'speech' ? 'rule' : 'narrative',
            baseScore: attr.confidence * 100,
            learnedAdjustment: 0,
            finalScore: attr.confidence * 100,
            features: { base_score: attr.confidence, direct_rule: 1 },
          }],
          predictedLabel: attr.speaker ?? null,
          confidence: attr.confidence,
          needsReview: attr.confidence > 0 && attr.confidence < 0.58,
          ambiguityGap: attr.confidence * 100,
          source: 'rule',
        }),
        task: 'speech',
        paragraphIndex,
        spanIndex,
      });
    }
    if (attr.speaker && attr.type === 'speech') {
      lastAttributedSpeaker = attr.speaker;
      lastAttributedConfidence = attr.confidence;
      speakWeights.set(normKey(attr.speaker), 1.0);
      activeSubject = attr.speaker;
      // H1: Track recent high-confidence speakers for turn-taking detection.
      // Window size is controlled by intelligenceLevel via maxRecentSpeakers.
      if (attr.confidence >= 0.65) {
        recentSpeakers.push(attr.speaker);
        if (recentSpeakers.length > (maxRecentSpeakers ?? 7)) recentSpeakers.shift();
      }
    }
    prevPairEnd = pair.end + 1;
  }

  return { segments, endsOpen };
}

// ── Hoisted term arrays for computeParagraphMeta (allocated once) ────────

const META_CONFRONTATION_VERBS: readonly string[] = [
  'demanded', 'challenged', 'confronted', 'pressed', 'insisted',
  'refused', 'snapped', 'accused', 'pleaded', 'confessed', 'denied',
  'seized', 'yanked', 'shoved', 'slammed', 'grabbed',
  'screamed', 'shouted', 'yelled', 'barked', 'hissed', 'snarled',
  'cornered', 'blocked', 'restrained', 'threatened', 'warned',
  'begged', 'lunged', 'struck',
  'slashed', 'parried', 'deflected', 'dodged', 'charged', 'impaled',
  'cut down', 'cut through', 'pierced', 'overwhelmed', 'overpowered',
  'drove back', 'knocked back', 'sent flying', 'disarmed',
  'defeated', 'destroyed',
];

const META_PHYS_TERMS: readonly string[] = [
  'trembling', 'trembled', 'tremor', 'shaking', 'shook',
  'gripped', 'clutched', 'clenched', 'tightened', 'tensed',
  'burning', 'strained', 'flinched', 'winced', 'braced',
  'stumbled', 'staggered', 'doubled over',
  'breath caught', 'held her breath', 'held his breath', 'their breath',
  'heart pounded', 'heart raced', 'pulse quickened',
  'white knuckles', 'jaw tightened', 'shoulders tensed',
];

const META_FEAR_TERMS: readonly string[] = [
  'afraid', 'frightened', 'terrified', 'dread',
  'desperate', 'panic', 'alarmed', 'horrified',
  'vulnerable', 'exposed', 'helpless', 'powerless',
  'grief', 'despair', 'anguish', 'shattered', 'devastated',
  'ached', 'aching', 'unbearable',
  'rage', 'fury', 'wrath', 'hatred', 'overwhelming',
  'desperation', 'bloodlust', 'killing intent',
];

const META_SILENCE_TERMS: readonly string[] = [
  'silence', 'silent', 'motionless', 'without a word',
  'said nothing', 'no words', "couldn't speak",
  'not allowed', 'forbidden', 'refused to answer', 'refused to look',
  'looked away', 'turned away',
];

const META_SUPPRESSION_TERMS: readonly string[] = [
  'bit back', 'swallowed hard', 'fought the urge',
  'kept her voice', 'kept his voice', 'steady voice',
  'held herself', 'held himself', 'held back',
  'forced herself', 'forced himself', 'made herself', 'made himself',
  'did not react', 'did not move', 'did not speak', 'did not answer',
  'carefully controlled', 'struggled to keep',
];

const META_DISASTER_TERMS: readonly string[] = [
  'explosion', 'exploded', 'detonated', 'blast', 'detonation',
  'debris', 'rubble', 'smoke', 'flames', 'fire spread',
  'shockwave', 'concussion',
  'bleeding', 'wounded', 'injuries',
  'shattered glass', 'chaos', 'screaming',
];

const META_REVELATION_TERMS: readonly string[] = [
  'admitted', 'confessed', 'broke the silence',
  'who are you', 'what are you', 'what you are', 'who you are',
  'the truth', 'truth is', 'had to know', 'needed to know',
  'all along', 'finally said', 'finally admitted', 'always knew',
];

const META_ABSTRACT_TERMS: readonly string[] = [
  'threshold', 'limit', 'margin', 'capacity', 'failure',
  'collapse', 'degradation', 'fragment', 'separation', 'fracture',
  'the cost', 'weight of', 'burden', 'erosion',
  'void', 'absence', 'the boundary', 'the gap', 'the distance',
  'consumed', 'projection',
  'parameters', 'tolerance', 'protocol', 'directive', 'procedure',
  'classification', 'designation', 'assigned', 'clearance', 'restricted',
  'compliant', 'non-compliant', 'deviation', 'variance', 'anomaly',
  'the system', 'the facility', 'the program', 'the record', 'the file',
  'scheduled', 'pending', 'delayed', 'suspended', 'terminated',
  'monitoring', 'assessment', 'evaluation', 'performance', 'output',
  'the weight', 'the silence', 'the space between', 'the interval',
  'accumulation', 'residue', 'implication', 'undercurrent', 'signal',
  'the pattern', 'the structure', 'the arrangement', 'the logic of',
];

const META_FANTASY_TERMS: readonly string[] = [
  'mana', 'magic power', 'cast a spell', 'spellcraft',
  'skill activated', 'skill:', 'ability activated', 'level up',
  'status screen', 'system message', 'notification',
  'killing aura', 'murderous aura', 'pressure emanated',
  'power level', 'overwhelmed by power', 'surpassed', 'overpowered by',
  'flames erupted', 'lightning crackled', 'ice spread',
  'the ground shook', 'the air crackled', 'mana exploded',
];

const META_QUIET_PIVOT_TERMS: readonly string[] = [
  'for the first time', 'the last time', 'never before', 'never again',
  'something changed', 'the moment', 'in that moment', 'only then',
  'it was then', 'she understood', 'he understood', 'it became clear',
  'the realization', 'the truth was', 'finally knew', 'already knew',
  'she found', 'he found', 'discovered',
];

const META_CELEB_HINTS: readonly string[] = [
  'festival', 'celebration', 'music', 'laughter', 'dancing',
  'golden light', 'warm light', 'gathered', 'joy', 'singing',
  'at the inn', 'the tavern', 'the guild', 'the village', 'at the feast',
  'sat down to eat', 'cooked', 'prepared a meal', 'shared a meal',
];

const META_INTIMATE_HINTS: readonly string[] = [
  'warmth', 'smiled', 'laughed', 'between them', 'beside her',
  'beside him', 'her hand', 'his hand', 'their hands',
  'familiar', 'close to', 'at ease', 'comfortable', 'gentle',
  'the warmth of',
  'across from her', 'across from him', 'sat together',
  'looked at each other', 'met his eyes', 'met her eyes',
  'the party', 'his companion', 'her companion',
];

const META_REFLECTIVE_HINTS: readonly string[] = [
  'remembered', 'thinking', 'thought about', 'wondered',
  'watching', 'listening', 'waiting', 'observed', 'noticed',
  'memory', 'for years', 'for so long', 'had always',
  'meaning', 'understood', 'realized', 'as though', 'felt like',
  'i thought', 'my mind', 'i realized', 'it occurred to me', 'in my head',
  'i had been', 'i wondered', 'i considered',
];

const META_WEIGHTED_HINTS: readonly string[] = [
  'carried for', 'borne for', 'held for', 'for decades',
  'for centuries', 'for longer than', 'across the years',
  'the weight of', 'the cost of', 'no one alive',
];

const META_SIGNIFICANT_HINTS: readonly string[] = [
  'for the first time', 'the last time', 'never before', 'never again',
  'would remember', 'would not forget', 'something changed',
  'the moment', 'in that moment',
];

// Explicit violence / combat / injury vocabulary. Weighted moderately so a
// single stray gothic term ("blood", "bone") can't flip calm prose, but a
// genuine action beat (several terms) reads high. Substring-matched.
const META_VIOLENCE_TERMS: readonly string[] = [
  'blade', 'knife', 'sword', 'dagger', 'axe', 'spear',
  'blood', 'bloody', 'wound', 'gash', 'stab', 'slash', 'impaled',
  'fist', 'punch', 'kick', 'choke', 'strangl', 'throat', 'skull', 'ribs', 'claw',
  'swung', 'hurled', 'flung', 'smashed', 'crushed', 'wrench', 'recoil',
  'shatter', 'crash', 'grappl', 'jaw',
  'lunging', 'tackled', 'wrestled', 'gunshot', 'bullet', 'trigger',
  'hit the floor', 'drove into', 'could not breathe', "couldn't breathe",
  "couldn’t breathe", 'crumpled', 'reeled', 'the blows', 'blow after',
];

// Subtle dread / unease — psychological tension without violent words. Light
// weight; needs several to register so calm prose stays calm.
const META_UNEASE_TERMS: readonly string[] = [
  'something was wrong', 'something wrong', 'something was off', 'not right',
  'would not meet', 'could not meet', "couldn't meet", "couldn’t meet",
  'would not look', 'refused to meet', 'avoided her eyes', 'avoided his eyes',
  'chest tightened', 'chest tightening', 'went cold', 'blood ran cold',
  'a chill', 'uneasy', 'unease', 'on edge', 'wary',
];

// ── Paragraph tension metadata ───────────────────────────────────────────

/**
 * Derives tension metadata for a paragraph using semantic/lexical scoring
 * across multiple independent signal dimensions.  Works on pure narrative
 * prose as well as dialogue-heavy paragraphs.
 *
 * Signals scored (each capped independently to prevent a single category
 * from dominating):
 *   1. Confrontation / action verbs       (+2 each, cap 10)
 *   2. Physical tension vocabulary        (+2 each, cap  8)
 *   3. Fear / emotional-exposure words    (+1.5 each, cap 6)
 *   4. Silence / constraint vocabulary    (+1 each, cap  5)
 *   5. Suppression / restraint phrases    (+1.5 each, cap 4.5)
 *   6. Disaster / physical-damage words   (+2.5 each, cap 7.5)
 *   7. Revelation vocabulary              (+1.5 each, cap 4.5)
 *   8. Sentence rhythm (fragmentation)    (up to +5)
 *   9. Question-mark density              (up to +4)
 *  10. Rapid dialogue exchange            (up to +7)
 *  11. Exclamation marks                  (up to +2)
 *  12. High dialogue density              (up to +2)
 *  13. Carry-forward from prevMeta        (+1.5 rising, +2 high)
 *
 * Thresholds: total ≥ 9 → 'high', ≥ 4.5 → 'rising', else 'calm'.
 */

// Fast-mode equivalent: skips all signal scoring to eliminate ~200 includes() calls/paragraph.
// Returns dialogueDensity for density-trend correctness; tension is always 'calm'
// (groupIntoScenes is already skipped in fast mode so sceneTension is never needed).
function computeParagraphMetaFast(para: string, segments: SpeechSegment[]): ParagraphMeta {
  if (para.length < 15) return { tension: 'calm', dialogueDensity: 0 };
  const speechChars = segments
    .filter(s => s.type === 'speech')
    .reduce((sum, s) => sum + (s.end - s.start), 0);
  return { tension: 'calm', dialogueDensity: speechChars / para.length };
}

function computeParagraphMeta(
  para: string,
  segments: SpeechSegment[],
  prevMeta?: ParagraphMeta,
): ParagraphMeta {
  const totalChars = para.length;
  if (totalChars < 15) return { tension: 'calm', dialogueDensity: 0 };

  const speechChars = segments
    .filter(s => s.type === 'speech')
    .reduce((sum, s) => sum + (s.end - s.start), 0);
  const dialogueDensity = speechChars / totalChars;

  const lower = para.toLowerCase();
  const has = (phrase: string) => lower.includes(phrase);

  // ── Sentence structure (hoisted — shared by signals 8, 14, 16 and hints)
  const sents = para.split(/(?<=[.!?])\s+(?=[A-Z"'\u2014])/).filter(s => s.trim().length > 3);
  const shortSents = sents.filter(s => s.trim().length < 40).length;
  const shortRatio = sents.length > 0 ? shortSents / sents.length : 0;
  const avgSentenceLength = sents.length > 0
    ? sents.reduce((a, s) => a + s.length, 0) / sents.length
    : 0;
  const punctuationDensity = (para.match(/[,.!?;:—]/g) ?? []).length / totalChars;

  let score = 0;

  // ── Signal 1: Confrontation / action verbs (+2 each, cap 10) ─────────
  let confrontationCount = 0;
  for (const v of META_CONFRONTATION_VERBS) if (has(v)) confrontationCount++;
  score += Math.min(confrontationCount * 2, 10);

  // ── Signal 2: Physical tension signals (+2 each, cap 8) ──────────────
  let physicalCount = 0;
  for (const w of META_PHYS_TERMS) if (has(w)) physicalCount++;
  score += Math.min(physicalCount * 2, 8);

  // ── Signal 3: Fear / emotional-exposure vocabulary (+1.5 each, cap 6) ─
  let fearCount = 0;
  for (const w of META_FEAR_TERMS) if (has(w)) fearCount++;
  score += Math.min(fearCount * 1.5, 6);

  // ── Signal 3b: Subtle dread / unease — psychological tension (+1.5, cap 4.5)
  let uneaseCount = 0;
  for (const w of META_UNEASE_TERMS) if (has(w)) uneaseCount++;
  score += Math.min(uneaseCount * 1.5, 4.5);

  // ── Signal 4: Silence / constraint vocabulary (+1 each, cap 5) ────────
  let silenceCount = 0;
  for (const w of META_SILENCE_TERMS) if (has(w)) silenceCount++;
  score += Math.min(silenceCount * 1, 5);

  // ── Signal 5: Restraint / suppression phrases (+1.5 each, cap 4.5) ───
  let suppressionCount = 0;
  for (const w of META_SUPPRESSION_TERMS) if (has(w)) suppressionCount++;
  score += Math.min(suppressionCount * 1.5, 4.5);

  // ── Signal 6: Disaster / physical-damage vocabulary (+2.5 each, cap 7.5)
  let disasterCount = 0;
  for (const w of META_DISASTER_TERMS) if (has(w)) disasterCount++;
  score += Math.min(disasterCount * 2.5, 7.5);

  // ── Signal 6b: Explicit violence / combat / injury (+2.5 each, cap 10) ─
  let violenceCount = 0;
  for (const w of META_VIOLENCE_TERMS) if (has(w)) violenceCount++;
  score += Math.min(violenceCount * 2.5, 10);

  // ── Signal 7: Revelation / truth vocabulary (+1.5 each, cap 4.5) ──────
  let revelationCount = 0;
  for (const w of META_REVELATION_TERMS) if (has(w)) revelationCount++;
  score += Math.min(revelationCount * 1.5, 4.5);

  // ── Signal 8: Sentence rhythm — fragmentation signals urgency ─────────
  if (sents.length >= 4) {
    if (shortRatio > 0.70)      score += 5;
    else if (shortRatio > 0.50) score += 3;
    else if (shortRatio > 0.35) score += 1.5;
  } else if (sents.length === 3 && shortRatio > 0.70) {
    score += 3;
  }

  // ── Signal 9: Question-mark density (full paragraph, not just speech) ─
  const questionCount = (para.match(/\?/g) ?? []).length;
  if (questionCount >= 4)       score += 4;
  else if (questionCount >= 3)  score += 2.5;
  else if (questionCount >= 2)  score += 1.5;
  else if (questionCount === 1) score += 0.5;

  // ── Signal 10: Rapid dialogue exchange ───────────────────────────────
  const speechSegs = segments.filter(s => s.type === 'speech');
  const shortSpeechSegs = speechSegs.filter(s => (s.end - s.start) < 55).length;
  const speakerSwitches = speechSegs.reduce(
    (n, s, i) => (i > 0 && s.speaker && s.speaker !== speechSegs[i - 1].speaker ? n + 1 : n),
    0,
  );
  if (shortSpeechSegs >= 4 && speakerSwitches >= 2) score += 5;
  else if (shortSpeechSegs >= 3 && speakerSwitches >= 1) score += 3;
  else if (shortSpeechSegs >= 2) score += 1.5;
  if (speakerSwitches >= 3)      score += 2;
  else if (speakerSwitches >= 2) score += 1;

  // ── Signal 11: Exclamation marks (+0.5 each, cap 2) ──────────────────
  score += Math.min((para.match(/!/g) ?? []).length * 0.5, 2);

  // ── Signal 12: High dialogue density ─────────────────────────────────
  if (dialogueDensity > 0.70)      score += 2;
  else if (dialogueDensity > 0.50) score += 1;

  // ── Fix: single-quote false positive dampening ────────────────────────
  // A lone short quote (e.g. "Where is the facility?") inflates question/
  // density/exchange signals without any real tense lexical content.
  const hasHighLexical = confrontationCount >= 1 || physicalCount >= 1
    || disasterCount >= 1 || fearCount >= 1 || violenceCount >= 1;
  if (!hasHighLexical && speechSegs.length <= 1 && dialogueDensity > 0.80 && totalChars < 150) {
    score *= 0.3;
  }

  // ── Signal 14: Repeated sentences / anaphora (+2.5 each, cap 5) ───────
  // Poetic repetition and trauma-echo mark high-intensity prose moments.
  const sentCounts = new Map<string, number>();
  for (const s of sents) {
    const key = s.trim().toLowerCase();
    if (key.length < 80) sentCounts.set(key, (sentCounts.get(key) ?? 0) + 1);
  }
  const repeatedLines = Array.from(sentCounts.values()).filter(c => c > 1).length;
  score += Math.min(repeatedLines * 2.5, 5);

  // ── Signal 15: Abstract concept density (+1.2 each, cap 5) ────────────
  let abstractCount = 0;
  for (const w of META_ABSTRACT_TERMS) if (has(w)) abstractCount++;
  score += Math.min(abstractCount * 1.2, 5);

  // ── Signal 16: Low-entropy controlled prose (+2.5) ────────────────────
  // Very long sentences + sparse punctuation = the novel's characteristic
  // "controlled tension" philosophical style. No longer gated by abstractCount
  // so it fires on any long-form literary prose, not just Hollow Iris.
  if (avgSentenceLength > 120 && punctuationDensity < 0.06) {
    score += 2.5;
  }

  // ── Signal 18: Fantasy / power-system vocabulary (+1.5 each, cap 6) ──
  let fantasyCount = 0;
  for (const w of META_FANTASY_TERMS) if (has(w)) fantasyCount++;
  score += Math.min(fantasyCount * 1.5, 6);

  // ── Signal 17: Contrast spike — calm → intense jump (+2) ─────────────
  if (prevMeta?.tension === 'calm' && score >= 6) {
    score += 2;
  }

  // ── Signal 19: Dialogue density trend (+1.2 / +2.5) ─────────────────
  // A chapter scene moving rapidly from low→high dialogue density signals
  // escalating confrontation even before lexical content becomes intense.
  // Applied in all modes (cheap: one subtraction).
  if (prevMeta) {
    const densityTrend = dialogueDensity - (prevMeta.dialogueDensity ?? 0);
    if (densityTrend > 0.30)      score += 2.5;
    else if (densityTrend > 0.15) score += 1.2;
  }

  // ── Signal 20: Interrupted speech (em-dash cuts) (+2) ────────────────
  // "I don't think—" is an inherently tense speech pattern.
  if (/[\u201c"][^"\u201d]*[\u2014\u2013]\s*[\u201d"]/.test(para)) {
    score += 2;
  }

  // ── Signal 13: EWMA carry-forward (replaces fixed +2/+1.5 to prevent runaway)
  // The EWMA decays naturally when prose calms down, so sustained high-tension
  // passages can't permanently floor the score at 'rising' or 'high'.
  // tensionEWMA is tracked externally and passed in via prevMeta.__ewma.
  const prevEWMA: number = (prevMeta as ParagraphMeta & { __ewma?: number })?.__ewma ?? 0;
  const rawNumeric = score >= 9 ? 1.0 : score >= 4.5 ? 0.5 : 0;
  const nextEWMA = 0.45 * rawNumeric + 0.55 * prevEWMA;
  const prevBoost = prevEWMA * 2.5;  // max +2.5 when EWMA=1.0 (vs fixed +2)

  const total = score + prevBoost;

  // ── Classify ──────────────────────────────────────────────────────────
  let tension: 'calm' | 'rising' | 'high';
  let label: string | undefined;

  if (total >= 9) {
    tension = 'high';
    if (disasterCount >= 2)
      label = 'impact';
    else if (violenceCount >= 3)
      label = 'violence';
    else if (confrontationCount >= 2 && questionCount >= 2)
      label = 'confrontation';
    else if (shortRatio > 0.65 && sents.length >= 3)
      label = 'intense';
    else if (physicalCount >= 2)
      label = 'tense';
    else if (revelationCount >= 1)
      label = 'breaking point';
    else if (speakerSwitches >= 2)
      label = 'rapid exchange';
    else if (suppressionCount >= 2)
      label = 'pressure';
    else if (fantasyCount >= 2)
      label = 'combat';
    else
      label = 'tense';
  } else if (total >= 4.5) {
    tension = 'rising';
  } else {
    tension = 'calm';
    // H4 — Quiet pivot detection: a calm paragraph with narrative pivot
    // vocabulary is marked as a noteworthy event even without tension.
    if (META_QUIET_PIVOT_TERMS.some(w => lower.includes(w))) {
      label = 'quiet pivot';
    }
  }

  // ── Paragraph quality hint (aggregated by groupIntoScenes) ────────────
  // Computed regardless of tension level so the scene grouper has signals
  // for labelling calm scenes (celebration, connection, reflection, etc.).
  let celebCount = 0, intimateCount = 0, reflectCount = 0;
  let weightedHintCount = 0, significantCount = 0;
  for (const w of META_CELEB_HINTS)       if (has(w)) celebCount++;
  for (const w of META_INTIMATE_HINTS)    if (has(w)) intimateCount++;
  for (const w of META_REFLECTIVE_HINTS)  if (has(w)) reflectCount++;
  for (const w of META_WEIGHTED_HINTS)    if (has(w)) weightedHintCount++;
  for (const w of META_SIGNIFICANT_HINTS) if (has(w)) significantCount++;

  let paragraphHint: ParagraphMeta['paragraphHint'];
  if      (celebCount >= 2)                               paragraphHint = 'celebratory';
  else if (intimateCount >= 3)                            paragraphHint = 'intimate';
  else if (significantCount >= 2)                         paragraphHint = 'significant';
  else if (reflectCount >= 3 || avgSentenceLength > 130)  paragraphHint = 'reflective';
  else if (weightedHintCount >= 2)                        paragraphHint = 'weighted';

  // Store the EWMA state on the meta object so it can be passed to the next para.
  // Using a type assertion to keep the public ParagraphMeta interface clean.
  const meta: ParagraphMeta & { __ewma: number } = {
    tension, label, dialogueDensity, paragraphHint, __ewma: nextEWMA,
  };
  return meta;
}

// ── Scene grouping ────────────────────────────────────────────────────────

/**
 * Derives a human-readable scene label from the aggregate text and hints
 * of all paragraphs belonging to a single scene group.
 */
function computeSceneLabel(
  paragraphTexts: string[],
  sceneTension: 'calm' | 'rising' | 'high',
  sceneResults: ChapterParaResult[],
): string | undefined {
  // High-tension: use the dominant per-paragraph label
  if (sceneTension === 'high') {
    const highLabel = sceneResults
      .filter(r => r.meta.tension === 'high' && r.meta.label)
      .map(r => r.meta.label as string)[0];
    return highLabel ?? 'intense';
  }

  // Rising-tension: characterise the flavour of pressure
  if (sceneTension === 'rising') {
    const topLabel = sceneResults.map(r => r.meta.label).find(l => l);
    if (topLabel) return topLabel;
    const sceneText = paragraphTexts.join(' ').toLowerCase();
    if (sceneText.includes('silence') || sceneText.includes('said nothing')
        || sceneText.includes('refused to') || sceneText.includes('turned away'))
      return 'weighted silence';
    const avgDd = sceneResults.reduce((a, r) => a + r.meta.dialogueDensity, 0) / sceneResults.length;
    return avgDd > 0.25 ? 'friction' : 'undercurrent';
  }

  // Calm scenes: aggregate hint votes across all paragraphs in the scene
  const hints = sceneResults
    .map(r => r.meta.paragraphHint)
    .filter((h): h is NonNullable<ParagraphMeta['paragraphHint']> => h !== undefined);

  const votes = new Map<string, number>();
  for (const h of hints) votes.set(h, (votes.get(h) ?? 0) + 1);

  const sceneText = paragraphTexts.join(' ').toLowerCase();

  // Silence / withholding scene → the "weighted silence" beat. Fires on a
  // concentration of silence + refusal vocabulary even when tension stays calm.
  const silenceVocab = ['silence', 'said nothing', 'refused', 'would not', 'turned away', 'looked away', 'without a word', 'no words']
    .filter(w => sceneText.includes(w)).length;
  if (silenceVocab >= 2) return 'weighted silence';

  // Celebratory: needs both hint vote and strong vocabulary overlap
  const celebVocab = ['festival', 'celebration', 'music', 'laughter', 'dancing', 'joy', 'golden', 'together']
    .filter(w => sceneText.includes(w)).length;
  if ((votes.get('celebratory') ?? 0) >= 1 && celebVocab >= 3) return 'celebration';

  // Intimate / conversation
  const avgDialogue = sceneResults.reduce((a, r) => a + r.meta.dialogueDensity, 0) / sceneResults.length;
  if ((votes.get('intimate') ?? 0) >= 2)
    return avgDialogue > 0.25 ? 'conversation' : 'connection';

  // Pivotal moment
  if ((votes.get('significant') ?? 0) >= 2) return 'pivotal';

  // Weighted / heavy prose
  if ((votes.get('weighted') ?? 0) >= 2) return 'weighted';

  // Reflection (most common calm quality)
  if ((votes.get('reflective') ?? 0) >= 2) return 'reflection';

  // Single strong signal from a short standalone scene
  if (hints.length === 1) {
    const singleMap: Record<string, string> = {
      reflective: 'reflection', intimate: 'connection',
      celebratory: 'celebration', weighted: 'weighted', significant: 'pivotal',
    };
    return singleMap[hints[0]];
  }

  return undefined;
}

/**
 * Post-processing pass: groups consecutive paragraphs into "scenes" and
 * stamps sceneStart / sceneLabel / sceneTension onto each scene's first
 * paragraph.  Mutates the meta objects inside `results` in place.
 *
 * Scene-boundary rules (first match wins):
 *  • Tension jumps or drops by ≥ 2 levels (hard: calm ↔ high)
 *  • Run reaches 10 paragraphs without a natural break
 *  • Dialogue-density shift > 0.45 after at least 3 paragraphs
 */
function groupIntoScenes(paragraphs: string[], results: ChapterParaResult[]): void {
  if (results.length === 0) return;

  const tLevel = (t: 'calm' | 'rising' | 'high') =>
    t === 'high' ? 2 : t === 'rising' ? 1 : 0;

  // Find scene boundaries
  const boundaries: number[] = [0];

  for (let i = 1; i < results.length; i++) {
    const prev     = results[i - 1].meta;
    const curr     = results[i].meta;
    const sceneLen = i - boundaries[boundaries.length - 1];
    const prevLvl  = tLevel(prev.tension);
    const currLvl  = tLevel(curr.tension);

    // Hard: sudden calm ↔ high jump (2-level skip)
    if (Math.abs(currLvl - prevLvl) >= 2) { boundaries.push(i); continue; }
    // Soft: any tension level change after a minimum run of 3 paragraphs
    if (Math.abs(currLvl - prevLvl) >= 1 && sceneLen >= 3) { boundaries.push(i); continue; }
    // Soft: long run cap
    if (sceneLen >= 10) { boundaries.push(i); continue; }
    // Soft: significant dialogue-density shift after at least 3 paragraphs
    if (sceneLen >= 3 && Math.abs(curr.dialogueDensity - prev.dialogueDensity) > 0.45) {
      boundaries.push(i); continue;
    }
  }

  // Annotate the first paragraph of each scene
  for (let s = 0; s < boundaries.length; s++) {
    const start       = boundaries[s];
    const end         = s + 1 < boundaries.length ? boundaries[s + 1] : results.length;
    const sceneParas  = paragraphs.slice(start, end);
    const sceneResult = results.slice(start, end);

    const maxLevel    = Math.max(...sceneResult.map(r => tLevel(r.meta.tension)));
    const sceneTension: 'calm' | 'rising' | 'high' =
      maxLevel >= 2 ? 'high' : maxLevel >= 1 ? 'rising' : 'calm';

    const sceneLabel = computeSceneLabel(sceneParas, sceneTension, sceneResult);

    results[start].meta.sceneStart   = true;
    results[start].meta.sceneTension = sceneTension;
    if (sceneLabel) results[start].meta.sceneLabel = sceneLabel;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Process an entire chapter with full cross-paragraph context.
 * Returns per-paragraph speech segments and tension metadata.
 *
 * @param paragraphs - Array of paragraph text strings
 * @param knownNames - Character names from the world data
 */
export function detectSpeechInChapter(
  paragraphs: string[],
  knownNames: string[] = [],
  options?: SpeechDetectOptions,
): ChapterParaResult[] {
  const level = options?.intelligenceLevel ?? 'default';

  // ── Level-specific settings ──────────────────────────────────────────────
  // extCtxDepth: how many previous paragraphs to include in extended context
  //   low=1  default=3  high=6
  const extCtxDepth       = level === 'fast' ? 1 : level === 'high' ? 6 : 3;
  // maxRecentSpeakers: sliding window size for bilateral turn-taking detection
  //   low=3  default=7  high=10
  const maxRecentSpeakers = level === 'fast' ? 3 : level === 'high' ? 10 : 7;
  // pronounMinScore: Bayesian posterior threshold for pronoun resolution
  //   high lowers it to 12 (more aggressive) vs default 18
  const pronounMinScore   = level === 'high' ? 12 : level === 'default' ? 16 : PRONOUN_MIN_SCORE;
  // useGenderMap: gender pre-pass is O(N·M); skip on low for speed
  const useGenderMap      = level !== 'fast';
  // useGroupScenes: scene-grouping post-pass; skip on low for speed
  const useGroupScenes    = level !== 'fast';
  const prev = options?.prevChapterContext;

  // Recency weight maps (Markov state)
  // Seeded from previous chapter context if available, otherwise initialized to 0.
  const speakWeights   = prev ? new Map(prev.speakWeights) : new Map<string, number>();
  const mentionWeights = prev ? new Map(prev.mentionWeights) : new Map<string, number>();
  for (const n of knownNames) {
    const k = normKey(n);
    if (!speakWeights.has(k))   speakWeights.set(k, 0);
    if (!mentionWeights.has(k)) mentionWeights.set(k, 0);
  }
  // Apply learned speaker priors (additive boost, identity when bias is absent).
  const learnedBias = options?.learnedBias;
  const adaptiveContext = options?.adaptiveContext;
  const predictionTraceOut = options?.predictionTraceOut;
  if (predictionTraceOut) predictionTraceOut.value = [];
  if (learnedBias) {
    for (const [name, prior] of Object.entries(learnedBias.speakerPriors)) {
      const k = normKey(name);
      speakWeights.set(k, (speakWeights.get(k) ?? 0) + prior);
    }
  }

  let openContinuation = false;
  let activeSubject: string | undefined = prev?.activeSubject;
  let prevParaFocus: { name: string; ratio: number } | undefined;
  let prevMeta: ParagraphMeta | undefined;
  // Sliding window of last N high-confidence attributed speakers.
  // Seeded from previous chapter context if available.
  const recentSpeakers: string[] = prev ? [...prev.recentSpeakers] : [];
  const result: ChapterParaResult[] = [];
  // First-mention tracking: a character's debut in the chapter is much stronger
  // evidence of narrative focus than their 40th mention.
  const everMentioned = new Set<string>();
  // Continuation depth: how many consecutive paragraphs a multi-para quote has
  // spanned. Used to decay confidence on long continuations.
  let continuationDepth = 0;
  let carryParagraphSubjectToNextOpeningQuote: string | undefined;

  // High mode: Markov-decayed subject weights to survive action/description paragraphs
  // without wiping out established speaker state. Decays slower than speakWeights (0.75/para).
  const subjectWeights = level === 'high' ? new Map<string, number>() : undefined;

  // Build gender map from the full chapter text before processing begins.
  // This pre-pass is O(N·M) but runs once; it lets pronoun resolution exclude
  // gender-mismatched candidates (e.g. 'he said' can never resolve to Nora).
  // Skipped on 'fast' intelligence level to reduce overhead.
  const nameCache = getNameRegexCache(knownNames);
  const genderMap = useGenderMap ? buildGenderMap(paragraphs, knownNames, nameCache) : undefined;

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];

    // extCtx: fast mode uses direct prior-para index (depth=1 → no array allocation)
    const extCtx = level === 'fast'
      ? (i > 0 ? paragraphs[i - 1] : '')
      : Array.from({ length: extCtxDepth }, (_, d) => {
          const idx = i - extCtxDepth + d;
          return idx >= 0 ? paragraphs[idx] : '';
        }).filter(Boolean).join(' ');

    // Next paragraph start (helps with inverted attribution at para boundaries)
    const nextParaStart = i + 1 < paragraphs.length
      ? paragraphs[i + 1].slice(0, 150)
      : '';

    // ── Mention boosts (before processing quotes) ──

    let paraSubject: string | undefined;
    let fastFocusResult: { name: string; ratio: number } | undefined;

    if (level === 'fast') {
      // ── Fast mode: combined single O(N) pass ──────────────────────────────
      // Merges detectParagraphSubject + possessive check + mention boost +
      // findParagraphFocusWithRatio into one loop. Cuts per-paragraph name-scan
      // work by ~75% vs the separate-pass default/high paths. Output is
      // numerically identical: same mentionWeights, same subject, same focus.
      const windowMatch = para.match(/^(?:[^.!?]+[.!?]\s*){0,1}[^.!?]+/);
      const windowStr = windowMatch ? windowMatch[0] : para.slice(0, 250);
      const possClauseEnd = para.search(/[.!?;—]/);
      const possClause = possClauseEnd > 0 ? para.slice(0, possClauseEnd) : para.slice(0, 150);
      let fastSubjectPos = Infinity;
      let fastPossMatch: string | undefined;
      let fastFocusName: string | undefined, fastFocusCount = 0, fastFocusTotal = 0;
      for (const name of knownNames) {
        const k = normKey(name);
        // Count all boundary mentions (includes possessives) — for focus ratio
        const mentionRe = nameCache.getMentionGi(name);
        mentionRe.lastIndex = 0;
        const count = (para.match(mentionRe) ?? []).length;
        if (count > 0) {
          fastFocusTotal += count;
          if (count > fastFocusCount) { fastFocusCount = count; fastFocusName = name; }
        }
        // NoPoss check: mention boost primary + subject position
        const noPossRe = nameCache.getWordBoundaryNoPoss(name);
        if (noPossRe.test(para)) {
          const windowHit = noPossRe.exec(windowStr);
          if (windowHit && windowHit.index < fastSubjectPos) {
            fastSubjectPos = windowHit.index;
            paraSubject = name;
          }
          const isFirstMention = !everMentioned.has(k);
          if (isFirstMention) everMentioned.add(k);
          mentionWeights.set(k, Math.min(1.0, (mentionWeights.get(k) ?? 0) + (isFirstMention ? 0.45 : 0.20)));
        } else if (count > 0) {
          // Possessive-only mention
          mentionWeights.set(k, Math.min(1.0, (mentionWeights.get(k) ?? 0) + 0.05));
          if (!fastPossMatch && !paraSubject) {
            if (nameCache.getPossessiveStart(name).test(possClause)) fastPossMatch = name;
          }
        }
      }
      // Subject boost + activeSubject (equivalent to original if(paraSubject) block)
      if (paraSubject) {
        const k = normKey(paraSubject);
        mentionWeights.set(k, Math.min(1.0, (mentionWeights.get(k) ?? 0) + 0.35));
        activeSubject = paraSubject;
      } else if (fastPossMatch) {
        const k = normKey(fastPossMatch);
        mentionWeights.set(k, Math.min(1.0, (mentionWeights.get(k) ?? 0) + 0.22));
        if (!activeSubject) activeSubject = fastPossMatch;
      }
      fastFocusResult = fastFocusName && fastFocusCount > 0
        ? { name: fastFocusName, ratio: fastFocusCount / Math.max(1, fastFocusTotal) }
        : undefined;
    } else {
      // ── Default / high mode: original multi-pass code ────────────────────
      paraSubject = detectParagraphSubject(para, knownNames, nameCache);
      if (paraSubject) {
        const k = normKey(paraSubject);
        mentionWeights.set(k, Math.min(1.0, (mentionWeights.get(k) ?? 0) + 0.35));

        if (subjectWeights) {
          subjectWeights.set(k, 1.0);
          for (const [sk, sv] of subjectWeights) {
            if (sk !== k) subjectWeights.set(sk, sv * 0.75);
          }
          let bestScore = 0;
          for (const [sk, sv] of subjectWeights) {
            if (sv > bestScore) {
              bestScore = sv;
              activeSubject = knownNames.find(n => normKey(n) === sk);
            }
          }
        } else {
          activeSubject = paraSubject;
        }
      } else {
        if (subjectWeights) {
          for (const [sk, sv] of subjectWeights) subjectWeights.set(sk, sv * 0.75);
        }
        // Possessive-leading subject: “Mareth’s lecture was about…”
        const possClauseEnd = para.search(/[.!?;—]/);
        const possClause = possClauseEnd > 0 ? para.slice(0, possClauseEnd) : para.slice(0, 150);
        for (const name of knownNames) {
          if (new RegExp(`^\s*${esc(name)}[‘’]s?\b`, 'i').test(possClause)) {
            const k = normKey(name);
            mentionWeights.set(k, Math.min(1.0, (mentionWeights.get(k) ?? 0) + 0.22));
            if (!activeSubject) activeSubject = name;
            break;
          }
        }
      }
      // Mention boosts — direct (non-possessive) mentions count more than possessive.
      // First mention in the chapter gets an elevated boost (character debut signal).
      for (const name of knownNames) {
        const k = normKey(name);
        if (nameCache.getWordBoundaryNoPoss(name).test(para)) {
          const isFirstMention = !everMentioned.has(k);
          if (isFirstMention) everMentioned.add(k);
          mentionWeights.set(k, Math.min(1.0, (mentionWeights.get(k) ?? 0) + (isFirstMention ? 0.45 : 0.20)));
        } else if (nameCache.getWordBoundary(name).test(para)) {
          mentionWeights.set(k, Math.min(1.0, (mentionWeights.get(k) ?? 0) + 0.05));
        }
      }
    }

    const carriedParagraphSubject = !paraSubject
      && carryParagraphSubjectToNextOpeningQuote
      && /^\s*[“”]/.test(para)
        ? carryParagraphSubjectToNextOpeningQuote
        : undefined;
    const localActiveSubject = paraSubject ?? carriedParagraphSubject;
    const activeSubjectIsLocal = !!localActiveSubject;
    carryParagraphSubjectToNextOpeningQuote = undefined;

    // ── High mode: build dialogue thread + extCtx density for this paragraph ──
    const thread      = level === 'high' && extCtx ? extractDialogueThread(extCtx, knownNames, genderMap) : undefined;
    const extCtxDens  = level === 'high' && extCtx ? buildExtCtxDensity(extCtx, knownNames, nameCache) : undefined;

    // Track continuation depth for confidence decay on long multi-para quotes.
    if (openContinuation) continuationDepth++;
    else continuationDepth = 0;

    // ── Process quotes ──
    const { segments, endsOpen } = processParagraph(
      para, i, knownNames, openContinuation,
      extCtx, nextParaStart,
      speakWeights, mentionWeights, localActiveSubject ?? activeSubject, prevParaFocus, recentSpeakers,
      genderMap, maxRecentSpeakers, pronounMinScore, thread, extCtxDens, continuationDepth, activeSubjectIsLocal,
      learnedBias,
      adaptiveContext,
      predictionTraceOut,
      nameCache,
    );

    // ── High mode: confidence upgrade / demotion pass ──────────────────
    if (level === 'high') {
      for (const seg of segments) {
        if (seg.type !== 'speech' || seg.confidence >= 0.65 || !seg.speaker) continue;
        const k = normKey(seg.speaker);
        const ctxScore = Math.max(speakWeights.get(k) ?? 0, mentionWeights.get(k) ?? 0);
        const inThread = thread?.turnCounts.has(k) ?? false;
        if (ctxScore >= 0.5 || inThread) {
          seg.confidence = Math.min(0.72, seg.confidence + 0.15);
        } else if (ctxScore < 0.15 && !inThread) {
          seg.speaker = undefined;
          seg.confidence = 0;
        }
      }
    }

    const meta = level === 'fast'
      ? computeParagraphMetaFast(para, segments)
      : computeParagraphMeta(para, segments, prevMeta);
    result.push({ segments, meta });
    prevMeta = meta;
    openContinuation = endsOpen;

    // ── Update Markov state ──
    for (const [k, v] of speakWeights)   speakWeights.set(k,   v * DECAY_SPEAK);
    for (const [k, v] of mentionWeights) mentionWeights.set(k, v * DECAY_MENTION);

    for (const seg of segments) {
      if (seg.speaker && seg.type === 'speech') {
        speakWeights.set(normKey(seg.speaker), 1.0);
        activeSubject = seg.speaker;
        if (subjectWeights) subjectWeights.set(normKey(seg.speaker), 1.0);
      }
    }

    // A1: prevParaFocus update (fast mode uses result computed in combined scan)
    if (level === 'fast') {
      if (fastFocusResult) prevParaFocus = fastFocusResult;
    } else {
      const thisFocus = findParagraphFocusWithRatio(para, knownNames, nameCache);
      if (thisFocus) prevParaFocus = thisFocus;
    }

    if (paraSubject && !/^\s*[“”]/.test(para)) {
      carryParagraphSubjectToNextOpeningQuote = paraSubject;
    }
  }

  if (useGroupScenes) groupIntoScenes(paragraphs, result);

  // Export final state box for cross-chapter continuity seeding.
  if (options?.contextOut) {
    const finalTensionAvg = result.reduce((s, r) => {
      const t = r.meta.tension;
      return s + (t === 'high' ? 1 : t === 'rising' ? 0.5 : 0);
    }, 0) / Math.max(1, result.length);

    options.contextOut.value = {
      speakWeights: new Map(speakWeights),
      mentionWeights: new Map(mentionWeights),
      activeSubject,
      recentSpeakers: [...recentSpeakers],
      finalTensionAvg,
    };
  }

  return result;
}

/**
 * Single-paragraph API kept for compatibility.
 * For full chapter processing, use detectSpeechInChapter.
 */
export function detectSpeechInParagraph(
  text: string,
  knownNames: string[] = [],
  isOpenContinuation = false,
): { segments: SpeechSegment[]; endsOpen: boolean } {
  const sw = new Map<string, number>();
  const mw = new Map<string, number>();
  for (const n of knownNames) { sw.set(normKey(n), 0); mw.set(normKey(n), 0); }
  return processParagraph(text, 0, knownNames, isOpenContinuation, '', '', sw, mw, undefined, undefined, []);
}
