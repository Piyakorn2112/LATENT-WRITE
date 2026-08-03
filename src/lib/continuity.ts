// Cross-chapter continuity signals — compares the active chapter against
// the surrounding book to surface high-leverage editorial flags:
//
//   • Out-of-order character mention — character first canonically
//     appears in a later chapter (potential timeline slip / missing
//     flashback marker).
//   • Chekhov candidates — concrete, specific nouns introduced in this
//     chapter that never recur. The writer can decide whether they
//     should pay off, fade, or be cut.
//   • Setting / time hand-off — soft check that the chapter's opening
//     locale and time-of-day cohere with the prior chapter's ending.
//
// Like prose-profile, all signals are heuristic. Designed to surface
// candidates the writer reviews; never to autocorrect.

import type { Chapter, WorldData } from "../types";

// ─── Character first-appearance map ──────────────────────────────────────
//
// Walks the book in chapter order and records the first chapter index
// where each known character name (or alias) appears. We then check the
// active chapter's mentions against that map: if a character is first
// "officially" introduced in chapter 12 but they're being mentioned in
// chapter 4, that's worth flagging.

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasesFor(c: WorldData["characters"][number]): string[] {
  return [c.name, ...(c.aliases ?? [])].filter(Boolean);
}

/**
 * Speech verbs that mark a name as PRESENT on the page rather than merely
 * discussed. Deliberately small and common — a name beside one of these is
 * someone in the scene, which is the whole distinction this signal turns on.
 */
const SPEECH_VERB =
  "(?:said|says|asked|asks|replied|answered|cried|whispered|shouted|murmured|added|told|muttered|called)";

/** Is this name in the scene, speaking, rather than being talked about? */
function presentInChapter(text: string, names: string[]): boolean {
  for (const name of names) {
    const n = escapeRe(name);
    // "X said" (allowing a short intervening clause), "said X", or a name
    // sitting immediately against a closing quotation mark.
    if (new RegExp(`\\b${n}\\b[^.!?"\u201C\u201D]{0,40}\\b${SPEECH_VERB}\\b`, "i").test(text)) return true;
    if (new RegExp(`\\b${SPEECH_VERB}\\b\\s+${n}\\b`, "i").test(text)) return true;
    if (new RegExp(`["\u201C][^"\u201C\u201D]{2,200}["\u201D]\\s*[,.]?\\s*${n}\\b`, "i").test(text)) return true;
  }
  return false;
}

export interface OutOfOrderHit {
  character: string;       // canonical name
  firstChapter: number;    // chapter number where they're "officially" introduced
  thisChapter: number;     // current chapter number
}

/**
 * A named character who walks on and starts talking, having never been
 * mentioned anywhere earlier in the book.
 *
 * ★★ THIS REPLACES A CHECK THAT COULD NEVER FIRE. The previous version asked
 *    whether a character's FIRST mention was in a LATER chapter than the one
 *    they are being mentioned in. It computed that first mention over every
 *    chapter INCLUDING this one, and only ran at all for characters this
 *    chapter mentions — so the first index was always ≤ this index and the
 *    condition was unsatisfiable. Measured: 0.00 hits per chapter across 61
 *    DEV chapters (scripts/probe-continuity-quality.ts). Dead by construction,
 *    and it had been shipping as one of three continuity signals.
 *
 * ★ THE REPLACEMENT IS A DIFFERENT QUESTION, CHOSEN BY MEASUREMENT. Three
 *   candidate definitions were counted before this one was written
 *   (scripts/probe-continuity-candidates.ts, engine-resolved cast so the count
 *   was possible at all):
 *
 *     talked about ≥3 chapters before appearing   — real, but mostly
 *                                                    foreshadowing, not a slip
 *     named but never appears anywhere            0.59/ch, and unreliable:
 *                                                    a first-person narrator
 *                                                    never says "Watson said"
 *     ARRIVES WITH NO PRIOR MENTION               0.48/ch — in band, and the
 *                                                    hits read as real
 *                                                    (Lestrade, Miss Stoner,
 *                                                    Rucastle)
 *
 * ★ IT ONLY LOOKS PAST THE OPENING OF THE BOOK. Every character in chapter one
 *   arrives with no prior mention; that is what chapter one is for. The check
 *   starts after the first fifth, where an unannounced speaking character is a
 *   choice worth confirming rather than the norm.
 */
export function findUnintroducedArrivals(
  chapters: Chapter[],
  worldData: WorldData | undefined,
  thisIndex: number,
): OutOfOrderHit[] {
  if (!worldData?.characters?.length) return [];
  if (thisIndex < 0 || thisIndex >= chapters.length) return [];
  // The opening of a book introduces everybody; there is nothing to report.
  if (thisIndex < Math.max(1, Math.floor(chapters.length * 0.2))) return [];
  const cur = chapters[thisIndex];
  if (!cur.content.trim()) return [];

  const out: OutOfOrderHit[] = [];
  for (const ch of worldData.characters) {
    const aliases = aliasesFor(ch);
    if (aliases.length === 0) continue;
    const re = new RegExp(`\\b(?:${aliases.map(escapeRe).join("|")})\\b`, "i");
    if (!re.test(cur.content)) continue;
    // Talked about earlier? Then they were set up, whatever else is true.
    let mentionedBefore = false;
    for (let i = 0; i < thisIndex; i++) {
      if (re.test(chapters[i].content)) { mentionedBefore = true; break; }
    }
    if (mentionedBefore) continue;
    // A name that merely appears here is not the finding; one that SPEAKS is.
    if (!presentInChapter(cur.content, aliases)) continue;
    out.push({
      character: ch.name,
      firstChapter: cur.number,
      thisChapter: cur.number,
    });
  }
  return out;
}

/** @deprecated Kept as the old name; see findUnintroducedArrivals for why the
 *  original check could never fire. */
export const findOutOfOrderMentions = findUnintroducedArrivals;

// ─── Chekhov: introduced-and-never-recurs concrete nouns ─────────────────
//
// Heuristic: collect bigrams where a definite-article phrase ("the rusted
// pistol", "her grandfather's watch") appears in this chapter and the
// noun head never reappears in any later chapter. We match the *noun
// head* (last word of the phrase) against later content to count
// recurrences.

const STOPWORDS = new Set([
  "the","a","an","this","that","these","those","my","your","his","her",
  "their","our","its","one","some","any","every","each","what","which",
]);

const COMMON_NOUNS = new Set([
  // Body parts, generic nouns that aren't "objects" worth tracking.
  "hand","hands","face","faces","eye","eyes","head","heart","mouth","arm",
  "arms","leg","legs","foot","feet","skin","hair","fingers","finger",
  "shoulder","shoulders","back","chest","mind","minds","voice","voices",
  "thing","things","man","woman","men","women","boy","girl","boys","girls",
  "person","people","kid","kids","child","children","day","days","night",
  "nights","hour","hours","minute","minutes","time","moment","moments",
  "way","ways","place","places","side","end","start","beginning","middle",
  "front","top","bottom","line","lines","word","words","name","names",
  "thought","thoughts","reason","reasons","question","questions","answer",
  "kind","kinds","sort","point","part","parts",
]);

/**
 * Closed-class words, which a noun phrase never is.
 *
 * ★★ THIS EXISTS BECAUSE THE REGEX SURFACED "rather than" AS A CHEKHOV GUN, AND
 *    THE LOCAL MODEL CONFIRMED IT AS A PROMISE at 0.7 — caught by READING what
 *    scripts/verify-review-sweep-e2e.mjs actually produced, not by any gate.
 *    The pattern matches `article + up to two words + word + word`, so any
 *    run of lowercase words after "the" qualifies, and "…the register rather
 *    than…" yields modifier "rather", head "than".
 *
 *    STOPWORDS and COMMON_NOUNS could not catch it, and adding "than" to them
 *    would be whack-a-mole: the defect is not those two words, it is that
 *    nothing tested WORD CLASS at all. A closed class is finite, so this is
 *    the one filter that ends the game rather than playing another round.
 *
 * ★ IT MATTERS MOST FOR THE MODEL, NOT THE WIDGET. Junk like this recurs
 *   constantly, and chekhov-review ranks by mentions — so the function words
 *   sorted FIRST and spent the whole per-chapter budget before a real object
 *   was ever asked about. And the question is unanswerable-but-plausible: the
 *   model is grounded in the SENTENCE, which always sounds meaningful, so it
 *   confirms rather than declines.
 */
const FUNCTION_WORDS = new Set([
  // conjunctions & subordinators
  "and","or","but","nor","yet","so","than","then","because","although","though",
  "while","whereas","unless","until","since","if","whether","that","as","when",
  "where","after","before","once",
  // prepositions
  "of","in","on","at","to","for","with","from","by","about","into","onto",
  "over","under","above","below","through","between","among","against",
  "without","within","across","behind","beside","toward","towards","upon",
  "off","out","up","down","near","past","along","around",
  // degree / focus adverbs and other closed-class filler
  "rather","quite","very","almost","nearly","just","only","even","still",
  "already","also","too","enough","such","more","most","less","least","much",
  "many","few","several","other","others","another","same","own",
  // pronouns and be/have/do forms that can land in the slots
  "he","she","it","they","we","you","i","him","them","us","me","who","whom",
  "whose","is","was","were","are","been","being","be","had","has","have",
  "did","does","do","not","no","never","always",
]);

/**
 * Endings that mark an abstract noun. A promise is a THING; "plainness",
 * "geniality", "resolution" and "superiority" are not things anyone can hide
 * in a drawer. 10% of what the extractor emits, measured over 1174 phrases
 * from six DEV books (scripts/probe-continuity-candidates.ts).
 */
const ABSTRACT_SUFFIX = /(?:ness|ity|tion|sion|ment|ance|ence|ism|ship|hood|acy|ancy|ency|itude|dom)$/;

/**
 * Verbs of HANDLING. Something a character picks up, hides, locks or carries is
 * a thing the prose has touched, and that is most of what separates a prop from
 * a noun that happens to sit in a sentence.
 *
 * ★ IT RANKS, IT DOES NOT FILTER. Only 16% of emitted phrases are ever handled,
 *   so hard-filtering on this would empty the widget. The score orders the list
 *   instead, which is what actually matters: the writer reads the top of it, and
 *   the model's two questions a chapter go to the top of it.
 */
const HANDLE_VERB = new Set([
  "put","took","take","held","hold","carried","carry","opened","open","closed",
  "locked","lock","hid","hide","drew","draw","set","lifted","lift","broke",
  "break","picked","pick","dropped","drop","pulled","pull","pushed","push",
  "wore","wear","gave","give","handed","hand","threw","throw","kept","keep",
  "reached","touched","touch","grabbed","grab","slipped","packed","loaded",
  "sealed","seal","buried","bury","wrapped","folded","placed","place","laid",
  "lay","pocketed","clutched","gripped","raised","tore","cut","stowed","hung",
]);

export interface ChekhovCandidate {
  /** The noun phrase, e.g. "rusted pistol". */
  phrase: string;
  /** Number of mentions in *this* chapter. */
  mentions: number;
  /**
   * 0…1, how much this reads as a physical object rather than an abstraction.
   *
   * ★★ THE LIST IS SORTED BY THIS, AND NOTHING IS DELETED FOR IT. Measured over
   *    61 DEV chapters, the extractor emits 4.92 phrases a chapter and most are
   *    not things ("hearty assent", "modern languages", "complete victory").
   *    A bigram regex cannot identify concrete nouns without a lexicon, so every
   *    filter here is a proxy and a hard cut would throw away real props with
   *    the noise. Ordering costs nothing when it is wrong and puts the real
   *    objects where they are read when it is right.
   */
  concreteness: number;
  /**
   * The sentence that INTRODUCES the phrase, verbatim — the first place it
   * occurs in this chapter.
   *
   * ★ THE WHOLE PROMISE-OR-FURNITURE QUESTION LIVES IN THIS SENTENCE. A phrase
   *   on its own ("rusted pistol") cannot be judged: what separates a promise
   *   from scenery is whether the prose hid it, loaded it, or stopped to say it
   *   mattered. chekhov-review.ts drops a candidate that has no sentence rather
   *   than ask about the phrase alone, because the phrase alone is an invitation
   *   to invent. Empty only when the match cannot be located (it always can).
   */
  sentence: string;
}

/**
 * The sentence containing `index`, bounded by terminal punctuation.
 *
 * Deliberately simple: this feeds a prompt, not a parser. An abbreviation that
 * splits a sentence early costs the model a clause of context; a whole-paragraph
 * fallback would cost it the signal in noise.
 */
function sentenceAround(text: string, index: number, max = 400): string {
  const before = text.slice(0, index);
  const startAt = Math.max(
    before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"),
    before.lastIndexOf("\n"),
  );
  const from = startAt === -1 ? 0 : startAt + 1;
  const rest = text.slice(index);
  const endRel = rest.search(/[.!?\n]/);
  const to = endRel === -1 ? text.length : index + endRel + 1;
  return text.slice(from, to).replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * How much a phrase reads as a physical object, 0…1.
 *
 * Three independent signals, none of which is decisive alone:
 *   the head is not an abstraction, the head is not a verb participle
 *   ("wit flowed", "body oscillated"), and somebody HANDLES it nearby.
 *
 * ★ THE WINDOW LOOKS BACKWARD ONLY, and not far. "She put the sealed letter
 *   under the ledger" has the verb before the phrase; a verb 200 characters
 *   away belongs to a different clause and would make every noun in a busy
 *   paragraph look handled.
 */
export function concretenessOf(phrase: string, text: string, at: number): number {
  const head = phrase.split(/\s+/).pop() ?? "";
  if (!head) return 0;
  let score = 0;
  if (!ABSTRACT_SUFFIX.test(head)) score += 0.4;
  if (!/(?:ed|ing)$/.test(head)) score += 0.3;
  const before = text.slice(Math.max(0, at - 70), at).toLowerCase();
  if (before.split(/[^a-z]+/).some((w) => HANDLE_VERB.has(w))) score += 0.3;
  return score;
}

export function findChekhovCandidates(
  chapters: Chapter[],
  thisIndex: number,
  limit = 6,
): ChekhovCandidate[] {
  if (thisIndex < 0 || thisIndex >= chapters.length - 1) {
    // No "later chapters" exists for the final chapter — nothing to check.
    return [];
  }
  const text = chapters[thisIndex].content;
  if (!text.trim()) return [];
  const later = chapters.slice(thisIndex + 1).map((c) => c.content.toLowerCase()).join("\n");

  // Match: definite-article + 0/1 adjective + concrete noun.
  //
  // ★★ THE `{0,2}?` IS LAZY, AND IT USED TO BE GREEDY. Greedy, the optional
  //    run swallowed the adjective AND the noun, so the two captures landed on
  //    whatever TRAILED the phrase: "the rusted pistol on the shelf" produced
  //    ("on", "the") — thrown away by STOPWORDS — and "…the register rather
  //    than…" produced ("rather", "than"), which survived every filter and was
  //    put to the local model, which called it a Chekhov promise at 0.7.
  //
  //    So this never extracted head nouns at all; it extracted trailing word
  //    pairs that sometimes happened to be nouns. Lazy, the run yields as
  //    little as it can and the captures land on the adjective and the head:
  //    "rusted pistol", "jade token", "alarm bell", "small pawnbroker" where
  //    the same prose previously gave "could penetrate", "sat doggedly",
  //    "rather than". test-continuity-voice holds at 32/32 across the change.
  const re = /\b(?:the|a|an|his|her|their|its|my|your)\s+(?:[a-z]+\s+){0,2}?([a-z]+ed|[a-z]+ing|[a-z]+)\s+([a-z]+)\b/g;

  const counts = new Map<string, { phrase: string; mentions: number; at: number }>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const adj = m[1] ?? "";
    const head = m[2] ?? "";
    if (!head || head.length < 4) continue;
    if (STOPWORDS.has(head) || COMMON_NOUNS.has(head)) continue;
    if (STOPWORDS.has(adj) || COMMON_NOUNS.has(adj)) continue;
    // ★★ Word class, not vocabulary — see the note on FUNCTION_WORDS. A phrase
    //    containing a closed-class word in either slot is not a noun phrase,
    //    and asking a model whether "rather than" is a Chekhov gun wastes a
    //    question on something that cannot have an answer.
    if (FUNCTION_WORDS.has(head) || (adj && FUNCTION_WORDS.has(adj))) continue;
    const phrase = `${adj} ${head}`.trim();
    const key = head;
    const ex = counts.get(key);
    if (ex) ex.mentions++;
    // `m.index` of the FIRST match only: the introducing sentence is the one
    // that made the promise, and a later mention is the story already using it.
    else counts.set(key, { phrase, mentions: 1, at: m.index });
  }

  const out: ChekhovCandidate[] = [];
  for (const [head, { phrase, mentions, at }] of counts) {
    // Skip noun heads that recur in later chapters at all — they're
    // already paying off (or the writer is referencing them).
    if (later.includes(` ${head} `) || later.includes(` ${head}.`) || later.includes(` ${head},`)) {
      continue;
    }
    // Only flag if there's enough specificity: the head appears as a
    // noun in a definite-article phrase 1+ time and doesn't recur.
    out.push({
      phrase, mentions,
      sentence: sentenceAround(text, at),
      concreteness: concretenessOf(phrase, text, at),
    });
  }
  // ★ CONCRETENESS FIRST, THEN MENTIONS. Mentions alone put the most REPEATED
  //   phrase on top, and function-word junk repeats more than any prop does —
  //   which is how "rather than" reached the model ahead of every real object.
  out.sort((a, b) => b.concreteness - a.concreteness || b.mentions - a.mentions);
  return out.slice(0, limit);
}

// ─── Setting / time hand-off ─────────────────────────────────────────────
//
// Crude time/place tokens at the end of the previous chapter vs the
// start of this chapter. We don't try to model an absolute timeline;
// just flag when one chapter ends "in the dungeon, at midnight" and
// the next opens in "the city plaza, at noon" with no transition prose.

const TIME_TOKENS_RE = /\b(dawn|morning|noon|afternoon|dusk|evening|twilight|night|midnight|sunrise|sunset|daybreak|nightfall)\b/gi;

/**
 * Openers that ANNOUNCE elapsed time. "The next morning", "three days later",
 * "that same night" — the chapter telling the reader where it sits in time.
 *
 * ★★ THE OLD RULE NEEDED A TIME WORD ON BOTH SIDES OF THE BOUNDARY, and so
 *    fired 0.04 times per chapter across 55 DEV boundaries: effectively never,
 *    while shipping as one of three continuity signals. The common real case is
 *    a chapter that ENDS without naming a time and OPENS with "The next
 *    morning", which the old rule could not see at all. Measured with this
 *    added: 0.13/ch, roughly one boundary in eight, which is what a hand-off
 *    signal should look like — it is not supposed to fire on every chapter.
 */
const ELAPSE_OPENER_RE =
  /\b(?:the\s+(?:next|following)\s+(?:morning|day|night|evening|afternoon|week|month|year)|(?:that|the)\s+(?:same\s+)?(?:night|evening|morning|afternoon)|(?:a|two|three|four|five|six|seven|several|a\s+few)\s+(?:days?|weeks?|months?|years?|hours?)\s+(?:later|afterwards|after)|later\s+that\s+(?:day|night|evening|morning)|by\s+(?:morning|nightfall|evening)|next\s+morning)\b/i;

export interface HandoffHint {
  prevTime?: string;
  thisTime?: string;
  prevPlace?: string;     // best-effort (worldData place mentioned in prev chapter's ending)
  thisPlace?: string;
  drift: "time" | "place" | "both" | null;
}

export function detectHandoff(
  chapters: Chapter[],
  thisIndex: number,
  worldData: WorldData | undefined,
): HandoffHint | null {
  if (thisIndex <= 0) return null;
  const cur = chapters[thisIndex];
  const prev = chapters[thisIndex - 1];
  if (!cur.content.trim() || !prev.content.trim()) return null;

  // Look at the last ~600 chars of prev chapter and first ~600 of this.
  const prevTail = prev.content.slice(-600);
  const thisHead = cur.content.slice(0, 600);

  const lastTime = (prevTail.match(TIME_TOKENS_RE) ?? []).pop()?.toLowerCase();
  const bareTime = (thisHead.match(TIME_TOKENS_RE) ?? [])[0]?.toLowerCase();
  // An explicit opener is stronger evidence than a bare token: it is the prose
  // stating that time passed, rather than a word that merely names a time.
  const opener = thisHead.slice(0, 400).match(ELAPSE_OPENER_RE)?.[0]?.toLowerCase();
  const firstTime = opener ?? bareTime;

  // Place hand-off: dominant place mentioned in each window.
  const places = worldData?.places ?? [];
  const placesAndAliases = places.flatMap((p) => [p.name, ...(p.aliases ?? [])]).filter(Boolean);
  const findPlace = (window: string): string | undefined => {
    let best: { name: string; count: number } | null = null;
    for (const p of placesAndAliases) {
      if (!p) continue;
      const re = new RegExp(`\\b${escapeRe(p)}\\b`, "gi");
      const c = (window.match(re) ?? []).length;
      if (c > 0 && (!best || c > best.count)) best = { name: p, count: c };
    }
    return best?.name;
  };

  const prevPlace = findPlace(prevTail);
  const thisPlace = findPlace(thisHead);

  let drift: "time" | "place" | "both" | null = null;
  // ★ AN OPENER STANDS ON ITS OWN. "The next morning" is a hand-off whether or
  //   not the previous chapter happened to name a time in its last 600
  //   characters, which is the case the old both-sides rule could never see.
  const timeShift = opener ? true : !!(lastTime && firstTime && lastTime !== firstTime);
  const placeShift = prevPlace && thisPlace && prevPlace !== thisPlace;
  if (timeShift && placeShift) drift = "both";
  else if (timeShift) drift = "time";
  else if (placeShift) drift = "place";

  if (!drift) return null;
  return {
    prevTime: lastTime,
    thisTime: firstTime,
    prevPlace,
    thisPlace,
    drift,
  };
}

// Aggregate all signals — convenience for the widget.
export interface ContinuitySummary {
  outOfOrder: OutOfOrderHit[];
  chekhov: ChekhovCandidate[];
  handoff: HandoffHint | null;
  hasAnything: boolean;
}

export function summarizeContinuity(
  chapters: Chapter[],
  worldData: WorldData | undefined,
  thisIndex: number,
): ContinuitySummary {
  const outOfOrder = findOutOfOrderMentions(chapters, worldData, thisIndex);
  const chekhov = findChekhovCandidates(chapters, thisIndex);
  const handoff = detectHandoff(chapters, thisIndex, worldData);
  return {
    outOfOrder,
    chekhov,
    handoff,
    hasAnything: outOfOrder.length > 0 || chekhov.length > 0 || handoff !== null,
  };
}
