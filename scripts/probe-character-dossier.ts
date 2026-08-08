/**
 * probe-character-dossier.ts — IS THERE ANYTHING TO GATHER?
 *
 * Before designing an auto role/description generator for the world panel, count
 * the funnel. The question is not "can a model write a character description" —
 * it obviously can, from nothing, which is the failure mode. The question is
 * whether the MANUSCRIPT contains retrievable, verbatim evidence for each of the
 * three things the panel would claim:
 *
 *   ROLE        what this person is to the story  (structural, not prose)
 *   APPEARANCE  what they look like               (must be derived from prose)
 *   LORE        what is known about them          (often only ever SPOKEN)
 *
 * Every channel below returns SENTENCE SPANS, never a judgement. A character
 * with zero spans in a channel is a character the panel must leave blank there,
 * and that is the number this probe exists to produce.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/probe-character-dossier.ts
 *   node node_modules/tsx/dist/cli.mjs scripts/probe-character-dossier.ts --show pride
 */
import { splitSentences, stripQuotes } from "../src/lib/prose-segments";
import { detectSpeechInChapter, resolvePronounOwners } from "../src/lib/speech-detect";
import { resolveSpeakerCandidates, buildSpeakerAliasMap } from "../src/lib/world-data";
import { loadBook, splitParagraphs } from "./print-chapter";

const DEV_BOOKS = ["pride", "sherlock", "anne", "dracula", "carol", "webnovel"];
/** ★ THE OPERATING POINT IS A DRAFT, NOT A FINISHED NOVEL. These two are
 *  original manuscripts at the length a writer actually opens this panel at,
 *  and the corpus classics are the ceiling, not the case. */
const DRAFT_BOOKS = ["hollow-iris", "root-crown", "webnovel"];
const CAST_LIMIT = 10;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Underscore is a word character and Gutenberg prose wraps names in it. */
const LB = "(?<![A-Za-z0-9])";
const RB = "(?![A-Za-z0-9])";

// ── the vocabularies ──────────────────────────────────────────────────────
//
// These are OPEN classes and therefore cannot be complete. They are used here
// only to COUNT how much evidence exists, never to decide anything — a probe
// may use a word list where a shipping engine may not.

const APPEARANCE_NOUN =
  "(?:eyes?|hair|face|features|complexion|skin|beard|moustache|mustache|whiskers|brow|brows|" +
  "forehead|chin|jaw|nose|mouth|lips?|teeth|cheeks?|ears?|neck|throat|shoulders?|arms?|hands?|" +
  "fingers?|legs?|feet|figure|frame|build|stature|height|voice|smile|expression|gaze|glance|" +
  "dress|gown|coat|cloak|hat|bonnet|boots?|shoes|gloves|uniform|robes?|clothes|clothing|" +
  "appearance|look|air|bearing|manner|posture|step|walk|scar|scars)";

const RELATION_NOUN =
  "(?:father|mother|parents?|brother|sister|siblings?|son|daughter|child|children|wife|husband|" +
  "widow|widower|uncle|aunt|nephew|niece|cousins?|grandfather|grandmother|grandson|granddaughter|" +
  "friend|companion|servant|maid|butler|master|mistress|employer|clerk|partner|rival|enemy|" +
  "neighbour|neighbor|guardian|ward|apprentice|teacher|pupil|student|captain|colleague|patron)";

/** Past-biography predicates. Deliberately requires a PAST frame, because the
 *  channel is "what is known about them", not "what they are doing". */
const LORE_PREDICATE =
  "(?:was born|were born|grew up|had been|has been|used to|once was|was once|had once|" +
  "came from|come from|hails? from|was raised|inherited|married|had married|served (?:in|as|under)|" +
  "worked (?:as|for|at)|studied|trained|fought (?:in|at)|left (?:home|the|his|her)|" +
  "arrived from|returned from|lost (?:his|her|their)|died|was killed|escaped|" +
  "was sent|was taken|was known|is known|they say|it is said|rumou?red|legend)";

interface Span {
  channel: Channel;
  chapter: number;
  text: string;
}

type Channel =
  | "appositive"    // Name, a country attorney, …
  | "copular"       // Name was a tall man …
  | "attributive"   // poor Anne / old Marley
  | "possessive"    // Name's eyes …
  | "pronoun-attr"  // her eyes … in a sentence only Name is in
  | "pronoun-owned" // her dark eyes … referent resolved by the engine
  | "relation"      // Name's brother / the daughter of Name
  | "lore-narrated" // narration, past-biography frame
  | "lore-spoken";  // the same, but inside quotation marks

const CHANNELS: Channel[] = [
  "appositive", "copular", "attributive", "possessive",
  "pronoun-attr", "pronoun-owned", "relation", "lore-narrated", "lore-spoken",
];

/** Visual channels — the ones an appearance line could be written from. */
const VISUAL: Channel[] = ["appositive", "copular", "attributive", "possessive", "pronoun-attr", "pronoun-owned"];
const LORE: Channel[] = ["lore-narrated", "lore-spoken", "relation"];

interface CharacterEvidence {
  name: string;
  forms: string[];
  mentions: number;
  speeches: number;
  /** Chapter numbers this character is named in, in reading order. */
  chapters: number[];
  byChannel: Record<Channel, Span[]>;
}

function emptyByChannel(): Record<Channel, Span[]> {
  return {
    appositive: [], copular: [], attributive: [], possessive: [],
    "pronoun-attr": [], "pronoun-owned": [],
    relation: [], "lore-narrated": [], "lore-spoken": [],
  };
}

/**
 * ★★ THE DESCRIPTIVE TEST, AND WHY EVERY CHANNEL NEEDS ONE.
 *
 *    The loose first pass of this probe harvested 819 "attributive" and 486
 *    "lore" spans and most of them said nothing about anybody. "The lamps had
 *    been lit, but the blinds had not been drawn" landed in Holmes's LORE
 *    because `had been` is in the predicate list and his name is in the
 *    sentence. "Holmes slowly reopened his eyes" landed in APPEARANCE because
 *    `eyes` is an appearance noun — but it is an ACTION with a body part in it,
 *    not a description of what he looks like.
 *
 *    Containment is not evidence. Every channel below now requires the
 *    descriptive material to be SYNTACTICALLY ATTACHED to the name: an
 *    adjective adjacent to the appearance noun, a copula whose complement is
 *    not a progressive verb, a lore predicate whose subject is this character.
 */

/** A word shaped like a descriptive adjective. Suffix test first — it covers
 *  the open class — then the short closed set of common bare adjectives that
 *  carry no suffix at all. */
const ADJ_SUFFIX = /(?:ish|ous|ful|less|able|ible|ive|ic|al|ary|ent|ant|y|ly|en|ed|er|est)$/;
const BARE_ADJ = new Set([
  "tall", "short", "big", "small", "little", "large", "old", "young", "fat", "thin", "slim",
  "lean", "stout", "pale", "dark", "fair", "red", "grey", "gray", "black", "white", "blue",
  "green", "brown", "blond", "blonde", "good", "bad", "poor", "rich", "kind", "cruel", "grim",
  "calm", "wild", "keen", "sharp", "soft", "hard", "cold", "warm", "clean", "neat", "plain",
  "smart", "slight", "broad", "narrow", "round", "square", "long", "deep", "high", "low",
  "clear", "bright", "dim", "quiet", "loud", "quick", "slow", "firm", "frail", "sweet",
]);
/** Progressive/passive complements — a verb, not a description. */
const VERBAL_COMPLEMENT = /^(?:[a-z]+ing|[a-z]+ed\s+(?:by|with|to|from|at|in|into|out|up|down|away|about))\b/;

const isAdjective = (w: string) => BARE_ADJ.has(w) || (w.length >= 4 && ADJ_SUFFIX.test(w));

/**
 * Does an adjective sit next to this appearance noun? "his tall, gaunt figure"
 * yes; "reopened his eyes and looked" no.
 *
 * ★★ EVERY OCCURRENCE, NOT THE FIRST. The first version tested only the first
 *    match and it cost the single best span in the corpus: "no sooner had he
 *    made it clear … that she had hardly a good feature in her face, than he
 *    began to find it was rendered uncommonly intelligent by the beautiful
 *    expression of HER DARK EYES". The first appearance noun in that sentence
 *    is `face`, preceded by "in her" and therefore bare, so the whole sentence
 *    was judged undescriptive — and it is the only place Austen ever describes
 *    Elizabeth Bennet's looks. A sentence qualifies if ANY of its appearance
 *    nouns carries a modifier.
 */
function adjacentAdjective(text: string, nounRe: RegExp): boolean {
  const all = new RegExp(nounRe.source, "gi");
  for (let m = all.exec(text); m; m = all.exec(text)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
    // Modifiers stacked before the noun: "long grey travelling-cloak".
    const pre = before.match(/([a-z-]+)[,\s]+([a-z-]+)?[,\s]*$/i);
    if (pre && [pre[1], pre[2]].some((w) => w && isAdjective(w.toLowerCase()))) return true;
    // Predicated after it: "his eyes were grey and steady", "her hair, black and heavy".
    const post = after.match(/^(?:\s*(?:was|were|is|are|seemed|looked|had)\s+|\s*,\s*)([a-z-]+)/i);
    if (post && isAdjective(post[1].toLowerCase())) return true;
  }
  return false;
}

/**
 * Harvest evidence spans for one character out of one sentence.
 *
 * ★ NARRATION AND DIALOGUE ARE SEPARATE SURFACES and the split is positional,
 *   not lexical — the same test character-presence.ts uses. A biography stated
 *   inside quotation marks is LORE SOMEONE SAID, which is a different kind of
 *   claim from the narrator stating it, and the panel would have to mark it as
 *   such. So the two are never pooled.
 */
function harvest(
  ev: CharacterEvidence,
  sentence: string,
  narration: string,
  chapter: number,
  otherFormsRe: RegExp | null,
) {
  const nameAlt = ev.forms.map(esc).join("|");
  const NAME = `${LB}(?:${nameAlt})${RB}`;
  const push = (channel: Channel, text: string) => {
    if (ev.byChannel[channel].length >= 40) return;
    ev.byChannel[channel].push({ channel, chapter, text: text.replace(/\s+/g, " ").trim() });
  };

  const inNarration = new RegExp(NAME).test(narration);

  // 1 — APPOSITIVE. "Mr. Bennet, a gentleman of small fortune, …"
  //     Requires a determiner or possessive after the comma so that "Elizabeth,
  //     and her sister" does not qualify.
  if (inNarration && new RegExp(`${NAME},\\s+(?:an?|the|his|her|their|its)\\s+[a-z]`).test(narration)) {
    push("appositive", sentence);
  }
  // "…, who was a …" / "…, who had …"
  if (inNarration && new RegExp(`${NAME},\\s+who\\s+(?:was|is|had|has)\\b`).test(narration)) {
    push("appositive", sentence);
  }

  // 2 — COPULAR, complement first. "Anne was a thin little thing" keeps;
  //     "Holmes was pacing up and down" and "was met by the doctor" do not.
  const cop = new RegExp(`${NAME}\\s+(?:was|is|had been|seemed|appeared)\\s+(.{0,40})`).exec(narration);
  if (inNarration && cop) {
    const tail = cop[1].replace(/^(?:very|quite|so|too|not|no|still|already|always|never|rather|somewhat)\s+/, "");
    const head = tail.match(/^(?:an?|the)\s+([a-z-]+)|^([a-z-]+)/i);
    const word = (head?.[1] ?? head?.[2] ?? "").toLowerCase();
    if (word && !VERBAL_COMPLEMENT.test(tail) && (isAdjective(word) || /^(?:an?|the)\s/.test(tail))) {
      push("copular", sentence);
    }
  }

  // 3 — ATTRIBUTIVE. "poor Anne", "old Marley", "little Dorrit".
  //
  //     ★ THE DIALOGUE TAG IS THE FALSE POSITIVE, and it is positional. In
  //       `“…,” murmured Holmes,` the word before the name is a speech verb,
  //       and no adjective test rejects it reliably ("murmured" ends in -ed).
  //       What DOES separate them is the closing quote a few characters back
  //       with no sentence terminator in between: that is a tag, never a
  //       modifier.
  const attr = new RegExp(`(?:^|[\\s(])([a-z-]+)\\s+${NAME}`).exec(narration);
  if (inNarration && attr && isAdjective(attr[1].toLowerCase())) {
    const before = sentence.slice(0, Math.max(0, sentence.indexOf(attr[0])));
    const isTag = /[”"’'][^.!?]{0,12}$/.test(before);
    if (!isTag) push("attributive", sentence);
  }

  // 4 — POSSESSIVE ATTRIBUTE. "Holmes's long thin fingers …"
  const possRe = new RegExp(`${NAME}['’]s\\s+(?:[a-z-]+[,\\s]+){0,3}${APPEARANCE_NOUN}${RB}`, "i");
  if (inNarration && possRe.test(narration) && adjacentAdjective(narration, new RegExp(APPEARANCE_NOUN + RB, "i"))) {
    push("possessive", sentence);
  }

  // 5 — PRONOUN ATTRIBUTE, and ONLY when no other cast member is in the
  //     sentence. "Her eyes were grey" is visual evidence for exactly one
  //     person, and the moment two are named the referent is a guess.
  if (inNarration) {
    const others = otherFormsRe ? otherFormsRe.test(narration) : false;
    const pronounNoun = new RegExp(`${LB}(?:his|her|their)\\s+(?:[a-z-]+[,\\s]+){0,3}${APPEARANCE_NOUN}${RB}`, "i");
    if (!others && pronounNoun.test(narration) && adjacentAdjective(narration, new RegExp(APPEARANCE_NOUN + RB, "i"))) {
      push("pronoun-attr", sentence);
    }
  }

  // 6 — RELATION. "Elizabeth's father", "the daughter of Mr. Bennet".
  if (new RegExp(`${NAME}['’]s\\s+(?:[a-z]+\\s+){0,2}${RELATION_NOUN}${RB}`, "i").test(sentence)
      || new RegExp(`${LB}${RELATION_NOUN}\\s+(?:of|to)\\s+${NAME}`, "i").test(sentence)) {
    push("relation", sentence);
  }

  // 7 — LORE, and THE CHARACTER MUST BE ITS SUBJECT. The loose version matched
  //     any lore predicate anywhere in a sentence that happened to name them,
  //     which is how the drawing-room blinds became Holmes's biography. At most
  //     three words may sit between the name and the predicate — enough for an
  //     adverb or a relative pronoun, not enough for a second clause.
  const loreRe = new RegExp(`${NAME}(?:['’]s)?\\s+(?:[a-z]+\\s+){0,3}${LORE_PREDICATE}`, "i");
  const passiveLoreRe = new RegExp(`${LORE_PREDICATE}\\s+(?:[a-z]+\\s+){0,3}${NAME}`, "i");
  if (loreRe.test(sentence) || passiveLoreRe.test(sentence)) {
    push(inNarration && loreRe.test(narration) ? "lore-narrated" : "lore-spoken", sentence);
  }
}

async function run(book: string, show: boolean, chapterLimit = Infinity) {
  const loaded = await loadBook(book);
  const novel = chapterLimit === Infinity
    ? loaded
    : { ...loaded, chapters: loaded.chapters.slice(0, chapterLimit) };
  const text = novel.chapters.map((c) => c.content).join("\n");
  const names = resolveSpeakerCandidates(novel).slice(0, CAST_LIMIT * 2);
  const aliasMap = buildSpeakerAliasMap(names, text);

  // Fold nicknames into their canonical owner so evidence is not split three
  // ways across Elizabeth / Lizzy / Eliza.
  const byCanonical = new Map<string, Set<string>>();
  for (const n of names) {
    const canonical = aliasMap.get(n.toLowerCase().trim()) ?? n;
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, new Set());
    byCanonical.get(canonical)!.add(n);
  }

  const cast: CharacterEvidence[] = [...byCanonical.entries()].map(([name, forms]) => ({
    name,
    forms: [...forms],
    mentions: 0,
    speeches: 0,
    chapters: [],
    byChannel: emptyByChannel(),
  }));

  // Rank by raw mentions, then keep the top CAST_LIMIT — the panel's own order.
  for (const ev of cast) {
    const re = new RegExp(`${LB}(?:${ev.forms.map(esc).join("|")})${RB}`, "g");
    ev.mentions = (text.match(re) ?? []).length;
  }
  cast.sort((a, b) => b.mentions - a.mentions);
  const top = cast.slice(0, CAST_LIMIT);

  // One "other cast" pattern per character, for the pronoun-attribute guard.
  const otherRe = new Map<string, RegExp>();
  for (const ev of top) {
    const others = top.filter((o) => o !== ev).flatMap((o) => o.forms);
    otherRe.set(ev.name, others.length
      ? new RegExp(`${LB}(?:${others.map(esc).join("|")})${RB}`)
      : /$^/);
  }

  const byName = new Map(top.map((ev) => [ev.name, ev]));
  const speechNames = names.slice(0, CAST_LIMIT * 2);

  for (const chapter of novel.chapters) {
    for (const ev of top) {
      const re = new RegExp(`${LB}(?:${ev.forms.map(esc).join("|")})${RB}`);
      if (re.test(chapter.content)) ev.chapters.push(chapter.number);
    }
    const paragraphs = splitParagraphs(chapter.content);

    // ★★ THE DESCRIPTION IS ALMOST NEVER IN THE SENTENCE WITH THE NAME.
    //
    //    Measured, and it is the finding that reshaped this probe. Every real
    //    description of Elizabeth Bennet in Pride and Prejudice arrives without
    //    her name anywhere in the sentence — "the beautiful expression of her
    //    dark eyes", "the brilliancy which exercise had given to her
    //    complexion", "Her face is too thin". Prose establishes a topic and
    //    then describes it by PRONOUN, which is exactly what a name-anchored
    //    harvester cannot see. Requiring the name is not a strict rule, it is
    //    the wrong rule, and it costs the protagonist of the book.
    //
    //    resolvePronounOwners already ships — it is the engine's own internal
    //    pronoun resolution surfaced for the highlight layer, gender-mapped and
    //    alias-canonicalised, and it refuses to resolve pronouns inside
    //    quotation marks. Its confidence encodes the source: 0.9 tag-adjacent,
    //    0.7 gender-known antecedent, 0.5 a bare fallback. Only the first two
    //    are trusted here; the 0.5 rung is a guess and a wrongly-owned
    //    description is worse than a missing one.
    const speech = detectSpeechInChapter(paragraphs, speechNames, { intelligenceLevel: "high" });
    const owners = resolvePronounOwners(paragraphs, speech, speechNames, aliasMap);

    paragraphs.forEach((paragraph, pIndex) => {
      for (const owner of owners[pIndex] ?? []) {
        if (owner.confidence < 0.7) continue;
        if (!/^(?:his|her|hers)$/i.test(owner.pronoun)) continue;   // possessive only
        const ev = byName.get(aliasMap.get(owner.owner.toLowerCase().trim()) ?? owner.owner)
          ?? byName.get(owner.owner);
        if (!ev) continue;
        const after = paragraph.slice(owner.end, owner.end + 60);
        const noun = new RegExp(`^\\s*(?:[a-z-]+[,\\s]+){0,3}${APPEARANCE_NOUN}${RB}`, "i").exec(after);
        if (!noun) continue;
        // The noun alone is not a description — "reopened his eyes" is an
        // action. An adjective has to be attached to it.
        const window = `${paragraph.slice(Math.max(0, owner.start - 60), owner.start)}${owner.pronoun}${after}`;
        if (!adjacentAdjective(window, new RegExp(APPEARANCE_NOUN + RB, "i"))) continue;
        const host = splitSentences(paragraph).find((s) => owner.start >= s.start && owner.start < s.end);
        if (!host) continue;
        if (ev.byChannel["pronoun-owned"].length >= 40) continue;
        ev.byChannel["pronoun-owned"].push({
          channel: "pronoun-owned",
          chapter: chapter.number,
          text: host.text.replace(/\s+/g, " ").trim(),
        });
      }

      for (const sentence of splitSentences(paragraph)) {
        const s = sentence.text;
        if (s.length < 12) continue;
        const narration = stripQuotes(s);
        for (const ev of top) {
          const nameAlt = ev.forms.map(esc).join("|");
          if (!new RegExp(`${LB}(?:${nameAlt})${RB}`).test(s)) continue;
          harvest(ev, s, narration, chapter.number, otherRe.get(ev.name) ?? null);
        }
      }
    });
  }

  if (show) {
    console.log(`\n══ ${book} — evidence spans, top ${CAST_LIMIT} cast ══`);
    for (const ev of top) {
      const visual = VISUAL.reduce((n, c) => n + ev.byChannel[c].length, 0);
      const lore = LORE.reduce((n, c) => n + ev.byChannel[c].length, 0);
      console.log(`\n── ${ev.name}  (${ev.mentions} mentions · ${visual} visual · ${lore} lore)`);
      for (const channel of CHANNELS) {
        const spans = ev.byChannel[channel];
        if (spans.length === 0) continue;
        console.log(`   ${channel} ×${spans.length}`);
        for (const span of spans.slice(0, 2)) {
          console.log(`     ch${span.chapter}: ${span.text.slice(0, 150)}`);
        }
      }
    }
    return null;
  }

  return {
    book,
    top,
    chapters: novel.chapters.length,
    words: text.split(/\s+/).filter(Boolean).length,
  };
}

const pad = (v: string | number, n: number) => String(v).padStart(n);
const padR = (v: string | number, n: number) => String(v).padEnd(n);

// ── pack assembly ─────────────────────────────────────────────────────────
//
// ★ THE HARNESS FINDS, THE MODEL READS. Same split as evidence-pack.ts and
//   max-ask.ts: the model never searches the manuscript and never chooses what
//   to look at. It gets numbered verbatim spans and a block of counted facts,
//   and every claim it makes has to point at a number.

/** Information density per channel, best first. An appositive is a whole
 *  identity in one clause; an attributive is one adjective. */
const CHANNEL_RANK: Record<Channel, number> = {
  appositive: 0, possessive: 1, "pronoun-owned": 2, "pronoun-attr": 3, copular: 4, attributive: 5,
  relation: 0, "lore-narrated": 1, "lore-spoken": 2,
};

const SPAN_CAP = 14;
const SPAN_CHARS = 300;

/** What the reader has to know about how a span was found, in one word. */
const PROVENANCE: Record<Channel, string> = {
  appositive: "named",
  copular: "named",
  attributive: "named",
  possessive: "named",
  "pronoun-attr": "pronoun",
  "pronoun-owned": "pronoun",
  relation: "named",
  "lore-narrated": "named",
  "lore-spoken": "said",
};

/**
 * ★★ ROUND-ROBIN ACROSS CHANNELS, NEVER BEST-CHANNEL-FIRST.
 *
 *    The first version sorted the pool by channel quality and took the top 14.
 *    On Elizabeth Bennet that filled the whole budget with `appositive` and
 *    `copular` — "Elizabeth, who had a letter to write", "Elizabeth was
 *    determined" — and starved out the ONE channel that had found Austen's
 *    actual description of her ("the beautiful expression of her dark eyes",
 *    harvested by `pronoun-owned`). A ranking over channels is a bet that
 *    syntactic SHAPE predicts descriptive CONTENT, and it does not.
 *
 *    So every channel gets a small guaranteed quota and the model does the
 *    choosing. That is the same division of labour as evidence-pack.ts: the
 *    harness guarantees coverage, the reader decides relevance.
 */
const PER_CHANNEL_CAP = 3;

function selectSpans(ev: CharacterEvidence): Span[] {
  // Near-duplicate suppression: two harvests of the same sentence through two
  // channels are one piece of evidence charged twice.
  const seen = new Set<string>();
  const queues = new Map<Channel, Span[]>();
  for (const channel of CHANNELS) {
    const kept: Span[] = [];
    // EARLIEST first inside a channel — a character's first full description is
    // almost always the fullest one the book ever gives.
    for (const span of [...ev.byChannel[channel]].sort((a, b) => a.chapter - b.chapter)) {
      const key = span.text.slice(0, 60).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(span);
      if (kept.length >= PER_CHANNEL_CAP) break;
    }
    queues.set(channel, kept);
  }

  const order = [...CHANNELS].sort((a, b) => CHANNEL_RANK[a] - CHANNEL_RANK[b]);
  const out: Span[] = [];
  for (let round = 0; round < PER_CHANNEL_CAP && out.length < SPAN_CAP; round++) {
    for (const channel of order) {
      const span = queues.get(channel)?.[round];
      if (span && out.length < SPAN_CAP) out.push(span);
    }
  }
  return out.sort((a, b) => a.chapter - b.chapter);
}

export interface DossierPack {
  book: string;
  name: string;
  aliases: string[];
  stats: string;
  spans: Array<{ n: number; channel: Channel; chapter: number; text: string }>;
  /**
   * ★★ THE GATE, AND IT RUNS BEFORE THE MODEL DOES.
   *
   *    Measured: handed a pack with NO appearance evidence in it, both shipping
   *    tiers wrote a full physical description anyway and cited a passage
   *    number that does not exist. The 1.7B gave Elder Kang a beard, a robe and
   *    a staff at confidence 0.8; the 4B gave him a long beard and a white robe
   *    at 0.8. Neither is a prompt failure that a better instruction fixes —
   *    "an empty answer is a correct answer" was already in the system prompt,
   *    in those words.
   *
   *    So the empty pack must never reach the model. These are the span numbers
   *    that actually contain a describable feature: an appearance noun with an
   *    adjective attached to it. Empty means the appearance field stays empty
   *    and no call is made. Same rule as the adjudicator's guards, and the same
   *    reason: a question a model cannot answer honestly is a question the
   *    harness should not ask.
   */
  visualCandidates: number[];
  text: string;
}

function buildPack(
  book: string,
  ev: CharacterEvidence,
  chapterCount: number,
  chaptersPresent: number,
  firstChapter: number,
  coPresent: Array<[string, number]>,
): DossierPack {
  const chosen = selectSpans(ev).map((s, i) => ({
    n: i + 1,
    channel: s.channel,
    chapter: s.chapter,
    text: s.text.length > SPAN_CHARS ? `${s.text.slice(0, SPAN_CHARS)}…` : s.text,
  }));

  const stats = [
    `named ${ev.mentions} times across ${chaptersPresent} of ${chapterCount} chapters`,
    `first named in chapter ${firstChapter}`,
    coPresent.length
      ? `most often on the page with ${coPresent.map(([n, c]) => `${n} (${c} ch)`).join(", ")}`
      : "never shares a chapter with another named character",
  ].join(" · ");

  const lines = [
    `CHARACTER: ${ev.name}`,
    ...(ev.forms.length > 1 ? [`ALSO WRITTEN: ${ev.forms.filter((f) => f !== ev.name).join(", ")}`] : []),
    "",
    "COUNTED FACTS (measured, not opinion)",
    stats,
    "",
    "PASSAGES — verbatim, numbered. These are the only evidence there is.",
    // ★ THE TAG IS PROVENANCE, NOT A HINT. `said` marks a passage that is
    //   someone's SPEECH about this character, which can be wrong in-world;
    //   `pronoun` marks one where the referent was resolved rather than named,
    //   which can be wrong mechanically. Both are things the reader has to be
    //   able to discount, so both are stated.
    ...chosen.map((s) => `[${s.n}] ch${s.chapter} (${PROVENANCE[s.channel]}): ${s.text}`),
  ];

  const nounRe = new RegExp(APPEARANCE_NOUN + RB, "i");
  const visualCandidates = chosen
    .filter((s) => VISUAL.includes(s.channel) && nounRe.test(s.text) && adjacentAdjective(s.text, nounRe))
    .map((s) => s.n);

  return {
    book,
    name: ev.name,
    aliases: ev.forms.filter((f) => f !== ev.name),
    stats,
    spans: chosen,
    visualCandidates,
    text: lines.join("\n"),
  };
}

/**
 * ★★ COVERAGE AT THE LENGTH THE PANEL IS ACTUALLY OPENED AT.
 *
 *    Pride and Prejudice is 670KB and 57 chapters. A writer who opens the world
 *    panel has written four. Reporting coverage on the finished classic answers
 *    a question nobody asked; this walks the same book forward chapter by
 *    chapter and reports when each channel first has anything to say.
 */
async function growth() {
  const STEPS = [2, 4, 8, 16, 32, Infinity];
  console.log("\nEVIDENCE vs DRAFT LENGTH — coverage of the top-10 cast as chapters accrue\n");
  console.log(`${padR("book", 13)} ${padR("chapters", 9)} ${pad("words", 7)} ${pad("cast", 5)} ${pad("vis≥1", 6)} ${pad("vis≥3", 6)} ${pad("lore≥1", 7)}`);
  console.log("-".repeat(62));
  for (const book of [...DRAFT_BOOKS, "anne", "pride"]) {
    for (const step of STEPS) {
      const result = await run(book, false, step);
      if (!result) continue;
      if (step !== Infinity && result.chapters < step) break;
      let anyVisual = 0, visual3 = 0, anyLore = 0;
      for (const ev of result.top) {
        const visual = VISUAL.reduce((n, c) => n + ev.byChannel[c].length, 0);
        const lore = LORE.reduce((n, c) => n + ev.byChannel[c].length, 0);
        if (visual >= 1) anyVisual++;
        if (visual >= 3) visual3++;
        if (lore >= 1) anyLore++;
      }
      const label = step === Infinity ? `all (${result.chapters})` : String(step);
      console.log(`${padR(book, 13)} ${padR(label, 9)} ${pad(Math.round(result.words / 1000) + "k", 7)} ${pad(result.top.length, 5)} ${pad(anyVisual, 6)} ${pad(visual3, 6)} ${pad(anyLore, 7)}`);
      if (step === Infinity) console.log("");
    }
  }
}

/**
 * Emit assembled packs as JSON on stdout, for the Electron probe to feed to the
 * real models. `--pack pride:Elizabeth pride:Darcy anne:Anne`
 */
async function packs(specs: string[]) {
  const byBook = new Map<string, string[]>();
  for (const spec of specs) {
    const [book, name] = spec.split(":");
    if (!byBook.has(book)) byBook.set(book, []);
    byBook.get(book)!.push(name);
  }
  const out: DossierPack[] = [];
  for (const [book, wanted] of byBook) {
    const result = await run(book, false);
    if (!result) continue;
    for (const name of wanted) {
      const ev = result.top.find((e) => e.name === name || e.forms.includes(name));
      if (!ev) {
        console.error(`  ! ${book}:${name} not in the top-${CAST_LIMIT} cast (${result.top.map((e) => e.name).join(", ")})`);
        continue;
      }
      const co = result.top
        .filter((o) => o !== ev)
        .map((o) => [o.name, o.chapters.filter((c) => ev.chapters.includes(c)).length] as [string, number])
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      out.push(buildPack(book, ev, result.chapters, ev.chapters.length, ev.chapters[0] ?? 1, co));
    }
  }
  console.log(JSON.stringify(out));
}

async function main() {
  const packIndex = process.argv.indexOf("--pack");
  if (packIndex >= 0) {
    await packs(process.argv.slice(packIndex + 1));
    return;
  }
  const showIndex = process.argv.indexOf("--show");
  if (showIndex >= 0) {
    await run(process.argv[showIndex + 1] ?? "pride", true);
    return;
  }
  if (process.argv.includes("--top1")) {
    await top1(DEV_BOOKS);
    return;
  }
  if (process.argv.includes("--growth")) {
    await growth();
    return;
  }

  console.log("\nCHARACTER DOSSIER EVIDENCE — how much is actually in the prose?\n");
  console.log("Per book: the top-10 cast by mention count. A character is COVERED in a");
  console.log("channel when the manuscript yields at least one verbatim span there.\n");

  const totals = { chars: 0, anyVisual: 0, visual3: 0, anyLore: 0, anyRelation: 0, spoken: 0 };
  const perChannel = Object.fromEntries(CHANNELS.map((c) => [c, 0])) as Record<Channel, number>;

  console.log(`${padR("book", 10)} ${pad("cast", 4)} ${pad("vis≥1", 6)} ${pad("vis≥3", 6)} ${pad("lore≥1", 7)} ${pad("rel≥1", 6)} ${pad("spoken", 7)}   median spans/char`);
  console.log("-".repeat(78));

  for (const book of DEV_BOOKS) {
    const result = await run(book, false);
    if (!result) continue;
    let anyVisual = 0, visual3 = 0, anyLore = 0, anyRelation = 0, spoken = 0;
    const perChar: number[] = [];
    for (const ev of result.top) {
      const visual = VISUAL.reduce((n, c) => n + ev.byChannel[c].length, 0);
      const lore = LORE.reduce((n, c) => n + ev.byChannel[c].length, 0);
      if (visual >= 1) anyVisual++;
      if (visual >= 3) visual3++;
      if (lore >= 1) anyLore++;
      if (ev.byChannel.relation.length >= 1) anyRelation++;
      if (ev.byChannel["lore-spoken"].length >= 1) spoken++;
      perChar.push(visual + lore);
      for (const c of CHANNELS) perChannel[c] += ev.byChannel[c].length;
      totals.chars++;
    }
    totals.anyVisual += anyVisual;
    totals.visual3 += visual3;
    totals.anyLore += anyLore;
    totals.anyRelation += anyRelation;
    totals.spoken += spoken;
    perChar.sort((a, b) => a - b);
    const median = perChar[Math.floor(perChar.length / 2)] ?? 0;
    console.log(`${padR(book, 10)} ${pad(result.top.length, 4)} ${pad(anyVisual, 6)} ${pad(visual3, 6)} ${pad(anyLore, 7)} ${pad(anyRelation, 6)} ${pad(spoken, 7)}   ${median}`);
  }

  console.log("-".repeat(78));
  const pct = (n: number) => `${((n / Math.max(1, totals.chars)) * 100).toFixed(0)}%`;
  console.log(`${padR("ALL", 10)} ${pad(totals.chars, 4)} ${pad(pct(totals.anyVisual), 6)} ${pad(pct(totals.visual3), 6)} ${pad(pct(totals.anyLore), 7)} ${pad(pct(totals.anyRelation), 6)} ${pad(pct(totals.spoken), 7)}`);

  console.log("\nspans harvested by channel, whole corpus:");
  for (const c of CHANNELS) console.log(`  ${padR(c, 14)} ${pad(perChannel[c], 6)}`);
  console.log("");
}

main();

/**
 * ★ THE NO-MODEL BASELINE. What does the harness alone put at rank 1?
 *
 * The conservative tier's only zero-fabrication option is to quote the
 * manuscript verbatim rather than write about it. That is only worth shipping
 * if the top-ranked gate-eligible span usually describes the RIGHT PERSON, so
 * this prints it for hand-judging. There is no automatic grader here on
 * purpose: whether a sentence describes Elizabeth or Charlotte is exactly the
 * judgement the harness cannot make, which is the thing being measured.
 */
async function top1(books: string[]) {
  for (const book of books) {
    const result = await run(book, false);
    if (!result) continue;
    console.log(`\n══ ${book}`);
    for (const ev of result.top.slice(0, 6)) {
      const co = result.top.filter((o) => o !== ev)
        .map((o) => [o.name, o.chapters.filter((c) => ev.chapters.includes(c)).length] as [string, number])
        .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
      const pack = buildPack(book, ev, result.chapters, ev.chapters.length, ev.chapters[0] ?? 1, co);
      const first = pack.visualCandidates[0];
      const span = pack.spans.find((s) => s.n === first);
      console.log(`  ${padR(ev.name, 16)} ${span ? `(${span.channel}) ${span.text.slice(0, 132)}` : "— GATED, nothing describable"}`);
    }
  }
}
