/**
 * character-dossier.ts — auto role and description for the world panel,
 * gathered from the manuscript, never from the model's imagination.
 *
 * The measured groundwork is plans/character-dossier-research-2026-08.md and
 * the two probes that produced it. Three findings shape everything here:
 *
 * ★★ THE DESCRIPTION IS ALMOST NEVER IN THE SENTENCE WITH THE NAME. Every real
 *    description of Elizabeth Bennet arrives by PRONOUN ("the beautiful
 *    expression of her dark eyes"); a name-anchored harvester returned fourteen
 *    spans for her and none described her. So the harvest rides the engine's
 *    own pronoun resolution (resolvePronounOwners) at its two trusted
 *    confidence rungs, and the name-anchored channels are only part of the
 *    pool. This is the same attribute inventory BookNLP extracts (agent and
 *    patient verbs, possessives, modifiers, predicatives), built from the
 *    machinery this app already ships.
 *
 * ★★ AN EMPTY PACK MAKES BOTH SHIPPING TIERS FABRICATE. Handed zero evidence,
 *    the 1.7B invented a beard, a robe and a staff at confidence 0.8; the 4B
 *    invented a long beard and a white robe; both cited a passage number that
 *    does not exist. The prompt already said an empty answer was correct. So
 *    the gates here are CODE, per field, both sides of the call: a field with
 *    no eligible evidence is never asked for and never accepted. GATE=off in
 *    the probe reproduces the fabrications; that canary is the gate's proof.
 *
 * ★★ CITE FIRST, THEN WRITE, THEN CHECK IN CODE. The schema puts each field's
 *    span numbers BEFORE its text (grammar emits in declaration order, so the
 *    model selects before it composes — the "attribute first, then generate"
 *    decomposition). The grounding pass then requires every content word to
 *    locate in the pack; a claim that fails its own citations is re-checked
 *    against the WHOLE pack and repaired rather than refused, because both
 *    tiers were measured writing a correct description from a span they read
 *    but failed to number. Only a claim that locates NOWHERE is dropped.
 *
 * The model never searches and never reads the manuscript. The harness finds,
 * the model reads, code checks. Same thesis as evidence-pack.ts and max-ask.ts.
 */
import { splitSentences, stripQuotes } from "./prose-segments";
import { tidyTruncatedText } from "./assistant-client";
import { notesBlock } from "./think";
import {
  detectSpeechInChapter,
  resolvePronounOwners,
} from "./speech-detect";
import type { Novel, WorldCharacter } from "../types";

export const DOSSIER_TASK = "character-dossier";
export const DOSSIER_PROMPT_VERSION = 2;

/**
 * ★★ THE OTHER THREE TYPES ARE THE SAME MACHINE WITH DIFFERENT QUESTIONS.
 *    A place is not described by its temperament and a faction has no face,
 *    so the harvest is shared (one pass, every channel) and only the FIELD
 *    DEFINITIONS and the gates differ. Doing it the other way — a second
 *    harvester per type — would be four things to keep in step, and the
 *    channels themselves are type-neutral: an appositive is an appositive
 *    whether it follows a woman or a guild.
 *
 *    Characters keep the exact behaviour they were measured with; the three
 *    other types are additive and cannot change a character's card.
 */
export type DossierKind = "character" | "place" | "faction" | "entity";

// ── channels ──────────────────────────────────────────────────────────────

/**
 * ★★ RIMMON-KENAN'S FOUR INDIRECT CHANNELS, PLUS DIRECT DEFINITION.
 *
 *    The narratology this converges on (and the computational work that
 *    follows it: BookNLP's agent/patient inventory, the Portrayal system's
 *    finding that "actions are essential ... and this indicator is missing
 *    from existing solutions") splits characterization into DIRECT
 *    definition, where the text states a trait outright, and INDIRECT
 *    definition through ACTION, SPEECH, APPEARANCE and ENVIRONMENT.
 *
 *    v1 of this engine harvested appearance well and the other three barely,
 *    and it showed. On the owner's own manuscript it produced "Widened eye;
 *    small, mended scar; moved hands; extended hand; clear eye" for the
 *    protagonist — a list of gestures — while the book's actual direct
 *    definition, "Mira was the person who came when a birth needed more than
 *    the family could give", sat in the pack unused. In modern literary and
 *    web-novel registers, stock physical description is rare and identity
 *    arrives through station, habit and act.
 *
 *    So: `identity` (direct definition) leads, `action` and `speech-manner`
 *    carry indirect characterization, and appearance is demoted to what it
 *    actually is in these registers — a supporting detail.
 */
export type DossierChannel =
  | "identity"      // Name was the person who … / Name, the village midwife,
  | "appositive"    // Name, a country attorney, …
  | "copular"       // Name was stubborn
  | "attributive"   // poor Anne / old Marley
  | "possessive"    // Name's long thin fingers …
  | "pronoun-attr"  // her grey eyes … in a sentence only Name is in
  | "pronoun-owned" // her dark eyes … referent resolved by the engine
  | "habitual"      // Name always / never / was in the habit of …
  | "action"        // recurring things Name is the agent of
  | "interiority"   // Name thought / knew / wanted — the POV channel
  | "speech-manner" // the verbs the prose attributes their dialogue with
  | "relation"      // Name's brother / the daughter of Name
  | "lore-narrated" // narration, past-biography frame
  | "lore-spoken";  // the same, but inside quotation marks

export const DOSSIER_CHANNELS: readonly DossierChannel[] = [
  "identity", "appositive", "copular", "attributive", "possessive",
  "pronoun-attr", "pronoun-owned", "habitual", "action", "interiority", "speech-manner",
  "relation", "lore-narrated", "lore-spoken",
];

/** Channels an APPEARANCE line could be written from. `identity` belongs
 *  here as well as in traits: a direct definition routinely carries the
 *  physical description with it ("Marilla was a tall, thin woman, with
 *  angles and without curves"). */
const VISUAL_CHANNELS: readonly DossierChannel[] = [
  "identity", "appositive", "copular", "attributive", "possessive", "pronoun-attr", "pronoun-owned",
];
/** Channels a PERSONALITY line could be written from. Action and speech
 *  manner are indirect definition and belong here, not in appearance. */
const TRAIT_CHANNELS: readonly DossierChannel[] = [
  "identity", "appositive", "copular", "attributive", "habitual", "action", "interiority", "speech-manner",
];

/**
 * ★ OCCUPATION AND STATION — what a character IS, in one word. This is the
 *   head noun of a direct definition ("Mira was the person who…", "Brother
 *   Ifian, the clinic's physician") and it is what makes a role SPECIFIC
 *   instead of a presence tier. Open class, so the list ranks rather than
 *   decides: an unlisted trade still reaches the model through the identity
 *   channel, it just does not become the deterministic role word.
 */
const STATION_NOUN =
  "(?:midwife|physician|doctor|healer|nurse|surgeon|apothecary|weaver|smith|blacksmith|" +
  "baker|butcher|farmer|miller|carpenter|mason|tailor|cobbler|potter|brewer|innkeeper|" +
  "merchant|trader|shopkeeper|clerk|scribe|scholar|student|apprentice|teacher|tutor|" +
  "magister|professor|priest|priestess|monk|nun|abbot|acolyte|warden|marshal|constable|" +
  "guard|soldier|captain|sergeant|knight|hunter|ranger|sailor|fisherman|shepherd|" +
  "servant|maid|steward|cook|groom|driver|messenger|herald|spy|thief|assassin|" +
  "king|queen|prince|princess|lord|lady|duke|duchess|elder|chief|mayor|magistrate|" +
  "widow|widower|orphan|heir|heiress)";
const STATION_RE = new RegExp(`${"(?<![A-Za-z0-9])"}(${STATION_NOUN})(?![A-Za-z0-9])`, "i");
// Background candidates are computed in buildDossierPack and deliberately
// EXCLUDE the relation channel — see the comment there.

export interface DossierSpan {
  channel: DossierChannel;
  chapter: number;
  text: string;
}

// ── vocabularies ──────────────────────────────────────────────────────────
//
// Open classes, and therefore never complete. They RANK and GATE candidate
// evidence for a reader that makes the final call; none of them decides a
// classification on its own, which is what separates this from the word-list
// traps recorded in narrative-events.ts.

const APPEARANCE_NOUN =
  "(?:eyes?|hair|face|features|complexion|skin|beard|moustache|mustache|whiskers|brow|brows|" +
  "forehead|chin|jaw|nose|mouth|lips?|teeth|cheeks?|ears?|neck|throat|shoulders?|arms?|hands?|" +
  "fingers?|legs?|feet|figure|frame|build|stature|height|voice|smile|expression|gaze|glance|" +
  "dress|gown|coat|cloak|hat|bonnet|boots?|shoes|gloves|uniform|robes?|clothes|clothing|" +
  "appearance|look|air|bearing|manner|posture|step|walk|scar|scars)";
export const APPEARANCE_NOUN_RE = new RegExp(`${"(?<![A-Za-z0-9])"}${APPEARANCE_NOUN}(?![A-Za-z0-9])`, "i");

const RELATION_NOUN =
  "(?:father|mother|parents?|brother|sister|siblings?|son|daughter|child|children|wife|husband|" +
  "widow|widower|uncle|aunt|nephew|niece|cousins?|grandfather|grandmother|grandson|granddaughter|" +
  "friend|companion|servant|maid|butler|master|mistress|employer|clerk|partner|rival|enemy|" +
  "neighbour|neighbor|guardian|ward|apprentice|teacher|pupil|student|captain|colleague|patron)";

/** Past-biography predicates. Deliberately a PAST frame: the channel is "what
 *  is known about them", not "what they are doing". */
/**
 * ★ BARE `had been` IS NOT A BIOGRAPHY, and it was in this list. It matches
 *   any past perfect at all, so "Kinoko had been sitting on the bench for
 *   eleven minutes" and "her father came in at midday" arrived as background
 *   — scene detail wearing a history's grammar. Every predicate here now
 *   names a life event or an origin; the tense alone earns nothing.
 */
const LORE_PREDICATE =
  "(?:was born|were born|grew up|was raised|had been born|used to|once was|was once|had once|" +
  "came from|come from|hails? from|inherited|married|had married|served (?:in|as|under)|" +
  "worked (?:as|for|at)|studied|trained|apprenticed|fought (?:in|at)|left (?:home|the village|the city)|" +
  "arrived from|returned from|lost (?:his|her|their) (?:father|mother|wife|husband|son|daughter|family|home)|" +
  "died|was killed|escaped|was sent|was taken|was known (?:as|for)|is known (?:as|for)|" +
  "they say|it is said|rumou?red|legend|had lived|has lived|spent (?:his|her|their) (?:life|childhood|youth)|" +
  // ★ `had been` IS BIOGRAPHY WHEN IT TAKES A PLACE OR A ROLE, and scene
  //   detail otherwise. Dropping it wholesale cost a genuinely good line —
  //   "Tessa had been in the valley for sixty-three years and had woven
  //   blankets and raised two children" — while keeping it wholesale let
  //   "had been sitting on the bench for eleven minutes" through. The
  //   complement decides: a locative or a role is a life, a progressive is
  //   a moment.
  "had been (?:in|at|on|with|among|of) (?!this|that|these|those)|had been (?:an?|the)\\b)";

/**
 * ★★ THE VIEWPOINT CHARACTER IS DESCRIBED LEAST AND THOUGHT MOST.
 *
 *    The protagonist of the owner's manuscript produced the thinnest card in
 *    the cast, and the reason is structural rather than a bug: a novel is
 *    told THROUGH its viewpoint character, so the narration has no occasion
 *    to describe her. Nobody says what she looks like because we are behind
 *    her eyes; nobody sums her up because we already have her judgements.
 *
 *    But the same vantage gives something no other character gets: direct
 *    access to what she thinks, wants, notices and refuses. Measured on
 *    root-crown, cognition verbs separate the cast cleanly — Kinoko 8 and
 *    Mira 12 against Vey 1 and Gareth 0 — so interiority is both the missing
 *    evidence AND the signal that identifies who the viewpoint belongs to.
 *
 *    Note the honest limit: this finds the character whose interior the book
 *    opens, which in a multi-viewpoint novel is more than one person. That
 *    is a correct answer, not a tie to be broken.
 */
const INTERIORITY_VERB =
  "(?:thought|wondered|felt|knew|realized|realised|remembered|decided|noticed|" +
  "understood|considered|wanted|needed|hated|liked|loved|preferred|hoped|feared|" +
  "expected|suspected|doubted|regretted|resented|admired|envied|missed|recognised|" +
  "recognized|imagined|assumed|believed|minded|dreaded|longed|intended|meant)";

/** Habit frames — durable personality evidence, not a moment. */
const HABIT_FRAME =
  "(?:always|never|seldom|rarely|usually|habitually|invariably|" +
  "was in the habit of|would (?:always|often|never|seldom)|" +
  "liked to|loved to|hated to|could never|had a way of)";

/** A word shaped like a descriptive adjective. Suffix test first, covering the
 *  open class, then the short closed set of bare adjectives with no suffix. */
const ADJ_SUFFIX = /(?:ish|ous|ful|less|able|ible|ive|ic|al|ary|ent|ant|y|ly|en|ed|er|est|some)$/;
// ★ SILENT-E ADJECTIVES EVADE EVERY SUFFIX TEST, and the miss was decisive:
//   "his fine, tall person, handsome features, noble mien" is the only
//   physical description of Mr. Darcy in his book, and `fine`, `handsome` and
//   `noble` all failed the shape test, so the gate judged the sentence
//   undescriptive. The bare list carries the frequent ones.
const BARE_ADJ = new Set([
  "tall", "short", "big", "small", "little", "large", "old", "young", "fat", "thin", "slim",
  "lean", "stout", "pale", "dark", "fair", "red", "grey", "gray", "black", "white", "blue",
  "green", "brown", "blond", "blonde", "good", "bad", "poor", "rich", "kind", "cruel", "grim",
  "calm", "wild", "keen", "sharp", "soft", "hard", "cold", "warm", "clean", "neat", "plain",
  "smart", "slight", "broad", "narrow", "round", "square", "long", "deep", "high", "low",
  "clear", "bright", "dim", "quiet", "loud", "quick", "slow", "firm", "frail", "sweet",
  "proud", "shy", "brave", "stern", "vain", "sly", "meek", "blunt", "gruff", "prim",
  "fine", "noble", "gentle", "humble", "feeble", "subtle", "wide", "huge", "spare",
  "severe", "austere", "serene", "petite", "polite", "mature", "obscure", "blithe",
  "lithe", "wise", "crude", "rude", "ripe", "pure", "rare", "dire", "bare", "dense",
  "tense", "obese", "strange", "sallow", "hollow", "mellow", "yellow", "bald", "plump",
  "sleek", "erect", "robust", "gaunt", "worn", "drawn",
]);
/** Progressive and agentive-passive complements: a verb, not a description. */
const VERBAL_COMPLEMENT = /^(?:[a-z]+ing|[a-z]+ed\s+(?:by|with|to|from|at|in|into|out|up|down|away|about))\b/;

export const isAdjectiveShaped = (w: string): boolean =>
  BARE_ADJ.has(w) || (w.length >= 4 && ADJ_SUFFIX.test(w));

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Underscore is a word character and imported prose wraps names in it. Same
 *  boundary as character-presence, alias-scan and max-ask-context. */
const LB = "(?<![A-Za-z0-9])";
const RB = "(?![A-Za-z0-9])";

/**
 * Does an adjective sit next to an appearance noun anywhere in this text?
 * "his tall, gaunt figure" yes; "reopened his eyes and looked" no.
 *
 * ★★ EVERY OCCURRENCE, NOT THE FIRST. Tested against only the first noun, this
 *    judged "hardly a good feature in her face … the beautiful expression of
 *    her dark eyes" undescriptive, because `face` comes first and is bare. That
 *    sentence is the only physical description of Elizabeth Bennet in her own
 *    book. A gate that silently excludes the best evidence in the corpus is
 *    worse than no gate.
 */
/** Determiners and possessives open a noun phrase; nothing BEFORE one can
 *  modify the noun AFTER it. Without this, "reopened his eyes" reads as
 *  descriptive because "reopened" ends in -ed two tokens back. */
const NP_OPENER = new Set(["the", "a", "an", "his", "her", "their", "its", "my", "your", "our"]);

export function hasDescriptiveAppearance(text: string): boolean {
  const all = new RegExp(`${LB}${APPEARANCE_NOUN}${RB}`, "gi");
  for (let m = all.exec(text); m; m = all.exec(text)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const pre = before.match(/(?:([a-z-]+)[,\s]+)?([a-z-]+)[,\s]*$/i);
    if (pre) {
      const adjacent = pre[2]?.toLowerCase();
      const back = pre[1]?.toLowerCase();
      if (adjacent && isAdjectiveShaped(adjacent) && !NP_OPENER.has(adjacent)) return true;
      // The token behind the adjacent one only counts when the adjacent one
      // does not RESTART the phrase: "tall, gaunt figure" yes, "reopened his
      // eyes" no.
      if (back && !NP_OPENER.has(adjacent ?? "") && isAdjectiveShaped(back) && !NP_OPENER.has(back)) return true;
    }
    const post = after.match(/^(?:\s*(?:was|were|is|are|seemed|looked|had)\s+|\s*,\s*)([a-z-]+)/i);
    if (post && isAdjectiveShaped(post[1].toLowerCase())) return true;
  }
  return false;
}

// ── per-character evidence ────────────────────────────────────────────────

export interface DossierCounts {
  mentions: number;
  /** Chapter numbers this character is named in, reading order. */
  chapters: number[];
  chapterTotal: number;
  /** Dialogue lines attributed to this character at usable confidence. */
  speechLines: number;
  /** Mean words per attributed line, 0 when speechLines is 0. */
  meanLineWords: number;
  /** Verbs this character is the grammatical agent of, most frequent first.
   *  The BookNLP attribute the earlier probe lacked. */
  agentVerbs: Array<[string, number]>;
  /** Agent verbs that are frequent for THIS character and rare for the rest
   *  of the cast — the ones that actually characterize. */
  distinctiveVerbs: string[];
  /** Marked speech-attribution verbs, most frequent first. */
  speechVerbs: Array<[string, number]>;
  /** Share of this character's dialogue attributed with the unmarked "said".
   *  1 means the prose never colours their speech. */
  plainSaidRatio: number;
  /** Sentences opening this character's interior (thought/knew/wanted). */
  interiorityCount: number;
  /** True when the book opens this character's interior far more often than
   *  the rest of the cast: the viewpoint. More than one may qualify, which
   *  in a multi-viewpoint novel is the right answer. */
  isViewpoint: boolean;
  /** Station or trade named for them in a direct definition, if any. */
  station: string | null;
  /** Top co-present cast members, [name, shared chapter count]. */
  coPresent: Array<[string, number]>;
}

export interface CharacterDossierEvidence {
  name: string;
  /** Every surface form: the name plus its aliases. */
  forms: string[];
  /** Whole-book honorific dominance. Never guessed from the name; "unknown"
   *  is a first-class answer and composes with they/their. */
  pronounClass: HonorificClass;
  counts: DossierCounts;
  byChannel: Record<DossierChannel, DossierSpan[]>;
}

export interface DossierEvidence {
  /** In cast order (the order the caller supplied). */
  characters: CharacterDossierEvidence[];
  byName: Map<string, CharacterDossierEvidence>;
  signature: string;
}

const SPANS_PER_CHANNEL_MAX = 40;

function emptyByChannel(): Record<DossierChannel, DossierSpan[]> {
  const out = {} as Record<DossierChannel, DossierSpan[]>;
  for (const channel of DOSSIER_CHANNELS) out[channel] = [];
  return out;
}

/** Cheap novel+cast signature for the harvest cache. Content length plus head
 *  per chapter, plus the cast's forms: any edit or cast change invalidates. */
export function dossierSignature(novel: Novel, cast: ReadonlyArray<{ name: string; aliases?: string[] }>): string {
  const chapterSig = novel.chapters.map((c) => `${c.content.length}|${c.content.slice(0, 24)}`).join("~");
  const castSig = cast.map((c) => [c.name, ...(c.aliases ?? [])].join(",")).join(";");
  return `${chapterSig}#${castSig}`;
}

// ── family disambiguation ─────────────────────────────────────────────────
//
// ★★ A SURNAME IS A FAMILY, NOT A PERSON, and the collision poisons every
//    channel. Measured: "Miss Darcy … tall, on a larger scale than Elizabeth,
//    womanly and graceful" was harvested as MR. Darcy's appearance, because
//    `Darcy` matches inside `Miss Darcy`; and the chapter-local gender map
//    then reads "Darcy" as female in Georgiana's chapters, so `her figure`
//    spans follow. The fix is the character's own dominant usage: a name
//    written "Mr. Darcy" four hundred times is masculine usage, and a match
//    preceded by a FEMININE honorific is a different member of the family.
//    Ambiguous families (Bennet: Mr., Mrs. and Miss all frequent) get no
//    class and are deliberately left alone — a wrong mask is worse than the
//    collision, so only clear dominance acts.

const MASC_HONORIFIC = "(?:Mr|Sir|Lord|Master|Uncle|Monsieur)";
const FEM_HONORIFIC = "(?:Miss|Mrs|Ms|Lady|Madam|Madame|Mistress|Aunt)";

export type HonorificClass = "masc" | "fem" | "unknown";

/** Which honorific class dominates this character's own usage in the text?
 *  Requires clear dominance (3 or more, and double the other side). */
export function honorificClassOf(text: string, forms: readonly string[]): HonorificClass {
  const alt = forms.map(esc).join("|");
  const masc = (text.match(new RegExp(`${LB}${MASC_HONORIFIC}\\.?\\s+(?:${alt})${RB}`, "g")) ?? []).length;
  const fem = (text.match(new RegExp(`${LB}${FEM_HONORIFIC}\\.?\\s+(?:${alt})${RB}`, "g")) ?? []).length;
  if (masc >= 3 && masc > fem * 2) return "masc";
  if (fem >= 3 && fem > masc * 2) return "fem";
  return "unknown";
}

/** A regex that matches OTHER family members' honorific+surname forms, or
 *  null when the class is unknown. Matches are masked before any harvesting
 *  so no channel and no count can fire on them. */
export function otherFamilyRe(forms: readonly string[], klass: HonorificClass): RegExp | null {
  if (klass === "unknown") return null;
  const alt = forms.map(esc).join("|");
  const opposite = klass === "masc" ? FEM_HONORIFIC : MASC_HONORIFIC;
  return new RegExp(`${LB}${opposite}\\.?\\s+(?:${alt})${RB}`, "g");
}

const maskOtherFamily = (text: string, re: RegExp | null): string =>
  re ? text.replace(re, (m) => "▓".repeat(m.length)) : text;

/** Is this possessive pronoun compatible with the character's class? `their`
 *  is always compatible; a known class rejects the opposite gender. */
function pronounCompatible(pronoun: string, klass: HonorificClass): boolean {
  const p = pronoun.toLowerCase();
  if (p === "their") return true;
  if (klass === "masc") return p === "his";
  if (klass === "fem") return p === "her" || p === "hers";
  return true;
}

/**
 * IRREGULAR simple-past forms plus the -ed open class: enough to count what a
 * character mostly DOES without a parser. A counted fact for the pack, never a
 * classification.
 */
const IRREGULAR_PAST = new Set([
  "said", "ran", "took", "gave", "went", "saw", "made", "came", "stood", "sat",
  "knew", "thought", "felt", "held", "kept", "drew", "threw", "spoke", "told",
  "began", "left", "met", "fell", "put", "let", "read", "heard", "found",
  "brought", "sent", "wore", "rode", "drove", "ate", "drank", "sang", "wrote",
  "rose", "shook", "broke", "chose", "swore", "wept", "fought", "sought",
  "caught", "taught", "bought", "led", "lay", "laid", "bade", "bore", "grew",
]);
/** Auxiliaries and copulas: they head clauses but say nothing about conduct. */
const NON_CONDUCT_VERB = new Set([
  "was", "were", "had", "has", "did", "does", "been", "being", "seemed",
  "appeared", "looked", "became", "used", "continued", "remained", "turned",
]);

/**
 * ★★ THE DISTINCTIVE VERBS ARE THE CHARACTERIZATION; THE COMMON ONES ARE THE
 *    LANGUAGE. Measured on root-crown, every character's top agent verb was
 *    `said` (42, 35, 43 …) followed by went/came/sat — the verbs of prose
 *    itself, identical for the whole cast and therefore worth nothing. Same
 *    problem the entity scanner solved with IDF, and the same solution: a
 *    verb earns its place by being frequent FOR THIS CHARACTER and rare
 *    across the rest of the cast.
 */
const AMBIENT_VERB = new Set([
  "said", "asked", "replied", "answered", "told", "spoke", "added", "repeated",
  "went", "came", "got", "put", "took", "made", "did", "gave", "let",
  "saw", "looked", "watched", "heard", "felt", "knew", "thought", "wanted",
  "found", "kept", "held", "stood", "sat", "walked", "moved", "turned",
  "started", "stopped", "began", "finished", "tried", "waited", "left",
]);

/** Speech verbs whose CHOICE characterizes: Rimmon-Kenan's speech channel.
 *  `said` is deliberately absent — it is the unmarked default and carries no
 *  signal (138 of 163 attributions in the owner's manuscript). */
const MARKED_SPEECH_VERB = new Set([
  "snapped", "muttered", "murmured", "whispered", "shouted", "yelled", "barked",
  "insisted", "admitted", "conceded", "confessed", "protested", "objected",
  "demanded", "ordered", "commanded", "pleaded", "begged", "urged", "warned",
  "teased", "joked", "laughed", "sighed", "groaned", "grumbled", "complained",
  "observed", "noted", "remarked", "offered", "suggested", "agreed", "allowed",
  "corrected", "countered", "pressed", "prompted", "explained", "announced",
  "declared", "hissed", "growled", "drawled", "stammered", "blurted",
]);

function agentVerbAfter(narration: string, nameRe: RegExp): string | null {
  const m = nameRe.exec(narration);
  if (!m) return null;
  const after = narration.slice(m.index + m[0].length);
  const v = after.match(/^\s+(?:[a-z]+ly\s+)?([a-z]+)/);
  if (!v) return null;
  const word = v[1].toLowerCase();
  if (NON_CONDUCT_VERB.has(word)) return null;
  if (IRREGULAR_PAST.has(word)) return word;
  if (word.length >= 4 && /[a-z]ed$/.test(word)) return word;
  return null;
}

/**
 * Harvest the name-anchored channels for one character out of one sentence.
 *
 * ★ NARRATION AND DIALOGUE ARE SEPARATE SURFACES, split positionally by
 *   stripQuotes, the same test character-presence.ts uses. A biography stated
 *   inside quotation marks is LORE SOMEONE SAID, a different kind of claim
 *   from the narrator stating it, and the pack tags it so the reader can
 *   discount it.
 */
function harvestSentence(
  ev: CharacterDossierEvidence,
  original: string,
  sentence: string,
  narration: string,
  chapter: number,
  otherFormsRe: RegExp,
  klass: HonorificClass,
) {
  const NAME = `${LB}(?:${ev.forms.map(esc).join("|")})${RB}`;
  // Tests run on the MASKED sentence and narration; the span the pack shows
  // is the ORIGINAL, because the writer must see the manuscript's own words.
  const push = (channel: DossierChannel, _text: string) => {
    if (ev.byChannel[channel].length >= SPANS_PER_CHANNEL_MAX) return;
    ev.byChannel[channel].push({ channel, chapter, text: original.replace(/\s+/g, " ").trim() });
  };

  const nameRe = new RegExp(NAME);
  const inNarration = nameRe.test(narration);

  // APPOSITIVE. "Mr. Bennet, a gentleman of small fortune, …". The determiner
  // after the comma is required so "Elizabeth, and her sister" cannot qualify.
  // An appositive naming a STATION is direct definition and files as identity,
  // which is what the role word and the card's first line read.
  const appos = new RegExp(`${NAME},\\s+((?:an?|the|his|her|their|its)\\s+[a-z][^,.;]{0,60})`).exec(narration);
  if (inNarration && appos) {
    push(STATION_RE.test(appos[1]) ? "identity" : "appositive", sentence);
  }
  if (inNarration && new RegExp(`${NAME},\\s+who\\s+(?:was|is|had|has)\\b`).test(narration)) {
    push("appositive", sentence);
  }

  // ★★ IDENTITY — DIRECT DEFINITION, and it leads the card. A copular whose
  //    complement is a NOUN PHRASE says what this person IS ("Mira was the
  //    person who came when a birth needed more than the family could give");
  //    a copular whose complement is a bare adjective says what they are LIKE
  //    and belongs in `copular`. v1 pooled the two and then built descriptions
  //    only from appearance nouns, so the strongest line in the book never
  //    reached the writer.
  const copular = new RegExp(`${NAME}\\s+(?:was|is|had been|remains?|became)\\s+(.{0,60})`).exec(narration);
  if (inNarration && copular) {
    const tail = copular[1].replace(/^(?:very|quite|so|too|not|no|still|already|always|never|rather|somewhat)\s+/, "");
    if (!VERBAL_COMPLEMENT.test(tail)) {
      if (/^(?:an?|the)\s+[a-z]/i.test(tail)) push("identity", sentence);
      else if (isAdjectiveShaped((tail.match(/^([a-z-]+)/i)?.[1] ?? "").toLowerCase())) push("copular", sentence);
    }
  }

  // ATTRIBUTIVE. "poor Anne", "old Marley".
  //
  // ★ THE DIALOGUE TAG IS THE FALSE POSITIVE, and the test is positional: in
  //   `"…," murmured Holmes` no adjective test rejects "murmured" (it ends in
  //   -ed). What separates a tag is the closing quote just before it. The
  //   probe version indexed the ORIGINAL sentence with an offset measured in
  //   the stripped string, which stripQuotes does not preserve; here the whole
  //   test runs on the narration string, whose own offsets are consistent —
  //   and in narration the quote characters are gone, so a tag's giveaway is
  //   the leading gap stripQuotes leaves where the quotation was.
  const attr = new RegExp(`(?:^|[\\s(])([a-z-]+)\\s+${NAME}`).exec(narration);
  if (inNarration && attr && isAdjectiveShaped(attr[1].toLowerCase())) {
    const beforeAttr = narration.slice(0, attr.index);
    // A quotation preceded this clause and nothing terminated the sentence in
    // between: the adjective-shaped word is a speech verb in a tag.
    const strippedGap = /\s\s$/.test(beforeAttr) || beforeAttr.trim() === "";
    const tagVerbShape = /(?:ed|said)$/.test(attr[1].toLowerCase());
    if (!(strippedGap && tagVerbShape && sentence !== narration)) {
      push("attributive", sentence);
    }
  }

  // POSSESSIVE ATTRIBUTE. "Holmes's long thin fingers …"
  const possRe = new RegExp(`${NAME}['’]s\\s+(?:[a-z-]+[,\\s]+){0,3}${APPEARANCE_NOUN}${RB}`, "i");
  if (inNarration && possRe.test(narration) && hasDescriptiveAppearance(narration)) {
    push("possessive", sentence);
  }

  // PRONOUN ATTRIBUTE, only when no other cast member shares the sentence:
  // "Her eyes were grey" is evidence for exactly one person, and the moment a
  // second is named the referent is a guess.
  //
  // ★ AND THE PRONOUN'S GENDER MUST FIT THE CHARACTER. "Her figure was
  //   elegant, and she walked well; but Darcy … was still inflexibly
  //   studious" names only Darcy, so the old guard passed it — and handed
  //   Miss Bingley's figure to a man written "Mr. Darcy" four hundred times.
  const pronounNounRe = new RegExp(`${LB}(his|her|their)\\s+(?:[a-z-]+[,\\s]+){0,4}${APPEARANCE_NOUN}${RB}`, "i");
  if (inNarration && !otherFormsRe.test(narration)) {
    const pn = pronounNounRe.exec(narration);
    if (pn && pronounCompatible(pn[1], klass) && hasDescriptiveAppearance(narration)) {
      push("pronoun-attr", sentence);
    }
  }

  // INTERIORITY. The name as subject of a cognition or emotion verb. This is
  // the viewpoint character's channel, and it is where their characterization
  // lives when the narration never stops to describe them.
  if (inNarration && new RegExp(`${NAME}\\s+(?:[a-z]+ly\\s+)?(?:had\\s+)?${INTERIORITY_VERB}${RB}`, "i").test(narration)) {
    push("interiority", sentence);
  }

  // HABITUAL. "Marilla always …", "he was in the habit of …" with the name as
  // the frame's subject: durable conduct, the personality channel's backbone.
  if (inNarration && new RegExp(`${NAME}\\s+(?:[a-z]+\\s+){0,2}${HABIT_FRAME}${RB}`, "i").test(narration)) {
    push("habitual", sentence);
  }

  // RELATION. "Elizabeth's father", "the daughter of Mr. Bennet". Dialogue
  // counts here: "my brother John" is how relations are usually stated.
  if (new RegExp(`${NAME}['’]s\\s+(?:[a-z]+\\s+){0,2}${RELATION_NOUN}${RB}`, "i").test(sentence)
      || new RegExp(`${LB}${RELATION_NOUN}\\s+(?:of|to)\\s+${NAME}`, "i").test(sentence)) {
    push("relation", sentence);
  }

  // LORE, and THE CHARACTER MUST BE ITS SUBJECT (or the patient of a passive).
  // At most three words between name and predicate: room for an adverb or a
  // relative pronoun, not for a second clause. That constraint is what keeps
  // the drawing-room blinds out of Holmes's biography.
  // ★★ NO POSSESSIVE SUBJECT IN THE LORE CHANNEL. "Vey's kettle had been in
  //    the safe-house kitchen longer than…" is a history OF THE KETTLE, and
  //    it reached the writer as Vey's background. The possessive was allowed
  //    so "Marlow's brother worked the nets" could count as his background,
  //    but that same permission hands the character every object and relative
  //    the sentence owns. A biography needs the person as its subject.
  const loreActive = new RegExp(`${NAME}\\s+(?:[a-z]+\\s+){0,3}${LORE_PREDICATE}`, "i");
  const lorePassive = new RegExp(`${LORE_PREDICATE}\\s+(?:[a-z]+\\s+){0,3}${NAME}`, "i");
  const activeHit = loreActive.test(sentence);
  const passiveHit = !activeHit && lorePassive.test(sentence);
  if (activeHit || passiveHit) {
    // Provenance from where the PREDICATE sits, not from which regex shape
    // matched — the probe's version sent every passive hit to "spoken", which
    // mislabels ordinary narrated passives.
    const inNarr = activeHit ? loreActive.test(narration) : lorePassive.test(narration);
    push(inNarr ? "lore-narrated" : "lore-spoken", sentence);
  }
}

export interface HarvestProgress {
  /** 0..1 across the whole harvest. */
  fraction: number;
  chapter: number;
  chapterTotal: number;
}

export interface HarvestOptions {
  onProgress?: (progress: HarvestProgress) => void;
  signal?: AbortSignal;
  /** Chapters between cooperative yields. The default keeps a keystroke alive. */
  yieldEvery?: number;
}

function makeAbortError(): Error {
  const error = new Error("Dossier harvest aborted");
  error.name = "AbortError";
  return error;
}

async function yieldToMainThread() {
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

/** The engine's paragraph split — same expression as max-ask-context and the
 *  analysis runner; a different split hands the pronoun resolver different
 *  paragraphs than the ones the app annotates. */
function splitEngineParagraphs(content: string): string[] {
  return content.split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean);
}

/**
 * ONE pass over the novel harvests EVERY cast member. The expensive work
 * (speech detection, pronoun resolution) is per chapter and shared, so a
 * writer filling ten cards pays the manuscript read once. Cache by
 * `dossierSignature`; any edit invalidates.
 */
export async function harvestDossierEvidence(
  novel: Novel,
  cast: ReadonlyArray<Pick<WorldCharacter, "name" | "aliases">>,
  options: HarvestOptions = {},
): Promise<DossierEvidence> {
  const cleanCast = cast
    .map((c) => ({ name: c.name.trim(), aliases: (c.aliases ?? []).map((a) => a.trim()).filter(Boolean) }))
    .filter((c) => c.name.length >= 2);

  const characters: CharacterDossierEvidence[] = cleanCast.map((c) => ({
    name: c.name,
    forms: [c.name, ...c.aliases.filter((a) => a.toLowerCase() !== c.name.toLowerCase())],
    pronounClass: "unknown" as HonorificClass,
    counts: {
      mentions: 0, chapters: [], chapterTotal: novel.chapters.length,
      speechLines: 0, meanLineWords: 0, agentVerbs: [], distinctiveVerbs: [],
      speechVerbs: [], plainSaidRatio: 0, interiorityCount: 0, isViewpoint: false,
      station: null, coPresent: [],
    },
    byChannel: emptyByChannel(),
  }));
  const byName = new Map(characters.map((c) => [c.name, c]));

  // Identity for the pronoun resolver: every alias maps to its canonical name.
  const aliasCanon = new Map<string, string>();
  for (const c of characters) {
    for (const form of c.forms) aliasCanon.set(form.toLowerCase().trim(), c.name);
  }
  const speechNames = characters.flatMap((c) => c.forms);

  // Honorific dominance needs the whole text once, before any harvesting.
  const fullText = novel.chapters.map((c) => c.content).join("\n");
  const perChar = characters.map((c) => {
    const klass = honorificClassOf(fullText, c.forms);
    return {
      ev: c,
      klass,
      maskRe: otherFamilyRe(c.forms, klass),
      formsRe: new RegExp(`${LB}(?:${c.forms.map(esc).join("|")})${RB}`),
      formsReG: new RegExp(`${LB}(?:${c.forms.map(esc).join("|")})${RB}`, "g"),
      othersRe: (() => {
        const others = characters.filter((o) => o !== c).flatMap((o) => o.forms);
        return others.length ? new RegExp(`${LB}(?:${others.map(esc).join("|")})${RB}`) : /$^/;
      })(),
      verbCounts: new Map<string, number>(),
      speechVerbCounts: new Map<string, number>(),
      // Which possessive the RESOLVER assigned this character, counted. The
      // honorific test needs "Mr./Miss X" forms and most modern prose has
      // none, so it returns unknown for a whole cast whose genders the
      // narration makes obvious. The resolver already decided; this reads
      // its decisions back instead of guessing from a name.
      ownedHis: 0,
      ownedHer: 0,
      saidCount: 0,
      station: null as string | null,
      lineWords: [] as number[],
    };
  });
  const perCharByName = new Map(perChar.map((pc) => [pc.ev.name, pc]));

  const yieldEvery = Math.max(1, options.yieldEvery ?? 1);
  const chapterTotal = Math.max(1, novel.chapters.length);

  for (let chIndex = 0; chIndex < novel.chapters.length; chIndex++) {
    if (options.signal?.aborted) throw makeAbortError();
    const chapter = novel.chapters[chIndex];
    options.onProgress?.({ fraction: chIndex / chapterTotal, chapter: chIndex + 1, chapterTotal });

    const paragraphs = splitEngineParagraphs(chapter.content);
    const speech = characters.length
      ? detectSpeechInChapter(paragraphs, speechNames, { intelligenceLevel: "high" })
      : [];
    const owners = characters.length
      ? resolvePronounOwners(paragraphs, speech, speechNames, aliasCanon)
      : [];

    for (const pc of perChar) {
      if (pc.formsRe.test(maskOtherFamily(chapter.content, pc.maskRe))) {
        pc.ev.counts.chapters.push(chapter.number);
      }
    }

    paragraphs.forEach((paragraph, pIndex) => {
      // Speech stats: attributed lines per character, canonicalised.
      for (const segment of speech[pIndex]?.segments ?? []) {
        if (segment.type !== "speech" || !segment.speaker) continue;
        if ((segment.confidence ?? 0) < 0.65) continue;
        const canonical = aliasCanon.get(segment.speaker.toLowerCase().trim());
        const pc = canonical ? perChar.find((x) => x.ev.name === canonical) : undefined;
        if (!pc) continue;
        pc.ev.counts.speechLines += 1;
        const words = paragraph.slice(segment.start, segment.end).trim().split(/\s+/).filter(Boolean).length;
        pc.lineWords.push(words);
      }

      // ★★ THE PRONOUN-OWNED CHANNEL — the one that finds the descriptions the
      //    name-anchored channels cannot see. Trust only the resolver's two
      //    strong rungs (0.9 tag-adjacent, 0.7 gender-known); the 0.5 fallback
      //    is a guess, and a wrongly-owned description is worse than a missing
      //    one.
      for (const owner of owners[pIndex] ?? []) {
        if (owner.confidence < 0.7) continue;
        if (!/^(?:his|her|hers)$/i.test(owner.pronoun)) continue;
        const canonical = aliasCanon.get(owner.owner.toLowerCase().trim()) ?? owner.owner;
        const ev = byName.get(canonical);
        if (!ev) continue;
        // ★ The pronoun resolver's gender map is CHAPTER-LOCAL: in Georgiana's
        //   chapters "Darcy" reads female and `her figure` lands on her
        //   brother. The character's whole-book honorific class outranks a
        //   chapter-local guess.
        const pc = perCharByName.get(canonical);
        if (pc && !pronounCompatible(owner.pronoun, pc.klass)) continue;
        if (pc) {
          if (/^his$/i.test(owner.pronoun)) pc.ownedHis += 1;
          else if (/^hers?$/i.test(owner.pronoun)) pc.ownedHer += 1;
        }
        if (ev.byChannel["pronoun-owned"].length >= SPANS_PER_CHANNEL_MAX) continue;
        const after = paragraph.slice(owner.end, owner.end + 60);
        // {0,4} because Austen's one description of Darcy is "his fine, tall
        // person, handsome features" — four tokens between pronoun and the
        // listed noun. {0,3} silently excluded it.
        if (!new RegExp(`^\\s*(?:[a-z-]+[,\\s]+){0,4}${APPEARANCE_NOUN}${RB}`, "i").test(after)) continue;
        // The noun alone is an action beat ("reopened his eyes"); the adjective
        // is what makes it a description, and it must be in the pronoun's OWN
        // clause, not anywhere in a 120-char window.
        const clause = `${owner.pronoun}${after}`;
        if (!hasDescriptiveAppearance(clause)) continue;
        const host = splitSentences(paragraph).find((s) => owner.start >= s.start && owner.start < s.end);
        if (!host) continue;
        ev.byChannel["pronoun-owned"].push({
          channel: "pronoun-owned",
          chapter: chapter.number,
          text: host.text.replace(/\s+/g, " ").trim(),
        });
      }

      // Name-anchored channels plus agent verbs, per sentence. Each character
      // sees the sentence with its OTHER family members masked out, so "Miss
      // Darcy" can neither count as a mention of her brother nor donate her
      // description to him.
      for (const sentence of splitSentences(paragraph)) {
        const s = sentence.text;
        if (s.length < 12) continue;
        for (const pc of perChar) {
          const sMasked = maskOtherFamily(s, pc.maskRe);
          if (!pc.formsRe.test(sMasked)) continue;
          const narration = stripQuotes(sMasked);
          pc.ev.counts.mentions += (sMasked.match(pc.formsReG) ?? []).length;
          harvestSentence(pc.ev, s, sMasked, narration, chapter.number, pc.othersRe, pc.klass);
          const verb = agentVerbAfter(narration, pc.formsRe);
          if (verb) pc.verbCounts.set(verb, (pc.verbCounts.get(verb) ?? 0) + 1);

          // Speech attribution, BOTH orders: "Mira said" dominates modern
          // prose, "said Mira" the 19th-century corpus, and a channel that
          // reads only one of them is blind to half the register range.
          const nameAlt = pc.ev.forms.map(esc).join("|");
          const tag = new RegExp(
            `${LB}(?:${nameAlt})${RB}\\s+([a-z]+)|${LB}([a-z]+)\\s+(?:${nameAlt})${RB}`,
          ).exec(narration);
          const tagVerb = (tag?.[1] ?? tag?.[2] ?? "").toLowerCase();
          if (tagVerb === "said") pc.saidCount += 1;
          else if (MARKED_SPEECH_VERB.has(tagVerb) && /["“”]/.test(s)) {
            pc.speechVerbCounts.set(tagVerb, (pc.speechVerbCounts.get(tagVerb) ?? 0) + 1);
          }

          // Station, from the first direct definition that names one.
          if (!pc.station) {
            const def = new RegExp(
              `${LB}(?:${nameAlt})${RB}(?:,|\\s+(?:was|is|had been))\\s+(?:an?|the)\\s+([^,.;]{0,60})`,
            ).exec(narration);
            const hit = def ? STATION_RE.exec(def[1]) : null;
            if (hit) pc.station = hit[1].toLowerCase();
          }
        }
      }
    });

    if (chIndex + 1 < novel.chapters.length && (chIndex + 1) % yieldEvery === 0) {
      await yieldToMainThread();
    }
  }

  // How often does the whole cast use each verb? The denominator for
  // distinctiveness, so "said" cancels and "delivered" survives.
  const castVerbTotals = new Map<string, number>();
  for (const pc of perChar) {
    for (const [verb, n] of pc.verbCounts) {
      castVerbTotals.set(verb, (castVerbTotals.get(verb) ?? 0) + n);
    }
  }

  for (const pc of perChar) {
    pc.ev.counts.agentVerbs = [...pc.verbCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    // Distinctive = this character owns most of the cast's uses of it, and
    // it is not an ambient verb of prose. Two uses minimum: one is a moment.
    pc.ev.counts.distinctiveVerbs = [...pc.verbCounts.entries()]
      .filter(([verb, n]) => {
        if (AMBIENT_VERB.has(verb) || n < 2) return false;
        const castTotal = castVerbTotals.get(verb) ?? n;
        return n / castTotal >= 0.6;
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([verb]) => verb);
    pc.ev.counts.speechVerbs = [...pc.speechVerbCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const markedTotal = [...pc.speechVerbCounts.values()].reduce((a, b) => a + b, 0);
    pc.ev.counts.plainSaidRatio = pc.saidCount + markedTotal > 0
      ? pc.saidCount / (pc.saidCount + markedTotal)
      : 0;
    pc.ev.counts.interiorityCount = pc.ev.byChannel.interiority.length;
    pc.ev.counts.station = pc.station;
    // Honorific dominance first (whole-book, strongest); the resolver's own
    // possessive assignments second; "unknown" -> they/their, which is
    // correct for an unresolved referent rather than a guess.
    pc.ev.pronounClass = pc.klass !== "unknown" ? pc.klass
      : pc.ownedHis >= 3 && pc.ownedHis > pc.ownedHer * 2 ? "masc"
      : pc.ownedHer >= 3 && pc.ownedHer > pc.ownedHis * 2 ? "fem"
      : "unknown";
    pc.ev.counts.meanLineWords = pc.lineWords.length
      ? Math.round(pc.lineWords.reduce((a, b) => a + b, 0) / pc.lineWords.length)
      : 0;
    pc.ev.counts.coPresent = perChar
      .filter((o) => o !== pc)
      .map((o) => [o.ev.name, o.ev.counts.chapters.filter((c) => pc.ev.counts.chapters.includes(c)).length] as [string, number])
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    // The two derived channels are written here, not per sentence, because
    // both are DISTRIBUTIONS: neither is knowable until the whole book has
    // been read and the rest of the cast counted.
    if (pc.ev.counts.distinctiveVerbs.length > 0) {
      pc.ev.byChannel.action.push({
        channel: "action", chapter: pc.ev.counts.chapters[0] ?? 1,
        text: `Across the book ${pc.ev.name} is the one who ${pc.ev.counts.distinctiveVerbs.join(", ")}.`,
      });
    }
    const marked = pc.ev.counts.speechVerbs.filter(([v]) => v !== "said");
    if (marked.length > 0 && pc.ev.counts.speechLines >= 4) {
      pc.ev.byChannel["speech-manner"].push({
        channel: "speech-manner", chapter: pc.ev.counts.chapters[0] ?? 1,
        text: `${pc.ev.name}'s dialogue is attributed with ${marked.map(([v, n]) => `${v} (${n})`).join(", ")}.`,
      });
    }
  }

  // ★ VIEWPOINT IS RELATIVE TO THE CAST, so it can only be decided once every
  //   character has been counted. The rate matters, not the raw count: a
  //   character named 400 times will out-count one named 40 on any measure,
  //   and what marks a viewpoint is how often their NAME comes with their
  //   INTERIOR rather than how often it appears.
  const rates = perChar.map((pc) => ({
    pc,
    rate: pc.ev.counts.mentions > 0 ? pc.ev.counts.interiorityCount / pc.ev.counts.mentions : 0,
  }));
  const median = [...rates].map((r) => r.rate).sort((a, b) => a - b)[Math.floor(rates.length / 2)] ?? 0;
  for (const { pc, rate } of rates) {
    // Twice the cast median and at least three openings: enough to be a
    // pattern rather than two stray sentences, and loose enough that a
    // second viewpoint is not squeezed out by the first.
    pc.ev.counts.isViewpoint = pc.ev.counts.interiorityCount >= 3 && rate >= Math.max(0.008, median * 2);
  }

  options.onProgress?.({ fraction: 1, chapter: chapterTotal, chapterTotal });
  return { characters, byName, signature: dossierSignature(novel, cast) };
}

// ── pack assembly ─────────────────────────────────────────────────────────

/** Information density per channel, best first, used only to order the
 *  round-robin; never to starve a channel (see selectDossierSpans). */
const CHANNEL_RANK: Record<DossierChannel, number> = {
  // Direct definition outranks everything: it is what the book says outright.
  identity: 0,
  appositive: 1, possessive: 2, "pronoun-owned": 3, "pronoun-attr": 4,
  copular: 5, attributive: 6,
  // Indirect definition through conduct, the channel modern prose leans on.
  habitual: 1, action: 2, interiority: 1, "speech-manner": 3,
  relation: 0, "lore-narrated": 1, "lore-spoken": 2,
};

export const DOSSIER_SPAN_CAP = 14;
const SPAN_CHARS = 300;
const PER_CHANNEL_QUOTA = 3;

/** Experiment surface: the bench may widen the evidence budget; the shipped
 *  defaults are exactly the constants above, so an absent opts is the
 *  measured behaviour byte for byte. */
export interface PackOptions {
  spanCap?: number;
  perChannelQuota?: number;
}

/** What the reader must know about how a span was found, in one word. `said`
 *  marks speech about the character (can be wrong in-world); `pronoun` marks a
 *  machine-resolved referent (can be wrong mechanically). */
const PROVENANCE: Record<DossierChannel, string> = {
  identity: "named",
  appositive: "named", copular: "named", attributive: "named", possessive: "named",
  "pronoun-attr": "pronoun", "pronoun-owned": "pronoun", habitual: "named",
  // `counted` marks a span the harness DERIVED from whole-book statistics
  // rather than lifted from a sentence — the reader must be able to tell a
  // quotation from a tally.
  action: "counted", "speech-manner": "counted",
  interiority: "named",
  relation: "named", "lore-narrated": "named", "lore-spoken": "said",
};

export interface NumberedSpan {
  n: number;
  channel: DossierChannel;
  chapter: number;
  text: string;
}

/**
 * ★★ ROUND-ROBIN ACROSS CHANNELS, NEVER BEST-CHANNEL-FIRST. Ranking the pool
 *    by channel quality filled Elizabeth Bennet's whole budget with
 *    "Elizabeth, who had a letter to write" shapes and starved out the one
 *    channel holding her actual description. Channel SHAPE does not predict
 *    descriptive CONTENT; every channel gets a quota and the reader chooses.
 *
 * ★ DESCRIBABLE SPANS FIRST INSIDE THE VISUAL CHANNELS. The gate asks "does
 *   anything describable exist in the pool"; selection must then guarantee the
 *   describable spans actually reach the pack, or the gate promises what the
 *   pack does not contain.
 */
export function selectDossierSpans(ev: CharacterDossierEvidence, opts: PackOptions = {}): DossierSpan[] {
  const spanCap = opts.spanCap ?? DOSSIER_SPAN_CAP;
  const quota = opts.perChannelQuota ?? PER_CHANNEL_QUOTA;
  const seen = new Set<string>();
  const queues = new Map<DossierChannel, DossierSpan[]>();
  for (const channel of DOSSIER_CHANNELS) {
    const pool = [...ev.byChannel[channel]].sort((a, b) => {
      if (VISUAL_CHANNELS.includes(channel)) {
        const da = hasDescriptiveAppearance(a.text) ? 0 : 1;
        const db = hasDescriptiveAppearance(b.text) ? 0 : 1;
        if (da !== db) return da - db;
      }
      // Earliest chapter otherwise: a character's first full description is
      // almost always the fullest the book ever gives.
      return a.chapter - b.chapter;
    });
    const kept: DossierSpan[] = [];
    for (const span of pool) {
      const key = span.text.slice(0, 60).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(span);
      if (kept.length >= quota) break;
    }
    queues.set(channel, kept);
  }

  const order = [...DOSSIER_CHANNELS].sort((a, b) => CHANNEL_RANK[a] - CHANNEL_RANK[b]);
  const out: DossierSpan[] = [];
  for (let round = 0; round < quota && out.length < spanCap; round++) {
    for (const channel of order) {
      const span = queues.get(channel)?.[round];
      if (span && out.length < spanCap) out.push(span);
    }
  }
  return out.sort((a, b) => a.chapter - b.chapter);
}

export interface DossierPack {
  name: string;
  aliases: string[];
  stats: string;
  spans: NumberedSpan[];
  /**
   * ★★ THE FIELD GATES, POOL-LEVEL, COMPUTED BEFORE ANY MODEL RUNS. A field
   *    whose set is empty is never asked for and never accepted — that is the
   *    measured fix for both tiers inventing a beard, a robe and a staff for a
   *    character with zero evidence. Span numbers, so the same sets serve as
   *    citation whitelists per field.
   */
  visualCandidates: number[];
  traitCandidates: number[];
  loreCandidates: number[];
  text: string;
}

export function buildDossierPack(ev: CharacterDossierEvidence, opts: PackOptions = {}): DossierPack {
  const chosen = selectDossierSpans(ev, opts).map((s, i) => ({
    n: i + 1,
    channel: s.channel,
    chapter: s.chapter,
    text: s.text.length > SPAN_CHARS ? `${s.text.slice(0, SPAN_CHARS)}…` : s.text,
  }));

  const c = ev.counts;
  const statBits = [
    `named ${c.mentions} times across ${c.chapters.length} of ${c.chapterTotal} chapters`,
    `first named in chapter ${c.chapters[0] ?? 1}`,
    c.speechLines > 0
      ? `speaks ${c.speechLines} lines, ${c.meanLineWords} words each on average`
      : "never speaks a line of dialogue",
    c.agentVerbs.length
      ? `most often seen to: ${c.agentVerbs.map(([v]) => v).join(", ")}`
      : "",
    c.coPresent.length
      ? `most often on the page with ${c.coPresent.map(([n, k]) => `${n} (${k} ch)`).join(", ")}`
      : "shares no chapter with another cast member",
    // Told to the model plainly: a viewpoint character is described less by
    // construction, so thin appearance evidence is expected rather than a
    // sign the search failed.
    c.isViewpoint ? "the book opens this character's thoughts — a viewpoint character" : "",
  ].filter(Boolean);
  const stats = statBits.join(" · ");

  // Pool-level candidate tests, then narrowed to what actually made the pack.
  // (Selection prefers describable spans inside visual channels precisely so
  // this narrowing cannot silently empty a set the pool satisfied.)
  const visualCandidates = chosen
    .filter((s) => VISUAL_CHANNELS.includes(s.channel) && hasDescriptiveAppearance(s.text))
    .map((s) => s.n);
  const traitCandidates = chosen
    .filter((s) => TRAIT_CHANNELS.includes(s.channel) || s.channel === "habitual")
    .map((s) => s.n);
  // ★ RELATION SPANS ARE NOT BACKGROUND CANDIDATES. "The eldest of them, a
  //   sensible, intelligent young woman, about twenty-seven, was Elizabeth's
  //   intimate friend" harvests under Elizabeth and describes CHARLOTTE — a
  //   relation span describes the related party as often as the character,
  //   and the model turned that one into "Elizabeth is the eldest … about
  //   twenty-seven", grounded and false. Relation spans stay in the pack for
  //   the writer's own reading; the model may not build background from them.
  const loreCandidates = chosen
    .filter((s) => s.channel === "lore-narrated" || s.channel === "lore-spoken")
    .map((s) => s.n);

  const lines = [
    `CHARACTER: ${ev.name}`,
    ...(ev.forms.length > 1 ? [`ALSO WRITTEN: ${ev.forms.slice(1).join(", ")}`] : []),
    "",
    "COUNTED FACTS (measured, not opinion)",
    stats,
    "",
    "PASSAGES — verbatim, numbered. These are the only evidence there is.",
    ...chosen.map((s) => `[${s.n}] ch${s.chapter} (${PROVENANCE[s.channel]}): ${s.text}`),
  ];

  return {
    name: ev.name,
    aliases: ev.forms.slice(1),
    stats,
    spans: chosen,
    visualCandidates,
    traitCandidates,
    loreCandidates,
    text: lines.join("\n"),
  };
}

// ── the max-tier requests: ONE FIELD PER CALL ─────────────────────────────
//
// ★★ THREE FIELDS AT ONCE MADE THE 4B GO SILENT, AND THE A/B PROVES THE FIX.
//    Asked for appearance, personality and background in one schema over the
//    full 14-span pack, the model returned every field empty at confidence 0
//    on all four RICH packs (Elizabeth, Darcy, Anne, Van Helsing) while
//    answering the small packs — the safe harbor ("") wins everywhere once
//    the selection problem is three criteria over fourteen options. The same
//    model, asked for ONE field over ONLY that field's candidate spans,
//    answered "dark eyes" citing the right span at 0.9 and cited all three
//    Anne spans correctly. So each field is its own call, its request shows
//    only that field's eligible spans, and a field with no eligible spans is
//    never asked at all. Latency is bounded by three small calls, each faster
//    than the one big one was.

const FIELD_MAX: Record<DossierFieldKey, number> = {
  appearance: 140,
  personality: 160,
  background: 160,
};

/** Fixed per-field schemas: three grammar-cache entries, each reused across
 *  every character (a fixed schema is a grammar-cache hit; never input-scale
 *  these). Spans FIRST — the grammar emits in declaration order, so the model
 *  selects its evidence before it composes ("attribute first, then generate";
 *  the same reason entity-review puts reason before type). */
function fieldSchema(field: DossierFieldKey) {
  return {
    type: "object",
    properties: {
      spans: { type: "array", items: { type: "integer" }, maxItems: 3 },
      [field]: { type: "string", maxLength: FIELD_MAX[field] },
      confidence: { type: "number" },
    },
  } as const;
}
export const DOSSIER_FIELD_SCHEMAS: Record<DossierFieldKey, ReturnType<typeof fieldSchema>> = {
  appearance: fieldSchema("appearance"),
  personality: fieldSchema("personality"),
  background: fieldSchema("background"),
};

type FieldAsk = { definition: string; question: string };

const CHARACTER_ASK: Record<DossierFieldKey, FieldAsk> = {
  appearance: {
    definition: `spans: FIRST. The numbers of the passages that state what this person LOOKS
  LIKE — body, face, hair, eyes, age, clothing. A passage where they merely do
  something with a body part is not appearance. [] if none qualify.
appearance: at most 20 words, from ONLY those passages, their own words where
  you can. "" if spans is [].`,
    question: "What does {name} look like?",
  },
  personality: {
    definition: `spans: FIRST. The numbers of the passages that show what this person is
  LIKE — temperament, habits, manner, how they treat people. [] if none do.
personality: at most 25 words. Name the TRAITS the passages show. You may use
  your own words for a trait, but never invent a name, a place or a number
  that is not in the passages. "" if spans is [].`,
    question: "What is {name} like?",
  },
  background: {
    definition: `spans: FIRST. The numbers of the passages that state what is KNOWN about
  this person — origins, family, history. [] if none do.
background: at most 25 words, from ONLY those passages. A passage tagged
  (said) is one character talking about another and may be unfair or wrong;
  report it as "said to …", never as fact. "" if spans is [].`,
    question: "What is known about {name}?",
  },
};

/**
 * ★ THE FIELD NAMES STAY THE SAME ON THE WIRE across all four types, and
 *   that is deliberate: the schemas are fixed, so the grammar cache is hit
 *   on every call regardless of type. Only the DEFINITIONS change. Renaming
 *   `appearance` to `look` for places would mint a second grammar for no
 *   gain and lose the cache — the repeated-schema lesson from the batch
 *   loop, applied here before it costs anything.
 */
const PLACE_ASK: Record<DossierFieldKey, FieldAsk> = {
  appearance: {
    definition: `spans: FIRST. The numbers of the passages that state what this place is LIKE
  to be in — its look, size, sound, smell, weather, buildings. [] if none do.
appearance: at most 20 words, from ONLY those passages, their own words where
  you can. "" if spans is [].`,
    question: "What is {name} like to be in?",
  },
  personality: {
    definition: `spans: FIRST. The numbers of the passages that show what this place is FOR
  and who is in it — its purpose, who lives or works there, what happens
  there. [] if none do.
personality: at most 25 words. Never invent a name, a place or a number that
  is not in the passages. "" if spans is [].`,
    question: "What happens at {name}, and who is there?",
  },
  background: {
    definition: `spans: FIRST. The numbers of the passages that state this place's HISTORY —
  who built or founded it, what happened here before, what it used to be.
  [] if none do.
background: at most 25 words, from ONLY those passages. A passage tagged
  (said) is a character's claim; report it as "said to …". "" if spans is [].`,
    question: "What is known about the history of {name}?",
  },
};

const GROUP_ASK: Record<DossierFieldKey, FieldAsk> = {
  appearance: {
    definition: `spans: FIRST. The numbers of the passages that state how this group is
  RECOGNISED — its colours, marks, dress, seat, or anything worn or shown.
  [] if none do.
appearance: at most 20 words, from ONLY those passages. "" if spans is [].`,
    question: "How is {name} recognised?",
  },
  personality: {
    definition: `spans: FIRST. The numbers of the passages that show what this group DOES
  and how it behaves — what it controls, demands, forbids, or is trying to
  achieve. [] if none do.
personality: at most 25 words. Never invent a name, a place or a number that
  is not in the passages. "" if spans is [].`,
    question: "What does {name} do, and how does it behave?",
  },
  background: {
    definition: `spans: FIRST. The numbers of the passages that state this group's ORIGIN —
  who founded it, when, out of what. [] if none do.
background: at most 25 words, from ONLY those passages. A passage tagged
  (said) is a character's claim; report it as "said to …". "" if spans is [].`,
    question: "Where did {name} come from?",
  },
};

const ASK_BY_KIND: Record<DossierKind, Record<DossierFieldKey, FieldAsk>> = {
  character: CHARACTER_ASK,
  place: PLACE_ASK,
  faction: GROUP_ASK,
  // A doctrine, protocol or institution behaves like a group for these
  // three questions: what marks it, what it does, where it came from.
  entity: GROUP_ASK,
};

const SUBJECT_WORD: Record<DossierKind, string> = {
  character: "person", place: "place", faction: "group", entity: "thing",
};

function fieldSystem(field: DossierFieldKey, kind: DossierKind): string {
  const ask = ASK_BY_KIND[kind][field];
  const subject = SUBJECT_WORD[kind];
  return `You fill in ONE field of a ${subject === "person" ? "character" : subject} card for a novel, from evidence a
search has already gathered. You cannot read the manuscript. The numbered
passages ${field === "personality" ? "and counted facts " : ""}are all the evidence there is.

Answer as JSON: {"spans","${field}","confidence"} in that order.
${ask.definition}
confidence: 0 to 1, how much the passages actually settle this. Never above 1.

A passage tagged (pronoun) had its subject resolved by a machine and may
belong to something else; trust it less. A passage tagged (counted) is a
tally the search made across the whole book, not a quotation. Passage numbers
are not consecutive; cite them exactly as printed.
An empty answer is a correct answer. Writing something true of most ${subject === "person" ? "people" : `${subject}s`} is
NOT an answer. Never use anything you know about this book from elsewhere.`;
}

export interface DossierFieldRequest {
  field: DossierFieldKey;
  systemPrompt: string;
  userText: string;
  schema: ReturnType<typeof fieldSchema>;
  maxTokens: number;
}

/**
 * ★★ WHICH FIELDS EARN A THINKING PASS, and it is not all of them.
 *
 *    A grammar masks think tokens from token zero, so real thinking costs a
 *    second unconstrained call. think.ts's policy is the one to follow:
 *    background batch work never thinks, interactive work thinks when the
 *    TASK SHAPE earns it. Here the shapes differ sharply per field:
 *
 *    · appearance and background are EXTRACTIVE. The answer is in one of the
 *      passages and the job is to find and copy it; reasoning adds latency
 *      to a lookup. They do not think.
 *    · personality is ABSTRACTIVE and multi-span: the model has to read
 *      several pieces of conduct and name the trait they share. That is the
 *      inference shape think.ts's own rules select for, and it is where the
 *      measured quality lives.
 *
 *    Thinking is also skipped when there is nothing to weigh — a single
 *    candidate span cannot support a comparison, so a lone span is a lookup
 *    whatever the field.
 */
export function decideDossierThinking(
  field: DossierFieldKey,
  candidateCount: number,
): { think: boolean; budget: number; reason: string } {
  if (field !== "personality") return { think: false, budget: 0, reason: "extractive-field" };
  if (candidateCount < 2) return { think: false, budget: 0, reason: "single-span" };
  // ★★ THE BUDGET IS SET BY WHERE THE CONCLUSION SITS, NOT BY THE TASK.
  //
  //    At 320 every note came back exactly at the cap, opening "Okay, I need
  //    to figure out what X is like… let me go through each passage" and
  //    stopping mid-walk: the model narrating its process and never reaching
  //    the conclusion the second call needs. think.ts records the identical
  //    failure at 448 and 768 on the ask surface.
  //
  //    At 1024 the notes completed (~4000 chars) and cost THIRTY SECONDS a
  //    field, for two answers better, two equal and one worse. That is a bad
  //    trade at 3x the card's whole latency.
  //
  //    A conclusion-first prompt at 512 was tried to buy the same notes for
  //    half the time. It backfired twice over: the model spent its opening
  //    lines RESTATING THE INSTRUCTION ("I have to write a VERDICT on the
  //    first line…"), and every answer collapsed toward a generic trait
  //    triple — "reliable" led four of five characters, and Mira's rich
  //    "deeply connected to others through shared history and care" became
  //    "community-oriented". Reasoning about what evidence ADDS UP TO pulls
  //    a model toward category labels; answering directly keeps it near the
  //    text. That is the cost of thinking on this task, and it is why the
  //    budget is not the only thing that had to be right.
  //
  //    1024 is what ships. Measured on five characters of the owner's
  //    manuscript: two answers materially richer (Mira gained "nurturing and
  //    protective", Tessa gained "skilled in practical crafts"), two equal,
  //    one thinner. It costs ~30s on top of a ~10s card, which is why only
  //    this one field spends it and why the UI names the wait.
  return { think: true, budget: 1024, reason: "multi-span-inference" };
}

/** The reasoning prompt for a field. Same evidence, different instruction:
 *  reach a conclusion in prose, do not produce the answer's JSON. */
export function buildFieldThinkRequest(
  pack: DossierPack,
  field: DossierFieldKey,
  kind: DossierKind = "character",
): DossierFieldRequest | null {
  const base = buildFieldRequest(pack, field, kind);
  if (!base) return null;
  return {
    ...base,
    // ★ LET IT WALK THE EVIDENCE. A conclusion-first variant was measured and
    //   reverted: instructing the model to lead with a verdict made it open
    //   by restating the instruction, and pushed every answer toward the same
    //   generic trait triple. This wording keeps the reasoning close to the
    //   passages, which is where the two measured gains came from.
    systemPrompt:
      `You are reading evidence about one ${SUBJECT_WORD[kind]} from a novel, to decide what it shows.\n\n`
      + `Work out which passages agree with each other, which one is the odd\n`
      + `one out, and what qualities they add up to. Stay close to what the\n`
      + `passages actually show — a quality you cannot point at a passage for\n`
      + `is not one this evidence supports.\n\n`
      + `Weigh a passage tagged (pronoun) less — its subject was resolved by a\n`
      + `machine. A passage tagged (counted) is a whole-book tally, not a\n`
      + `quotation, so it shows a pattern rather than a moment.\n`
      + `Do not write JSON and do not write the final answer. Just reason.`,
  };
}

export function fieldCandidates(pack: DossierPack, field: DossierFieldKey): number[] {
  return field === "appearance" ? pack.visualCandidates
    : field === "personality" ? pack.traitCandidates
    : pack.loreCandidates;
}

/**
 * The request for one field, or null when its gate is closed — the asking
 * side of the measured fabrication fix. Only the field's candidate spans are
 * shown, keeping the original pack numbering so citations stay comparable
 * across fields.
 */
export function buildFieldRequest(
  pack: DossierPack,
  field: DossierFieldKey,
  kind: DossierKind = "character",
  /** Conclusions from a prior unconstrained reasoning pass, if one ran. The
   *  notes ride the USER turn, never the system prompt: the system prompts
   *  in this repo stay frozen so a measured prompt cannot drift under a
   *  feature (the LENGTH_SYSTEM lesson from the writing tool). */
  notes?: string | null,
): DossierFieldRequest | null {
  const candidates = fieldCandidates(pack, field);
  if (candidates.length === 0) return null;
  const subset = pack.spans.filter((s) => candidates.includes(s.n));
  const label = kind === "character" ? "CHARACTER"
    : kind === "place" ? "PLACE" : kind === "faction" ? "GROUP" : "THING";
  const lines = [
    `${label}: ${pack.name}`,
    ...(pack.aliases.length ? [`ALSO WRITTEN: ${pack.aliases.join(", ")}`] : []),
    ...(field === "personality" ? ["", "COUNTED FACTS (measured, not opinion)", pack.stats] : []),
    "",
    "PASSAGES — verbatim, numbered. These are the only evidence there is.",
    ...subset.map((s) => `[${s.n}] ch${s.chapter} (${PROVENANCE[s.channel]}): ${s.text}`),
  ];
  const question = ASK_BY_KIND[kind][field].question.replace("{name}", pack.name);
  return {
    field,
    systemPrompt: fieldSystem(field, kind),
    userText: notes
      ? `${lines.join("\n")}\n\n${notesBlock(notes)}\n\n${question}`
      : `${lines.join("\n")}\n\n${question}`,
    schema: DOSSIER_FIELD_SCHEMAS[field],
    maxTokens: 512,
  };
}

// ── normalize · gate · ground · repair ────────────────────────────────────

export type DossierFieldKey = "appearance" | "personality" | "background";

/** `refused` = the text located nowhere in the pack (a grounding failure, and
 *  the one status that licenses the single extractive retry). `vacuous` = the
 *  text grounded but described nothing (the Darcy "standing near enough"
 *  case); retrying grounding cannot fix that, so it does not retry. */
export type GroundingStatus = "grounded" | "repaired" | "refused" | "vacuous" | "empty" | "gated";

export interface DossierField {
  text: string;
  /** Span numbers the text actually locates in, post repair. */
  spans: number[];
  status: GroundingStatus;
}

export interface DossierProposal {
  appearance: DossierField;
  personality: DossierField;
  background: DossierField;
  role: string;
  confidence: number;
}

const STOP_WORDS = new Set((
  "a an the and or but of to in on at by for with from as is are was were be been " +
  "his her their its he she they him them this that these those very quite more most much many some any " +
  "who whom which what when where how not no nor than then there here also into over under about " +
  "seems seem appears appear looks look has have had having does do did done will would could should " +
  "said say says told tell asked ask most often seen most-often man woman person character people someone thing things"
).split(/\s+/));

/** Iterative light stem: "laughingly" → "laughing" → "laugh", so a claim of
 *  "laughs easily" grounds against "laughingly answered". One layer was
 *  measured missing exactly that pair. Floor of 3 chars keeps "eyes"/"eye". */
const stemOf = (w: string): string => {
  let out = w;
  for (let i = 0; i < 2; i++) {
    const next = out.replace(/(?:ing|ed|ly|s)$/, "");
    if (next === out || next.length < 3) break;
    out = next;
  }
  return out;
};

function contentWords(line: string): string[] {
  const words = line.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
  return words.filter((w) => !STOP_WORDS.has(w) && w.length >= 4);
}

/**
 * Which of `line`'s content words fail to locate in `texts`?
 *
 * Word-boundary stem matching on both sides — the probe's bare substring test
 * would let "art" hide inside "particular". A crude FAIL is a real failure; a
 * crude pass is not a guarantee, which is why the caller also runs the
 * usefulness test and shows the citations to the writer.
 */
export function missingWords(line: string, texts: readonly string[]): string[] {
  const hayStems = new Set(
    (texts.join(" ").toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []).map(stemOf),
  );
  return contentWords(line).filter((w) => !hayStems.has(stemOf(w)));
}

/**
 * ★ GROUNDED IS NOT USEFUL, and this is the test that separates them. The 4B
 *   produced "standing near enough for her to overhear a conversation" for
 *   Darcy — every word locates, nothing describes. An appearance line must
 *   carry at least one appearance noun or one descriptive adjective; the
 *   measured answers split exactly on this line ("dark eyes" and "bushy brows"
 *   pass, the Darcy line fails).
 */
export function usefulAppearance(line: string): boolean {
  // ★ A TRUNCATION MARKER MEANS THE ANSWER NEVER FINISHED. The 4B returned
  //   "a person who i…" for a character, which tidyTruncatedText had already
  //   cut back as far as it could; three words and an ellipsis is not a
  //   description whatever else it contains.
  if (/…$/.test(line.trim())) return false;
  if (APPEARANCE_NOUN_RE.test(line)) return true;
  return (line.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [])
    .some((w) => !STOP_WORDS.has(w) && isAdjectiveShaped(w));
}

function normalizeSpanList(raw: unknown, legal: ReadonlySet<number>): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const v of raw) {
    const n = typeof v === "number" && Number.isInteger(v) ? v : NaN;
    if (!Number.isNaN(n) && legal.has(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * ★★ A TRAIT IS AN INFERENCE; A FEATURE IS A FACT. THEY NEED DIFFERENT
 *    CHECKS, and conflating them was the worst bug this feature has had.
 *
 *    Measured on the owner's manuscript, the 4B's first personality answers
 *    were the best output this engine has ever produced — "Systematic and
 *    decisive", "meticulous about her work, values her creations", "Solemn,
 *    patient, and methodical" — and word-level grounding REFUSED every one
 *    of them, because "meticulous" is precisely what the prose does not say.
 *    The extractive retry then replaced each with a bag of verbs ("worked,
 *    died, made it, good, embroidery"). The check was destroying the product.
 *
 *    Extractive and abstractive claims need different faithfulness tests.
 *    Appearance and background are FACTUAL: a physical feature or a piece of
 *    history must be stated somewhere, so word containment is right. A trait
 *    is a reading OF evidence and its words will not be in the evidence. What
 *    must still hold is that it invents no CONCRETE PARTICULARS — no names,
 *    places or numbers the manuscript never gave it — and that it cites the
 *    spans it read. That is checkable, and it is the whole check.
 */
function ungroundedParticulars(line: string, texts: readonly string[]): string[] {
  const hay = texts.join(" ").toLowerCase();
  const out: string[] = [];
  // Proper nouns, skipping the sentence-initial position (which is
  // capitalised by punctuation, not by being a name).
  for (const m of line.matchAll(/(?<=[a-z,;]\s)([A-Z][a-z]{2,})/g)) {
    if (!hay.includes(m[1].toLowerCase())) out.push(m[1]);
  }
  // Numbers, spelled or written, are particulars too.
  for (const m of line.matchAll(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred)\b/gi)) {
    if (!hay.includes(m[1].toLowerCase())) out.push(m[1]);
  }
  return [...new Set(out)];
}

/**
 * Ground one field: check against its citations, repair against the whole
 * pack, refuse only what locates nowhere.
 *
 * ★★ REPAIR BEFORE REJECT. Both tiers wrote Anne Shirley's "freckled face,
 *    solemn gray eyes" from a span they read and failed to number. The
 *    retrieval was right, the writing was right, only the citation was wrong;
 *    rejecting there throws away the best description in the pack. So the
 *    corrected citation set is recomputed from where the words actually live.
 */
function groundField(
  rawText: unknown,
  rawSpans: unknown,
  pack: DossierPack,
  candidates: readonly number[],
  useful: (line: string) => boolean,
  maxLen: number,
  abstractive: boolean,
): DossierField {
  // THE GATE, accepting side. No eligible evidence: the field is empty no
  // matter what the model wrote. This is the code half of the fix for the
  // measured fabrications; the asking half lives in the caller that skips the
  // run when every gate is empty.
  if (candidates.length === 0) return { text: "", spans: [], status: "gated" };

  // A grammar cut at maxLength leaves a ragged tail ("… a little, flat,
  // glossy, new sailor, the [ext" was observed). Tidy BEFORE grounding — the
  // fragment is not a claim and must not fail one. Order matters: the tidy
  // helper detects truncation by the string sitting AT the cap, so it must
  // see the raw length; the bracket and dangling-article strips run after.
  let text = typeof rawText === "string" ? rawText.replace(/\s+/g, " ").trim() : "";
  text = tidyTruncatedText(text, maxLen)
    .replace(/\s*\[[^\]]*$/, "")
    .replace(/[\s,]+(?:a|an|the|and|or|with|of|by|in|on|at)$/i, "");
  if (!text) return { text: "", spans: [], status: "empty" };
  if (!useful(text)) return { text: "", spans: [], status: "vacuous" };

  const legal = new Set(pack.spans.map((s) => s.n));
  const cited = normalizeSpanList(rawSpans, legal);
  const citedTexts = cited.map((n) => pack.spans.find((s) => s.n === n)?.text ?? "");

  // ABSTRACTIVE field: the words are a reading, the particulars are the
  // claim. Cite something legal and invent no names or numbers.
  if (abstractive) {
    if (cited.length === 0) return { text: "", spans: [], status: "refused" };
    const invented = ungroundedParticulars(text, pack.spans.map((s) => s.text));
    if (invented.length > 0) return { text: "", spans: [], status: "refused" };
    return { text, spans: cited, status: "grounded" };
  }

  if (cited.length > 0 && missingWords(text, citedTexts).length === 0) {
    return { text, spans: cited, status: "grounded" };
  }

  // Repair: locate every content word somewhere in the pack, then cite the
  // spans that actually carry them.
  const allTexts = pack.spans.map((s) => s.text);
  const stillMissing = missingWords(text, allTexts);
  if (stillMissing.length > 0) return { text: "", spans: [], status: "refused" };

  const needed = contentWords(text).map(stemOf);
  const repaired = pack.spans
    .filter((s) => {
      const stems = new Set((s.text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []).map(stemOf));
      return needed.some((w) => stems.has(w));
    })
    .map((s) => s.n)
    .slice(0, 4);
  return { text, spans: repaired, status: "repaired" };
}

/** ★ A ONE-WORD ANSWER IS NOT A CARD LINE. The extractive retry, squeezed,
 *  produced the single grounded word "forgotten" for Anne Shirley — verbatim,
 *  cited, and useless-to-misleading. Prose fields need enough words to state
 *  a claim; appearance keeps its own noun-or-adjective test instead ("dark
 *  eyes" is two words and perfect). */
const wordCount = (line: string) => (line.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;
/**
 * ★ THE FLOOR IS PER FIELD, because a legitimate answer has a different
 *   shape in each. A trait list is a real personality answer at three words
 *   ("curious, analytical, observant") and a flat 4-word floor was measured
 *   throwing exactly those away; background is a claim about history and
 *   needs a clause. The single word "forgotten" — the over-compressed retry
 *   that prompted the floor — still fails both.
 */
const usefulTrait = (line: string) => wordCount(line) >= 3;
const usefulProse = (line: string) => wordCount(line) >= 4;

/**
 * Route one field's raw JSON through its gate, grounding and repair. Never
 * throws; a hopeless payload degrades to an empty field. The model's own
 * confidence rides along for display, clamped.
 */
export function normalizeFieldAnswer(
  raw: unknown,
  pack: DossierPack,
  field: DossierFieldKey,
  /** Experiment surface: a variant that asks for a longer field must grade
   *  at the length it asked for, or the truncation tidy cuts a completed
   *  answer. Absent = the shipped cap, byte for byte. */
  opts: { maxLen?: number } = {},
): DossierField & { confidence: number } {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const grounded = groundField(
    value[field], value.spans, pack, fieldCandidates(pack, field),
    field === "appearance" ? usefulAppearance
      : field === "personality" ? usefulTrait : usefulProse,
    opts.maxLen ?? FIELD_MAX[field],
    // Personality is the only abstractive field: appearance and background
    // are factual claims and must locate word for word.
    field === "personality");
  const confRaw = typeof value.confidence === "number" && Number.isFinite(value.confidence)
    ? value.confidence : 0;
  return { ...grounded, confidence: Math.min(1, Math.max(0, confRaw)) };
}

export const DOSSIER_FIELDS: readonly DossierFieldKey[] = ["appearance", "personality", "background"];

/**
 * ★ A RETRY NEEDS A LICENSE, and the refusal is it. Personality summaries are
 *   naturally abstractive ("sociable" for a woman shown laughing in company),
 *   and strict grounding refuses them even when they are fair — measured on
 *   all four rich packs. The retry re-asks ONCE with an extractive
 *   instruction; its answer goes through the same grounding, and a second
 *   refusal is final. Never retry a field whose gate is closed, and never
 *   retry more than once — the writing tool's intent harness learned both
 *   rules the hard way.
 */
export function buildFieldRetryRequest(
  pack: DossierPack,
  field: DossierFieldKey,
  kind: DossierKind = "character",
  notes?: string | null,
): DossierFieldRequest | null {
  const base = buildFieldRequest(pack, field, kind, notes);
  if (!base) return null;
  return {
    ...base,
    systemPrompt: base.systemPrompt +
      `\n\nIMPORTANT: your earlier answer used words that appear in none of the` +
      `\npassages. Write the ${field} again using ONLY words copied from the` +
      `\npassages you cite. Quote their exact wording; do not summarise in your` +
      `\nown vocabulary.`,
  };
}

/** An all-gated starting proposal; the caller fills in what it asked for. */
export function emptyProposal(pack: DossierPack, role: string): DossierProposal {
  const gatedOrEmpty = (field: DossierFieldKey): DossierField =>
    ({ text: "", spans: [], status: fieldCandidates(pack, field).length === 0 ? "gated" : "empty" });
  return {
    appearance: gatedOrEmpty("appearance"),
    personality: gatedOrEmpty("personality"),
    background: gatedOrEmpty("background"),
    role,
    confidence: 0,
  };
}

/** Anything left standing after the gates? The caller shows nothing otherwise. */
export function proposalHasContent(p: DossierProposal): boolean {
  return !!(p.appearance.text || p.personality.text || p.background.text || p.role);
}

/** Is any field worth a model call at all? One empty answer costs seconds of
 *  a writer's attention; a closed gate costs nothing. */
export function packWorthAsking(pack: DossierPack): boolean {
  return DOSSIER_FIELDS.some((f) => fieldCandidates(pack, f).length > 0);
}

// ── the conservative tier: an extractive card, no generation ──────────────
//
// ★★ THE 1.7B DOES NOT DEGRADE INTO "CORRECT BUT GENERIC". Measured: it
//    abstained on three of four packs with real evidence and fabricated on the
//    fourth, and asked only to POINT at spans it chose the right person about
//    half the time. So the conservative tier is a DIFFERENT PRODUCT, not the
//    same product with a smaller model: the role is computed from counted
//    facts, and the description is offered as the manuscript's own sentences
//    for the writer to accept. Zero fabrication surface by construction.

export interface DossierQuote {
  kind: "appearance" | "personality" | "background";
  chapter: number;
  text: string;
  /** The provenance tag the pack would print: named, pronoun, said. */
  provenance: string;
}

export interface ExtractiveCard {
  /** Deterministic role, e.g. "central character". Always non-empty. */
  role: string;
  /** The counted-facts line, for display under the role. */
  factLine: string;
  quotes: DossierQuote[];
}

/**
 * Role from counted facts. Thresholds are structural, not literary: presence
 * share and speech are things the engine measures reliably, and the labels
 * claim no more than the numbers show.
 */
/**
 * ★★ A ROLE SHOULD NAME THE PERSON, NOT RANK THEM. v1 emitted four presence
 *    tiers — "central character", "major character" — which the owner
 *    correctly called too generic: every book has one of each and none of
 *    them tells a writer anything they did not already know.
 *
 *    A specific role has two parts, and both come from evidence already
 *    counted: WHAT they are (a station the prose states outright) and WHO
 *    they are to the story (the cast member they share most of the book
 *    with). Presence is demoted to the fallback it should always have been —
 *    used only when the manuscript has named neither.
 */
export function deriveRoleFromCounts(
  counts: DossierCounts,
  castRank: number,
  kind: DossierKind = "character",
): string {
  const presence = counts.chapterTotal > 0 ? counts.chapters.length / counts.chapterTotal : 0;
  // A place is never a "character", and calling one a minor character is the
  // kind of tell that makes a whole feature feel unfinished.
  const noun = kind === "character" ? "character"
    : kind === "place" ? "location" : kind === "faction" ? "group" : "element";
  const tier = castRank === 0 && presence >= 0.6 ? `central ${noun}`
    : castRank <= 2 || presence >= 0.5 ? `major ${noun}`
    : presence >= 0.25 || counts.speechLines >= 10 ? `recurring ${noun}`
    : `minor ${noun}`;
  // Station is a person's trade; a place or a group has none to state.
  if (kind !== "character") return tier;

  // The station the prose stated. This is the specific answer, and it is the
  // only one the manuscript actually licenses.
  if (counts.station) return `the ${counts.station}`;

  // ★ NO STATION MEANS FALL BACK TO THE TIER, and a relational fallback was
  //   tried here and reverted. "Vey's counterpart", "viewpoint, with Osric":
  //   co-presence says two people share chapters, which in a two-hander is
  //   true of everyone and names no role at all. A vague-but-true tier beats
  //   a specific-sounding invention.
  return tier;
}

/**
 * ★ ONE DESCRIPTION, NOT A PILE OF QUOTES — owner feedback from live testing.
 *   The first card offered the manuscript's sentences as separate "Add" rows,
 *   and reading it felt like search results, not a character description. The
 *   conservative tier still may not GENERATE (measured: the 1.7B fabricates
 *   or abstains), so this composes a description from EXTRACTED PHRASES: the
 *   adjective-plus-noun fragments the descriptive test already anchors on,
 *   the habit clause, the lore clause. Every phrase is the manuscript's own
 *   words; only the joining punctuation is ours.
 */
const PHRASE_CAP = 5;

/** Words the adjective SHAPE test admits that are never descriptive
 *  modifiers in a phrase: adverbs of sequence, frequency and degree, and the
 *  frequent action participles that put "kissed, sallow cheek" and "turned
 *  look" into composed descriptions. A closed list is safe here because it
 *  only prunes; the shape test still admits the open class. */
const STOP_MODIFIER = new Set([
  "then", "over", "never", "ever", "again", "once", "twice", "very", "every",
  "kissed", "turned", "fixed", "directed", "seen", "left", "established",
  "brushed", "opened", "closed", "raised", "lowered", "reached", "pressed",
  "own", "other", "certain", "several", "said",
  // ★ "some face" shipped on Scrooge's card: `some` ends in the -some
  //   suffix that was added FOR "handsome", and `such`/`next`/`last`/`first`
  //   are determiners wearing adjective shapes. None of them describes.
  // ★ "best expression" shipped on a draft's card: a superlative before an
  //   appearance noun is almost always a scene beat ("settled on his best
  //   expression"), not a feature.
  "some", "such", "next", "last", "first", "best", "worst",
]);

/**
 * ★★ A PARTICIPLE OF MOTION IS NEVER A STATIVE MODIFIER, and this is the
 *    single biggest source of junk descriptions. Measured on root-crown, the
 *    protagonist's whole description read "Widened eye; small, mended scar;
 *    moved hands; extended hand; clear eye": every one of `widened`,
 *    `moved`, `extended` is an -ed form, passes the adjective SHAPE test, and
 *    describes a GESTURE rather than a person. Appearance is what is stable
 *    about someone; a body part in motion is an action beat.
 */
const MOTION_PARTICIPLE = new Set([
  "widened", "narrowed", "moved", "extended", "raised", "lowered", "opened",
  "closed", "shut", "turned", "lifted", "dropped", "shifted", "tightened",
  "loosened", "clenched", "unclenched", "shook", "nodded", "tilted", "bowed",
  "crossed", "folded", "spread", "stretched", "reached", "waved", "pointed",
  "pressed", "rubbed", "touched", "covered", "wiped", "brushed", "flicked",
  "blinked", "flushed", "paled", "twitched", "curled", "settled", "came",
  "went", "fell", "rose", "held", "caught", "found", "took", "put", "set",
]);

const phraseModifier = (w: string): boolean => {
  const lc = w.toLowerCase();
  if (STOP_MODIFIER.has(lc) || NP_OPENER.has(lc) || MOTION_PARTICIPLE.has(lc)) return false;
  if (/ly$/.test(lc)) return false; // adverbs read as adjectives by shape
  return isAdjectiveShaped(lc);
};

/**
 * Descriptive phrases, and ONLY out of a possessive-bound noun phrase:
 * `POSSESSIVE + modifiers + APPEARANCE NOUN`.
 *
 * ★★ THE BINDING IS THE FIX FOR POLYSEMY. `air`, `look`, `manner`, `walk` and
 *    `figure` all mean a bearing AND something else entirely, so an unbound
 *    match harvested "alley air", "kitchen air" and "cold air" as descriptions
 *    of a person. A possessive binds the noun to somebody; nothing else in
 *    this vocabulary does. The cost is real (a predicative "her hair was
 *    black" no longer yields a phrase) and it is worth it: measured on
 *    root-crown the predicative form contributed one usable phrase and four
 *    fragments, because a complement runs on past where the phrase ends
 *    ("Hand was cold from the").
 */
export function extractDescriptivePhrases(text: string, referentBound = false): string[] {
  const out: string[] = [];
  const push = (phrase: string) => { if (!out.includes(phrase)) out.push(phrase); };

  // ★ WHEN THE CHANNEL HAS ALREADY BOUND THE REFERENT, a determiner is
  //   enough. The possessive requirement exists to stop "alley air" being
  //   read as a person's bearing; inside the possessive and pronoun-owned
  //   channels the engine has ALREADY established whose feature this is, so
  //   insisting on a second possessive threw away real descriptions —
  //   "a small mended scar … pale against her palm" among them.
  const binder = referentBound
    ? `(?:his|her|their|its|my|your|our|an?|the|[A-Z][a-z]+['’]s)`
    : `(?:his|her|their|its|my|your|our|[A-Z][a-z]+['’]s)`;

  /**
   * ★★ SOME NOUNS NEVER TAKE A DETERMINER BINDER, however bound the channel.
   *    Relaxing to determiners inside the resolved channels immediately
   *    brought back "alley air" and "kitchen air" as descriptions of a
   *    person. `air`, `look`, `manner`, `walk` and `figure` denote a bearing
   *    AND an ordinary thing, and only a possessive disambiguates them; a
   *    body part does not have that problem, which is why the relaxation is
   *    worth keeping for the rest.
   */
  const strictNoun = (noun: string) =>
    /^(?:air|look|manner|walk|step|bearing|figure|build|frame|appearance|expression)$/i.test(noun);
  const posBinder = `(?:his|her|their|its|my|your|our|[A-Z][a-z]+['’]s)`;
  const boundOk = (noun: string, matched: string) =>
    !strictNoun(noun) || new RegExp(`^${posBinder}\\b`).test(matched.trim());

  // 1 — ATTRIBUTIVE: binder + modifiers + noun. "her long grey cloak".
  const attributive = new RegExp(
    `${LB}${binder}\\s+((?:[a-z-]+(?:,\\s+|\\s+)){0,3})(${APPEARANCE_NOUN})${RB}`, "g");
  for (let m = attributive.exec(text); m; m = attributive.exec(text)) {
    const preWords = (m[1] ?? "").trim().split(/[\s,]+/).filter(Boolean);
    // A non-modifier RESTARTS the run, so "small, mended" survives intact
    // while "cold from the" contributes nothing.
    const adjectives: string[] = [];
    for (const word of preWords) {
      if (phraseModifier(word)) adjectives.push(word);
      else adjectives.length = 0;
    }
    if (adjectives.length > 0 && boundOk(m[2], m[0])) push(`${adjectives.join(", ")} ${m[2]}`);
  }

  // 2 — PREDICATIVE: binder + noun + copula + adjective. "Kinoko's face was
  //     warm", "her eyes were grey and steady".
  //
  //     ★ ONLY THE ADJECTIVES COME BACK, never the tail. An earlier version
  //       took the whole complement and produced "Hand was cold from the" —
  //       a fragment, because a complement runs on past where the phrase
  //       ends. Emitting "warm face" is fragment-free by construction.
  const predicative = new RegExp(
    `${LB}${binder}\\s+(${APPEARANCE_NOUN})${RB}\\s+(?:was|were|is|are|seemed|looked)\\s+((?:[a-z-]+)(?:(?:,\\s+|\\s+and\\s+)[a-z-]+){0,2})`,
    "g");
  for (let m = predicative.exec(text); m; m = predicative.exec(text)) {
    const adjectives = (m[2] ?? "").split(/[\s,]+|and/).filter(Boolean)
      .filter((w) => phraseModifier(w));
    if (adjectives.length > 0 && boundOk(m[1], m[0])) push(`${adjectives.join(", ")} ${m[1]}`);
  }

  return out;
}

/** Function words a clause must never END on: the phrase continues past the
 *  cut, so what was taken is a fragment. */
const DANGLING_TAIL = new Set([
  "a", "an", "the", "and", "or", "but", "nor", "so", "yet", "of", "to", "in",
  "on", "at", "by", "for", "with", "from", "as", "that", "which", "who",
  "than", "then", "before", "after", "when", "while", "into", "onto", "over",
  "under", "about", "her", "his", "their", "its", "my", "your", "our", "no",
  "not", "very", "more", "most", "such", "this", "these", "those", "is",
  "was", "were", "are", "be", "been", "had", "has", "have", "mr", "mrs",
  "ms", "dr", "st", "if", "because", "though", "although", "since", "up",
]);

/** A finite verb somewhere in the clause: without one it is a noun pile
 *  ("A child and before that"), not a claim about anybody. */
const FINITE_VERB_RE =
  /\b(?:is|was|were|are|am|be|been|being|has|had|have|does|did|do|can|could|will|would|shall|should|may|might|must|[a-z]{3,}(?:ed|es|s))\b/i;

/**
 * ★★ A CLAUSE MUST BE A CLAIM, NOT A CUT. Measured on the owner's manuscript,
 *    the lenient version emitted "A child and before that.", "Eight feet
 *    ahead, watching without asking, and she had caught up" and "Had never
 *    fully answered even to herself." — every one a fragment lifted out of a
 *    longer sentence, and every one of them reads as a bug to a writer. Four
 *    independent tests, all cheap: enough words, a finite verb, no dangling
 *    function word at the cut, and no opener that presupposes what came
 *    before it.
 */
function usableClause(clause: string): boolean {
  const words = clause.split(/\s+/).filter(Boolean);
  if (words.length < 6 || words.length > 30) return false;
  if (!FINITE_VERB_RE.test(clause)) return false;
  const last = words[words.length - 1].toLowerCase().replace(/[^a-z]/g, "");
  if (DANGLING_TAIL.has(last)) return false;
  if (/^(?:and|or|but|nor|so|yet|because|which|that|who|then|before|after|[a-z]+ing)\b/i.test(clause)) return false;
  // A clause that opens on a bare number or measurement is mid-sentence
  // scene-setting ("Eight feet ahead, …"), never a definition.
  if (/^[A-Z]?[a-z]*\s*\d|^(?:one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(clause)) return false;
  return true;
}

/**
 * ★★ IDENTITY FIRST, THEN CONDUCT, THEN APPEARANCE. v1 built the description
 *    out of appearance phrases alone and led with them, which on modern prose
 *    produced a list of gestures and buried what the book actually said the
 *    person WAS. A reader meeting a character wants the same order a novel
 *    gives them: who they are, what they do, then what they look like.
 */
/**
 * ★ THE PRONOUN COMES FROM THE HONORIFIC CLASS THE HARVEST ALREADY
 *   COMPUTED, and falls back to "they" — which is correct for an unknown
 *   referent and never misgenders anyone. It is never guessed from a name.
 */
function subjectPronoun(ev: CharacterDossierEvidence): string {
  return ev.pronounClass === "masc" ? "He" : ev.pronounClass === "fem" ? "She" : "They";
}
/** Lower-case a clause's first letter unless it opens on a proper noun. */
function lowerFirst(text: string): string {
  return /^[A-Z][a-z]+\s/.test(text) && /^(?:The|A|An)\s/.test(text) === false
    ? text
    : text.replace(/^./, (c) => c.toLowerCase());
}

/**
 * The card's sentences, UNFLOORED. Exported so a composition that appends
 * further lines (the counted voice and company sentences under experiment)
 * can apply the too-thin floor to the WHOLE card instead of losing a real
 * two-word line ("Big eyes.") because it stood alone at this stage — the
 * measured failure that motivated the split.
 */
export function composeExtractiveParts(
  ev: CharacterDossierEvidence,
  otherCastNames: readonly string[] = [],
): string[] {
  const nameAlt = ev.forms.map(esc).join("|");
  const others = otherCastNames.filter((n) => !ev.forms.includes(n));
  const otherCastRe = others.length
    ? new RegExp(`${LB}(?:${others.map(esc).join("|")})${RB}`)
    : null;

  /**
   * ★★ THE CHARACTER MUST BE THE SUBJECT OF THE CLAUSE, and nothing weaker
   *    works. Two rounds of this were measured on the owner's manuscript and
   *    both produced grammatical sentences about the wrong person, because
   *    "text after the name" is not "what the name does":
   *
   *      Gareth  ← "The kind of negotiation Lyssa conducted well…"
   *      Mira    ← "…two people in it, the kitchen their primary room"
   *      Tessa   ← "Loom and bolts of wool and the accumulated tools…"
   *
   *    In each the name sits inside a possessive or a prepositional phrase
   *    and the predicate belongs to something else. The test is positional:
   *    the name, then at most an adverb, then a FINITE VERB — and the name
   *    must not itself be governed by a preposition, or "since the generation
   *    before Gareth was…" reads as Gareth being something.
   */
  const PREP_BEFORE = /\b(?:before|after|since|than|with|for|to|from|near|beside|beyond|about|against|toward|towards|of|by|at|in|on|into|onto|unlike|like|behind|between)\s+$/i;
  /**
   * ★★ A DEFINITION MUST BE DURABLE, AND THE BASELINE BENCH CAUGHT THREE WAYS
   *    IT WAS NOT. Measured on the dev books, the identity opener shipped
   *    "The victim of an overwhelming attack of stage fright" (Anne — a
   *    scene, its head noun names an EVENT ROLE), "Not a man to be
   *    frightened by echoes" (Scrooge — a negation is what somebody is NOT),
   *    and "The happy woman by whom he finally seated himself" (Elizabeth —
   *    the relative clause is about Darcy, and the OPPOSITE-gender pronoun
   *    is the tell). Each test is closed and positional; the spans stay in
   *    the pack for the model tiers, which can weigh what extraction may not.
   */
  const IDENTITY_STOP_HEAD =
    /^(?:not\b|no\b)|^(?:an?|the)\s+(?:[a-z-]+\s+){0,2}?(?:victim|object|subject|occasion|cause|target|week|day|month|year|hour|morning|evening|night|moment|while)\b/i;
  const oppositePronounRe = ev.pronounClass === "masc" ? /\b(?:she|her|hers|herself)\b/i
    : ev.pronounClass === "fem" ? /\b(?:he|his|him|himself)\b/i
    : null;
  const clauseFrom = (spans: readonly DossierSpan[], maxLen: number): string | null => {
    const subjectRe = new RegExp(
      `${LB}(?:${nameAlt})${RB}\\s+(?:[a-z]+ly\\s+)?((?:was|is|were|are|had been|has been|became|remains?|always|never|seldom|often|usually|[a-z]{3,}(?:ed|es|s))\\b[^.;]{6,${maxLen}})`,
    );
    for (const span of spans.slice(0, 5)) {
      const m = subjectRe.exec(span.text);
      if (!m) continue;
      // A name governed by a preposition is not the subject of what follows.
      if (PREP_BEFORE.test(span.text.slice(Math.max(0, m.index - 24), m.index))) continue;
      // ★ THE LEADING COPULA STAYS. It used to be stripped so the clause
      //   could stand alone, but the composer now gives every clause a
      //   SUBJECT — and stripping the verb then produced "They in the valley
      //   for sixty-three years". A clause that keeps its verb reads as a
      //   sentence the moment a pronoun is put in front of it.
      let clause = m[1].trim()
        // ★ AN EM-DASH OR COLON INTRODUCES A NEW FOCUS. "Mira was a child —
        //   two people in it, the kitchen their primary room" predicates
        //   Mira for four words and the house for twenty.
        .split(/\s*[—–:]\s*/)[0];
      // ★ A CLAUSE THAT NAMES ANOTHER CAST MEMBER IS ABOUT THEM. This is the
      //   same failure as the subject test one level out: "…which was the
      //   kind of thing people said about Tessa" arrived under Mira.
      if (otherCastRe && otherCastRe.test(clause)) continue;
      // ★ AND SO IS A CLAUSE CARRYING THE OPPOSITE-GENDER PRONOUN. "The
      //   happy woman by whom he finally seated himself" predicates
      //   Elizabeth for three words and Darcy for the rest. Only a KNOWN
      //   class rejects; unknown stays permissive.
      if (oppositePronounRe && oppositePronounRe.test(clause)) continue;
      // A cut at maxLen lands mid-word; fall back to the last whole word.
      if (span.text.indexOf(clause) + clause.length < span.text.length
          && /\w$/.test(clause) && !/[.!?]$/.test(clause)) {
        const nextChar = span.text[span.text.indexOf(clause) + clause.length];
        if (nextChar && /\w/.test(nextChar)) clause = clause.replace(/\s*\S+$/, "");
      }
      // Trim trailing words until the tail is not a dangling function word.
      for (let guard = 0; guard < 6; guard++) {
        if (usableClause(clause)) return clause;
        const words = clause.split(/\s+/);
        if (words.length <= 6) break;
        clause = words.slice(0, -1).join(" ").replace(/[,:;]$/, "");
      }
    }
    return null;
  };

  // ★★ HOW A CHARACTER DESCRIPTION ACTUALLY READS. A story bible does not
  //    write "She is described by her weathered face" — it writes "The
  //    village midwife. Weathered face, grey eyes that miss nothing." Bare
  //    noun phrases are the NATIVE register of a character card, and the
  //    frame that was wrapped around them to stop a semicolon pile reading
  //    as broken was solving the wrong problem: what read as broken was the
  //    JUNK phrases, and those are gone. Fragments of the right kind are not
  //    a failure of prose, they are the form.
  //
  // ★ AND THE DEPTH ADAPTS TO WHAT EXISTS. A character the book never
  //   describes physically should not get a short card — they should get
  //   MORE of whatever the book does give, because a thin card reads as the
  //   feature failing rather than as the manuscript being quiet. Budgets
  //   below are raised when a neighbouring aspect is empty.
  const sentences: string[] = [];
  /**
   * ★ TWO CHANNELS CAN HARVEST THE SAME SENTENCE, and the card then says it
   *   twice — Jane's "a week in town, without either seeing or hearing from
   *   Caroline" shipped as both her identity and her history. Channel-level
   *   dedup cannot catch it (different channels, different pools), so the
   *   composer refuses any sentence whose content stems mostly overlap one
   *   it already placed.
   */
  const placedStems: Set<string>[] = [];
  const pushUnique = (sentence: string): void => {
    const stems = new Set(
      (sentence.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []).map(stemOf),
    );
    for (const prior of placedStems) {
      if (stems.size === 0) break;
      let shared = 0;
      for (const s of stems) if (prior.has(s)) shared++;
      if (shared / stems.size >= 0.6) return;
    }
    placedStems.push(stems);
    sentences.push(sentence);
  };
  const pack = buildDossierPack(ev);
  const hasVisual = pack.visualCandidates.length > 0;

  // 1 — IDENTITY. Direct definition: what the book says this person IS. The
  //     station alone is the cleanest possible opener when the prose named
  //     one; the clause carries it when it did not.
  const identity = clauseFrom(ev.byChannel.identity, 130);
  let identityBody = identity ? lowerFirst(identity.replace(/^(?:was|is|had been)\s+/, "")) : "";
  if (IDENTITY_STOP_HEAD.test(identityBody)) identityBody = "";
  if (ev.counts.station && identityBody) {
    pushUnique(`The ${ev.counts.station}, ${identityBody}.`);
  } else if (ev.counts.station) {
    pushUnique(`The ${ev.counts.station}.`);
  } else if (identityBody) {
    pushUnique(`${identityBody.replace(/^./, (c) => c.toUpperCase())}.`);
  }

  // 2 — CONDUCT. Only a habit the prose STATES. A bare verb tally was tried
  //     here and reverted: "Most often seen to filed, considered, agreed"
  //     is ungrammatical and says nothing, and "worked, died" as a
  //     characterization is worse than silence. The verbs stay a counted
  //     fact in the pack, where the model can weigh them as evidence and
  //     phrase them itself; extraction may not compose.
  const habit = clauseFrom(ev.byChannel.habitual, 100);
  if (habit) pushUnique(`${subjectPronoun(ev)} ${lowerFirst(habit)}.`);

  // ★ WHEN THE BOOK NEVER DESCRIBES THEM, GIVE MORE OF WHAT IT DOES GIVE.
  //   A viewpoint character has no appearance evidence by construction, and
  //   a two-line card for the protagonist reads as the feature failing. Her
  //   interior is what the book offers instead, so it fills the gap rather
  //   than being held back for symmetry.
  if (!hasVisual) {
    const interior = clauseFrom(ev.byChannel.interiority, 110);
    if (interior) pushUnique(`${subjectPronoun(ev)} ${lowerFirst(interior)}.`);
  }

  // 3 — APPEARANCE, in the register a character card actually uses.
  const seen = new Set<string>();
  const phrases: string[] = [];
  const byN = new Map(pack.spans.map((s) => [s.n, s]));
  // More phrases when nothing else carried the card.
  const phraseBudget = sentences.length === 0 ? PHRASE_CAP + 2 : PHRASE_CAP;
  for (const n of pack.visualCandidates) {
    const span = byN.get(n);
    if (!span) continue;
    // These three channels already resolved WHOSE feature this is, so the
    // extractor may accept a determiner-bound phrase inside them.
    const bound = span.channel === "possessive"
      || span.channel === "pronoun-owned" || span.channel === "pronoun-attr";
    for (const phrase of extractDescriptivePhrases(span.text, bound)) {
      const key = phrase.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      phrases.push(phrase);
      if (phrases.length >= phraseBudget) break;
    }
    if (phrases.length >= phraseBudget) break;
  }
  // The phrases are the manuscript's own words, listed as a card lists
  // them. Sentence-cased and stopped, so they read as a line rather than a
  // query result, and joined with commas rather than semicolons.
  if (phrases.length > 0) {
    pushUnique(`${phrases.join(", ").replace(/^./, (c) => c.toUpperCase())}.`);
  }

  // 4 — BACKGROUND. Narrated only; a spoken claim is someone's opinion and
  //     does not belong in a description written as fact.
  const lore = clauseFrom(ev.byChannel["lore-narrated"], 120);
  // The identity head test again: "had been a week in town" is a scene
  // wearing a biography's grammar, and its tell is the same temporal head.
  const loreBody = lore ? lore.replace(/^(?:was|is|had been|has been)\s+/, "") : "";
  if (lore && !IDENTITY_STOP_HEAD.test(loreBody)) {
    pushUnique(`${subjectPronoun(ev)} ${lowerFirst(lore)}.`);
  }

  return sentences;
}

export function composeExtractiveDescription(
  ev: CharacterDossierEvidence,
  otherCastNames: readonly string[] = [],
): string {
  // ★ A SINGLE APPEARANCE FRAGMENT IS NOT A DESCRIPTION. "Outer coat." was
  //   the whole of one character's card; a writer reads that as the feature
  //   failing, not as the manuscript being thin. Below the floor, say
  //   nothing and let the honest empty state do its job.
  const out = composeExtractiveParts(ev, otherCastNames).join(" ");
  // ★ FIVE, not six. The natural register is shorter than the frame it
  //   replaced: "Small mended scar, warm face." is a real card line at five
  //   words and was being discarded by a floor tuned to the wordier version.
  //   "Outer coat." still is not.
  return out.split(/\s+/).filter(Boolean).length >= 5 ? out : "";
}

/** The generated fields as ONE description block, for the single-accept UI.
 *  Order is the card's order; empty fields simply do not appear. */
export function composeProposalDescription(p: DossierProposal): string {
  const parts = [p.appearance.text, p.personality.text, p.background.text]
    .filter(Boolean)
    .map((t) => {
      const s = t.trim().replace(/^./, (c) => c.toUpperCase());
      return /[.!?…]$/.test(s) ? s : `${s}.`;
    });
  return parts.join(" ");
}

export function buildExtractiveCard(
  ev: CharacterDossierEvidence,
  castRank: number,
  kind: DossierKind = "character",
): ExtractiveCard {
  const pack = buildDossierPack(ev);
  const byN = new Map(pack.spans.map((s) => [s.n, s]));
  const quoteOf = (n: number, kind: DossierQuote["kind"]): DossierQuote | null => {
    const s = byN.get(n);
    return s ? { kind, chapter: s.chapter, text: s.text, provenance: PROVENANCE[s.channel] } : null;
  };

  const quotes: DossierQuote[] = [];
  for (const n of pack.visualCandidates.slice(0, 2)) {
    const q = quoteOf(n, "appearance");
    if (q) quotes.push(q);
  }
  for (const n of pack.traitCandidates.slice(0, 2)) {
    const q = quoteOf(n, "personality");
    if (q && !quotes.some((x) => x.text === q.text)) quotes.push(q);
  }
  for (const n of pack.loreCandidates.slice(0, 1)) {
    const q = quoteOf(n, "background");
    if (q && !quotes.some((x) => x.text === q.text)) quotes.push(q);
  }

  return {
    role: deriveRoleFromCounts(ev.counts, castRank, kind),
    factLine: pack.stats,
    quotes,
  };
}
