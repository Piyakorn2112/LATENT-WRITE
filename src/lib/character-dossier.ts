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
import {
  detectSpeechInChapter,
  resolvePronounOwners,
} from "./speech-detect";
import type { Novel, WorldCharacter } from "../types";

export const DOSSIER_TASK = "character-dossier";
export const DOSSIER_PROMPT_VERSION = 1;

// ── channels ──────────────────────────────────────────────────────────────

export type DossierChannel =
  | "appositive"    // Name, a country attorney, …
  | "copular"       // Name was a tall man … / Name was stubborn
  | "attributive"   // poor Anne / old Marley
  | "possessive"    // Name's long thin fingers …
  | "pronoun-attr"  // her grey eyes … in a sentence only Name is in
  | "pronoun-owned" // her dark eyes … referent resolved by the engine
  | "habitual"      // Name always / never / was in the habit of …
  | "relation"      // Name's brother / the daughter of Name
  | "lore-narrated" // narration, past-biography frame
  | "lore-spoken";  // the same, but inside quotation marks

export const DOSSIER_CHANNELS: readonly DossierChannel[] = [
  "appositive", "copular", "attributive", "possessive",
  "pronoun-attr", "pronoun-owned", "habitual",
  "relation", "lore-narrated", "lore-spoken",
];

/** Channels an APPEARANCE line could be written from. */
const VISUAL_CHANNELS: readonly DossierChannel[] = [
  "appositive", "copular", "attributive", "possessive", "pronoun-attr", "pronoun-owned",
];
/** Channels a PERSONALITY line could be written from. */
const TRAIT_CHANNELS: readonly DossierChannel[] = [
  "appositive", "copular", "attributive", "habitual",
];
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
const LORE_PREDICATE =
  "(?:was born|were born|grew up|had been|has been|used to|once was|was once|had once|" +
  "came from|come from|hails? from|was raised|inherited|married|had married|served (?:in|as|under)|" +
  "worked (?:as|for|at)|studied|trained|fought (?:in|at)|left (?:home|the|his|her)|" +
  "arrived from|returned from|lost (?:his|her|their)|died|was killed|escaped|" +
  "was sent|was taken|was known|is known|they say|it is said|rumou?red|legend)";

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
  /** Top co-present cast members, [name, shared chapter count]. */
  coPresent: Array<[string, number]>;
}

export interface CharacterDossierEvidence {
  name: string;
  /** Every surface form: the name plus its aliases. */
  forms: string[];
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
  if (inNarration && new RegExp(`${NAME},\\s+(?:an?|the|his|her|their|its)\\s+[a-z]`).test(narration)) {
    push("appositive", sentence);
  }
  if (inNarration && new RegExp(`${NAME},\\s+who\\s+(?:was|is|had|has)\\b`).test(narration)) {
    push("appositive", sentence);
  }

  // COPULAR, complement first. "Anne was a thin little thing" keeps; "Holmes
  // was pacing up and down" and "was met by the doctor" do not.
  const cop = new RegExp(`${NAME}\\s+(?:was|is|had been|seemed|appeared)\\s+(.{0,40})`).exec(narration);
  if (inNarration && cop) {
    const tail = cop[1].replace(/^(?:very|quite|so|too|not|no|still|already|always|never|rather|somewhat)\s+/, "");
    const head = tail.match(/^(?:an?|the)\s+([a-z-]+)|^([a-z-]+)/i);
    const word = (head?.[1] ?? head?.[2] ?? "").toLowerCase();
    if (word && !VERBAL_COMPLEMENT.test(tail) && (isAdjectiveShaped(word) || /^(?:an?|the)\s/.test(tail))) {
      push("copular", sentence);
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
  const loreActive = new RegExp(`${NAME}(?:['’]s)?\\s+(?:[a-z]+\\s+){0,3}${LORE_PREDICATE}`, "i");
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
    counts: {
      mentions: 0, chapters: [], chapterTotal: novel.chapters.length,
      speechLines: 0, meanLineWords: 0, agentVerbs: [], coPresent: [],
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
        }
      }
    });

    if (chIndex + 1 < novel.chapters.length && (chIndex + 1) % yieldEvery === 0) {
      await yieldToMainThread();
    }
  }

  for (const pc of perChar) {
    pc.ev.counts.agentVerbs = [...pc.verbCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    pc.ev.counts.meanLineWords = pc.lineWords.length
      ? Math.round(pc.lineWords.reduce((a, b) => a + b, 0) / pc.lineWords.length)
      : 0;
    pc.ev.counts.coPresent = perChar
      .filter((o) => o !== pc)
      .map((o) => [o.ev.name, o.ev.counts.chapters.filter((c) => pc.ev.counts.chapters.includes(c)).length] as [string, number])
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
  }

  options.onProgress?.({ fraction: 1, chapter: chapterTotal, chapterTotal });
  return { characters, byName, signature: dossierSignature(novel, cast) };
}

// ── pack assembly ─────────────────────────────────────────────────────────

/** Information density per channel, best first, used only to order the
 *  round-robin; never to starve a channel (see selectDossierSpans). */
const CHANNEL_RANK: Record<DossierChannel, number> = {
  appositive: 0, possessive: 1, "pronoun-owned": 2, "pronoun-attr": 3,
  copular: 4, attributive: 5, habitual: 2,
  relation: 0, "lore-narrated": 1, "lore-spoken": 2,
};

export const DOSSIER_SPAN_CAP = 14;
const SPAN_CHARS = 300;
const PER_CHANNEL_QUOTA = 3;

/** What the reader must know about how a span was found, in one word. `said`
 *  marks speech about the character (can be wrong in-world); `pronoun` marks a
 *  machine-resolved referent (can be wrong mechanically). */
const PROVENANCE: Record<DossierChannel, string> = {
  appositive: "named", copular: "named", attributive: "named", possessive: "named",
  "pronoun-attr": "pronoun", "pronoun-owned": "pronoun", habitual: "named",
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
export function selectDossierSpans(ev: CharacterDossierEvidence): DossierSpan[] {
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
      if (kept.length >= PER_CHANNEL_QUOTA) break;
    }
    queues.set(channel, kept);
  }

  const order = [...DOSSIER_CHANNELS].sort((a, b) => CHANNEL_RANK[a] - CHANNEL_RANK[b]);
  const out: DossierSpan[] = [];
  for (let round = 0; round < PER_CHANNEL_QUOTA && out.length < DOSSIER_SPAN_CAP; round++) {
    for (const channel of order) {
      const span = queues.get(channel)?.[round];
      if (span && out.length < DOSSIER_SPAN_CAP) out.push(span);
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

export function buildDossierPack(ev: CharacterDossierEvidence): DossierPack {
  const chosen = selectDossierSpans(ev).map((s, i) => ({
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

const FIELD_ASK: Record<DossierFieldKey, { definition: string; question: string }> = {
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
personality: at most 25 words, from ONLY those passages. The counted facts may
  inform the emphasis, but every claim must trace to a passage. "" if spans
  is [].`,
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

function fieldSystem(field: DossierFieldKey): string {
  return `You fill in ONE field of a character card for a novel, from evidence a search
has already gathered. You cannot read the manuscript. The numbered passages
${field === "personality" ? "and counted facts " : ""}are all the evidence there is.

Answer as JSON: {"spans","${field}","confidence"} in that order.
${FIELD_ASK[field].definition}
confidence: 0 to 1, how much the passages actually settle this. Never above 1.

A passage tagged (pronoun) had its subject resolved by a machine and may
belong to someone else; trust it less. Passage numbers are not consecutive;
cite them exactly as printed.
An empty answer is a correct answer. Writing something true of most people is
NOT an answer. Never use anything you know about this book from elsewhere.`;
}

export interface DossierFieldRequest {
  field: DossierFieldKey;
  systemPrompt: string;
  userText: string;
  schema: ReturnType<typeof fieldSchema>;
  maxTokens: number;
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
): DossierFieldRequest | null {
  const candidates = fieldCandidates(pack, field);
  if (candidates.length === 0) return null;
  const subset = pack.spans.filter((s) => candidates.includes(s.n));
  const lines = [
    `CHARACTER: ${pack.name}`,
    ...(pack.aliases.length ? [`ALSO WRITTEN: ${pack.aliases.join(", ")}`] : []),
    ...(field === "personality" ? ["", "COUNTED FACTS (measured, not opinion)", pack.stats] : []),
    "",
    "PASSAGES — verbatim, numbered. These are the only evidence there is.",
    ...subset.map((s) => `[${s.n}] ch${s.chapter} (${PROVENANCE[s.channel]}): ${s.text}`),
  ];
  return {
    field,
    systemPrompt: fieldSystem(field),
    userText: `${lines.join("\n")}\n\n${FIELD_ASK[field].question.replace("{name}", pack.name)}`,
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
const usefulProse = (line: string) => (line.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length >= 4;

/**
 * Route one field's raw JSON through its gate, grounding and repair. Never
 * throws; a hopeless payload degrades to an empty field. The model's own
 * confidence rides along for display, clamped.
 */
export function normalizeFieldAnswer(
  raw: unknown,
  pack: DossierPack,
  field: DossierFieldKey,
): DossierField & { confidence: number } {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const grounded = groundField(
    value[field], value.spans, pack, fieldCandidates(pack, field),
    field === "appearance" ? usefulAppearance : usefulProse,
    FIELD_MAX[field]);
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
): DossierFieldRequest | null {
  const base = buildFieldRequest(pack, field);
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
export function deriveRoleFromCounts(counts: DossierCounts, castRank: number): string {
  const presence = counts.chapterTotal > 0 ? counts.chapters.length / counts.chapterTotal : 0;
  if (castRank === 0 && presence >= 0.6) return "central character";
  if (castRank <= 2 || presence >= 0.5) return "major character";
  if (presence >= 0.25 || counts.speechLines >= 10) return "recurring character";
  return "minor character";
}

export function buildExtractiveCard(
  ev: CharacterDossierEvidence,
  castRank: number,
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
    role: deriveRoleFromCounts(ev.counts, castRank),
    factLine: pack.stats,
    quotes,
  };
}
