/**
 * prose-segments.ts
 *
 * Shared, deep prose-segmentation primitives consumed ONLY by the two
 * one-shot formatting passes (`auto-paragraph.ts`, `auto-scene-break.ts`).
 *
 * These are deliberately heavyweight and high-precision: they replace the
 * fragile per-file regex scanners those passes used to carry (a naive
 * sentence splitter that broke on "Dr."/"U.S.", and a quote counter that
 * toggled state on every apostrophe). Nothing else in the app imports this
 * module — speech-detect, paragraph-risk and the analysis pipeline are
 * untouched.
 *
 * Three primitives:
 *   1. splitSentences  — abbreviation/initial/decimal-aware sentence tokenizer
 *   2. analyzeQuotes   — apostrophe-safe dialogue/quote analysis
 *   3. classifyOpener  — discourse-marker taxonomy (time/place/abrupt/intra-scene)
 */

// ─────────────────────────────────────────────────────────────────────────
// 1. Sentence tokenizer
// ─────────────────────────────────────────────────────────────────────────

/** Non-breaking abbreviations (lower-cased, dots stripped). A '.' directly
 *  after one of these is NOT a sentence boundary even when a capital follows
 *  (e.g. "Dr. Finch"). Kept curated rather than exhaustive — precision first. */
const ABBREVIATIONS = new Set([
  // courtesy / professional / rank titles
  "mr", "mrs", "ms", "mx", "dr", "prof", "sr", "jr", "st", "sgt", "capt",
  "cpt", "lt", "col", "gen", "cmdr", "maj", "adm", "gov", "pres", "rev",
  "fr", "br", "hon", "messrs", "mme", "mlle", "mons", "mt", "ft", "rep",
  "sen", "supt", "det", "ofc", "pvt", "cpl", "pfc", "esq", "dept",
  // editorial / latin
  "etc", "al", "vs", "viz", "cf", "ibid", "op", "ca", "approx", "esp",
  "est", "no", "nos", "vol", "pp", "pg", "fig", "ch", "sec", "art", "para",
  // time / era units (dots already stripped: a.m → am)
  "am", "pm", "ad", "bc", "bce", "ce",
]);

const TERMINALS = ".!?…"; // . ! ? …
const CLOSERS = "\"'’”»)]"; // " ' ’ ” » ) ]

export interface Sentence {
  /** Trimmed sentence text. */
  text: string;
  /** Offset of the first non-space char in the source string. */
  start: number;
  /** Offset just past the sentence's terminal punctuation (exclusive). */
  end: number;
}

function precedingAlphaWord(text: string, dotIdx: number): string {
  let s = dotIdx - 1;
  while (s >= 0 && /[A-Za-z]/.test(text[s])) s--;
  return text.slice(s + 1, dotIdx);
}

function firstNonSpace(text: string, from: number, to: number): number {
  let i = from;
  while (i < to && /\s/.test(text[i])) i++;
  return i;
}

/**
 * Decide whether the terminal-punctuation run [dotIdx, afterDots) ends a
 * sentence, given the next non-space char and whether we hit end-of-line.
 *
 * High-precision posture: when ambiguous, prefer NOT to split (merge), since
 * a missed split is far less harmful downstream than a wrong one.
 */
function isBoundary(
  text: string,
  dotIdx: number,
  afterDots: number,
  nextCh: string,
  atEOL: boolean,
): boolean {
  if (atEOL) return true;

  const run = text.slice(dotIdx, afterDots);
  const singleDot = run === ".";

  // Decimal: digit '.' digit (3.14) — never a boundary.
  if (singleDot && /\d/.test(text[dotIdx - 1] ?? "") && /\d/.test(nextCh)) {
    return false;
  }

  // A sentence almost never starts with a lowercase letter. Lowercase next
  // ⇒ continuation: dialogue attribution ("...!\" she said"), an abbreviation
  // we didn't list, or a trailing-off ellipsis ("paused... then").
  if (/[a-z]/.test(nextCh)) return false;

  // For '.' followed by a capital/digit/quote we still have to reject
  // abbreviations and initials.
  if (singleDot) {
    const word = precedingAlphaWord(text, dotIdx);
    // Single-letter initial: "J. R. R. Tolkien".
    if (word.length === 1 && /[A-Z]/.test(word)) return false;
    // Inside a multi-dot acronym: "U.S.", "e.g.", "i.e." — the char two back
    // is itself a dot.
    if (word.length === 1 && text[dotIdx - 2] === ".") return false;
    if (ABBREVIATIONS.has(word.toLowerCase())) return false;
  }

  return true;
}

/**
 * Tokenize prose into sentences. Abbreviation-, initial-, decimal- and
 * quote-aware. Newlines that follow a terminal end a sentence; newlines
 * mid-sentence (hard wrapping) do not.
 */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  const n = text.length;
  if (n === 0) return out;

  let start = firstNonSpace(text, 0, n);
  let i = start;

  while (i < n) {
    if (!TERMINALS.includes(text[i])) {
      i++;
      continue;
    }
    // Consume the run of terminal punctuation ("?!", "...", "!!").
    let j = i;
    while (j < n && TERMINALS.includes(text[j])) j++;
    // Optional trailing closers (quotes/brackets).
    let k = j;
    while (k < n && CLOSERS.includes(text[k])) k++;
    // Look ahead past spaces/tabs only — a newline counts as end-of-line.
    let p = k;
    while (p < n && (text[p] === " " || text[p] === "\t")) p++;
    const atEOL = p >= n || text[p] === "\n";
    const nextCh = atEOL ? "" : text[p];

    if (isBoundary(text, i, j, nextCh, atEOL)) {
      const seg = text.slice(start, k).trim();
      if (seg) out.push({ text: seg, start: firstNonSpace(text, start, k), end: k });
      start = firstNonSpace(text, k, n);
      i = start;
      continue;
    }
    i = j; // skip past this non-terminal run and keep scanning
  }

  if (start < n) {
    const seg = text.slice(start, n).trim();
    if (seg) out.push({ text: seg, start: firstNonSpace(text, start, n), end: n });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Quote / dialogue analyzer (apostrophe-safe)
// ─────────────────────────────────────────────────────────────────────────

const OPEN_MARKS = new Set(["“", "«", "‘"]); // “ « ‘
const CLOSE_MARKS = new Set(["”", "»"]); // ” »

export interface QuoteAnalysis {
  /** Text contains at least one real dialogue span (delimiters, not apostrophes). */
  hasQuote: boolean;
  /** Fraction of non-space chars sitting inside quotes (apostrophe-safe). */
  inQuoteRatio: number;
  /** inQuoteRatio ≥ 0.55 — a dialogue-dominant line. */
  isMostlyQuote: boolean;
  /** First non-space char is an opening delimiter. */
  startsWithOpenQuote: boolean;
  /** Ends with a closing delimiter (+ optional trailing sentence punctuation). */
  endsWithCloseQuote: boolean;
  /** Open/close delimiters balanced and not left mid-quote. */
  balanced: boolean;
}

/**
 * Is the single-quote mark at index `i` an apostrophe (contraction / possessive)
 * rather than a dialogue delimiter? This is the crux of the fix: the old scanner
 * toggled quote state on every `'`, so "That's", "don't", "it's" corrupted the
 * in-quote ratio and broke dialogue paragraphing.
 */
function isApostrophe(text: string, i: number, inside: boolean): boolean {
  const c = text[i];
  if (c !== "'" && c !== "’") return false; // ' or ’
  const prev = text[i - 1] ?? "";
  const next = text[i + 1] ?? "";
  const letterPrev = /[A-Za-z0-9]/.test(prev);
  const letterNext = /[A-Za-z]/.test(next);
  if (letterPrev && letterNext) return true; // don't, it's, o'clock, rock'n'roll
  if (c === "’" && letterPrev) return true; // curly: it’s / dogs’ / James’
  if (c === "'" && letterPrev && !inside) return true; // straight possessive outside a quote
  return false;
}

export function analyzeQuotes(text: string): QuoteAnalysis {
  const n = text.length;
  let inside = false;
  let inQuoteChars = 0;
  let totalNonSpace = 0;
  let opens = 0;
  let closes = 0;
  let everInside = false;

  for (let i = 0; i < n; i++) {
    const c = text[i];
    const isSpace = /\s/.test(c);
    if (!isSpace) totalNonSpace++;

    if (OPEN_MARKS.has(c)) {
      if (!inside) {
        inside = true;
        opens++;
        everInside = true;
      }
      continue;
    }
    if (CLOSE_MARKS.has(c)) {
      if (inside) {
        inside = false;
        closes++;
      }
      continue;
    }
    if (c === '"') {
      if (!inside) {
        inside = true;
        opens++;
        everInside = true;
      } else {
        inside = false;
        closes++;
      }
      continue;
    }
    if (c === "'" || c === "’") {
      if (isApostrophe(text, i, inside)) {
        if (inside) inQuoteChars++;
        continue;
      }
      if (!inside) {
        inside = true;
        opens++;
        everInside = true;
      } else {
        inside = false;
        closes++;
      }
      continue;
    }

    if (inside && !isSpace) inQuoteChars++;
  }

  const ratio = totalNonSpace > 0 ? inQuoteChars / totalNonSpace : 0;
  const trimmed = text.trim();
  const firstCh = trimmed[0] ?? "";
  const startsWithOpenQuote =
    OPEN_MARKS.has(firstCh) || firstCh === '"' || firstCh === "'";
  const endsWithCloseQuote = /["'’”»][.,!?;:]*\s*$/.test(text);

  return {
    hasQuote: everInside,
    inQuoteRatio: ratio,
    isMostlyQuote: ratio >= 0.55,
    startsWithOpenQuote,
    endsWithCloseQuote,
    balanced: opens === closes && !inside,
  };
}

/**
 * Return the text with all quoted spans replaced by a single space, leaving
 * only the narration/attribution (apostrophe-safe). Used to find a sentence's
 * acting subject without being fooled by pronouns *inside* the dialogue
 * (e.g. the "I" in `"I'll go," she said` must not outrank the real speaker).
 */
export function stripQuotes(text: string): string {
  const n = text.length;
  let inside = false;
  let out = "";
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (OPEN_MARKS.has(c)) {
      if (!inside) {
        inside = true;
        out += " ";
      }
      continue;
    }
    if (CLOSE_MARKS.has(c)) {
      if (inside) inside = false;
      continue;
    }
    if (c === '"') {
      inside = !inside;
      out += " ";
      continue;
    }
    if (c === "'" || c === "’") {
      if (isApostrophe(text, i, inside)) {
        if (!inside) out += c;
        continue;
      }
      inside = !inside;
      out += " ";
      continue;
    }
    if (!inside) out += c;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Scene-break markers
// ─────────────────────────────────────────────────────────────────────────

/** A line that is purely a scene-break marker: `* * *`, `---`, `~ ~ ~`, etc. */
export const SCENE_BREAK_RE = /^[\s*\-—#~=|·•]{3,}$/;

/** True when the (whole) line is nothing but a scene-break marker. */
export function isSceneBreakLine(line: string): boolean {
  return SCENE_BREAK_RE.test(line.trim());
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Discourse-marker taxonomy
// ─────────────────────────────────────────────────────────────────────────

/**
 * Classification of how a paragraph/sentence opens. The *magnitude* matters:
 *   - "time-major"  : a real time jump (the next morning, three days later) —
 *                     scene-capable, but only with corroboration.
 *   - "time-minor"  : continuous time (then, a moment later, soon) — NEVER a
 *                     scene boundary; at most a paragraph beat.
 *   - "place-shift" : a relocation (meanwhile, across the city, back at the
 *                     house) — scene-capable with corroboration.
 *   - "abrupt"      : a pacing pivot (suddenly, without warning) — paragraph
 *                     beat only, never a scene boundary.
 *   - null          : no discourse marker.
 *
 * The old code lumped all of these into one regex and treated any hit as a
 * scene boundary, which shattered scenes on intra-scene "Then"/"Later".
 */
export type OpenerClass = "time-major" | "time-minor" | "place-shift" | "abrupt" | null;

const RE_TIME_MAJOR =
  /^(?:the\s+(?:next|following)\s+(?:morning|day|week|month|year|evening|night|afternoon|dawn|spring|summer|autumn|fall|winter)|(?:\d+|a\s+few|several|many|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hours?|days?|weeks?|months?|years?)\s+later|(?:hours?|days?|weeks?|months?|years?)\s+later|(?:years?|months?|weeks?|days?)\s+(?:passed|went\s+by)|that\s+(?:same\s+)?(?:morning|afternoon|evening|night)|later\s+that\s+(?:day|morning|afternoon|evening|night|week)|by\s+(?:nightfall|morning|noon|dawn|dusk|midnight|the\s+time\b)|the\s+morning\s+(?:after|came)|when\s+(?:morning|dawn|night|day)\s+(?:came|broke|fell))\b/i;

const RE_TIME_MINOR =
  /^(?:then|and\s+then|after\s+a\s+(?:moment|while|pause|beat|second|minute|time)|a\s+(?:moment|while|second|minute)\s+later|moments?\s+later|seconds?\s+later|minutes?\s+later|soon(?:\s+after)?|presently|now|just\s+then|eventually|finally|at\s+last)\b/i;

const RE_PLACE =
  /^(?:meanwhile|elsewhere|across\s+the\s+\w+|back\s+(?:at|in|home|inside|outside)|on\s+the\s+other\s+side|miles?\s+away|far\s+away|in\s+another\s+\w+|downstairs|upstairs)\b/i;

const RE_ABRUPT =
  /^(?:suddenly|abruptly|without\s+warning|all\s+at\s+once|in\s+an\s+instant|in\s+a\s+flash|just\s+like\s+that)\b/i;

/** Classify the opening discourse marker of a sentence/paragraph. */
export function classifyOpener(text: string): OpenerClass {
  const t = text.trimStart();
  if (RE_TIME_MAJOR.test(t)) return "time-major";
  if (RE_PLACE.test(t)) return "place-shift";
  if (RE_ABRUPT.test(t)) return "abrupt";
  if (RE_TIME_MINOR.test(t)) return "time-minor";
  return null;
}

// A relocation phrase may sit in a follow-on clause of the opening sentence,
// e.g. "The next morning, across the city, …" — so for scene detection we look
// for it ANYWHERE in the leading clause, not only at absolute position 0.
const RE_PLACE_ANY =
  /\b(?:meanwhile|elsewhere|across\s+the\s+\w+|back\s+(?:at|in|home|inside|outside)|on\s+the\s+other\s+side|miles?\s+away|far\s+away|in\s+another\s+\w+|in\s+the\s+(?:kitchen|garden|study|hall|library|cellar|attic|chapel|courtyard)|downstairs|upstairs)\b/i;

export interface OpenerSignals {
  /** Opening sentence begins with a major time jump. */
  timeMajor: boolean;
  /** Opening sentence references a relocation (lead clause). */
  placeShift: boolean;
  /** Opening sentence begins with an abrupt pivot. */
  abrupt: boolean;
}

/**
 * Scene-oriented signals from a paragraph's OPENING sentence. Unlike
 * `classifyOpener` (which strictly classifies position 0 for the paragraph
 * pass), this reads the whole leading sentence so a place shift in a follow-on
 * clause is still seen. Used by auto-scene-break for corroboration.
 */
export function openerSignals(paragraph: string): OpenerSignals {
  const first = splitSentences(paragraph)[0]?.text ?? paragraph;
  const lead = first.slice(0, 140);
  return {
    timeMajor: RE_TIME_MAJOR.test(lead.trimStart()),
    placeShift: RE_PLACE_ANY.test(lead),
    abrupt: RE_ABRUPT.test(lead.trimStart()),
  };
}
