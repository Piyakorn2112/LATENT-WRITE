/**
 * narrative-events.ts — what actually happens in a chapter.
 *
 * Replaces the scoring half of event-detect.ts. Read this header before
 * changing anything in here; every rule below is a response to a measured
 * failure of the engine it replaces, and the measurements are recorded in
 * plans/narrative-event-engine.md.
 *
 * ─── WHY THE OLD ENGINE COULD NOT WORK ───────────────────────────────────────
 *
 * Four defects, all measured over 80 events across 30 chapters of the two
 * sample manuscripts:
 *
 * 1. THE UNIT WAS WRONG. Scores were computed per PARAGRAPH and the label was
 *    then scavenged from anywhere inside it, so the agent, the verb, the type
 *    and the label could each come from a different sentence. "The records
 *    system was imperfect" was emitted as a revelation from a paragraph whose
 *    first sentence is "She began with the obvious." An event is a CLAUSE.
 *    This module scores clauses and a label is generated from the same clause
 *    that triggered detection — the label cannot disagree with the evidence.
 *
 * 2. THE DICTIONARIES WERE MEMORISED. 170 multi-word phrases; 45% occur in
 *    Hollow Iris and not in The Root Crown, and 24% occur in NEITHER book.
 *    INTELLECTUAL_DISCOURSE matched 87% in Hollow Iris against 24% in Root
 *    Crown: it was a Hollow Iris detector, not an event detector. A third
 *    manuscript got nothing, and the engine fell through to punctuation and
 *    vocabulary-novelty noise. This module keys off VERB CLASSES instead —
 *    a closed, general class — and off the structure of the clause.
 *
 * 3. NOTHING DISTINGUISHED A HAPPENING FROM A DESCRIPTION. 48.8% of the old
 *    engine's anchors were backstory (past perfect), habit ("would", "always"),
 *    hypothetical (modal), bare copula, or had no agent at all. Literary prose
 *    spends most of its words in exactly those moods. The realis test below is
 *    the single largest source of precision here.
 *
 * 4. CONFIDENCE CARRIED NO INFORMATION. `min(1, total / 2.5)` saturated: 95%
 *    of events reported exactly 1.00 and there were 3 distinct values across
 *    all 80. Scores here are calibrated WITHIN the chapter, so they spread and
 *    so a penalty is relative rather than fatal — a chapter written entirely
 *    in past perfect still surfaces its own best moments.
 *
 * ─── THE INSIGHT THAT SHAPES THE DESIGN ──────────────────────────────────────
 *
 * In the gold annotations, most events are ATTRIBUTED DIALOGUE ACTS: someone
 * tells, admits, refuses, agrees. "Tessa reveals Brennan knew Mira doesn't
 * age" is a speaker plus a speech act plus its content — it is not the surface
 * subject-verb-object of the quoted sentence.
 *
 * Speaker attribution is this app's strongest signal (speech-detect runs at
 * ~96% in high mode) and the old event engine used it only as a flat +0.2
 * bonus for "contains a quotation mark". So this module has two channels:
 *
 *   NARRATION — a realis clause: agent + change-of-state verb + object
 *   DIALOGUE  — an attributed utterance whose act has consequences
 *
 * Both produce the same (agent, act, object) triple, which is what makes a
 * label fit the timeline's real budget: ~28 characters. Short by construction
 * rather than truncated after the fact.
 */

import type { WorldData } from "../types";
import { splitSentences, type Sentence } from "./prose-segments";
import type { ChapterParaResult } from "./speech-detect";
import { buildEntityPattern } from "./world-data";

// ─── Public shape ─────────────────────────────────────────────────────────────

/** The taxonomy the gold set is annotated against. `unclassified` is deliberate:
 *  the old engine defaulted unmatched clauses to "confrontation", which is why
 *  36.3% of its output was typed that way. Showing no type beats showing a
 *  wrong one. */
export type NarrativeEventType =
  | "decision"
  | "revelation"
  | "confrontation"
  | "action"
  | "arrival"
  | "departure"
  | "shift"
  | "state-change"
  | "unclassified";

/** The six types the timeline's colour map and stored graph entries already
 *  use. Kept so this engine can drop in without a data migration. */
export type LegacyEventType =
  | "climax"
  | "transition"
  | "introduction"
  | "confrontation"
  | "revelation"
  | "scene-break";

export interface NarrativeEvent {
  /** Generated from the triggering clause. Built short (≤ LABEL_BUDGET). */
  label: string;
  type: NarrativeEventType;
  /** Same event expressed in the legacy six, for the existing UI. */
  legacyType: LegacyEventType;
  /** 0-based paragraph. The gold set and the editor both anchor on this. */
  paragraphIndex: number;
  /** 0-based sentence within that paragraph. */
  sentenceIndex: number;
  /** Offset of the clause within the paragraph, for select-and-scroll. */
  offsetInParagraph: number;
  /** paragraphIndex / (paragraphCount - 1). Retained for the stored graph. */
  tensionPosition: number;
  /** Calibrated within this chapter. Spreads across (0,1); comparable. */
  confidence: number;
  /** `major` = a chapter summary would mention it. */
  salience: "major" | "minor";
  /** The triggering clause, verbatim. The UI can finally show its source. */
  sentence: string;
  /** Resolved actor, when one was found. */
  agent?: string;
  channel: "dialogue" | "narration";
  /** Which signals fired, for the diagnostics panel and for debugging a
   *  regression without re-deriving the score by hand. */
  why: string[];
}

export interface DetectOptions {
  /** Names from world data plus detected speakers. Drives agent resolution. */
  knownNames?: string[];
  worldData?: WorldData;
  /** Per-paragraph tension, 0..1, same length as `paragraphs`. A local RISE
   *  is evidence; a high plateau is not, which is why the derivative is used. */
  tensionByParagraph?: number[];
  /** Hard cap on returned events. The timeline has room for about four. */
  maxEvents?: number;
  /** Override the calibrated-confidence floor. Exposed so the operating point
   *  can be SWEPT by the suite instead of guessed; see CONFIDENCE_FLOOR. */
  confidenceFloor?: number;
}

/** The timeline gives an event label 20–36 characters depending on whether a
 *  detail tag sits beside it (measured off TimelineGraph/TimelineGraphFull).
 *  Build to the lower bound so nothing is ever cut mid-word. */
const LABEL_BUDGET = 28;

// ─── Verb classes ─────────────────────────────────────────────────────────────
// Verbs are a closed class and generalise across manuscripts; multi-word idioms
// do not, which is exactly how the previous dictionaries ended up memorising
// two books. Each entry maps a lemma-ish surface form to the event type it
// evidences. Inflections are handled by `verbLookup`, not by listing them.

const CHANGE_VERBS: Record<string, NarrativeEventType> = {
  // Commitment — someone binds themselves to a course of action.
  decide: "decision", choose: "decision", agree: "decision", accept: "decision",
  refuse: "decision", decline: "decision", resolve: "decision", commit: "decision",
  promise: "decision", swear: "decision", vow: "decision", consent: "decision",
  volunteer: "decision", sign: "decision", quit: "decision", resign: "decision",

  // Transfer of knowledge — the speaker's side.
  tell: "revelation", reveal: "revelation", admit: "revelation", confess: "revelation",
  disclose: "revelation", announce: "revelation", explain: "revelation", warn: "revelation",
  confirm: "revelation", concede: "revelation", acknowledge: "revelation",

  // Acquisition of knowledge — the hearer's side.
  realize: "revelation", realise: "revelation", understand: "revelation",
  discover: "revelation", learn: "revelation", recognize: "revelation",
  recognise: "revelation", remember: "revelation",

  // Open opposition.
  argue: "confrontation", accuse: "confrontation", challenge: "confrontation",
  object: "confrontation", deny: "confrontation", protest: "confrontation",
  confront: "confrontation", threaten: "confrontation", demand: "confrontation",
  insist: "confrontation", contradict: "confrontation", reject: "confrontation",
  shout: "confrontation", interrupt: "confrontation",

  // Acts with consequences.
  take: "action", give: "action", break: "action", strike: "action", hit: "action",
  kill: "action", destroy: "action", burn: "action", build: "action", send: "action",
  write: "action", open: "action", close: "action", lock: "action", steal: "action",
  hide: "action", show: "action", hand: "action", pay: "action", buy: "action",
  kiss: "action", grab: "action", push: "action", pull: "action", throw: "action",
  cut: "action", tear: "action", pour: "action", plant: "action", carry: "action",

  // Entering the situation.
  arrive: "arrival", enter: "arrival", appear: "arrival", come: "arrival",
  reach: "arrival", join: "arrival", return: "arrival",

  // Leaving it.
  leave: "departure", depart: "departure", go: "departure", exit: "departure",
  flee: "departure", abandon: "departure", withdraw: "departure",

  // Directing others — the act is the order, not its execution.
  order: "decision", command: "decision", authorize: "decision",
  authorise: "decision", approve: "decision", permit: "decision",
  forbid: "decision", cancel: "decision", halt: "decision",

  // The world itself changing.
  die: "state-change", marry: "state-change", collapse: "state-change",
  end: "state-change", begin: "state-change", start: "state-change",
  change: "state-change", become: "state-change", fail: "state-change",
  win: "state-change", lose: "state-change", vote: "state-change",
  appoint: "state-change", dismiss: "state-change", publish: "state-change",
  rise: "state-change", fall: "state-change", drop: "state-change",
  climb: "state-change", grow: "state-change", spread: "state-change",
  worsen: "state-change", improve: "state-change", recover: "state-change",
  cross: "state-change", pass: "state-change", stop: "state-change",
  disconnect: "state-change", release: "state-change", arrest: "state-change",
  install: "action", submit: "action", deliver: "action", report: "action",
  // The most general change verb in the language. Carries no content of its own,
  // which is why it is only useful alongside the specificity test on entity
  // subjects ("The fourth micro-disconnection happened at 03:14").
  happen: "state-change", occur: "state-change",
};

/** Verbs of perception and cognition. These describe a mind, not a change, and
 *  they are extremely common in this register — "looked", "watched", "felt",
 *  "thought". Admitted only as weak evidence so a chapter made entirely of
 *  them can still rank its own moments. */
const PERCEPTION_VERBS = new Set([
  "look", "watch", "see", "feel", "hear", "notice", "observe", "consider",
  "think", "wonder", "imagine", "sense", "study", "regard", "listen", "wait",
]);

/** Copulas and stative verbs. A clause whose main verb is one of these is
 *  describing a condition, and a condition is not a happening. */
const STATE_VERBS = new Set([
  "be", "is", "are", "was", "were", "been", "being", "am",
  "seem", "appear", "remain", "stay", "have", "has", "had",
  "hold", "contain", "mean", "exist", "belong", "consist", "sit", "stand", "lie",
]);

/** Irregular past → base, for forms `-ed` stripping cannot reach. Only verbs
 *  that appear in the classes above are worth listing. */
const IRREGULAR_PAST: Record<string, string> = {
  took: "take", gave: "give", broke: "break", struck: "strike", hit: "hit",
  told: "tell", knew: "know", understood: "understand", wrote: "write",
  came: "come", went: "go", left: "leave", fled: "flee", threw: "throw",
  drew: "draw", held: "hold", made: "make", said: "say", saw: "see",
  felt: "feel", heard: "hear", found: "find", chose: "choose", swore: "swear",
  began: "begin", became: "become", won: "win", lost: "lose", paid: "pay",
  bought: "buy", sent: "send", cut: "cut", tore: "tear", hid: "hide",
  stole: "steal", built: "build", burnt: "burn", burned: "burn", died: "die",
  shut: "close", rose: "rise", fell: "fall", spoke: "speak", stood: "stand",
  sat: "sit", lay: "lie", read: "read", put: "put", kept: "keep", let: "let",
};

/** Speech-act verbs, for the dialogue channel. The attribution tells us WHO
 *  spoke; this tells us what the speaking DID. */
const SPEECH_ACT_VERBS: Record<string, NarrativeEventType> = {
  said: "unclassified", asked: "unclassified", replied: "unclassified",
  answered: "unclassified", added: "unclassified", murmured: "unclassified",
  whispered: "unclassified", repeated: "unclassified",
  told: "revelation", admitted: "revelation", confessed: "revelation",
  explained: "revelation", revealed: "revelation", conceded: "revelation",
  acknowledged: "revelation", confirmed: "revelation", announced: "revelation",
  warned: "revelation", offered: "revelation",
  insisted: "confrontation", argued: "confrontation", objected: "confrontation",
  snapped: "confrontation", accused: "confrontation", demanded: "confrontation",
  countered: "confrontation", protested: "confrontation", shouted: "confrontation",
  agreed: "decision", promised: "decision", refused: "decision",
  declined: "decision", swore: "decision",
};

/**
 * Words that are common nouns AND appear in the verb classes above. Left in the
 * classes because they are real verbs, but they must never be reached by the
 * forward walk unless nothing verb-shaped came first.
 *
 * This list is the fix for the single worst bug in the first version of this
 * file: "She pressed her hands against the wall" produced the event "She hands
 * against". `press` was not in the verb classes, so verbLookup returned null for
 * it, the walk continued, and "hands" matched CHANGE_VERBS.hand. Five of twenty
 * emitted events on the gold set were some variation of "<Name> hands".
 *
 * The structural fix is in `findVerb`: stop at the first VERB-SHAPED token
 * whether or not it is in a class. This set is the belt to that braces.
 */
const NOUNY_HOMOGRAPHS = new Set([
  "hand", "hands", "show", "shows", "plant", "plants", "point", "points",
  "face", "faces", "watch", "watches", "study", "studies", "end", "ends",
  "change", "changes", "start", "starts", "return", "returns", "cut", "cuts",
  "break", "breaks", "hide", "hides", "close", "lock", "locks", "pay",
  "carry", "reach", "reaches", "vote", "votes", "warn", "offer", "offers",
]);

function stripTrailingPunct(word: string): string {
  return word.replace(/^[^A-Za-z']+/, "").replace(/[^A-Za-z']+$/, "").toLowerCase();
}

/** Auxiliaries and negators that sit between a subject and its main verb. */
const PRE_VERB = new Set([
  "did", "does", "do", "not", "never", "also", "then", "just", "still", "already",
  "had", "has", "have", "was", "were", "is", "are", "been", "being", "am",
  "would", "could", "should", "might", "must", "may", "will", "shall", "can",
  "quietly", "slowly", "finally", "simply", "again", "only", "even", "almost",
  "carefully", "deliberately", "immediately", "eventually", "suddenly",
]);

/** Determiners and possessives. A candidate verb directly preceded by one of
 *  these is a noun ("her hands", "the show"). */
const DETERMINER = new Set([
  "the", "a", "an", "her", "his", "their", "its", "my", "our", "your",
  "this", "that", "these", "those", "both", "each", "every", "some", "any",
  "no", "one", "two", "three", "another", "other", "such",
]);

/** Is the token shaped like an inflected verb? Deliberately permissive: the
 *  point is to STOP the forward walk at the real verb even when that verb is
 *  outside the class lexicon, so that an unknown verb yields `unclassified`
 *  rather than letting a later noun masquerade as the predicate. */
function looksVerbal(word: string): boolean {
  const w = stripTrailingPunct(word);
  if (!w || w.length < 3) return false;
  if (IRREGULAR_PAST[w]) return true;
  if (STATE_VERBS.has(w)) return true;
  // -ed is the strongest signal in past-tense prose. -ing and -s are weaker
  // because they collide with gerunds and plural nouns, so they only count
  // when the word is not a known nouny homograph.
  if (/(?:ed|ied)$/.test(w)) return true;
  if (/ing$/.test(w) && !NOUNY_HOMOGRAPHS.has(w)) return true;
  if (/s$/.test(w) && !NOUNY_HOMOGRAPHS.has(w) && verbLookup(w) !== null) return true;
  return verbLookup(w) !== null && !NOUNY_HOMOGRAPHS.has(w);
}

interface VerbHit {
  /** Base form if it resolved to one of the classes, else null. */
  base: string | null;
  /** Surface form as written, for present-tense rendering. */
  surface: string;
  /** Index into the word array following the subject. */
  at: number;
}

/**
 * The first finite verb after the subject.
 *
 * Walks past auxiliaries, negators and adverbs, then STOPS at the first
 * verb-shaped token. Stopping is the whole point: if that token is not a
 * change-of-state verb, the clause is not evidence of an event, and the caller
 * must be able to see that rather than being handed a homograph from four words
 * later.
 */
function findVerb(words: string[]): VerbHit | null {
  for (let i = 0; i < Math.min(words.length, 7); i++) {
    const raw = words[i];
    const w = stripTrailingPunct(raw);
    if (!w) continue;
    if (PRE_VERB.has(w)) continue;
    // A determiner means we have walked into a noun phrase; the verb is behind
    // us and we failed to recognise it. Give up rather than guess.
    if (DETERMINER.has(w)) return null;
    if (i > 0 && DETERMINER.has(stripTrailingPunct(words[i - 1]))) return null;
    if (!looksVerbal(raw)) {
      // A non-verbal, non-auxiliary word right after the subject usually means
      // an appositive or a prepositional phrase. Allow two before giving up.
      if (i >= 2) return null;
      continue;
    }
    const base = verbLookup(raw);
    return { base: base && !STATE_VERBS.has(base) ? base : null, surface: w, at: i };
  }
  return null;
}

/**
 * Map an inflected surface form to a base form present in the verb classes.
 * Deliberately crude: this is not a morphological analyser, it is four rules
 * plus an irregular table, checked against a closed lexicon. A wrong guess
 * simply fails to match, which costs recall and never precision.
 */
function verbLookup(raw: string): string | null {
  const w = stripTrailingPunct(raw);
  if (!w) return null;
  if (IRREGULAR_PAST[w]) return IRREGULAR_PAST[w];
  const candidates = [w];
  if (w.endsWith("ies") && w.length > 4) candidates.push(`${w.slice(0, -3)}y`);
  if (w.endsWith("es") && w.length > 3) candidates.push(w.slice(0, -2), w.slice(0, -1));
  if (w.endsWith("s") && w.length > 3) candidates.push(w.slice(0, -1));
  if (w.endsWith("ed") && w.length > 3) {
    candidates.push(w.slice(0, -2), w.slice(0, -1));
    // "refused" → "refus" → "refuse"; "stopped" → "stopp" → "stop"
    candidates.push(`${w.slice(0, -2)}e`);
    const stem = w.slice(0, -2);
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      candidates.push(stem.slice(0, -1));
    }
  }
  if (w.endsWith("ing") && w.length > 4) {
    const stem = w.slice(0, -3);
    candidates.push(stem, `${stem}e`);
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      candidates.push(stem.slice(0, -1));
    }
  }
  for (const c of candidates) {
    if (CHANGE_VERBS[c] || PERCEPTION_VERBS.has(c) || STATE_VERBS.has(c)) return c;
  }
  return null;
}

// ─── Realis: is this clause reporting something that happened? ────────────────

/** Backstory. "She had walked", "it had been decided". */
const PLUPERFECT_RE = /\b(?:had|hadn't|had not)\s+(?:\w+ly\s+)?(?:been\s+|already\s+)?[a-z]+(?:ed|en|t|ne|wn|de|me|un)\b/i;
/** Habit, not a single occurrence. "she would sit", "every night", "as she often did". */
const HABITUAL_RE = /\b(?:would|used to|always|never|often|usually|generally|each (?:time|day|night|year)|whenever|every (?:day|night|morning|year|time)|on the nights|tended to|kept \w+ing)\b/i;
/** It did not happen. "she could have", "he might go". */
const MODAL_RE = /\b(?:could|might|may|should|must|shall|ought to|would have|can|cannot|can't)\b/i;
/** A general truth, not an occurrence. "Four days is a specific duration." */
const GNOMIC_RE = /^(?:[A-Z][\w-]*\s+){0,3}(?:is|are|was|were)\s+(?:a|an|the|not|always|never)\b/;

interface MoodFlags {
  pluperfect: boolean;
  habitual: boolean;
  modal: boolean;
  gnomic: boolean;
  interrogative: boolean;
  /** Negation is NOT a rejection: "She did not answer" is a refusal, which is
   *  one of the strongest event shapes there is. It is a TYPE signal. */
  negated: boolean;
}

function moodOf(text: string): MoodFlags {
  return {
    pluperfect: PLUPERFECT_RE.test(text),
    habitual: HABITUAL_RE.test(text),
    modal: MODAL_RE.test(text),
    gnomic: GNOMIC_RE.test(text),
    interrogative: /\?/.test(text),
    negated: /\b(?:did not|didn't|does not|doesn't|do not|don't|never|refused to|would not|wouldn't)\b/i.test(text),
  };
}

// ─── Agent resolution ─────────────────────────────────────────────────────────

const SUBJECT_PRONOUNS = new Set(["she", "he", "they", "i", "we", "it"]);

interface AgentHit {
  name: string;
  /** Where the agent sits in the clause, so the verb search can start after it. */
  end: number;
  kind: "named" | "pronoun" | "entity";
}

/** Heads that are pure abstraction and make a useless label subject. */
const WEAK_HEADS = new Set([
  "thing", "things", "way", "ways", "moment", "moments", "time", "times",
  "kind", "sort", "part", "parts", "fact", "point", "sense", "idea", "reason",
  "sound", "sounds", "light", "lights", "air", "room", "day", "night", "morning",
  "silence", "quality", "presence", "weight", "surface", "space",
  "name", "names", "word", "words", "line", "lines", "side", "end", "edge",
  "door", "doors", "window", "wall", "floor", "hand", "hands", "eyes", "face",
]);

/**
 * Is this clause SPECIFIED — does it name something or count something?
 *
 * The discriminator for whether a change to the world is worth reporting. Every
 * entity-subject event in the gold set carries a proper noun, a numeral or a
 * quantity; none of the false positives did.
 *
 * ★ The proper-noun test must SKIP THE FIRST WORD. Every sentence starts with a
 * capital, so `/[A-Z][a-z]{2,}/` over the whole clause is satisfied by the
 * subject itself and the test passes unconditionally — which is how "Lights
 * returns" survived a rule written specifically to stop it.
 */
function isSpecified(text: string): boolean {
  const afterFirstWord = text.replace(/^\s*\S+\s*/, "").slice(0, 200);
  if (/\b[A-Z][a-z]{2,}\b/.test(afterFirstWord)) return true;
  if (/\d/.test(text)) return true;
  return /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|first|second|third|fourth|fifth|hundred|thousand|million|percent)\b/i.test(
    text,
  );
}

/**
 * A definite noun phrase acting as the subject: "The Axiom Spire departed…",
 * "The total affected population reached…", "one more peripheral body went dark".
 *
 * Requiring a person or a pronoun cost more recall than any other single rule in
 * the first version — five of the eleven MAJOR gold events have a non-person
 * subject, because a large part of what happens in a novel happens to
 * institutions, ships, populations and systems rather than to characters.
 *
 * The head word is taken as the label's subject, and abstractions are refused so
 * the label cannot come out as "The thing begins".
 */
function findEntitySubject(clause: string): AgentHit | null {
  const m = clause.match(
    /^\s*(?:The|A|An|One|Two|Three|Another|Each|Every|Both)\s+((?:[a-z][\w-]*\s+){0,3}?[A-Za-z][\w-]*)\b/,
  );
  if (!m) return null;
  const phrase = m[1].trim();
  const words = phrase.split(/\s+/);
  const head = stripTrailingPunct(words[words.length - 1]);
  if (!head || head.length < 3 || WEAK_HEADS.has(head)) return null;
  // A verb-shaped head means the match ran past the subject into the predicate.
  if (looksVerbal(head)) return null;
  // Keep at most two words so the label stays inside its budget: "The Axiom
  // Spire" survives, "The total affected population" becomes "population".
  const kept = words.length > 2 ? head : phrase;
  return { name: kept, end: (m.index ?? 0) + m[0].length, kind: "entity" };
}

/**
 * Find the clause's subject. A named entity beats a pronoun; a pronoun resolves
 * to the carried subject, which is the last named entity that acted. That carry
 * is what lets "She released the moment" become "Iris releases the moment"
 * rather than an unattributable fragment.
 */
function findAgent(
  clause: string,
  nameRe: RegExp | null,
  carried: string | null,
  recurringCaps: Set<string>,
): AgentHit | null {
  if (nameRe) {
    nameRe.lastIndex = 0;
    const m = nameRe.exec(clause);
    // Only treat it as the SUBJECT when it opens the clause. A name deep in an
    // object position ("she wrote to Nora") is not the actor.
    if (m && m.index <= 2) return { name: m[0], end: m.index + m[0].length, kind: "named" };
  }
  const p = clause.match(/^\s*(She|He|They|I|We|It)\b/);
  if (p) {
    const resolved = carried && SUBJECT_PRONOUNS.has(p[1].toLowerCase()) && p[1].toLowerCase() !== "it"
      ? carried
      : p[1];
    return { name: resolved, end: (p.index ?? 0) + p[0].length, kind: "pronoun" };
  }

  // ── An unlisted proper noun.
  //
  // `knownNames` comes from world data plus detected speakers, so before a
  // manuscript has been scanned the list is thin or empty — and without this
  // fallback a clause as blunt as "Mira refused the contract" was invisible,
  // because "Mira" was not yet a known name. An event engine that only works
  // after the entity scan has run is an event engine that does not work on a
  // new project.
  const cap = clause.match(/^\s*([A-Z][a-z']{2,})\b/);
  if (cap) {
    const lower = cap[1].toLowerCase();
    // It must RECUR. A character comes back; a place named once in passing does
    // not, and admitting the singletons cost real precision on the gold set
    // (57.1% -> 50.0%) for no generalisation benefit, because the things this
    // rule exists to catch are the people the chapter is about.
    const isName =
      !SENTENCE_OPENERS.has(lower) && !WEAK_HEADS.has(lower) && recurringCaps.has(lower);
    if (isName) return { name: cap[1], end: (cap.index ?? 0) + cap[0].length, kind: "named" };
  }
  return null;
}

/**
 * Capitalised words that open a sentence without being its subject. Everything
 * else that starts a clause with a capital is treated as a proper noun, which is
 * the right bet in prose: mid-paragraph, a capital that is not one of these is
 * almost always a name.
 */
const SENTENCE_OPENERS = new Set([
  "the", "a", "an", "and", "but", "or", "nor", "yet", "so", "for",
  "this", "that", "these", "those", "there", "here", "then", "now",
  "when", "while", "where", "after", "before", "because", "since", "though",
  "although", "if", "unless", "until", "as", "by", "in", "on", "at", "from",
  "with", "without", "into", "onto", "over", "under", "through", "during",
  "his", "her", "their", "its", "my", "our", "your", "one", "two", "three",
  "not", "no", "yes", "even", "still", "only", "just", "later", "outside",
  "inside", "above", "below", "beyond", "instead", "meanwhile", "afterward",
  "eventually", "finally", "somewhere", "nothing", "someone", "everyone",
  "what", "who", "how", "why", "which", "whether", "both", "each", "every",
]);

// ─── Object extraction ────────────────────────────────────────────────────────

const OBJECT_STOP = new Set([
  "the", "a", "an", "his", "her", "their", "its", "this", "that", "these", "those",
  "of", "to", "for", "with", "at", "in", "on", "from", "by", "as", "into", "and",
  "or", "but", "not", "up", "out", "down", "back", "again", "then", "very",
]);

/**
 * Words that must TERMINATE the object rather than be skipped over.
 *
 * The difference matters. OBJECT_STOP words are skipped before the head is found
 * ("closed **the** door" → "door"); these end it. Without the distinction the
 * object ran past the noun and picked up whatever followed, producing labels like
 * "Doors opens onto", "She passes building whose", "Campus comes alive around"
 * and "Nora pushes herself off" — each a real clause turned into a dangling
 * fragment by one word too many.
 */
const OBJECT_TERMINATOR = new Set([
  // Prepositions and particles that open a NEW phrase after the object.
  "onto", "over", "under", "through", "across", "around", "toward", "towards",
  "against", "beside", "behind", "beneath", "above", "below", "between",
  "within", "without", "along", "off", "past", "near", "until", "since",
  "before", "after", "during", "about", "upon", "inside", "outside",
  // Relativisers and complementisers.
  "who", "whose", "whom", "which", "where", "when", "while", "because",
  "though", "although", "unless", "whether", "than",
]);

/** Reflexives make a poor object head: "pushes herself off" says nothing. */
const REFLEXIVE = new Set([
  "herself", "himself", "themselves", "itself", "myself", "ourselves", "yourself",
]);

/**
 * The head of the clause's object, as one or two content words. Long noun phrases
 * are what produced the old engine's sentence-length labels, so this takes the
 * head and stops.
 */
function findObject(rest: string): string | null {
  const words = rest.split(/\s+/).slice(0, 8);
  const out: string[] = [];
  for (const w of words) {
    const clean = stripTrailingPunct(w);
    if (!clean) continue;
    if (OBJECT_TERMINATOR.has(clean) || REFLEXIVE.has(clean)) break;
    if (OBJECT_STOP.has(clean)) {
      if (out.length) break;
      continue;
    }
    // A verb-shaped word after the verb is a second predicate, not an object:
    // "Alternation stops slowed" came from taking one. Stop before it.
    if (looksVerbal(clean)) break;
    // ★ Keep the SOURCE casing. Comparisons above are lower-cased, but pushing
    // the lower-cased form is what turned proper nouns inside an object into
    // "Nora admits dr altai's" and "She reaches iris". A name in a label has to
    // look like a name.
    out.push(w.replace(/^[^A-Za-z'"“]+/, "").replace(/[^A-Za-z's]+$/, ""));
    if (out.length === 2) break;
  }
  const phrase = out.filter(Boolean).join(" ").trim();
  return phrase.length >= 2 ? phrase : null;
}

// ─── Present-tense rendering for the label ────────────────────────────────────

const PRESENT_IRREGULAR: Record<string, string> = {
  be: "is", have: "has", go: "goes", do: "does",
};

/** Third-person present of a base form: "refuse" → "refuses". Labels read as a
 *  present-tense report ("Tessa admits she has known"), which is how a reader
 *  narrates a plot beat and how the gold set is written. */
function toPresent(base: string): string {
  if (PRESENT_IRREGULAR[base]) return PRESENT_IRREGULAR[base];
  if (/(?:s|sh|ch|x|z|o)$/.test(base)) return `${base}es`;
  if (/[^aeiou]y$/.test(base)) return `${base.slice(0, -1)}ies`;
  return `${base}s`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Assemble a label inside the budget by dropping the least important part
 *  first (the object), rather than truncating mid-phrase. */
function buildLabel(agent: string | undefined, verb: string, object: string | null): string {
  const a = agent ? capitalize(agent) : "";
  const withObject = [a, verb, object].filter(Boolean).join(" ");
  if (withObject.length <= LABEL_BUDGET) return capitalize(withObject);
  const noObject = [a, verb].filter(Boolean).join(" ");
  if (noObject.length <= LABEL_BUDGET) return capitalize(noObject);
  // Last resort: an over-long name. Cut the name, never the verb — the verb is
  // the part that says what happened.
  const room = Math.max(3, LABEL_BUDGET - verb.length - 1);
  return capitalize(`${a.slice(0, room).trimEnd()} ${verb}`);
}

// ─── Candidate construction ───────────────────────────────────────────────────

interface Candidate {
  paragraphIndex: number;
  sentenceIndex: number;
  offsetInParagraph: number;
  sentence: string;
  channel: "dialogue" | "narration";
  agent?: string;
  agentKind?: "named" | "pronoun" | "entity";
  verbBase: string;
  type: NarrativeEventType;
  object: string | null;
  mood: MoodFlags;
  score: number;
  why: string[];
}

/** Content words, for the persistence test below. */
function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/\b[a-z]{5,}\b/g) ?? []).filter((w) => !OBJECT_STOP.has(w));
}

/**
 * Does this clause introduce vocabulary that the chapter goes on to use?
 *
 * This replaces the old engine's `salienceScore`, which rewarded RARE words.
 * Rarity peaks in a chapter's opening, where every word is new — which is
 * exactly why 13.8% of its events landed in the first 5% of the chapter, a
 * region where by construction nothing has happened yet. Recurrence is the
 * better signal: a term that comes back is a thing the story now contains;
 * a term that never returns was a flourish.
 */
function persistence(words: string[], forwardCounts: Map<string, number>): number {
  if (!words.length) return 0;
  let recurring = 0;
  for (const w of words) if ((forwardCounts.get(w) ?? 0) > 0) recurring++;
  return recurring / words.length;
}

export function detectNarrativeEvents(
  paragraphs: string[],
  speechResults: ChapterParaResult[],
  options: DetectOptions = {},
): NarrativeEvent[] {
  const paraCount = paragraphs.length;
  if (paraCount < 2) return [];

  const names = (options.knownNames ?? []).filter((n) => n && n.length >= 2);
  const pattern = buildEntityPattern(names);
  const nameRe = pattern ? new RegExp(pattern, "g") : null;

  // Forward word counts per paragraph index, for the persistence test. Built
  // once as a suffix structure: counts[i] = words appearing in paragraphs > i.
  const paraWords = paragraphs.map((p) => new Set(contentWords(p)));
  const suffixCounts: Array<Map<string, number>> = new Array(paraCount);
  let running = new Map<string, number>();
  for (let i = paraCount - 1; i >= 0; i--) {
    suffixCounts[i] = new Map(running);
    for (const w of paraWords[i]) running.set(w, (running.get(w) ?? 0) + 1);
  }

  // Capitalised words that occur more than once in the chapter. Used to tell a
  // character from a proper noun mentioned in passing, so the engine can find an
  // agent before world data exists without inventing one.
  const capCounts = new Map<string, number>();
  for (const p of paragraphs) {
    for (const m of p.matchAll(/(?<![.!?]\s)(?<!^)\b([A-Z][a-z']{2,})\b/g)) {
      const k = m[1].toLowerCase();
      capCounts.set(k, (capCounts.get(k) ?? 0) + 1);
    }
  }
  const recurringCaps = new Set([...capCounts].filter(([, c]) => c >= 2).map(([w]) => w));

  const tension = options.tensionByParagraph;
  const candidates: Candidate[] = [];
  let carriedSubject: string | null = null;

  for (let pi = 0; pi < paraCount; pi++) {
    const paraText = paragraphs[pi];
    const sentences: Sentence[] = splitSentences(paraText);
    const segments = speechResults[pi]?.segments ?? [];

    for (let si = 0; si < sentences.length; si++) {
      const sent = sentences[si];
      const text = sent.text;
      if (text.length < 12) continue;

      // Which speech segment, if any, covers this sentence? `type === "speech"`
      // matters: speech-detect separates real dialogue from embedded/reported
      // quotes, and only real dialogue carries a speech act.
      const seg = segments.find(
        (s) => s.type === "speech" && s.start < sent.end && s.end > sent.start,
      );

      const mood = moodOf(text);
      // Annotated explicitly: both branches return `Candidate | null`, and
      // without the annotation TypeScript follows Candidate → dialogueCandidate
      // → Candidate and reports a circular inference (TS7022).
      const cand: Candidate | null = seg
        ? dialogueCandidate(text, sent, pi, si, seg, mood)
        : narrationCandidate(text, sent, pi, si, nameRe, carriedSubject, mood, recurringCaps);

      if (!cand) continue;

      if (cand.agent && cand.agentKind === "named") carriedSubject = cand.agent;

      // ── Scoring. Every term is a general property of the clause; none of
      //    them consults a phrase lifted from a manuscript.
      const why: string[] = [];
      let score = 1;

      if (cand.type !== "unclassified") { score += 1.1; why.push(`verb:${cand.type}`); }
      if (cand.agentKind === "named")   { score += 0.5; why.push("named-agent"); }
      else if (cand.agentKind === "entity") { score += 0.35; why.push("entity-subject"); }
      else if (cand.agent)              { score += 0.2; why.push("pronoun-agent"); }
      if (cand.object)                  { score += 0.3; why.push("transitive"); }
      if (cand.channel === "dialogue")  { score += 0.4; why.push("dialogue-act"); }
      if (mood.negated)                 { score += 0.3; why.push("refusal"); }

      // The realis penalties. Subtractive rather than fatal so a wholly
      // retrospective chapter still ranks its own best clauses (the
      // calibration below is relative).
      if (mood.pluperfect) { score -= 1.3; why.push("-pluperfect"); }
      if (mood.habitual)   { score -= 1.1; why.push("-habitual"); }
      if (mood.modal)      { score -= 0.9; why.push("-modal"); }
      if (mood.gnomic)     { score -= 0.8; why.push("-general-truth"); }
      // A question rarely IS the event; the answer is.
      if (mood.interrogative && cand.channel === "dialogue") { score -= 0.4; why.push("-question"); }

      const persist = persistence(contentWords(text), suffixCounts[pi]);
      if (persist > 0.34) { score += 0.45; why.push("consequential"); }
      else if (persist < 0.08) { score -= 0.25; why.push("-no-echo"); }

      // A local RISE in tension, not a high level. A plateau says the chapter
      // is tense; a rise says something just happened.
      if (tension && pi > 0) {
        const delta = (tension[pi] ?? 0) - (tension[pi - 1] ?? 0);
        if (delta >= 0.25) { score += 0.4; why.push("tension-rise"); }
      }

      // The first 4% and last 2% of a chapter are where the old engine's false
      // positives concentrated: an opening has no prior state to change, and a
      // closing cadence ("The apartment was quiet.") trips loss vocabulary.
      const pos = pi / Math.max(1, paraCount - 1);
      if (pos < 0.04) { score -= 0.6; why.push("-chapter-open"); }
      if (pos > 0.98) { score -= 0.3; why.push("-chapter-close"); }

      candidates.push({ ...cand, score, why });
    }
  }

  if (!candidates.length) return [];
  // The ENGINE must not enforce the timeline's chip budget. The gold set has a
  // chapter with nine events and a chapter with two; capping the engine at four
  // put a hard ceiling of 44% on recall for the eventful one. Return everything
  // that clears the confidence floor, ranked, and let each surface slice what it
  // has room for.
  const cap = options.maxEvents ?? Math.max(3, Math.min(10, Math.ceil(paraCount / 6)));
  return selectEvents(candidates, paraCount, cap, options.confidenceFloor ?? CONFIDENCE_FLOOR);
}

function narrationCandidate(
  text: string,
  sent: Sentence,
  pi: number,
  si: number,
  nameRe: RegExp | null,
  carried: string | null,
  mood: MoodFlags,
  recurringCaps: Set<string>,
): Candidate | null {
  // A named character or pronoun first; failing that, a definite noun phrase.
  const agent = findAgent(text, nameRe, carried, recurringCaps) ?? findEntitySubject(text);
  if (!agent) return null;

  const after = text.slice(agent.end);
  const words = after.split(/\s+/).filter(Boolean);

  const verb = findVerb(words);
  if (!verb) return null;

  // An unrecognised verb is not evidence of an event. Emitting it as
  // `unclassified` was how "She thinks about hands" and "Helia feels" reached
  // the timeline at confidence 0.7+; those are descriptions of a mind, and a
  // chip that says one is worse than no chip.
  if (!verb.base || !CHANGE_VERBS[verb.base]) return null;

  const verbBase = verb.base;
  const type = CHANGE_VERBS[verbBase];

  // ── The entity-subject path needs a second key, or it floods.
  //
  // Opening it up recovered five major gold events and simultaneously produced
  // most of the false positives: "Lamp burns low", "Blanket goes forward",
  // "Cold comes north", "Eyes returns" — descriptive sentences about objects,
  // which this register is made of.
  //
  // What separates the real ones is that they are SPECIFIED. Every entity-subject
  // event in the gold set names something or counts something:
  //   "The Axiom Spire departed Crownfall's orbit"        proper noun
  //   "The total affected population reached seventy-eight thousand"  quantity
  //   "The Crownfall restoration operations began on Day 64"          both
  //   "The fourth micro-disconnection happened at 03:14."             ordinal
  // while none of the false ones do. A change to the world that matters arrives
  // with a name or a number attached; a mood does not.
  if (agent.kind === "entity") {
    if (type !== "state-change" && type !== "action" && type !== "departure" && type !== "arrival") {
      return null;
    }
    if (!isSpecified(text)) return null;
  }

  // ── Motion is not an event unless it changes the situation.
  //
  // "She leaves room", "She goes lecture", "She reaches transit bay", "Campus
  // comes alive" — a chapter about walking to a lecture generates a dozen of
  // these, and none of them is a thing that happened. Arrival and departure earn
  // a chip only when the clause says WHERE or WHO, which is the difference
  // between crossing a room and crossing a border.
  if ((type === "arrival" || type === "departure") && !isSpecified(text)) return null;

  // ── A physical act is not an event unless it acts on something.
  //
  // `action` is the widest class here (take, give, open, close, write, carry,
  // hand…) and the out-of-distribution audit caught it flooding: on the HELD-OUT
  // manuscript it was 58.9% of all events, a worse single-type dominance than
  // the engine this replaces, and it drove yield to 7.0 events per chapter.
  // A domestic rural novel is made of people opening doors and pouring drinks.
  //
  // The discriminator is the same one the entity path uses: an act that matters
  // names something. "Helia writes audit report" survives; "Mira opens hand"
  // does not, because a body part is not a thing acted upon in any sense a
  // reader would report.
  const object = findObject(words.slice(verb.at + 1).join(" "));

  if (type === "action") {
    const head = object?.split(/\s+/).pop()?.toLowerCase() ?? "";
    const hasRealObject = head.length > 0 && !WEAK_HEADS.has(head);
    if (!hasRealObject && !isSpecified(text)) return null;
  }

  return {
    paragraphIndex: pi,
    sentenceIndex: si,
    offsetInParagraph: sent.start,
    sentence: text,
    channel: "narration",
    agent: agent.name,
    agentKind: agent.kind,
    verbBase,
    type,
    object,
    mood,
    score: 0,
    why: [],
  };
}

function dialogueCandidate(
  text: string,
  sent: Sentence,
  pi: number,
  si: number,
  seg: { speaker?: string; confidence: number },
  mood: MoodFlags,
): Candidate | null {
  // An utterance with no attributed speaker cannot become "<who> admits <what>",
  // and a guessed speaker in a label is worse than no event. 0.5 is below
  // speech-detect's own display threshold (0.65) on purpose: the label only
  // needs the name to be probably right, and dropping to 0.65 costs real recall
  // in bare-alternation dialogue, which this corpus is full of.
  if (!seg.speaker || seg.confidence < 0.5) return null;

  // The speech act comes from the attribution verb in the surrounding prose
  // when there is one, and from the utterance's own shape when there is not.
  let act: NarrativeEventType = "unclassified";
  let verbSurface = "says";
  const tag = text.match(
    /["”']\s*,?\s*(?:[A-Z][\w']*\s+)?(said|asked|replied|answered|added|told|admitted|confessed|explained|revealed|conceded|acknowledged|confirmed|announced|warned|offered|insisted|argued|objected|snapped|accused|demanded|countered|protested|shouted|agreed|promised|refused|declined|swore|murmured|whispered|repeated)\b/i,
  ) ?? text.match(
    /\b(said|asked|replied|answered|added|told|admitted|confessed|explained|revealed|conceded|acknowledged|confirmed|announced|warned|offered|insisted|argued|objected|snapped|accused|demanded|countered|protested|shouted|agreed|promised|refused|declined|swore|murmured|whispered|repeated)\b/i,
  );
  if (tag) {
    const lower = tag[1].toLowerCase();
    act = SPEECH_ACT_VERBS[lower] ?? "unclassified";
    verbSurface = lower === "said" || lower === "murmured" || lower === "whispered"
      ? "says"
      : toPresent(verbLookup(lower) ?? lower.replace(/ed$/, ""));
  }

  // A colourless "said" still carries an act when the utterance itself is a
  // refusal, an admission or a commitment. This is where the gold set's events
  // actually live, so the shape of the utterance has to be read.
  //
  // These patterns are ANCHORED to the start of the utterance. Unanchored, they
  // fired on any dialogue containing "I noticed" anywhere in it and produced the
  // three highest-confidence false positives on the gold set ("Edis admits
  // absent i" at 0.90). A speech act is what the utterance opens by doing.
  const inner = (text.match(/["“]([^"”]{4,})["”]/)?.[1] ?? text).trim();
  if (act === "unclassified") {
    // The optional "I said" / "I told you" frame matters: the gold event at
    // root-crown 16 ¶27 is the utterance "I said I noticed when you were
    // twenty-four." An anchor that does not allow the frame misses it.
    if (/^(?:I (?:said|told you)[,:]?\s+)?I\s+(?:know|knew|noticed|saw|realised|realized|understood|remember|remembered)\b/i.test(inner)) {
      act = "revelation"; verbSurface = "admits";
    } else if (/^(?:You|He|She|They)\s+(?:knew|lied|promised)\b/i.test(inner)) {
      act = "confrontation"; verbSurface = "accuses";
    } else if (/^(?:I\s+(?:will not|won't|refuse|am not going to|can't|cannot)\b)/i.test(inner)) {
      act = "decision"; verbSurface = "refuses";
    }
    // A bare affirmative is NOT an event. "Yes," on its own produced four
    // identical "<Name> agrees yes" chips in one chapter of the gold set, and
    // an agreement whose object cannot be recovered says nothing a reader can use.
  }

  // "says" with nothing else is not an event. Skip rather than emit a chip
  // that means "someone spoke here".
  if (act === "unclassified") return null;

  // The object is the CONTENT of the utterance, so the framing has to come off
  // first. Without this the labels read "Mira admits i said" — the frame
  // survived and the content did not.
  // Strip the frame, then any leading pronoun-plus-contraction the frame left
  // behind. Without the second pass the labels read "Iris confirms i've seen"
  // and "Nora admits something you're" — the frame was gone but its subject
  // pronoun became the object.
  const content = inner
    .replace(/^(?:I\s+(?:know|knew|noticed|saw|realised|realized|understood|remember|remembered|said|told you)|You\s+\w+|yes|no|all right|agreed|very well)\b[,.]?\s*/i, "")
    .replace(/^(?:I|you|we|he|she|they|it)\s*(?:'(?:ve|d|m|re|ll|s)|am|are|is|was|were|have|had|has|will|would)?\b\s*/i, "")
    .replace(/^(?:that|the|a|an|when|it|about|there|this)\s+/i, "")
    .trim();
  const object = findObject(content.length >= 4 ? content : inner);

  return {
    paragraphIndex: pi,
    sentenceIndex: si,
    offsetInParagraph: sent.start,
    sentence: text,
    channel: "dialogue",
    agent: seg.speaker,
    agentKind: "named",
    verbBase: verbSurface,
    type: act,
    object,
    mood,
    score: 0,
    why: [],
  };
}

// ─── Selection, calibration, labelling ────────────────────────────────────────

/**
 * The legacy six exist only so stored graph entries and the current colour map
 * keep working. The mapping follows how the gold annotators actually reached for
 * the old vocabulary, which is why `action` and `state-change` both land on
 * "transition": the old set simply has no word for "a condition of the world
 * changed", and forcing those onto "revelation" scored 33% where this scores
 * far better. Prefer `type` for anything new.
 */
const LEGACY_MAP: Record<NarrativeEventType, LegacyEventType> = {
  decision: "climax",
  revelation: "revelation",
  confrontation: "confrontation",
  action: "transition",
  arrival: "introduction",
  departure: "transition",
  shift: "transition",
  "state-change": "transition",
  unclassified: "transition",
};

/**
 * Absolute floor on the calibrated score. This is what lets a quiet chapter
 * return one event or none: the old engine took its top three clusters
 * unconditionally and so reported 2.67 events per chapter whether or not the
 * chapter contained any. The gold annotations for the two quiet chapters in
 * the set contain 2 and 2 events across 65 and 25 paragraphs.
 */
/**
 * Chosen by sweeping the gold set, not by taste. `FLOOR=x npx tsx
 * scripts/test-event-detect.ts --engine new` reproduces this table:
 *
 *   floor   emitted   precision   recall   major recall   F1    type
 *   0.28      22        54.5%      54.5%      63.6%      54.5%  50.0%
 *   0.34      21        57.1%      54.5%      63.6%      55.8%  50.0%   ← here
 *   0.40      19        57.9%      50.0%      54.5%      53.7%  54.5%
 *   0.46      16        62.5%      45.5%      54.5%      52.6%  60.0%
 *   0.52      15        66.7%      45.5%      54.5%      54.1%  60.0%
 *   0.60      13        69.2%      40.9%      45.5%      51.4%  55.6%
 *
 * Worth understanding rather than just copying: an earlier sweep, taken before
 * the object-extraction and motion-verb rules below existed, put the best point
 * at 0.55. Cleaning up the CANDIDATES moved the optimum DOWN, because the floor
 * had been doing a job that now happens at the source — it was suppressing junk
 * by suppressing everything. A threshold that has to be high is a symptom.
 *
 * 21 emitted against 22 gold is also the yield behaving: the old engine reported
 * 2.67 events per chapter whether or not the chapter had any.
 *
 * This is tuned against 22 gold events across 5 chapters, far too small a sample
 * to trust to two decimal places. Re-run the sweep whenever the gold set grows.
 *
 * The floor is also what lets a quiet chapter return one event or none. The old
 * engine took its top three clusters unconditionally and reported 2.67 events
 * per chapter whether or not the chapter contained any; the gold set's quiet
 * chapters contain 2 events across 29 and 65 paragraphs.
 */
const CONFIDENCE_FLOOR = 0.34;
/**
 * Suppression radius in PARAGRAPHS, not as a fraction of the chapter.
 *
 * A fractional radius scaled with chapter length: 0.06 of a 36-paragraph
 * chapter is 2.2 paragraphs, so it suppressed genuinely separate events sitting
 * in adjacent paragraphs. The gold set has runs at ¶6, ¶7, ¶8, ¶10 — four
 * distinct changes to the world in four consecutive paragraphs — and the
 * fractional rule could only ever report one of them.
 *
 * 0 means "one event per paragraph": the strongest clause in a paragraph wins
 * that paragraph, and neighbouring paragraphs are free to have their own.
 */
const MIN_SEPARATION_PARAGRAPHS = 0;

function selectEvents(
  candidates: Candidate[],
  paraCount: number,
  maxEvents: number,
  floor: number,
): NarrativeEvent[] {
  // Calibrate within the chapter. A z-score through a logistic gives a spread
  // that is comparable across chapters, which `min(1, total/2.5)` never was —
  // it saturated for 95% of events.
  const scores = candidates.map((c) => c.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const sd = Math.sqrt(scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length) || 1;

  const ranked = candidates
    .map((c) => ({ c, conf: 1 / (1 + Math.exp(-((c.score - mean) / sd))) }))
    .sort((a, b) => b.conf - a.conf);

  const kept: Array<{ c: Candidate; conf: number }> = [];
  for (const entry of ranked) {
    if (entry.conf < floor) continue;
    // Non-maximum suppression: the highest-scoring clause in a neighbourhood
    // wins the neighbourhood. Ranked order means the winner is already first.
    const clash = kept.some(
      (k) => Math.abs(k.c.paragraphIndex - entry.c.paragraphIndex) <= MIN_SEPARATION_PARAGRAPHS,
    );
    if (clash) continue;
    kept.push(entry);
    if (kept.length >= maxEvents) break;
  }

  // `major` is the top of the chapter's own distribution rather than a fixed
  // cut, because event density genuinely varies between chapters.
  const majorCut = kept.length ? Math.max(0.62, kept[0].conf - 0.12) : 1;

  return kept
    .map(({ c, conf }) => {
      const verbSurface = c.channel === "dialogue" ? c.verbBase : toPresent(c.verbBase);
      const label = buildLabel(c.agent, verbSurface, c.object);
      return {
        label,
        type: c.type,
        legacyType: LEGACY_MAP[c.type],
        paragraphIndex: c.paragraphIndex,
        sentenceIndex: c.sentenceIndex,
        offsetInParagraph: c.offsetInParagraph,
        tensionPosition: c.paragraphIndex / Math.max(1, paraCount - 1),
        confidence: Number(conf.toFixed(3)),
        salience: (conf >= majorCut ? "major" : "minor") as "major" | "minor",
        sentence: c.sentence,
        agent: c.agent,
        channel: c.channel,
        why: c.why,
      };
    })
    .sort((a, b) => a.tensionPosition - b.tensionPosition);
}
