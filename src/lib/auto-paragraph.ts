/**
 * Smart chapter auto-paragraphing.
 *
 * Given a chapter's raw content, produce a re-paragraphed version using
 * signals already derivable from the prose: speech detection (quote
 * boundaries + speaker change), action verb density, discourse / time-shift
 * markers, and a length cap. The goal isn't 100% fidelity — it's giving
 * the writer a sane starting point they can review and tweak in seconds
 * instead of hand-breaking a wall of text.
 *
 * The algorithm operates on flat sentence sequences:
 *   1. Preserve existing scene breaks (lines like "* * *" or "---")
 *      verbatim — those are an authorial decision and never split.
 *   2. Within each prose chunk, collapse all whitespace (newlines + spaces)
 *      to single spaces — we re-derive the paragraph structure from
 *      scratch rather than honour the user's existing breaks, otherwise
 *      a wall-of-text input would get unchanged output.
 *   3. Sentence-tokenise the chunk.
 *   4. Annotate each sentence with quote presence, attribution-tag
 *      detection, time-shift opener, action-verb head, and a coarse
 *      speaker guess.
 *   5. Walk pairwise; insert a paragraph break before sentence i when
 *      one of the rules fires (see RULES below).
 *   6. Re-emit `paragraphs.join("\n\n")`.
 *
 * Design choices:
 *   • No dependency on `detectSpeechInChapter` — that operates on
 *     pre-split paragraphs, which we don't have yet. We use a lightweight
 *     local quote/attribution scan tuned for paragraphing decisions only.
 *   • Conservative on breaks: we'd rather under-split than over-split,
 *     because the output is meant to be a reasonable draft, not noisy
 *     fragments the writer has to glue back together.
 *   • No async / no worker — the algorithm is fast enough to run
 *     synchronously even on long chapters; the loading shell exists for
 *     UX feedback (the orb / pill), not because the work blocks.
 */

const SCENE_BREAK_RE = /^[\s\*\-—#~=|]{3,}$/;

// Quote characters across common conventions. Matches anywhere in a
// sentence to flag dialogue presence; we don't try to balance pairs
// since the paragraphing rules only need "is there speech here at all".
const QUOTE_ANY = /[“”"'‘’«»]/;
const QUOTE_OPENER_AT_START = /^\s*[“"'‘«]/;

// Attribution verbs for "X said" / "she whispered" pattern detection.
// Matches the speech-detect verb list at a smaller, paragraphing-only
// granularity — enough to recognise that "Alice said" anchors a quote
// to the SAME paragraph as that quote rather than the next.
const ATTRIB_VERBS = [
  "said","says","asked","asks","replied","replies","whispered","whispers",
  "shouted","shouts","muttered","mutters","exclaimed","added","adds",
  "answered","answers","called","calling","cried","cries","murmured","sighed",
  "snapped","stated","told","tells","yelled","gasped","breathed","interrupted",
  "continued","began","begins","insisted","explained","scoffed","groaned",
  "growled","laughed","screamed","spoke","speaks","mumbled","barked",
  "hissed","stammered","wondered","muttered","retorted","remarked","quipped",
];
const ATTRIB_VERBS_RE = new RegExp(
  `\\b(?:${ATTRIB_VERBS.join("|")})\\b`,
  "i",
);

// Discourse markers at sentence start that strongly suggest a paragraph
// break. Time-shift = jumps in narrative time. Abrupt = sudden pivots.
const TIME_SHIFT_RE = /^(?:later|then|afterwards?|that\s+(?:morning|afternoon|evening|night|day)|the\s+next\s+\w+|hours?\s+later|days?\s+later|weeks?\s+later|months?\s+later|years?\s+later|moments?\s+later|much\s+later|meanwhile|elsewhere|outside|inside|across\s+the\s+(?:room|street|hall|table|city)|down\s+(?:the\s+\w+)|when\s+(?:the\s+)?(?:morning|night|sun|moon|day|evening|dawn|dusk)|by\s+(?:the\s+time|nightfall|morning|noon|dawn|dusk))\b/i;

const ABRUPT_RE = /^(?:suddenly|abruptly|without\s+warning|in\s+an\s+instant|all\s+at\s+once|just\s+then)\b/i;

// Action-beat heuristics — matches sentences that lead with motion, used
// to consider a paragraph break when a strong physical beat follows
// non-physical narration. A small, high-precision verb set keeps the
// rule from firing on every "She walked over" inside an existing scene.
const ACTION_HEAD_VERBS = [
  "stood","sat","rose","fell","stepped","walked","ran","sprinted","jumped",
  "leapt","crouched","kneeled","knelt","bolted","dashed","staggered",
  "stumbled","grabbed","reached","pulled","pushed","slammed","slipped",
  "turned","spun","whirled","dropped","flung","threw","caught","struck",
  "hit","kicked","punched","drew","raised","lowered","leaned","bowed",
  "lunged","sprang","fled","chased","entered","exited","crossed","passed",
];
const ACTION_HEAD_RE = new RegExp(
  `^(?:[A-Z][a-z'\\-]+\\s+)?(?:${ACTION_HEAD_VERBS.join("|")})\\b`,
  "i",
);

// Paragraph length cap — beyond this many sentences the next reasonable
// boundary forces a break for readability. Calibrated against trade-
// paperback prose where the median paragraph is 2–4 sentences and 6+
// reads as a wall.
const MAX_SENTENCES_PER_PARA = 5;

interface SentenceInfo {
  text: string;
  /** Sentence contains at least one quote character. */
  hasQuote: boolean;
  /** Sentence is essentially nothing but a quoted line (≥ 60% in quotes). */
  isMostlyQuote: boolean;
  /** Sentence ends with " or " followed by punctuation (closing quote). */
  endsWithCloseQuote: boolean;
  /** Sentence opens with a quote marker. */
  startsWithOpenQuote: boolean;
  /** Sentence contains a "said" / "asked" / etc. attribution verb. */
  hasAttribVerb: boolean;
  /** Sentence text starts with a known time-shift discourse marker. */
  startsWithTimeShift: boolean;
  /** Sentence text starts with an abrupt-pivot marker. */
  startsWithAbrupt: boolean;
  /** Sentence opens with an action-head verb (Subject + walked/turned/…). */
  startsWithActionHead: boolean;
  /** Coarse speaker guess for dialogue-only lines (a known name appearing
   *  in the sentence's attribution, or the lone speaker in the line). */
  speakerGuess?: string;
}

// ── Sentence tokenisation ────────────────────────────────────────────────

function splitSentences(text: string): string[] {
  const out: string[] = [];
  // End boundary: ., !, or ? followed optionally by a closing quote /
  // bracket, then whitespace or end-of-input. We keep the punctuation
  // attached to the sentence.
  const re = /[.!?]+['")\]’”]?(?=\s|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    let start = last;
    while (start < end && /\s/.test(text[start])) start++;
    if (start < end) out.push(text.slice(start, end));
    last = end;
  }
  if (last < text.length) {
    let start = last;
    while (start < text.length && /\s/.test(text[start])) start++;
    if (start < text.length) {
      const tail = text.slice(start).trim();
      if (tail) out.push(tail);
    }
  }
  return out;
}

// ── Sentence annotation ──────────────────────────────────────────────────

function annotate(sentence: string, knownNames: string[]): SentenceInfo {
  const trimmed = sentence.trim();
  const hasQuote = QUOTE_ANY.test(trimmed);
  const startsWithOpenQuote = QUOTE_OPENER_AT_START.test(trimmed);
  const endsWithCloseQuote = /['"’”][.,!?;:]?\s*$/.test(trimmed);
  const hasAttribVerb = hasQuote && ATTRIB_VERBS_RE.test(trimmed);

  // "Mostly quote" = the in-quote portion is ≥ 60% of the sentence chars.
  // Used to recognise pure dialogue lines (no surrounding narration).
  let inQuoteChars = 0;
  let inside = false;
  for (const ch of trimmed) {
    if (ch === "“" || ch === "‘" || ch === "«" || ch === '"' || ch === "'") {
      inside = !inside;
      continue;
    }
    if (ch === "”" || ch === "’" || ch === "»") {
      inside = false;
      continue;
    }
    if (inside) inQuoteChars++;
  }
  const isMostlyQuote = trimmed.length > 0 && inQuoteChars / trimmed.length >= 0.55;

  const startsWithTimeShift = TIME_SHIFT_RE.test(trimmed);
  const startsWithAbrupt = ABRUPT_RE.test(trimmed);
  const startsWithActionHead = ACTION_HEAD_RE.test(trimmed);

  // Speaker guess — find the first known name in this sentence (works
  // when the sentence contains an attribution like "Alice said").
  let speakerGuess: string | undefined;
  if (hasAttribVerb && knownNames.length) {
    for (const name of knownNames) {
      if (!name) continue;
      const re = new RegExp(`\\b${escapeRegex(name)}\\b`);
      if (re.test(trimmed)) {
        speakerGuess = name;
        break;
      }
    }
  }

  return {
    text: trimmed,
    hasQuote,
    isMostlyQuote,
    endsWithCloseQuote,
    startsWithOpenQuote,
    hasAttribVerb,
    startsWithTimeShift,
    startsWithAbrupt,
    startsWithActionHead,
    speakerGuess,
  };
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Break decision ───────────────────────────────────────────────────────

/**
 * RULES — return `true` to insert a paragraph break BEFORE `curr`.
 * Rules are ordered from strongest (always-break) to weakest (only when
 * paragraph is already long). First match wins; later rules don't override.
 */
function shouldBreakBefore(
  prev: SentenceInfo,
  curr: SentenceInfo,
  paraLen: number,
  carriedSpeaker: string | undefined,
): boolean {
  // 1. Speaker change in dialogue-heavy lines. If both sentences are
  //    mostly quote and we can identify two different speakers, break.
  if (prev.isMostlyQuote && curr.isMostlyQuote) {
    const a = prev.speakerGuess ?? carriedSpeaker;
    const b = curr.speakerGuess;
    if (a && b && a !== b) return true;
    // Two consecutive pure-dialogue lines — even without speaker certainty,
    // the convention is a paragraph break. Keep dialogue lines clean.
    if (!prev.hasAttribVerb && !curr.hasAttribVerb) return true;
  }

  // 2. Narration → dialogue transition. If curr opens with a quote and
  //    prev didn't end with attribution (which would tie them together),
  //    break before curr.
  if (curr.startsWithOpenQuote && !prev.isMostlyQuote) {
    // Don't break when prev sets up the quote ("She turned and said,").
    if (!/(:|,)\s*$/.test(prev.text) && !prev.hasAttribVerb) return true;
  }

  // 3. Dialogue → narration transition. A pure quote line followed by
  //    descriptive narration almost always wants its own paragraph.
  if (prev.isMostlyQuote && !curr.hasQuote && !curr.hasAttribVerb) {
    return true;
  }

  // 4. Time-shift markers — strong signal of new paragraph.
  if (curr.startsWithTimeShift) return true;

  // 5. Abrupt pivots — also strong.
  if (curr.startsWithAbrupt) return true;

  // 6. Action beat after narration: when the current paragraph has run a
  //    few sentences AND curr leads with an action head verb, break for
  //    pacing. The threshold (≥3) keeps us from breaking on every action.
  if (curr.startsWithActionHead && paraLen >= 3) return true;

  // 7. Length cap — force-break at the next sentence boundary once a
  //    paragraph has reached MAX_SENTENCES_PER_PARA.
  if (paraLen >= MAX_SENTENCES_PER_PARA) return true;

  return false;
}

// ── Per-block reparagraphing ─────────────────────────────────────────────

function reparagraphProse(text: string, knownNames: string[]): string {
  // Collapse all whitespace (including existing newlines) to single spaces.
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";

  const rawSentences = splitSentences(flat);
  if (rawSentences.length === 0) return flat;

  const annotated = rawSentences.map((s) => annotate(s, knownNames));

  const paragraphs: string[][] = [[annotated[0].text]];
  let carriedSpeaker = annotated[0].speakerGuess;

  for (let i = 1; i < annotated.length; i++) {
    const prev = annotated[i - 1];
    const curr = annotated[i];
    const currentPara = paragraphs[paragraphs.length - 1];

    if (shouldBreakBefore(prev, curr, currentPara.length, carriedSpeaker)) {
      paragraphs.push([curr.text]);
    } else {
      currentPara.push(curr.text);
    }

    if (curr.speakerGuess) carriedSpeaker = curr.speakerGuess;
  }

  return paragraphs.map((p) => p.join(" ")).join("\n\n");
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Re-paragraph an entire chapter's content. Scene-break markers (lines
 * matching `^[\s\*\-—#~=|]{3,}$`, e.g. `* * *`) are preserved verbatim
 * because they encode an authorial decision the algorithm shouldn't
 * second-guess. Everything else is collapsed and re-segmented from
 * scratch.
 */
export function autoParagraph(content: string, knownNames: string[] = []): string {
  if (!content || !content.trim()) return content;

  // Walk line by line, accumulating a running prose buffer. When we hit a
  // scene-break line, flush the buffer through reparagraphProse and emit
  // the scene break as-is. This keeps "* * *" exactly where the user put it.
  const lines = content.split("\n");
  const out: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    const reparagraphed = reparagraphProse(buffer.join("\n"), knownNames);
    if (reparagraphed) out.push(reparagraphed);
    buffer = [];
  };

  for (const line of lines) {
    if (SCENE_BREAK_RE.test(line.trim())) {
      flush();
      out.push(line.trim());
    } else {
      buffer.push(line);
    }
  }
  flush();

  return out.join("\n\n");
}
