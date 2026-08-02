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
  /**
   * ★ SELECTION ORDER, 0 = the chapter's strongest event.
   *
   * This array is returned in READING order, because that is how a timeline
   * has to draw it. For a long time that meant every consumer wrote
   * `events.slice(0, TIMELINE_CHIP_BUDGET)` and got "the first three events in
   * the chapter" while believing it had "the three best" — the harness even
   * documented the wrong one. Measured over the gold set, that mistake cost:
   *
   *     first 3 by position (what shipped)   36.1%  <- worse than random
   *     random 3                             42.5%
   *     top 3 by rank                        47.0%
   *
   * So: rank to CHOOSE, paragraph order to DRAW. Never re-derive the choice by
   * slicing this array.
   */
  rank: number;
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
  /** Weight of the narrative-position prior. Exposed for the DEV sweep; see
   *  POSITION_PRIOR_WEIGHT and the block that applies it. */
  positionPriorWeight?: number;
  /** Weight of the per-type reliability prior. Exposed for the DEV sweep. */
  typePriorWeight?: number;
}

/**
 * How hard "late in the chapter" counts as evidence.
 *
 * FITTED ON DEV BOOKS ONLY (see DEV_BOOKS in scripts/test-event-detect.ts), then
 * confirmed on the held-out TEST books. DEV sweep, precision@3:
 *
 *     0 -> 49.6   0.3 -> 50.8   0.6 -> 51.7   0.9 -> 49.2
 *     1.2 -> 49.6   1.6 -> 52.1
 *
 * A noisy plateau, not a peak: the spread is about 3 points and it is not
 * monotonic, so anything inside it is a coin-flip on this sample. 0.6 was taken
 * over the marginally higher 1.6 because a smaller intervention is the safer
 * one when the curve cannot tell them apart.
 *
 * HELD OUT, which is the number that counts:
 *     0    precision@3 43.5   major shown 16.7
 *     0.6  precision@3 44.6   major shown 17.7
 *
 * ★ WORTH ABOUT A POINT, and the gap to expectation is the interesting part.
 * The decile table below shows P(real) nearly TRIPLING from the first decile to
 * the last, which looks like it should be worth far more. It is not, because
 * that table is pooled ACROSS chapters while selection happens WITHIN one: a
 * prior that is monotone in position can only reorder a single chapter's own
 * candidates, and the between-chapter variance it also describes is unavailable
 * to it. A pooled distribution is an upper bound on a within-group ranker, never
 * an estimate of it. Do not re-derive this expecting the 3x.
 */
export const POSITION_PRIOR_WEIGHT = 0.6;

/**
 * Per-type reliability, centred on the DEV mean hit rate (~0.36) so the term
 * only ever REORDERS and never inflates a chapter's scores as a group. The
 * shape is fixed from the measurement recorded at the point of use; only the
 * single scale below is swept, which keeps this one fitted number rather than
 * seven and makes it far harder to overfit seven small per-type samples.
 */
const TYPE_RELIABILITY: Record<string, number> = {
  decision:      0.10,
  action:        0.08,
  "state-change": 0.045,
  departure:     0.03,
  arrival:      -0.03,
  revelation:   -0.07,
  confrontation: -0.10,
  unclassified:  0,
};

/** Scale on TYPE_RELIABILITY. Swept on DEV, confirmed held out; see the sweep
 *  recorded beside the sweep for POSITION_PRIOR_WEIGHT. */
export const TYPE_PRIOR_WEIGHT = 0;

/** The timeline gives an event label 20–36 characters depending on whether a
 *  detail tag sits beside it (measured off TimelineGraph/TimelineGraphFull).
 *  Build to the lower bound so nothing is ever cut mid-word. */
export const LABEL_BUDGET = 28;

/**
 * ★ HOW MANY CHIPS A CHAPTER ACTUALLY SHOWS. The single source of truth, and it
 * has to be, because it was previously three different numbers in three places:
 *
 *   TimelineGraphFull.tsx   MAX_EVENTS = 3   (sliced)
 *   TimelineGraph.tsx       no cap at all    (drew every event, up to 40)
 *   test-event-detect.ts    hardcoded 4      (what precision@N was measured at)
 *
 * The engine deliberately emits far more than this and lets the ranking decide
 * the order — see the cap in `detectNarrativeEvents`. But the number that
 * describes the PRODUCT is precision@(this), so the harness and both renderers
 * must agree on it or the gate is measuring a view nobody sees.
 */
export const TIMELINE_CHIP_BUDGET = 3;

/**
 * The chips a chapter shows: the best `budget` by RANK, drawn in reading order.
 *
 * Every surface that renders chips must go through this. Slicing the event
 * array directly is the bug this function exists to make impossible — the
 * array is in reading order, so a slice silently selects "earliest" and reads
 * as "best". Works on stored MajorEvent records too (pre-rank entries fall
 * back to array order, which is what they were rendered as anyway).
 */
/**
 * The rank a selector treats an event as having. Entries stored before `rank`
 * existed fall back to array order, which is what they were rendered as anyway.
 *
 * ★ ONE DEFINITION, because two halves read it. chip-picker.ts NUMBERS the
 *   candidates it offers the model with this, and `selectDisplayChips` RESOLVES
 *   the model's answer with it. A disagreement between those two would not
 *   throw: it would quietly attach one event's label to another event.
 */
export const effectiveRank = (event: { rank?: number }, index: number): number =>
  event.rank ?? index;

export function selectTimelineChips<T extends { rank?: number; tensionPosition: number }>(
  events: readonly T[],
  budget: number = TIMELINE_CHIP_BUDGET,
): T[] {
  return [...events]
    .map((e, i) => ({ e, rank: effectiveRank(e, i) }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, budget)
    .sort((a, b) => a.e.tensionPosition - b.e.tensionPosition)
    .map((x) => x.e);
}

/** Minimum an entry must expose to be a chip source. `ChapterGraphEntry`
 *  satisfies it structurally; a live analysis pass can pass its own events. */
export interface TimelineChipSource<T> {
  majorEvents: readonly T[];
  lmChips?: readonly { rank: number; label: string }[];
}

/**
 * THE ONE DISPLAY SELECTOR. Every surface that draws chips goes through this.
 *
 * With no `lmChips` it is `selectTimelineChips` — the same objects, in the same
 * order, with no copies made — so a chapter the model has not been asked about
 * renders exactly as it did before this task existed.
 *
 * With picks it resolves rank → event against the entry's own events, drawn in
 * reading order, and the picked label overrides the heuristic one for DISPLAY
 * only (the stored event is never mutated). Ranks that no longer resolve are
 * dropped, because the model may not add an event the engine did not find.
 *
 * ★ PICKS THAT RESOLVE TO NOTHING FALL BACK. A stale pick set — the events were
 *   re-ranked under it — must not blank a chapter's timeline. The LM may
 *   reorder and rename what the writer sees; it may never empty it.
 */
export function selectDisplayChips<
  T extends { label: string; rank?: number; tensionPosition: number },
>(
  source: TimelineChipSource<T> | null | undefined,
  budget: number = TIMELINE_CHIP_BUDGET,
): T[] {
  if (!source) return [];
  const events = source.majorEvents;
  const picks = source.lmChips;
  if (!picks || picks.length === 0) return selectTimelineChips(events, budget);

  const byRank = new Map<number, T>();
  events.forEach((event, index) => {
    const rank = effectiveRank(event, index);
    if (!byRank.has(rank)) byRank.set(rank, event);
  });

  const resolved: T[] = [];
  const seen = new Set<number>();
  for (const pick of picks) {
    if (resolved.length >= budget) break;
    if (seen.has(pick.rank)) continue;
    const event = byRank.get(pick.rank);
    if (!event) continue;
    seen.add(pick.rank);
    const label = typeof pick.label === "string" && pick.label.trim() !== ""
      ? pick.label
      : event.label;
    resolved.push(label === event.label ? event : { ...event, label });
  }

  if (resolved.length === 0) return selectTimelineChips(events, budget);
  return resolved.sort((a, b) => a.tensionPosition - b.tensionPosition);
}

/**
 * Reject a dialogue act whose content could not be recovered, rather than only
 * scoring it down.
 *
 * ★ MEASURED TWICE, LOSES BOTH TIMES. Default OFF.
 *
 *   45 events, 1 author    major recall 56.0% -> 44.0%
 *   67 events, 4 authors   major recall 35.9% -> 28.2%, precision 35.6% -> 34.0%
 *
 * Which settles something more useful than the flag itself. These acts ARE the
 * largest single class of false positive (six of nine on one Austen chapter were
 * an ordinary conversational turn emitted as "<Name> tells"), and yet removing
 * them loses MORE real events than false ones. So the true positives and the
 * false positives are the same shape, and the problem is not the decision to keep
 * them: it is that CONTENT EXTRACTION from dialogue is too weak to tell them
 * apart. Fix the extraction, not the threshold. The flag stays only so the claim
 * can be re-tested when the extraction improves.
 */
// `process` does not exist in the Electron renderer. Reading it unguarded threw
// `ReferenceError: process is not defined` at MODULE SCOPE, which kills the
// whole module rather than just this flag — so the timeline engine never loaded
// at all in the app. Harness-only escape hatch; in the app it is simply off.
const STRICT_DIALOGUE_CONTENT =
  typeof process !== "undefined" && process.env?.STRICT_DIALOGUE === "on";

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
  // Each of these cost a MISSED MAJOR gold event by simply not being listed.
  // All general English, none manuscript-specific: adopt/suspend/dismiss are
  // institutional, invite/receive social, round/count/record clerical.
  adopt: "decision", suspend: "decision", invite: "decision", grant: "decision",
  receive: "arrival", walk: "departure", step: "departure",
  round: "action", count: "action", measure: "action", record: "action",
  disconnect_: "state-change",
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

// ─── What an utterance DOES ───────────────────────────────────────────────────
/**
 * The act of a quoted utterance, from its own shape rather than from its tag.
 *
 * ★ THIS IS THE HIGHEST-VALUE RULE IN THE FILE, and getting it wrong cost the
 * most recall. Expanding the gold set from 5 chapters to 11 exposed it: one
 * chapter lost ALL FIVE of its events, and every one was an ordinary
 * `"…," she said` line whose act lives entirely in the content —
 *
 *     "Come see where I live."
 *     "Most residents are within the system's standard tolerance. I'm outside it."
 *     "When this building breathes, I breathe with it."
 *     "You're defending the system,"          ← a textbook accusation
 *     "I want someone to know."
 *
 * The previous version required either a coloured attribution verb (`admitted`,
 * `insisted`) or one of four hand-written openings. Literary dialogue almost
 * always tags with "said", and no realistic number of regex shapes covers what
 * people actually say. Enumerating them is the same mistake the phrase
 * dictionaries made, one level down.
 *
 * The general rule instead: a quoted utterance is an EVENT when it makes a
 * first- or second-person CLAIM — about knowledge, capability, intent or
 * identity — or when it is an imperative. That is what distinguishes speech that
 * changes something from speech that fills a scene. Contractions must be handled
 * ("You're", "I'm", "I've"), because that is how the claims are actually written.
 *
 * What is deliberately NOT an event: a bare affirmative, a question, and anything
 * too short to carry a claim. An earlier draft accepted bare "Yes" and produced
 * four identical "<Name> agrees yes" chips in a single chapter.
 */
const UTTERANCE_VERB: Partial<Record<NarrativeEventType, string>> = {
  revelation: "tells",
  confrontation: "accuses",
  decision: "commits",
};

function classifyUtterance(inner: string): NarrativeEventType {
  // ★ STRIP A LEADING QUOTE MARK, or every `^`-anchored rule below silently fails.
  //
  // Detection runs per SENTENCE. When an utterance spans several sentences, the
  // caller's `["“]([^"”]{4,})["”]` cannot find a closing quote inside the first
  // one and falls back to the raw text — so the string arriving here is
  // `“No more work to-night.` with the opening quote still attached, and `^No`
  // does not match it. Every anchored rule in this function had that exposure,
  // and the anchoring is deliberate (unanchored patterns produced the three
  // highest-confidence false positives on the gold set), so the fix belongs here
  // rather than in each pattern.
  // ★★ AND NORMALISE THE APOSTROPHE. Real books are typeset with ’ (U+2019), not
  // the ASCII '. Every contraction in every rule below — I'll, I'm, I've, don't,
  // won't, weren't — was written with the straight form and therefore silently
  // failed on the actual corpus. "or I’ll cut your throat!" did not match a rule
  // written precisely for it. This is the same bug as the leading quote above,
  // one character over, and it was invisible for the same reason: the patterns
  // look correct when read.
  const u = inner.trim()
    .replace(/^["“”'‘’\s]+/, "")
    .replace(/[’‘ʼ]/g, "'");
  const words = u.split(/\s+/).length;

  // ── SELF-IDENTIFICATION runs BEFORE the length gate below, because the whole
  // act fits in two words. "I'm Gatsby," he said suddenly — a missed MAJOR gold
  // event and the hinge of that chapter: Nick has been talking to a stranger for
  // several minutes without knowing it. Naming yourself to someone who did not
  // know you changes the relation between two people, which is what an event is.
  //
  // Requires a CAPITALISED name after the copula, so "I'm tired" and "I'm the one
  // who has to fix it" cannot reach it.
  if (/\bI\s*(?:'m|\s+am)\s+(?:Mr\.?|Mrs\.?|Miss|Dr\.?|Lord|Lady)?\s*[A-Z][a-z']{2,}\b/.test(u)) {
    return "revelation";
  }

  // Too short to carry a claim, or asking rather than asserting.
  if (words < 3) return "unclassified";
  if (/^(?:yes|no|all right|agreed|very well|of course|maybe|perhaps)\b[.,!]?$/i.test(u)) return "unclassified";
  if (u.endsWith("?")) return "unclassified";

  // Second person plus a finite verb: an accusation or a characterisation of the
  // listener. "You're defending the system", "You knew", "You never asked".
  if (/^(?:You|Y'?all)\b\s*(?:'(?:re|ve|d|ll)|are|were|was|have|had|did|didn't|do|don't|never|always|knew|know|lied|promised|said|told)\b/i.test(u)) {
    return "confrontation";
  }
  // Second person NEED NOT open the clause. "That you weren't going to age the
  // way the rest of us do" is a revelation addressed to the listener, and it was
  // a missed major gold event under a clause-initial-only rule. Bounded to
  // negated or knowledge-bearing predicates for the same reason as the
  // first-person rule below: unbounded, it fires on ordinary conversation.
  if (/\byou\s*(?:weren'?t|aren'?t|didn'?t|don'?t|won'?t|never|knew|know|lied|promised|owe|must)\b/i.test(u)) {
    return "revelation";
  }

  // First person plus a knowledge verb: an admission. Restricted to verbs that
  // report ACQUIRING knowledge or asserting it. "saw", "thought", "believed" and
  // "felt" were here and are gone: "I saw him at the ball", "I thought he was
  // handsome", "I felt tired" are conversation, and Austen's dialogue is built
  // out of them.
  if (/\bI\s*(?:'ve|'d)?\s*(?:know|knew|noticed|realised|realized|understood|remember|remembered|discovered|learned|learnt)\b/i.test(u)) {
    return "revelation";
  }

  // First person plus intent or refusal: a commitment.
  if (/\bI\s*(?:'m|'ll|'d)?\s*(?:will|won'?t|refuse|want|need|am going to|intend|promise|can'?t|cannot|won't)\b/i.test(u)) {
    return "decision";
  }

  // An imperative opening: "Come see where I live", "Tell me what happened".
  // A bare verb-initial clause addressed to someone is an instruction, and an
  // instruction in dialogue moves the scene.
  const first = u.split(/\s+/)[0]?.replace(/[^A-Za-z']/g, "").toLowerCase() ?? "";
  if (first && !STATE_VERBS.has(first) && CHANGE_VERBS[first] !== undefined && /^[A-Z]/.test(u)) {
    return "decision";
  }
  if (/^(?:Come|Go|Look|Listen|Tell|Show|Take|Give|Wait|Stop|Let)\b/.test(u)) return "decision";

  // First-person identity or capability claim: "I'm outside it", "I breathe with
  // it", "I am the one who signed it".
  //
  // ★ THIS RULE USED TO BE A CATCH-ALL AND IT BROKE ON ANOTHER AUTHOR. The verb
  // slot was `[a-z]+(?:ed|e|s)`, which matches essentially any verb, so ANY
  // four-word utterance containing "I <verb>" became a revelation. On the
  // in-house manuscripts, whose dialogue is sparse, that looked fine. On Pride
  // and Prejudice it collapsed the whole taxonomy: type entropy fell to 0.38 and
  // 84.4% of every detected event in the book was typed "revelation". Sherlock
  // was 67.5%. Austen's dialogue is almost entirely first-person declaratives.
  //
  // ★★ NARROWING IT ONCE WAS NOT ENOUGH, and the second pass is the interesting
  // one. The replacement list still held `am was have had been do did see saw
  // find found hear heard feel felt mean meant think thought hope wish` — which
  // is, almost exactly, the vocabulary ordinary conversation is MADE of. Austen
  // stayed at 64.9% revelation, and reading the output made the real problem
  // visible: these were not mistyped events, they were not events. "I do not
  // cough for my own amusement", "I am not afraid", "I wish you had been there"
  // were each getting a chip.
  //
  // The principled cut is Austin's: an utterance is an ACT when its verb is
  // PERFORMATIVE — saying it is doing it — and not when the verb merely reports a
  // state or a perception. "I promise", "I refuse", "I confess" change the
  // situation between two people. "I am tired", "I saw him", "I think so" do not,
  // however fluent they are.
  //
  // This generalises better than a frequency list because performative verbs are
  // a small CLOSED class in English, so the rule carries to an author whose
  // conversational register is nothing like Austen's.
  const PERFORMATIVE =
    /\bI\s*(?:'m|'ve|'d|'ll)?\s*(?:admit|admitted|confess|confessed|promise|promised|swear|swore|refuse|refused|decline|declined|agree|agreed|decide|decided|assure|declare|insist|insisted|beg|owe|owed|intend|vow|vowed|apologise|apologize|accept|accepted|forbid|deny|denied|grant|granted|consent)\b/i;
  if (words >= 4 && PERFORMATIVE.test(u)) return "revelation";

  // ── DECLARATIONS: saying it IS the act, and it changes a standing status.
  //
  // The list above is all COMMISSIVE — the speaker binding their own future
  // conduct. Austin's other performative class changes the relation between two
  // people at the moment of utterance: releasing someone from an obligation,
  // forgiving, disowning, resigning. "I do; and I release you" ends an
  // engagement, and was a missed MAJOR gold event.
  //
  // Also a closed class and a small one, which is what keeps it safe. Bounded to
  // FIRST PERSON with a direct object, because "he released her hand" is a
  // physical act while "I release you" is a social one.
  if (words >= 3 && /\bI\s+(?:release|free|forgive|pardon|absolve|disown|renounce|resign|withdraw|dismiss)\b/i.test(u)) {
    return "decision";
  }

  // ── NEGATIVE VOLITION. "I'm not going to keep her."
  //
  // The commissive rules above only catch a refusal phrased as one ("I refuse").
  // In speech the same act is almost always negated intention, which is a
  // decision every bit as much as its positive form — and this one turns the
  // whole first act of Anne of Green Gables.
  if (/\bI\s*(?:'m|\s+am)\s+not\s+going\s+to\s+[a-z]/i.test(u)
      || /\bI\s*(?:'d|\s+would|\s+will|'ll)\s+(?:sooner|rather)\b/i.test(u)
      || /\bI\s*(?:will|'ll|shall)\s+not\s+[a-z]/i.test(u)) {
    return "decision";
  }

  // ── A DEATH REPORTED IN SPEECH.
  //
  // "And my poor father died quite suddenly that evening." The narration channel
  // catches a death it witnesses; nothing caught one that a character REPORTS,
  // which in detective and epistolary fiction is how most deaths arrive.
  if (/\b(?:died|is\s+dead|was\s+killed|were\s+killed|has\s+died|had\s+died|passed\s+away|was\s+murdered)\b/i.test(u)) {
    return "state-change";
  }

  // ── A STANDING REVOKED. "Rank stripped. Guild membership revoked."
  //
  // Institutional acts performed BY SPEAKING — the utterance is the act. Closed
  // on the revocation word. Distinct from the termination rule below, which ends
  // an arrangement; this one strips a person of a status.
  if (/\b(?:revoked|stripped\s+of|expelled|dismissed\s+from|discharged|disbarred|excommunicated|disowned|disinherited|demoted)\b/i.test(u)
      || /\b(?:rank|membership|title|commission|licence|license)\s+(?:stripped|revoked|forfeit)\b/i.test(u)) {
    return "state-change";
  }

  // ── A THREAT. The speaker undertakes to do harm.
  //
  // "Keep still, you little devil, or I'll cut your throat!" — a missed MAJOR
  // gold event, and a speech act the classifier had no rule for at all. It is a
  // commissive like a promise, but its content is violence, so none of the
  // performative verbs reach it.
  //
  // Carried by a closed set of HARM verbs, not by "I'll", which is far too common
  // alone: "I'll call tomorrow" is not a threat and "I'll cut your throat" is.
  if (/\b(?:I'?ll|I\s+will|we'?ll|we\s+will)\s+(?:\w+\s+){0,2}(?:kill|murder|cut|shoot|strangle|hang|throttle|beat|thrash|break|tear|smash|ruin|destroy|finish)\b/i.test(u)
      || /\bI'?ll\s+have\s+your\s+(?:heart|liver|throat|life|blood|hide)\b/i.test(u)) {
    return "confrontation";
  }

  // ── AN ARRANGEMENT ANNOUNCED AS ENDED, or a party reported gone.
  //
  // "THE RED-HEADED LEAGUE IS DISSOLVED" and "The whole party have left
  // Netherfield by this time" — both missed MAJOR gold events. Neither is about
  // the speaker, so every first-person rule above is blind to them: the utterance
  // reports that something in the world has stopped.
  //
  // Closed on the TERMINATION word, which is what stops it firing on ordinary
  // reportage.
  if (/\b(?:is|are|was|were|has\s+been|have\s+been)\s+(?:dissolved|disbanded|broken\s+off|cancelled|canceled|terminated|abolished|over|ended|at\s+an\s+end)\b/i.test(u)) {
    return "state-change";
  }
  if (/\b(?:has|have|had)\s+(?:left|quitted|departed|fled|vanished|disappeared)\b/i.test(u)) {
    return "departure";
  }

  // ── A PROHIBITION, which is a directive with the verb left out.
  //
  // "No more work to-night. Christmas Eve, Dick." — Fezziwig closing the
  // warehouse, a missed MAJOR gold event. Every rule above looks for a verb and
  // this utterance has none: "No more <noun>" is an order by ellipsis, and it
  // ends the working day for everyone in the room.
  //
  // Narrow on purpose. "No more" as a quantifier inside a longer clause ("there
  // was no more bread") is not a prohibition, so it has to OPEN the utterance.
  if (/^(?:and\s+)?no\s+more\b/i.test(u)
      || /\b(?:you|we)\s+(?:shall|will|must)\s+not\b/i.test(u)
      || /\bnever\s+again\b/i.test(u)) {
    return "decision";
  }

  // ── A PREDICTION whose outcome is grave.
  //
  // "If these shadows remain unaltered by the future, the child will die" — a
  // missed MAJOR gold event, and one that no rule above could reach because the
  // subject is third person and the speaker commits to nothing.
  //
  // `will` on its own is one of the commonest words in dialogue, so the rule is
  // carried entirely by a CLOSED SET of grave outcomes. A prophecy that someone
  // will die, hang or be ruined changes a scene; "I will call tomorrow" does not,
  // and the verb list is what separates them.
  if (/\b(?:will|shall|'ll)\s+(?:die|perish|hang|starve|drown|fall|end|fail|be\s+(?:dead|lost|killed|destroyed|ruined|undone|hanged|taken))\b/i.test(u)) {
    return "revelation";
  }

  // ── A COMMITMENT stated as settled intention rather than a promise.
  //
  // "I mean to give him the same chance every year, whether he likes it or not" —
  // a missed MAJOR gold event. `intend` was already in the performative list but
  // almost nobody says "I intend to"; in narrative dialogue the same act is
  // "I mean to", "I am going to", "I shall".
  //
  // The infinitive is required. "I mean THAT…" is a clarification of something
  // already said, and "I mean, …" is a filler — neither commits the speaker to
  // anything, and both are extremely common in conversation.
  if (/\bI\s+(?:mean|meant)\s+to\s+[a-z]/i.test(u)
      || /\bI\s+(?:am|'m)\s+going\s+to\s+[a-z]/i.test(u)) {
    return "decision";
  }

  // ── The speaker ANNOUNCES THEIR OWN ARRIVAL, and says what for.
  //
  // "I have come to bring you home, dear brother!" — a missed MAJOR gold event.
  // A character reporting that they are now here, for a reason, is the arrival
  // stated from the inside; the narration channel only ever catches it from the
  // outside ("the door opened and a girl came in").
  //
  // The exclusion is the whole rule. "I have come to BELIEVE that…" is an idiom
  // for a slowly-formed opinion and not an arrival at all, so a mental verb after
  // the infinitive disqualifies it.
  if (/\bI\s+(?:have\s+|had\s+)?(?:come|came)\s+(?:here\s+)?(?:to|for)\b/i.test(u)
      && !/\b(?:come|came)\s+(?:here\s+)?to\s+(?:think|believe|realise|realize|understand|know|see|feel|suppose|regard|expect|accept|love|hate|fear|doubt)\b/i.test(u)) {
    return "arrival";
  }

  return "unclassified";
}

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
    //
    // ★ This bail-out is the largest remaining loss in the whole narration path:
    // it is why 345 of 590 entity subjects find no verb, almost all of them a
    // subject carrying a prepositional post-modifier — "The register OF HIS
    // BURIAL was signed", "The mention OF MARLEY'S FUNERAL brings me back". The
    // verb really is still ahead there, so crossing the modifier looks like free
    // recall.
    //
    // IT IS NOT, AND THIS WAS MEASURED, so do not re-derive it. A conservative
    // skip (stop at any punctuation or relativiser, look ahead at most five
    // tokens) recovered 17 entity subjects and 2 emitted events, of which ZERO
    // landed on a gold event: precision 28.9% -> 28.6%, precision@4 and
    // major-in-top-4 both unchanged. The pattern is real and the events are not.
    // "The X of Y verbed" is overwhelmingly descriptive prose — Dickens
    // inventories a room, Shelley describes a season — rather than something
    // happening. Reverted; the code was ~40 lines and a false-attachment risk for
    // no measured gain.
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
/** Words that can open a FRONTED ADVERBIAL — a phrase preceding the subject. */
const FRONTED_OPENER = new Set([
  "with", "without", "after", "before", "during", "despite", "besides",
  "among", "between", "in", "on", "at", "from", "by", "for", "through",
  "across", "against", "beneath", "beyond", "under", "over", "upon",
  "within", "toward", "towards", "near", "beside", "behind", "above", "below",
  "when", "while", "as", "although", "though", "because", "since", "if",
  "unless", "once", "whenever", "until",
  "then", "now", "later", "suddenly", "finally", "meanwhile", "presently",
  "afterwards", "immediately", "instead", "meantime", "thereupon",
  "here", "there", "thus", "therefore", "however", "indeed", "perhaps",
  "certainly", "yesterday", "today", "tonight", "still", "nevertheless",
]);

/**
 * Characters of fronted adverbial to step over before looking for the subject,
 * or 0 to leave the clause alone.
 *
 * ★ MEASURED NEUTRAL ONCE, REVERTED, AND RE-ADMITTED ON EVIDENCE. Both subject
 * finders are anchored at position 0, so a clause opening with a prepositional or
 * participial phrase has no findable subject at all:
 *
 *   "With an effort I turned and began a stumbling run"
 *   "With a fierce sweep of his arm, he hurled the woman from him"
 *   "advancing from the direction of Horsell, I noted a little black knot of men"
 *
 * All three are MAJOR gold events. A first version fired 78 times and moved
 * nothing, because the recovered clauses died at the same verb gate as everything
 * else, and it was reverted with that number recorded. It is back because those
 * three are still in the miss list and the engine around it has changed. If it
 * measures neutral again, revert again — but MEASURE, do not assume either way.
 *
 * Resumes ONLY at a personal pronoun, or at a subject-shaped token immediately
 * after a comma. That second condition is what stops "advancing from the
 * direction of Horsell, I noted…" resuming at "Horsell" and inventing a subject.
 */
function frontedAdverbialLength(text: string): number {
  const opener = text.match(/^\s*([A-Za-z']+)/);
  if (!opener) return 0;
  const first = opener[1].toLowerCase();
  if (!FRONTED_OPENER.has(first) && !/(?:ing|ed)$/.test(first)) return 0;
  const tok = /\S+/g;
  let index = 0;
  let afterComma = false;
  let t: RegExpExecArray | null;
  while ((t = tok.exec(text)) !== null && index < 10) {
    index++;
    if (index === 1) { afterComma = /,$/.test(t[0]); continue; }
    if (/^(?:She|He|They|I|We|It)\b/.test(t[0])) return t.index;
    if (afterComma && /^(?:[A-Z][a-z']{2,}|[Tt]he|[Aa]n?|[Oo]ne)\b/.test(t[0])) return t.index;
    afterComma = /,$/.test(t[0]);
  }
  return 0;
}

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

/**
 * Words that CLOSE a subject noun phrase. Everything after one of these belongs
 * to a different phrase, so the head is whatever came before it.
 *
 * Deliberately separate from `OBJECT_TERMINATOR`, which is the same idea applied
 * to objects but must NOT contain the core prepositions — "the smell of the
 * interior" is one object, while a subject walk that crosses "of" lands its head
 * on the wrong noun.
 */
const NP_BOUNDARY = new Set([
  // Prepositions.
  "of", "in", "on", "at", "to", "from", "with", "by", "for", "into", "onto",
  "over", "under", "through", "across", "against", "between", "among", "about",
  "before", "after", "during", "within", "without", "behind", "beside",
  "beneath", "above", "below", "near", "past", "upon", "toward", "towards",
  "around", "along", "off", "inside", "outside", "like", "than", "since",
  "until", "despite", "besides",
  // Coordinators and clause openers.
  "and", "or", "but", "nor", "so", "yet", "that", "which", "who", "whom",
  "whose", "where", "when", "while", "because", "if", "though", "although",
  "as", "unless", "whether",
  // A pronoun opens a reduced relative clause, not more of the subject:
  // "The hands she was thinking about" gave the head "she" without this.
  "she", "he", "they", "it", "we", "i", "you", "him", "them", "her", "us", "me",
  // A second determiner or possessive opens a NEW noun phrase.
  "the", "a", "an", "this", "these", "those", "his", "her", "its", "their",
  "my", "our", "your", "some", "any", "no",
]);

/**
 * Words that open a sentence with a capital and are NEVER a character.
 *
 * The unlisted-proper-noun fallback below takes a capitalised sentence-initial
 * word as an agent when it RECURS, which is how a character is recognised before
 * the manuscript has been scanned. Quantifiers and discourse openers recur more
 * than any real name does, so they sailed through it: The Great Gatsby produced
 * "Some buys dozen volumes", "Some tells how I" and "You stops" as timeline
 * chips. This is the single largest source of nonsense labels in the whole
 * corpus, and it is worst exactly where the engine is weakest — modern prose
 * that opens sentences with these words far more often than Victorian prose does.
 */
const NEVER_A_NAME = new Set([
  "some", "any", "many", "most", "much", "more", "few", "several", "each",
  "every", "all", "none", "both", "either", "neither", "another", "one", "two",
  "you", "your", "yours", "they", "them", "their", "we", "our", "his", "her",
  "him", "hers", "its", "this", "that", "these", "those", "there", "here",
  "then", "now", "once", "when", "while", "after", "before", "since", "until",
  "yes", "not", "nor", "and", "but", "for", "the", "she", "was", "were",
  "well", "why", "how", "what", "who", "whom", "whose", "where", "which",
  "oh", "ah", "still", "even", "just", "only", "perhaps", "maybe", "indeed",
  "already", "always", "never", "often", "sometimes", "suddenly", "finally",
  "instead", "besides", "however", "therefore", "meanwhile", "nevertheless",
  "everyone", "everybody", "someone", "somebody", "anyone", "anybody",
  "nobody", "nothing", "something", "anything", "everything",
]);

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
  // ★ Three bugs have lived in this one pattern, and the third was by far the
  // most expensive.
  //
  // It was LAZY (`{0,3}?`), so "The total affected population reached
  // seventy-eight thousand" captured just "total" and the verb search started at
  // "affected" and gave up. It required a CAPITALISED determiner, so "one more
  // peripheral body went dark" never matched at all. Both were missed MAJOR gold
  // events, and both were fixed by making the quantifier greedy.
  //
  // Greedy then overshot in the other direction, and that is the bug being fixed
  // here. `(?:[\w-]+\s+){0,3}` happily eats prepositions and conjunctions, so the
  // head landed on whatever word sat four tokens in:
  //
  //   "The coffee machine in the corner hummed."            head → "the"
  //   "The records from the outermost settlements survived" head → "outermost"
  //   "A serene sky and verdant fields filled me"           head → "verdant"
  //
  // Measured consequence: of 523 entity subjects found across the gold chapters,
  // 425 — 81.3% — then failed to find a verb, because `end` had already been
  // carried past the verb into the predicate. Entity subjects are the strongest
  // major-event predictor in the engine (+33.7pp) and this is what was starving
  // them. `isSpecified`, long assumed to be the throttle, kills exactly one.
  //
  // So walk tokens and stop at a real noun-phrase boundary instead.
  const det = clause.match(/^\s*(?:the|a|an|one|two|three|another|each|every|both)\s+/i);
  if (!det) return null;

  const np: string[] = [];
  let end = det[0].length;
  const tok = /\S+/g;
  tok.lastIndex = det[0].length;
  let t: RegExpExecArray | null;
  while (np.length < 4 && (t = tok.exec(clause)) !== null) {
    const raw = t[0];
    const bare = stripTrailingPunct(raw);
    if (!bare || NP_BOUNDARY.has(bare)) break;
    // A verb-shaped token after at least one noun word IS the predicate starting.
    if (np.length > 0 && looksVerbal(bare)) break;
    // The FIRST token is not checked the same way, because plenty of good heads
    // look verbal to a suffix test ("The records", "The operations"). But an
    // UNAMBIGUOUS verb form is never a noun, and letting those through produced
    // subjects like "were dark" and "shook".
    if (np.length === 0 && (IRREGULAR_PAST[bare] || STATE_VERBS.has(bare))) return null;
    np.push(bare);
    end = t.index + raw.length;
    // Trailing punctuation closes the phrase: "The fair girl, with a laugh…".
    if (/[^A-Za-z']$/.test(raw)) break;
  }
  if (!np.length) return null;

  const head = np[np.length - 1];
  if (head.length < 3 || WEAK_HEADS.has(head)) return null;
  // A verb-shaped head means the walk never found a noun at all.
  if (looksVerbal(head)) return null;
  // Keep at most two words so the label stays inside its budget: "The Axiom
  // Spire" survives, "The total affected population" becomes "population".
  const kept = np.length > 2 ? head : np.join(" ");
  return { name: kept, end, kind: "entity" };
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
  windowNames: readonly string[] = [],
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
    const pron = p[1];
    const lower = pron.toLowerCase();
    let resolved = carried && SUBJECT_PRONOUNS.has(lower) && lower !== "it"
      ? carried
      : pron;
    // ★ She/He resolve through the RECENT-NAME WINDOW too (the owner's ask:
    // the chip should say the cast name, not the pronoun, when the engine can
    // be confident). Two rules, both deliberately conservative — a wrong name
    // in a chip is worse than a pronoun:
    //   · no carry, and exactly ONE known name on stage in the last three
    //     sentences → that name is who "she/he" is;
    //   · a carry the window CONTRADICTS (names on stage, the carried one not
    //     among them) is stale — fall back to the pronoun rather than guess.
    // "I"/"We" never resolve this way (first-person narrators are not cast),
    // and "It" never resolves at all.
    if (lower === "she" || lower === "he") {
      if (resolved === pron && windowNames.length === 1) {
        resolved = windowNames[0];
      }
      // MEASURED AND REJECTED (kept for the record): also vetoing a carry the
      // window contradicts — carried name absent from the last three sentences
      // while other names are on stage → fall back to the pronoun. On DEV it
      // traded names for pronouns (shown named agent 81.6 -> 79.2) and cost
      // 0.8pp of precision@3. The carry is right more often than the window
      // when they disagree.
    }
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
  if (cap && !NEVER_A_NAME.has(cap[1].toLowerCase())) {
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

// ─── Object consequence ───────────────────────────────────────────────────────
/**
 * WHAT the clause acts on, as a class. The same idea as the verb classes, one
 * argument along.
 *
 * ★ This is the answer to the precision problem. Precision sat at 35.7% and was
 * FLAT across the whole usable confidence range, which meant no threshold could
 * fix it: the false positives were scoring as high as the true ones. Reading them
 * showed why. Almost every one was stage business that happened to contain a
 * change verb:
 *
 *     "Kinoko drops hand"        "Tessa opens hand fully"
 *     "Mira pays supper"         "She returns drawer"
 *     "Winter passes"            "Sky begins early transition"
 *
 * while the gold events act on things that carry consequence:
 *
 *     "Kael accepted the decision"     "council adopted it"
 *     "Helia writes audit report"      "Tessa reveals Brennan knew"
 *
 * A verb tells you the SHAPE of a happening. Its object tells you whether the
 * happening matters. Both lists are general English, not manuscript vocabulary —
 * that distinction is the whole reason the previous engine's dictionaries failed,
 * so it has to hold here too.
 */
const TRIVIAL_OBJECTS = new Set([
  // Body. A clause about a body part is almost always a gesture.
  "hand", "hands", "head", "eyes", "eye", "face", "arm", "arms", "shoulder",
  "shoulders", "foot", "feet", "finger", "fingers", "mouth", "hair", "knee",
  "knees", "chest", "back", "wrist", "palm", "thumb", "lip", "lips", "throat",
  // Domestic objects and furniture.
  "cup", "plate", "bowl", "door", "doors", "window", "chair", "table", "lamp",
  "blanket", "cloth", "sheet", "pillow", "drawer", "shelf", "basket", "jug",
  "jar", "spoon", "bottle", "glass", "bag", "coat", "boot", "boots", "shoe",
  "floor", "wall", "ceiling", "stair", "stairs", "step", "steps", "gate",
  // Food and drink.
  "bread", "tea", "water", "supper", "dinner", "breakfast", "lunch", "coffee",
  "meal", "food", "wine", "milk", "soup",
  // Weather, light, time. Description, not event.
  "morning", "evening", "night", "afternoon", "day", "days", "winter", "summer",
  "autumn", "spring", "sky", "sun", "moon", "rain", "snow", "wind", "light",
  "dark", "darkness", "air", "heat", "cold", "silence", "sound", "smell",
  // Pure abstraction.
  "thing", "things", "way", "ways", "moment", "side", "edge", "end", "line",
  "place", "time", "point", "part", "kind", "sort",
]);

const CONSEQUENTIAL_OBJECTS = new Set([
  // Institutional artefacts.
  "decision", "decisions", "resolution", "order", "orders", "report", "reports",
  "record", "records", "document", "documents", "contract", "agreement",
  "treaty", "vote", "motion", "recommendation", "protocol", "protocols",
  "policy", "law", "laws", "ruling", "verdict", "charge", "charges", "warrant",
  "licence", "license", "permit", "lease", "budget", "audit", "archive", "file",
  "files", "ledger", "minutes", "transcript", "proposal", "petition", "appeal",
  // Knowledge and speech that binds.
  "truth", "secret", "secrets", "name", "names", "message", "letter", "reply",
  "request", "offer", "promise", "permission", "right", "rights", "claim",
  "account", "testimony", "statement", "evidence", "confession", "warning",
  "reason", "reasons", "answer", "question",
  // Stakes.
  "life", "lives", "death", "body", "bodies", "child", "children", "family",
  "position", "post", "seat", "command", "money", "payment", "debt", "land",
  "field", "fields", "house", "farm", "share", "stake", "future", "control",
]);

/**
 * Subjects that are weather, light or the passage of time. A clause with one of
 * these as its subject is setting a scene, not reporting a change.
 */
const AMBIENT_SUBJECTS = new Set([
  "morning", "evening", "night", "afternoon", "day", "days", "winter", "summer",
  "autumn", "spring", "sky", "sun", "moon", "rain", "snow", "wind", "light",
  "dark", "darkness", "air", "heat", "cold", "weather", "season", "seasons",
  "silence", "sound", "sounds", "smell", "hour", "hours", "week", "weeks",
  "year", "years", "time", "moment", "moments",
]);

/** Reflexives make a poor object head: "pushes herself off" says nothing. */
const REFLEXIVE = new Set([
  "herself", "himself", "themselves", "itself", "myself", "ourselves", "yourself",
]);

/**
 * Pronouns and bare deictics cannot BE an object worth showing. "She reaches it",
 * "Mira tells them", "Nora tells it" — the chip names an action and then points
 * at nothing. Rejected as heads so the label either finds a real object or
 * carries none.
 */
const PRONOUN_HEADS = new Set([
  "it", "them", "him", "her", "us", "me", "you", "they", "she", "he", "we", "i",
  "this", "that", "these", "those", "there", "here", "one", "some", "any", "all",
  "something", "anything", "nothing", "everything", "someone", "anyone",
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
    // A degree/time adverb never belongs in an object: it either strands the
    // object walk on a modifier ("tells Once") or trails a real noun with
    // noise ("hands glass anyway"). Stop before it, keeping what came first.
    if (ADVERB_HEADS.has(clean)) break;
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
    // Strip surrounding punctuation INCLUDING quote marks. Leaving them in
    // produced labels like `Iris commits "I` and `Tessa commits "I want` — the
    // opening quote of the utterance survived into the object.
    // A dash splice is TWO tokens the typesetting glued together — "sash--it"
    // is "sash" followed by a new clause. Keep the first side only; carrying
    // both shipped "She pushes sash--it".
    const word = w.split(/--|—|–/)[0]
      .replace(/^[^A-Za-z']+/, "").replace(/[^A-Za-z's]+$/, "");
    if (!word) continue;
    // NOTE: rejecting pronoun heads here was tried and measured as a net LOSS
    // (major recall 56% -> 44%): it removed valid objects along with the useless
    // ones. The uselessness of "tells them" is handled by scoring, not by
    // refusing to extract.
    out.push(word);
    // The dash opened a NEW clause; nothing after it belongs to this object.
    if (/--|—|–/.test(w)) break;
    if (out.length === 2) break;
  }
  const phrase = out.filter(Boolean).join(" ").trim();
  return phrase.length >= 2 ? phrase : null;
}

// ─── Present-tense rendering for the label ────────────────────────────────────

const PRESENT_IRREGULAR: Record<string, string> = {
  be: "is", have: "has", go: "goes", do: "does",
};

/**
 * Agents that take the BARE present rather than the -s form. "I loses" and "We
 * agrees" both shipped; a label that cannot conjugate reads as broken software
 * rather than as a reminder, which costs more trust than a missed event does.
 */
const PLURAL_AGENTS = new Set(["i", "we", "they", "you", "both", "everyone else"]);

/** Third-person present of a base form: "refuse" → "refuses". Labels read as a
 *  present-tense report ("Tessa admits she has known"), which is how a reader
 *  narrates a plot beat and how the gold set is written. */
function toPresent(base: string, agent?: string): string {
  const a = agent?.toLowerCase().trim();
  if (a && (PLURAL_AGENTS.has(a) || / and /.test(a))) {
    // "I refuse", "We agree", "Tessa and Mira arrive".
    return base === "be" ? "are" : base;
  }
  if (PRESENT_IRREGULAR[base]) return PRESENT_IRREGULAR[base];
  if (/(?:s|sh|ch|x|z|o)$/.test(base)) return `${base}es`;
  if (/[^aeiou]y$/.test(base)) return `${base.slice(0, -1)}ies`;
  return `${base}s`;
}

/**
 * ─── LABEL WELL-FORMEDNESS ───────────────────────────────────────────────────
 *
 * The object slot was accepting text that is not a word, and the timeline was
 * showing it. Real examples, all from the gold corpus:
 *
 *     "Marilla accuses ll"        <- "You'll have to stay here"
 *     "Marilla accuses t know"    <- "You don't know how delighted I was"
 *     "Matthew accuses d likely"  <- "You'd likely set the place on fire"
 *     "Marilla insists Marilla"   <- "insisted Marilla" (inverted attribution)
 *
 * The first three are CONTRACTION REMNANTS: an apostrophe-split left `ll`, `t`,
 * `d`, `s`, `re`, `ve`, `m` stranded as a bare token, and none of them is an
 * English word. The fourth is the agent repeated back at itself, which carries
 * no information at all.
 *
 * These are rejected rather than repaired. A missing object degrades to "Marilla
 * accuses", which is thin but true; a fragment object is noise wearing the shape
 * of information, and the writer cannot tell which they are looking at.
 */
const CONTRACTION_REMNANTS = new Set(["ll", "t", "d", "s", "re", "ve", "m", "n", "nt"]);

/** Interrogative heads. An object that opens with one is the shell of a
 *  question, not its content: "Rachel demands What", "Marilla asks How" tell
 *  the writer nothing. These shipped because the junk filter only knew about
 *  contraction remnants. */
const QUESTION_HEADS = new Set([
  "what", "who", "whom", "whose", "which", "why", "how", "where", "when",
]);

/** A whole subject-contraction as a word — "I'm", "you're", "don't". As an
 *  object it means the strips upstream never reached the quote's content
 *  ("Marilla commits I'm"), and in any position it reads as a cut-off quote. */
const CONTRACTION_WORD = /^(?:i|you|he|she|it|we|they|that|there|who|what|don|won|can|ain)['’](?:m|re|ll|ve|d|s|t)$/i;

/** A bare possessive as an object head is a quote cut mid-reference:
 *  "Bohemian confesses mine", "Fuchs tells ours". Nothing a possessive alone
 *  points at survives into the label. */
const POSSESSIVE_HEADS = new Set(["mine", "ours", "yours", "theirs", "hers"]);

/** Degree/time adverbs that mean the object walk stopped on a modifier and
 *  never reached a noun: "Jake tells Once", "Old man becomes somewhat",
 *  "Fuchs remembers exactly how". */
const ADVERB_HEADS = new Set([
  "once", "somewhat", "exactly", "quite", "rather", "almost", "really",
  "perhaps", "indeed", "anyway", "anyhow", "however", "twice",
]);

/** Personal pronouns as object heads. GRAMMATICAL, unlike the above — "Robert
 *  kisses them" is a fine reminder — so these are not junk. They are merely
 *  ANONYMOUS, and buildLabel upgrades them to the addressee's name when the
 *  scene knows one. */
const PERSONAL_OBJECT_HEADS = new Set(["him", "her", "them", "us", "me", "you", "it"]);

const bare = (w: string) => w.toLowerCase().replace(/[^a-z]/gi, "");

/** True when this object text would make the label worse than having none. */
function isJunkObject(object: string, agent?: string): boolean {
  const words = object.split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  // Any contraction remnant anywhere in the phrase poisons it: the phrase was
  // cut mid-word, so the words after it are the wrong side of the split.
  if (words.some((w) => CONTRACTION_REMNANTS.has(bare(w)))) return true;
  if (words.some((w) => CONTRACTION_WORD.test(w))) return true;
  // A question shell ("What", "How desperate") points at nothing.
  if (QUESTION_HEADS.has(bare(words[0]))) return true;
  // A possessive or a stranded modifier as the head reached no noun.
  if (POSSESSIVE_HEADS.has(bare(words[0]))) return true;
  if (ADVERB_HEADS.has(bare(words[0]))) return true;
  // Two personal pronouns in a row is a splice across a clause boundary:
  // "Jake tells us we" — the "we" belongs to the next clause.
  for (let i = 1; i < words.length; i++) {
    if (PERSONAL_OBJECT_HEADS.has(bare(words[i - 1])) &&
        (PERSONAL_OBJECT_HEADS.has(bare(words[i])) || /^(?:i|we|he|she|they)$/i.test(bare(words[i])))) {
      return true;
    }
  }
  // The agent restated. "Marilla insists Marilla" says one thing twice.
  if (agent && words.some((w) => bare(w) === agent.toLowerCase().trim())) return true;
  return false;
}

/**
 * The defect in a finished label, or null when it is well formed.
 *
 * Exported so the accuracy suite scores the SAME definition the engine repairs
 * against. A label-quality target checked by a second, hand-rolled copy of
 * these rules would drift, and then the gate would pass while the timeline
 * showed "Marilla accuses ll".
 */
export function labelDefect(label: string): "fragment" | "repeats-agent" | "no-verb" | null {
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "no-verb";
  if (words.some((w) => CONTRACTION_REMNANTS.has(bare(w)))) return "fragment";
  // A cut-off quote shipped whole: "Marilla commits I'm", "Rachel tells don't".
  if (words.some((w) => CONTRACTION_WORD.test(w))) return "fragment";
  // A question shell after the subject: "Rachel demands What", "Marilla asks
  // How". The first word is exempt — it is the agent, and a character can be
  // named Who — but anywhere later a bare interrogative is a quote's skeleton.
  if (words.slice(1).some((w) => QUESTION_HEADS.has(bare(w)))) return "fragment";
  // A bare possessive or stranded modifier after the subject reached no noun:
  // "Bohemian confesses mine", "Jake tells Once", "Old man becomes somewhat".
  // (Personal pronouns — "kisses them" — are grammatical and NOT flagged.)
  if (words.slice(1).some((w) => POSSESSIVE_HEADS.has(bare(w)))) return "fragment";
  if (words.slice(1).some((w) => ADVERB_HEADS.has(bare(w)))) return "fragment";
  // A dash splice survived object extraction: "She pushes sash--it".
  if (/--|—|–/.test(label)) return "fragment";
  const seen = new Set<string>();
  for (const w of words) {
    const k = bare(w);
    if (!k) continue;
    if (seen.has(k)) return "repeats-agent";
    seen.add(k);
  }
  // Agent alone, with nothing said about it.
  if (words.length < 2) return "no-verb";
  return null;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Assemble a label inside the budget by dropping the least important part
 *  first (the object), rather than truncating mid-phrase. */
/** A/B switch for the label repair, in the same style as FLOOR / CAP / SALIENCE,
 *  so the suite can print the before-and-after instead of me asserting it.
 *  Guarded: a bare `process` reference at module scope kills the whole module in
 *  the renderer, which has already happened once in this codebase. */
const LABEL_REPAIR =
  typeof process !== "undefined" ? process.env?.LABEL_REPAIR !== "off" : true;

/** How each speech verb takes a PERSON as its object. "Rachel demands Marilla"
 *  is broken English; "Rachel presses Marilla" is the scene. A verb with no
 *  entry cannot take the addressee, and the fallback quietly declines. */
const ADDRESSEE_VERB: Record<string, string> = {
  asks: "asks", questions: "questions", demands: "presses",
  tells: "tells", reveals: "tells", announces: "tells",
  explains: "explains to", admits: "admits to", confesses: "confesses to",
  concedes: "concedes to", acknowledges: "answers", confirms: "confirms to",
  warns: "warns", accuses: "accuses", refuses: "refuses", declines: "refuses",
  agrees: "agrees with", promises: "promises", answers: "answers",
  objects: "objects to", protests: "protests to", counters: "counters",
  offers: "offers", argues: "argues with", insists: "insists to",
  snaps: "snaps at", shouts: "shouts at", swears: "swears to",
  repeats: "repeats to", says: "speaks to",
};

/** Exported for scripts/test-label-quality.ts, same reasoning as labelDefect:
 *  the repair rules deserve direct cases, not just corpus-level rates. */
export function buildLabel(
  agent: string | undefined,
  verb: string,
  object: string | null,
  addressee?: string,
): string {
  const a = agent ? capitalize(agent) : "";
  // A fragment object is worse than no object — see isJunkObject.
  if (LABEL_REPAIR && object && isJunkObject(object, agent)) object = null;
  // ★ And no object at all is worse than the ADDRESSEE. When a dialogue event's
  // content came back empty or junk but the scene is a clean two-hander, name
  // the other party: "Rachel presses Marilla" reminds the writer of the scene;
  // "Rachel demands" reminds them of nothing. Label-time only — the fallback
  // never touches scoring or selection — and only through ADDRESSEE_VERB, so
  // the verb always agrees with a person object.
  // An ANONYMOUS object upgrades to the addressee too: "Bohemian tells him"
  // is grammatical but reminds the writer of no one; "Bohemian tells the
  // Bohemian's actual listener" does. Only the single-pronoun case — a longer
  // object that merely starts with a pronoun is saying something else.
  const anonymous = object !== null &&
    object.split(/\s+/).length === 1 && PERSONAL_OBJECT_HEADS.has(bare(object));
  if (LABEL_REPAIR && (!object || anonymous) && addressee &&
      bare(addressee) !== (agent ?? "").toLowerCase().trim()) {
    const av = ADDRESSEE_VERB[verb.toLowerCase()];
    if (av) {
      verb = av;
      object = capitalize(addressee);
    }
  }
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

/**
 * ─── DIAGNOSTIC: where do entity-subject candidates die? ──────────────────────
 *
 * Kept, not temporary, and it earned that. Entity subjects are the strongest
 * signal in the engine, and for four rounds the standing hypothesis was that
 * `isSpecified` was throttling them. Removing that gate entirely produced ONE
 * extra candidate. Counting the funnel instead found the real loss in a single
 * run: 425 of 523 entity subjects — 81.3% — were failing to find a verb, because
 * the noun-phrase walk had already carried the search past it.
 *
 * A rate tells you something is wrong; a funnel tells you where. Cost is a dozen
 * integer increments per sentence, and the sample arrays are capped so a long
 * editing session cannot grow them without bound.
 *
 * Read it with `npx tsx scripts/probe-entity-funnel.ts`.
 */
export const _funnel = {
  sentences: 0,
  agentNamedOrPronoun: 0,
  entityTried: 0,
  entityFound: 0,
  entityNoVerb: 0,
  entityVerbNotChange: 0,
  entityWrongType: 0,
  entityUnspecified: 0,
  entityArrivalDeparture: 0,
  entityActionWeakObject: 0,
  entityAmbient: 0,
  entitySurvived: 0,
  personNoVerb: 0,
  personVerbNotChange: 0,
  personSurvived: 0,
};
const FUNNEL_SAMPLE_CAP = 300;
export const _funnelSamples: { noVerb: string[]; notChange: string[]; personNotChange: string[] } = { noVerb: [], notChange: [], personNotChange: [] };
function sample(bucket: string[], line: string) {
  if (bucket.length < FUNNEL_SAMPLE_CAP) bucket.push(line);
}
export function _resetFunnel() {
  for (const k of Object.keys(_funnel)) (_funnel as Record<string, number>)[k] = 0;
  _funnelSamples.noVerb.length = 0;
  _funnelSamples.notChange.length = 0;
  _funnelSamples.personNotChange.length = 0;
}

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
  /** The scene's OTHER speaker, when the passage is a clean two-hander.
   *  Used only as a label-time fallback object — "Rachel presses Marilla"
   *  instead of "Rachel demands" — never for scoring or selection. */
  addressee?: string;
  /** Entity subject that named or counted nothing — see the entity path. */
  unspecifiedEntity?: boolean;
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

/**
 * One-entry memo, keyed on the chapter's own text.
 *
 * ★ Detection was running TWICE per chapter. `story-graph.ts` builds the graph
 * entry and `chapter-observation.ts` builds the panel brief, and both called this
 * function on every analysis settle — so every chapter was segmented and scored
 * clause by clause two times over, for identical results. On the weak machines
 * this engine has to run on, that is half the cost of the feature for nothing.
 *
 * A single entry is the right size: both callers work on the CURRENT chapter,
 * back to back, within one settle. Keeping more would hold whole chapters of
 * candidate strings alive for no benefit.
 */
let _memoKey = "";
let _memoValue: NarrativeEvent[] = [];

export function detectNarrativeEvents(
  paragraphs: string[],
  speechResults: ChapterParaResult[],
  options: DetectOptions = {},
): NarrativeEvent[] {
  // Cheap key: length plus head and tail. The same shape story-graph already
  // uses for its contentHash, and enough to catch any real edit.
  const first = paragraphs[0] ?? "";
  const last = paragraphs[paragraphs.length - 1] ?? "";
  // ★ Every option that changes the OUTPUT must appear here. A swept parameter
  // missing from the key makes the sweep read the first run's answer back for
  // every setting and report a dead flat curve that looks like "no effect".
  // ★ Every option that can change the OUTPUT must be in this key. worldData
  // joined that set when place-agent rejection landed — without it here, the
  // first caller's result was served to a caller with different places, which
  // is exactly how the rejection silently failed its own test.
  const key = `${paragraphs.length}|${first.length}|${last.length}|${first.slice(0, 40)}|${last.slice(-40)}|${options.confidenceFloor ?? ""}|${options.maxEvents ?? ""}|${options.positionPriorWeight ?? ""}|${options.typePriorWeight ?? ""}|${(options.knownNames ?? []).length}|${(options.worldData?.places ?? []).map((p) => p.name).join(",")}`;
  if (key === _memoKey) return _memoValue;
  const result = detectNarrativeEventsUncached(paragraphs, speechResults, options);
  _memoKey = key;
  _memoValue = result;
  return result;
}

function detectNarrativeEventsUncached(
  paragraphs: string[],
  speechResults: ChapterParaResult[],
  options: DetectOptions = {},
): NarrativeEvent[] {
  const paraCount = paragraphs.length;
  if (paraCount < 2) return [];

  const positionPriorWeight = options.positionPriorWeight ?? POSITION_PRIOR_WEIGHT;
  const typePriorWeight = options.typePriorWeight ?? TYPE_PRIOR_WEIGHT;
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

  // ── Rolling window of explicitly-named characters, for pronoun resolution.
  //    The carry alone dies at every stretch of narration that produces no
  //    candidate ("She pushed up the sash" opening a chapter stayed "She"),
  //    so every sentence also records which known names it MENTIONS; a
  //    clause-initial she/he can then resolve when exactly one name has been
  //    on stage in the last three sentences. Places are excluded — a window
  //    of ["Green Gables"] must never make "she" a house.
  const nameSweep = nameRe ? new RegExp(nameRe.source, "gi") : null;
  const recentNames: Array<{ name: string; tick: number }> = [];
  let sentenceTick = 0;
  // ── Place-shape statistics, world-data or not. The place filter above only
  //    exists after an entity scan, and the first live test of the window
  //    resolved "She" to GREEN GABLES — a house — because nothing else had
  //    been on stage for three sentences. A name that mostly occurs behind a
  //    locative preposition ("at Green Gables", "in Avonlea") is a place
  //    whatever the world data says, and never a pronoun referent.
  const nameShape = new Map<string, { locative: number; agentive: number; total: number }>();
  const LOCATIVE_BEFORE = /\b(?:at|in|into|near|towards?)\s+$/i;
  // Auxiliaries make equative and passive frames ("This was Green Gables",
  // "Green Gables was built") — being followed by one is not ACTING.
  const AUX = new Set(["was", "were", "is", "are", "be", "been", "being", "had",
    "has", "have", "would", "could", "will", "shall", "should", "may", "might",
    "must", "did", "does", "do", "and", "or"]);
  // Irregular pasts that looksVerbal cannot see (they are not change verbs, so
  // IRREGULAR_PAST — which feeds detection — must not learn them; this set
  // feeds ONLY the agentivity stat). "Anne awoke" is how a referent enters.
  const AGENTIVE_EXTRA = new Set(["awoke", "woke", "ran", "ate", "drank",
    "slept", "wept", "sprang", "leapt", "crept", "shook", "knelt", "clung",
    "swung", "hung", "strode", "rode", "drove", "flew", "grew", "wore", "met",
    "got", "bade", "smiled", "laughed", "nodded", "sighed"]);
  const eligibleSpeakers = new Set<string>();
  // ★ A pronoun referent must have EARNED personhood in this chapter: either
  // it has acted (name followed by a real, non-auxiliary verb — "Anne awoke")
  // or it has spoken (attributed speaker). The first live test resolved "She"
  // to GREEN GABLES off a predicate nominal ("This was Green Gables"), which
  // passes every frequency and locative test — but a house never acts and
  // never speaks, and that is the difference that holds.
  const personShaped = (name: string): boolean => {
    const key = name.toLowerCase();
    if (eligibleSpeakers.has(key)) return true;
    const stat = nameShape.get(key);
    if (!stat || stat.agentive === 0) return false;
    return stat.total === 0 || stat.locative / stat.total <= 0.5;
  };

  // ── Place names, for agent validation. "Green Gables builds" shipped at 77%
  //    because a place name resolves through the same path as a character —
  //    the defect the passive-clause experiment (below) failed to fix because
  //    it aimed at a different signal. World data knows the difference; when
  //    an agent is a KNOWN PLACE and not also a character name, the candidate
  //    is not an actor doing something, it is scenery being described.
  // The guard against "a character named after a place" reads the EXPLICIT
  // character list, not knownNames — knownNames is a mixed pool (cast scan +
  // speakers + recurring proper nouns) that contains the places themselves,
  // and filtering against it quietly emptied the place set on first test.
  const explicitCharacters = new Set(
    (options.worldData?.characters ?? [])
      .flatMap((c) => [c.name, ...(c.aliases ?? [])])
      .map((n) => n.toLowerCase()),
  );
  const placeNames = new Set(
    (options.worldData?.places ?? [])
      .flatMap((p) => [p.name, ...(p.aliases ?? [])])
      .map((n) => n.toLowerCase())
      .filter((n) => n && !explicitCharacters.has(n)),
  );

  for (let pi = 0; pi < paraCount; pi++) {
    const paraText = paragraphs[pi];
    const sentences: Sentence[] = splitSentences(paraText);
    const segments = speechResults[pi]?.segments ?? [];

    // ── The scene's other party, for the label's fallback object. Scan a
    //    ±2-paragraph window for attributed speech; if exactly ONE other
    //    confident speaker holds the floor, this is a two-hander and that
    //    speaker is who the current line is said TO. In a crowd the answer is
    //    nobody: a guessed name in a label is worse than no object.
    const addresseeOf = (speaker: string): string | undefined => {
      const others = new Set<string>();
      for (let qi = Math.max(0, pi - 2); qi <= Math.min(paraCount - 1, pi + 2); qi++) {
        for (const s of speechResults[qi]?.segments ?? []) {
          if (s.type !== "speech" || !s.speaker || (s.confidence ?? 0) < 0.65) continue;
          if (s.speaker !== speaker) others.add(s.speaker);
          if (others.size > 1) return undefined;
        }
      }
      return others.size === 1 ? [...others][0] : undefined;
    };

    for (const sSeg of segments) {
      if (sSeg.type === "speech" && sSeg.speaker && (sSeg.confidence ?? 0) >= 0.65) {
        eligibleSpeakers.add(sSeg.speaker.toLowerCase());
      }
    }

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

      // The window holds names from PRIOR sentences only. Recording the
      // current sentence first would let "She wrote to Nora" resolve its own
      // subject to Nora — the object of the very clause under question.
      //
      // ★ Resolution rule: the MOST RECENT eligible name, if it is close
      // enough (within 8 sentences) and unrivalled — the nearest DIFFERENT
      // eligible name must be at least 4 sentences older. A fixed short
      // window missed the ordinary case where the referent enters once and a
      // pronoun trail carries her ("Anne awoke... she... she... She pushed"),
      // while a two-name scene stays ambiguous and keeps the pronoun.
      sentenceTick++;
      while (recentNames.length && recentNames[0].tick < sentenceTick - 12) recentNames.shift();
      let windowNames: string[] = [];
      for (let ri = recentNames.length - 1; ri >= 0; ri--) {
        const last = recentNames[ri];
        if (!personShaped(last.name)) continue;
        if (sentenceTick - last.tick > 8) break;
        const rival = [...recentNames].reverse()
          .find((r) => r.name !== last.name && personShaped(r.name));
        if (!rival || last.tick - rival.tick >= 4) windowNames = [last.name];
        break;
      }
      if (nameSweep) {
        nameSweep.lastIndex = 0;
        for (const m of text.matchAll(nameSweep)) {
          if (placeNames.has(m[0].toLowerCase())) continue;
          const key = m[0].toLowerCase();
          const stat = nameShape.get(key) ?? { locative: 0, agentive: 0, total: 0 };
          stat.total++;
          if (LOCATIVE_BEFORE.test(text.slice(Math.max(0, (m.index ?? 0) - 10), m.index ?? 0))) stat.locative++;
          const after = text.slice((m.index ?? 0) + m[0].length).match(/^\s+([a-z']+)/);
          if (after && !AUX.has(after[1]) && (looksVerbal(after[1]) || AGENTIVE_EXTRA.has(after[1]))) stat.agentive++;
          nameShape.set(key, stat);
          recentNames.push({ name: m[0], tick: sentenceTick });
          if (recentNames.length > 24) recentNames.shift();
        }
      }

      // Annotated explicitly: both branches return `Candidate | null`, and
      // without the annotation TypeScript follows Candidate → dialogueCandidate
      // → Candidate and reports a circular inference (TS7022).
      const cand: Candidate | null = seg
        ? dialogueCandidate(text, sent, pi, si, seg, mood,
            seg.speaker ? addresseeOf(seg.speaker) : undefined)
        : narrationCandidate(text, sent, pi, si, nameRe, carriedSubject, mood, recurringCaps, windowNames);

      if (!cand) continue;

      // A known place acting as an agent is scenery, not an event. (See the
      // placeNames note above; this is the upstream fix the passive-clause
      // experiment was aiming past.)
      if (cand.agent && placeNames.has(cand.agent.toLowerCase())) continue;

      if (cand.agent && cand.agentKind === "named") carriedSubject = cand.agent;

      // ── Scoring. Every term is a general property of the clause; none of
      //    them consults a phrase lifted from a manuscript.
      const why: string[] = [];
      let score = 1;

      // ─── WEIGHTS FITTED TO MEASURED LIFT, NOT TO INTUITION ─────────────────
      //
      // ★ Every bonus in the FIRST version of this block was anti-predictive and
      // the ranking was inverted: top third by confidence hit 19.1%, bottom third
      // 33.8%, separation -14.7pp. Fitting to measured lift took precision@4 from
      // 31.1% to 45.9%. That history is why nothing here is set by intuition.
      //
      // ★★ These weights have now been refitted a SECOND time, and the reason is
      // the standing warning at the bottom of this comment: the lifts are
      // conditional on which candidates survive the gates. Fixing the noun-phrase
      // walk in `findEntitySubject` changed the candidate population from 205 to
      // 243, and the previously-fitted weights immediately stopped separating
      // (8.1pp -> 1.2pp). Several signals CHANGED SIGN between the two fits:
      //
      //                     fit #1 (n=205)   fit #2 (n=243)
      //     pronoun-agent        +8.8            -4.4
      //     -habitual           +11.6            -0.0
      //     -no-echo             +8.0            -1.4
      //     -pronoun-object      +5.9           -13.3
      //     -pluperfect          +2.8            -4.4
      //
      // Do not read that as either fit being wrong. A signal's value depends on
      // what it is competing against, and the population it competes in is now
      // materially different. It does mean a weight is only valid for the gates it
      // was fitted under, which is a property worth stating out loud.
      //
      // Fit #2, base rate 30.0% any / 18.9% major, n=243:
      //
      //     entity-subject     +28.4  (+24.2 major)   dialogue-act      -16.2
      //     -trivial-object     +8.0   (+6.5 major)   -pronoun-object   -13.3
      //     -modal              +1.8                  named-agent       -12.6
      //     tension-rise        +0.5                  refusal            -6.7
      //                                               pronoun-agent      -4.4
      //                                               -pluperfect        -4.4
      //
      // Weights are lift ÷ ~25, rounded coarse ON PURPOSE. 243 samples against 16
      // features means precise coefficients would be fitting noise; the SIGN and
      // rough magnitude are what the data supports. Signals firing fewer than ~10
      // times are recorded and not scored, however large their apparent lift.
      //
      // Re-run `npx tsx scripts/analyse-event-signals.ts` after ANY change to the
      // gates. It also reports nested signals separately — a feature that can only
      // fire inside another one has a confounded raw lift, and weighting on that
      // raw number double-counts the parent.
      //
      // ★★ "THESE WEIGHTS HAVE SATURATED" WAS WRONG, AND THE CORRECTION IS THE
      // most useful thing in this comment. Fit #3 against the 212-candidate
      // population LOST, and I concluded the weights had nothing left to give —
      // that lift is a marginal association, the features are correlated, and
      // joint fitting was the only way forward.
      //
      // Then the gold set tripled to 444 candidates and FOUR SIGNS WERE WRONG:
      //
      //     pronoun-agent    weighted -0.20, measured +6.3pp
      //     -pluperfect      weighted -0.12, measured +5.4pp
      //     -chapter-close   weighted -0.30, measured +11.8pp
      //     -modal           weighted +0.05, measured -3.7pp
      //
      // Fixing the signs took precision@3 from 46.1% to 50.4%. The weights were
      // never saturated; the SAMPLE was too small to see the errors. 212
      // candidates against 16 features cannot resolve a 5-point lift, so fit #3
      // was fitting noise and correctly lost.
      //
      // The rule that follows: a failed refit means "not enough data to fit",
      // not "nothing left to fit". Re-run the analyser whenever the FIXTURE
      // grows, not only when the gates change. A fifth pass tuning the three
      // largest remaining gaps was tried and lost (50.4% -> 49.6%), which is the
      // real saturation point for this sample size.
      //
      // The reason is a limit of the tool, stated here so nobody spends another
      // day on it: LIFT IS A MARGINAL ASSOCIATION, NOT A CONDITIONAL EFFECT.
      // These features are correlated (`-no-content` fires only inside
      // `dialogue-act`, which fires mostly inside `named-agent`), so fitting each
      // independently to its own marginal double-counts the shared part. The
      // first fit won big because the SIGNS were wrong, and sign errors dominate
      // everything else. With the signs right, marginal fitting has nothing left.
      //
      // Do not refit expecting a gain. The remaining headroom is in a signal that
      // does not exist yet, or in EXTRACTION — which is where every real gain in
      // this file has actually come from.

      // The verb class still identifies WHAT KIND of event a clause describes,
      // which the type channel needs, but it does not predict whether the clause
      // is a real event, so it no longer moves the ranking.
      // ★★ THE TYPE CHANNEL IS SEPARABLE BUT NOT USABLE, and both halves of that
      // are worth knowing.
      //
      // This was long documented as "the verb class identifies WHAT KIND of event
      // a clause describes but does not predict WHETHER it is one". That was an
      // ARTIFACT: `analyse-event-signals` split every signal on ":" and collapsed
      // all eight types into one "verb" bucket, whose lift is near zero because
      // the good and bad types cancel. Keeping `verb:<type>` whole (851
      // candidates) shows they separate strongly:
      //
      //     state-change  +9.3  (+11.2 major)     revelation    -10.1
      //     departure     +8.2                    arrival        -8.4
      //     action        +7.0                    confrontation  -7.8
      //     decision      +6.4   (+3.6 major)
      //
      // So the types DO carry information. Scoring them still LOSES: at the full
      // measured lift precision@3 went 47.4% -> 46.4%, and at half weight 45.5%.
      // Both reverted.
      //
      // The reason is the one that has caught every marginal-lift fit in this
      // file: `revelation` is the default type for most dialogue acts, so its
      // -10.1pp is largely `dialogue-act`'s -15.2pp measured a second time.
      // Adding it double-counts a penalty the scorer already applies.
      //
      // Recorded rather than deleted because the SEPARATION is real and a future
      // model that fits jointly — rather than from marginals — could use it. The
      // measurement bug is fixed either way, so the next person sees true numbers.
      if (cand.type !== "unclassified") why.push(`verb:${cand.type}`);

      // ─── HOW RELIABLE IS THIS ENGINE ON THIS KIND OF EVENT ────────────────
      //
      // The verb class already scores. What it does not carry is how often the
      // engine turns out to be RIGHT when it fires that class, and those rates
      // are far apart. Measured on DEV books, share of detections landing on a
      // real gold event (mean ~36%):
      //
      //     decision      45.7%  (n=70)     departure     39.3%  (n=28)
      //     action        43.8%  (n=64)     arrival       33.3%  (n=27)
      //     state-change  40.5%  (n=79)     revelation    29.1%  (n=117)
      //                                     confrontation 26.3%  (n=57)
      //
      // Revelation and confrontation together are the largest slice of output
      // and the least trustworthy part of it, which is a self-knowledge the
      // ranker had no way to express.
      //
      // ★★ AND IT IS OFF, BECAUSE IT DID NOT SURVIVE THE HELD-OUT BOOKS. This is
      // the most useful measurement in this file; read it before reinventing the
      // idea, because on DEV it looks unarguable.
      //
      //     DEV       0 -> 51.7   2 -> 52.5   4 -> 53.3   7 -> 54.6   11 -> 53.8
      //     HELD OUT  0 -> 44.6                           7 -> 42.4
      //
      // On DEV that is a clean monotonic climb to a real peak, +2.9 points,
      // exactly what a genuine signal looks like. Held out it LOSES 2.2, and
      // major-events-shown loses 2.1 with it.
      //
      // The reason is a double-dip that is easy to miss. The seven-value SHAPE
      // was read off the DEV hit rates, and then the scale was swept on DEV as
      // well. Only the scale LOOKED like a fitted parameter; in truth eight
      // numbers were fitted on the books the sweep then scored. A single swept
      // scalar is not automatically safe when the vector it multiplies came out
      // of the same data.
      //
      // Kept at 0 rather than deleted, in the same spirit as the LM salience
      // blend below: the mechanism plus its measurement is worth more than
      // either alone. Retrying this honestly needs type rates from a source the
      // sweep never sees.
      if (typePriorWeight !== 0) score += typePriorWeight * (TYPE_RELIABILITY[cand.type] ?? 0);

      // ─── Agent kind ────────────────────────────────────────────────────────
      //
      // ENTITY SUBJECT IS NOW THE STRONGEST SIGNAL IN THE ENGINE, on both axes:
      // +28.4pp for finding any event and +24.2pp for finding a MAJOR one, at a
      // 53.7% hit rate against a 30.0% base. Which makes sense once stated: a
      // major event is usually the WORLD changing, not a person making a gesture.
      // "The council adopted the resolution", "The Axiom Spire departed".
      //
      // It was already the best major predictor at the previous fit, and it was
      // useless anyway, because it fired on 6 of 205 candidates and no weight can
      // reach that far. Reweighting it was tried then and moved nothing. What
      // moved it was fixing WHY there were only six: the noun-phrase walk in
      // `findEntitySubject` was overshooting the head into prepositional phrases,
      // so 81.3% of entity subjects then failed to find a verb. It now fires 41
      // times, and the weight has somewhere to act.
      //
      // Note that a pronoun subject has gone from the best any-hit agent signal to
      // a mild negative. It did not get worse; it stopped being the only thing in
      // the room.
      // ─── REFUTED: cancelling the entity bonus on PASSIVE clauses ──────────
      //
      // The reasoning was sound and the measurement still said no, so it is
      // recorded here rather than retried. "Green Gables builds" ships at 77%
      // confidence and salience MAJOR from "Green Gables was built at the
      // furthest edge of his cleared land" — a sentence describing a house —
      // and entity-subject (+0.82) is the strongest signal in the engine. Since
      // that bonus exists to reward an entity ACTING, and a passive subject is
      // what was acted upon, cancelling it there looked like a free correction.
      //
      // Measured on DEV: precision@3 51.7 -> 50.8, major shown unchanged. AND IT
      // DID NOT FIX ITS OWN TARGET CASE: the chip was still there, identical,
      // because "Green Gables" is classified `named`, not `entity`, so the bonus
      // being cancelled was never the one paying for that chip.
      //
      // The lesson is about method, not about passives: confirm which signal is
      // actually funding a bad output (`why` carries it) before writing a rule
      // aimed at a different one. The real defect in that example is upstream —
      // a place name resolving as a character-shaped agent.
      if (cand.agentKind === "entity") { score += 0.82; why.push("entity-subject"); }
      else if (cand.agentKind === "pronoun") { score += 0.25; why.push("pronoun-agent"); }
      else if (cand.agentKind === "named") { score -= 0.62; why.push("named-agent"); }

      // An entity subject that named or counted nothing. This USED TO BE A GATE
      // that returned null, on the reasoning that a change to the world worth
      // reporting arrives with a name or a number attached. Measured, that was
      // wrong: these candidates hit at 47.4% and reach a major event 36.8% of the
      // time, both far above base. Within entity subjects they are worth -11.7pp
      // (nested lift, not the confounded raw +18.8pp), so they are worse than a
      // specified one and much better than nothing. A penalty, not a gate.
      if (cand.unspecifiedEntity) { why.push("unspecified-entity"); }

      // Dialogue was the largest source of false positives once measured. It is
      // still where many real events live, so this is a penalty and not a gate.
      if (cand.channel === "dialogue") { score -= 0.61; why.push("dialogue-act"); }
      // Nested within dialogue-act: -4.6pp for any hit but +2.5pp for a major one.
      // Small and contradictory, so it stays small.
      if (cand.channel === "dialogue" && !cand.object) { score -= 0.34; why.push("-no-content"); }

      // Object class, inverted from the previous version. A "consequential"
      // object turned out to mark institutional discussion rather than
      // institutional action.
      {
        const head = cand.object?.split(/\s+/).pop()?.toLowerCase() ?? "";
        if (head && CONSEQUENTIAL_OBJECTS.has(head)) { score -= 0.75; why.push("consequential"); }
        else if (head && TRIVIAL_OBJECTS.has(head)) { why.push("-trivial-object"); }
        // Flipped sign at fit #2: +5.9pp then, -13.3pp now, on 42 firings.
        if (head && PRONOUN_HEADS.has(head)) { score -= 0.14; why.push("-pronoun-object"); }
      }

      // Mood. Habitual was the strongest bonus at fit #1 (+11.6pp) and measures
      // exactly 0.0pp now, so it is recorded and no longer scored — the realis
      // gate it comes from is doing its work at extraction instead. Pluperfect
      // went positive to negative; modal stayed negligible either way.
      if (mood.habitual)   { score -= 0.16; why.push("-habitual"); }
      if (mood.pluperfect) { score += 0.22; why.push("-pluperfect"); }
      if (mood.modal)      { score -= 0.15; why.push("-modal"); }
      if (mood.gnomic)     { why.push("-general-truth"); }
      // Negation measures -6.7pp any / -9.7pp major on 29 firings. A clause about
      // something NOT happening is usually a character's reflection on it.
      if (mood.negated)    { why.push("refusal"); }
      if (mood.interrogative && cand.channel === "dialogue") { why.push("-question"); }

      // Recurrence. Also went from +8.0pp to -1.4pp between fits, which is now
      // inside the noise on 62 firings. Recorded, not scored.
      const persist = persistence(contentWords(text), suffixCounts[pi]);
      if (persist < 0.08) { score += 0.30; why.push("-no-echo"); }

      // Tension rise measured NEGATIVE, so it is recorded and not scored. The
      // three-level ordinal signal it derives from is probably too coarse to
      // carry a derivative; revisit if tension ever becomes continuous.
      if (tension && pi > 0 && ((tension[pi] ?? 0) - (tension[pi - 1] ?? 0)) >= 0.25) {
        why.push("tension-rise");
      }

      // ─── WHERE IN THE CHAPTER, as a continuous prior ──────────────────────
      //
      // This used to be two cliffs at the extreme edges (pos < 0.04, pos > 0.98),
      // each firing on about four candidates. The real signal is a gradient
      // across the WHOLE chapter, and it is large. Measured over 74 gold
      // chapters, P(a detected event is real | the decile it sits in):
      //
      //     0-10%  20.7%   40-50%  30.7%   80-90%  44.3%
      //    10-20%  36.9%   50-60%  26.9%   90-100% 58.0%
      //    20-30%  19.5%   60-70%  26.9%
      //    30-40%  31.5%   70-80%  33.8%
      //
      // Gold events put 1.52x as much weight in the second half as the first,
      // and the final decile alone holds 19.7% of all of them (2x uniform)
      // against 20.8% of the majors. The engine's own candidates, by contrast,
      // are FLAT across position (0.99x): it was blind to this entirely, so the
      // prior adds evidence rather than double-counting something already scored.
      //
      // This is a structural fact about chapters, not a clause feature — a
      // chapter ends on its turn — which is why no amount of better clause
      // analysis was ever going to recover it.
      //
      // The weight is FITTED, the first fitted parameter in this engine, so the
      // gold set gained a DEV/TEST split by book at the same time; see the header
      // of scripts/test-event-detect.ts. Swept on DEV only.
      const pos = pi / Math.max(1, paraCount - 1);
      score += positionPriorWeight * (pos - 0.5);
      if (pos >= 0.8) why.push("late-chapter");
      // The very first paragraphs stay a hard penalty on top of the ramp: an
      // opening line is scene-setting far more reliably than the ramp alone says.
      if (pos < 0.04) { score -= 1.2; why.push("-chapter-open"); }

      candidates.push({ ...cand, score, why });
    }
  }

  if (!candidates.length) return [];
  // The ENGINE must not enforce the timeline's chip budget. The gold set has a
  // chapter with nine events and a chapter with two; capping the engine at four
  // put a hard ceiling of 44% on recall for the eventful one. Return everything
  // that clears the confidence floor, ranked, and let each surface slice what it
  // has room for.
  // ★ The ENGINE must not enforce the timeline's chip budget, and this cap was
  // doing exactly that. `min(10, ceil(paraCount / 6))` gives a 30-paragraph
  // chapter five events; the gold annotation for one such chapter has EIGHT, so
  // the cap alone held recall to 5/8 before a single scoring rule was consulted.
  // On a 215-paragraph Sherlock story it allowed ten events across 258 paragraphs
  // and every one of that chapter's eight major events was missed.
  //
  // Measured, raising it:
  //     cap 10   major recall 28.8%   precision 31.2%
  //     cap 40   major recall 40.7%   precision 25.5%
  //
  // Overall precision falls because it is computed over everything emitted. But
  // the timeline renders the top four BY CONFIDENCE, so what a writer actually
  // sees is precision@4, which the suite now reports separately. Return the
  // ranked list; let each surface slice what it has room for.
  const cap = options.maxEvents ?? Math.max(6, Math.min(40, Math.ceil(paraCount / 3)));
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
  windowNames: readonly string[] = [],
): Candidate | null {
  // A named character or pronoun first; failing that, a definite noun phrase.
  _funnel.sentences++;
  const primary = findAgent(text, nameRe, carried, recurringCaps, windowNames);
  if (primary) _funnel.agentNamedOrPronoun++; else _funnel.entityTried++;
  let agent = primary ?? findEntitySubject(text);
  // Fallback ONLY — cannot change any clause that already finds a subject.
  let bodyOffset = 0;
  if (!agent) {
    bodyOffset = frontedAdverbialLength(text);
    if (bodyOffset > 0) {
      const body = text.slice(bodyOffset);
      agent = findAgent(body, nameRe, carried, recurringCaps, windowNames) ?? findEntitySubject(body);
      if (!agent) bodyOffset = 0;
    }
  }
  if (!agent) return null;
  const ENT = agent.kind === "entity";
  if (ENT) _funnel.entityFound++;
  let unspecifiedEntity = false;

  const after = text.slice(bodyOffset + agent.end);
  const words = after.split(/\s+/).filter(Boolean);

  const verb = findVerb(words);
  if (!verb) {
    if (ENT) { _funnel.entityNoVerb++; sample(_funnelSamples.noVerb, `[${agent.name}] ⟩⟩ ${after.trim().slice(0, 90)}`); }
    else _funnel.personNoVerb++;
    return null;
  }

  // An unrecognised verb is not evidence of an event. Emitting it as
  // `unclassified` was how "She thinks about hands" and "Helia feels" reached
  // the timeline at confidence 0.7+; those are descriptions of a mind, and a
  // chip that says one is worse than no chip.
  if (!verb.base || !CHANGE_VERBS[verb.base]) {
    if (ENT) { _funnel.entityVerbNotChange++; sample(_funnelSamples.notChange, `${verb.surface}\t[${agent.name}] ⟩⟩ ${text.slice(0, 78)}`); }
    else { _funnel.personVerbNotChange++; sample(_funnelSamples.personNotChange, `${verb.surface}\t[${agent.name}] ⟩⟩ ${text.slice(0, 78)}`); }
    return null;
  }

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
      _funnel.entityWrongType++;
      return null;
    }
    if (!isSpecified(text)) { _funnel.entityUnspecified++; unspecifiedEntity = true; } // PROBE A: gate → signal
  }

  // ── Motion is not an event unless it changes the situation.
  //
  // "She leaves room", "She goes lecture", "She reaches transit bay", "Campus
  // comes alive" — a chapter about walking to a lecture generates a dozen of
  // these, and none of them is a thing that happened. Arrival and departure earn
  // a chip only when the clause says WHERE or WHO, which is the difference
  // between crossing a room and crossing a border.
  if ((type === "arrival" || type === "departure") && !isSpecified(text)) {
    if (ENT) _funnel.entityArrivalDeparture++;
    return null;
  }

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
  let object = findObject(words.slice(verb.at + 1).join(" "));
  // A label whose object repeats its own agent says nothing: "Tom commits Tom",
  // "Tom accuses Tom". It happens when the attribution name also appears inside
  // the utterance, which modern dialogue does constantly. Drop the object rather
  // than the candidate — the act is still real, only the content is unusable.
  if (object && agent.name && object.toLowerCase().includes(agent.name.toLowerCase())) {
    object = null;
  }

  // ── A physical act is not an event unless it acts on something that matters.
  //
  // `action` is the widest verb class here, and the out-of-distribution audit
  // caught it flooding: 54.0% of all events on the HELD-OUT manuscript, worse
  // single-type dominance than the engine this replaces. A domestic novel is made
  // of people opening doors and pouring drinks.
  if (type === "action") {
    const head = object?.split(/\s+/).pop()?.toLowerCase() ?? "";
    if (!head || WEAK_HEADS.has(head) || TRIVIAL_OBJECTS.has(head)) {
      // No object, or one that carries nothing. Only survives if the clause names
      // or counts something, which is what a consequential act does.
      if (!isSpecified(text)) { if (ENT) _funnel.entityActionWeakObject++; return null; }
    }
  }

  // ── A clause whose subject is weather, light or the passage of time is
  // description. "Winter passes", "Sky begins early transition", "Cold comes
  // north". Narrowed to exactly that set on purpose: rejecting EVERY trivial
  // subject also killed "The smell of the interior arrived when Vey pushed the
  // door open" and "The thing below hears differently…", both real major events
  // whose subjects only sound incidental.
  if (agent.kind === "entity" && AMBIENT_SUBJECTS.has(agent.name.split(/\s+/).pop()!.toLowerCase())) {
    _funnel.entityAmbient++;
    return null;
  }
  if (ENT) _funnel.entitySurvived++; else _funnel.personSurvived++;

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
    unspecifiedEntity,
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
  addressee?: string,
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
    act = classifyUtterance(inner);
    verbSurface = UTTERANCE_VERB[act] ?? "says";
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
    // ★ Discourse markers FIRST. Every strip below is ANCHORED to the start of
    // the utterance, and spoken lines overwhelmingly open with a connective —
    // "And you know how hard...", "But I'm not going to keep her", "Well, what
    // of it?". One leading "And" defeated every anchor at once, which is how
    // "Marilla tells you know" and "Marilla commits I'm" shipped: the frame
    // strips never fired, so the frame became the object.
    .replace(/^(?:(?:And|But|So|Well|Oh|Now|Then|Still|Yet|Besides|Anyway|Indeed|Why|Surely|Perhaps|Of course|Nonsense)[,!]?\s+){1,2}/i, "")
    // An imperative opens with its verb ("Come see where I live"), and findObject
    // stops at the first verb-shaped word — so the object came back empty and the
    // event was penalised out of existence. Drop the imperative verb first.
    .replace(/^(?:Come|Go|Look|Listen|Tell|Show|Take|Give|Wait|Stop|Let)\s+(?:and\s+)?/i, "")
    .replace(/^(?:I\s+(?:know|knew|noticed|saw|realised|realized|understood|remember|remembered|said|told you)|You\s+\w+|yes|no|all right|agreed|very well)\b[,.]?\s*/i, "")
    .replace(/^(?:I|you|we|he|she|they|it)\s*(?:'(?:ve|d|m|re|ll|s)|am|are|is|was|were|have|had|has|will|would)?\b\s*/i, "")
    .replace(/^(?:that|the|a|an|when|it|about|there|this)\s+/i, "")
    .trim();
  // ── Object selection for dialogue, by INFORMATIVENESS rather than position.
  //
  // findObject takes the first one or two content words, which is right for
  // narration ("closed the door") and wrong for speech, where the informative
  // part can be anywhere. Darcy's answer to "who?" is the whole utterance
  // "Miss Elizabeth Bennet.", and taking the first content words gave "Miss".
  //
  // A proper noun inside an utterance is the strongest available signal of what
  // the utterance is ABOUT, so prefer one when it is present and is not merely
  // the sentence-initial capital.
  const properNoun = (content.length >= 4 ? content : inner)
    .replace(/^\s*\S+\s*/, "")
    .match(/\b((?:Miss|Mrs|Mr|Lady|Lord|Sir|Doctor|Dr)\.?\s+)?[A-Z][a-z']{2,}(?:\s+[A-Z][a-z']{2,})?/);
  const object =
    (properNoun && !SENTENCE_OPENERS.has(properNoun[0].trim().split(/\s+/)[0].toLowerCase())
      ? properNoun[0].replace(/^(?:Miss|Mrs|Mr|Lady|Lord|Sir|Doctor|Dr)\.?\s+/, "").trim()
      : null) ?? findObject(content.length >= 4 ? content : inner);
  // NOTE: dropping an object that merely REPEATS the speaker ("Tom accuses Tom")
  // was tried here and cost 0.5 points of precision@3 without moving Gatsby at
  // all. The echo is ugly in a label but it is apparently carrying signal — a
  // speaker named inside their own utterance is often being addressed BY someone,
  // which is a real cue. Left in place deliberately.

  // A speech act with no recoverable content ("Edis tells", "Qesh tells", and on
  // Austen "Elizabeth tells", "Bingley tells", "Lady Catherine tells") points at
  // nothing. It is the largest class of false positive on every gold set measured
  // so far. Whether to REJECT or merely penalise is an empirical question that
  // changed answer once the corpus stopped being one author, so it is a flag.
  if (STRICT_DIALOGUE_CONTENT) {
    const head = object?.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!head || PRONOUN_HEADS.has(head)) return null;
  }

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
    addressee: addressee && addressee !== seg.speaker ? addressee : undefined,
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
 *   floor   emitted   precision   major recall   F1      type
 *   0.34      61        32.8%        56.0%       37.7%   55.0%
 *   0.42      55        36.4%        56.0%       40.0%   55.0%   <- here
 *   0.48      52        36.5%        52.0%       39.2%   57.9%
 *   0.54      46        34.8%        44.0%       35.2%   56.3%
 *
 * ★ These numbers are from the 45-event / 11-chapter gold set. An earlier
 * 22-event / 5-chapter version of the same set reported F1 55.8% for the SAME
 * code. The larger set is the honest one; the small one was optimistic by nearly
 * twenty points. Do not quote a figure without saying which set produced it.
 *
 * Two things the sweeps have now shown twice, worth internalising:
 *   · the optimum floor MOVES when the candidates change, so re-sweep after any
 *     change to the gates, never carry a threshold forward
 *   · precision here is flat across the whole usable range (32-37%), which means
 *     the threshold cannot fix it. The false positives score as high as the true
 *     positives. That is a candidate-quality problem and it is the open one.
 *
 * The floor is also what lets a quiet chapter return one event or none. The old
 * engine took its top three clusters unconditionally and reported 2.67 events
 * per chapter whether or not the chapter contained any; the gold set's quiet
 * chapters contain 2 events across 29 and 65 paragraphs.
 */
const CONFIDENCE_FLOOR = 0.18;
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

  const kept: Array<{ c: Candidate; conf: number; label: string }> = [];
  // ── Two chips with the SAME TEXT carry one chip's worth of information.
  //
  // A Christmas Carol chapter 1 emitted "Scrooge accuses" three times, at
  // confidence 0.71, 0.71 and 0.50, alongside "Scrooge commits" and "Ghost
  // commits" — all of them attributed utterances whose content could not be
  // extracted, so the label collapsed to agent plus speech act. Each one occupied
  // a slot in a timeline that shows four.
  //
  // The label has to be built HERE rather than after selection, which is why this
  // did not exist: you cannot deduplicate on something you compute later. Ranked
  // order means the survivor is the highest-confidence instance.
  const seenLabels = new Set<string>();
  for (const entry of ranked) {
    if (entry.conf < floor) continue;
    // Non-maximum suppression: the highest-scoring clause in a neighbourhood
    // wins the neighbourhood. Ranked order means the winner is already first.
    const clash = kept.some(
      (k) => Math.abs(k.c.paragraphIndex - entry.c.paragraphIndex) <= MIN_SEPARATION_PARAGRAPHS,
    );
    if (clash) continue;
    const verbSurface = entry.c.channel === "dialogue"
      ? entry.c.verbBase
      : toPresent(entry.c.verbBase, entry.c.agent);
    const label = buildLabel(entry.c.agent, verbSurface, entry.c.object, entry.c.addressee);
    const key = label.toLowerCase();
    if (seenLabels.has(key)) continue;
    // A CONTENT-LESS label is subsumed by one that shares its agent and verb and
    // actually says something. "Scrooge accuses" adds nothing beside "Scrooge
    // accuses particular"; the reverse is not true, so only the empty one yields.
    const stem = `stem:${entry.c.agent ?? ""}|${entry.c.verbBase}`.toLowerCase();
    if (!entry.c.object && seenLabels.has(stem)) continue;
    seenLabels.add(stem);
    seenLabels.add(key);
    kept.push({ ...entry, label });
    if (kept.length >= maxEvents) break;
  }

  // `major` is the top of the chapter's own distribution rather than a fixed
  // cut, because event density genuinely varies between chapters.
  const majorCut = kept.length ? Math.max(0.62, kept[0].conf - 0.12) : 1;

  // `kept` is already in selection order, so the index IS the rank. Capture it
  // BEFORE the display sort below, which destroys that order.
  return kept
    .map(({ c, conf, label }, rank) => {
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
        rank,
        agent: c.agent,
        channel: c.channel,
        why: c.why,
      };
    })
    .sort((a, b) => a.tensionPosition - b.tensionPosition);
}

// ─── Optional async pass: LM salience re-ranking ───────────────────────────────
/**
 * Re-rank and prune the sync engine's events using the embedding model's
 * plot-event-vs-description score.
 *
 * WHY THIS IS A SEPARATE, LATER PASS rather than part of detection:
 *
 * Detection is synchronous and runs on the deferred story-graph path; embeddings
 * are async and only reachable in Electron's main process (or under Node in the
 * suites). Making detection async would push a promise through `analyzeChapter`,
 * the worker boundary and the panel. So the engine emits its best sync guess, the
 * UI shows it immediately, and this refines it when a model is available — the
 * same two-phase shape the story graph already uses for dedup.
 *
 * `scorer` is injected rather than imported so this module keeps no dependency on
 * the LM, and so the suites can substitute a stub.
 */
export interface SalienceRefineOptions {
  /** Returns one score per clause. Positive = reads like a plot event. */
  scorer: (clauses: string[]) => Promise<number[]>;
  /** Optional second scorer: how central each clause is to the chapter's subject.
   *  Its WEIGHT may be negative; see chapterCentrality's header on why the sign
   *  is measured rather than assumed. */
  centrality?: (clauses: string[]) => Promise<number[]>;
  /** Weight for the centrality term. Set from measured lift. */
  centralityWeight?: number;
  /** Drop events below this. Tuned by the suite; see the sweep in its comments. */
  minSalience?: number;
  /** ★ The prune's override: an event whose SYNC confidence (pre-blend) is at
   *  least this survives even below minSalience. The -0.05 cut deletes real
   *  majors from the rail (18 on DEV when measured); structural evidence
   *  strong enough should outvote the embedding. Unset = pure cut. */
  keepFloor?: number;
  /** How hard the LM score moves the ranking, relative to the sync confidence. */
  weight?: number;
}

export async function refineEventSalience(
  events: NarrativeEvent[],
  options: SalienceRefineOptions,
): Promise<NarrativeEvent[]> {
  if (events.length === 0) return events;
  const sentences = events.map((e) => e.sentence);
  const scores = await options.scorer(sentences);
  const central = options.centrality ? await options.centrality(sentences) : null;
  const centralityWeight = options.centralityWeight ?? 0;
  const minSalience = options.minSalience ?? -Infinity;
  const weight = options.weight ?? 0.5;

  const keepFloor = options.keepFloor ?? Infinity;
  const rescored = events.map((e, i) => {
    const s = scores[i] ?? 0;
    const syncConfidence = e.confidence;
    // Blend rather than replace. The sync score carries structural evidence the
    // LM cannot see (realis mood, agent kind, object class); the LM carries
    // semantic evidence the structure cannot. Neither should win outright.
    const c = central?.[i] ?? 0;
    const blended = Math.max(0, Math.min(1, e.confidence + weight * s + centralityWeight * c));
    return {
      ...e,
      confidence: Number(blended.toFixed(3)),
      why: [
        ...e.why,
        `lm-salience:${s.toFixed(2)}`,
        ...(central ? [c >= 0.35 ? "central" : "peripheral"] : []),
      ],
      _salience: s,
      _sync: syncConfidence,
    };
  });

  // ★ RE-ASSIGN RANK. This pass rewrites `confidence`, so the rank the detector
  // stamped is stale the moment it runs — and rank is what every renderer now
  // selects on. Leaving it meant the LM could re-score all it liked while the
  // timeline still drew the detector's original pick. `rank` means "selection
  // order as of the most recent scoring pass", and any future pass that touches
  // confidence owes the same three lines.
  return rescored
    .filter((e) => e._salience >= minSalience || e._sync >= keepFloor)
    .sort((a, b) => b.confidence - a.confidence)
    .map(({ _salience, _sync, ...e }, rank) => { void _salience; void _sync; return { ...e, rank }; })
    .sort((a, b) => a.tensionPosition - b.tensionPosition);
}
