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
 * ── MEASURED · scripts/probe-alias-referent.cjs · qwen3-1.7b · 8 passages ───
 *
 *   right, and a row proposed        2
 *   WRONG, and a row proposed        0    ← the deciding number
 *   answerable, left unattached      2    ← costs a nickname, nothing more
 *   unanswerable, correctly held     4
 *   distinct answers produced        unclear, Weir, Ottoline
 *
 * Four of the eight passages have NO answer in them and carry the same surface
 * shape as the four that do; the model held all four. Confidences: correct
 * referents [1, 1], wrong referents [none].
 *
 * ★★ THE FIRST RUN SCORED 0 RIGHT AND 0 WRONG, AND THE CAUSE WAS THE HARNESS,
 *    NOT THE MODEL. Two instrument defects, both visible only in the RAW text:
 *
 *    · `reason` was capped at 110 characters, and a grammar enforces maxLength
 *      by CUTTING. Every answer opened with a preamble and was guillotined
 *      mid-clause before reaching the evidence — then had to emit its label
 *      having been interrupted. One such answer named the man who was SHOUTING
 *      the nickname. Reason-before-label only helps if the reason can finish.
 *      Fixed by 200 chars plus "start with the quoted words, no preamble".
 *    · The abstention was written as an invitation — three ways to choose it
 *      and "it costs nothing" — which is precisely what this repo's own note
 *      says a catch-all must never be. It became the resting state and the
 *      task did nothing. Now stated as one narrow condition.
 *
 *    Both were fixed on the mechanism, ONE re-run was taken, and the number
 *    above is that run. Iterating a prompt against these eight cases until it
 *    passes would make the number meaningless — the cases are the measurement,
 *    not training data.
 *
 * ── REFUTED: "IT WAS THE ANSWER SET" ───────────────────────────────
 *
 * entity-review asks "what TYPE is this word?" over [character, place,
 * faction, object, not-a-name] and gets "Meanwhile" -> not-a-name right. This
 * asked "WHICH PERSON is this?" over [Gatsby, Jordan, unclear, not-a-name] and
 * answered "Bah" -> Scrooge @1.0. The obvious theory was that a list of PEOPLE
 * reads as "pick a person" whatever escape hatches are attached, and that
 * re-asking it as a type question would fix it.
 *
 * ★★ IT DOES NOT. The same four words, put through the REAL entity-review
 *    prompt and schema, come back as `character` at 0.9:
 *
 *      Bah    -> character @0.9  "Bah is spoken to by Scrooge and is spoken by Scrooge"
 *      Hullo  -> character @0.9  "Hullo is spoken to by someone else and is used as a greeting"
 *      Yeah   -> character @0.9  "Yeah is spoken to by Gatsby and is spoken by Gatsby"
 *      Ding   -> object    @0.5
 *      Kes    -> character @0.9  OK   Ott OK   Tinder OK   (controls, 3 for 3)
 *
 *    "...and is used as a greeting" - it names the word's actual function and
 *    labels it a person in the same breath, exactly as before.
 *
 * ★★ SO THE REAL FINDING IS SIMPLER AND WORSE: THE MODEL IS READING THE SLOT,
 *    NOT THE WORD. Anything sitting in `"..., X,"` inside dialogue is a person
 *    being addressed, as far as it is concerned. That is precisely what
 *    alias-scan's VOCATIVE_RE already decides, for free - so on this class the
 *    model is not a second opinion at all, it is the SAME opinion at a
 *    thousand times the cost. "Meanwhile" classifies correctly in entity-review
 *    because it sits at the head of a NARRATED sentence, a different position -
 *    not because that task is better posed.
 *
 * ★ WHAT WOULD ACTUALLY BE NEEDED: evidence from OUTSIDE the vocative slot -
 *   does this word ever appear where only a name can go - which is a question
 *   about the corpus, not about a passage, and therefore not a model's job.
 *   alias-scan's narration rules already ask it.
 *
 * ★ AND IT MISSES THE APP'S OWN DEMO CASE. "Sparrow" from the stress chapter
 *   is one of the two answerable passages it left unattached. The deterministic
 *   scan finds seven aliases on that chapter; the model layer finds none of
 *   them. It earns its place on books where an epithet is never declared and
 *   never spoken to a lone addressee — not as the part that carries the
 *   feature. If a future run puts wrong-and-proposed above 0, delete the layer;
 *   the scan stands without it.
 */
import { fnv1a } from "./evidence-pack";
import { tidyTruncatedText } from "./assistant-client";
import type { AssistantJSONRunner } from "./assistant-client";
import type { UnresolvedForm } from "./alias-scan";

export const REFERENT_TASK = "alias-referent";
export const REFERENT_PROMPT_VERSION = 2;

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
/**
 * ★★ THE OPTION THE VOCATIVE LAYER NEEDS. Its remaining wrong rows are not
 *    mis-attributions, they are non-names: `Gatsby ← Yeah`, `Christmas ← Bah`,
 *    `Scrooge ← Ding`. Every one is a capitalised token sitting in the vocative
 *    slot — `"Yeah, old sport,"` is the same shape as `"Careful, Kes,"` — and
 *    no positional or frequency test in this file can tell them apart, because
 *    both live only inside quotation marks and neither is ever narrated.
 *    Whether a word is a person's name is a language question, which is the
 *    one kind of question worth spending a model on.
 *
 * ★ It is NOT the abstention. `unclear` means "the passage does not say who";
 *   this means "the passage says this is not anybody". Keeping them separate is
 *   what lets an abstention leave the deterministic row alone while this one
 *   kills it.
 */
export const NOT_A_NAME = "not-a-name";

const SNIPPET_MAX = 420;
/**
 * ★★ MEASURED, AND IT WAS 110. A constrained grammar enforces `maxLength` by
 *    CUTTING, so a model that opens with a preamble is guillotined mid-clause
 *    and then has to emit its label having been interrupted. Both raw answers
 *    in the first run began "The name 'Tinder' is used as a noun here,
 *    referring to a person's name" and ran out of room before reaching the
 *    evidence; one of them then named the man who was SHOUTING the nickname.
 *    Reason-before-label only helps if the reason gets to finish.
 */
const REASON_MAX = 200;
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
      referent: { enum: [...shortlist, UNCLEAR, NOT_A_NAME] },
      confidence: { type: "number" },
    },
  } as const;
}

export const REFERENT_SYSTEM = `A passage from a novel uses a name or title. You say which of the listed
people it refers to, using only what the passage shows.

The passage is all the evidence there is. Do not use anything you know about
books, history or real people.

Choose a person when the passage shows it — they answer to the name, they are
described doing what the name does, or the passage puts the name and the person
in the same role. One person reacting to the name while the others do not is
enough. Nearness on its own is not.

Choose "unclear" only when the name belongs to a person but the passage does
not show which of them it is.

Choose "not-a-name" when the word is not a person's name at all — an
exclamation, a greeting, a sound, an ordinary word that happens to be
capitalised because it starts what someone says. "Yeah", "Well", "Bah" and
"Hullo" are not names. A name is a word you could put on a list of people.

Answer as JSON: {"reason","referent","confidence"} in that order.
reason: FIRST, and START WITH THE QUOTED WORDS from the passage that decide it.
  No preamble, no restating the question. If no words decide it, write "none".
referent: exactly one of the listed names, or "unclear", or "not-a-name".
confidence: a decimal between 0 and 1, such as 0.9 or 0.4. Use 0.9 or more only
  when the quoted words show it outright. Never above 1.`;

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
  const referent = wanted === UNCLEAR || wanted === NOT_A_NAME
    ? wanted
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
    && answer.referent !== NOT_A_NAME
    && answer.confidence >= REFERENT_MIN_CONFIDENCE;
}

/**
 * Does this answer REFUTE a row the deterministic pass already produced?
 *
 * ★★ THE ASYMMETRY IS THE POINT, and it is the opposite of the one above. A row
 *    with a deterministic answer behind it ships unless the model actively
 *    contradicts it, so an abstention — which is what this model does most —
 *    costs nothing and changes nothing. Only two answers kill a row: "that is
 *    not a name" and "that is a different person", and both need the same high
 *    confidence a fresh attachment needs.
 */
export function refutesProposal(
  answer: ReferentAnswer | null | undefined,
  proposed: string,
): boolean {
  if (!answer || answer.confidence < REFERENT_MIN_CONFIDENCE) return false;
  if (answer.referent === UNCLEAR) return false;
  if (answer.referent === NOT_A_NAME) return true;
  return answer.referent.toLowerCase() !== proposed.trim().toLowerCase();
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
