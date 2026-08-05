/**
 * alias-referent.ts — the local model's ONE job in the alias scan: read a
 * passage and say which of these people the strange name refers to.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ READ alias-review.ts FIRST. IT ASKS A DIFFERENT QUESTION AND IT FAILED.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * alias-review.ts asks "are these two names the same person?" over two
 * unrelated snippets. Measured on qwen3-1.7b, eight pairs: one right, one
 * catastrophically wrong, and NO THRESHOLD SEPARATING THEM — the false merge
 * of two sisters came back at confidence 1.0, its stated reason ("both names
 * share the same surname and are given different first names") being the exact
 * rule that refutes it. That module is unwired and must stay unwired.
 *
 * ★★ THE DIFFERENCE HERE IS THE TASK, NOT THE PROMPT. Re-arguing a failed
 *    prompt is how a measured result gets quietly overturned, so this does not
 *    re-argue it. It asks something else:
 *
 *      alias-review   OPEN identity judgement over two disjoint snippets.
 *                     "Is Alise Verrin the same person as Mera Verrin?"
 *                     The evidence for "no" is a fact about the WORLD (families
 *                     exist) that the passages do not contain.
 *
 *      this module    CLOSED extraction over ONE passage that contains both.
 *                     "In this passage, who is being called the Ash Marshal?
 *                      Elena, Marcus, Corin, or unclear?"
 *                     The evidence is on the page, the answer set is given, and
 *                     abstention is one of the options.
 *
 *    Reading comprehension over a supplied span with a closed answer set is
 *    what a 1.7B model is for; unbounded world-knowledge identity arbitration
 *    is not. Same finding as the rest of this repo: the model adds evidence it
 *    can actually see, and loses whenever it is asked to adjudicate.
 *
 * ★★ AND THE CONSEQUENCE IS DECLAWED EITHER WAY. Nothing here can merge a cast
 *    entry — `kind` is always `alias`, which is additive and reversible — and
 *    every model-sourced row reaches the writer UNTICKED, labelled as a guess,
 *    carrying the passage it was read from. alias-review's disqualifying
 *    property was that a confident wrong answer had no answer underneath it.
 *    Here the answer underneath is "the row stays unticked", which is what a
 *    writer who disagrees does by doing nothing.
 *
 * ★ WHAT TO MEASURE, AND WHEN TO PULL IT: scripts/probe-alias-referent.cjs.
 *   The deciding number is WRONG-AND-CONFIDENT — a passage where the model
 *   names a person the passage does not support, above the floor. Distractors
 *   are half the set. If that number is not 0, drop the model layer and ship
 *   the deterministic scan alone; it is the part that carries the feature.
 */
import { fnv1a } from "./evidence-pack";
import { tidyTruncatedText } from "./assistant-client";
import type { AssistantJSONRunner } from "./assistant-client";
import type { UnresolvedForm } from "./alias-scan";

export const REFERENT_TASK = "alias-referent";
export const REFERENT_PROMPT_VERSION = 1;

/** Per scan. This runs once, when the writer presses the button. */
export const REFERENT_CAP = 6;
/**
 * ★ The same 0.85 floor alias-review set, and for the same reason: every other
 *   task in this repo marks or labels something and falls back on a
 *   deterministic call when it declines. A name is a fact about the book.
 */
export const REFERENT_MIN_CONFIDENCE = 0.85;

/** The abstention, spelled the same on the wire and in the code. */
export const UNCLEAR = "unclear";

const SNIPPET_MAX = 420;
const REASON_MAX = 110;
const DEFAULT_MAX_TOKENS = 128;
const DEFAULT_TIMEOUT_MS = 30_000;

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * ★★ REASON FIRST. A constrained grammar emits properties in DECLARATION
 *    ORDER, so a schema with the answer first makes the model commit before it
 *    has written a word of evidence. Measured in this repo on two other tasks.
 *
 * ★ THE CANDIDATE LIST IS AN ENUM, not a free string. An extractive task whose
 *   output is unconstrained text invents referents — and a hallucinated name
 *   is indistinguishable from a real one by the time it reaches the UI.
 *
 * ★ `unclear` IS LAST AND IT IS NOT A DEFAULT. A catch-all listed first, or
 *   described as "if you are not sure", becomes the model's resting state and
 *   the task does nothing. It is the final option and it is described by what
 *   it asserts: the passage does not say.
 */
export function referentSchema(shortlist: readonly string[]) {
  return {
    type: "object",
    properties: {
      reason: { type: "string", maxLength: REASON_MAX },
      referent: { enum: [...shortlist, UNCLEAR] },
      confidence: { type: "number" },
    },
  } as const;
}

export const REFERENT_SYSTEM = `A passage from a novel uses a name or title. You say which of the listed
people it refers to, using only what the passage shows.

The passage is all the evidence there is. Do not use anything you know about
books, history or real people.

Choose a person only when the passage itself shows it — they are described
doing what the name does, they answer to it, someone uses the name while
speaking to them, or the passage puts the name and the person in the same role.

Choose "unclear" when the passage does not show it. That is the right answer
whenever the name could belong to someone not listed, when two of the listed
people fit equally, or when the passage merely mentions them nearby. Nearness
is not evidence. "unclear" costs nothing: the name simply stays unattached,
which is how it already is.

Answer as JSON: {"reason","referent","confidence"} in that order.
reason: FIRST, one clause of at most 14 words naming what in the passage
  decided it. Quote the deciding words if there are any.
referent: exactly one of the listed names, or "unclear".
confidence: 0 to 1. High only when the passage shows it outright. Never above 1.`;

// ── request ────────────────────────────────────────────────────────────────

export interface ReferentRequest {
  systemPrompt: string;
  userText: string;
  schema: ReturnType<typeof referentSchema>;
  maxTokens: number;
  shortlist: readonly string[];
}

function cutHead(text: string, max: number): string {
  const body = collapse(text);
  if (body.length <= max) return body;
  const cut = body.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function buildReferentRequest(
  form: UnresolvedForm,
  maxTokens = DEFAULT_MAX_TOKENS,
): ReferentRequest {
  const shortlist = form.shortlist.map((s) => s.character);
  const userText = [
    "PASSAGE:",
    ...form.snippets.slice(0, 2).map((s) => `  …${cutHead(s, SNIPPET_MAX)}…`),
    "",
    `PEOPLE: ${shortlist.join(", ")}`,
    "",
    `In this passage, who is "${collapse(form.alias)}"?`,
  ].join("\n");
  return {
    systemPrompt: REFERENT_SYSTEM,
    userText,
    schema: referentSchema(shortlist),
    maxTokens,
    shortlist,
  };
}

// ── validation ─────────────────────────────────────────────────────────────

export interface ReferentAnswer {
  /** A cast name, or `UNCLEAR`. */
  referent: string;
  confidence: number;
  reason: string;
}

export function normalizeReferent(
  raw: unknown,
  shortlist: readonly string[],
): ReferentAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  const referentRaw = value.referent;
  if (typeof referentRaw !== "string") return null;
  const wanted = collapse(referentRaw).toLowerCase();
  const referent = wanted === UNCLEAR
    ? UNCLEAR
    // ★ MATCHED BACK AGAINST THE LIST WE SENT, never taken as written. A
    //   grammar constrains the tokens, not the semantics: a model can still
    //   emit a listed name with different casing or spacing, and a string that
    //   is not one of ours must not reach the UI as a character.
    : shortlist.find((s) => s.toLowerCase() === wanted);
  if (!referent) return null;

  const confidenceRaw = value.confidence;
  if (typeof confidenceRaw !== "number" || !Number.isFinite(confidenceRaw)) return null;

  const reasonRaw = value.reason;
  if (typeof reasonRaw !== "string") return null;
  const reason = tidyTruncatedText(collapse(reasonRaw).slice(0, REASON_MAX), REASON_MAX);
  if (!reason) return null;

  return { referent, confidence: Math.min(1, Math.max(0, confidenceRaw)), reason };
}

/** Does this answer become a row the writer sees? Nothing else does. */
export function isSurfacedReferent(answer: ReferentAnswer | null | undefined): boolean {
  return !!answer
    && answer.referent !== UNCLEAR
    && answer.confidence >= REFERENT_MIN_CONFIDENCE;
}

export function referentKeyFor(bookHash: string, alias: string, modelId: string): string {
  return fnv1a(`${bookHash}|${collapse(alias).toLowerCase()}|${modelId}|v${REFERENT_PROMPT_VERSION}`);
}

// ── one form ───────────────────────────────────────────────────────────────

export interface ReferentOptions {
  run: AssistantJSONRunner;
  modelId: string;
  bookHash: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ReferentResult extends ReferentAnswer {
  alias: string;
  surfaced: boolean;
  key: string;
}

export async function runReferentReview(
  form: UnresolvedForm,
  opts: ReferentOptions,
): Promise<ReferentResult | null> {
  if (!form.alias.trim() || form.shortlist.length === 0 || form.snippets.length === 0) return null;

  const request = buildReferentRequest(form, opts.maxTokens ?? DEFAULT_MAX_TOKENS);
  const result = await opts.run<unknown>({
    task: REFERENT_TASK,
    tag: form.alias,
    systemPrompt: request.systemPrompt,
    userText: request.userText,
    schema: request.schema,
    maxTokens: request.maxTokens,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!result.ok) return null;

  const answer = normalizeReferent(result.json, request.shortlist);
  if (!answer) return null;

  return {
    alias: form.alias,
    ...answer,
    surfaced: isSurfacedReferent(answer),
    key: referentKeyFor(opts.bookHash, form.alias, opts.modelId),
  };
}

/**
 * The whole model layer: ask about the forms the deterministic scan could not
 * attach, and return only the confident answers, as ALIAS candidates.
 *
 * Sequential on purpose — the assistant runtime serialises anyway, and a
 * parallel fan-out here would only queue behind itself while making the
 * progress reporting lie.
 */
export async function reviewUnresolvedForms(
  forms: readonly UnresolvedForm[],
  opts: ReferentOptions & { cap?: number; onProgress?: (done: number, total: number) => void },
): Promise<ReferentResult[]> {
  const take = forms.slice(0, Math.max(0, opts.cap ?? REFERENT_CAP));
  const out: ReferentResult[] = [];
  for (let i = 0; i < take.length; i += 1) {
    opts.onProgress?.(i, take.length);
    try {
      const result = await runReferentReview(take[i], opts);
      if (result) out.push(result);
    } catch {
      // One refusal must not lose the rest of the scan.
    }
  }
  opts.onProgress?.(take.length, take.length);
  return out;
}
