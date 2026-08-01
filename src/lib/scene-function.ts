/**
 * scene-function.ts — what is this part of the chapter DOING?
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 *
 * The scene label sits directly above a colour that already encodes tension.
 * So the only useful label is one that says something the colour does not. The
 * engine this replaces failed that test numerically: measured across 1566
 * scenes of real prose, ONE expression —
 *
 *     avgDialogueDensity > 0.25 ? 'friction' : 'undercurrent'
 *
 * — produced 65% of every label a reader ever saw, and 51% of the label's
 * information was already carried by the colour. The remaining vocabulary was
 * mostly synonyms for loud (tense / intense / pressure / impact / combat), so
 * the word next to a red bar said "red". That is what makes a label feel like
 * a gimmick: it is confident, it is decorative, and it is not informative.
 *
 * ── What replaces it ────────────────────────────────────────────────────────
 *
 * The organising axis is MODE — Dwight Swain's scene/sequel alternation. A
 * *scene* is proactive: a character pursues a goal against opposition. A
 * *sequel* is reactive: they absorb the outcome, weigh it, and decide. Prose
 * gives this away — sequels run on interiority, past-perfect and deliberative
 * modals; scenes run on transitive verbs, motion, and dialogue that pushes.
 *
 * TEXTURE then supplies the concrete word (discovery, negotiation, arrival,
 * weighted silence) when its own evidence is strong enough to earn it.
 *
 * Story Grid's VALUE SHIFT was the intended second axis and was built, measured
 * and then removed — see the long note above GATE_BASE. It could not beat its
 * own permutation null at any scene length. That note is the most important
 * thing in this file; read it before adding anything that claims a direction.
 *
 * ── The rule that does most of the work ─────────────────────────────────────
 *
 * ★ ABSTENTION. Every candidate must pass a hard GATE (real evidence for that
 *   specific reading, not "nothing else matched"), then clear an absolute
 *   FLOOR, then beat the runner-up by a MARGIN. If no candidate does, the
 *   scene gets NO label. Silence is more honest than "tense", and an engine
 *   that can say nothing is the difference between a reading and a decoration.
 *
 * Nothing here is a generative model — it is lexical and grammatical evidence
 * scored additively, which is the constraint this app runs under.
 */

import { stripQuotes } from "./prose-segments";

// ── Public shape ───────────────────────────────────────────────────────────

export type Tension = "calm" | "rising" | "high";

/** Which side of the Swain alternation the prose is sitting on. */
export type SceneMode = "proactive" | "reactive" | "ambient";

export interface SceneFunction {
  /** The word shown to the writer. */
  label: string;
  /** Winning margin over the runner-up, 0–1. Drives the UI's emphasis. */
  confidence: number;
  mode: SceneMode;
}

export interface SceneFunctionInput {
  /** The scene's paragraphs, in order. */
  paragraphs: string[];
  /** Per-paragraph dialogue density, parallel to `paragraphs`. */
  dialogueDensity: number[];
  tension: Tension;
  /** Tension of the scene before this one — the only way to see an aftermath. */
  prevTension?: Tension;
  /** Label of the scene before this one, so we do not say it twice running. */
  prevLabel?: string;
}

// ── Lexicons ───────────────────────────────────────────────────────────────
//
// Unigrams live in Sets and are matched against a tokenised scene: one pass,
// O(1) per lookup. Multi-word phrases are a separate, deliberately short list
// matched by indexOf. Keeping those apart is what stops this from becoming the
// hundred-substring-scans-per-paragraph shape it replaces.

const W = (s: string) => new Set(s.trim().split(/\s+/));

/** Cognition and perception — the spine of a Swain sequel. */
const INTERIOR = W(`
  thought thoughts thinking wondered wonder wondering realised realized
  realising realizing knew know knowing understood understand understanding
  remembered remember remembering recalled recollected considered considering
  imagined imagining supposed suspected doubted doubting believed believing
  felt feeling feelings sensed noticed observed perceived reflected pondered
  mused reasoned wished hoped feared dreaded regretted resented pictured
  memory memories mind conscience awareness
`);

/** Decision-shaped grammar — the dilemma and decision beats. */
const DELIBERATE = W(`
  should ought must decide decided deciding decision choose chose choosing
  choice chance option alternative whether either neither resolve resolved
  determined intend intended meant plan planned purpose
`);
const DELIBERATE_PHRASES = [
  "had to", "no choice", "would have to", "what to do", "or else",
  "made up her mind", "made up his mind", "make up her mind", "make up his mind",
  "could not decide", "couldn't decide", "the only way", "nothing else for it",
  "there was nothing", "if she", "if he", "if they",
];

/** Transitive, goal-directed action — a character doing rather than dwelling. */
const AGENCY = W(`
  took taking seized opened open pulled pull pushed push carried carry
  searched search sought lifted raised dragged drew threw thrust struck
  gathered fetched built made unlocked locked cut tore struck placed set
  handed offered gave passed poured filled emptied wrote signed
`);

/** Motion through space — pursuit, flight, arrival all need it. */
const MOTION = W(`
  went go going came come coming walked walk ran run running hurried hurry
  rushed rode riding drove driving climbed climb crossed cross entered enter
  left leaving departed arrived arrive approached approaching followed follow
  chased pursued fled flee fleeing escaped escape retreated advanced marched
  turned wandered strode stepped stumbled hastened
`);
const ARRIVAL_PHRASES = [
  "came to", "arrived at", "arrived in", "reached the", "stepped into",
  "walked into", "entered the", "made his way", "made her way", "made their way",
  "set out", "drew up at", "came upon", "found himself in", "found herself in",
];

/** Opposition — someone pushing back. Kept narrower than the old list so that
 *  ordinary vigorous narration does not read as conflict. */
const OPPOSE = W(`
  demanded challenged confronted refused refusing refuse insisted accused
  denied protested objected argued arguing quarrelled quarreled contradicted
  snapped retorted interrupted forbade resisted defied opposed rebuked
  scolded threatened warned reproached
`);
const OPPOSE_PHRASES = [
  "would not", "will not have", "i forbid", "how dare", "you have no right",
  "said nothing more", "turned on her", "turned on him",
];

/** Physical violence, kept separate from opposition — a fight is not an argument. */
const VIOLENCE = W(`
  blood bloody wound wounded blade knife sword dagger gun pistol shot fired
  struck strike blow blows fist fists punched kicked stabbed slashed seized
  grappled wrestled choked throat crushed smashed shattered hurled flung
  staggered reeled crumpled bruised broken
`);

/** Fear and threat — the affect that turns motion into flight. */
const FEAR = W(`
  afraid fear feared frightened terrified terror dread dreadful panic
  panicked alarm alarmed horror horrified desperate desperation helpless
  trembling trembled shaking shuddered danger dangerous peril threat menace
`);

/** Withholding — the scene where the meaningful thing is what is not said. */
const SILENCE = W(`
  silence silent silently quiet stillness speechless wordless mute hush
`);
const SILENCE_PHRASES = [
  "said nothing", "without a word", "no words", "could not speak",
  "couldn't speak", "refused to answer", "refused to look", "looked away",
  "turned away", "did not answer", "made no reply", "no reply", "in silence",
];

/** Revelation — a thing becoming known. The discovery beat. */
const REVEAL = W(`
  discovered discover discovery revealed reveal revelation confessed confession
  admitted admission learned learnt uncovered exposed disclosed betrayed
  truth secret secrets proof evidence
`);
const REVEAL_PHRASES = [
  "for the first time", "all along", "it became clear", "the truth was",
  "it occurred to", "now she knew", "now he knew", "had always known",
  "never told", "had been lying", "found out",
];

/** Place and sensation — the establishing register. */
const MILIEU = W(`
  light sunlight lamplight shadow shadows darkness dark air wind rain snow
  cold warm warmth heat sun moon sky cloud clouds sea shore river hill road
  street lane garden window windows door doorway room hall stair stairs
  house cottage church trees tree grass field silence smell scent sound
  morning evening afternoon night dusk dawn twilight fire hearth
`);

/** Bargaining register — negotiation as distinct from argument. */
const BARGAIN = W(`
  offer offered offering propose proposed proposal terms agree agreed
  agreement bargain deal promise promised accept accepted refuse condition
  conditions exchange arrange arranged persuade persuaded convince
`);

// ── Valence ────────────────────────────────────────────────────────────────
// A compact fiction-tuned charge lexicon. This does not need to be a sentiment
// model; it needs to detect that a scene ENDS somewhere other than it started.
// Used only as a scene-wide bag count; see the value-shift note below for why
// the seductive third-vs-third DELTA is not here.

const POSITIVE = W(`
  joy joyful happy happiness glad gladly delight delighted pleasure pleased
  smile smiled smiling laugh laughed laughing laughter warm warmth kind
  kindness gentle tender love loved loving affection friend friendship
  comfort comforted safe safety relief relieved hope hopeful bright beautiful
  lovely sweet peace peaceful calm content contented grateful thank thanked
  triumph triumphant victory won win success succeeded free freedom saved
  rescue rescued healed recovered welcome blessing blessed praise admired
  agreed together reunited forgave forgiven
`);

const NEGATIVE = W(`
  grief grieved sorrow sad sadness misery miserable wretched despair
  desperate anguish agony pain painful ache aching suffering suffered
  wound wounded hurt harm cruel cruelty bitter bitterly angry anger rage
  fury furious hatred hate hated afraid fear feared terror terrified dread
  horror horrified shame ashamed guilt guilty disgrace humiliated
  lonely loneliness alone abandoned betrayed betrayal lost losing loss dead
  death died dying kill killed murder ruin ruined destroyed broke broken
  failure failed fail refused denied cold dark darkness ill illness sick
  weep wept crying cried tears sob sobbed trembling danger doubt doubtful
  worse wrong error mistake regret sorry
`);

// ── Feature extraction ─────────────────────────────────────────────────────

interface Features {
  words: number;
  paras: number;
  dialogue: number;
  /** All rates below are hits per 100 words. */
  interior: number;
  deliberate: number;
  agency: number;
  motion: number;
  oppose: number;
  violence: number;
  fear: number;
  silence: number;
  reveal: number;
  milieu: number;
  bargain: number;
  retro: number;
  question: number;
  /** −1…+1 overall charge. */
  charge: number;
  /** The scene opens by moving into a place. */
  arrivalOpen: boolean;
  /** A decision verb lands in the closing third — Swain's decision beat. */
  decisionLate: boolean;
  tension: Tension;
  prevTension?: Tension;
}

const TOKEN_RE = /[a-z][a-z']*/g;

function tokenise(lower: string): string[] {
  return lower.match(TOKEN_RE) ?? [];
}

/** Count set members present, and phrases by substring, as a per-100-word rate. */
function rate(hits: number, words: number): number {
  return words > 0 ? (hits * 100) / words : 0;
}

function countSet(tokens: string[], set: Set<string>): number {
  let n = 0;
  for (const t of tokens) if (set.has(t)) n++;
  return n;
}

function countPhrases(lower: string, phrases: readonly string[]): number {
  let n = 0;
  for (const p of phrases) if (lower.includes(p)) n++;
  return n;
}

/** Past perfect ("had seen", "had been") — the grammar of looking back. */
const RETRO_RE = /\bhad\s+(?:been|not\s+)?[a-z]+(?:ed|en|t)\b/g;
const RETRO_PHRASES = ["years ago", "used to", "long before", "as a child", "in those days", "once, when"];

/**
 * Signed charge of a token run.
 *
 * ★ THE SMOOTHING IS NOT COSMETIC. An unsmoothed (pos−neg)/(pos+neg) on a
 *   short run is quantised to ±1 and ±0.5, so two stray negative words in a
 *   closing third produced a full-magnitude "the scene turned" reading. A
 *   permutation test (scripts/probe-scene-function.ts) showed that estimator
 *   sat inside its own shuffled noise floor: it was measuring which end of the
 *   scene the lexicon happened to like.
 *
 *   Additive smoothing shrinks weak counts toward zero, and MIN_CHARGE_HITS
 *   refuses to report a charge at all below real evidence. Returns null for
 *   "no reading", which is distinct from 0.0 meaning "balanced".
 */
const CHARGE_SMOOTHING = 3;
const MIN_CHARGE_HITS = 4;

function chargeOf(tokens: string[]): number | null {
  let pos = 0, neg = 0;
  for (const t of tokens) {
    if (POSITIVE.has(t)) pos++;
    else if (NEGATIVE.has(t)) neg++;
  }
  const total = pos + neg;
  if (total < MIN_CHARGE_HITS) return null;
  return (pos - neg) / (total + CHARGE_SMOOTHING);
}

function extract(input: SceneFunctionInput): Features {
  const joined = input.paragraphs.join("\n");
  const lower = joined.toLowerCase();
  const tokens = tokenise(lower);
  const words = tokens.length;

  // ★ THE MODE FEATURES READ NARRATION ONLY.
  //
  // Swain's sequel is the NARRATION dwelling — not a character saying "I
  // think". Measured on the full text, a pure-dialogue scene of two people
  // arguing about a third scored as `reflection`, because "I am quite of your
  // opinion" and "I have been meditating" are interiority words sitting inside
  // quotation marks. Reading Pride & Prejudice ch.5 is what surfaced it; no
  // aggregate metric would have, because the label was still informative and
  // still non-redundant with tension. It was simply wrong.
  //
  // Content features (fear, reveal, silence, violence, bargain, deliberate)
  // stay on the FULL text: those are legitimately spoken. Only the features
  // that decide what the PROSE is doing are narration-scoped.
  const narration = stripQuotes(joined).toLowerCase();
  const nTokens = tokenise(narration);
  const nWords = Math.max(1, nTokens.length);

  const dialogue =
    input.dialogueDensity.length > 0
      ? input.dialogueDensity.reduce((a, b) => a + b, 0) / input.dialogueDensity.length
      : 0;

  // ── Valence trajectory ──────────────────────────────────────────────────
  // Thirds by WORD count, not paragraph count: a scene whose first paragraph
  // is 400 words and whose next six are 20 each would otherwise have its
  // "opening third" swallow the whole scene.
  const third = Math.floor(words / 3);

  // A decision verb landing late is Swain's decision beat; the same verb early
  // is just someone having already decided offstage.
  const tailText = tokens.slice(Math.max(0, words - Math.max(60, third))).join(" ");
  const decisionLate =
    /\b(?:decided|resolved|determined|would|must)\b/.test(tailText) &&
    (countSet(tokenise(tailText), DELIBERATE) >= 2 ||
      countPhrases(tailText, DELIBERATE_PHRASES) >= 1);

  // Does the scene OPEN by moving into somewhere? Narration-scoped for the
  // same reason as the rest of the mode features: a character SAYING "I walked
  // into the room" is not the prose arriving anywhere.
  const opening = narration.slice(0, 340);
  // ★ AN ARRIVAL PHRASE IS REQUIRED — loose motion words are not enough.
  //   This used to also accept "two or more MOTION tokens in the opening",
  //   and MOTION contains bare `go` and `come`, which are overwhelmingly
  //   HYPOTHETICAL in deliberation: "He could stay and let the thing happen,
  //   or he could go and try to stop it" tripped it twice and shipped
  //   `arrival` over a scene whose whole subject is a man deciding not to move
  //   yet. Nobody arrives anywhere in a sentence about what they could do.
  const arrivalOpen = countPhrases(opening, ARRIVAL_PHRASES) >= 1;

  const retroHits =
    (narration.match(RETRO_RE)?.length ?? 0) + countPhrases(narration, RETRO_PHRASES);

  return {
    words,
    paras: input.paragraphs.length,
    dialogue,
    // ── narration-scoped: what the PROSE is doing ──
    interior: rate(countSet(nTokens, INTERIOR), nWords),
    agency: rate(countSet(nTokens, AGENCY), nWords),
    motion: rate(countSet(nTokens, MOTION), nWords),
    milieu: rate(countSet(nTokens, MILIEU), nWords),
    retro: rate(retroHits, nWords),
    // Attribution verbs ("she insisted") are narration; the phrases are spoken.
    oppose: rate(
      countSet(nTokens, OPPOSE) + countPhrases(lower, OPPOSE_PHRASES), nWords),
    // ── full-text: content that is legitimately spoken ──
    deliberate: rate(
      countSet(tokens, DELIBERATE) + countPhrases(lower, DELIBERATE_PHRASES), words),
    violence: rate(countSet(tokens, VIOLENCE), words),
    fear: rate(countSet(tokens, FEAR), words),
    silence: rate(
      countSet(tokens, SILENCE) + countPhrases(lower, SILENCE_PHRASES), words),
    reveal: rate(
      countSet(tokens, REVEAL) + countPhrases(lower, REVEAL_PHRASES), words),
    bargain: rate(countSet(tokens, BARGAIN), words),
    question: rate((joined.match(/\?/g) ?? []).length, words),
    charge: chargeOf(tokens) ?? 0,
    arrivalOpen,
    decisionLate,
    tension: input.tension,
    prevTension: input.prevTension,
  };
}

// ── Candidates ─────────────────────────────────────────────────────────────

/** Saturating normaliser: 0 at 0, →1 as x grows, no cliff at the threshold. */
const sat = (x: number, k: number) => (x <= 0 ? 0 : x / (x + k));
/** Inverse: high when the feature is ABSENT. */
const lacks = (x: number, k: number) => 1 - sat(x, k);

interface Candidate {
  label: string;
  mode: SceneMode;
  /** Hard evidence requirement. A candidate that cannot pass this is never
   *  considered — which is what stops a label from meaning "nothing else fit". */
  gate: (f: Features) => boolean;
  /** Graded support, in 0…1. See GATE_BASE for why this range is mandatory. */
  score: (f: Features) => number;
}

/**
 * ★ EVERY CANDIDATE SCORES ON THE SAME SCALE: GATE_BASE for passing its gate,
 *   plus a `score` in 0…1 for how strongly the evidence supports it.
 *
 *   The first version of this file let each candidate invent its own scale.
 *   Some carried a large additive constant and some were pure saturating sums
 *   topping out near 0.6, so the ranking was decided by the parameterisation
 *   rather than by the prose: the six labels with the biggest constants took
 *   84% of all output, and `reflection` — gated in 129 times — shipped 3.
 *   If you add a candidate, its `score` MUST stay in 0…1 or it will quietly
 *   outrank everything else for reasons that have nothing to do with writing.
 */
const GATE_BASE = 1;

/**
 * ★★ THERE IS NO VALUE-SHIFT LABEL HERE, AND THAT IS A MEASURED DECISION.
 *
 * Story Grid's value shift is the most attractive idea in the craft literature
 * for this job, and an earlier revision of this file shipped it: `setback`,
 * `upturn`, `reversal` and `stalemate`, decided by the valence of a scene's
 * opening third against its closing third. Across DEV they looked excellent —
 * 39% of all output, a plausible spread, no obvious errors when spot-read.
 *
 * They were naming coin flips. A permutation test (the shift family's tokens
 * shuffled, so any trajectory is destroyed while length, vocabulary and charge
 * totals are held identical) found NO enrichment over chance at any scene
 * length. In the only bucket with enough magnitude to compare — scenes of 600+
 * words — the SHUFFLED text scored higher than the real text (null p90 0.160
 * vs real p90 0.143).
 *
 * The reason is arithmetic, not lexicon quality: a median scene is 116 words,
 * a third of it is 39, and 39 words of fiction carry two or three charge words.
 * A difference between two three-sample estimates is noise wearing the shape of
 * a trajectory. No amount of lexicon tuning fixes a sample size.
 *
 * ★ DO NOT REINSTATE THIS WITHOUT RE-RUNNING scripts/probe-scene-function.ts
 *   AND BEATING THE NULL. A confident word attached to a coin flip is exactly
 *   the defect this rewrite existed to remove; it is worse than the tension
 *   synonyms it replaced, because it is not even correlated with anything.
 *
 * Scene-wide `charge` SURVIVES and is used by `reckoning` and `aftermath`.
 * That is a far weaker and better-evidenced claim — "this scene's vocabulary
 * is dark" is a bag count over the whole scene, not a direction over thirds.
 */

/**
 * ★ Every label below names a different narrative FUNCTION. If two entries
 *   could be swapped without changing what a writer learns, one of them is a
 *   synonym and does not belong here. That was the old vocabulary's disease:
 *   tense / intense / pressure / impact / combat were five words for red.
 */
/**
 * ★ GATE THRESHOLDS ARE SET FROM THE CORPUS DISTRIBUTION, NOT BY TASTE.
 *   Every threshold below sits near the p80–p90 of its own feature measured
 *   over 1566 real scenes, so a gate means "this scene is unusually X" rather
 *   than "X occurs". The first draft ignored this and half the gates sat ABOVE
 *   the p90 of the feature they tested — `oppose` has a p90 of 0.17 per 100
 *   words and three separate gates demanded ≥ 0.9, which is why `stalemate`
 *   was considered zero times in the whole corpus.
 *   Re-run scripts/probe-scene-function.ts after touching any of these.
 */
const CANDIDATES: Candidate[] = [
  // ── Reactive: the Swain sequel ──────────────────────────────────────────
  {
    label: "reflection",
    mode: "reactive",
    // ★ `charge >= -0.1` keeps this MUTUALLY EXCLUSIVE with `reckoning` below.
    //   They were competing on overlapping gates and reckoning lost every time
    //   (gated in 24, top scorer twice), which is not a ranking — it is two
    //   labels for one reading with the tie broken by weight arithmetic.
    //   Sibling labels must be separated by a gate, never by a score.
    // `!decisionLate` separates this from `resolve`. In Swain's sequel these
    // are SEQUENTIAL phases — reaction and dilemma, then decision — not rival
    // readings, so a scene that reaches a decision is a resolve and this must
    // not compete with it. Left competing, the two split 1.726 vs 1.678 and
    // the margin rule threw away a correct answer.
    gate: (f) =>
      f.interior >= 0.9 && f.charge >= -0.1 && !f.decisionLate &&
      f.dialogue < 0.3 && f.oppose < 0.3 && f.violence < 0.5,
    score: (f) =>
      0.5 * sat(f.interior, 1.8) + 0.25 * sat(f.retro, 1.2) + 0.25 * lacks(f.agency, 2),
  },
  {
    label: "reckoning",
    mode: "reactive",
    // The same interior turn, but facing something dark — and it must be
    // facing something SPECIFIC (a memory, or a thing become known).
    gate: (f) => f.interior >= 0.8 && f.charge < -0.1 && (f.retro >= 0.5 || f.reveal >= 0.25),
    score: (f) =>
      0.4 * sat(f.interior, 1.8) + 0.3 * sat(f.reveal, 0.4) +
      0.2 * sat(-f.charge, 0.2) + 0.1 * sat(f.retro, 0.8),
  },
  {
    label: "aftermath",
    mode: "reactive",
    gate: (f) => f.prevTension === "high" && f.tension !== "high" && f.agency < 2.0 && f.oppose < 0.4,
    score: (f) =>
      0.4 * sat(f.milieu, 2.5) + 0.3 * sat(-f.charge, 0.3) + 0.3 * lacks(f.dialogue * 10, 3),
  },
  {
    label: "resolve",
    mode: "reactive",
    gate: (f) => f.deliberate >= 0.85 && f.decisionLate,
    score: (f) => 0.6 * sat(f.deliberate, 1.2) + 0.4 * sat(f.interior, 1.8),
  },
  {
    label: "misgiving",
    mode: "reactive",
    gate: (f) => f.deliberate >= 0.7 && f.question >= 0.35 && f.charge <= 0 && !f.decisionLate,
    score: (f) =>
      0.45 * sat(f.deliberate, 1.2) + 0.35 * sat(f.question, 1.2) + 0.2 * sat(f.interior, 1.8),
  },

  // ── Proactive: the Swain scene ──────────────────────────────────────────
  {
    label: "confrontation",
    mode: "proactive",
    gate: (f) => f.oppose >= 0.35 && f.dialogue >= 0.25,
    score: (f) =>
      0.55 * sat(f.oppose, 0.5) + 0.3 * sat(f.dialogue * 10, 3) + 0.15 * sat(f.question, 1.2),
  },
  {
    label: "friction",
    mode: "proactive",
    // Deliberately the MILDER sibling of confrontation and non-overlapping
    // with it, so the two never compete for the same scene.
    gate: (f) => f.oppose >= 0.16 && f.oppose < 0.35 && f.dialogue >= 0.22,
    score: (f) => 0.55 * sat(f.oppose, 0.3) + 0.45 * sat(f.dialogue * 10, 3),
  },
  {
    label: "pursuit",
    mode: "proactive",
    gate: (f) => f.motion >= 1.6 && f.agency >= 0.9 && f.dialogue < 0.35,
    score: (f) =>
      0.5 * sat(f.motion, 2.2) + 0.35 * sat(f.agency, 1.8) + 0.15 * lacks(f.interior, 1.8),
  },
  {
    label: "flight",
    mode: "proactive",
    gate: (f) => f.motion >= 1.5 && f.fear >= 0.45 && f.tension !== "calm",
    score: (f) =>
      0.45 * sat(f.motion, 2.2) + 0.4 * sat(f.fear, 0.8) + 0.15 * sat(f.violence, 1.2),
  },
  {
    label: "negotiation",
    mode: "proactive",
    gate: (f) => f.dialogue >= 0.32 && f.bargain >= 0.25 && f.violence < 0.5,
    score: (f) =>
      0.55 * sat(f.bargain, 0.5) + 0.3 * sat(f.dialogue * 10, 3) + 0.15 * lacks(f.oppose, 0.5),
  },
  {
    label: "discovery",
    mode: "proactive",
    gate: (f) => f.reveal >= 0.3,
    score: (f) => 0.7 * sat(f.reveal, 0.6) + 0.3 * sat(f.interior, 1.8),
  },

  // ── Undertone: pressure without a visible cause ─────────────────────────
  {
    label: "undercurrent",
    mode: "ambient",
    gate: (f) => f.tension === "rising" && f.oppose < 0.25 && f.violence < 0.6 && f.dialogue < 0.45,
    score: (f) =>
      0.4 * sat(f.interior, 1.8) + 0.3 * sat(f.fear, 0.8) + 0.3 * sat(f.silence, 0.4),
  },
  {
    label: "weighted silence",
    mode: "ambient",
    // ★ THE DISCRIMINATOR IS DIALOGUE, NOT OPPOSITION. This is the scene where
    //   the meaningful thing is what is NOT said, so it cannot be full of
    //   speech — whereas a confrontation is people talking at each other.
    //
    //   Gating on `oppose` instead looked right and was wrong: "refused to
    //   explain herself" and "would not look at him" score as opposition while
    //   MEANING withholding, so the guard threw out the very scene the label
    //   exists for (it broke test-tension-scene's refusal case) while a
    //   shouting match still scored 1.723 against confrontation's 1.728.
    //   Dialogue separates the two concepts cleanly and says what we mean.
    gate: (f) => f.silence >= 0.3 && f.dialogue < 0.25,
    score: (f) => 0.7 * sat(f.silence, 0.5) + 0.3 * sat(f.interior, 1.8),
  },

  // ── Establishing ────────────────────────────────────────────────────────
  {
    label: "arrival",
    mode: "proactive",
    gate: (f) => f.arrivalOpen && f.milieu >= 1.9 && f.dialogue < 0.35 && f.oppose < 0.3,
    score: (f) => 0.55 * sat(f.milieu, 2.5) + 0.45 * sat(f.motion, 2.2),
  },
  {
    label: "stillness",
    mode: "ambient",
    gate: (f) =>
      f.tension === "calm" && f.dialogue < 0.1 && f.interior < 0.7 &&
      f.milieu >= 2.2 && f.agency < 1.4 && f.oppose < 0.2,
    score: (f) => 0.6 * sat(f.milieu, 2.5) + 0.4 * lacks(f.agency, 1.5),
  },
];

// ── Decision ───────────────────────────────────────────────────────────────

/** Absolute evidence a winner must carry: the gate plus real graded support.
 *  With GATE_BASE = 1 this means "passing the gate alone is not enough". */
const FLOOR = 1.2;
/** How far clear of the runner-up the winner must be. */
const MARGIN = 0.08;

/**
 * Classify one scene. Returns null when the evidence does not support any
 * single reading — which is a correct and frequent answer, not a failure.
 */
export function classifyScene(input: SceneFunctionInput): SceneFunction | null {
  if (input.paragraphs.length === 0) return null;
  const f = extract(input);
  // Too little text to say anything honest about function.
  if (f.words < 45) return null;

  const scored: Array<{ c: Candidate; s: number }> = [];
  for (const c of CANDIDATES) {
    if (!c.gate(f)) continue;
    scored.push({ c, s: GATE_BASE + c.score(f) });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.s - a.s);

  let winner = scored[0];
  let runnerUp = scored[1]?.s ?? 0;

  // ★ NEVER SAY THE SAME WORD TWICE RUNNING. The reader already has that word
  //   on screen directly above; repeating it adds nothing and reads as the
  //   engine having exactly one idea (the old one repeated 35% of the time).
  //   If a second reading clears the floor, use it; otherwise say nothing and
  //   let the label above stand for both scenes — consecutive same-function
  //   scenes are usually one scene the grouper over-split anyway.
  //
  //   An earlier version compared the winner against a runner-up that defaults
  //   to 0 when there is no second candidate, so a lone winner always "insisted"
  //   and the guard never fired at all.
  if (input.prevLabel && winner.c.label === input.prevLabel) {
    const alt = scored[1];
    if (!alt || alt.s < FLOOR) return null;
    winner = alt;
    runnerUp = scored[2]?.s ?? 0;
  }

  if (winner.s < FLOOR) return null;
  if (winner.s - runnerUp < MARGIN) return null;

  return {
    label: winner.c.label,
    confidence: Math.min(1, (winner.s - runnerUp) / 0.8),
    mode: winner.c.mode,
  };
}

/** Exposed for the accuracy harness only. */
export const _internals = { extract, CANDIDATES, FLOOR, MARGIN };
