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
  "fling","flung",
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

export interface ActionSegment {
  /** Offsets within the SENTENCE this segment was cut from. */
  start: number;
  end: number;
  /** The assigned actor, resolved by subject position. */
  actor: string | null;
  /** Which rule assigned it, for the harness and the review UI. */
  via: "subject" | "pronoun" | "anywhere" | "carry" | "none";
}

const CLAUSE_CONNECTIVE = /\b(?:and|but|while|as|then|before|after|until)\s+/gi;
const SUBJECT_PRONOUN_RE = /^(?:she|he|they)\b/i;

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
export function segmentActions(
  sentence: string,
  knownNames: string[],
  carryingSpeaker: string | null,
): ActionSegment[] {
  const nameRes = [...knownNames]
    .sort((a, b) => b.length - a.length)
    .map((name) => ({ name, re: new RegExp(`\\b${escapeRegex(name)}\\b`, "gi") }));

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

  const bounds = [0, ...joints, sentence.length];
  const segments: ActionSegment[] = [];
  let prevActor: string | null = carryingSpeaker;

  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    const text = sentence.slice(start, end);
    const verbs = actionVerbOffsets(text);
    const firstVerb = verbs.length ? verbs[0] : text.length;

    // ── Subject position: the last name BEFORE the first action verb.
    const subject = lastNameBefore(text, firstVerb, nameRes);
    let actor: string | null = null;
    let via: ActionSegment["via"] = "none";
    if (subject) {
      actor = subject.name;
      via = "subject";
    } else if (SUBJECT_PRONOUN_RE.test(text.trimStart()) && prevActor) {
      // "She lit the lamp" — the pronoun subject continues whoever last acted
      // or spoke. Only clause-INITIAL pronouns; "watched her" is an object.
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
  const re = new RegExp(`\\b${escapeRegex(name)}\\b`, "gi");
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
        const re = new RegExp(`\\b${escapeRegex(name)}\\b`, "i");
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
    const re = new RegExp(`\\b${escapeRegex(name)}\\b`, "i");
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
    const baseScore = (explicitMatch
      ? 78 + actorPrior * 8 + carryingMatch * 6
      : carryingMatch
      ? 58 + actorPrior * 6
      : actorPrior > 0
      ? 18 + actorPrior * 5
      : 0) + subjectMatch * 14;
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

/** Walk over `text` and emit ranges for every sentence that contains at
 *  least one action verb. Sentence boundaries are end-punctuation OR newline. */
export function findActionSentences(text: string): ActionSpan[] {
  if (!text) return [];

  // First, collect sentence boundaries (end indices, exclusive of trailing space).
  const ends: number[] = [];
  SENT_BOUNDARY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENT_BOUNDARY.exec(text)) !== null) {
    ends.push(m.index + m[0].length);
  }
  // Newlines also end sentences (fiction often elides terminals at line breaks).
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") ends.push(i);
  }
  ends.push(text.length);
  ends.sort((a, b) => a - b);

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
