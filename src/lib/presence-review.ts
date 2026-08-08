/**
 * presence-review.ts — in the room, or being talked about?
 *
 * character-presence.ts decides 87% of the ledger's marks from where a name
 * falls relative to the quotation marks and what predicate it heads. The other
 * 13% it declares `uncertain` rather than guessing, and those are what this
 * asks about. Measured over 67 DEV chapters that is ~0.5 questions a chapter.
 *
 * ★★ THE SHAPE IS BLOCKING → VERIFICATION, WHICH IS WHAT THE FIELD SETTLED ON.
 *    Entity-resolution practice converged on a cheap deterministic pass that
 *    generates candidates and tolerates false positives, then a model used only
 *    as the final judge over those candidates — never as an end-to-end
 *    resolver. The same split is already in this repo (entity-review sees only
 *    names the scan doubted, chekhov-review only ranked phrases), and it is why
 *    this file can never make the deterministic answer worse: the 87% is not
 *    shown to the model at all.
 *
 * ★ THE ENGINE'S OWN LEAN IS NOT SHOWN EITHER. `uncertain` marks still carry a
 *   class — `present` at 0.55 for an object, `mentioned` at 0.5 for a bare
 *   narration hit — and putting that in the prompt would invite exactly the
 *   anchoring that killed the attribution task. The model gets the snippets and
 *   the question, and its answer is applied or it is not.
 *
 * ★ THE PAIR OF CONCRETE TESTS IS THE WHOLE PROMPT. "Is she present?" is a
 *   question about the world; "does this sentence put her in the room or in
 *   someone's head?" is a question about the sentence, and only the second one
 *   has an answer in the evidence the model is given.
 */
import { fnv1a } from "./evidence-pack";
import { tidyTruncatedText } from "./assistant-client";
import { reasonEchoesSentence } from "./chekhov-review";
import type { AssistantJSONRunner } from "./assistant-client";

export const PRESENCE_TASK = "presence-review";
/** Bump on ANY change to the prompt text or the schema. Invalidates verdicts. */
export const PRESENCE_PROMPT_VERSION = 1;

/** Per-chapter budget. The deterministic engine already answered the rest. */
export const PRESENCE_CAP = 3;
/**
 * Below this the engine's own uncertain call stands, unchanged.
 *
 * ★ THIS IS A CONSERVATIVE GATE, NOT A DISCRIMINATOR, and the measurement says
 *   so: on the deferred set the model's confidence does NOT separate right from
 *   wrong (correct answers came back at 0.8, 0.7 and also 0.5 and 0.0; the one
 *   wrong answer at 0.5). The floor declines two correct answers to block one
 *   wrong one. That trade is only acceptable BECAUSE DECLINING IS FREE — the
 *   deterministic engine already holds a call for every deferred mark. A
 *   feature with nothing to fall back on could not buy safety this way.
 */
export const PRESENCE_MIN_CONFIDENCE = 0.7;

/**
 * ★★ "unsure" IS MEASURED UNREACHABLE ON qwen3-1.7b AND IS KEPT ANYWAY.
 *    Across 17 probe cases — including two written to be genuinely
 *    unresolvable ("The Ferrars question came up again", a name standing alone)
 *    — it was returned zero times. So the abstention this task actually uses is
 *    the CONFIDENCE FLOOR, not the label, and nothing here should be described
 *    as if the model declines on its own.
 *
 *    It stays in the enum for two reasons: an unreachable grammar branch costs
 *    nothing at run time, and removing it would force a binary choice on a
 *    model that has already shown it will answer 0.5 rather than abstain.
 *    Re-run scripts/probe-presence-review.cjs on any new model before repeating
 *    this claim — reachability is a property of the model, not of the prompt.
 *
 * ★★ RE-RUN ON THREE MORE MODELS (2026-08-08), STILL ZERO. The claim above was
 *    measured on qwen3-1.7b alone. It now holds across the whole size range and
 *    across a model generation, so it is a property of the TASK, not of one
 *    model, and scaling will not buy the abstention:
 *
 *      model                        right  wrong-applied  declined  "unsure"
 *      Qwen3-1.7B      (ships, On)      4              0         3         0
 *      Qwen3-4B-Think  (ships, Max)     3              0         4         0
 *      Qwen3.5-4B      (candidate)      5              0         2         0
 *      Granite-4.0-1B  (candidate)      0              0         7         0
 *
 *    Every model clears the ship condition (wrong-applied 0), so this task is
 *    NOT the one to change models for. The Granite row is not a score: its
 *    grammar decoding fails outright in our stack, see the findings doc.
 *    Run a candidate with PROBE_TIER=max and/or PROBE_NOTHINK=0 as appropriate;
 *    `/no_think` is a Qwen token and is junk in a non-Qwen prompt.
 */
export type PresenceVerdict = "in-the-scene" | "talked-about" | "unsure";

/** Wire order is the schema's declaration order; see the ★ on the enum. */
export const PRESENCE_VERDICTS: readonly PresenceVerdict[] =
  ["in-the-scene", "talked-about", "unsure"];

const SNIPPET_MAX = 260;
const REASON_MAX = 110;
const SNIPPETS_PER_NAME = 3;

const DEFAULT_MAX_TOKENS = 128;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * ★★ REASON FIRST. A grammar emits properties in declaration order; with the
 *    verdict first the model commits before it has written a word of evidence,
 *    which is how entity-review got labels contradicting their own reasons.
 *    Do not reorder these.
 *
 * ★ "unsure" IS LAST. It is the abstention, not a third reading, and a small
 *   model reaches for whatever sits first when the discriminators get crowded.
 */
export const PRESENCE_SCHEMA = {
  type: "object",
  properties: {
    reason: { type: "string", maxLength: REASON_MAX },
    verdict: { enum: ["in-the-scene", "talked-about", "unsure"] },
    confidence: { type: "number" },
  },
} as const;

export const PRESENCE_SYSTEM = `A novel names a character in a chapter. You say whether that character is THERE
— in the scene, in the room, present — or whether other people are talking or
thinking about them while they are somewhere else.

You are given the character's name and up to three short passages from the
chapter where the name appears. Those passages are all the evidence there is.

Judge the PASSAGES, not the story. The question is never "would this character
plausibly be here"; it is "do these sentences put them in the room".

Answer "in-the-scene" when a passage shows them doing, saying, or receiving
something in the moment:
- they speak, move, look, react, or are spoken to by name
- someone in the scene touches them, hands them something, dances with them,
  sits beside them, or arrives with them
- the narration follows their thoughts or their senses

Answer "talked-about" when the name is only the SUBJECT OF SOMEONE'S ATTENTION:
- someone remembers, imagines, pities, mentions, praises or blames them
- someone asks after them, writes to them, or waits for them to arrive
- the passage reports what they said or did at another time or place
- the name appears only as a possessive or a place — "at Sir William's",
  "Lady Catherine's drawing-room" — and the person is not in it

Two passages that look almost identical can differ here, so find the verb that
governs the name and ask WHOSE verb it is. A verb sitting next to a name is not
the same as a verb that name performs: in "they all agreed that Anselm was
right", the agreeing is done by "they", and Anselm is not in the room.

Answer "unsure" when the passages genuinely do not settle it. That costs
nothing: a tool has already made its own call and will keep it.

Answer as JSON: {"reason","verdict","confidence"} in that order.
reason: FIRST, one clause of at most 14 words, naming the verb AND WHO PERFORMS
  IT — "she pities him", "he arrives", "the aunt reports it". Do not copy a
  passage back and do not repeat an example from these instructions.
verdict: in-the-scene, talked-about, or unsure.
confidence: a number from 0 to 1, how much the passages show. Never above 1.`;

/**
 * The instruction text a reason must not simply hand back.
 *
 * ★★ THE MODEL COPIED THE PROMPT'S OWN WORKED EXAMPLE INTO ITS REASON — measured:
 *    for a passage about Colonel Brandon walking through a door it answered
 *    correctly and explained itself with "danced with Miss Bingley", which was
 *    the example three paragraphs up. `reasonEchoesSentence` only compared the
 *    reason against the SNIPPETS, so a reason echoing the INSTRUCTIONS sailed
 *    through and inflated the right-answer count by luck. A right answer with a
 *    borrowed reason is not evidence the task works.
 *
 *    The worked example was also rewritten to use a name that appears nowhere
 *    in this app's corpus, so if it is echoed again the tell is unmistakable.
 */
export const PRESENCE_EXAMPLE_TEXT =
  "they all agreed that Anselm was right the agreeing is done by they and Anselm " +
  "is not in the room she pities him he arrives the aunt reports it";

// ── input & selection ─────────────────────────────────────────────────────

export interface PresenceReviewCandidate {
  /** Canonical character name, as the ledger draws it. */
  name: string;
  /** Verbatim windows around the name's occurrences. The whole evidence budget. */
  snippets: readonly string[];
  /** Mentions in this chapter — ranking only, never shown to the model. */
  mentions: number;
  chapterNumber: number;
}

/**
 * Rank the chapter's uncertain marks and take the budget.
 *
 * ★ MORE MENTIONS FIRST. A name the chapter returns to is one the writer will
 *   notice on the ledger, and a wrong mark on it costs more than a wrong mark
 *   on a single passing reference. A candidate with no snippet is dropped
 *   rather than asked about: without evidence the question is an invitation to
 *   invent, which is the failure mode that got the attribution task withdrawn.
 */
export function selectPresenceCandidates(
  candidates: readonly PresenceReviewCandidate[],
  cap = PRESENCE_CAP,
): PresenceReviewCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) =>
      candidate.name.trim() !== ""
      && candidate.snippets.some((s) => s.trim() !== ""))
    .sort((a, b) =>
      b.candidate.mentions - a.candidate.mentions
      || a.candidate.name.localeCompare(b.candidate.name)
      || a.index - b.index)
    .slice(0, Math.max(0, cap))
    .map((entry) => entry.candidate);
}

// ── request assembly ──────────────────────────────────────────────────────

export interface PresenceRequest {
  systemPrompt: string;
  userText: string;
  schema: typeof PRESENCE_SCHEMA;
  maxTokens: number;
  offered: readonly PresenceVerdict[];
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

function cutHead(text: string, max: number): string {
  const body = collapse(text);
  if (body.length <= max) return body;
  const cut = body.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The exact bytes one name sends; the live harness drives this, not a copy. */
export function buildPresenceRequest(
  candidate: PresenceReviewCandidate,
  maxTokens = DEFAULT_MAX_TOKENS,
): PresenceRequest {
  const snippets = candidate.snippets
    .map((s) => collapse(s))
    .filter(Boolean)
    .slice(0, SNIPPETS_PER_NAME);
  const userText = [
    `CHARACTER: ${collapse(candidate.name)}`,
    `CHAPTER: ${candidate.chapterNumber}`,
    "",
    `PASSAGES WHERE THE NAME APPEARS (${snippets.length})`,
    ...snippets.map((s, i) => `  ${i + 1}. …${cutHead(s, SNIPPET_MAX)}…`),
    "",
    `Do these passages put ${collapse(candidate.name)} in the scene, or is`,
    "someone talking about them while they are elsewhere?",
  ].join("\n");

  return {
    systemPrompt: PRESENCE_SYSTEM,
    userText,
    schema: PRESENCE_SCHEMA,
    maxTokens,
    offered: PRESENCE_VERDICTS,
  };
}

// ── validation ────────────────────────────────────────────────────────────

export interface PresenceAnswer {
  verdict: PresenceVerdict;
  confidence: number;
  reason: string;
}

/**
 * Mechanical checks only. Null when the answer is not usable at all — a shape
 * that is not an object, a verdict outside the three, a missing confidence, an
 * empty reason, or a reason that merely restates a passage.
 *
 * ★ THE TRANSCRIPTION TELL IS IMPORTED, NOT RE-DERIVED. `reasonEchoesSentence`
 *   was measured on chekhov's answers and is a property of the STRINGS, so it
 *   transfers without re-tuning. A second copy would drift from the first.
 */
export function normalizePresence(raw: unknown, snippets: readonly string[] = []): PresenceAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  const verdictRaw = value.verdict;
  if (typeof verdictRaw !== "string") return null;
  const wire = collapse(verdictRaw).toLowerCase();
  const verdict = PRESENCE_VERDICTS.find((v) => v === wire);
  if (!verdict) return null;

  const confidenceRaw = value.confidence;
  if (typeof confidenceRaw !== "number" || !Number.isFinite(confidenceRaw)) return null;

  const reasonRaw = value.reason;
  if (typeof reasonRaw !== "string") return null;
  const reason = tidyTruncatedText(collapse(reasonRaw).slice(0, REASON_MAX), REASON_MAX);
  if (!reason) return null;
  for (const snippet of snippets) {
    if (snippet && reasonEchoesSentence(reason, snippet)) return null;
  }
  // ★ AND against the INSTRUCTIONS — see PRESENCE_EXAMPLE_TEXT. Same mechanical
  //   predicate, second reference text.
  if (reasonEchoesSentence(reason, PRESENCE_EXAMPLE_TEXT)) return null;

  return {
    verdict,
    confidence: Math.min(1, Math.max(0, confidenceRaw)),
    reason,
  };
}

/**
 * The class this answer imposes, or null to leave the engine's call alone.
 *
 * ★ THIS IS THE ONLY PLACE A MODEL ANSWER TOUCHES THE LEDGER, and it states the
 *   whole rule by itself rather than trusting a floor checked upstream:
 *   confident, and not an abstention. An `unsure` verdict is a valid, storable
 *   answer that changes nothing — which is the point of offering it.
 */
export function appliedPresenceClass(
  answer: PresenceAnswer | null | undefined,
): "present" | "mentioned" | null {
  if (!answer || answer.confidence < PRESENCE_MIN_CONFIDENCE) return null;
  if (answer.verdict === "in-the-scene") return "present";
  if (answer.verdict === "talked-about") return "mentioned";
  return null;
}

// ── cache key ─────────────────────────────────────────────────────────────

/**
 * ★ THE CHAPTER HASH CARRIES THE EVIDENCE. The snippets are cut from the
 *   chapter, so hashing the chapter covers them; hashing the snippets too
 *   would re-ask every time a window shifted by a character.
 */
export function presenceKeyFor(
  chapterContentHash: string,
  name: string,
  modelId: string,
): string {
  return fnv1a(
    `${chapterContentHash}|${collapse(name).toLowerCase()}|${modelId}|v${PRESENCE_PROMPT_VERSION}`,
  );
}

// ── one name ──────────────────────────────────────────────────────────────

export interface PresenceReviewOptions {
  run: AssistantJSONRunner;
  /** From `assistantStatus().model.id`; part of the cache key. */
  modelId: string;
  chapterContentHash: string;
  chapterId?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface PresenceReviewResult extends PresenceAnswer {
  name: string;
  /** The class to apply, or null to keep the engine's own uncertain call. */
  applied: "present" | "mentioned" | null;
  key: string;
}

export async function runPresenceReview(
  candidate: PresenceReviewCandidate,
  opts: PresenceReviewOptions,
): Promise<PresenceReviewResult | null> {
  const snippets = candidate.snippets.filter((s) => s.trim() !== "");
  if (candidate.name.trim() === "" || snippets.length === 0) return null;
  const request = buildPresenceRequest(candidate, opts.maxTokens ?? DEFAULT_MAX_TOKENS);

  const result = await opts.run<unknown>({
    task: PRESENCE_TASK,
    tag: `${opts.chapterId ?? `ch-${candidate.chapterNumber}`}:${candidate.name}`,
    systemPrompt: request.systemPrompt,
    userText: request.userText,
    schema: request.schema,
    maxTokens: request.maxTokens,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!result.ok) return null;

  const answer = normalizePresence(result.json, snippets);
  if (!answer) return null;

  return {
    name: candidate.name,
    ...answer,
    applied: appliedPresenceClass(answer),
    key: presenceKeyFor(opts.chapterContentHash, candidate.name, opts.modelId),
  };
}

// ── candidate extraction ──────────────────────────────────────────────────

const WINDOW_RADIUS = 130;

/**
 * Cut up to three verbatim windows around a name's occurrences in a chapter.
 *
 * ★ THE MODEL SEES WINDOWS, NEVER THE MANUSCRIPT. Same budget rule as
 *   entity-review, and for the same reason: it keeps the answer about what the
 *   sentences DO with the name rather than about whatever the reader knows of
 *   the character from elsewhere in the book.
 */
export function presenceSnippets(
  text: string,
  name: string,
  variants: readonly string[] = [],
  limit = SNIPPETS_PER_NAME,
): string[] {
  const forms = [name, ...variants]
    .map((v) => v.trim())
    .filter((v) => v.length >= 2)
    .sort((a, b) => b.length - a.length)
    .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (forms.length === 0) return [];
  // Same non-`\b` boundary as character-presence.ts: underscore is a word
  // character and Gutenberg wraps names in it.
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${[...new Set(forms)].join("|")})(?![A-Za-z0-9])`, "g");

  const out: string[] = [];
  let lastEnd = -1;
  for (const match of text.matchAll(re)) {
    const at = match.index ?? 0;
    // Skip an occurrence already inside the previous window — three windows
    // over the same sentence is one piece of evidence pretending to be three.
    if (at < lastEnd) continue;
    const start = Math.max(0, at - WINDOW_RADIUS);
    const end = Math.min(text.length, at + match[0].length + WINDOW_RADIUS);
    out.push(collapse(text.slice(start, end)));
    lastEnd = end;
    if (out.length >= limit) break;
  }
  return out;
}
