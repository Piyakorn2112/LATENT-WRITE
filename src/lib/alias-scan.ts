/**
 * alias-scan.ts — one button: find every other name this book uses for a
 * character, and let the writer tick the ones that are real.
 *
 * alias-propose.ts already links what MORPHOLOGY can prove — Elizabeth ⊂
 * Elizabeth Bennet, Mr. Darcy → Darcy, Lizzy → Elizabeth — but only over
 * candidate forms somebody else extracted, and only when the two strings
 * overlap. Three whole classes of alias are invisible to it:
 *
 *   1. A SURNAME THAT NEVER STANDS ALONE. autoExtractEntities needs a form to
 *      occur 3+ times BY ITSELF and clear an IDF floor. A book that writes
 *      "Elena Vasquez" in full and "Elena" thereafter never produces "Vasquez"
 *      as a candidate at all, so no rule ever gets the chance to fire on it.
 *   2. AN EPITHET THE TEXT DECLARES. "Elena Vasquez, known as the Ash Marshal"
 *      is the strongest alias evidence there is — the author is telling you
 *      outright — and it shares not one character with the canonical name.
 *   3. A NICKNAME ONLY EVER SPOKEN. "Careful, Kes." No narration ever attaches
 *      it; it exists only in the vocative slot inside dialogue.
 *
 * ── WHAT THE FIELD DOES, AND WHERE THIS DIVERGES ───────────────────────────
 *
 * BookNLP clusters name mentions and then forbids common nouns ("the boy")
 * from ever coreferring to a named entity, because full coreference over a
 * book "tends to erroneously conflate multiple distinct entities into one".
 * Vala et al. (2015) build a mention graph, add LINK edges (hypocorism, shared
 * surname, stripped title), then cut edges along the shortest path between any
 * pair a VETO rule catches, and take connected components as characters.
 *
 * ★★ STILL NO CONNECTED COMPONENTS, for the reason alias-propose gives: a
 *    component is how "Elizabeth Bennet" reaches "Mr. Bennet" through the node
 *    "Bennet" and a family becomes one person. Every candidate here links ONE
 *    surface form to ONE canonical character the writer already has, and any
 *    form two characters could own is dropped rather than assigned.
 *
 * ★★ THE DIVERGENCE THAT MATTERS: this is not trying to be right. It is trying
 *    to put a SHORT, HONEST list in front of a writer who knows the answer. So
 *    recall may be bought with precision — a wrong row costs one glance — but
 *    every row carries the rule that produced it and a verbatim line from the
 *    manuscript, and only rows the TEXT ITSELF ASSERTS arrive pre-ticked.
 *    Everything inferred arrives unticked. That inversion is the whole safety
 *    story, and it is why this may propose things alias-review.ts was
 *    measured out for proposing automatically.
 *
 * ── THE FILTER FOR COMMON WORDS IS EVIDENCE, NOT A STOP-LIST ───────────────
 *
 * Two tests, both asking the manuscript rather than a shipped word list (the
 * app's users write in every naming tradition there is, and an English
 * stop-list is a bug for most of them):
 *
 *   · isCommonWordName — does the lower-case form outnumber the capitalised
 *     one in this very text? "then" swamps "Then"; a character called Rose
 *     swamps the flower. Borrowed from action-detect, where it was measured.
 *   · looksProperNoun — does the token EVER appear capitalised somewhere that
 *     is not a sentence start? This is the one that kills "Then Vale left" and
 *     "Suddenly Vasquez turned": a sentence-opening adverb is capitalised in
 *     every instance, a proper noun is capitalised mid-clause too.
 *
 * ── MEASURED ON FIVE PUBLIC-DOMAIN NOVELS ──────────────────────────────────
 *
 * Pride, Sherlock, Dracula, Gatsby, Carol — cast taken as the top 12 extracted
 * names, which is harsher than a real writer's cast and puts junk like "God"
 * and "West Egg" in it. 47 rows offered, ~450 forms refused, 0.7-4.1s a book.
 *
 * Adjacency, titled, attested and morphology are near-clean: "Mina <- Madam
 * Mina" (87x), "Van Helsing <- Professor Van Helsing", "Elizabeth <- Lizzy",
 * "Gatsby <- Jay Gatsby", "Lucy <- Lucy Westenra", "Holmes <- Sherlock Holmes".
 *
 * ★★ THE VOCATIVE LAYER SCORED ROUGHLY 0 FOR 9 ON REAL PROSE, and the two
 *    rules that fixed most of it are both about NARRATION:
 *
 *    · A name the NARRATOR uses is its own character, not somebody's nickname.
 *      `Watson <- Jones` (Athelney Jones), `Scrooge <- Fred` (his nephew) —
 *      real people the engine attached to whoever its "present and not
 *      speaking" guess landed on. If the narrator says the name in their own
 *      voice, it belongs in the cast as an entry.
 *    · Two DISJOINT names in one narrated sentence are two people. Not in a
 *      quoted one: `"Kes," Elena said, and Kestrel looked up` is evidence they
 *      are the SAME person, which is why the quoted half is blanked first.
 *
 *    Nine bad rows down to five. What survives is the class no positional or
 *    frequency test can reach — a capitalised non-name in the vocative slot
 *    ("Yeah", "Bah", "Ding"), which lives only inside quotation marks exactly
 *    as a real nickname does. ★ THE LOCAL MODEL WAS TRIED ON PRECISELY THIS
 *    AND MADE IT WORSE (0 wrong to 3 wrong); see the block in WorldDataView
 *    where the layer is switched off, and probe-alias-referent.cjs.
 *
 *    These rows arrive unticked and carry the passage, so the cost is a glance.
 *    Do not delete the layer to buy the precision: it is the only thing that
 *    finds a nickname appearing nowhere but dialogue, which is the case the
 *    feature exists for.
 */
import { isCommonWordName } from "./action-detect";
import { detectSpeechInChapter } from "./speech-detect";
import {
  proposeAliases,
  splitName,
  coordinated,
  surnameSharedByFamily,
  genderConflict,
  TITLES,
  type AliasProposal,
  type AliasProposalResult,
} from "./alias-propose";

// ── shape ──────────────────────────────────────────────────────────────────

export type AliasScanSource =
  /** alias-propose.ts: given name, surname, title, initial, hypocorism. */
  | "morphology"
  /** "Elena" + the Title-Case token to its RIGHT — a surname absorbed. */
  | "adjacent-right"
  /** The Title-Case token to a name's LEFT — a given name absorbed. */
  | "adjacent-left"
  /** A rank or honorific to the left: "Marshal Vasquez". */
  | "titled"
  /** The text says it: "known as X", "they called her X", "Elena, the X,". */
  | "attested"
  /** Spoken as direct address to somebody who is not the speaker. */
  | "vocative"
  /** The local model read a passage and named the referent. */
  | "model";

export interface AliasCandidate {
  /** The canonical cast entry this form belongs to. */
  character: string;
  /** The surface form found in the manuscript. */
  alias: string;
  /** `merge` when `alias` is itself an entry in the writer's cast. */
  kind: "alias" | "merge";
  source: AliasScanSource;
  /** 0..1. Ranking and the default tick — never an automatic merge. */
  confidence: number;
  occurrences: number;
  /** Verbatim from the manuscript, so the writer checks a fact not a claim. */
  evidence: string;
  /**
   * The manuscript ASSERTS this link ("known as", an appositive). Only these
   * arrive pre-ticked. Everything else is a question, not an answer.
   */
  attested: boolean;
  /** One line in the writer's language, naming what fired. */
  why: string;
}

export type AliasScanVeto =
  | "common-word"      // the lower-case form outnumbers the capitalised one
  | "sentence-opener"  // only ever capitalised at a sentence start
  | "ambiguous"        // the form fits more than one cast member
  | "coordination"     // "X and Y" — proof of two people
  | "shared-surname"   // the surname belongs to a FAMILY
  | "honorific-gender" // Mr against Miss
  | "too-rare"         // not worth a confirmation click
  | "already-known"    // already this character's name or alias
  | "co-occurs";       // alias and character share a paragraph — two people

export interface AliasScanRejection {
  character: string;
  alias: string;
  veto: AliasScanVeto;
}

export interface AliasScanResult {
  candidates: AliasCandidate[];
  /**
   * ★ REPORTED, NEVER DROPPED SILENTLY. A scan that refuses everything and a
   *   scan that is switched off look identical from the outside, and this repo
   *   has lost time to exactly that shape before.
   */
  rejected: AliasScanRejection[];
  /** Forms the deterministic pass could not attach — the model layer's input. */
  unresolved: UnresolvedForm[];
  stats: AliasScanStats;
}

export interface AliasScanStats {
  paragraphs: number;
  formsHarvested: number;
  /** Truncated by a cap rather than by a veto. Never silent — see `capped`. */
  capped: number;
}

/**
 * A recurring name-shaped form the book uses that belongs to NOBODY in the
 * cast, together with the character it behaves most like an alias of.
 *
 * This is the "completely different name" case: no shared letters, no
 * attestation, nothing morphology or pattern-matching can reach. What is left
 * is DISTRIBUTION — see `complementaryScore`.
 */
export interface UnresolvedForm {
  alias: string;
  occurrences: number;
  /** Cast members ranked by how alias-like their distribution is. */
  shortlist: Array<{ character: string; complementary: number }>;
  /** Verbatim passages showing the form in use. */
  snippets: string[];
  /** A vocative with more than one candidate addressee, if that is its origin. */
  fromVocative: boolean;
  /**
   * The answer the deterministic pass already reached, when it reached one.
   * Present → the model's job is to REFUTE it, and the row survives an
   * abstention. Absent → the model may attach the form, or leave it alone.
   */
  proposed?: string;
}

// ── constants ──────────────────────────────────────────────────────────────

/** An attested link needs one instance; the author said it out loud. */
const MIN_ATTESTED = 1;
/** An inferred one needs repetition — once is a typo or a coincidence. */
const MIN_INFERRED = 2;
/** Per character, so one noisy name cannot bury the rest of the list. */
const MAX_PER_CHARACTER = 8;
/** Paragraph radius for "who else is in this scene". */
const PRESENCE_WINDOW = 2;
/**
 * ★★ THE COLLOCATION TEST, and it is what separates a name-part from a word
 *    that merely stood next to a name. A surname BELONGS to its character:
 *    "Vasquez" occurs only ever inside "Elena Vasquez", "Sherlock" only ever
 *    before "Holmes". A greeting or a passing character does not — measured on
 *    the Sherlock corpus, adjacency alone offered `Watson ← Hullo` ("Hullo
 *    Watson," he said) and `Watson ← Jones`, because a Title-Case token beside
 *    a name is the same shape whatever the token means.
 *
 *    So: a neighbour is a name-part only if MOST of its occurrences in the book
 *    are attached to this name. Titles are exempt — "Miss" is shared by every
 *    woman in the book by definition, and that is what a title IS.
 */
const MIN_ADJACENT_SHARE = 0.5;
/** How many unattached forms may reach the model layer. */
const MAX_UNRESOLVED = 8;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Underscore is a word character and Gutenberg wraps names in it, so `\b`
 *  silently never matches. Same boundary as alias-propose and presence. */
const LB = "(?<![A-Za-z0-9])";
const RB = "(?![A-Za-z0-9])";
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

const TITLE_SET = new Set(TITLES.map((t) => t.toLowerCase()));

/**
 * The manuscript with every quoted span blanked out, so NARRATION can be read
 * on its own.
 *
 * ★★ THIS IS WHAT SEPARATES A NICKNAME FROM ANOTHER CHARACTER. Two names in one
 *    sentence are usually two people — but a vocative breaks that rule by
 *    construction, because `"Kes," Elena said, and Kestrel looked up` puts the
 *    nickname and the person in one sentence as EVIDENCE THEY ARE THE SAME. The
 *    quoted half and the narrated half are different kinds of claim, and the
 *    test only works on the narrated one. In narration, "Jack" and "Van Helsing"
 *    appearing together really are two men.
 *
 * ★ BLANKED LENGTH-PRESERVINGLY, not deleted: every offset into this string has
 *   to keep matching the original, or evidence windows and sentence boundaries
 *   drift silently against the real text.
 */
export function narrationOnly(text: string): string {
  return text.replace(/["“«][^"”»]{0,3000}["”»]/g, (m) => " ".repeat(m.length));
}

/**
 * Do two names appear in one sentence of NARRATION as SEPARATE mentions?
 *
 * ★★ THE JOINT FORM IS MASKED FIRST, and without that this test is worse than
 *    useless. "Sherlock Holmes said" contains "Sherlock" and "Holmes" in one
 *    sentence — and reading that as two people killed `Holmes ← Sherlock`,
 *    `Mina ← Murray`, `Gatsby ← Jay`, `Arthur ← Holmwood` and `Van Helsing ←
 *    Abraham` on the first run, every one of them correct. A given name beside
 *    its own surname is ONE mention. What the veto is looking for is the two
 *    names apart, in the same breath, doing different things.
 */
export function coOccursInNarration(narration: string, a: string, b: string): boolean {
  const A = esc(a), B = esc(b);
  const solo = narration.replace(
    new RegExp(`${LB}(?:${A}\\s+${B}|${B}\\s+${A})${RB}`, "gi"),
    (m) => " ".repeat(m.length),
  );
  return new RegExp(
    `[^.!?]*${LB}${A}${RB}[^.!?]*${LB}${B}${RB}[^.!?]*`
    + `|[^.!?]*${LB}${B}${RB}[^.!?]*${LB}${A}${RB}[^.!?]*`, "i",
  ).test(solo);
}

/**
 * Tokens that are capitalised mid-sentence for reasons that are not names.
 * Deliberately tiny: the two evidence tests do the work, and every entry here
 * is an English assumption this app should be reluctant to ship.
 */
const NEVER_A_NAME = new Set([
  "i", "i'm", "i'd", "i'll", "i've",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "god", "lord", "sir", "madam", "ma'am",
]);

// ── the two evidence tests ─────────────────────────────────────────────────

/**
 * Does this token EVER appear capitalised somewhere that is not the start of a
 * sentence or a quotation?
 *
 * ★★ THIS IS THE TEST THAT SEPARATES A GIVEN NAME FROM A SENTENCE OPENER, and
 *    nothing else can. "Then Vale left the room" and "Corin Vale left the room"
 *    are the same shape to every other check in this file: a Title-Case token,
 *    a space, a cast name. The difference is that "Corin" also occurs after a
 *    comma or mid-clause somewhere in the book and "Then" never does.
 *
 * A lower-case letter, comma, semicolon or colon before the whitespace proves
 * the position is mid-clause. A full stop, a dash or an opening quote does not.
 */
export function looksProperNoun(token: string, text: string): boolean {
  return new RegExp(`[a-z,;:][ \\t]+${esc(token)}${RB}`).test(text);
}

/**
 * Both evidence tests plus the tiny hard list. Every harvested form runs it.
 *
 * `attested` — the manuscript states the link in words. `alsoSeenAs` — the
 * multi-word form this token was absorbed into.
 */
function plausibleName(
  token: string,
  text: string,
  opts: { attested?: boolean; alsoSeenAs?: string; positionProven?: boolean } = {},
): AliasScanVeto | null {
  if (NEVER_A_NAME.has(token.toLowerCase().replace(/\.$/, ""))) return "common-word";
  // ★ AN ALL-CAPS TOKEN IS TYPOGRAPHY, NOT A NAME — a chapter heading, a sign,
  //   a shout. `[A-Z][A-Za-z]*` matches "HUNTER" as happily as "Hunter", and on
  //   the Sherlock corpus that put `Holmes ← HUNTER` in front of the writer,
  //   harvested from a running head. Two letters minimum so an initial survives.
  if (/^[A-Z]{2,}$/.test(token)) return "common-word";
  // ★★ A VOCATIVE IS ALREADY IN A PROPER-NOUN-ONLY POSITION, so asking
  //    looksProperNoun about it is asking the same question twice and getting
  //    the wrong answer: the vocative slot is bounded by a comma or an opening
  //    quote on the LEFT, which is precisely the shape looksProperNoun reads as
  //    "sentence start". Measured — `"Sparrow," Nadia said` was thrown away as
  //    a sentence opener, silently, and took the whole model layer with it.
  //    VOCATIVE_RE has already done the positional work: it requires closing
  //    punctuation straight after the token, which no sentence opener has
  //    ("Then you should go" is not matched; "Then, you should go" is, and the
  //    ratio test below still owns it).
  if (opts.positionProven) return isCommonWordName(token, text) ? "common-word" : null;
  // ★ AN ATTESTED FORM SKIPS THE CORPUS RATIO. "…known as the Ash Marshal" is
  //   the author stating the link outright, and that outranks a statistic
  //   about how often "ash" appears lower-case elsewhere in a book full of
  //   fires. The ratio test exists to judge forms nobody vouched for.
  if (!opts.attested && isCommonWordName(token, text)) return "common-word";
  if (looksProperNoun(token, text)) return null;
  // ★ THE FALLBACK, AND IT IS NOT A LOOSENING. A token that never appears
  //   mid-clause can still be a real given name, in a book that happens to
  //   open every sentence with it: "Corin Vale crossed the yard." ×9. What
  //   separates that from "Then Vale crossed the yard." is the ratio test,
  //   which has already run and passed. Requiring the BIGRAM itself to recur
  //   supplies the other half of the evidence.
  if (opts.alsoSeenAs && countOf(text, opts.alsoSeenAs) >= MIN_INFERRED) return null;
  return "sentence-opener";
}

const countOf = (text: string, form: string): number =>
  (text.match(new RegExp(`${LB}${esc(form)}${RB}`, "g")) ?? []).length;

/** Case-insensitive, for callers holding a normalised key rather than a surface
 *  form. ★ `countOf` is case-SENSITIVE, and passing it a lower-cased key
 *  silently returns 0 for every capitalised name — which is how the narration
 *  veto below read as "fires on nothing" for a whole measurement round. */
const countOfI = (text: string, form: string): number =>
  (text.match(new RegExp(`${LB}${esc(form)}${RB}`, "gi")) ?? []).length;

function evidenceFor(text: string, form: string, radius = 70): string {
  const m = new RegExp(`${LB}${esc(form)}${RB}`).exec(text);
  if (!m) return "";
  const at = m.index;
  return collapse(text.slice(Math.max(0, at - radius), Math.min(text.length, at + form.length + radius)));
}

// ── paragraph model ────────────────────────────────────────────────────────

interface ScanParagraph {
  text: string;
  /** Canonical cast members named in this paragraph. */
  present: Set<string>;
  /** Attributed speakers of this paragraph's dialogue. */
  speakers: Set<string>;
  /** Quoted spans only — where a vocative can live. */
  quotes: string[];
}

/** The engine's paragraph split. Duplicated in story-graph, event-detect and
 *  App; getting it wrong here would shift every evidence anchor silently. */
export function splitParagraphs(content: string): string[] {
  return content.split(/\n{2,}|\n/).map((l) => l.trim()).filter(Boolean);
}

// ── layer 1 · adjacency absorption ─────────────────────────────────────────

/**
 * The token immediately left and right of every occurrence of a known name.
 *
 * Only spaces and tabs may separate them, which is what makes this safe: any
 * punctuation at all — a comma, a full stop, a quote mark, a line break —
 * breaks the match, so "…and there was Elena. Vasquez had gone" contributes
 * nothing, and neither does `"Yes, Elena," Marcus said`.
 */
export function absorbNeighbours(
  text: string,
  name: string,
): { left: Map<string, number>; right: Map<string, number> } {
  const left = new Map<string, number>();
  const right = new Map<string, number>();
  const TOKEN = "[A-Z][A-Za-z'’-]*";
  const re = new RegExp(
    `(?:(${TOKEN})[ \\t]+)?${LB}${esc(name)}${RB}(?:[ \\t]+(${TOKEN})${RB})?`,
    "g",
  );
  // ★ A POSSESSIVE IS THE SAME NAME. The token class has to allow an apostrophe
  //   for O'Brien and D'Arcy, which also swallows the trailing 's — and the
  //   result was `Mina ← Mina Murray's` and `Lucy ← Westenra's` offered
  //   alongside the bare forms, two rows for one decision and neither of them
  //   how the name is spelled. Strip only a TRAILING possessive; the internal
  //   apostrophe is part of the name.
  const bare = (t: string) => t.replace(/['’]s$/, "").replace(/['’]$/, "");
  const add = (into: Map<string, number>, token: string) => {
    const key = bare(token);
    if (key.length >= 2) into.set(key, (into.get(key) ?? 0) + 1);
  };
  for (const m of text.matchAll(re)) {
    if (m[1]) add(left, m[1]);
    if (m[2]) add(right, m[2]);
  }
  return { left, right };
}

// ── layer 2 · what the text says outright ──────────────────────────────────

/**
 * Constructions in which a novel DECLARES an alias. These are the only rows
 * that arrive pre-ticked, because the author wrote the link down.
 *
 * `NAME` is substituted with the canonical name; group 1 is the alias. The
 * head of the alias phrase must be capitalised — that is BookNLP's rule about
 * common nouns, kept: "Elena, the woman who had waited," must not produce an
 * alias "woman", while "Elena, the Ash Marshal," must produce "Ash Marshal".
 */
const ATTESTED_PATTERNS: Array<{ build: (n: string) => RegExp; why: string }> = [
  // "Elena Vasquez, known as the Ash Marshal" / "…, called Sparrow"
  { build: (n) => new RegExp(`${LB}${n}${RB}[^.!?\\n]{0,40}?\\b(?:better\\s+)?(?:known|called)\\s+(?:as\\s+)?(?:the\\s+|a\\s+)?((?:[A-Z][A-Za-z'’-]+)(?:\\s+(?:of|the)\\s+[A-Z][A-Za-z'’-]+|\\s+[A-Z][A-Za-z'’-]+){0,2})`),
    why: "the text says “known as”" },
  // "they called her Sparrow" / "everyone called him the Ash Marshal"
  { build: (n) => new RegExp(`${LB}${n}${RB}[^.!?\\n]{0,80}?\\bcall(?:ed|s)?\\s+(?:him|her|them|it)\\s+(?:the\\s+)?((?:[A-Z][A-Za-z'’-]+)(?:\\s+[A-Z][A-Za-z'’-]+){0,2})`),
    why: "somebody calls them that" },
  // "Elena Vasquez, the Ash Marshal, stepped forward" — a true appositive,
  // closed by a second comma so a run-on clause cannot be swallowed.
  { build: (n) => new RegExp(`${LB}${n}${RB},\\s+(?:the|a)\\s+((?:[A-Z][A-Za-z'’-]+)(?:\\s+(?:of|the)\\s+[A-Z][A-Za-z'’-]+|\\s+[A-Z][A-Za-z'’-]+){0,2}),`),
    why: "named in apposition" },
  // "the Ash Marshal, as Elena was known"
  { build: (n) => new RegExp(`(?:the\\s+|a\\s+)?((?:[A-Z][A-Za-z'’-]+)(?:\\s+[A-Z][A-Za-z'’-]+){0,2}),\\s+as\\s+${LB}${n}${RB}\\s+(?:was|were|is|are)\\s+(?:known|called)`),
    why: "the text says “as … was known”" },
  // "went by the name Sparrow" / "goes by Sparrow"
  { build: (n) => new RegExp(`${LB}${n}${RB}[^.!?\\n]{0,40}?\\b(?:went|goes|go)\\s+by\\s+(?:the\\s+name\\s+(?:of\\s+)?)?(?:the\\s+)?((?:[A-Z][A-Za-z'’-]+)(?:\\s+[A-Z][A-Za-z'’-]+){0,2})`),
    why: "the text says “goes by”" },
  // "whose real name was Elena" — mirrored: the ALIAS is on the left.
  { build: (n) => new RegExp(`((?:[A-Z][A-Za-z'’-]+)(?:\\s+[A-Z][A-Za-z'’-]+){0,2})[^.!?\\n]{0,30}?\\bwhose\\s+(?:real\\s+|true\\s+|given\\s+)?name\\s+(?:was|is)\\s+${LB}${n}${RB}`),
    why: "the text gives their real name" },
];

export function attestedAliases(text: string, name: string): Array<{ alias: string; why: string }> {
  const out: Array<{ alias: string; why: string }> = [];
  const n = esc(name);
  for (const { build, why } of ATTESTED_PATTERNS) {
    const re = new RegExp(build(n).source, "g");
    for (const m of text.matchAll(re)) {
      const alias = collapse(m[1] ?? "");
      if (alias) out.push({ alias, why });
    }
  }
  return out;
}

// ── layer 3 · vocatives (the speech-act layer) ─────────────────────────────

/**
 * A capitalised token set off by punctuation INSIDE a quotation.
 *
 * ★ THE INVERSION IS THE VALUE, and speech-detect already documents it: a name
 *   in the vocative slot names the person being SPOKEN TO, never the speaker.
 *   So in a scene with two people it identifies its own referent — the one who
 *   is present and is not talking.
 *
 * Same strictness as speech-detect's VOCATIVE_RE: punctuation-bounded on both
 * sides, so an ordinary object-position name never matches.
 */
const VOCATIVE_RE = /(?:^|[,;—–]\s*)([A-Z][A-Za-z'’-]{2,})\s*[,.!?…]/g;

export function vocativesIn(quote: string): string[] {
  const out: string[] = [];
  VOCATIVE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VOCATIVE_RE.exec(quote)) !== null) out.push(m[1]);
  return out;
}

/** Quoted spans of a paragraph. Straight and curly, double and guillemet. */
export function quotedSpans(paragraph: string): string[] {
  const out: string[] = [];
  const re = /[""“«]([^""”»]{2,400})[""”»]/g;
  for (const m of paragraph.matchAll(re)) out.push(m[1]);
  return out;
}

// ── layer 4 input · complementary distribution ─────────────────────────────

/**
 * How alias-like is the way these two names are DISTRIBUTED across paragraphs?
 *
 * ★★ THIS IS THE ONLY SIGNAL LEFT once the strings share nothing and the text
 *    never declares the link. Two names for one person are in complementary
 *    distribution: the book uses one or the other, rarely both in one breath.
 *    Two different people who matter to each other co-occur constantly.
 *
 * Returns 0..1, and it is a SHORTLIST RANKER, not a decision. Even a perfect 1
 * only means "these two never share a paragraph", which is equally true of two
 * characters who never meet — which is exactly why this hands off to a model
 * that reads the passage, and why the writer still ticks the box.
 */
export function complementaryScore(
  paragraphs: readonly ScanParagraph[],
  character: string,
  aliasHits: readonly boolean[],
): number {
  let onlyA = 0, onlyB = 0, both = 0;
  for (let i = 0; i < paragraphs.length; i += 1) {
    const a = paragraphs[i].present.has(character);
    const b = aliasHits[i];
    if (a && b) both += 1;
    else if (a) onlyA += 1;
    else if (b) onlyB += 1;
  }
  // Both names must actually be used, or "never co-occur" is vacuous — the
  // empty-set trap that has read green in this repo more than once.
  if (onlyA + both < 3 || onlyB + both < 2) return 0;
  return (onlyA + onlyB) / (onlyA + onlyB + both * 4);
}

// ── the scan ───────────────────────────────────────────────────────────────

export interface AliasScanInput {
  characters: readonly { name: string; aliases?: readonly string[] }[];
  chapters: readonly { content: string }[];
  /** Extra candidate forms from the caller (the entity scan's own output). */
  extraCandidates?: readonly string[];
  /** Speaker attribution costs the most; skip it and lose only the vocatives. */
  withSpeech?: boolean;
  onProgress?: (done: number, total: number, label: string) => void;
}

/** Build the paragraph model once — every layer reads it. */
function buildParagraphs(
  input: AliasScanInput,
  canonicalNames: readonly string[],
  aliasOf: ReadonlyMap<string, string>,
): ScanParagraph[] {
  const out: ScanParagraph[] = [];
  const namePattern = [...aliasOf.keys()]
    .sort((a, b) => b.length - a.length)
    .map(esc)
    .join("|");
  const nameRe = namePattern ? new RegExp(`${LB}(${namePattern})${RB}`, "gi") : null;

  for (const chapter of input.chapters) {
    const paragraphs = splitParagraphs(chapter.content);
    let speech: ReturnType<typeof detectSpeechInChapter> | null = null;
    if (input.withSpeech !== false && paragraphs.length > 0) {
      try {
        speech = detectSpeechInChapter(paragraphs, [...canonicalNames]);
      } catch {
        // Attribution is a bonus layer; a failure here must not lose the scan.
        speech = null;
      }
    }
    paragraphs.forEach((text, i) => {
      const present = new Set<string>();
      if (nameRe) {
        nameRe.lastIndex = 0;
        for (const m of text.matchAll(nameRe)) {
          const canon = aliasOf.get(m[1].toLowerCase());
          if (canon) present.add(canon);
        }
      }
      const speakers = new Set<string>();
      for (const seg of speech?.[i]?.segments ?? []) {
        if (seg.type === "speech" && seg.speaker) {
          speakers.add(aliasOf.get(seg.speaker.toLowerCase()) ?? seg.speaker);
        }
      }
      out.push({ text, present, speakers, quotes: quotedSpans(text) });
    });
  }
  return out;
}

export function scanAliases(input: AliasScanInput): AliasScanResult {
  const text = input.chapters.map((c) => c.content).join("\n\n");
  // Computed once: every `offer` consults it, and it is a full pass over the book.
  const narration = narrationOnly(text);
  const rejected: AliasScanRejection[] = [];
  const rawCandidates: AliasCandidate[] = [];

  const cast = input.characters
    .map((c) => ({ raw: c.name.trim(), parts: splitName(c.name), aliases: c.aliases ?? [] }))
    .filter((c) => c.raw.length >= 2);
  if (cast.length === 0 || text.trim().length < 120) {
    return {
      candidates: [], rejected, unresolved: [],
      stats: { paragraphs: 0, formsHarvested: 0, capped: 0 },
    };
  }

  /** Every surface form already spoken for, and by whom. */
  const aliasOf = new Map<string, string>();
  for (const c of cast) {
    aliasOf.set(c.raw.toLowerCase(), c.raw);
    for (const a of c.aliases) if (a.trim()) aliasOf.set(a.trim().toLowerCase(), c.raw);
  }
  const knownForms = new Set(aliasOf.keys());
  const castNames = new Set(cast.map((c) => c.raw.toLowerCase()));

  input.onProgress?.(0, 4, "Reading the manuscript");
  const paragraphs = buildParagraphs(input, cast.map((c) => c.raw), aliasOf);

  /** Record a candidate after the shared vetoes. */
  const offer = (
    c: (typeof cast)[number],
    aliasRaw: string,
    source: AliasScanSource,
    confidence: number,
    why: string,
    attested: boolean,
  ) => {
    const alias = collapse(aliasRaw);
    const key = alias.toLowerCase();
    if (alias.length < 2) return;
    if (key === c.raw.toLowerCase()) return;
    if (aliasOf.get(key) === c.raw) {
      rejected.push({ character: c.raw, alias, veto: "already-known" });
      return;
    }
    // A title on its own is never anybody's alias — "Mrs" reached the top-30
    // extracted cast in nine of sixteen books before world-data guarded it.
    if (TITLE_SET.has(key.replace(/\.$/, ""))) return;

    const occurrences = countOf(text, alias);
    if (occurrences < (attested ? MIN_ATTESTED : MIN_INFERRED)) {
      rejected.push({ character: c.raw, alias, veto: "too-rare" });
      return;
    }
    // The gender and family vetoes from alias-propose, applied to forms its
    // morphology could never have produced.
    const parts = splitName(alias);
    if (genderConflict(c.parts, parts)) {
      rejected.push({ character: c.raw, alias, veto: "honorific-gender" });
      return;
    }
    if (!parts.bare.includes(" ") && surnameSharedByFamily(text, parts.bare)) {
      rejected.push({ character: c.raw, alias, veto: "shared-surname" });
      return;
    }
    // ★★ AND THE CANONICAL SIDE, which is the direction that actually bites.
    //    The check above asks whether the ALIAS is a family's surname. It says
    //    nothing when the CAST ENTRY is one — and a writer who has typed
    //    "Bennet" into the panel has an entry that could be any of five people.
    //    Measured on Pride and Prejudice: that entry collected "Elizabeth
    //    Bennet", "Lydia Bennet" and "Eliza Bennet" as its own aliases, three
    //    sisters welded into one character, silently. If the book writes both a
    //    male and a female title before the entry's own name, nothing can be
    //    attached to it, because nobody can tell which family member it means.
    if (!c.parts.bare.includes(" ") && surnameSharedByFamily(text, c.parts.bare)) {
      rejected.push({ character: c.raw, alias, veto: "shared-surname" });
      return;
    }
    // ★ "X and Y" anywhere in the book is proof of two people, and it is the
    //   veto that matters most for an EPITHET: "Elena and the Ash Marshal
    //   exchanged a look" settles it instantly and no other test would.
    if (coordinated(text, c.raw, alias)) {
      rejected.push({ character: c.raw, alias, veto: "coordination" });
      return;
    }
    // ★★ THE CO-OCCURRENCE VETO, AND IT ONLY APPLIES TO A DISJOINT FORM. If the
    //    alias and the cast name share no word — "Sparrow" for Vale, "Jack" for
    //    Van Helsing — then two of them in one NARRATED sentence is two people.
    //    Measured: this is what every surviving bad vocative row had in common
    //    across four novels. It cannot be applied to overlapping forms, because
    //    "Elena Vasquez" and "Elena" share a sentence constantly and are one
    //    woman; containment is the evidence there, and co-occurrence here.
    //
    // ★★ AND AN ATTESTED ROW IS EXEMPT, because the sentence that declares the
    //    link necessarily contains both names: "It named her in full — Elena
    //    Vasquez, known as the Ash Marshal". Measured — the veto read the
    //    strongest evidence FOR a link as evidence against it and deleted the
    //    one pre-ticked row on the fixture. Same shape as the ratio test, which
    //    an attested form also skips: an author saying it outranks a statistic
    //    about how names usually behave.
    const shareAToken = parts.tokens.some((t) =>
      c.parts.tokens.some((ct) => ct.toLowerCase() === t.toLowerCase()));
    if (!attested && !shareAToken && coOccursInNarration(narration, c.raw, alias)) {
      rejected.push({ character: c.raw, alias, veto: "co-occurs" });
      return;
    }
    rawCandidates.push({
      character: c.raw,
      alias,
      kind: castNames.has(key) ? "merge" : "alias",
      source,
      confidence,
      occurrences,
      evidence: evidenceFor(text, alias),
      attested,
      why,
    });
  };

  // ── layer 2 first: what the text asserts outranks everything inferred ────
  input.onProgress?.(1, 4, "Reading declared names");
  for (const c of cast) {
    for (const { alias, why } of attestedAliases(text, c.raw)) {
      // The pattern's own capture can swallow the canonical name back ("known
      // as the Elena of Kesh"); a form containing the name it aliases is noise.
      if (alias.toLowerCase().includes(c.raw.toLowerCase())) continue;
      const veto = plausibleName(alias.split(/\s+/)[0], text, { attested: true });
      if (veto) { rejected.push({ character: c.raw, alias, veto }); continue; }
      offer(c, alias, "attested", 0.95, why, true);
    }
  }

  // ── layer 1 · adjacency ─────────────────────────────────────────────────
  input.onProgress?.(2, 4, "Absorbing neighbouring words");
  let formsHarvested = 0;
  for (const c of cast) {
    const { left, right } = absorbNeighbours(text, c.raw);
    formsHarvested += left.size + right.size;

    for (const [token, hits] of right) {
      if (hits < MIN_INFERRED) continue;
      if (hits / Math.max(1, countOf(text, token)) < MIN_ADJACENT_SHARE) {
        rejected.push({ character: c.raw, alias: token, veto: "common-word" });
        continue;
      }
      const veto = plausibleName(token, text, { alsoSeenAs: `${c.raw} ${token}` });
      if (veto) { rejected.push({ character: c.raw, alias: token, veto }); continue; }
      // The full form is near-certain: it CONTAINS the canonical name.
      offer(c, `${c.raw} ${token}`, "adjacent-right", 0.9,
        `written “${c.raw} ${token}” ${hits}×`, false);
      // The bare surname is a guess even after the family veto — the writer
      // may simply not have added the father yet. alias-propose flags the same
      // shape `uncertain` for the same reason.
      offer(c, token, "adjacent-right", 0.55,
        `the name beside “${c.raw}”`, false);
    }

    for (const [token, hits] of left) {
      if (hits < MIN_INFERRED) continue;
      const bare = token.replace(/\.$/, "").toLowerCase();
      if (TITLE_SET.has(bare)) {
        offer(c, `${token} ${c.raw}`, "titled", 0.85,
          `addressed as “${token} ${c.raw}” ${hits}×`, false);
        continue;
      }
      if (hits / Math.max(1, countOf(text, token)) < MIN_ADJACENT_SHARE) {
        rejected.push({ character: c.raw, alias: token, veto: "common-word" });
        continue;
      }
      const veto = plausibleName(token, text, { alsoSeenAs: `${token} ${c.raw}` });
      if (veto) { rejected.push({ character: c.raw, alias: token, veto }); continue; }
      offer(c, `${token} ${c.raw}`, "adjacent-left", 0.9,
        `written “${token} ${c.raw}” ${hits}×`, false);
      offer(c, token, "adjacent-left", 0.55,
        `the name before “${c.raw}”`, false);
    }
  }

  // ── layer 3 · vocatives ─────────────────────────────────────────────────
  input.onProgress?.(3, 4, "Listening for spoken names");
  const vocativeAmbiguous = new Map<string, { count: number; snippets: string[]; speakers: Set<string>; candidates: Set<string> }>();
  const vocativeCounts = new Map<string, Map<string, number>>();

  paragraphs.forEach((para, i) => {
    for (const quote of para.quotes) {
      for (const token of vocativesIn(quote)) {
        const key = token.toLowerCase();
        if (knownForms.has(key)) continue;          // already somebody's name
        if (plausibleName(token, text, { positionProven: true })) continue;

        // Who is in this scene, minus whoever is doing the talking? A vocative
        // names the ADDRESSEE, so the speaker is disqualified by construction.
        const here = new Set<string>();
        for (let j = Math.max(0, i - PRESENCE_WINDOW); j <= Math.min(paragraphs.length - 1, i + PRESENCE_WINDOW); j += 1) {
          for (const n of paragraphs[j].present) here.add(n);
        }
        for (const s of para.speakers) here.delete(s);

        if (here.size === 1) {
          const who = [...here][0];
          const byName = vocativeCounts.get(key) ?? new Map<string, number>();
          byName.set(who, (byName.get(who) ?? 0) + 1);
          vocativeCounts.set(key, byName);
        } else {
          // ★ RECORDED AS A REFUSAL, not just quietly forwarded. This IS the
          //   deterministic layer declining — "two people are present and not
          //   speaking, so the vocative does not resolve itself" — and a
          //   refusal that leaves no trace cannot be told apart from a form
          //   that was never harvested at all.
          for (const who of here) rejected.push({ character: who, alias: token, veto: "ambiguous" });
          const entry = vocativeAmbiguous.get(token)
            ?? { count: 0, snippets: [], speakers: new Set<string>(), candidates: new Set<string>() };
          entry.count += 1;
          for (const who of here) entry.candidates.add(who);
          // ★ CARRIED FORWARD SO THE MODEL IS NEVER OFFERED THE SPEAKER. The
          //   inversion that makes a vocative useful — it names the person
          //   spoken TO — is a fact, not a guess, and it survives the handoff
          //   only if it travels with the form. Measured: the shortlist for
          //   "Sparrow" led with the woman who says it.
          for (const s of para.speakers) entry.speakers.add(s);
          // ★ THE REPLY IS THE EVIDENCE, so the passage must contain it. A
          //   vocative paragraph on its own says "somebody called somebody
          //   Sparrow" and nothing more — asking a model to name the referent
          //   from that is a question with no answer in the prompt, which
          //   measures the harness rather than the model. The turn that
          //   follows is where a novel says who answered to it.
          if (entry.snippets.length < 2) {
            entry.snippets.push(collapse(
              [paragraphs[i - 1]?.text, para.text, paragraphs[i + 1]?.text]
                .filter(Boolean).join(" "),
            ).slice(0, 480));
          }
          vocativeAmbiguous.set(token, entry);
        }
      }
    }
  });

  // ★★ AN AMBIGUOUS INSTANCE REINFORCES AN ALREADY-UNIQUE RESOLUTION. Speech
  //    attribution is not perfect, and when it misses, a vocative that would
  //    have resolved cleanly lands in the ambiguous pile instead — so a real
  //    nickname spoken twice can be left holding one resolution and get thrown
  //    away by the floor below. If the token already resolves to exactly ONE
  //    person elsewhere, and that person is among the candidates present for
  //    this instance, the instance is theirs. This can only strengthen an
  //    existing link, never invent one: the person must already be the unique
  //    answer AND be in the room. Same anchoring rule as speech-detect's
  //    sandwich pass — propagate belief from attested points, never from
  //    guesses.
  for (const [token, entry] of vocativeAmbiguous) {
    const byName = vocativeCounts.get(token.toLowerCase());
    if (!byName || byName.size !== 1) continue;
    const [who] = [...byName.keys()];
    if (!entry.candidates.has(who)) continue;
    byName.set(who, (byName.get(who) ?? 0) + entry.count);
  }

  for (const [key, byName] of vocativeCounts) {
    const ranked = [...byName.entries()].sort((a, b) => b[1] - a[1]);
    // ★ AMBIGUITY IS A VETO, NOT A TIE-BREAK — the rule alias-propose is built
    //   on. If the same spoken name resolved to two different people across the
    //   book, it belongs to neither of them.
    if (ranked.length > 1) {
      for (const [who] of ranked) rejected.push({ character: who, alias: key, veto: "ambiguous" });
      continue;
    }
    // ★★ A NAME THAT APPEARS IN NARRATION IS ITS OWN CHARACTER, NOT SOMEBODY'S
    //    NICKNAME. This is the rule the whole vocative layer was missing, and
    //    without it the layer scored roughly 0 for 9 on five real novels:
    //    `Watson ← Jones`, `Van Helsing ← Jack`, `Scrooge ← Fred`, `Daisy ←
    //    Ewing`. Every one of those is a real person the narrator writes about
    //    — Athelney Jones, Scrooge's nephew Fred — who happened to be addressed
    //    in a scene where the engine's "who is present and not speaking" guess
    //    landed on the wrong body.
    //
    //    A nickname the writer has NOT registered lives in dialogue. The moment
    //    the narrator uses a name in their own voice, that name has an
    //    independent existence and belongs in the cast as an entry, not folded
    //    into someone else's alias list. Refusing here is the conservative
    //    direction: the writer can still add them as a character.
    const narrated = countOfI(narration, key);
    if (narrated >= MIN_INFERRED) {
      rejected.push({ character: ranked[0][0], alias: key, veto: "co-occurs" });
      continue;
    }
    const [who, hits] = ranked[0];
    // ★★ ONCE IS A COINCIDENCE — the rule adjacency already lives by, applied
    //    to the RIGHT counter. `offer` gates on how often the word occurs in
    //    the book, which for an interjection is often. Measured: every bad
    //    vocative row across four novels said "spoken to X 1×" — `Watson ←
    //    Hullo`, `Gatsby ← Yeah`, `Wilson ← Listen`, `Don ← Ah-h-h`. One
    //    resolution cannot be told apart from an interjection landing beside
    //    whoever happened to be in the room; a real nickname is used again.
    if (hits < MIN_INFERRED) {
      rejected.push({ character: who, alias: key, veto: "too-rare" });
      continue;
    }
    const c = cast.find((x) => x.raw === who);
    if (!c) continue;
    // Restore the surface casing from the manuscript.
    const surface = new RegExp(`${LB}(${esc(key)})${RB}`, "i").exec(text)?.[1] ?? key;
    offer(c, surface, "vocative", 0.6,
      `spoken to ${who} ${hits}×`, false);
  }

  // ── one row per pair ────────────────────────────────────────────────────
  const byPair = new Map<string, AliasCandidate>();
  for (const cand of rawCandidates) {
    const key = `${cand.character.toLowerCase()}|${cand.alias.toLowerCase()}`;
    const prior = byPair.get(key);
    // Attested beats inferred; within a class, the higher confidence wins.
    if (!prior
      || (cand.attested && !prior.attested)
      || (cand.attested === prior.attested && cand.confidence > prior.confidence)) {
      byPair.set(key, cand);
    }
  }

  // ── morphology, from alias-propose, over the forms this scan harvested ──
  //
  // Its candidate list has always been the weak link: autoExtractEntities only
  // yields forms that stand alone 3+ times. Feeding it what adjacency absorbed
  // lets its rules fire on surnames that never appear by themselves.
  const harvested = [...new Set([
    ...[...byPair.values()].map((c) => c.alias),
    ...(input.extraCandidates ?? []),
  ])];
  let morph: AliasProposalResult = { proposals: [], rejected: [] };
  try {
    morph = proposeAliases(input.characters, harvested, text);
  } catch {
    morph = { proposals: [], rejected: [] };
  }
  for (const p of morph.proposals) {
    const key = `${p.character.toLowerCase()}|${p.alias.toLowerCase()}`;
    const prior = byPair.get(key);
    // A morphological rule EXPLAINS a harvested form, so it upgrades the row's
    // wording and confidence rather than adding a second row for one decision.
    if (prior) {
      byPair.set(key, {
        ...prior,
        kind: p.kind,
        confidence: Math.max(prior.confidence, p.confidence),
        why: prior.attested ? prior.why : `${MORPH_WHY[p.rule]} · ${prior.why}`,
      });
    } else {
      byPair.set(key, {
        character: p.character, alias: p.alias, kind: p.kind, source: "morphology",
        confidence: p.confidence, occurrences: p.occurrences, evidence: p.evidence,
        attested: false, why: MORPH_WHY[p.rule],
      });
    }
  }
  for (const r of morph.rejected) {
    if (r.veto === "too-rare" || r.veto === "ambiguous" || r.veto === "coordination"
      || r.veto === "shared-surname" || r.veto === "honorific-gender") {
      rejected.push({ character: r.character, alias: r.alias, veto: r.veto });
    }
  }

  // ── ambiguity across the WHOLE output, morphology included ──────────────
  //
  // ★★ RE-CHECKED LAST, AND "LAST" MEANS AFTER THE MORPHOLOGY MERGE. This pass
  //    used to run on the harvest, before alias-propose contributed — and
  //    alias-propose adds rows nobody re-examined. Measured on the Sherlock
  //    corpus with a fragmented cast holding both "Holmes" and "Sherlock
  //    Holmes": adjacency produced `Holmes ← Sherlock`, morphology then added
  //    `Sherlock Holmes ← Sherlock`, and BOTH shipped — one name offered as two
  //    different people's alias, which is the precise failure this check
  //    exists to prevent. A veto that runs before the last producer is not a
  //    veto. Found only by running it on a real book.
  //
  // ★ EXCEPT WHEN THE ALIAS BEGINS WITH THE NAME. "Elena Vasquez" is claimed by
  //   "Elena" and by "Vasquez" whenever the cast holds both — the fragmented
  //   cast this feature exists to repair — and dropping it would refuse the row
  //   that fixes it. ★★ ONLY THE PREFIX DIRECTION IS SAFE, and the first
  //   version of this said "contains", which is not. On Pride and Prejudice a
  //   cast entry "Bennet" collected `Elizabeth Bennet`, `Lydia Bennet` AND
  //   `Eliza Bennet` — three sisters folding into one surname, exempted from
  //   the one check that would have caught them. A given name plus a surname
  //   can only be that person; a surname is a whole family's.
  const beginsWithName = (alias: string, character: string) =>
    new RegExp(`^${esc(character)}${RB}`, "i").test(alias.trim());
  const claimants = new Map<string, Set<string>>();
  for (const cand of byPair.values()) {
    if (beginsWithName(cand.alias, cand.character)) continue;
    const set = claimants.get(cand.alias.toLowerCase()) ?? new Set<string>();
    set.add(cand.character.toLowerCase());
    claimants.set(cand.alias.toLowerCase(), set);
  }
  for (const [key, cand] of [...byPair.entries()]) {
    if (beginsWithName(cand.alias, cand.character)) continue;
    if ((claimants.get(cand.alias.toLowerCase())?.size ?? 0) > 1) {
      rejected.push({ character: cand.character, alias: cand.alias, veto: "ambiguous" });
      byPair.delete(key);
    }
  }

  // ── cap, and SAY what the cap dropped ───────────────────────────────────
  const perCharacter = new Map<string, AliasCandidate[]>();
  for (const cand of byPair.values()) {
    const list = perCharacter.get(cand.character) ?? [];
    list.push(cand);
    perCharacter.set(cand.character, list);
  }
  let capped = 0;
  const candidates: AliasCandidate[] = [];
  for (const [, list] of perCharacter) {
    list.sort((a, b) =>
      Number(b.attested) - Number(a.attested)
      || b.confidence - a.confidence
      || b.occurrences - a.occurrences
      || a.alias.localeCompare(b.alias));
    if (list.length > MAX_PER_CHARACTER) capped += list.length - MAX_PER_CHARACTER;
    candidates.push(...list.slice(0, MAX_PER_CHARACTER));
  }
  candidates.sort((a, b) =>
    a.character.localeCompare(b.character)
    || Number(b.attested) - Number(a.attested)
    || b.confidence - a.confidence
    || a.alias.localeCompare(b.alias));

  const unresolved = collectUnresolved(text, paragraphs, cast, vocativeAmbiguous, candidates);

  const seen = new Set<string>();
  const uniqueRejections = rejected.filter((r) => {
    const key = `${r.character.toLowerCase()}|${r.alias.toLowerCase()}|${r.veto}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  input.onProgress?.(4, 4, "Done");
  return {
    candidates,
    rejected: uniqueRejections,
    unresolved,
    stats: { paragraphs: paragraphs.length, formsHarvested, capped },
  };
}

const MORPH_WHY: Record<AliasProposal["rule"], string> = {
  "given-name": "shares the given name",
  "family-name": "shares the family name",
  "title-stripped": "the same name with a title",
  hypocorism: "a short form of the name",
  initial: "the same name with an initial",
};

/**
 * Recurring name-shaped forms nothing above could attach, ranked against the
 * cast by distribution. This is the model layer's entire input.
 */
function collectUnresolved(
  text: string,
  paragraphs: readonly ScanParagraph[],
  cast: readonly { raw: string }[],
  vocativeAmbiguous: ReadonlyMap<string, { count: number; snippets: string[]; speakers: Set<string>; candidates: Set<string> }>,
  resolved: readonly AliasCandidate[],
): UnresolvedForm[] {
  const forms = new Map<string, { count: number; fromVocative: boolean; proposed?: string }>();

  for (const [token, entry] of vocativeAmbiguous) {
    if (entry.count >= MIN_INFERRED) forms.set(token, { count: countOfI(text, token), fromVocative: true });
  }
  // ★★ THE VOCATIVES THAT DID RESOLVE COME TOO, CARRYING THEIR ANSWER. The
  //    deterministic rule behind them — "the one person present who is not
  //    speaking" — is a guess about stage geography, and on five real novels
  //    every surviving row from it was wrong (`Van Helsing ← Jack`, `Gatsby ←
  //    Yeah`, `Daisy ← Ewing`). They are the class most worth a second opinion,
  //    and the model's job on them is REFUTATION, not discovery: the row ships
  //    unless the passage says otherwise, so an abstention costs nothing.
  for (const cand of resolved) {
    if (cand.source !== "vocative") continue;
    forms.set(cand.alias, {
      count: cand.occurrences, fromVocative: true, proposed: cand.character,
    });
  }
  // ══════════════════════════════════════════════════════════════════════
  // ★★ THE GENERIC TITLE-CASE SWEEP WAS DELETED HERE, AND DELETING IT IS THE
  //    FIX. It collected every recurring capitalised form the cast did not
  //    already own, on the theory that an epithet used alone would be among
  //    them. Measured on five real novels, here is everything it ever handed
  //    the model:
  //
  //      places        Longbourn, Netherfield, Meryton, Pemberley, London,
  //                    England, Varna, Carfax, Piccadilly, New York
  //      contractions  I’m, I’d, I’ve, I’ll
  //      other people  McCarthy, Neville, Frank, Renfield, Martha, Topper
  //
  //    Not one usable alias in five books, and each one cost an inference and
  //    a nonsense shortlist ("Longbourn → Illustration / Lizzy / Lady
  //    Catherine"). A recurring form the NARRATOR uses is a separate entity
  //    and belongs in the cast — that is the entity scan's job, not this one's.
  //
  //    What is left is the class that is actually ours: a form characters SAY
  //    and the narrator never writes. That is where the undiscovered nickname
  //    lives, it is the one class morphology provably cannot reach (Kitty ⊄
  //    Catherine), and it is a question a model can answer from a passage.
  // ══════════════════════════════════════════════════════════════════════

  const out: UnresolvedForm[] = [];
  for (const [form, { count, fromVocative, proposed }] of forms) {
    const hits = paragraphs.map((p) =>
      new RegExp(`${LB}${esc(form)}${RB}`, "i").test(p.text));
    const spoke = vocativeAmbiguous.get(form)?.speakers;
    const shortlist = cast
      .map((c) => ({ character: c.raw, complementary: complementaryScore(paragraphs, c.raw, hits) }))
      .filter((s) => s.complementary > 0)
      // Whoever used the name out loud is not who it names.
      .filter((s) => !spoke?.has(s.character))
      // ★★ THE DETERMINISTIC VETO RUNS BEFORE THE MODEL, AND ON THE SHORTLIST.
      //    "Sparrow and Kestrel went ahead" is proof of two people that a regex
      //    settles for nothing; leaving Kestrel among the options spends an
      //    inference on a question already answered and invites the one wrong
      //    answer the text has explicitly refuted. Same split as alias-review:
      //    blocking generates, the model only judges what survives.
      .filter((s) => !coordinated(text, s.character, form))
      .sort((a, b) => b.complementary - a.complementary)
      .slice(0, 3);
    // The deterministic answer must be ON the list the model chooses from, or
    // "confirm or refute" degenerates into "pick from these other people".
    if (proposed && !shortlist.some((s) => s.character === proposed)) {
      shortlist.unshift({ character: proposed, complementary: 1 });
      shortlist.length = Math.min(shortlist.length, 3);
    }
    if (shortlist.length === 0) continue;
    const snippets = vocativeAmbiguous.get(form)?.snippets?.length
      ? vocativeAmbiguous.get(form)!.snippets
      : [evidenceFor(text, form, 120)].filter(Boolean);
    if (snippets.length === 0) continue;
    out.push({ alias: form, occurrences: count, shortlist, snippets, fromVocative, proposed });
  }
  return out
    .sort((a, b) => (b.shortlist[0]?.complementary ?? 0) - (a.shortlist[0]?.complementary ?? 0)
      || b.occurrences - a.occurrences)
    .slice(0, MAX_UNRESOLVED);
}
