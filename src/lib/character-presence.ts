/**
 * character-presence.ts — is this character IN the chapter, or just talked about?
 *
 * The timeline used to answer that with a substring test. `charactersPresent`
 * came from `chapter.content.includes(c.name)` and the cast ledger drew a bar
 * whenever a name matched anywhere, so a woman three counties away whose sister
 * mentions her got the same mark as the man arguing in the room.
 *
 * ★ THE DISTINCTION HAS A NAME AND THE FIELD DELIBERATELY LEAVES IT OPEN.
 *   Presence vs EVOCATION. The Corpus Novelties NER guidelines annotate both
 *   identically and say outright that telling them apart "can be done in a
 *   later step" (arXiv 2410.02281). So there is no gold set to borrow and no
 *   pretrained classifier to call — but the distinction is real, and it is
 *   precisely the one the ledger was getting wrong.
 *
 * Measured on 246 cast marks over 67 DEV chapters (probe-presence-classes.ts):
 *   77% decidable ON PAGE by three cheap signals
 *    4% decidable EVOCATION (named only inside quotation marks)
 *   19% a genuinely ambiguous middle
 * and the old engine called all 100% "present", identically.
 *
 * ★ THE ONE THING THAT MADE THIS WORK: position relative to the QUOTATION
 *   MARKS, not a verb word list. Two runs of the probe died on word lists —
 *   "Elizabeth Bennet had been obliged to sit down" is presence and no
 *   NAME+action-verb pattern sees it, because prose puts auxiliaries and
 *   appositives in between. Masking dialogue and asking where the name falls
 *   costs one pass and separates the classes.
 *
 * `uncertain` is a first-class output. The middle is where a model earns its
 * keep, and a classifier that hides its ambiguity gives it nothing to work on.
 */

/** What the ledger draws. `absent` never reaches a renderer — it means no mark. */
export type PresenceClass = "speaking" | "present" | "mentioned" | "absent";

export interface PresenceEvidence {
  /** A dialogue tag ties a quotation to this name. */
  speaks: boolean;
  /** Someone inside a quotation addresses them by name — a vocative. */
  addressed: boolean;
  /** The name heads a finite clause in narration. */
  subject: boolean;
  /** Narration has someone act on them. */
  object: boolean;
  /** Every narration hit sits inside a complement clause of a speech or
   *  cognition verb — "she asked whether X had been at Longbourn". */
  reported: boolean;
  /** Reached only across distance — written to, sent for, heard from. Looks
   *  like an object, means the opposite. */
  distal: boolean;
  mentions: number;
  narrationMentions: number;
}

export interface CharacterPresence {
  name: string;
  klass: PresenceClass;
  /** 0..1. Only meaningful for `speaking` / `present` / `mentioned`. */
  confidence: number;
  /** True when the deterministic signals cannot call it. The model reviews
   *  exactly these and nothing else. */
  uncertain: boolean;
  evidence: PresenceEvidence;
  /** A short verbatim span that justifies the call, for the UI tooltip and as
   *  the model's evidence window. */
  cue: string;
}

const ESC = /[.*+?^${}()|[\]\\]/g;
const esc = (s: string) => s.replace(ESC, "\\$&");

/**
 * ★ `\b` IS THE WRONG WORD BOUNDARY FOR PROSE, and it fails SILENTLY.
 *   Underscore is a word character, so `\bLetter` has no boundary inside
 *   Gutenberg's `_Letter, Mina Murray to Miss Lucy Westenra._` and the whole
 *   pattern quietly never matches. Caught only because a corpus number stayed
 *   byte-identical across two separate fixes that should each have moved it —
 *   a fix that changes nothing has not been proven to work, it has been proven
 *   not to fire. These lookarounds break on letters and digits and let
 *   underscore, quotes and dashes through.
 */
const LB = "(?<![A-Za-z0-9])";
const RB = "(?![A-Za-z0-9])";

/**
 * ★ `returned` and `called` are in here and that is safe ONLY because every
 *   pattern using this list also requires an adjacent QUOTATION MARK. Without
 *   that guard "he returned to England" and "a place called London" put
 *   England, London and Baker Street into the cast as speakers — measured, in
 *   the first run of probe-presence-classes.ts, where it accounted for 39% of
 *   the supposed findings.
 */
const SPEECH_VERB =
  "(?:said|says|asked|asks|replied|answered|cried|whispered|shouted|murmured|" +
  "added|told|muttered|observed|remarked|exclaimed|repeated|returned|called|" +
  "began|went on|continued|snapped|breathed|sighed|laughed)";

/** Auxiliaries and copulas. "had been obliged" is a predicate although not one
 *  of its words is an action. */
const AUX =
  "(?:was|were|is|are|am|be|been|being|had|has|have|would|could|should|will|" +
  "shall|did|does|do|might|may|must|used to|ought)";

/** Irregular pasts a `-ed` test cannot reach.
 *
 *  ★ THE ZERO-CHANGE PASTS ARE THE EASY ONES TO FORGET — set, put, cut, let,
 *    hit, shut, cost, spread. "Harriet SET down her cup" has no morphological
 *    tell at all, and leaving them out sent a plainly on-page character to the
 *    model as uncertain. */
const IRREGULAR =
  "(?:said|saw|knew|thought|felt|came|went|took|gave|made|found|told|began|" +
  "stood|sat|rose|spoke|heard|held|drew|threw|caught|brought|bought|sought|" +
  "fought|left|met|kept|slept|swept|wept|crept|leapt|read|ran|won|lost|" +
  "sent|spent|bent|lent|built|fell|hung|swung|struck|stuck|shook|" +
  "wrote|rode|drove|broke|woke|chose|froze|stole|bore|wore|tore|swore|" +
  "set|put|cut|let|hit|shut|cost|hurt|burst|spread|shed|split|quit|bid|" +
  "grew|blew|flew|knelt|lay|laid|led|fed|bled|slid|hid|bit|lit|dug|clung)";

/** Titles ride WITH the name in prose, so any pattern anchored on a delimiter
 *  before the name has to step over them — "welcome, Mr. Harker, to my house"
 *  is a vocative, and the first probe missed it. */
const TITLE =
  "(?:Mr|Mrs|Ms|Miss|Dr|Sir|Lord|Lady|Captain|Colonel|Professor|Madam|" +
  "Madame|Monsieur|Mademoiselle|Aunt|Uncle|Father|Mother|Brother|Sister|" +
  "Master|Major|General|Sergeant|Reverend|Saint)\\.?\\s+";

/** Verbs whose complement clause is an intensional context. A name inside
 *  "she asked whether X had been at Longbourn" is evoked, never present. This
 *  is the one principled veto here: it is about clause embedding, not about
 *  which words happen to sit nearby. */
/**
 * ★ INFLECTIONS MATTER HERE AND THE FIRST LIST HAD ONLY PAST TENSE. "He could
 *   not stop WONDERING what Wickham would have made of it" is an intensional
 *   context and `wondered` does not match `wondering`, so the engine read
 *   "Wickham would have made" as a plain finite clause and put him in the room.
 */
const REPORT_VERB =
  "(?:said|says|saying|asked|asks|asking|replied|replies|replying|answered|" +
  "answers|answering|told|tells|telling|thought|thinks|thinking|believed|" +
  "believes|believing|hoped|hopes|hoping|wondered|wonders|wondering|" +
  "supposed|supposes|supposing|imagined|imagines|imagining|remembered|" +
  "remembers|remembering|heard|hears|hearing|knew|knows|knowing|feared|" +
  "fears|fearing|declared|declares|wrote|writes|writing|written|mentioned|" +
  "mentions|mentioning|complained|insisted|insists|argued|argues|explained|" +
  "explains|agreed|agrees|admitted|admits|decided|decides|discovered|" +
  "learned|learnt|realised|realized|understood|guessed|forgot|forgets)";

/**
 * ★ WH-WORDS OPEN A COMPLEMENT CLAUSE TOO, and leaving them out was half of the
 *   same bug: "wondering WHAT Wickham would have made of it" embeds Wickham
 *   exactly as "wondering THAT…" would.
 */
const COMPLEMENTIZER =
  "(?:that|whether|if|about|of|what|who|whom|whose|where|when|how|why|which)";

/**
 * Verbs that put a thing into someone's hand IN PERSON.
 *
 * ★★ "handed the letter to X" IS PRESENCE AND IT MATCHED THE DISTAL RULE. The
 *    distal NOUN pattern reads "letter … to NAME" as communication at a
 *    distance, which is right for a posted letter and exactly wrong for one
 *    handed across a table — and handing it over is the more common scene. The
 *    veto is on the verb that governs the noun, because the noun alone cannot
 *    carry the distinction.
 */
const HANDOVER =
  "(?:handed|hands|hand|gave|gives|give|given|passed|passes|pass|brought|" +
  "brings|bring|offered|offers|offer|showed|shows|show|held|holds|hold|" +
  "pushed|slid|dropped|placed|laid|put|tossed|threw|read)";

/**
 * ★ COMMUNICATION AT A DISTANCE IS EVIDENCE OF ABSENCE, and it reads exactly
 *   like presence to an object test. "Alder wrote to Corwin twice that winter"
 *   puts Corwin in the grammatical object slot of a real narration verb — and
 *   the whole point of writing to someone is that they are not in the room.
 *   Caught by a gate asserting first-on-page, which the engine placed a chapter
 *   early because of this one sentence. Epistolary novels lean on it hardest:
 *   Dracula's chapter headers ("Letter, Mina Murray to Miss Lucy Westenra")
 *   name two absent people per line.
 */
const DISTAL_VERB =
  "(?:wrote|write|writes|written|sent|send|sends|posted|mailed|telegraphed|" +
  "wired|cabled|forwarded|addressed|replied)";
/** Nouns that carry the same "not here" force: "a letter to X", "word from X". */
const DISTAL_NOUN =
  "(?:letter|note|message|telegram|wire|card|parcel|packet|word|news|report)";

const CLOSE_Q = `["”]`;
const OPEN_Q = `["“]`;

/**
 * Split a chapter into narration and dialogue, each the same LENGTH as the
 * input with the other half blanked out. Same length matters: offsets found in
 * either half index straight back into the original text, so a cue can be
 * quoted verbatim without a second search.
 */
export function maskDialogue(text: string): { narration: string; dialogue: string } {
  const n = text.length;
  const narr = new Array<string>(n);
  const dial = new Array<string>(n);
  let inQ = false;
  for (let i = 0; i < n; i += 1) {
    const c = text[i];
    const isOpen = c === "“" || (c === '"' && !inQ);
    const isClose = c === "”" || (c === '"' && inQ);
    if (isOpen) { inQ = true; narr[i] = " "; dial[i] = " "; continue; }
    if (isClose) { inQ = false; narr[i] = " "; dial[i] = " "; continue; }
    if (inQ) { narr[i] = " "; dial[i] = c; } else { narr[i] = c; dial[i] = " "; }
  }
  return { narration: narr.join(""), dialogue: dial.join("") };
}

/** Every surface form of one character, longest first so a regex alternation
 *  prefers "Miss Bingley" over "Bingley". */
export interface CharacterVariants {
  name: string;
  variants: readonly string[];
}

interface CompiledMatcher {
  name: string;
  /** Any surface form, global — for counting. */
  any: RegExp;
  speaks: RegExp;
  addressed: RegExp;
  subject: RegExp;
  object: RegExp;
  reported: RegExp;
  distal: RegExp;
}

function compile(entry: CharacterVariants): CompiledMatcher | null {
  const forms = [entry.name, ...entry.variants]
    .map((v) => v.trim())
    .filter((v) => v.length >= 2)
    .sort((a, b) => b.length - a.length)
    .map(esc);
  if (forms.length === 0) return null;
  const N = `(?:${[...new Set(forms)].join("|")})`;

  // ★ A TRAILING PROPER NOUN IS PART OF THE NAME. The cast holds "Sir William"
  //   and the prose writes "Sir William Lucas had been formerly in trade" — the
  //   surname sits between the name and its verb and blocks every predicate
  //   test. Measured: this alone moved several marks out of the ambiguous
  //   middle. Same problem the alias linker solves; here it only needs to be
  //   stepped over.
  const TAIL = `(?:\\s+[A-Z][a-z]+){0,2}`;
  const FINITE = `(?:${AUX}|${IRREGULAR}|\\w+ed)`;

  return {
    name: entry.name,
    any: new RegExp(`${LB}${N}${RB}`, "g"),
    // A dialogue tag sits against a quote in one of two word orders.
    speaks: new RegExp(
      `${CLOSE_Q}\\s*[,.]?\\s*(?:${SPEECH_VERB}\\s+(?:${TITLE})?${N}|(?:${TITLE})?${N}${TAIL}\\s+(?:\\w+\\s+){0,2}${SPEECH_VERB})\\b` +
      `|\\b(?:${SPEECH_VERB}\\s+(?:${TITLE})?${N}|(?:${TITLE})?${N}${TAIL}\\s+(?:\\w+\\s+){0,2}${SPEECH_VERB})\\b\\s*[,:]?\\s*${OPEN_Q}`,
    ),
    // A vocative: clause-initial or after a delimiter, closed by punctuation.
    addressed: new RegExp(
      `(?:^|[,;:!?]\\s*|\\b(?:oh|well|yes|no|but|why|now|dear|my|good|please|thank you)\\s+)` +
      `(?:${TITLE})?${N}${RB}\\s*[,.!?]`, "i",
    ),
    // The name heads a finite clause. One coordination or appositive allowed.
    subject: new RegExp(
      `${LB}(?:${TITLE})?${N}${TAIL}(?:\\s+(?:and|or)\\s+(?:${TITLE})?[A-Z]\\w+|,[^,.;!?]{2,40},)?\\s+(?:\\w+ly\\s+)?${FINITE}\\b`,
    ),
    // Someone acts on them.
    object: new RegExp(
      `\\b${FINITE}\\b(?:\\s+\\w+){0,2}\\s+(?:with|on|at|to|upon|towards?|for|from|after|beside|against|about)?\\s*(?:${TITLE})?${N}${RB}`,
    ),
    // ★ THE SEPARATOR ALLOWS PUNCTUATION here for the same reason `distal`
    //   does: "They had all agreed, LONG BEFORE, that Colonel Brandon was…"
    //   puts two commas between the verb and its complementizer, and `\s+\w+`
    //   cannot cross them. The engine read that as Brandon acting.
    reported: new RegExp(
      `${LB}${REPORT_VERB}${RB}(?:[\\s,]+\\w+){0,3}[\\s,]+${COMPLEMENTIZER}\\s+(?:\\w+\\s+){0,4}(?:${TITLE})?${N}${RB}`,
    ),
    // ★ THE SEPARATOR HAS TO ALLOW PUNCTUATION. `\s+\w+` cannot cross the comma
    //   in "Letter, Mina Murray to Miss Lucy Westenra" — Dracula's chapter
    //   headers, which is where this rule earns most of its keep. The first
    //   version used `\s` only and the corpus numbers did not move at all,
    //   which is how the miss was caught: a fix that changes nothing did not.
    distal: new RegExp(
      `${LB}${DISTAL_VERB}${RB}(?:[\\s,]+\\w+){0,3}[\\s,]+(?:to|from)\\s+(?:${TITLE})?${N}${RB}` +
      `|(?<!${LB}${HANDOVER}${RB}[^.!?]{0,40})${LB}${DISTAL_NOUN}${RB}` +
      `(?:[\\s,]+[\\w.]+){0,4}[\\s,]+(?:to|from)\\s+(?:${TITLE})?${N}${RB}`, "i",
    ),
  };
}

const CUE_RADIUS = 70;

function cueAround(text: string, re: RegExp): string {
  const m = re.exec(text);
  if (!m || m.index < 0) return "";
  const start = Math.max(0, m.index - 20);
  return text.slice(start, Math.min(text.length, m.index + CUE_RADIUS))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Classify every character's presence in one chapter.
 *
 * Dialogue is masked ONCE for the chapter and the matchers are compiled once
 * per character, so the cost is one pass plus a handful of regex tests per
 * (chapter, character) rather than a fresh RegExp per pair.
 */
export function classifyChapterPresence(
  text: string,
  cast: readonly CharacterVariants[],
): CharacterPresence[] {
  if (!text.trim() || cast.length === 0) return [];
  const { narration, dialogue } = maskDialogue(text);
  const out: CharacterPresence[] = [];

  for (const entry of cast) {
    const m = compile(entry);
    if (!m) continue;
    m.any.lastIndex = 0;
    const mentions = (text.match(m.any) ?? []).length;
    if (mentions === 0) {
      out.push({
        name: entry.name, klass: "absent", confidence: 1, uncertain: false, cue: "",
        evidence: { speaks: false, addressed: false, subject: false, object: false, reported: false, distal: false, mentions: 0, narrationMentions: 0 },
      });
      continue;
    }
    m.any.lastIndex = 0;
    const narrationMentions = (narration.match(m.any) ?? []).length;

    const speaks = m.speaks.test(text);
    const addressed = m.addressed.test(dialogue);
    const subject = m.subject.test(narration);
    const object = m.object.test(narration);
    const reported = m.reported.test(narration);
    const distal = m.distal.test(narration);

    const evidence: PresenceEvidence = { speaks, addressed, subject, object, reported, distal, mentions, narrationMentions };

    let klass: PresenceClass;
    let confidence: number;
    let uncertain = false;
    let cue = "";

    // ★ THE LADDER IS ORDERED BY WHAT DOMINATES WHAT, not by signal strength.
    //   `reported` used to sit below `subject` and be vetoed by `object`, and
    //   both were wrong for the same reason: when a name is inside a complement
    //   clause, the subject and object matches the other tests find are matches
    //   INSIDE that clause. "They agreed that Colonel Brandon was the steadiest
    //   man" has Brandon heading a finite clause and he is still not in the
    //   room. An intensional context swallows everything nested in it, which is
    //   what makes it a veto rather than one more vote.
    if (speaks) {
      klass = "speaking"; confidence = 0.95;
      cue = cueAround(text, new RegExp(m.speaks.source));
    } else if (addressed) {
      // Someone in the scene said their name TO them. Direct evidence, and the
      // only signal that survives a chapter where they never act.
      klass = "present"; confidence = 0.75;
      cue = cueAround(dialogue, new RegExp(m.addressed.source, "i"));
    } else if (narrationMentions === 0) {
      // Named only inside quotation marks. This is evocation in the field's
      // own sense and it is the cleanest call the engine makes.
      klass = "mentioned"; confidence = 0.85;
      cue = cueAround(dialogue, new RegExp(m.any.source));
    } else if (distal) {
      // Written to, sent for, heard from. The grammar looks like presence and
      // the meaning is the opposite.
      klass = "mentioned"; confidence = 0.75;
      cue = cueAround(narration, new RegExp(m.distal.source, "i"));
    } else if (reported) {
      klass = "mentioned"; confidence = 0.7;
      cue = cueAround(narration, new RegExp(m.reported.source));
    } else if (subject) {
      klass = "present"; confidence = object ? 0.9 : 0.8;
      cue = cueAround(narration, new RegExp(m.subject.source));
    } else if (object) {
      // Acted upon but never acting or speaking. Genuinely could be either —
      // "danced with Miss Bingley" is presence, "thought of poor Miss Bingley"
      // is not, and the surface is nearly identical.
      klass = "present"; confidence = 0.55; uncertain = true;
      cue = cueAround(narration, new RegExp(m.object.source));
    } else {
      // In narration, no predicate anywhere. Usually a possessive or a
      // prepositional aside; sometimes a real presence in a clause shape the
      // patterns miss.
      klass = "mentioned"; confidence = 0.5; uncertain = true;
      cue = cueAround(narration, new RegExp(m.any.source));
    }

    out.push({ name: entry.name, klass, confidence, uncertain, evidence, cue });
  }

  return out;
}

/** The names that are actually on the page — what `charactersPresent` should
 *  have meant all along. */
export function onPageNames(presence: readonly CharacterPresence[]): string[] {
  return presence
    .filter((p) => p.klass === "speaking" || p.klass === "present")
    .map((p) => p.name);
}

/**
 * First chapter each character is ON PAGE, which is not the first chapter they
 * are named in — that gap is the whole point. Returns a map from name to
 * chapter index.
 */
export function firstOnPageByName(
  perChapter: readonly (readonly CharacterPresence[])[],
): Map<string, number> {
  const first = new Map<string, number>();
  perChapter.forEach((chapter, index) => {
    for (const p of chapter) {
      if (p.klass !== "speaking" && p.klass !== "present") continue;
      if (!first.has(p.name)) first.set(p.name, index);
    }
  });
  return first;
}
