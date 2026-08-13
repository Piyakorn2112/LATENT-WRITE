/**
 * lib-dossier-variants.ts — EXPERIMENTAL dossier pipeline variants, bench-only.
 *
 * Nothing here ships. Each variant composes pieces of the shipped module
 * (never copies of them) so that a variant that wins can graduate by moving
 * its few genuinely new functions into src/lib/character-dossier.ts, and a
 * variant that loses can be deleted without touching the product.
 *
 * The variants under test, from plans/dossier-quality-research (in progress):
 *   skeleton  richer DETERMINISTIC card: the shipped extractive composition
 *             plus templated counted-fact sentences (voice, company). Zero
 *             model risk; the templates are closed and the names/verbs are
 *             counted facts.
 *   fusion    a rewrite pass that turns fact lines into flowing prose, with
 *             a containment gate in CODE: every content word of the output
 *             must locate in the input facts, at most one fact line may be
 *             dropped, and the shape must be sentences. A failed gate falls
 *             back to the deterministic text, so the fabrication surface is
 *             zero by construction.
 *   reason-first personality — the 30s unconstrained think pass replaced by
 *             an in-schema reason field DECLARED FIRST (grammar emits in
 *             declaration order, so the model reasons before it selects and
 *             composes — the same decomposition the schema-ordering
 *             literature measures at +8-14pp for small models).
 */
import {
  buildDossierPack,
  buildFieldRequest,
  composeExtractiveParts,
  missingWords,
  type CharacterDossierEvidence,
  type DossierFieldKey,
  type DossierPack,
  type PackOptions,
} from "../src/lib/character-dossier";

// ── deterministic skeleton ────────────────────────────────────────────────

/** Present-tense base forms for the shipped MARKED_SPEECH_VERB set. Closed
 *  map, hand-written, because mechanical de-conjugation of -ed forms is
 *  exactly the "filed, considered, agreed" trap the module already recorded. */
const SPEECH_VERB_BASE: Record<string, string> = {
  snapped: "snap", muttered: "mutter", murmured: "murmur", whispered: "whisper",
  shouted: "shout", yelled: "yell", barked: "bark", insisted: "insist",
  admitted: "admit", conceded: "concede", confessed: "confess", protested: "protest",
  objected: "object", demanded: "demand", ordered: "order", commanded: "command",
  pleaded: "plead", begged: "beg", urged: "urge", warned: "warn",
  teased: "tease", joked: "joke", laughed: "laugh", sighed: "sigh",
  groaned: "groan", grumbled: "grumble", complained: "complain", observed: "observe",
  noted: "note", remarked: "remark", offered: "offer", suggested: "suggest",
  agreed: "agree", allowed: "allow", corrected: "correct", countered: "counter",
  pressed: "press", prompted: "prompt", explained: "explain", announced: "announce",
  declared: "declare", hissed: "hiss", growled: "growl", drawled: "drawl",
  stammered: "stammer", blurted: "blurt",
};

export function subjectPronounOf(ev: CharacterDossierEvidence): string {
  return ev.pronounClass === "masc" ? "He" : ev.pronounClass === "fem" ? "She" : "They";
}

/**
 * The voice line, from counted speech facts only. Templates are closed; the
 * only open slots are verbs from the closed base-form map above. Returns null
 * when the evidence does not clear the module's own floors.
 */
export function voiceSentence(ev: CharacterDossierEvidence): string | null {
  const c = ev.counts;
  const pronoun = subjectPronounOf(ev);
  if (c.speechLines === 0) {
    // Only notable for a character the book actually spends time on.
    return c.mentions >= 30 ? `${pronoun} never speaks a line of dialogue.` : null;
  }
  const length = c.meanLineWords > 0 && c.meanLineWords <= 8 ? "in short lines"
    : c.meanLineWords >= 22 ? "at length" : null;
  const marked = c.speechVerbs
    .filter(([v]) => SPEECH_VERB_BASE[v])
    .slice(0, 2)
    .map(([v]) => SPEECH_VERB_BASE[v]);
  const manner = c.speechLines >= 4 && marked.length > 0 && c.plainSaidRatio < 0.6
    ? `often to ${marked.join(" or ")}`
    : c.speechLines >= 4 && marked.length > 0
      ? `mostly plainly, sometimes to ${marked[0]}`
      : null;
  if (!length && !manner) return null;
  const verb = pronoun === "They" ? "speak" : "speaks";
  const bits = [length, manner].filter(Boolean).join(", ");
  return `${pronoun} ${verb} ${bits}.`;
}

/** The company line, from co-presence counts. */
export function companySentence(ev: CharacterDossierEvidence): string | null {
  const c = ev.counts;
  const own = c.chapters.length;
  if (own < 3 || c.coPresent.length === 0) return null;
  // A co-present "name" sharing a word with the character's own forms is the
  // character again under an unmerged alias ("Sherlock Holmes" beside
  // "Holmes" in a cold-start cast); self-company is never a fact.
  const ownTokens = new Set(
    ev.forms.flatMap((f) => f.toLowerCase().split(/\s+/)).filter((t) => t.length >= 3),
  );
  const strong = c.coPresent
    .filter(([n]) => !n.toLowerCase().split(/\s+/).some((t) => ownTokens.has(t)))
    .filter(([, k]) => k >= Math.max(2, own * 0.5));
  if (strong.length === 0) return null;
  const names = strong.slice(0, 2).map(([n]) => n);
  return `Most often on the page with ${names.join(" and ")}.`;
}

/** The richer deterministic card: shipped composition plus counted lines,
 *  floored as a WHOLE — "Big eyes." plus a voice line is a real card even
 *  though neither part clears the floor alone. */
export function composeSkeleton(
  ev: CharacterDossierEvidence,
  otherCastNames: readonly string[] = [],
): string {
  const parts = [
    ...composeExtractiveParts(ev, otherCastNames),
    voiceSentence(ev),
    companySentence(ev),
  ].filter(Boolean);
  const out = parts.join(" ");
  return out.split(/\s+/).filter(Boolean).length >= 5 ? out : "";
}

// ── fusion: rewrite fact lines as prose, gated by containment ─────────────

export interface FusionInput {
  name: string;
  pronounClass: CharacterDossierEvidence["pronounClass"];
  forms: readonly string[];
  /** Independent fact lines. Sentences of the skeleton plus, on max, the
   *  grounded field texts. Order is the card's order. */
  factLines: readonly string[];
}

export interface FusionRequest {
  systemPrompt: string;
  userText: string;
  schema: object;
  maxTokens: number;
}

export function buildFusionRequest(input: FusionInput): FusionRequest {
  const pronoun = input.pronounClass === "masc" ? "he"
    : input.pronounClass === "fem" ? "she" : "they";
  const factWords = input.factLines.join(" ").split(/\s+/).filter(Boolean).length;
  const sentMax = factWords > 60 ? 5 : factWords > 30 ? 4 : 3;
  return {
    systemPrompt:
      `You rewrite a character card so it reads as if a person wrote it. You are\n` +
      `given fact lines gathered from a manuscript search. Write 2 to ${sentMax} plain\n` +
      `sentences of connected prose.\n` +
      `Rules:\n` +
      `- Use ONLY the facts given. Never add a detail, trait, name or number that\n` +
      `  is not in a fact line. Leaving a small fact out is allowed; inventing\n` +
      `  one is not.\n` +
      `- Keep the manuscript's own wording for descriptive details. You may\n` +
      `  reorder and conjugate the facts' own words; do not add imagery,\n` +
      `  comparisons or atmosphere of your own.\n` +
      `- Refer to ${input.name} as ${pronoun} after the first mention.\n` +
      `- No headings, no lists, no quotation marks.\n` +
      `Answer as JSON: {"text"}.`,
    userText:
      `CHARACTER: ${input.name}\n` +
      `FACTS:\n${input.factLines.map((l) => `- ${l}`).join("\n")}\n\n` +
      `Write the card text.`,
    schema: { type: "object", properties: { text: { type: "string", maxLength: 700 } } },
    maxTokens: 320,
  };
}

const FINITE_VERB_RE =
  /\b(?:is|was|were|are|am|has|had|have|does|did|do|can|could|will|would|shall|should|may|might|must|never|always|[a-z]{3,}(?:ed|es|s))\b/i;

/**
 * ★ THE GATE'S FIRST MEASURED RUN REJECTED 12 OF 12 REWRITES, and a third
 *   of the "new words" were not new: "Vey's" beside the fact line's "Vey"
 *   (a possessive survives the suffix stemmer as `vey'`), and "spoke"
 *   beside "speaks" (irregular inflection, invisible to any suffix rule).
 *   Possessives are folded off both sides; each hay word that belongs to an
 *   irregular family donates its whole family, so the model may conjugate a
 *   verb the facts already use without being scored as inventing one. The
 *   remaining rejects were REAL — "moves through shadows … weaving tale" —
 *   and stay rejected.
 */
const foldPossessives = (s: string): string =>
  s.replace(/(['’])s\b/g, "").replace(/['’](?=\s|$)/g, "");

const VERB_FAMILIES: string[][] = [
  ["speak", "speaks", "spoke", "spoken", "speaking"],
  ["write", "writes", "wrote", "written", "writing"],
  ["find", "finds", "found", "finding"],
  ["spend", "spends", "spent", "spending"],
  ["tell", "tells", "told", "telling"],
  ["know", "knows", "knew", "known", "knowing"],
  ["come", "comes", "came", "coming"],
  ["go", "goes", "went", "gone", "going"],
  ["see", "sees", "saw", "seen", "seeing"],
  ["give", "gives", "gave", "given", "giving"],
  ["take", "takes", "took", "taken", "taking"],
  ["keep", "keeps", "kept", "keeping"],
  ["hold", "holds", "held", "holding"],
  ["stand", "stands", "stood", "standing"],
  ["sit", "sits", "sat", "sitting"],
  ["run", "runs", "ran", "running"],
  ["make", "makes", "made", "making"],
  ["say", "says", "said", "saying"],
  ["wear", "wears", "wore", "worn", "wearing"],
  ["grow", "grows", "grew", "grown", "growing"],
  ["leave", "leaves", "left", "leaving"],
  ["meet", "meets", "met", "meeting"],
];
const FAMILY_OF = new Map<string, string[]>();
for (const family of VERB_FAMILIES) {
  for (const form of family) FAMILY_OF.set(form, family);
}

/** Every hay word's irregular family plus its regular inflections, appended
 *  once, so conjugating a fact's own verb is never scored as invention.
 *  ("snap" must license "snapped": the doubled consonant defeats a suffix
 *  stemmer, so the licensed forms are generated on the hay side instead.) */
function expandHay(hay: string): string {
  const words = hay.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
  const extra = new Set<string>();
  for (const w of words) {
    for (const member of FAMILY_OF.get(w) ?? []) extra.add(member);
    extra.add(`${w}ed`);
    extra.add(`${w}d`);
    if (w.length <= 6 && /[bdgklmnprt]$/.test(w)) {
      extra.add(`${w}${w[w.length - 1]}ed`);
      extra.add(`${w}${w[w.length - 1]}ing`);
    }
  }
  return extra.size ? `${hay} ${[...extra].join(" ")}` : hay;
}

export interface FusionVerdict {
  ok: boolean;
  text: string;
  /** Content words of the output that locate in no fact line. Non-empty
   *  fails the gate: that is the fabrication surface, closed in code. */
  newWords: string[];
  /** Fact lines none of whose content words reached the output. */
  droppedLines: string[];
  reason: string;
}

/** How many content words a line has, via the module's own tokenizer:
 *  missingWords against an empty haystack returns every content word. */
const contentWordsOf = (line: string): string[] => missingWords(line, [" "]);

/**
 * The fusion gate. Approves only a rewrite that (a) introduces no content
 * word absent from the facts, (b) drops at most one fact line entirely,
 * (c) is shaped like prose: 2+ sentences, each with a finite verb.
 */
export function groundFusion(raw: unknown, input: FusionInput): FusionVerdict {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  const fail = (reason: string): FusionVerdict =>
    ({ ok: false, text, newWords: [], droppedLines: [], reason });
  if (!text) return fail("empty");
  if (/[•\-*]\s|\n/.test(text)) return fail("list-shape");

  const hay = [
    expandHay(foldPossessives([input.factLines.join(" "), input.forms.join(" ")].join(" "))),
  ];
  const newWords = missingWords(foldPossessives(text), hay);
  if (newWords.length > 0) {
    return { ok: false, text, newWords, droppedLines: [], reason: "new-content-words" };
  }

  const droppedLines = input.factLines.filter((line) => {
    const total = contentWordsOf(line);
    if (total.length === 0) return false;
    return missingWords(line, [text]).length === total.length;
  });
  if (droppedLines.length > 1) {
    return { ok: false, text, newWords: [], droppedLines, reason: "dropped-facts" };
  }

  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length < 2) return fail("one-sentence");
  if (sentences.some((s) => !FINITE_VERB_RE.test(s))) return fail("fragment");

  const factWords = input.factLines.join(" ").split(/\s+/).filter(Boolean).length;
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < factWords * 0.5) return fail("too-short");
  if (words > factWords * 1.8 + 10) return fail("too-long");

  return { ok: true, text, newWords: [], droppedLines, reason: "ok" };
}

/**
 * ★ A REPAIR NEEDS AN EXTERNAL CHECK, and the containment gate is one — the
 *   measured small-model rule (repair loops that check something concrete
 *   help; open self-critique hurts). ONE retry, the offending words named;
 *   a second failure falls back to the deterministic text.
 */
export function buildFusionRetryRequest(
  input: FusionInput,
  newWords: readonly string[],
): FusionRequest {
  const base = buildFusionRequest(input);
  return {
    ...base,
    systemPrompt: base.systemPrompt +
      `\n\nIMPORTANT: your earlier rewrite added words that appear in none of the` +
      `\nfact lines: ${newWords.slice(0, 12).join(", ")}. Write it again using only` +
      `\nthe facts' own words.`,
  };
}

// ── reason-first personality (replaces the unconstrained think pass) ──────

/**
 * The shipped personality request with ONE change: a free-prose `reason`
 * field declared before everything else, sized to carry a real evidence
 * walk (~100 tokens) instead of a 1024-token unconstrained think call.
 * normalizeFieldAnswer ignores unknown keys, so the shipped grounding path
 * grades this answer unchanged.
 */
export function buildReasonFirstRequest(
  pack: DossierPack,
  field: DossierFieldKey,
): ReturnType<typeof buildFieldRequest> {
  const base = buildFieldRequest(pack, field, "character");
  if (!base) return null;
  return {
    ...base,
    systemPrompt: base.systemPrompt
      .replace(
        `Answer as JSON: {"spans","${field}","confidence"} in that order.`,
        `Answer as JSON: {"reason","spans","${field}","confidence"} in that order.\n` +
        `reason: FIRST. Two or three sentences weighing the passages: which\n` +
        `  agree with each other, which is the odd one out, what they add up to.`,
      ),
    schema: {
      type: "object",
      properties: {
        reason: { type: "string", maxLength: 420 },
        ...(base.schema as { properties: object }).properties,
      },
    } as never,
  };
}

/** Wider evidence for the deep variant: quota 4 per channel, cap 20. The
 *  one-field-per-call design keeps each request's span list small anyway;
 *  this widens the candidate sets a field may cite. */
export const DEEP_PACK_OPTS: PackOptions = { spanCap: 20, perChannelQuota: 4 };

export function buildDeepPack(ev: CharacterDossierEvidence): DossierPack {
  return buildDossierPack(ev, DEEP_PACK_OPTS);
}

// ── deeper fields: longer caps, fused citations, show-don't-tell ──────────

export interface DeepFieldSpec {
  words: number;
  maxLength: number;
  extra?: string;
}

export const DEEP_FIELDS: Record<DossierFieldKey, DeepFieldSpec> = {
  appearance: { words: 30, maxLength: 220 },
  personality: {
    words: 40, maxLength: 300,
    // LIIPA / "Show, Don't Tell": trait follows conduct; and the fusion
    // instruction from Attribute-First — several agreeing passages become
    // ONE statement, not a list.
    extra: `Lead with what the passages show this person DOING, and let the
trait follow from the conduct. When two or three passages agree, cite them
all and fuse them into one statement.`,
  },
  background: { words: 35, maxLength: 260 },
};

/** Patch a shipped field request to the deep caps. The base definitions all
 *  carry "at most N words" and a schema maxLength; both move together, and
 *  the answer must then be GRADED at the same cap (normalizeFieldAnswer's
 *  maxLen option) or the tidy pass cuts a completed answer. */
export function deepenFieldRequest<T extends { systemPrompt: string; schema: object } | null>(
  req: T,
  field: DossierFieldKey,
): T {
  if (!req) return req;
  const spec = DEEP_FIELDS[field];
  const schema = JSON.parse(JSON.stringify(req.schema)) as {
    properties: Record<string, { maxLength?: number }>;
  };
  if (schema.properties?.[field]) schema.properties[field].maxLength = spec.maxLength;
  return {
    ...req,
    systemPrompt: req.systemPrompt.replace(/at most \d+ words/, `at most ${spec.words} words`)
      + (spec.extra ? `\n\n${spec.extra}` : ""),
    schema,
  };
}
