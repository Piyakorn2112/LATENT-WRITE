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
/** One pass is a background nicety, not a batch job. */
export const REVIEW_CAP = 12;
export const SNIPPET_RADIUS = 140;
export const SNIPPETS_PER_NAME = 2;

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
}

/** Same reasoning as the adjudicator: no `minLength`, so a reason stays measurable. */
export const ENTITY_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    type: { enum: ["character", "place", "faction", "entity", "not-a-name"] },
    confidence: { type: "number" },
    reason: { type: "string", maxLength: REASON_MAX },
  },
} as const;

export const ENTITY_REVIEW_SYSTEM = `You classify how a NAME is used in a novel manuscript. You are given the name
and one or two verbatim snippets of the manuscript around it. The snippets are
all the evidence there is.

Types:
- "character": a person or speaking being. Speaks, is spoken to, acts, is described.
- "place": somewhere people are, go to, or come from. A city, house, road, region.
- "faction": an organised group acting as one. An order, guild, army, court, crew.
- "entity": a named thing that is none of the above. An object, ship, title, artefact.
- "not-a-name": not a name at all. A capitalised sentence-opening common word, a
  bare title, an interjection, a heading.

Rules:
- Judge only from the snippets. Do not use knowledge of any real or famous name.
- The grammar around the name is the evidence: "the road to X" and "the streets
  of X" are place usage; "X said" and "she asked X" are character usage.
- PREFER a low confidence over a guess. Confidence is how much the snippets
  show, not how certain you feel.
- If the snippets do not show the word being used as a name, answer "not-a-name".
Answer as JSON: {"type","confidence","reason"}.
confidence: a number from 0 to 1. 1 means the snippets settle it, 0 means they
show nothing. Never answer above 1.
reason: one clause of at most 15 words, pointing at what the snippets show.
Stop before 120 characters; a reason that runs long is cut off mid-word.`;

// ── selection & snippets ──────────────────────────────────────────────────

/** The scan's own uncertainty picks the work; nothing else is worth a run. */
export function selectReviewable(
  entries: readonly EntityReviewEntry[],
  cap = REVIEW_CAP,
): EntityReviewEntry[] {
  const picked = entries.filter(
    (e) =>
      e.needsReview === true ||
      (e.ambiguityGap !== undefined && e.ambiguityGap < AMBIGUITY_GAP_FLOOR),
  );
  return picked.slice(0, cap);
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
  const re = new RegExp(`\\b${escapeRe(name)}\\b`, "g");
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
): EntityReviewRequest {
  const lines = [
    `NAME: ${entry.name}`,
    "",
    "SNIPPETS",
    ...snippets.map((s, i) => `${i + 1}. ${s}`),
    "",
    `The question: how is "${entry.name}" used in these snippets?`,
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
): EntityReviewProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const type = value.type;
  if (typeof type !== "string" || !TYPES.includes(type as ProposedType)) return null;
  const confidenceRaw = value.confidence;
  if (typeof confidenceRaw !== "number" || !Number.isFinite(confidenceRaw)) return null;
  const reasonRaw = value.reason;
  if (typeof reasonRaw !== "string") return null;
  const reason = tidyTruncatedText(reasonRaw.slice(0, REASON_MAX), REASON_MAX);
  if (!reason) return null;
  return {
    name: entry.name,
    currentType: entry.currentType,
    proposedType: type as ProposedType,
    confidence: Math.min(1, Math.max(0, confidenceRaw)),
    reason,
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
  const selected = selectReviewable(input.entries, opts.cap ?? REVIEW_CAP);

  for (const entry of selected) {
    if (opts.isCancelled?.()) break;
    const snippets = usageSnippets(
      input.text,
      entry.name,
      opts.snippetLimit ?? SNIPPETS_PER_NAME,
      opts.snippetRadius ?? SNIPPET_RADIUS,
    );
    if (snippets.length === 0) continue;

    const request = buildEntityReviewRequest(entry, snippets, opts.maxTokens ?? DEFAULT_MAX_TOKENS);
    const result = await opts.run<unknown>({
      task: ENTITY_REVIEW_TASK,
      tag: entry.name,
      systemPrompt: request.systemPrompt,
      userText: request.userText,
      schema: request.schema,
      maxTokens: request.maxTokens,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (!result.ok) continue;

    const proposal = normalizeProposal(entry, result.json);
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
 * A proposal below `minConfidence`, one that agrees with where the name
 * already is, or one for a name the scan does not contain changes nothing —
 * the scan, not the proposal, is the source of truth about current placement.
 */
export function applyProposalsToScanResult(
  scan: ScanBuckets,
  proposals: readonly EntityReviewProposal[],
  minConfidence = 0.6,
): { scan: ScanBuckets; changes: EntityReviewChange[] } {
  const next: ScanBuckets = {
    characters: [...scan.characters],
    places: [...scan.places],
    factions: [...scan.factions],
    entities: [...scan.entities],
  };
  const changes: EntityReviewChange[] = [];
  const keys: ScanBucketKey[] = ["characters", "places", "factions", "entities"];

  for (const proposal of proposals) {
    if (proposal.confidence < minConfidence) continue;

    const fromKey = keys.find((k) => next[k].includes(proposal.name));
    if (!fromKey) continue;
    const from = TYPE_OF[fromKey];
    if (proposal.proposedType === from) continue;

    next[fromKey] = next[fromKey].filter((n) => n !== proposal.name);
    if (proposal.proposedType !== "not-a-name") {
      const toKey = BUCKET_OF[proposal.proposedType];
      if (!next[toKey].includes(proposal.name)) next[toKey].push(proposal.name);
    }
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
