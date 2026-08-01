// Lightweight regex-based action-sentence detector.
//
// Returns absolute character ranges in the input text for sentences that
// contain at least one common action verb (movement, manipulation, combat,
// eating, sensory). The HighlightLayer wraps these ranges in a tinted
// border-box span so action beats stand out from dialogue and exposition.
//
// This is intentionally heuristic — no NLP, no parsing. Cheap to call per
// render. False positives are acceptable; the visual treatment is light.

import { rerankAdaptiveCandidates } from "./adaptive-inference";
import type {
  AdaptiveCandidateOption,
  AdaptiveInferenceContext,
} from "../types";

const ACTION_VERBS = new Set([
  // Locomotion
  "walk","walked","walks","walking",
  "run","ran","runs","running",
  "step","stepped","steps","stepping",
  "stride","strode","strides","striding","stridden",
  "pace","paced","paces","pacing",
  "march","marched","marches","marching",
  "jump","jumped","jumps","jumping",
  "leap","leaped","leapt","leaps","leaping",
  "climb","climbed","climbs","climbing",
  "crawl","crawled","crawls","crawling",
  "slide","slid","slides","sliding",
  "dash","dashed","dashes","dashing",
  "sprint","sprinted","sprints","sprinting",
  "rush","rushed","rushes","rushing",
  "hurry","hurried","hurries","hurrying",
  "bolt","bolted","bolts","bolting",
  "stagger","staggered","staggers","staggering",
  "stumble","stumbled","stumbles","stumbling",
  // Posture
  "sit","sat","sits","sitting",
  "stand","stood","stands","standing",
  "lie","lay","lies","lying",
  "kneel","knelt","kneels","kneeling",
  "lean","leaned","leant","leans","leaning",
  "crouch","crouched","crouches","crouching",
  "rise","rose","rises","rising","risen",
  "fall","fell","falls","falling","fallen",
  // Hands / manipulation
  "reach","reached","reaches","reaching",
  "grab","grabbed","grabs","grabbing",
  "snatch","snatched","snatches","snatching",
  "pick","picked","picks","picking",
  "hold","held","holds","holding",
  "push","pushed","pushes","pushing",
  "pull","pulled","pulls","pulling",
  "throw","threw","throws","throwing","thrown",
  "toss","tossed","tosses","tossing",
  "catch","caught","catches","catching",
  "open","opened","opens","opening",
  "close","closed","closes","closing",
  "shut","shuts","shutting",
  "lift","lifted","lifts","lifting",
  "drop","dropped","drops","dropping",
  "place","placed","places","placing",
  "set","sets","setting",
  "press","pressed","presses","pressing",
  "tap","tapped","taps","tapping",
  "knock","knocked","knocks","knocking",
  "wave","waved","waves","waving",
  "point","pointed","points","pointing",
  // Eating / drinking
  "eat","ate","eats","eating","eaten",
  "drink","drank","drinks","drinking","drunk",
  "bite","bit","bites","biting","bitten",
  "chew","chewed","chews","chewing",
  "sip","sipped","sips","sipping",
  "swallow","swallowed","swallows","swallowing",
  "taste","tasted","tastes","tasting",
  // Combat
  "punch","punched","punches","punching",
  "kick","kicked","kicks","kicking",
  "hit","hits","hitting",
  "strike","struck","strikes","striking",
  "slash","slashed","slashes","slashing",
  "stab","stabbed","stabs","stabbing",
  "shoot","shot","shoots","shooting",
  "fire","fired","fires","firing",
  "block","blocked","blocks","blocking",
  "dodge","dodged","dodges","dodging",
  "parry","parried","parries","parrying",
  "swing","swung","swings","swinging",
  // Face / body language
  "smile","smiled","smiles","smiling",
  "grin","grinned","grins","grinning",
  "frown","frowned","frowns","frowning",
  "scowl","scowled","scowls","scowling",
  "nod","nodded","nods","nodding",
  "shake","shook","shakes","shaking","shaken",
  "shrug","shrugged","shrugs","shrugging",
  "blink","blinked","blinks","blinking",
  "wink","winked","winks","winking",
  // Eyes / orientation
  "look","looked","looks","looking",
  "glance","glanced","glances","glancing",
  "stare","stared","stares","staring",
  "watch","watched","watches","watching",
  "turn","turned","turns","turning",
  "face","faced","faces","facing",
  // Movement of others
  "follow","followed","follows","following",
  "lead","led","leads","leading",
  "chase","chased","chases","chasing",
  "flee","fled","flees","fleeing",
  // Door / entry
  "enter","entered","enters","entering",
  "leave","left","leaves","leaving",
  "exit","exited","exits","exiting",
  "cross","crossed","crosses","crossing",
  // Misc physical
  "move","moved","moves","moving",
  "stop","stopped","stops","stopping",
  "wait","waited","waits","waiting",
  "pause","paused","pauses","pausing",
  "breathe","breathed","breathes","breathing",
  "wipe","wiped","wipes","wiping",
  "brush","brushed","brushes","brushing",
  "stroke","stroked","strokes","stroking",
  "clutch","clutched","clutches","clutching",
  "draw","drew","draws","drawing","drawn",
  "raise","raised","raises","raising",
  "lower","lowered","lowers","lowering",
  // ── Families the first list missed, found the honest way: the owner
  //    caught "lit" unhighlighted. Irregular pasts are exactly what a
  //    suffix-based eye skips, so every family here lists ALL its forms.
  // Fire / light
  "light","lit","lights","lighting","lighted",
  "extinguish","extinguished","extinguishes","extinguishing",
  "snuff","snuffed","snuffs","snuffing",
  "kindle","kindled","kindles","kindling",
  "burn","burned","burnt","burns","burning",
  // Carrying / force
  "carry","carried","carries","carrying",
  "drag","dragged","drags","dragging",
  "haul","hauled","hauls","hauling",
  "heave","heaved","hove","heaves","heaving",
  "hoist","hoisted","hoists","hoisting",
  "shove","shoved","shoves","shoving",
  "yank","yanked","yanks","yanking",
  "tug","tugged","tugs","tugging",
  "fling","flung","flings","flinging",
  "hurl","hurled","hurls","hurling",
  "slam","slammed","slams","slamming",
  "bang","banged","bangs","banging",
  "seize","seized","seizes","seizing",
  "grip","gripped","grips","gripping",
  "grasp","grasped","grasps","grasping",
  "clasp","clasped","clasps","clasping",
  "squeeze","squeezed","squeezes","squeezing",
  // Fine hands
  "fold","folded","folds","folding",
  "unfold","unfolded","unfolds","unfolding",
  "wrap","wrapped","wraps","wrapping",
  "tie","tied","ties","tying",
  "untie","untied","unties","untying",
  "fasten","fastened","fastens","fastening",
  "button","buttoned","buttons","buttoning",
  "pour","poured","pours","pouring",
  "spill","spilled","spilt","spills","spilling",
  "scatter","scattered","scatters","scattering",
  "gather","gathered","gathers","gathering",
  "tuck","tucked","tucks","tucking",
  "pin","pinned","pins","pinning",
  "pat","patted","pats","patting",
  "slap","slapped","slaps","slapping",
  "rub","rubbed","rubs","rubbing",
  "scratch","scratched","scratches","scratching",
  "tear","tore","torn","tears","tearing",
  // Body / motion
  "spin","spun","spins","spinning",
  "twist","twisted","twists","twisting",
  "bend","bent","bends","bending",
  "straighten","straightened","straightens","straightening",
  "stretch","stretched","stretches","stretching",
  "spring","sprang","sprung","springs","springing",
  "duck","ducked","ducks","ducking",
  "dive","dove","dived","dives","diving",
  "sink","sank","sunk","sinks","sinking",
  "plunge","plunged","plunges","plunging",
  "scramble","scrambled","scrambles","scrambling",
  "vault","vaulted","vaults","vaulting",
  "mount","mounted","mounts","mounting",
  "slip","slipped","slips","slipping",
  "trip","tripped","trips","tripping",
  "tumble","tumbled","tumbles","tumbling",
  "collapse","collapsed","collapses","collapsing",
  "creep","crept","creeps","creeping",
  "sweep","swept","sweeps","sweeping",
  "cling","clung","clings","clinging",
  "hang","hung","hangs","hanging",
  "wear","wore","worn","wears","wearing",
  "ride","rode","ridden","rides","riding",
  "drive","drove","driven","drives","driving",
  "fly","flew","flown","flies","flying",
  "wander","wandered","wanders","wandering",
  "stroll","strolled","strolls","strolling",
  "limp","limped","limps","limping",
  "shuffle","shuffled","shuffles","shuffling",
  "hop","hopped","hops","hopping",
  "trot","trotted","trots","trotting",
  "gallop","galloped","gallops","galloping",
  "kneel","knelt","kneeled","kneels","kneeling",
  "fetch","fetched","fetches","fetching",
  // The everyday transfers the first two passes both missed — caught by the
  // owner's stress story, where "Mira gave him the whiskey" and "He took the
  // chair" were not even action sentences.
  "take","took","taken","takes","taking",
  "give","gave","given","gives","giving",
  "put","puts","putting",
  "bring","brought","brings","bringing",
  "hand","handed","hands","handing",
  "arrive","arrived","arrives","arriving",
  "produce","produced","produces","producing",
  "wrestle","wrestled","wrestles","wrestling",
  "tune","tuned","tuning",
  "played","playing",
  "shouldered","shouldering",
  "bank","banked","banking",
]);

export interface ActionSpan {
  /** Start offset within the input text. */
  start: number;
  /** End offset (exclusive). */
  end: number;
}

export interface ActionPrediction {
  start: number;
  end: number;
  actor: string | null;
  confidence: number;
  needsReview: boolean;
  ambiguityGap: number;
  candidates: AdaptiveCandidateOption[];
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Smart action segmentation (HIGH mode) ────────────────────────────────────
//
// One sentence, one actor was the old contract, and long fiction sentences
// break it constantly: "Anne flung the window open while Marilla lit the lamp"
// is TWO actions by TWO people, and the old attribution — longest known name
// anywhere in the sentence — could not even reliably name ONE of them (the
// longest name wins, subject or not; "Marilla watched Anne" belonged to
// whoever had more letters).
//
// segmentActions splits an action sentence at clause joints and assigns each
// segment its own actor by SUBJECT position: the last known name (or resolved
// pronoun) BEFORE the segment's first action verb. Splitting is deliberately
// conservative — precision first, per the owner's brief: a joint must have a
// connective, a DIFFERENT known name in subject position on its right, and an
// action verb on both sides, or the sentence stays whole.

// ─── Gender evidence, for pronoun carry ───────────────────────────────────────
//
// "Mira gave him the whiskey. He took the chair across from Thomas." — the
// carry says Mira acted last, so a gender-blind resolver hands "He" to Mira.
// This is the single largest remaining class of wrong actor, and it does NOT
// need a name gazetteer (invented names are half this corpus). It needs
// evidence from the prose itself, gathered by high-precision rules only:
//
//   · an honorific immediately before the name          (weight 3)
//   · a gendered common noun in apposition to the name  (weight 2)
//   · a NOMINATIVE he/she later in the same sentence,
//     with no other known name in between               (weight 2)
//   · a sentence whose first known-name-free clause opens with He/She,
//     attributed to the last name in play               (weight 2)
//
// Accusative/possessive pronouns are deliberately ignored: "Mira gave HIM the
// whiskey" is the exact sentence that would poison her entry.

export type Gender = "male" | "female";

const MALE_HONORIFIC = /\b(?:mr|mister|sir|lord|master|captain|capt|king|prince|father|fr|brother|uncle)\.?\s+$/i;
const FEMALE_HONORIFIC = /\b(?:mrs|miss|ms|madam|madame|mme|lady|queen|princess|mother|sister|aunt|widow|dame)\.?\s+$/i;
const MALE_NOUN = /\b(?:man|men|boy|boys|gentleman|gentlemen|lad|fellow|husband|son|widower|nephew|king|prince)\b/i;
const FEMALE_NOUN = /\b(?:woman|women|girl|girls|lady|ladies|wife|daughter|mother|sister|aunt|widow|niece|queen|princess|maid)\b/i;
const NOMINATIVE_MALE = /\bhe\b/i;
const NOMINATIVE_FEMALE = /\bshe\b/i;
const OPENS_MALE = /^[\s"'\u201c\u2018(]*he\b/i;
const OPENS_FEMALE = /^[\s"'\u201c\u2018(]*she\b/i;

/**
 * Per-character gender, inferred from the chapter's own prose.
 *
 * Returns only CONFIDENT entries: an absolute margin of 2 and a 65% majority.
 * A name with mixed or thin evidence is simply absent, and every consumer must
 * treat absence as "unknown" rather than as a licence to guess — a wrong
 * gender is worse than none, because it would move an actor rather than leave
 * a neutral span.
 */
export function inferGender(
  text: string,
  knownNames: string[],
  /** Diagnostics sink — every bump with its reason, for probes. Cheap to skip. */
  trace?: Array<{ name: string; gender: Gender; weight: number; why: string; sentence: string }>,
): Map<string, Gender> {
  const score = new Map<string, { male: number; female: number }>();
  let bumpSentence = "";
  const bump = (name: string, g: Gender, w: number, why = "") => {
    const cur = score.get(name) ?? { male: 0, female: 0 };
    cur[g] += w;
    score.set(name, cur);
    trace?.push({ name, gender: g, weight: w, why, sentence: bumpSentence.slice(0, 70) });
  };
  const nameRes = knownNames.map((name) => ({
    name,
    re: new RegExp(`\\b${escapeRegex(name)}\\b`, "g"),
  }));

  // The name currently "in play" — what a bare He/She at the head of a
  // name-free sentence refers to. Reset by any sentence that names someone.
  let lastName: string | null = null;

  for (const [start, end] of sentenceBounds(text)) {
    const sentence = text.slice(start, end);
    bumpSentence = sentence;

    // Where does each known name sit in this sentence?
    const hits: Array<{ name: string; index: number }> = [];
    for (const { name, re } of nameRes) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sentence)) !== null) hits.push({ name, index: m.index });
    }
    hits.sort((a, b) => a.index - b.index);

    // A sentence that opens with He/She before naming anyone continues the
    // name in play.
    let opened = false;
    if (lastName && (hits.length === 0 || hits[0].index > 0)) {
      if (OPENS_MALE.test(sentence)) { bump(lastName, "male", 2, "opens-he"); opened = true; }
      else if (OPENS_FEMALE.test(sentence)) { bump(lastName, "female", 2, "opens-she"); opened = true; }
    }
    // A sentence that names NOBODY and uses exactly one gender's nominative
    // pronoun is also about the name in play — "This one, she thought,
    // watching the black water churn". Weaker, and never double-counted with
    // the opener above.
    if (lastName && !opened && hits.length === 0) {
      const m = NOMINATIVE_MALE.test(sentence);
      const f = NOMINATIVE_FEMALE.test(sentence);
      if (m && !f) bump(lastName, "male", 1, "nameless-he");
      else if (f && !m) bump(lastName, "female", 1, "nameless-she");
    }

    for (let i = 0; i < hits.length; i++) {
      const { name, index } = hits[i];
      const before = sentence.slice(Math.max(0, index - 12), index);
      if (MALE_HONORIFIC.test(before)) bump(name, "male", 3, "honorific");
      else if (FEMALE_HONORIFIC.test(before)) bump(name, "female", 3, "honorific");

      // Apposition: a gendered common noun close by, on either side.
      const nearAfter = sentence.slice(index + name.length, index + name.length + 45);
      const nearBefore = sentence.slice(Math.max(0, index - 30), index);
      const near = `${nearBefore} ${nearAfter}`;
      if (MALE_NOUN.test(near) && !FEMALE_NOUN.test(near)) bump(name, "male", 2, "noun");
      else if (FEMALE_NOUN.test(near) && !MALE_NOUN.test(near)) bump(name, "female", 2, "noun");

      // A nominative pronoun after this name, before the NEXT name.
      const stop = i + 1 < hits.length ? hits[i + 1].index : sentence.length;
      const between = sentence.slice(index + name.length, stop);
      if (NOMINATIVE_MALE.test(between) && !NOMINATIVE_FEMALE.test(between)) bump(name, "male", 2, "in-sentence-he");
      else if (NOMINATIVE_FEMALE.test(between) && !NOMINATIVE_MALE.test(between)) bump(name, "female", 2, "in-sentence-she");
    }

    // ★ THE NAME IN PLAY IS THE SUBJECT, NOT THE LAST NAME MENTIONED. Taking
    // the last one made "Thomas was the one who went out ... calling for Mira
    // to bring a blanket." hand the next sentence ("He came back in carrying a
    // boy") to Mira, and those two stray male points were exactly enough to
    // deadlock her real gender into "unknown". A clause-initial name is the
    // subject; failing that, a sentence naming exactly one person is about
    // that person; anything more ambiguous leaves the previous name in play
    // rather than guessing.
    if (hits.length > 0) {
      const distinct = [...new Set(hits.map((h) => h.name))];
      const head = sentence.replace(/^[\s"'\u201c\u2018(]+/, "");
      const initial = distinct.find((n) => head.startsWith(n));
      // ★ A PRONOUN-INITIAL SENTENCE DOES NOT CHANGE WHO IS IN PLAY. Its
      // subject is the pronoun — every name in it is an object. "He nodded
      // once at Mira" names exactly one person and is not about her, and
      // letting it hand the floor to Mira gave the following line ("he said")
      // to her too. Two stray points, and they were the difference between
      // knowing her gender and not.
      const pronounSubject = /^(?:he|she|they|it|we|i)\b/i.test(head);
      if (initial) lastName = initial;
      else if (!pronounSubject && distinct.length === 1) lastName = distinct[0];
    }
  }

  const out = new Map<string, Gender>();
  for (const [name, s2] of score) {
    const total = s2.male + s2.female;
    if (total === 0) continue;
    const [g, top, other] = s2.male >= s2.female
      ? ["male" as Gender, s2.male, s2.female]
      : ["female" as Gender, s2.female, s2.male];
    if (top - other >= 2 && top / total >= 0.65) out.set(name.toLowerCase(), g);
  }
  return out;
}

/** Words that mark the previous token as a SUBJECT doing something. Kept
 *  wide on purpose: this gate decides who may be an actor at all, and a gate
 *  must always be wider than what it guards. */
const VERBISH_AFTER_NAME = new Set([
  "was", "were", "is", "are", "had", "has", "have", "did", "does", "would",
  "could", "will", "shall", "should", "may", "might", "must", "began", "kept",
  "seemed", "felt", "knew", "thought", "wanted", "tried", "made", "let",
  "said", "asked", "replied", "answered", "told", "cried", "called", "spoke",
  "looked", "saw", "watched", "heard", "smiled", "laughed", "nodded", "sat",
  "stood", "went", "came", "left", "turned", "moved", "put", "took", "gave",
]);

/**
 * Which known names may be offered as an ACTOR.
 *
 * `knownNames` is a mixed pool — world-data cast, detected speakers, and
 * recurring capitalised words — so it carries entries like "Rank", "Yield",
 * "Some" and "Mars". Offering those as actors produced exactly those answers
 * on the corpus benchmark. A name earns actor candidacy the same way a
 * character does in prose: by ACTING (clause-initial, followed by something
 * verb-shaped) or by SPEAKING (handled by the caller, which knows the
 * attributed speakers).
 *
 * Deliberately generous — one qualifying sentence in the whole chapter is
 * enough, because the cost of excluding a real character is far higher than
 * the cost of admitting a borderline one.
 */
/**
 * Is this "name" just a common word that happened to start a sentence?
 *
 * "Rank", "Yield", "Some" and "Mars" were all being offered as actors, three
 * of them because a capitalised sentence opener got recruited into the name
 * pool. The test is evidence, not a stop-list: compare how often the word
 * appears LOWER-case against how often it appears capitalised in this very
 * text. "some" swamps "Some"; a character called Rose swamps the flower.
 * Multi-word names are exempt — "Lin Xiao" is nobody's common noun.
 */
export function isCommonWordName(name: string, text: string): boolean {
  if (/\s/.test(name) || name.length < 2) return false;
  const lower = name.toLowerCase();
  if (lower === name) return true; // never capitalised anywhere: not a name
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  const lowerHits = count(new RegExp(`(?<![\\w'])${escapeRegex(lower)}(?![\\w'])`, "g"));
  const capHits = count(new RegExp(`(?<![\\w'])${escapeRegex(name)}(?![\\w'])`, "g"));
  return lowerHits >= capHits;
}

export function actorCandidates(text: string, knownNames: string[]): Set<string> {
  const out = new Set<string>();
  const sorted = [...knownNames].sort((a, b) => b.length - a.length);
  for (const [start, end] of sentenceBounds(text)) {
    const sentence = text.slice(start, end).replace(/^[\s"'\u201c\u2018(]+/, "");
    for (const name of sorted) {
      if (out.has(name) || !sentence.startsWith(name)) continue;
      if (isCommonWordName(name, text)) continue;
      const rest = sentence.slice(name.length);
      if (!/^[\s,]/.test(rest)) continue;
      const next = rest.replace(/^[\s,]+/, "").split(/[\s,.;:]+/)[0]?.toLowerCase() ?? "";
      if (!next) continue;
      if (ACTION_VERBS.has(next) || VERBISH_AFTER_NAME.has(next) ||
          /(?:ed|ing)$/.test(next)) {
        out.add(name);
      }
    }
  }
  return out;
}

/** The gender a subject pronoun demands, or null when it demands nothing. */
export function pronounGender(pronoun: string): Gender | null {
  const p = pronoun.toLowerCase();
  if (p === "he") return "male";
  if (p === "she") return "female";
  return null;
}

export interface ActionSegment {
  /** Offsets within the SENTENCE this segment was cut from. */
  start: number;
  end: number;
  /** The assigned actor, resolved by subject position. */
  actor: string | null;
  /** Which rule assigned it, for the harness and the review UI.
   *  "collective" is a DECISION that nobody in particular acts ("they stood
   *  for a moment") — downstream must not let a carry resurrect an actor. */
  via: "subject" | "pronoun" | "anywhere" | "carry" | "none" | "collective";
}

const CLAUSE_CONNECTIVE = /\b(?:and|but|while|as|then|before|after|until)\s+/gi;
// Singular only. "They stood for a moment" is six people; resolving it to
// whoever acted last credits one person with a crowd's action.
const SUBJECT_PRONOUN_RE = /^(?:she|he)\b/i;
// Any pronoun subject. A clause whose SUBJECT is a pronoun must never take
// its actor from a name sitting in object position — "She thanked him from
// her heart, and then walked towards a table where Bingley..." is not
// Bingley acting. Only the carry may answer a pronoun; if the carry cannot,
// the honest answer is nobody.
const ANY_PRONOUN_SUBJECT = /^(?:she|he|they|i|we|it)\b/i;

/** All action-verb hits in `text`, as offsets. */
function actionVerbOffsets(text: string): number[] {
  const out: number[] = [];
  const wordRe = /[a-zA-Z]+/g;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(text)) !== null) {
    if (ACTION_VERBS.has(m[0].toLowerCase())) out.push(m.index);
  }
  return out;
}

/** The last known name that occurs strictly BEFORE `limit` in `text`. */
function lastNameBefore(
  text: string,
  limit: number,
  nameRes: Array<{ name: string; re: RegExp }>,
): { name: string; index: number } | null {
  let best: { name: string; index: number } | null = null;
  for (const { name, re } of nameRes) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index >= limit) break;
      if (!best || m.index > best.index) best = { name, index: m.index };
    }
  }
  return best;
}

/**
 * Split one action SENTENCE into per-actor segments and assign each.
 *
 * `carryingSpeaker` is the same carry the whole-sentence path uses; it decides
 * pronoun subjects and unattributed segments.
 */
export interface SegmentContext {
  /** Confident per-character gender, from inferGender over the whole chapter. */
  gender?: Map<string, Gender>;
  /** Actors seen recently, MOST RECENT FIRST. A subject pronoun whose gender
   *  the carry contradicts walks this list for the nearest actor that agrees. */
  recentActors?: readonly string[];
  /** ── REFUTED, kept as a note: a second-tier pool of names mentioned in ANY
   *  position, searched after recentActors when gender disagrees. The theory
   *  was that prose keeping its cast in object position ("Elizabeth thanked
   *  him... She walked towards a table") would supply the antecedent there.
   *  Measured: DEV masked recovery 37.7% before and after, held-out 23.1%
   *  before and after — the branch fires too rarely to matter, because a
   *  gender-disagreeing carry almost always has an agreeing ACTOR nearby.
   *  Reverted rather than left as dead weight. */
}

export function segmentActions(
  sentence: string,
  knownNames: string[],
  carryingSpeaker: string | null,
  context: SegmentContext = {},
): ActionSegment[] {
  // ★ CASE-EXACT. Character names are capitalised in prose, and a
  // case-blind match turned "the frank curiosity of someone" into the
  // peddler Frank acting in a scene he had not yet entered.
  const nameRes = [...knownNames]
    .sort((a, b) => b.length - a.length)
    .map((name) => ({ name, re: new RegExp(`\\b${escapeRegex(name)}\\b`, "g") }));

  // Candidate joints: a connective whose right side opens with a known name
  // (allowing one leading comma/space) followed within a few words by an
  // action verb. Both sides must contain an action verb or the joint is not
  // splitting two ACTIONS.
  const joints: number[] = [];
  CLAUSE_CONNECTIVE.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = CLAUSE_CONNECTIVE.exec(sentence)) !== null) {
    const rightStart = cm.index + cm[0].length;
    const right = sentence.slice(rightStart, rightStart + 60);
    const opensWithName = nameRes.some(({ re }) => {
      re.lastIndex = 0;
      const m = re.exec(right);
      return m !== null && m.index <= 2;
    });
    if (!opensWithName) continue;
    const leftVerbs = actionVerbOffsets(sentence.slice(0, cm.index));
    const rightVerbs = actionVerbOffsets(right);
    if (leftVerbs.length === 0 || rightVerbs.length === 0) continue;
    joints.push(cm.index);
  }

  // ★ PARTICIPLE LISTS — the construction the connective scan cannot see:
  // "Thomas at the flue with the poker, Frank hauling the chair back, Mira
  // flinging open the shutter, Elena keeping Lio's face turned away". Six
  // actors, zero connectives. A joint opens before `Name + (light adverbs) +
  // V-ing` when the name follows a comma or a dash, and before `— Name`
  // (the dash itself introduces a new clause). The left side may be a
  // verbless intro; the participle IS the verb.
  const PARTICIPLE_AFTER = /^\s*,?\s*(?:\w+ly,?\s+)*(?:still\s+|already\s+)?\w+ing\b/;
  for (const { re } of nameRes) {
    re.lastIndex = 0;
    let nm: RegExpExecArray | null;
    while ((nm = re.exec(sentence)) !== null) {
      if (nm.index === 0) continue;
      const before = sentence.slice(Math.max(0, nm.index - 4), nm.index);
      const after = sentence.slice(nm.index + nm[0].length, nm.index + nm[0].length + 40);
      const afterComma = /[,;]\s*$/.test(before) && PARTICIPLE_AFTER.test(after);
      const afterDash = /[—–]\s*$|--\s*$/.test(before);
      if (afterComma || afterDash) joints.push(nm.index);
    }
  }
  joints.sort((a, b) => a - b);
  // Collapse joints closer than a few words — one split point per clause.
  for (let i = joints.length - 1; i > 0; i--) {
    if (joints[i] - joints[i - 1] < 8) joints.splice(i, 1);
  }

  const bounds = [0, ...joints, sentence.length];
  const segments: ActionSegment[] = [];
  let prevActor: string | null = carryingSpeaker;

  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    const text = sentence.slice(start, end);
    const verbs = actionVerbOffsets(text);
    const firstVerb = verbs.length ? verbs[0] : text.length;

    // ── Collective subjects pin the segment to NOBODY. "They stood for a
    // moment", "the six of them stood blinking" — crediting the carry with a
    // crowd's action is exactly the kind of confident wrong answer that
    // costs more trust than a neutral span. Checked before every fallback.
    const head = text.replace(/^[\s,;—–-]+/, "").replace(/^(?:and|but|while|as|then|before|after|until|when)\s+/i, "")
      .replace(/^[\w\s,]*?(?=\b(?:they|everyone|nobody|both|all|the \w+ of them)\b)/i, "");
    if (/^(?:they|everyone|nobody|both|all of them|the \w+ of them)\b/i.test(head) &&
        !lastNameBefore(text, text.length, nameRes)) {
      segments.push({ start, end, actor: null, via: "collective" });
      continue;
    }

    // ── Subject position. A CLAUSE-INITIAL name is the subject whatever
    // follows — "Elena, before she let Lio go, tucked the wrapper" must not
    // let the subordinate clause's object (Lio) steal the slot. Otherwise,
    // the last name before the first action verb.
    const trimmed = text.replace(/^[\s,;—–-]+/, "");
    const lead = trimmed.match(/^(?:and\s+|but\s+|while\s+|as\s+|then\s+|before\s+|after\s+|until\s+)?/i);
    const headStart = text.length - trimmed.length + (lead?.[0]?.length ?? 0);
    let subject: { name: string; index: number } | null = null;
    for (const { name, re } of nameRes) {
      re.lastIndex = headStart;
      const m = re.exec(text);
      if (m && m.index === headStart) { subject = { name, index: m.index }; break; }
    }
    if (!subject) subject = lastNameBefore(text, firstVerb, nameRes);
    let actor: string | null = null;
    let via: ActionSegment["via"] = "none";
    if (subject) {
      actor = subject.name;
      via = "subject";
    } else if (ANY_PRONOUN_SUBJECT.test(text.trimStart()) && !prevActor) {
      // A pronoun subject with nothing to continue: say nobody, rather than
      // reach into the clause for a name that is not its subject.
      actor = null;
      via = "none";
    } else if (SUBJECT_PRONOUN_RE.test(text.trimStart()) && prevActor) {
      // "She lit the lamp" — the pronoun subject continues whoever last acted
      // or spoke. Only clause-INITIAL pronouns; "watched her" is an object.
      //
      // ★ GENDER AGREEMENT. "Mira gave him the whiskey. He took the chair
      // across from Thomas." — the carry says Mira, and a gender-blind
      // resolver hands Frank's action to her. When the chapter's own prose
      // gives a confident gender that CONTRADICTS the pronoun, the carry is
      // not the referent: walk back for the nearest actor that agrees, and
      // if none does, say nobody rather than name the wrong person.
      const want = pronounGender(text.trimStart().match(SUBJECT_PRONOUN_RE)?.[0] ?? "");
      const gender = context.gender;
      const carryGender = gender?.get(prevActor.toLowerCase()) ?? null;
      if (want && carryGender && carryGender !== want) {
        const agreeing = (context.recentActors ?? [])
          .find((a) => gender?.get(a.toLowerCase()) === want);
        actor = agreeing ?? null;
        via = agreeing ? "pronoun" : "none";
      } else {
        actor = prevActor;
        via = "pronoun";
      }
    } else if (ANY_PRONOUN_SUBJECT.test(text.trimStart())) {
      // "I"/"we"/"it" with a carry: continue it, but never scan the clause
      // for a name — same reason as above.
      actor = prevActor;
      via = "pronoun";
    } else {
      // No subject-side evidence. Fall back to the old behaviour — a name
      // anywhere in the segment, else the carry — so this path is never less
      // capable than the one it replaces.
      const anywhere = lastNameBefore(text, text.length, nameRes);
      if (anywhere) {
        actor = anywhere.name;
        via = "anywhere";
      } else if (prevActor) {
        actor = prevActor;
        via = "carry";
      }
    }
    segments.push({ start, end, actor, via });
    if (actor) prevActor = actor;
  }
  return segments;
}

function countNameMentions(text: string, name: string) {
  if (!text || !name) return 0;
  // Case-exact: names are capitalised in prose, and a case-blind count reads
  // "the frank curiosity of someone" as the peddler Frank.
  const re = new RegExp(`\\b${escapeRegex(name)}\\b`, "g");
  return (text.match(re) ?? []).length;
}

/**
 * Predict the actor performing an action sentence.
 *
 * Strategy (in order):
 *   1. Explicit name: any known character mentioned inside the action text
 *      itself wins — that's almost always the actor in fiction prose.
 *   2. Carrying speaker: the most recent attributed speaker (from the most
 *      recent speech segment with confidence ≥ 0.65) before this action.
 *      Reflects "X said. X walked." — the same actor carries.
 *   3. null  → render with the neutral grey default.
 *
 * Multi-actor scenes resolve to the highest-confidence candidate among
 * names that appear in the action sentence, falling back to the carrying
 * speaker if none is named.
 */
export function attributeActor(
  actionText: string,
  knownNames: string[],
  carryingSpeaker: string | null,
  learnedBias?: import("../types").LearnedBias,
  adaptiveContext?: AdaptiveInferenceContext,
): string | null {
  // Most hot-path callers (notably HighlightLayer during live typing) do not
  // need adaptive ranking. Keep the original cheap longest-match/carrying-
  // speaker path for that case so the visible mirror layer tracks typing
  // immediately instead of waiting on a heavier candidate-building pass.
  if (!learnedBias && !adaptiveContext) {
    if (knownNames.length > 0) {
      const sorted = [...knownNames].sort((a, b) => b.length - a.length);
      for (const name of sorted) {
        const re = new RegExp(`\\b${escapeRegex(name)}\\b`);
        if (re.test(actionText)) return name;
      }
    }
    return carryingSpeaker;
  }
  return predictActionActor(actionText, knownNames, carryingSpeaker, learnedBias, adaptiveContext).actor;
}

export function predictActionActor(
  actionText: string,
  knownNames: string[],
  carryingSpeaker: string | null,
  learnedBias?: import("../types").LearnedBias,
  adaptiveContext?: AdaptiveInferenceContext,
  contextBefore = "",
  contextAfter = "",
  /** The GRAMMAR's answer — segmentActions' subject-side actor for this
   *  clause. A hint, not a decree: it outweighs a bare explicit-name match
   *  (subjects beat objects) but the adaptive ranker can still overrule it
   *  with learned evidence. */
  subjectHint?: string,
): {
  actor: string | null;
  confidence: number;
  needsReview: boolean;
  ambiguityGap: number;
  candidates: AdaptiveCandidateOption[];
} {
  const candidates: AdaptiveCandidateOption[] = [];
  const sorted = [...knownNames].sort((a, b) => b.length - a.length);

  for (const name of sorted) {
    const re = new RegExp(`\\b${escapeRegex(name)}\\b`);
    const explicitMatch = re.test(actionText) ? 1 : 0;
    const carryingMatch = carryingSpeaker && carryingSpeaker.toLowerCase() === name.toLowerCase() ? 1 : 0;
    const actorPrior = learnedBias?.actorPriors[name] ?? 0;
    const beforeMentions = countNameMentions(contextBefore, name);
    const afterMentions = countNameMentions(contextAfter, name);
    const cueWeights = learnedBias?.contextCueWeights;
    const contextBoost = cueWeights
      ? beforeMentions * (2 + cueWeights.beforeName * 8) +
        afterMentions * (2 + cueWeights.afterName * 6) +
        (beforeMentions + afterMentions > 0 ? cueWeights.surroundingName * 8 : 0)
      : 0;
    const subjectMatch = subjectHint && subjectHint.toLowerCase() === name.toLowerCase() ? 1 : 0;
    const baseCore = explicitMatch
      ? 78 + actorPrior * 8 + carryingMatch * 6
      : carryingMatch
      ? 58 + actorPrior * 6
      : actorPrior > 0
      ? 18 + actorPrior * 5
      : 0;
    // ★ The grammar's subject must OUTRANK a bare explicit match: "He nodded
    // once at Mira" is Thomas acting, however loudly Mira's name appears in
    // object position. Floor + bonus puts the hint at 86 against 78; a hint
    // that is ALSO the explicit subject lands at 104 and is untouchable.
    // Learned adjustments still apply on top, so annotation corrections can
    // overrule the grammar where it is genuinely wrong.
    const baseScore = subjectMatch ? Math.max(baseCore, 60) + 26 : baseCore;
    if (baseScore <= 0) continue;
    candidates.push({
      label: name,
      source: explicitMatch ? "action-name" : carryingMatch ? "carrying-speaker" : "actor-prior",
      baseScore: baseScore + contextBoost,
      learnedAdjustment: 0,
      finalScore: baseScore + contextBoost,
      features: {
        base_score: (baseScore + contextBoost) / 100,
        explicit_name_match: explicitMatch,
        subject_position: subjectMatch,
        carrying_speaker: carryingMatch,
        actor_prior: actorPrior,
        before_name_mentions: beforeMentions,
        after_name_mentions: afterMentions,
        surrounding_name_weight: cueWeights?.surroundingName ?? 0,
        token_length: Math.min(3, name.split(/\s+/).length) / 3,
      },
      evidence: [
        ...(explicitMatch ? ["explicit-name"] : []),
        ...(subjectMatch ? ["subject-position"] : []),
        ...(carryingMatch ? ["carry"] : []),
        ...(actorPrior > 0 ? [`prior=${actorPrior.toFixed(2)}`] : []),
        ...(beforeMentions > 0 ? [`before=${beforeMentions}`] : []),
        ...(afterMentions > 0 ? [`after=${afterMentions}`] : []),
      ],
    });
  }

  candidates.push({
    label: null,
    source: "neutral",
    baseScore: carryingSpeaker ? 12 : 22,
    learnedAdjustment: 0,
    finalScore: carryingSpeaker ? 12 : 22,
    features: {
      base_score: (carryingSpeaker ? 12 : 22) / 100,
      explicit_name_match: 0,
      carrying_speaker: 0,
      actor_prior: 0,
      token_length: 0,
    },
    evidence: ["null-candidate"],
  });

  const ranked = rerankAdaptiveCandidates(adaptiveContext, candidates, {
    task: "action",
    spanText: actionText,
    contextBefore,
    contextAfter,
    previousSpeaker: carryingSpeaker,
  });
  const winner = ranked.candidates[0];
  return {
    actor: winner?.label ?? carryingSpeaker ?? null,
    confidence: ranked.confidence,
    needsReview: ranked.needsReview,
    ambiguityGap: ranked.ambiguityGap,
    candidates: ranked.candidates,
  };
}

// Sentence boundary: . ! ? optionally followed by closing quote/paren, then whitespace or EOL.
const SENT_BOUNDARY = /[.!?]['")\]]?(?=\s|$)/g;

/** Abbreviations whose period ends a WORD, not a sentence. Without this,
 *  "I called upon my friend, Mr. Sherlock Holmes, one day in the autumn" is
 *  two sentences, the second one starting mid-clause — so the action span and
 *  its subject came from different sentences. speech-detect learned this same
 *  lesson years ago; action-detect never did. */
const ABBREVIATION = /\b(?:mr|mrs|ms|messrs|dr|prof|st|capt|capt|lt|sgt|col|gen|adm|rev|hon|jr|sr|esq|mme|mlle|vs|etc|no|inc|ltd|co|mt|ft|ave|dept|univ)$/i;

function isAbbreviatingPeriod(text: string, dotIndex: number): boolean {
  if (text[dotIndex] !== ".") return false;
  let i = dotIndex - 1;
  while (i >= 0 && /[A-Za-z]/.test(text[i])) i--;
  const word = text.slice(i + 1, dotIndex);
  if (!word) return false;
  // A lone capital is an initial: "J. R. Hartley".
  if (word.length === 1 && word === word.toUpperCase()) return true;
  return ABBREVIATION.test(word);
}

/** Sentence END offsets, shared by findActionSentences and sentenceBounds so
 *  the two can never disagree about where a sentence stops. */
function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  SENT_BOUNDARY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENT_BOUNDARY.exec(text)) !== null) {
    if (isAbbreviatingPeriod(text, m.index)) continue;
    ends.push(m.index + m[0].length);
  }
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") ends.push(i);
  ends.push(text.length);
  ends.sort((a, b) => a - b);
  return ends;
}

/** Every sentence's [start, end) in `text` — the same boundaries
 *  findActionSentences uses, exported so the prediction builder can walk the
 *  WHOLE paragraph in order (the actor carry must advance through sentences
 *  that are not actions: "Mira lit the lantern. She had run this place..."). */
export function sentenceBounds(text: string): Array<[number, number]> {
  const ends = sentenceEnds(text);
  const out: Array<[number, number]> = [];
  let cursor = 0;
  for (const end of ends) {
    let s2 = cursor;
    while (s2 < end && /\s/.test(text[s2])) s2++;
    if (s2 < end) out.push([s2, end]);
    cursor = end;
  }
  return out;
}

/** Walk over `text` and emit ranges for every sentence that contains at
 *  least one action verb. Sentence boundaries are end-punctuation OR newline. */
export function findActionSentences(text: string): ActionSpan[] {
  if (!text) return [];

  // Sentence boundaries, from the shared helper (abbreviation-aware).
  const ends = sentenceEnds(text);

  const out: ActionSpan[] = [];
  let cursor = 0;
  for (const end of ends) {
    // Trim leading whitespace
    let s = cursor;
    while (s < end && /\s/.test(text[s])) s++;
    if (s >= end) { cursor = end; continue; }

    // Scan for any action verb in the sentence
    const sentence = text.slice(s, end);
    let found = false;
    const wordRe = /[a-zA-Z]+/g;
    let wm: RegExpExecArray | null;
    while ((wm = wordRe.exec(sentence)) !== null) {
      if (ACTION_VERBS.has(wm[0].toLowerCase())) { found = true; break; }
    }
    if (found) out.push({ start: s, end });

    cursor = end;
  }
  return out;
}
