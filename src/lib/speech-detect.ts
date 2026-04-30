// @ts-nocheck — vendored copy; suppress unused-variable errors from the original source
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
 * 'low'     — ~85% accuracy of default. Skips gender pre-pass and scene
 *             grouping; narrower context windows (1 para extCtx, 3-speaker
 *             recency window). Best for low-end devices or long chapters.
 * 'default' — Balanced (existing behaviour). 2-para extCtx, 5-speaker
 *             recency window, full gender map, scene grouping.
 * 'high'    — Maximum accuracy. 3-para extCtx, 8-speaker recency window,
 *             lowered pronoun-resolution threshold, wider sibling context.
 */
export type IntelligenceLevel = 'low' | 'default' | 'high';

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
function findActionSubject(clause: string, knownNames: string[]): string | undefined {
  // Build quoted regions to exclude names inside dialogue content
  // e.g. "Thayne understands X," Iris said → Thayne is inside quotes, skip it
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
    // Exclude possessives — "Iris's" is ownership, not agency
    const m = new RegExp(`\\b${esc(name)}\\b(?!['’]s)`, 'i').exec(clause);
    if (m && !isInsideQuote(m.index) && (!firstMatch || m.index < firstMatch.pos)) {
      firstMatch = { name, pos: m.index };
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
): string | undefined {
  // Object-pronoun guard: if the candidate name appears to the RIGHT of the
  // quote and the surrounding text has a subject pronoun (he/she/they) before
  // the speech verb, the named entity is the LISTENER not the speaker.
  // e.g. "Two months ago," he said to Nora → speaker = he (resolved by pronoun),
  // NOT Nora. We block names that immediately follow "to|toward|at" within 20 chars.
  const objectMask = new RegExp(
    `\\b(?:to|toward|at|with|for)\\s+(?:${knownNames.map(esc).join('|')})\\b`,
    'i',
  );

  // Known names: subject pattern — Name ... verb
  for (const name of knownNames) {
    const e = esc(name);
    // Check that the name is NOT the object: if objectMask matches for THIS name
    // specifically, skip it.
    const objTest = new RegExp(`\\b(?:to|toward|at|with|for)\\s+${e}\\b`, 'i');
    if (objTest.test(text)) continue;
    // Fix B: expanded window 0–50 → 0–120 to handle long embedded clauses
    // Exclude quote marks in char class to prevent bridging across quote boundaries
    // e.g. "Thayne understands X," Iris said → must not match Thayne...said
    if (new RegExp(`\\b${e}\\b(?!['’]s)[^.!?\u201c\u201d\u201e\u2018\u2019"']{0,120}\\b${SPEECH_VERB_PAT}\\b`, 'i').test(text)) {
      return name;
    }
  }
  void objectMask;
  // Known names: inverted pattern — verb ... Name
  for (const name of knownNames) {
    const e = esc(name);
    const objTest = new RegExp(`\\b(?:to|toward|at|with|for)\\s+${e}\\b`, 'i');
    if (objTest.test(text)) continue;
    // Fix B: also expand inverted window 0–40 → 0–70 (more conservative on inverted)
    if (new RegExp(`\\b${SPEECH_VERB_PAT}\\b[^.!?\u201c\u201d\u201e\u2018\u2019"']{0,70}\\b${e}\\b(?!['’]s)`, 'i').test(text)) {
      return name;
    }
  }
  // Generic speakers — stricter: must immediately surround the verb.
  // The char class excludes sentence-ending punctuation AND quote chars so that
  // a name in one clause cannot bridge across a quote boundary to a verb in
  // another clause (e.g. "The system is old," he said → system≠speaker).
  for (const gen of GENERIC_SPEAKERS) {
    const e = esc(gen);
    const art = '(?:the|a|an)?\\s*';
    const noQuote = '[^.!?\u201c\u201d\\u201c\\u201d"\']{0,30}';
    const noQuoteInv = '[^.!?\u201c\u201d\\u201c\\u201d"\']{0,25}';
    if (new RegExp(`${art}\\b${e}\\b${noQuote}\\b${SPEECH_VERB_PAT}\\b`, 'i').test(text)) {
      return cap(gen);
    }
    if (new RegExp(`\\b${SPEECH_VERB_PAT}\\b${noQuoteInv}${art}\\b${e}\\b`, 'i').test(text)) {
      return cap(gen);
    }
  }
  return undefined;
}

// ── Paragraph subject detector ────────────────────────────────────────────

/**
 * Finds the first named character in the paragraph's opening clause.
 * Used to track the "active subject" for pronoun resolution across paragraphs.
 */
export function detectParagraphSubject(para: string, knownNames: string[]): string | undefined {
  const match = para.match(/^(?:[^.!?]+[.!?]\s*){0,1}[^.!?]+/);
  const windowStr = match ? match[0] : para.slice(0, 250);
  let firstMatch: { name: string; pos: number } | undefined;
  for (const name of knownNames) {
    // Exclude possessives — "Nora's" / "Nora’s" in the opening context is not the subject
    const found = new RegExp(`\\b${esc(name)}\\b(?!['’]s)`, 'i').exec(windowStr);
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
function findImmediateNameAfter(after: string, knownNames: string[]): string | undefined {
  const win = after.slice(0, 55);
  const guardWindow = after.slice(0, 100);
  for (const name of knownNames) {
    if (new RegExp(`^\\s*\\b${esc(name)}\\b(?!['’]s)`, 'i').test(win)) {
      // Known proper name → trust immediately
      return name;
    }
  }
  // Generic speakers — only if speech verb follows (prevents section-header false positives)
  for (const gen of GENERIC_SPEAKERS) {
    const e = esc(gen);
    if (new RegExp(`^\\s*\\b${e}\\b`, 'i').test(win)) {
      // Require a speech verb nearby, otherwise this is a label not an attribution
      if (SPEECH_VERB_RE.test(guardWindow)) return cap(gen);
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
function findVoiceAttribution(text: string, knownNames: string[]): string | undefined {
  for (const name of knownNames) {
    if (new RegExp(`\\b${esc(name)}['’]s?\\s+(?:voice|tone|words?|breath|question|answer|reply|response|laugh|sigh|cry|shout)\\b`, 'i').test(text)) {
      return name;
    }
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
      const nameRe = new RegExp(`\\b${esc(name)}\\b(?!'s)`, 'gi');
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
      const nearbyNames = knownNames.filter(n => new RegExp(`\\b${esc(n)}\\b`, 'i').test(attrWin));
      
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
): { name: string; ratio: number } | undefined {
  let bestName: string | undefined;
  let bestCount = 0;
  let totalMentions = 0;
  for (const name of knownNames) {
    const re = new RegExp(`\\b${esc(name)}\\b(?!'s)`, 'gi');
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
function buildExtCtxDensity(extCtx: string, knownNames: string[]): Map<string, number> {
  const density = new Map<string, number>();
  for (const name of knownNames) {
    const hits = (extCtx.match(new RegExp(`\\b${esc(name)}\\b`, 'gi')) ?? []).length;
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
): Attribution {
  const localBefore = before.slice(-LOCAL_VERB_WINDOW);
  const localAfter  = after.slice(0, LOCAL_VERB_WINDOW);
  const hasSpeechVerb = SPEECH_VERB_RE.test(localBefore + ' ' + localAfter);

  // ── No speech verb in local window ─────────────────────────────────────
  if (!hasSpeechVerb) {
    // A) Post-quote immediate name: "Yes." Iris looked → Iris spoke
    const immediateNameAfter = findImmediateNameAfter(after, knownNames);
    if (immediateNameAfter) return { speaker: immediateNameAfter, type: 'speech', confidence: 0.92 };

    // A+) Voice attribution: "Iris's voice came from above" → Iris
    const voiceNameNoVerb = findVoiceAttribution(after.slice(0, 120), knownNames);
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
    const actionSpeaker = findActionSubject(leadingText, knownNames);
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
      const beatActor = findActionSubject(leadingText, knownNames);
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
        //     Confidence 0.65 ensures it survives the HIGH-mode demotion pass
        //     (which strips speakers with conf < 0.65 and low ctx score) and
        //     gets pushed to recentSpeakers for subsequent alternation.
        if (thread.participants.length >= 1 && knownNames.length === 2) {
          const otherName = knownNames.find(n => normKey(n) !== lastK);
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
        const epSubject = findActionSubject(leadingClause(ep), knownNames);
        if (epSubject) {
          return { speaker: epSubject, type: 'speech', confidence: 0.60 };
        }
      }
    }

    // D) Bare-opening-quote alternation: quote opens the paragraph (before is
    //    empty), no action beat establishes the speaker. Alternate to the most
    //    recently active OTHER participant in this conversation.
    //    e.g. Iris just spoke → next untagged standalone quote → Nora → Iris → …
    //    Uses activeSubject (updated on every attribution) to determine the
    //    "last speaker", not just recentSpeakers (which requires ≥0.65 confidence).
    if (before.trim().length === 0 && recentSpeakers && recentSpeakers.length >= 1) {
      const mostRecent = activeSubject ?? recentSpeakers[recentSpeakers.length - 1];
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
  const trailName = findDirectName(trailing, knownNames)
    ?? findVoiceAttribution(trailing, knownNames);
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
  const leadName = findDirectName(leading, knownNames)
    ?? findVoiceAttribution(leading, knownNames);
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
  if (activeSubject && thread && (activeSubjectIsLocal || before.trim().length > 0)) {
    const leadSubj = findActionSubject(leading, knownNames);
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
    const localSubj = findActionSubject(leadingClause(before), knownNames);
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
    const scores: Array<{ name: string; score: number }> = [];
    for (const name of genderFilteredNames) {
      const k = normKey(name);
      const sw = speakWeights.get(k)   ?? 0;
      const mw = mentionWeights.get(k) ?? 0;
      let score = sw * 75 + mw * 55;
      if (activeSubject && normKey(name) === normKey(activeSubject)) score += 45;
      if (prevParaFocus && normKey(name) === normKey(prevParaFocus.name)) {
        score += prevParaFocus.ratio * NARRATIVE_FOCUS_MAX;
      }
      // Thread participant bonus: characters who are active in the extCtx dialogue
      // get additional weight proportional to how many turns they've taken.
      if (thread?.turnCounts.has(k)) {
        score += (thread.turnCounts.get(k)! * 60);
      }
      // Local extCtx density bonus: raw undecayed occurrence count in the 5-para window.
      if (extCtxDensity) {
        score += (extCtxDensity.get(k) ?? 0) * 14;
      }
      if (score > 0) scores.push({ name, score });
    }
    scores.sort((a, b) => b.score - a.score);
    const best = scores[0];
    const second = scores[1];
    // Cast-size penalty: more candidates dilute the posterior even when one
    // character clearly dominates. Scale the threshold up slightly per extra cast
    // member beyond 4, and require a minimum dominance ratio over the runner-up.
    const dominanceRatio = second ? best?.score / second.score : Infinity;
    const castPenalty = Math.max(0, (genderFilteredNames.length - 4) * 0.03);
    const adjustedThreshold = (pronounMinScore ?? PRONOUN_MIN_SCORE) + castPenalty;

    if (best && best.score >= adjustedThreshold) {
      const totalScore = scores.reduce((s, x) => s + x.score, 0);
      const topProb = totalScore > 0 ? best.score / totalScore : 0;

      if (topProb >= 0.40 && dominanceRatio >= 1.8) {
        return { speaker: best.name, type: 'speech', confidence: topProb * 0.85 };
      } else if (topProb >= PRONOUN_MIN_POSTERIOR && second && dominanceRatio >= 1.4) {
        return { speaker: best.name, type: 'speech', confidence: topProb * 0.50 };
      }
    }
    return { speaker: undefined, type: 'speech', confidence: 0 };
  }

  // ── Step 4: extended context (previous paragraphs) ──
  if (extCtx) {
    const extName = findDirectName(extCtx, knownNames);
    if (extName) {
      // Validate with recency: only use if this character was recently active
      const k = normKey(extName);
      const recency = Math.max(speakWeights.get(k) ?? 0, mentionWeights.get(k) ?? 0);
      if (recency >= 0.3) return { speaker: extName, type: 'speech', confidence: 0.58 };
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
        speakWeights, mentionWeights, activeSubject, prevParaFocus, undefined, recentSpeakers, genderMap, pronounMinScore, thread, extCtxDensity, activeSubjectIsLocal);
      const confMod = Math.max(0.6, 1.0 - ((continuationDepth ?? 0) * 0.12));
      segments.push({ start: 0, end: text.length, speaker: attr.speaker, continuation: true, type: 'speech', confidence: attr.confidence * confMod });
      if (attr.speaker) speakWeights.set(normKey(attr.speaker), 1.0);
      return { segments, endsOpen: true };
    }
    const contBefore = text.slice(0, closeIdx + 1);
    const contAfter  = text.slice(closeIdx + 1);
    const attr = findAttribution(contBefore, contAfter, extCtx, knownNames,
      speakWeights, mentionWeights, activeSubject, prevParaFocus, undefined, recentSpeakers, genderMap, pronounMinScore, thread, extCtxDensity, activeSubjectIsLocal);
    const confMod = Math.max(0.6, 1.0 - ((continuationDepth ?? 0) * 0.12));
    segments.push({ start: 0, end: closeIdx + 1, speaker: attr.speaker, continuation: true, type: 'speech', confidence: attr.confidence * confMod });
    if (attr.speaker) speakWeights.set(normKey(attr.speaker), 1.0);

    const rest = processParagraph(
      text.slice(closeIdx + 1), knownNames, false, extCtx, nextParaStart,
      speakWeights, mentionWeights, activeSubject, prevParaFocus, recentSpeakers, genderMap, maxRecentSpeakers, pronounMinScore, thread, extCtxDensity,
      undefined,
      activeSubjectIsLocal,
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
      speakWeights, mentionWeights, activeSubject, prevParaFocus, quoteContent, recentSpeakers, genderMap, pronounMinScore, thread, extCtxDensity, activeSubjectIsLocal);

    // Adjacent quote inheritance: if attribution failed but the immediately
    // preceding attributed quote had high confidence and no new named actor
    // appeared in the beat text between them, inherit the same speaker with decay.
    if (!attr.speaker && lastAttributedSpeaker && lastAttributedConfidence >= 0.65) {
      const beatText = text.slice(prevPairEnd, pair.start);
      const beatActor = findActionSubject(beatText, knownNames);
      const newActor = beatActor && normKey(beatActor) !== normKey(lastAttributedSpeaker);
      if (!newActor) {
        attr = { speaker: lastAttributedSpeaker, type: 'speech', confidence: lastAttributedConfidence * 0.82 };
      }
    }

    segments.push({ start: pair.start, end: pair.end + 1, speaker: attr.speaker, type: attr.type, confidence: attr.confidence });
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
  // Extended with combat/action vocabulary for isekai and genre fiction.
  const confrontationVerbs = [
    // Literary / psychological
    'demanded', 'challenged', 'confronted', 'pressed', 'insisted',
    'refused', 'snapped', 'accused', 'pleaded', 'confessed', 'denied',
    'seized', 'yanked', 'shoved', 'slammed', 'grabbed',
    'screamed', 'shouted', 'yelled', 'barked', 'hissed', 'snarled',
    'cornered', 'blocked', 'restrained', 'threatened', 'warned',
    'begged', 'lunged', 'struck',
    // Combat / action (isekai, genre fiction)
    'slashed', 'parried', 'deflected', 'dodged', 'charged', 'impaled',
    'cut down', 'cut through', 'pierced', 'overwhelmed', 'overpowered',
    'drove back', 'knocked back', 'sent flying', 'disarmed',
    'defeated', 'destroyed',
  ];
  let confrontationCount = 0;
  for (const v of confrontationVerbs) if (has(v)) confrontationCount++;
  score += Math.min(confrontationCount * 2, 10);

  // ── Signal 2: Physical tension signals (+2 each, cap 8) ──────────────
  const physTerms = [
    'trembling', 'trembled', 'tremor', 'shaking', 'shook',
    'gripped', 'clutched', 'clenched', 'tightened', 'tensed',
    'burning', 'strained', 'flinched', 'winced', 'braced',
    'stumbled', 'staggered', 'doubled over',
    'breath caught', 'held her breath', 'held his breath', 'their breath',
    'heart pounded', 'heart raced', 'pulse quickened',
    'white knuckles', 'jaw tightened', 'shoulders tensed',
  ];
  let physicalCount = 0;
  for (const w of physTerms) if (has(w)) physicalCount++;
  score += Math.min(physicalCount * 2, 8);

  // ── Signal 3: Fear / emotional-exposure vocabulary (+1.5 each, cap 6) ─
  const fearTerms = [
    'afraid', 'frightened', 'terrified', 'dread',
    'desperate', 'panic', 'alarmed', 'horrified',
    'vulnerable', 'exposed', 'helpless', 'powerless',
    'grief', 'despair', 'anguish', 'shattered', 'devastated',
    'ached', 'aching', 'unbearable',
    // Genre-fiction emotional extremes
    'rage', 'fury', 'wrath', 'hatred', 'overwhelming',
    'desperation', 'bloodlust', 'killing intent',
  ];
  let fearCount = 0;
  for (const w of fearTerms) if (has(w)) fearCount++;
  score += Math.min(fearCount * 1.5, 6);

  // ── Signal 4: Silence / constraint vocabulary (+1 each, cap 5) ────────
  const silenceTerms = [
    'silence', 'silent', 'motionless', 'without a word',
    'said nothing', 'no words', "couldn't speak",
    'not allowed', 'forbidden', 'refused to answer', 'refused to look',
    'looked away', 'turned away',
  ];
  let silenceCount = 0;
  for (const w of silenceTerms) if (has(w)) silenceCount++;
  score += Math.min(silenceCount * 1, 5);

  // ── Signal 5: Restraint / suppression phrases (+1.5 each, cap 4.5) ───
  const suppressionTerms = [
    'bit back', 'swallowed hard', 'fought the urge',
    'kept her voice', 'kept his voice', 'steady voice',
    'held herself', 'held himself', 'held back',
    'forced herself', 'forced himself', 'made herself', 'made himself',
    'did not react', 'did not move', 'did not speak', 'did not answer',
    'carefully controlled', 'struggled to keep',
  ];
  let suppressionCount = 0;
  for (const w of suppressionTerms) if (has(w)) suppressionCount++;
  score += Math.min(suppressionCount * 1.5, 4.5);

  // ── Signal 6: Disaster / physical-damage vocabulary (+2.5 each, cap 7.5)
  const disasterTerms = [
    'explosion', 'exploded', 'detonated', 'blast', 'detonation',
    'debris', 'rubble', 'smoke', 'flames', 'fire spread',
    'shockwave', 'concussion',
    'bleeding', 'wounded', 'injuries',
    'shattered glass', 'chaos', 'screaming',
  ];
  let disasterCount = 0;
  for (const w of disasterTerms) if (has(w)) disasterCount++;
  score += Math.min(disasterCount * 2.5, 7.5);

  // ── Signal 7: Revelation / truth vocabulary (+1.5 each, cap 4.5) ──────
  const revelationTerms = [
    'admitted', 'confessed', 'broke the silence',
    'who are you', 'what are you', 'what you are', 'who you are',
    'the truth', 'truth is', 'had to know', 'needed to know',
    'all along', 'finally said', 'finally admitted', 'always knew',
  ];
  let revelationCount = 0;
  for (const w of revelationTerms) if (has(w)) revelationCount++;
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
    || disasterCount >= 1 || fearCount >= 1;
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
  // System-pressure / weight vocabulary (Fix D: expanded for sci-fi institutional prose).
  const abstractTerms = [
    // Original core set
    'threshold', 'limit', 'margin', 'capacity', 'failure',
    'collapse', 'degradation', 'fragment', 'separation', 'fracture',
    'the cost', 'weight of', 'burden', 'erosion',
    'void', 'absence', 'the boundary', 'the gap', 'the distance',
    'consumed', 'projection',
    // Expanded: institutional/systemic pressure (Hollow Iris register)
    'parameters', 'tolerance', 'protocol', 'directive', 'procedure',
    'classification', 'designation', 'assigned', 'clearance', 'restricted',
    'compliant', 'non-compliant', 'deviation', 'variance', 'anomaly',
    'the system', 'the facility', 'the program', 'the record', 'the file',
    'scheduled', 'pending', 'delayed', 'suspended', 'terminated',
    'monitoring', 'assessment', 'evaluation', 'performance', 'output',
    // Abstract pressure vocabulary (literary sci-fi)
    'the weight', 'the silence', 'the space between', 'the interval',
    'accumulation', 'residue', 'implication', 'undercurrent', 'signal',
    'the pattern', 'the structure', 'the arrangement', 'the logic of',
  ];
  let abstractCount = 0;
  for (const w of abstractTerms) if (has(w)) abstractCount++;
  score += Math.min(abstractCount * 1.2, 5);

  // ── Signal 16: Low-entropy controlled prose (+2.5) ────────────────────
  // Very long sentences + sparse punctuation = the novel's characteristic
  // "controlled tension" philosophical style. No longer gated by abstractCount
  // so it fires on any long-form literary prose, not just Hollow Iris.
  if (avgSentenceLength > 120 && punctuationDensity < 0.06) {
    score += 2.5;
  }

  // ── Signal 18: Fantasy / power-system vocabulary (+1.5 each, cap 6) ──
  // Detects isekai / genre-fiction pressure points: skill activations,
  // mana bursts, power scaling, and aura-based confrontations.
  const fantasyTerms = [
    'mana', 'magic power', 'cast a spell', 'spellcraft',
    'skill activated', 'skill:', 'ability activated', 'level up',
    'status screen', 'system message', 'notification',
    'killing aura', 'murderous aura', 'pressure emanated',
    'power level', 'overwhelmed by power', 'surpassed', 'overpowered by',
    'flames erupted', 'lightning crackled', 'ice spread',
    'the ground shook', 'the air crackled', 'mana exploded',
  ];
  let fantasyCount = 0;
  for (const w of fantasyTerms) if (has(w)) fantasyCount++;
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
    const quietPivotTerms = [
      'for the first time', 'the last time', 'never before', 'never again',
      'something changed', 'the moment', 'in that moment', 'only then',
      'it was then', 'she understood', 'he understood', 'it became clear',
      'the realization', 'the truth was', 'finally knew', 'already knew',
      'she found', 'he found', 'discovered',
    ];
    if (quietPivotTerms.some(w => lower.includes(w))) {
      label = 'quiet pivot';
    }
  }

  // ── Paragraph quality hint (aggregated by groupIntoScenes) ────────────
  // Computed regardless of tension level so the scene grouper has signals
  // for labelling calm scenes (celebration, connection, reflection, etc.).
  const celebHints = [
    'festival', 'celebration', 'music', 'laughter', 'dancing',
    'golden light', 'warm light', 'gathered', 'joy', 'singing',
    // Isekai slice-of-life
    'at the inn', 'the tavern', 'the guild', 'the village', 'at the feast',
    'sat down to eat', 'cooked', 'prepared a meal', 'shared a meal',
  ];
  const intimateHints = [
    'warmth', 'smiled', 'laughed', 'between them', 'beside her',
    'beside him', 'her hand', 'his hand', 'their hands',
    'familiar', 'close to', 'at ease', 'comfortable', 'gentle',
    'the warmth of',
    // Isekai social / party dynamics
    'across from her', 'across from him', 'sat together',
    'looked at each other', 'met his eyes', 'met her eyes',
    'the party', 'his companion', 'her companion',
  ];
  const reflectiveHints = [
    'remembered', 'thinking', 'thought about', 'wondered',
    'watching', 'listening', 'waiting', 'observed', 'noticed',
    'memory', 'for years', 'for so long', 'had always',
    'meaning', 'understood', 'realized', 'as though', 'felt like',
    // Isekai internal monologue patterns
    'i thought', 'my mind', 'i realized', 'it occurred to me', 'in my head',
    'i had been', 'i wondered', 'i considered',
  ];
  const weightedHints = [
    'carried for', 'borne for', 'held for', 'for decades',
    'for centuries', 'for longer than', 'across the years',
    'the weight of', 'the cost of', 'no one alive',
  ];
  const significantHints = [
    'for the first time', 'the last time', 'never before', 'never again',
    'would remember', 'would not forget', 'something changed',
    'the moment', 'in that moment',
  ];

  let celebCount = 0, intimateCount = 0, reflectCount = 0;
  let weightedHintCount = 0, significantCount = 0;
  for (const w of celebHints)       if (has(w)) celebCount++;
  for (const w of intimateHints)    if (has(w)) intimateCount++;
  for (const w of reflectiveHints)  if (has(w)) reflectCount++;
  for (const w of weightedHints)    if (has(w)) weightedHintCount++;
  for (const w of significantHints) if (has(w)) significantCount++;

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
  const extCtxDepth       = level === 'low' ? 1 : level === 'high' ? 6 : 3;
  // maxRecentSpeakers: sliding window size for bilateral turn-taking detection
  //   low=3  default=7  high=10
  const maxRecentSpeakers = level === 'low' ? 3 : level === 'high' ? 10 : 7;
  // pronounMinScore: Bayesian posterior threshold for pronoun resolution
  //   high lowers it to 12 (more aggressive) vs default 18
  const pronounMinScore   = level === 'high' ? 12 : level === 'default' ? 16 : PRONOUN_MIN_SCORE;
  // useGenderMap: gender pre-pass is O(N·M); skip on low for speed
  const useGenderMap      = level !== 'low';
  // useGroupScenes: scene-grouping post-pass; skip on low for speed
  const useGroupScenes    = level !== 'low';
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
  // Skipped on 'low' intelligence level to reduce overhead.
  const genderMap = useGenderMap ? buildGenderMap(paragraphs, knownNames) : undefined;

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];

    // N-paragraph context window sized by intelligenceLevel
    // low=1  default=3  high=6 previous paragraphs
    const extCtx = Array.from({ length: extCtxDepth }, (_, d) => {
      const idx = i - extCtxDepth + d;
      return idx >= 0 ? paragraphs[idx] : '';
    }).filter(Boolean).join(' ');

    // Next paragraph start (helps with inverted attribution at para boundaries)
    const nextParaStart = i + 1 < paragraphs.length
      ? paragraphs[i + 1].slice(0, 150)
      : '';

    // ── Mention boosts (before processing quotes) ──

    // Subject of this paragraph boosts its mention weight
    const paraSubject = detectParagraphSubject(para, knownNames);
    const carriedParagraphSubject = !paraSubject
      && carryParagraphSubjectToNextOpeningQuote
      && /^\s*["“]/.test(para)
        ? carryParagraphSubjectToNextOpeningQuote
        : undefined;
    const localActiveSubject = paraSubject ?? carriedParagraphSubject;
    const activeSubjectIsLocal = !!localActiveSubject;
    carryParagraphSubjectToNextOpeningQuote = undefined;
    if (paraSubject) {
      const k = normKey(paraSubject);
      mentionWeights.set(k, Math.min(1.0, (mentionWeights.get(k) ?? 0) + 0.35));

      if (subjectWeights) {
        // High mode: update subject weights and derive activeSubject from max weight
        subjectWeights.set(k, 1.0);
        // Decay all others
        for (const [sk, sv] of subjectWeights) {
          if (sk !== k) subjectWeights.set(sk, sv * 0.75);
        }
        // activeSubject = highest-weighted subject (not just most recent)
        let bestScore = 0;
        for (const [sk, sv] of subjectWeights) {
          if (sv > bestScore) {
            bestScore = sv;
            activeSubject = knownNames.find(n => normKey(n) === sk);
          }
        }
      } else {
        activeSubject = paraSubject;
        if (!activeSubject) activeSubject = paraSubject;
      }
    } else {
      if (subjectWeights) {
        // No new subject: decay all subject weights so old state fades
        for (const [sk, sv] of subjectWeights) subjectWeights.set(sk, sv * 0.75);
      }
      // Possessive-leading subject: "Mareth's lecture was about…"
      const possClauseEnd = para.search(/[.!?;—]/);
      const possClause = possClauseEnd > 0 ? para.slice(0, possClauseEnd) : para.slice(0, 150);
      for (const name of knownNames) {
        if (new RegExp(`^\s*${esc(name)}['’]s?\b`, 'i').test(possClause)) {
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
      const e = esc(name);
      const k = normKey(name);
      if (new RegExp(`\b${e}\b(?!['’]s)`, 'i').test(para)) {
        const isFirstMention = !everMentioned.has(k);
        if (isFirstMention) everMentioned.add(k);
        mentionWeights.set(k, Math.min(1.0, (mentionWeights.get(k) ?? 0) + (isFirstMention ? 0.45 : 0.20)));
      } else if (new RegExp(`\b${e}['’]s\b`, 'i').test(para)) {
        mentionWeights.set(k, Math.min(1.0, (mentionWeights.get(k) ?? 0) + 0.05));
      }
    }

    // ── High mode: build dialogue thread + extCtx density for this paragraph ──
    const thread      = level === 'high' && extCtx ? extractDialogueThread(extCtx, knownNames, genderMap) : undefined;
    const extCtxDens  = level === 'high' && extCtx ? buildExtCtxDensity(extCtx, knownNames) : undefined;

    // Track continuation depth for confidence decay on long multi-para quotes.
    if (openContinuation) continuationDepth++;
    else continuationDepth = 0;

    // ── Process quotes ──
    const { segments, endsOpen } = processParagraph(
      para, knownNames, openContinuation,
      extCtx, nextParaStart,
      speakWeights, mentionWeights, localActiveSubject ?? activeSubject, prevParaFocus, recentSpeakers,
      genderMap, maxRecentSpeakers, pronounMinScore, thread, extCtxDens, continuationDepth, activeSubjectIsLocal,
    );

    // ── High mode: confidence upgrade / demotion pass ──────────────────
    // After processParagraph, review low-confidence segments using extCtx.
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

    const meta = computeParagraphMeta(para, segments, prevMeta);
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

    // A1: prevParaFocus with dominance ratio for proportional focus bonus.
    // If no named characters found, keep previous value (transitional prose).
    const thisFocus = findParagraphFocusWithRatio(para, knownNames);
    if (thisFocus) prevParaFocus = thisFocus;

    if (paraSubject && !/^\s*["“]/.test(para)) {
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
  return processParagraph(text, knownNames, isOpenContinuation, '', '', sw, mw, undefined, undefined, []);
}
