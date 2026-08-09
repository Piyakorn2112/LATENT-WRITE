/**
 * entity-review.ts — the scan-review task: "how is this NAME actually used?"
 *
 * The world scan classifies every extracted name deterministically and marks
 * the ones it is not sure about (`needsReview`, or a small `ambiguityGap`
 * between its top two labels). Those are exactly the cases where a small
 * amount of real reading beats another heuristic, so they — and only they —
 * are shown to the local model.
 *
 * This is the SECOND consumer of the assistant runtime, and it exists partly
 * to prove the runtime is generic: same client, same grammar-constrained JSON,
 * a completely different domain question, zero runtime changes.
 *
 * ★ THE MODEL SEES SNIPPETS, NEVER THE MANUSCRIPT. Two ±140-char windows
 *   around real occurrences. That is the whole evidence budget, which keeps
 *   the answer about USAGE ("the road to X", "X said") and not about whatever
 *   the name resembles in the world.
 *
 * ★ `not-a-name` IS A FIRST-CLASS ANSWER. The scan's worst failures are
 *   sentence-initial common words ("Meanwhile", "Try"), and a classifier that
 *   can only choose between four name types will always launder them into one.
 *
 * Application to the UI is a later phase. `applyProposalsToScanResult` is pure
 * and returns a new ScanResult-shaped object plus the change list; nothing in
 * this module touches a store.
 */
import { tidyTruncatedText } from "./assistant-client";
import type { AssistantJSONRunner } from "./assistant-client";

export const ENTITY_REVIEW_PROMPT_VERSION = 1;
export const ENTITY_REVIEW_TASK = "entity-review";

/** Below this gap between the top two labels, the scan is effectively guessing. */
export const AMBIGUITY_GAP_FLOOR = 0.15;
/** One pass is a foreground nicety, not a batch job. Raised from 12 when review
 *  stopped being reserved for the names the scan already doubted. */
export const REVIEW_CAP = 24;
export const SNIPPET_RADIUS = 140;
export const SNIPPETS_PER_NAME = 3;

/**
 * How confident the model must be to OVERTURN the scan.
 *
 * ★ ASYMMETRIC ON PURPOSE. Agreeing with a deterministic classifier is cheap;
 *   overruling one that was sure should not be. A name the scan itself doubted
 *   needs only the ordinary bar; a name it was confident about needs this one,
 *   so a hesitant model cannot churn a correct scan.
 */
export const OVERTURN_DOUBTED_MIN = 0.6;
export const OVERTURN_CONFIDENT_MIN = 0.8;

const DEFAULT_MAX_TOKENS = 128;
const DEFAULT_TIMEOUT_MS = 30_000;
const REASON_MAX = 120;

export type EntityType = "character" | "place" | "faction" | "entity";
export type ProposedType = EntityType | "not-a-name";

export interface EntityReviewEntry {
  name: string;
  currentType: EntityType;
  needsReview?: boolean;
  /** Distance between the scan's top two label scores, when it recorded one. */
  ambiguityGap?: number;
}

export interface EntityReviewInput {
  entries: readonly EntityReviewEntry[];
  /** The scanned manuscript span the entries came from. */
  text: string;
}

export interface EntityReviewProposal {
  name: string;
  currentType: EntityType;
  proposedType: ProposedType;
  confidence: number;
  reason: string;
  /** True when the scan itself was unsure. Sets which overturn bar applies. */
  scanDoubted: boolean;
  /** Whole-word sightings across the reviewed span. Gates bucket MOVES. */
  occurrences?: number;
}

/**
 * ★★ A NAME NOBODY USES THREE TIMES HAS NO USAGE PATTERN TO READ, so a
 *    proposal to MOVE it between buckets is a coin flip however confident it
 *    sounds. Measured on The Root Crown against the 4B: of the accepted
 *    proposals that were wrong, every single one was a name with one or two
 *    sightings ("Hollow Vein", both Conclave Schools, "Greythorn Quarter
 *    Anomaly"), while every proposal that was right had four or more.
 *
 * ★ DELETIONS ARE DELIBERATELY NOT GATED, and the asymmetry is the point. At
 *   two sightings the snippets ARE the name's entire life in the book, so
 *   "this is not a name at all" is the one question that evidence can settle —
 *   it is the four-way bucket choice that it cannot. "Classify Crown Prince"
 *   appears once and deleting it was correct.
 */
export const MIN_MOVE_OCCURRENCES = 3;

/**
 * ★★ THE CATCH-ALL IS CALLED "object" ON THE WIRE, NOT "entity".
 *
 *    Measured, and the second time this codebase has hit it (the adjudicator's
 *    `break` was the first): with "entity" in the enum this model answered
 *    "entity" for a name whose own reason said "clearly a person, as evidenced
 *    by the dialogue" and for one whose reason said "used as a place". The
 *    REASONING was right and the LABEL was wrong — "entity" is a generic word
 *    the model reaches for whenever a thing is being named, and the whole task
 *    is framed in terms of entities, so it is primed on every run.
 *
 *    Renaming the wire label fixed both without touching a single rule. The
 *    store's own type stays `entity`; `WIRE_TO_TYPE` maps it back.
 *
 * ★★ AND IT HAPPENED A SECOND TIME, TO "not-a-name".
 *
 *    Measured on The Root Crown against the 4B: NINE of its fifteen accepted
 *    proposals were `not-a-name`, deleting Growth, Bind, Founding, Aldren,
 *    Hollow Vein and Mycomedical — all of them real names — with reasons like
 *    "the name appears after the/a and is not spoken to or spoken by anyone".
 *
 *    That reason is a near-quotation of the prompt, which explained the counts
 *    with the phrase "after the/a suggests it is not a PERSONAL name". The
 *    model carried "not a … name" straight onto the label that reads the same
 *    way. Two lexically confusable strings, one of them an escape hatch, and
 *    the escape hatch wins — the identical mechanism, and the second time this
 *    file has paid for it.
 *
 *    `common-word` names what the label is actually for: a capitalised word
 *    that is not naming anything. Nothing about a thing written "the X" reads
 *    that way, which is the point.
 */
export const ENTITY_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    // ★★ REASON FIRST, AND THE ORDER IS THE FIX. A grammar emits properties in
    //    declaration order, so with `type` first the model had to commit to a
    //    label before it had written a single word of evidence — and it then
    //    produced reasons that CONTRADICTED its own label ("object" for a name
    //    whose reason read "clearly a person"). Naming the evidence first lets
    //    the label follow from it. Do not reorder these for tidiness.
    reason: { type: "string", maxLength: REASON_MAX },
    type: { enum: ["character", "place", "faction", "object", "common-word"] },
    confidence: { type: "number" },
  },
} as const;

/** Wire label → the type this app stores. "entity" is still accepted, because
 *  a grammar change must never be the only thing standing between a valid
 *  answer and a dropped one. */
const WIRE_TO_TYPE: Record<string, ProposedType> = {
  character: "character",
  place: "place",
  faction: "faction",
  object: "entity",
  entity: "entity",
  "common-word": "not-a-name",
  "not-a-name": "not-a-name",
};

/**
 * ★★ A DECISION LADDER, NOT A LIST OF TYPES, AND THE CATCH-ALL GOES LAST.
 *
 *    Measured across four live runs: a longer prompt with the types listed as
 *    peers made this model retreat to "entity" for BOTH a clear person and a
 *    clear place. "entity" is the semantic catch-all, and a catch-all offered
 *    as an equal option absorbs everything the moment the discriminators get
 *    crowded — the same failure the event engine's dictionaries had. Stating
 *    an ordered test, stopping at the first that fits, and naming the
 *    catch-all a last resort is what separated them again.
 *
 *    Also measured: telling the model "the current label is often right"
 *    anchored it so hard that "Meanwhile" stayed a character. The asymmetric
 *    acceptance bar in `applyProposalsToScanResult` is where that caution
 *    belongs — in code, where it cannot bias a reading.
 *
 * ★★ WHEN THERE ARE TWO ESCAPE HATCHES, THE IRREVERSIBLE ONE GOES LAST.
 *
 *    The ladder ends where the model stops reading, so last place is the
 *    scarce position and only one label can have it. `object` files a name in
 *    a bucket the writer can drag it out of; `common-word` DELETES it, and a
 *    name deleted from the cast is one the writer never sees again. That
 *    asymmetry decides the order, not which label is semantically broader.
 *
 *    It also matches what the 4B was measured doing with them reversed: for
 *    Growth, Bind and Founding it wrote reasons that name them exactly ("a
 *    class of phrases with specific technical definitions", "a time period"),
 *    which is rung 4 stated precisely, and then answered rung 4 as it was
 *    then written — `common-word` — and deleted all three.
 */
export const ENTITY_REVIEW_SYSTEM = `You classify how a NAME is used in a novel manuscript. You are given the name,
counts of how it is used across the chapter, and verbatim snippets. That is all
the evidence there is.

Decide in this order and stop at the first that fits:
1. It speaks, or is spoken to, or acts and is described like a person, OR it is
   part of a person's name — "character". A surname carries this: if the
   snippets show it after a given name ("Tessa Mosswell"), it is that family's
   name and belongs here, however often the rest of the book writes "the
   Mosswell loaves". Places, objects and groups do not talk.
2. People go to it, come from it, or are inside it — "place". A city, house,
   road, region.
3. It is an organised group acting as one — "faction". An order, guild, army,
   court, crew.
4. It names a thing that is not a person, a place or a group — "object". A
   ship, a sword, a book, a doctrine, a named spell or technique, an era, a
   treaty. Every name is the name of something, so "it is a named thing" is
   NOT on its own a reason to answer "object".
5. Only if none of the above fit: it is not naming anything at all —
   "common-word". The test is replacement: an ordinary word could be written
   in lower case without changing what the sentence means, as with a word that
   merely opens a sentence, an interjection, a bare title, a heading. "the
   Growth phrase" does not survive that test and IS a name. This is a last
   resort, never a default.

The counts: "speaks" and "spoken to" are person usage; "after a place
preposition" counts "at X" and "through X"; a high "after the/a" count means it
is a thing rather than a person, which still leaves place, faction and object
open. Where the counts and the snippets disagree, the snippets decide.

When a multi-word name ends in a word saying what kind of thing it is, that
LAST word decides and the earlier words only say which one: "the Outer Ring
Anomaly" is an anomaly named after a district, not a district.

Judge only from the evidence. Do not use knowledge of any real or famous name.
The current label is an earlier guess and is not evidence.
PREFER a low confidence over a guess.
Answer as JSON: {"reason","type","confidence"} in that order.
reason: FIRST, one clause of at most 15 words naming what the evidence shows.
type: the label that clause leads to.
confidence: a number from 0 to 1, how much the evidence shows. Never above 1.`;

// ── usage signals ─────────────────────────────────────────────────────────
//
// ★★ THE SCAN'S OWN DOUBT IS NOT ENOUGH. Review used to be reserved for names
//    the scan flagged, which by construction can never reach a name it got
//    CONFIDENTLY wrong — and "a character classified as a location" is exactly
//    that failure. These counts are the second opinion that promotes such a
//    name into review: cheap, deterministic, computed from the same span the
//    snippets come from.
//
// They are evidence for the priority queue AND they ride along in the prompt,
// because a count over the whole span sees what three windows cannot.

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);

/**
 * ★★ `\b` IS ASCII-ONLY AND IT MADE THIS MODULE LIE.
 *
 *    `Á` is not a word character to a non-unicode regex, so `/\bÁntonia\b/`
 *    never matches — but `/\basked\s+Ántonia\b/` does, because there the
 *    boundary sits on "asked". Measured: `usageSignals` reported Ántonia as
 *    `occurrences: 0` and `spoken: 1` IN THE SAME OBJECT, which is not a
 *    degraded reading, it is an impossible one. Downstream that meant a
 *    contradiction score computed against a zero denominator, a name jumping
 *    the review queue on phantom evidence, `usageSnippets` returning nothing
 *    so the model was never asked, and `MIN_MOVE_OCCURRENCES` refusing every
 *    correction on the grounds that the name does not appear.
 *
 *    Every boundary in this file is these. world-data.ts carries the same
 *    pair; the two are deliberately not shared, because this module does not
 *    import the scanner.
 */
const WB = "(?<![\\p{L}\\p{N}_])";
const WA = "(?![\\p{L}\\p{N}_])";
const nameRe = (body: string, flags = "g") => new RegExp(body, `${flags}u`);

export interface UsageSignals {
  /** "X said", "said X", "X asked" — a name that speaks is a person. */
  spoken: number;
  /** "asked X", "told X", "turned to X" — a name spoken TO is a person. */
  addressed: number;
  /** "to X", "at X", "through X" — motion and location take places. */
  placePrep: number;
  /** "the X", "a X" — a personal name is rarely determined. */
  determiner: number;
  possessive: number;
  /** ", X," inside dialogue — direct address, so a person. */
  vocative: number;
  occurrences: number;
}

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

export function usageSignals(text: string, name: string): UsageSignals {
  const n = escapeRe(name);
  if (!text || !name) {
    return { spoken: 0, addressed: 0, placePrep: 0, determiner: 0, possessive: 0, vocative: 0, occurrences: 0 };
  }
  return {
    spoken:
      count(text, nameRe(`${WB}${n}${WA}\\s+(?:said|says|asked|asks|replied|answered|whispered|shouted|muttered|thought|nodded|smiled|laughed|cried|shrugged)${WA}`)) +
      count(text, nameRe(`${WB}(?:said|asked|replied|answered|whispered|shouted|muttered|cried)\\s+${n}${WA}`)),
    addressed: count(text, nameRe(`${WB}(?:asked|told|warned|reminded|thanked|greeted|assured|answered|informed|begged)\\s+${n}${WA}|${WB}turn(?:ed|ing)?\\s+to\\s+${n}${WA}`)),
    // ★ "to" IS NOT A PLACE PREPOSITION ON ITS OWN. "turned to Doran" and
    //   "said to Doran" are person usage, and counting them as place evidence
    //   made a speaking character read as a location — the exact failure this
    //   module exists to catch. Bare "to X" only counts when no attention or
    //   speech verb governs it; the unambiguous prepositions always count.
    placePrep:
      count(text, nameRe(`${WB}(?:in|at|from|toward|towards|outside|inside|near|across|through|into|onto|past|beyond|around)\\s+${n}${WA}`)) +
      count(text, nameRe(`(?<!${WB}(?:turn|turns|turned|turning|spoke|speak|speaks|speaking|said|says|talk|talks|talked|listen|listens|listened|whisper|whispers|whispered|shout|shouts|shouted|gesture|gestures|gestured|nod|nods|nodded|point|points|pointed|reply|replies|replied|according|close|next|back)\\s)${WB}to\\s+${n}${WA}`)),
    determiner: count(text, nameRe(`${WB}(?:the|a|an)\\s+${n}${WA}`)),
    possessive: count(text, nameRe(`${WB}${n}(?:['’]s)`)),
    vocative: count(text, nameRe(`[,;]\\s*${n}\\s*[,.!?]`)),
    occurrences: count(text, nameRe(`${WB}${n}${WA}`)),
  };
}

const personEvidence = (s: UsageSignals) => s.spoken + s.addressed + s.vocative;
const placeEvidence = (s: UsageSignals) => s.placePrep + s.determiner * 0.5;

/**
 * How much the prose disagrees with the label the scan assigned, 0..1.
 *
 * Only ever counts evidence the OTHER way with none of its own — "Doran is
 * called a place, and the text shows him speaking three times and never shows
 * anyone travelling to him". A name with evidence on both sides is ordinary
 * ambiguity, not a contradiction, and its own low ambiguityGap will pick it up.
 */
export function contradictionScore(currentType: EntityType, s: UsageSignals): number {
  const person = personEvidence(s);
  const place = placeEvidence(s);
  const strength = (n: number) => Math.min(1, n / 3);
  if (currentType === "character") return place >= 2 && person === 0 ? strength(place) : 0;
  if (currentType === "place" || currentType === "faction" || currentType === "entity") {
    return person >= 2 && place === 0 ? strength(person) : 0;
  }
  return 0;
}

/** The scan admits it was unsure about this one. */
export function scanDoubted(entry: EntityReviewEntry): boolean {
  return entry.needsReview === true ||
    (entry.ambiguityGap !== undefined && entry.ambiguityGap < AMBIGUITY_GAP_FLOOR);
}

/** Higher runs first. Contradiction outranks mere doubt: a wrong-and-confident
 *  label costs the writer more than an honest coin-flip does. */
export function reviewPriority(entry: EntityReviewEntry, signals?: UsageSignals): number {
  const contradiction = signals ? contradictionScore(entry.currentType, signals) : 0;
  const doubt = entry.needsReview === true
    ? 0.7
    : entry.ambiguityGap !== undefined && entry.ambiguityGap < AMBIGUITY_GAP_FLOOR
      ? 0.5 + (AMBIGUITY_GAP_FLOOR - entry.ambiguityGap)
      : 0;
  // A contradiction can reach 1.0 and therefore always outranks pure doubt.
  return Math.max(contradiction, doubt);
}

// ── selection & snippets ──────────────────────────────────────────────────

export interface SelectReviewableOptions {
  /** The scanned span. Without it, selection degrades to the scan's own doubt. */
  text?: string;
  cap?: number;
}

/**
 * Order the whole cast by how much a second reading would be worth, then take
 * the budget. Every classified name is eligible; nothing is filtered out up
 * front, because the failure this exists to catch is a name nobody flagged.
 */
export function selectReviewable(
  entries: readonly EntityReviewEntry[],
  opts: SelectReviewableOptions = {},
): EntityReviewEntry[] {
  const cap = opts.cap ?? REVIEW_CAP;
  const scored = entries.map((entry) => ({
    entry,
    priority: reviewPriority(entry, opts.text ? usageSignals(opts.text, entry.name) : undefined),
  }));
  // ★★ A QUESTION WITH NO ANSWER IN IT IS PURE COST — AND PURE RISK. Priority
  //    zero means the scan did not doubt this name AND its own usage counts do
  //    not contradict the label, so there is nothing to ask. Measured on The
  //    Root Crown: eleven of the twenty-four slots went to names in exactly
  //    that state, which is 45% of the pass spent on questions whose only
  //    possible outcome is churning a correct answer.
  //
  // ★  ONLY WHEN THE TEXT WAS PROVIDED. Without it there is no contradiction
  //    score to compute, so priority zero means "unknown", not "nothing to
  //    ask", and filtering on it would silently disable the whole pass for
  //    every caller that does not pass a span.
  const eligible = opts.text ? scored.filter((s) => s.priority > 0) : scored;
  // Stable within a priority so a rerun of the same scan asks the same
  // questions in the same order.
  return eligible
    .map((s, index) => ({ ...s, index }))
    .sort((a, b) => (b.priority - a.priority) || (a.index - b.index))
    .slice(0, cap)
    .map((s) => s.entry);
}

/**
 * Up to `limit` windows of ±`radius` chars around real occurrences.
 *
 * ★ CASE-SENSITIVE, whole word. Proper names are capitalised in prose; a
 *   case-blind match is how "Don" starts matching "don't" (the ledger paid for
 *   this one already).
 * ★ OCCURRENCES CLOSER THAN `radius` ARE SKIPPED. Two windows over the same
 *   sentence are one piece of evidence charged twice.
 */
export function usageSnippets(
  text: string,
  name: string,
  limit = SNIPPETS_PER_NAME,
  radius = SNIPPET_RADIUS,
): string[] {
  if (!text || !name) return [];
  const re = nameRe(`${WB}${escapeRe(name)}${WA}`);
  const out: string[] = [];
  let lastIndex = -Infinity;
  for (let m = re.exec(text); m && out.length < limit; m = re.exec(text)) {
    if (m.index - lastIndex < radius) continue;
    lastIndex = m.index;
    const start = Math.max(0, m.index - radius);
    const end = Math.min(text.length, m.index + name.length + radius);
    let body = text.slice(start, end).replace(/\s+/g, " ").trim();
    // Cut to whole words at both edges — a window that ends mid-word reads as
    // corrupt evidence, and the model has to spend attention deciding it isn't.
    if (start > 0) body = body.replace(/^\S+\s+/, "");
    if (end < text.length) body = body.replace(/\s+\S+$/, "");
    out.push(`${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`);
  }
  return out;
}

export interface EntityReviewRequest {
  systemPrompt: string;
  userText: string;
  schema: typeof ENTITY_REVIEW_SCHEMA;
  maxTokens: number;
}

/**
 * The exact bytes one entry sends. Exported for the same reason the
 * adjudicator's is: a harness must drive the real prompt, not a copy of it.
 */
export function buildEntityReviewRequest(
  entry: EntityReviewEntry,
  snippets: readonly string[],
  maxTokens = DEFAULT_MAX_TOKENS,
  signals?: UsageSignals,
): EntityReviewRequest {
  const lines = [
    `NAME: ${entry.name}`,
    `CURRENT LABEL: ${entry.currentType}`,
    ...(signals
      ? [
          "",
          "COUNTS ACROSS THE CHAPTER",
          `appears ${signals.occurrences} times · speaks ${signals.spoken} · spoken to ${signals.addressed} · ` +
            `addressed by name ${signals.vocative} · after a place preposition ${signals.placePrep} · ` +
            `after the/a ${signals.determiner} · possessive ${signals.possessive}`,
        ]
      : []),
    "",
    "SNIPPETS",
    ...snippets.map((s, i) => `${i + 1}. ${s}`),
    "",
    `The question: how is "${entry.name}" used here?`,
  ];
  return {
    systemPrompt: ENTITY_REVIEW_SYSTEM,
    userText: lines.join("\n"),
    schema: ENTITY_REVIEW_SCHEMA,
    maxTokens,
  };
}

// ── the pass ──────────────────────────────────────────────────────────────

export interface EntityReviewOptions {
  run: AssistantJSONRunner;
  cap?: number;
  snippetLimit?: number;
  snippetRadius?: number;
  maxTokens?: number;
  timeoutMs?: number;
  isCancelled?: () => boolean;
  onProposal?: (proposal: EntityReviewProposal) => void;
}

const TYPES: readonly ProposedType[] = ["character", "place", "faction", "entity", "not-a-name"];

function normalizeProposal(
  entry: EntityReviewEntry,
  raw: unknown,
  occurrences?: number,
): EntityReviewProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const wire = value.type;
  if (typeof wire !== "string") return null;
  const type = WIRE_TO_TYPE[wire];
  if (!type || !TYPES.includes(type)) return null;
  const confidenceRaw = value.confidence;
  if (typeof confidenceRaw !== "number" || !Number.isFinite(confidenceRaw)) return null;
  const reasonRaw = value.reason;
  if (typeof reasonRaw !== "string") return null;
  const reason = tidyTruncatedText(reasonRaw.slice(0, REASON_MAX), REASON_MAX);
  if (!reason) return null;
  return {
    name: entry.name,
    currentType: entry.currentType,
    proposedType: type,
    confidence: Math.min(1, Math.max(0, confidenceRaw)),
    reason,
    scanDoubted: scanDoubted(entry),
    occurrences,
  };
}

/**
 * Review the ambiguous entries, one at a time (the client queue enforces that
 * anyway). Entries with no usable snippet are skipped, not guessed at: there
 * is nothing honest to ask about a name the span never shows.
 *
 * Unlike the adjudicator sweep there is no pacing gap — this pass is
 * user-initiated and foreground, so its cost is expected, not hidden.
 */
export async function reviewEntities(
  input: EntityReviewInput,
  opts: EntityReviewOptions,
): Promise<EntityReviewProposal[]> {
  const proposals: EntityReviewProposal[] = [];
  const selected = selectReviewable(input.entries, {
    text: input.text,
    cap: opts.cap ?? REVIEW_CAP,
  });

  for (const entry of selected) {
    if (opts.isCancelled?.()) break;
    const snippets = usageSnippets(
      input.text,
      entry.name,
      opts.snippetLimit ?? SNIPPETS_PER_NAME,
      opts.snippetRadius ?? SNIPPET_RADIUS,
    );
    if (snippets.length === 0) continue;

    const signals = usageSignals(input.text, entry.name);
    const request = buildEntityReviewRequest(
      entry,
      snippets,
      opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      signals,
    );
    // ★★ ONE BAD CALL COSTS ONE NAME. `run` is a bridge to another process and
    //    it can reject — the host dies, the socket closes, a timeout races.
    //    Unguarded, that rejection propagated out of `reviewEntities` and the
    //    caller's try/catch threw away EVERY proposal in the pass, including
    //    the ones already collected and correct. The failure of one name is
    //    not evidence about the others.
    let result: Awaited<ReturnType<typeof opts.run<unknown>>>;
    try {
      result = await opts.run<unknown>({
        task: ENTITY_REVIEW_TASK,
        tag: entry.name,
        systemPrompt: request.systemPrompt,
        userText: request.userText,
        schema: request.schema,
        maxTokens: request.maxTokens,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch {
      continue;
    }
    if (!result.ok) continue;

    const proposal = normalizeProposal(entry, result.json, signals.occurrences);
    if (!proposal) continue;
    proposals.push(proposal);
    opts.onProposal?.(proposal);
  }

  return proposals;
}

// ── pure application ──────────────────────────────────────────────────────

/** Structurally the ScanResult of world-data.ts; kept local so this module
 *  does not drag the 70k-line scanner into its import graph. */
export interface ScanBuckets {
  characters: string[];
  places: string[];
  factions: string[];
  entities: string[];
}

export type ScanBucketKey = keyof ScanBuckets;

const BUCKET_OF: Record<EntityType, ScanBucketKey> = {
  character: "characters",
  place: "places",
  faction: "factions",
  entity: "entities",
};
const TYPE_OF: Record<ScanBucketKey, EntityType> = {
  characters: "character",
  places: "place",
  factions: "faction",
  entities: "entity",
};

export interface EntityReviewChange {
  name: string;
  /** Where the name actually sat in the scan, not what the proposal claimed. */
  from: EntityType;
  to: ProposedType;
  confidence: number;
  reason: string;
}

/**
 * Move names between buckets according to accepted proposals, dropping
 * `not-a-name` entirely. Pure: returns a new object and never mutates `scan`.
 *
 * A proposal below its bar, one that agrees with where the name already is, or
 * one for a name the scan does not contain changes nothing — the scan, not the
 * proposal, is the source of truth about current placement.
 *
 * ★ TWO BARS, NOT ONE. `minConfidence` applies to names the scan itself
 *   doubted; overturning a name it was confident about needs
 *   OVERTURN_CONFIDENT_MIN. Same rule for deleting one as `not-a-name`.
 */
export function applyProposalsToScanResult(
  scan: ScanBuckets,
  proposals: readonly EntityReviewProposal[],
  minConfidence = OVERTURN_DOUBTED_MIN,
): { scan: ScanBuckets; changes: EntityReviewChange[] } {
  const next: ScanBuckets = {
    characters: [...scan.characters],
    places: [...scan.places],
    factions: [...scan.factions],
    entities: [...scan.entities],
  };
  const changes: EntityReviewChange[] = [];
  const keys: ScanBucketKey[] = ["characters", "places", "factions", "entities"];
  // ★ ONE ANSWER PER NAME. Two proposals for the same name applied in order
  //   would move it twice, and the second reads the bucket the FIRST one put
  //   it in — so a name could be walked across three buckets by a model that
  //   answered inconsistently. Selection is stable and priority-ordered, so
  //   the first proposal is the best-motivated one.
  const settled = new Set<string>();

  for (const proposal of proposals) {
    if (settled.has(proposal.name)) continue;
    const bar = proposal.scanDoubted
      ? minConfidence
      : Math.max(minConfidence, OVERTURN_CONFIDENT_MIN);
    if (proposal.confidence < bar) continue;
    // A silent reason is an unexplainable change; the writer would have no way
    // to judge it, so it does not get made.
    if (!proposal.reason.trim()) continue;

    const fromKey = keys.find((k) => next[k].includes(proposal.name));
    if (!fromKey) continue;
    const from = TYPE_OF[fromKey];
    if (proposal.proposedType === from) continue;

    // See MIN_MOVE_OCCURRENCES: a four-way bucket choice needs a usage
    // pattern, and two sightings are not one. Deleting is exempt, because at
    // two sightings the snippets are the name's whole life in the book.
    if (
      proposal.proposedType !== "not-a-name"
      && proposal.occurrences !== undefined
      && proposal.occurrences < MIN_MOVE_OCCURRENCES
    ) continue;

    // ★ REMOVE FROM EVERY BUCKET, not just the one it was found in. A name the
    //   scan managed to file twice would otherwise be COPIED by the move
    //   rather than moved, leaving the writer one referent under two types.
    for (const key of keys) next[key] = next[key].filter((n) => n !== proposal.name);
    if (proposal.proposedType !== "not-a-name") {
      const toKey = BUCKET_OF[proposal.proposedType];
      if (!next[toKey].includes(proposal.name)) next[toKey].push(proposal.name);
    }
    settled.add(proposal.name);
    changes.push({
      name: proposal.name,
      from,
      to: proposal.proposedType,
      confidence: proposal.confidence,
      reason: proposal.reason,
    });
  }

  return { scan: next, changes };
}
