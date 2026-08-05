/**
 * max-ask.ts — "what about this paragraph?", answered from assembled context.
 *
 * The deterministic engines in this app can tell you WHERE things are: who is
 * present, who speaks, which names recur, which sentence opens a thread. What
 * they cannot do is say what a passage MEANS in the story around it. That gap
 * is what max mode exists to fill, and it is the only thing this module is for.
 *
 * ── THE HARNESS CARRIES THE INTELLIGENCE, NOT THE MODEL ────────────────────
 *
 * Same thesis as evidence-pack.ts, and this is deliberately its sibling: a
 * PURE function from already-derived story data to the exact text the model is
 * allowed to see. The model never searches, never reads the manuscript, and
 * never chooses what to look at. Everything measured in this repo says a 4B
 * reasons well over evidence in front of it and fails the moment it has to go
 * and FIND the evidence — so finding is the harness's job and reasoning is the
 * model's, and the split is not negotiable.
 *
 * ── WHY A LADDER AND NOT A TEMPLATE ────────────────────────────────────────
 *
 * On 8 GB the context window is 4096 tokens, of which a thinking model needs a
 * large slice for its own reasoning. So the budget for evidence is small and
 * hard, and the only question that matters is WHAT GETS IN. Rungs fill
 * top-down and whatever does not fit is dropped from the bottom, WHOLE — a
 * half-included dossier is worse than an absent one, because the model cannot
 * tell a truncated fact from a complete one.
 *
 *   1. the paragraph itself                          — always
 *   2. the writer's question, if they asked one      — always
 *   3. who is in this scene, and what they are       — always
 *   4. the paragraphs either side                    — budget
 *   5. what this chapter has established so far      — budget
 *   6. open threads this passage could be touching   — budget
 *   7. earlier passages about the same people        — budget
 *
 * ── THE LOOP, AND WHY IT CANNOT SPIN ───────────────────────────────────────
 *
 * ★★ THE LOOP ADVANCES ON ONE SIGNAL AND ONE ONLY: the model reporting that
 *    what it was given does not contain the answer, while the ladder still has
 *    an unspent rung. Not "am I confident enough", not "should I think more" —
 *    those are judgements a small model makes badly and they are how an agent
 *    gets stuck. Insufficiency is a fact about the PACK, which the harness can
 *    check and act on.
 *
 * ★ FOUR INDEPENDENT BREAKS, so no single failure can hang it:
 *      · MAX_STEPS               — a hard count, never conditional
 *      · rungs exhausted         — nothing left to add, so retrying is a repeat
 *      · a repeated answer       — same text twice means adding context changed
 *                                  nothing, so more will not either
 *      · a wall-clock deadline   — covers a model that is slow rather than stuck
 *
 *   Every break returns the best answer so far. There is no path that returns
 *   nothing because the loop ran out — a stuck harness must degrade to its last
 *   good result, not to silence.
 */
/**
 * ── MEASURED · scripts/probe-max-ask.cjs · qwen3-4b-thinking-2507 · 5 packs ──
 *
 * contextSize 4096, noThink:false, grammar-constrained. First call 6.7s warm
 * (~15s with a cold model load), then ~2.4s per answer — right-click viable.
 *
 *   explain   grounded, specific, basis=passage            REACHES THE WRITER
 *   flag      "taking the short way conflicts with her     REACHES THE WRITER
 *              refusal in chapter 8" — the planted
 *              contradiction, found and named
 *   control   no invented problem (a bland restatement,    ships, harmless
 *              not a false positive)
 *   widen-2   "forty marks … the name Elena Vasquez",      REACHES THE WRITER
 *              basis=open-threads — correct rung cited
 *
 * ★★ ROUND 1 FAILED ON AN INSTRUMENT BUG, NOT THE MODEL: the pack's headings
 *    said "THE STORY BEFORE THIS" while the enum said "story-so-far". Answers
 *    drawn from the passage cited `passage` correctly; answers drawn from ANY
 *    other rung fell back to the abstention, because the heading the model was
 *    reading did not exist in the list it was allowed to answer with. Correct,
 *    grounded answers shipped as "not in what I was given" — including the
 *    flag case, whose text explicitly cited chapter 8 while its label said the
 *    pack contained nothing. THE ENUM AND THE PAGE MUST BE THE SAME
 *    VOCABULARY; every heading now begins with its rung token verbatim.
 *    Also fixed on the same round: `check` on clean prose reported "the tin is
 *    not mentioned before this" — novelty read as anomaly — so the ask now
 *    states that absence is not a conflict. One re-run taken; the numbers
 *    above are that run.
 *
 * ★ RESIDUAL, RECORDED NOT PATCHED: on a deliberately starved pack the model
 *   phrases absence as an answer ("the notice does not specify the amount",
 *   basis=passage) instead of abstaining — so the loop's widen signal
 *   UNDER-fires and a step-1 answer that sounds like a claim about the story
 *   can ship. In practice the default 1600-token budget holds every rung of a
 *   realistic input (full packs measure ~320 tokens), so a dropped rung —
 *   the only state where this matters — is close to unreachable outside a
 *   harness. Do not fix this by iterating the prompt against the probe cases;
 *   they are the measurement.
 */
import { fnv1a } from "./evidence-pack";
import { tidyTruncatedText } from "./assistant-client";
import type { AssistantJSONRunner } from "./assistant-client";
import type { WorldData } from "../types";

export const MAX_ASK_TASK = "max-ask";
export const MAX_ASK_PROMPT_VERSION = 2;

const CHARS_PER_TOKEN = 4;
/** Evidence budget. The rest of a 4k window belongs to the model's thinking. */
export const DEFAULT_BUDGET_TOKENS = 1600;
const PARAGRAPH_CAP = 900;
const NEIGHBOUR_CAP = 420;
const ANSWER_MAX = 700;
const DEFAULT_MAX_TOKENS = 640;
const DEFAULT_TIMEOUT_MS = 90_000;

/** ★ TWO. One ask, one retry with more context. A third step has never had new
 *  evidence to justify it, because the ladder is spent by then. */
export const MAX_STEPS = 2;
/**
 * The widened budget can never exceed this.
 *
 * ★ 3200 leaves ~900 tokens of a 4k window for the model's own thinking and its
 *   answer, which a THINKING model needs more of than an instruct one. Widening
 *   to "whatever it takes" would let a long chapter's rungs push the prompt past
 *   the window and get silently truncated at the far end — where the retrieved
 *   passages are, which is the rung the retry was for.
 */
export const WIDEN_CEILING_TOKENS = 3200;
/** Covers a model that is slow rather than stuck; the step count covers stuck. */
export const DEFAULT_DEADLINE_MS = 150_000;

/** The abstention, and the ONLY thing that makes the loop take another step. */
export const NOT_IN_CONTEXT = "not-in-what-i-was-given";

export type AskKind = "check" | "suggest" | "explain" | "question";

export interface MaxAskInput {
  /** The paragraph the writer right-clicked. */
  paragraph: string;
  paragraphIndex: number;
  chapterNumber: number;
  chapterTitle?: string;
  /** What they want. `question` carries `question`. */
  kind: AskKind;
  question?: string;
  /** Paragraphs of the current chapter, for the neighbours rung. */
  chapterParagraphs?: readonly string[];
  /** Cast members the engine says are in this scene. */
  present?: readonly string[];
  worldData?: WorldData | null;
  /** One line per earlier chapter, in reading order. */
  chapterSummaries?: ReadonlyArray<{ chapterNumber: number; summary: string }>;
  /** Threads the story has opened and not closed. */
  openThreads?: ReadonlyArray<{ chapterNumber: number; text: string }>;
  /** Pre-retrieved passages about the same people. Retrieval is the CALLER's
   *  job — this module stays synchronous so it can be tested without a model. */
  related?: ReadonlyArray<{ chapterNumber: number; text: string }>;
  budgetTokens?: number;
}

export interface MaxAskPack {
  text: string;
  tokensEstimate: number;
  /** Which rungs made it in, in order. Reported so a thin answer can be told
   *  apart from a thin PACK — they look identical from the outside. */
  rungsIncluded: string[];
  /** Rungs the budget refused. Non-empty means step 2 has something to add. */
  rungsDropped: string[];
  /**
   * What the budget would have to be for NOTHING to be dropped.
   *
   * ★★ WITHOUT THIS THE WIDENING STEP IS A COIN FLIP. The first version simply
   *    doubled the budget, and the gate caught it: the always-rungs alone cost
   *    111 tokens, so doubling 60 to 120 still fitted nothing new and step 2
   *    was a byte-identical second call. A retry that cannot change the prompt
   *    is not a retry, it is a wasted inference and a slower answer.
   */
  tokensIfComplete: number;
  packHash: string;
}

const estimateTokens = (t: string) => Math.ceil(t.length / CHARS_PER_TOKEN);
const cap = (t: string, max = PARAGRAPH_CAP) => (t.length <= max ? t : `${t.slice(0, max - 1)}…`);
const collapse = (t: string) => t.replace(/\s+/g, " ").trim();

const ASK_LINE: Record<AskKind, string> = {
  // ★ "ABSENCE IS NOT A CONFLICT" is load-bearing. Measured without it: on a
  //   perfectly consistent paragraph the model reported "the tin is not
  //   mentioned in the story before this" — the classic small-model check
  //   failure, novelty read as anomaly. A check surface that flags clean prose
  //   trains the writer to ignore it.
  check: "What in this paragraph CONFLICTS with something another section "
    + "establishes? Something merely not mentioned before is not a conflict. "
    + "If nothing conflicts, say the paragraph fits.",
  suggest: "What could plausibly happen next here, given what the story has already established?",
  explain: "What is this paragraph doing in the story — what work is it performing?",
  question: "",
};

/**
 * Build the pack. `extraRungs` lets step 2 spend a bigger budget on the same
 * input rather than re-deriving anything.
 */
export function buildMaxAskPack(input: MaxAskInput, budgetOverride?: number): MaxAskPack {
  const budget = budgetOverride ?? input.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const included: string[] = [];
  const dropped: string[] = [];
  const parts: string[] = [];
  let spent = 0;

  /** Add a rung if it fits WHOLE; otherwise record it as dropped. */
  let ifComplete = 0;
  const add = (name: string, body: string, always = false) => {
    const cost = estimateTokens(body);
    ifComplete += cost;
    if (!always && spent + cost > budget) { dropped.push(name); return; }
    parts.push(body);
    included.push(name);
    spent += cost;
  };

  // ★★ EVERY HEADING BELOW STARTS WITH ITS RUNG TOKEN, VERBATIM, because the
  //    heading is what the model reads and the rung token is what the schema
  //    lets it say. Measured with prose headings ("THE STORY BEFORE THIS"
  //    against an enum saying "story-so-far"): answers drawn from the passage
  //    cited `passage` correctly, and answers drawn from ANY other rung fell
  //    back to the abstention — the model could not find the heading it was
  //    reading in the list it was allowed to answer with, so a correct,
  //    grounded answer shipped as "not in what I was given". The enum and the
  //    page must be the same vocabulary.

  // ── 1 · the passage ─────────────────────────────────────────────────────
  add("passage",
    `PASSAGE — chapter ${input.chapterNumber}`
    + `${input.chapterTitle ? `, ${input.chapterTitle}` : ""}, paragraph ${input.paragraphIndex + 1}\n`
    + cap(collapse(input.paragraph)),
    true);

  // ── 2 · the ask ─────────────────────────────────────────────────────────
  const ask = input.kind === "question"
    ? collapse(input.question ?? "").slice(0, 300)
    : ASK_LINE[input.kind];
  add("ask", `ASK\n${ask || ASK_LINE.explain}`, true);

  // ── 3 · who is here ─────────────────────────────────────────────────────
  const present = (input.present ?? []).slice(0, 6);
  if (present.length) {
    const lines = present.map((name) => {
      const c = input.worldData?.characters.find(
        (x) => x.name === name || x.aliases?.includes(name));
      const bits = [c?.role, c?.description].filter(Boolean).join(". ");
      return bits ? `${name}: ${cap(bits, 160)}` : name;
    });
    add("who", `WHO — is in this scene\n${lines.join("\n")}`, true);
  }

  // ── 3b · how the chapter began ──────────────────────────────────────────
  //
  // ★ Situating context the neighbours cannot give: a paragraph deep in a
  //   chapter is read against where the chapter STARTED (who arrived, what was
  //   wrong, what the writer promised). Only added once the passage is far
  //   enough in that the opening is not already a neighbour.
  const paras0 = input.chapterParagraphs ?? [];
  if (input.paragraphIndex > 2 && paras0[0]) {
    add("opening", `OPENING — how this chapter begins\n${cap(collapse(paras0[0]), 300)}`);
  }

  // ── 4 · either side ─────────────────────────────────────────────────────
  const paras = input.chapterParagraphs ?? [];
  const before = paras[input.paragraphIndex - 1];
  const after = paras[input.paragraphIndex + 1];
  if (before || after) {
    add("neighbours",
      `NEIGHBOURS — immediately around it\n`
      + (before ? `Before: ${cap(collapse(before), NEIGHBOUR_CAP)}\n` : "")
      + (after ? `After: ${cap(collapse(after), NEIGHBOUR_CAP)}` : ""));
  }

  // ── 5 · the story so far ────────────────────────────────────────────────
  const summaries = (input.chapterSummaries ?? [])
    .filter((s) => s.chapterNumber < input.chapterNumber)
    .slice(-4);
  if (summaries.length) {
    add("story-so-far",
      `STORY-SO-FAR — what earlier chapters established\n`
      + summaries.map((s) => `Ch ${s.chapterNumber}: ${cap(collapse(s.summary), 220)}`).join("\n"));
  }

  // ── 6 · open threads ────────────────────────────────────────────────────
  const threads = (input.openThreads ?? []).slice(0, 4);
  if (threads.length) {
    add("open-threads",
      `OPEN-THREADS — still unresolved\n`
      + threads.map((t) => `Ch ${t.chapterNumber}: ${cap(collapse(t.text), 180)}`).join("\n"));
  }

  // ── 7 · related passages ────────────────────────────────────────────────
  const related = (input.related ?? []).slice(0, 3);
  if (related.length) {
    add("related",
      `RELATED — earlier passages about the same people\n`
      + related.map((r) => `Ch ${r.chapterNumber}: ${cap(collapse(r.text), 240)}`).join("\n"));
  }

  const text = parts.join("\n\n");
  return {
    text,
    tokensEstimate: estimateTokens(text),
    rungsIncluded: included,
    rungsDropped: dropped,
    tokensIfComplete: ifComplete,
    packHash: fnv1a(`${MAX_ASK_PROMPT_VERSION}|${text}`),
  };
}

// ── the request ────────────────────────────────────────────────────────────

/**
 * ★★ ANSWER FIRST, THEN THE LABEL ABOUT IT. A constrained grammar emits
 *    properties in declaration order, and this repo has measured twice what
 *    happens when a label comes first: the model commits and then writes
 *    reasoning that contradicts it. `basis` is a classification OF the answer,
 *    so it comes after the answer.
 *
 * ★ `basis` IS THE GROUNDING CHECK. It has to name the section the answer came
 *   out of, and the sections are the rung names actually in the pack — so an
 *   answer citing a rung that was never included is detectable, and an answer
 *   that came from the model's own training has nowhere honest to point.
 */
export function maxAskSchema(rungs: readonly string[]) {
  return {
    type: "object",
    properties: {
      answer: { type: "string", maxLength: ANSWER_MAX },
      basis: { enum: [...rungs, NOT_IN_CONTEXT] },
      confidence: { type: "number" },
    },
  } as const;
}

export const MAX_ASK_SYSTEM = `You are reading one paragraph of a novel, with some of what the story has
already established around it. Answer the question about that paragraph.

Everything you are given is under a heading. Use only what is there. You have
not read the rest of the book and must not pretend to — if the answer needs
something you were not given, say so with basis "${NOT_IN_CONTEXT}".

Be concrete and specific to this passage. Name the people and the things that
are actually in it. Do not summarise the paragraph back — the writer wrote it
and knows what it says. Do not give writing advice in general terms.

Answer as JSON: {"answer","basis","confidence"} in that order.
answer: FIRST. Two or three sentences. Say the useful thing straight away.
basis: the NAME of the section your answer relies on, in lower case — the word
  before the dash in its heading, such as "story-so-far" or "passage". If you
  answered the question from a section, that section is your basis. Use
  "${NOT_IN_CONTEXT}" only when NO section contains what the question needs —
  never on an answer you actually gave.
confidence: a decimal between 0 and 1, such as 0.9 or 0.4. Never above 1.`;

export interface MaxAskRequest {
  systemPrompt: string;
  userText: string;
  schema: ReturnType<typeof maxAskSchema>;
  maxTokens: number;
  rungs: readonly string[];
}

export function buildMaxAskRequest(pack: MaxAskPack, maxTokens = DEFAULT_MAX_TOKENS): MaxAskRequest {
  return {
    systemPrompt: MAX_ASK_SYSTEM,
    userText: pack.text,
    schema: maxAskSchema(pack.rungsIncluded),
    maxTokens,
    rungs: pack.rungsIncluded,
  };
}

// ── validation ─────────────────────────────────────────────────────────────

export interface MaxAskAnswer {
  answer: string;
  basis: string;
  confidence: number;
}

export function normalizeMaxAsk(
  raw: unknown,
  rungs: readonly string[],
): MaxAskAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.answer !== "string" || typeof v.basis !== "string") return null;
  if (typeof v.confidence !== "number" || !Number.isFinite(v.confidence)) return null;

  const answer = tidyTruncatedText(collapse(v.answer).slice(0, ANSWER_MAX), ANSWER_MAX);
  if (!answer) return null;

  // ★ Matched back against the rungs WE SENT, never taken as written. A grammar
  //   constrains tokens, not meaning: a basis that is not one of ours is a
  //   citation to something that was not in the pack.
  const wanted = collapse(v.basis).toLowerCase();
  const basis = wanted === NOT_IN_CONTEXT
    ? NOT_IN_CONTEXT
    : rungs.find((r) => r.toLowerCase() === wanted);
  if (!basis) return null;

  return { answer, basis, confidence: Math.min(1, Math.max(0, v.confidence)) };
}

/** Does this answer reach the writer? */
export function isUsefulAnswer(a: MaxAskAnswer | null | undefined): boolean {
  return !!a && a.basis !== NOT_IN_CONTEXT && a.answer.length > 0;
}

// ── self-review ────────────────────────────────────────────────────────────
//
// ★★ THE REVIEWER SEES EXACTLY WHAT THE ANSWERER SAW, PLUS THE ANSWER. Same
//    pack, verbatim — a reviewer with different context is measuring the
//    difference in context, not the answer. And its verdict can only ever
//    DECORATE: a `supported` adds nothing, anything else adds a caution line
//    the writer sees beside the answer. It never deletes — this repo has
//    measured what happens when a small model's judgement is given a
//    destructive lever, and the answer is already advisory text.
//
// ★ REASON FIRST, VERDICT AFTER, and `supported` is NOT described as the safe
//   default — each verdict is a positive claim about what the sections state.

export const REVIEW_MAX_TOKENS = 200;

export type ReviewVerdict = "supported" | "overreaches" | "contradicted";

export const MAX_ASK_REVIEW_SYSTEM = `You are checking an answer that was written about a passage from a novel,
using only the sections provided. The sections are the whole truth here.

Say which one of these the answer is:
- "supported": everything the answer claims is stated by, or follows directly
  from, the sections.
- "overreaches": the answer includes something no section states — invented
  detail, motive, or history.
- "contradicted": a section states the opposite of something the answer claims.

Answer as JSON: {"reason","verdict","confidence"} in that order.
reason: FIRST, at most 20 words. Name the claim and the section that decides it.
verdict: supported, overreaches, or contradicted.
confidence: a decimal between 0 and 1, such as 0.9 or 0.4. Never above 1.`;

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    reason: { type: "string", maxLength: 160 },
    verdict: { enum: ["supported", "overreaches", "contradicted"] },
    confidence: { type: "number" },
  },
} as const;

export interface ReviewAnswer {
  verdict: ReviewVerdict;
  confidence: number;
  reason: string;
}

export function buildReviewRequest(pack: MaxAskPack, answer: MaxAskAnswer) {
  return {
    systemPrompt: MAX_ASK_REVIEW_SYSTEM,
    userText: `${pack.text}\n\nTHE ANSWER UNDER REVIEW\n${answer.answer}`,
    schema: REVIEW_SCHEMA,
    maxTokens: REVIEW_MAX_TOKENS,
  };
}

export function normalizeReview(raw: unknown): ReviewAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.verdict !== "string" || typeof v.reason !== "string") return null;
  if (typeof v.confidence !== "number" || !Number.isFinite(v.confidence)) return null;
  const verdict = (["supported", "overreaches", "contradicted"] as const)
    .find((x) => x === collapse(v.verdict as string).toLowerCase());
  if (!verdict) return null;
  const reason = collapse(v.reason).slice(0, 160);
  return { verdict, confidence: Math.min(1, Math.max(0, v.confidence)), reason };
}

// ── the bounded loop ───────────────────────────────────────────────────────

/**
 * What the model is doing RIGHT NOW, reported before each call — the same
 * live-phase courtesy every long harness in this app extends (the entity scan
 * narrates extract/classify, the download narrates bytes). "asking" is the
 * first read; "widening" is the retry with more of the story; "reviewing" is
 * the model checking its own answer. A surface that shows one spinner for all
 * three is hiding the most reassuring fact it has: that different work is
 * happening.
 */
export type MaxAskPhase = "asking" | "widening" | "reviewing";

export interface MaxAskOptions {
  run: AssistantJSONRunner;
  /** Run the self-review pass on a useful answer. One extra call, bounded. */
  selfReview?: boolean;
  /** Live phase, fired immediately BEFORE the call it names. */
  onPhase?: (phase: MaxAskPhase) => void;
  maxTokens?: number;
  timeoutMs?: number;
  /** Wall-clock ceiling across every step. */
  deadlineMs?: number;
  maxSteps?: number;
  now?: () => number;
  onStep?: (step: number, why: string) => void;
}

export interface MaxAskResult {
  answer: MaxAskAnswer | null;
  /** The self-review verdict, when it ran and parsed. Decoration, never a veto. */
  review?: ReviewAnswer | null;
  /** How many model calls it actually took. */
  steps: number;
  /** Why the loop stopped — always one of a closed set, never "it just did". */
  stopped: "answered" | "steps" | "rungs-exhausted" | "repeat" | "deadline" | "failed";
  /** The runtime's reason when stopped === "failed" — "low-memory" and "busy"
   *  deserve different words in the UI than a generic shrug. */
  failReason?: string;
  packHash: string;
  tokensEstimate: number;
  rungsIncluded: string[];
}

/**
 * Ask, and if the model says the pack did not contain the answer, widen the
 * budget once and ask again.
 *
 * ★★ EVERY EXIT IS NAMED AND EVERY EXIT RETURNS THE BEST ANSWER SO FAR. A
 *    harness that can end in an unnamed state is one nobody can debug from a
 *    bug report, and one that returns null on a break throws away a good step-1
 *    answer because step 2 was unlucky.
 */
export async function runMaxAsk(
  input: MaxAskInput,
  opts: MaxAskOptions,
): Promise<MaxAskResult> {
  const now = opts.now ?? (() => Date.now());
  const started = now();
  const deadline = started + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const maxSteps = Math.max(1, opts.maxSteps ?? MAX_STEPS);

  let budget = input.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  let pack = buildMaxAskPack(input, budget);
  let best: MaxAskAnswer | null = null;
  let lastAnswerText = "";
  let steps = 0;

  for (let step = 1; step <= maxSteps; step += 1) {
    if (now() >= deadline) {
      return { answer: best, steps, stopped: "deadline", packHash: pack.packHash,
        tokensEstimate: pack.tokensEstimate, rungsIncluded: pack.rungsIncluded };
    }

    const request = buildMaxAskRequest(pack, opts.maxTokens ?? DEFAULT_MAX_TOKENS);
    steps = step;
    opts.onStep?.(step, step === 1 ? "first ask" : "context widened");
    opts.onPhase?.(step === 1 ? "asking" : "widening");

    const result = await opts.run<unknown>({
      task: MAX_ASK_TASK,
      tag: `${input.chapterNumber}:${input.paragraphIndex}`,
      systemPrompt: request.systemPrompt,
      userText: request.userText,
      schema: request.schema,
      maxTokens: request.maxTokens,
      // Never let one call outlive the whole budget.
      timeoutMs: Math.max(1000, Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, deadline - now())),
    });
    if (!result.ok) {
      return { answer: best, steps, stopped: "failed", failReason: result.reason,
        packHash: pack.packHash,
        tokensEstimate: pack.tokensEstimate, rungsIncluded: pack.rungsIncluded };
    }

    const answer = normalizeMaxAsk(result.json, pack.rungsIncluded);
    if (answer) best = answer;

    if (answer && isUsefulAnswer(answer)) {
      // ── self-review: exactly ONE extra call, and a failure loses nothing ──
      //
      // ★★ ONLY ON `question` ANSWERS, and both boundaries were MEASURED:
      //    · a `check` answer ASSERTS a conflict, and the reviewer read the
      //      very conflict a correct flag reports as a conflict WITH the flag
      //      — "contradicted" @0.9 on a right answer. Incoherent at any prompt.
      //    · an `explain` answer INTERPRETS ("counting twice indicates her
      //      meticulous nature"), and the strict reviewer flags fair
      //      interpretation as overreach @0.9 — a caution that fires on most
      //      good explanations trains the writer to ignore cautions, which is
      //      the one way this feature dies. `suggest` speculates by charter,
      //      same problem.
      //    What remains is the factual surface: a free QUESTION answered with
      //    story facts, where the poisoned probe case ("blackmailing her since
      //    the fire she started") is caught as overreach @0.9 with the exact
      //    missing facts named. Review guards facts; interpretation is the
      //    writer's to judge.
      let review: ReviewAnswer | null = null;
      if (opts.selfReview && input.kind === "question" && now() < deadline) {
        opts.onPhase?.("reviewing");
        const reviewRequest = buildReviewRequest(pack, answer);
        const reviewed = await opts.run<unknown>({
          task: MAX_ASK_TASK,
          tag: `review:${input.chapterNumber}:${input.paragraphIndex}`,
          systemPrompt: reviewRequest.systemPrompt,
          userText: reviewRequest.userText,
          schema: reviewRequest.schema,
          maxTokens: reviewRequest.maxTokens,
          timeoutMs: Math.max(1000, Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, deadline - now())),
        }).catch(() => null);
        if (reviewed && reviewed.ok) review = normalizeReview(reviewed.json);
      }
      return { answer, review, steps, stopped: "answered", packHash: pack.packHash,
        tokensEstimate: pack.tokensEstimate, rungsIncluded: pack.rungsIncluded };
    }

    // ── the only reason to go round again ────────────────────────────────
    if (pack.rungsDropped.length === 0) {
      return { answer: best, steps, stopped: "rungs-exhausted", packHash: pack.packHash,
        tokensEstimate: pack.tokensEstimate, rungsIncluded: pack.rungsIncluded };
    }
    // ★ A REPEATED ANSWER MEANS MORE CONTEXT CHANGED NOTHING. Without this a
    //   model that always says the same thing burns every remaining step.
    if (answer && answer.answer === lastAnswerText) {
      return { answer: best, steps, stopped: "repeat", packHash: pack.packHash,
        tokensEstimate: pack.tokensEstimate, rungsIncluded: pack.rungsIncluded };
    }
    if (answer) lastAnswerText = answer.answer;

    // ★ WIDEN TO WHAT IS ACTUALLY NEEDED, capped. Doubling was the obvious
    //   move and it was wrong: the pack knows exactly what everything costs, so
    //   ask for that and let the ceiling — not arithmetic — be the limiter.
    budget = Math.min(Math.max(budget * 2, pack.tokensIfComplete), WIDEN_CEILING_TOKENS);
    const wider = buildMaxAskPack(input, budget);
    // If widening changed nothing, another call is the same call.
    if (wider.rungsIncluded.length === pack.rungsIncluded.length) {
      return { answer: best, steps, stopped: "rungs-exhausted", packHash: pack.packHash,
        tokensEstimate: pack.tokensEstimate, rungsIncluded: pack.rungsIncluded };
    }
    pack = wider;
  }

  return { answer: best, steps, stopped: "steps", packHash: pack.packHash,
    tokensEstimate: pack.tokensEstimate, rungsIncluded: pack.rungsIncluded };
}
