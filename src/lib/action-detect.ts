// Lightweight regex-based action-sentence detector.
//
// Returns absolute character ranges in the input text for sentences that
// contain at least one common action verb (movement, manipulation, combat,
// eating, sensory). The HighlightLayer wraps these ranges in a tinted
// border-box span so action beats stand out from dialogue and exposition.
//
// This is intentionally heuristic — no NLP, no parsing. Cheap to call per
// render. False positives are acceptable; the visual treatment is light.

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
]);

export interface ActionSpan {
  /** Start offset within the input text. */
  start: number;
  /** End offset (exclusive). */
  end: number;
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
): string | null {
  if (knownNames.length > 0) {
    // Longest-match-first so "Mary Sue" wins over "Mary"
    const sorted = [...knownNames].sort((a, b) => b.length - a.length);
    for (const name of sorted) {
      const re = new RegExp(`\\b${escapeRegex(name)}\\b`, "i");
      if (re.test(actionText)) return name;
    }
  }
  return carryingSpeaker;
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
